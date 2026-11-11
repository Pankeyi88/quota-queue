/**
 * quota-queue/host — the real Cordis Host Service and its one Remote method.
 *
 * `QuotaQueueService extends TypertRemoteService` and registers the Cordis
 * service key `quotaQueue`. One public instance method, `dispatch(request,
 * signal)`, is marked with the protocol's public `Remote` decorator protocol:
 * `Remote(method, {kind:'method', name, static:false, private:false,
 * addInitializer(fn){ fn.call(Object.create(proto)) }})`. No private symbol is
 * written, so the marker is exactly what the shipped generator would emit.
 *
 * ## Why this class has no `#private` members
 *
 * The Gateway calls a Remote method on
 * `receiverContext.extend({invocation}).get(serviceKey)` — a Cordis
 * *traceable proxy* whose `apply` trap rebinds `this` to a shadow proxy that
 * overrides the `ctx` property. JavaScript private fields are not reachable
 * through a `Proxy`, so reading a private field inside `dispatch` throws
 * "Cannot read private member ... from an object whose class did not declare
 * it" and the whole call degrades to `gateway/internal`. Every shipped Typert
 * service avoids private members for this reason.
 *
 * The instance state therefore lives in one non-enumerable own property,
 * `_state`. Non-enumerable keeps it out of enumeration and JSON projection,
 * and it is not Remote-reachable: the Gateway only dispatches methods carrying
 * a `Remote` marker, and `dispatch` is the only marked method.
 *
 * ## Gateway signature constraint
 *
 * Source-mode discovery parses the method with `Function.prototype.toString`:
 * parameter names must be unique plain identifiers with no destructuring,
 * default or rest, and `signal` — when present — must be the final one. That
 * is why `dispatch` is a prototype method spelled `async dispatch(request,
 * signal) { ... }` and why the protocol binding is a factory argument rather
 * than a default parameter.
 *
 * ## Security posture of `dispatch`
 *
 *  - a real `ctx.invocation` is required (a direct in-process call derives
 *    none), and its service/namespace/method, peer and signal must all be sound;
 *  - authorization-class operations additionally require
 *    `invocation.peer === ctx.get('connection').operator`. That proves the
 *    call arrived through the admitted Connection Remote; it is **not** a
 *    physical-user-click proof and is documented as such;
 *  - no model-supplied `actor`/`role` field is consulted, ever;
 *  - no authorization setter is registered as an agent tool anywhere.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { QueueStore } from '../core/store.mjs';
import {
  CAPABILITIES,
  DISPATCH_ENDPOINT,
  EFFECT_LABEL,
  OPERATOR_GATED_OPS,
  OPS,
  OWNER_LOCK_PORT,
  SERVICE_KEY,
} from './constants.js';
import { HostError, toFailure } from './errors.js';
import { QueueOperations } from './ops.js';
import { createHostPorts } from './ports.js';
import { createSessionInspection } from './session-inspection.js';
import { createQuotaBridge } from './quota.js';
import { createCpamcQuotaSource } from './cpamc-quota.js';
import { bindingRevisionOf, createAutoResume } from './auto-resume.js';
import { RecoveryPlanStore } from '../core/recovery-plan-store.mjs';
import { createAutoContinueDriver } from './auto-continue.js';
import { createContinueStore } from './continue-store.js';
import { createOwnerMutex } from './owner-lock.js';
import { createKvUnitPorts, openContinueUnit, openQueueUnit, openRecoveryPlanUnit } from './storage-port.js';
import { parsePayload, parseRequest } from './wire.js';

/** Non-enumerable instance-state key (see the class comment). */
const STATE = '_state';

/**
 * Require that a call really arrived as an admitted Remote invocation.
 * @param {unknown} invocation `this.ctx.invocation`
 * @returns {object} the validated invocation
 * @throws {HostError} not_remote | invalid_invocation | cancelled
 */
export function validateInvocation(invocation) {
  if (invocation === undefined || invocation === null || typeof invocation !== 'object') {
    // A direct Host-method call (for example from an agent tool) derives no
    // invocation, which is the containment boundary for model-initiated calls.
    throw new HostError('not_remote');
  }
  if (Reflect.get(invocation, 'service') !== SERVICE_KEY) {
    throw new HostError('invalid_invocation', { field: 'service' });
  }
  const request = Reflect.get(invocation, 'request');
  if (request === null || typeof request !== 'object') {
    throw new HostError('invalid_invocation', { field: 'request' });
  }
  if (Reflect.get(request, 'namespace') !== SERVICE_KEY) {
    throw new HostError('invalid_invocation', { field: 'namespace' });
  }
  if (Reflect.get(request, 'method') !== 'dispatch') {
    throw new HostError('invalid_invocation', { field: 'method' });
  }
  const args = Reflect.get(request, 'args');
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new HostError('invalid_invocation', { field: 'args' });
  }
  const argKeys = Object.keys(args);
  if (argKeys.length !== 1 || argKeys[0] !== 'request') {
    throw new HostError('invalid_invocation', { field: 'args' });
  }
  const peer = Reflect.get(invocation, 'peer');
  if (peer === null || typeof peer !== 'object') {
    throw new HostError('invalid_invocation', { field: 'peer' });
  }
  const peerId = Reflect.get(peer, 'id');
  if (typeof peerId !== 'string' || peerId.length === 0) {
    throw new HostError('invalid_invocation', { field: 'peer.id' });
  }
  const signal = Reflect.get(invocation, 'signal');
  if (signal === null || typeof signal !== 'object' || typeof Reflect.get(signal, 'aborted') !== 'boolean') {
    throw new HostError('invalid_invocation', { field: 'signal' });
  }
  if (Reflect.get(signal, 'aborted') === true) throw new HostError('cancelled');
  return invocation;
}

/**
 * Require the call to speak for the Host's owner principal.
 *
 * DSH 0.2.1 replaces the old `connection.operator` reference with a
 * `PeerScope.principal` fixed by the connection layer at Peer creation. A
 * browser/API request admitted for the local user arrives as
 * `{kind:'owner'}`; no wire field can set it. Unknown or missing principals
 * are refused.
 *
 * @param {object} invocation validated invocation
 * @param {object} [_ctx] the call receiver's context (kept for call-site compatibility)
 * @throws {HostError} operator_required
 */
export function requireOperatorPeer(invocation, _ctx) {
  const peer = invocation === null || invocation === undefined ? undefined : invocation.peer;
  const principal = peer !== null && peer !== undefined ? Reflect.get(peer, 'principal') : undefined;
  if (principal === null || principal === undefined || Reflect.get(principal, 'kind') !== 'owner') {
    throw new HostError('operator_required');
  }
}

/**
 * Whether one operation is operator-gated. True for every operation, and the
 * exported policy list is asserted against the accepted op list at load time so
 * adding an op cannot silently skip the gate.
 * @param {string} op
 * @returns {boolean}
 */
export function needsOperatorPeer(op) {
  return OPERATOR_GATED_OPS.includes(op);
}

if (OPERATOR_GATED_OPS.length !== OPS.length) {
  throw new Error('quota-queue: every Host operation must stay operator-gated');
}

/**
 * Build the Host service class against an injected Typert protocol binding.
 *
 * Injecting the binding keeps the production entry point on the real package
 * while letting the host integration tests exercise this exact class with a
 * recording stub — without pretending that a stub is the real host.
 *
 * @param {{TypertRemoteService: Function, Remote: Function, bindTypertRemote: Function}} protocol
 * @returns {Function} the service class
 */
export function createQuotaQueueService(protocol) {
  if (protocol === null || typeof protocol !== 'object') {
    throw new TypeError('createQuotaQueueService expects a protocol binding');
  }
  const { TypertRemoteService, Remote, bindTypertRemote } = protocol;
  if (typeof TypertRemoteService !== 'function') throw new TypeError('createQuotaQueueService requires TypertRemoteService');
  if (typeof Remote !== 'function') throw new TypeError('createQuotaQueueService requires the Remote decorator');
  if (typeof bindTypertRemote !== 'function') throw new TypeError('createQuotaQueueService requires bindTypertRemote');

  class QuotaQueueService extends TypertRemoteService {
    /**
     * @param {object} ctx owning Cordis context
     * @param {{storageBackend: string, routes: object[]}} config parsed config
     */
    constructor(ctx, config) {
      super(ctx, SERVICE_KEY);
      // TypertRemoteService binds `typertRemote` (the Gateway's discovery
      // handle) in its own constructor. A base that does not must not silently
      // lose discovery, so bind it here through the public helper.
      if (Reflect.get(this, 'typertRemote') === undefined) {
        this.typertRemote = bindTypertRemote(this, SERVICE_KEY, { namespace: SERVICE_KEY });
      }
      // One non-enumerable own property holds all mutable state. A `#field`
      // would be unreachable through the Gateway's contextual proxy.
      Object.defineProperty(this, STATE, {
        value: {
          config: config === null || typeof config !== 'object'
            ? { storageBackend: 'json', routes: [] }
            : config,
          unit: null,
          store: null,
          planUnit: null,
          planStore: null,
          // Plugin-local SessionInspection port; never the Host controller.
          inspection: null,
          ops: null,
          autoResume: null,
          // Durable automatic continuation: {mutex, store, unit, driver} or null.
          autoContinue: null,
          disposed: false,
          disposePromise: null,
          initPromise: null,
        },
        writable: true,
        enumerable: false,
        configurable: false,
      });
    }

    /** True once the persisted snapshot failed to load or validate. */
    get storageDegraded() {
      const state = this[STATE];
      return state.store !== null && state.store.locked === true;
    }

    /** True once `dispose` started; every later operation fails closed. */
    get disposed() { return this[STATE].disposed === true; }

    /** The mounted HOT adapter, or null when recovery stays disabled. */
    getAutoResume() { return this[STATE].autoResume; }

    /** The automatic-continuation driver, or null when it is not configured. */
    getAutoContinue() {
      const runtime = this[STATE].autoContinue;
      return runtime === null || runtime === undefined ? null : runtime.driver;
    }

    /**
     * Open the storage unit and the queue store. Idempotent.
     * @returns {Promise<object>} this service
     */
    async init() {
      const state = this[STATE];
      if (state.initPromise === null) state.initPromise = this._doInit();
      return state.initPromise;
    }

    async _doInit() {
      const state = this[STATE];
      // The service's own context, captured once and used to RESOLVE services
      // per operation. Reading a service value once and storing it would latch
      // a provider that is not ACTIVE yet (see host/ports.js).
      const ownContext = this.ctx;
      // Read-only inspection port over the public `sessionQuery` service. DSH
      // 0.2.2 retired SessionController.inspect; this wrapper is the one place
      // that still knows how to read a complete Session log.
      const inspection = createSessionInspection(() => ownContext.get('sessionQuery'));
      state.inspection = inspection;
      // A failing unit open (missing backend, kv facet absent, or the unit
      // already open in this process) fails plugin activation loudly rather
      // than letting a second owner run on the same snapshot.
      const unit = await openQueueUnit(ownContext.get('storage'), { backendName: state.config.storageBackend });
      state.unit = unit;
      const store = new QueueStore(createKvUnitPorts(unit));
      try {
        await store.open();
      } catch {
        // The snapshot could not be loaded/validated. The core store is locked
        // from here: every write fails with a clear error, nothing is
        // published, and no scheduler is started. Keep the service mounted so
        // the failure is visible in the View instead of silently disappearing.
      }
      state.store = store;
      // The plan lives in its OWN unit so the legacy snapshot is never rewritten
      // or migrated. A failure here is surfaced as an unavailable plan and never
      // silently manufactures a fresh replacement for corrupt persisted data.
      let planStore = null;
      try {
        const planUnit = await openRecoveryPlanUnit(ownContext.get('storage'), { backendName: state.config.storageBackend });
        state.planUnit = planUnit;
        planStore = new RecoveryPlanStore(createKvUnitPorts(planUnit));
        try {
          await planStore.open();
        } catch {
          // Locked store stays unopened: reads report unavailable, writes fail.
        }
      } catch {
        state.planUnit = null;
        planStore = null;
      }
      state.planStore = planStore;
      // Read-only quota source. The management key is read from the process
      // environment named by the config (never from a request or the Client),
      // and only this Host-side bridge ever sees it.
      let quotaBridge = createQuotaBridge();
      let cpamcSource = null;
      const quotaSourceConfig = state.config.quotaSource;
      if (quotaSourceConfig !== null && quotaSourceConfig !== undefined) {
        const key = typeof process.env[quotaSourceConfig.managementKeyEnv] === 'string'
          ? process.env[quotaSourceConfig.managementKeyEnv]
          : '';
        if (key.length > 0) {
          const source = createCpamcQuotaSource({
            baseUrl: quotaSourceConfig.baseUrl,
            managementKey: key,
            authIndex: quotaSourceConfig.authIndex,
            weeklyMinRemaining: quotaSourceConfig.weeklyMinRemaining,
            fiveHourMinRemaining: quotaSourceConfig.fiveHourMinRemaining,
            timeoutMs: quotaSourceConfig.timeoutMs,
            maxAgeMs: quotaSourceConfig.maxAgeMs,
          });
          cpamcSource = source;
          quotaBridge = {
            configured: true,
            network: true,
            scopeKey: source.scopeKey,
            async check() { return { configured: true, snapshot: await source.check() }; },
          };
        } else {
          quotaBridge = {
            configured: false,
            network: false,
            reasons: ['management_key_missing'],
            async check() { return { configured: false, reasons: ['management_key_missing'] }; },
          };
        }
      }
      const autoResumeConfig = state.config.autoResume;
      const autoResumeEnabled = autoResumeConfig !== null && autoResumeConfig !== undefined
        && autoResumeConfig.enabled === true && cpamcSource !== null && store.opened === true;
      state.ops = new QueueOperations({
        store,
        planStore,
        autoResume: autoResumeEnabled,
        // A mounted continuation driver is a real recovery consumer even when
        // no quota source is bound. `state.getAutoContinue` (which is
        // `getAutoContinue` on the service) is the runtime truth, so a swapped
        // runtime counts instead of being frozen at construction time.
        autoContinue: () => {
          if (state.config.autoContinue !== null && state.config.autoContinue !== undefined
            && state.config.autoContinue.enabled === true) return true;
          try {
            return typeof state.getAutoContinue === 'function' && state.getAutoContinue() !== null;
          } catch {
            return false;
          }
        },
        ports: createHostPorts({
          // Evaluated on every availability check and every operation, so a
          // registry that becomes active after activation, is removed
          // temporarily, or is replaced is always seen in its current state.
          resolveWorkspaceRegistry: () => ownContext.get('workspaceRegistry'),
          // Header-only candidate listing still uses the Session controller.
          resolveSessionController: () => ownContext.get('sessionController'),
          // Complete-log reads use the plugin's own inspection port.
          resolveInspection: () => inspection,
          // Public agent registry: used only as POSITIVE running evidence.
          resolveAgents: () => ownContext.get('agents'),
          quotaBridge,
          quotaScopeId: cpamcSource !== null ? cpamcSource.scopeKey : null,
          autoContinueView: () => {
            const runtime = state.autoContinue;
            if (runtime === null || runtime === undefined) {
              return { enabled: false, owner: 'disabled', ownerReason: null, store: 'closed', tickets: [] };
            }
            if (runtime.driver !== null) return runtime.driver.projection();
            return { enabled: true, owner: 'passive', ownerReason: runtime.reason ?? null, store: 'closed', tickets: [] };
          },
          quotaSourceConfigured: quotaSourceConfig !== null && quotaSourceConfig !== undefined,
          managementKeyPresent: typeof process.env[quotaSourceConfig?.managementKeyEnv] === 'string'
            && process.env[quotaSourceConfig.managementKeyEnv].length > 0,
        }),
        routes: new Map(
          (Array.isArray(state.config.routes) ? state.config.routes : []).map((route) => [route.id, route]),
        ),
      });
      if (autoResumeEnabled) {
        state.autoResume = createAutoResume({
          resolveInspection: () => inspection,
          resolveAgents: () => ownContext.get('agents'),
          getOptIn: (sessionId) => store.opened === true && store.getSnapshot().sessionOptIns[sessionId] === true,
          quotaSource: cpamcSource,
          bindingRevision: bindingRevisionOf(quotaSourceConfig),
          maxWaitMs: autoResumeConfig.maxWaitMs,
          maxChecks: autoResumeConfig.maxChecks,
        });
      }
      await this._startAutoContinue(ownContext, state, cpamcSource);
      return this;
    }

    /**
     * The one Remote method. Parameter names are part of the wire contract:
     * `request` is the JSON argument and `signal` is injected by the Gateway.
     *
     * @param {object} request `{version, op, requestId, payload}`
     * @param {AbortSignal} signal carrier cancellation
     * @returns {Promise<{ok:true,data:object}|{ok:false,error:{code:string,message:string}}>}
     */
    async dispatch(request, signal) {
      try {
        const invocation = validateInvocation(Reflect.get(this.ctx, 'invocation'));
        // Uniform gate, placed before any payload inspection: no operation may be
        // reached by a forged in-process peer, and an unauthenticated caller must
        // not even learn whether its request shape is valid.
        requireOperatorPeer(invocation, this.ctx);
        if (signal !== undefined && signal !== null && Reflect.get(signal, 'aborted') === true) {
          throw new HostError('cancelled');
        }
        const state = this[STATE];
        if (state.disposed === true) throw new HostError('unavailable');
        const parsed = parseRequest(request);
        const payload = parsePayload(parsed.op, parsed.payload);
        const ops = state.ops;
        if (ops === null) throw new HostError('unavailable', { reason: 'not-initialized' });
        const data = await ops.run(parsed.op, payload, parsed.requestId);
        return { ok: true, data };
      } catch (error) {
        // Only the fixed safe summary crosses the wire; no cause, stack, raw
        // response, header or credential is ever returned.
        return { ok: false, error: toFailure(error) };
      }
    }

    /**
     * Stop accepting work, drain the operation chain, close the store and the
     * storage unit. Idempotent and safe to call from a Cordis effect disposer.
     * @returns {Promise<void>}
     */
    async dispose() {
      const state = this[STATE];
      if (state.disposePromise === null) {
        state.disposed = true;
        state.disposePromise = this._doDispose();
      }
      return state.disposePromise;
    }

    /**
     * Mount the durable automatic-continuation driver.
     *
     * Order matters: the OS mutex is acquired BEFORE the ticket store is
     * opened, so a second DSH process never opens the same unit and never
     * races the first one's ticket file. A process that loses the bind stays
     * passive with a visible reason and sends nothing.
     */
    async _startAutoContinue(ownContext, state, quotaSource = null) {
      const config = state.config.autoContinue;
      if (config === null || config === undefined || config.enabled !== true) return;
      const instanceId = `qq-${process.pid}-${randomUUID().slice(0, 8)}`;
      const mutex = createOwnerMutex({
        port: OWNER_LOCK_PORT,
        instanceId,
        metaPath: join(homedir(), '.dsh', 'quota-continue', `owner-${OWNER_LOCK_PORT}.json`),
      });
      const runtime = { mutex, unit: null, driver: null, reason: null, retryTimer: null };
      state.autoContinue = runtime;
      // The unit is opened LAZILY: a passive instance must never open the
      // shared store (last-write-wins across processes).
      let unitPromise = null;
      const ensureUnit = async () => {
        if (unitPromise === null) {
          unitPromise = openContinueUnit(ownContext.get('storage'), { backendName: state.config.storageBackend })
            .then((unit) => { runtime.unit = unit; return createKvUnitPorts(unit); });
        }
        return unitPromise;
      };
      const store = createContinueStore({
        load: async () => (await ensureUnit()).load(),
        save: async (value) => (await ensureUnit()).save(value),
        now: () => Date.now(),
      });
      const driver = createAutoContinueDriver({
        store,
        owner: mutex,
        // Prompt delivery stays on the Session controller; log reads use the port.
        resolveController: () => ownContext.get('sessionController'),
        resolveInspection: () => state.inspection,
        resolveAgents: () => ownContext.get('agents'),
        getOptIn: (sessionId) => state.store !== null && state.store.opened === true
          && state.store.getSnapshot().sessionOptIns[sessionId] === true,
        // Bounded startup scan (KD-2): only sessions the user opted in.
        listOptIns: () => {
          if (state.store === null || state.store.opened !== true) return [];
          const map = state.store.getSnapshot().sessionOptIns;
          return Object.keys(map).filter((id) => map[id] === true);
        },
        isPaused: () => state.store === null || state.store.opened !== true
          || state.store.getSnapshot().dispatchPaused === true,
        maxAttempts: config.maxAttempts,
        pollMs: config.pollMs,
        fenceGraceMs: config.fenceGraceMs,
        // Every automatic turn is gated on ONE fresh read-only observation.
        // Only a verified quota source with a present management key mounts
        // this; without one the driver keeps its documented time-only policy.
        readQuota: quotaSource === null || typeof quotaSource.check !== 'function'
          ? null
          : () => quotaSource.check(),
        quotaGateRetryMs: config.quotaGateRetryMs,
      });
      runtime.driver = driver;

      const tryStart = async () => {
        try {
          const ownership = await mutex.acquire();
          if (ownership.active !== true) {
            runtime.reason = ownership.reason ?? 'held_by_peer';
            return false;
          }
          await driver.start();
          runtime.reason = null;
          return true;
        } catch {
          runtime.reason = 'continue_store_unavailable';
          try { if (runtime.unit !== null) await runtime.unit.close(); } catch { /* already closed */ }
          runtime.unit = null;
          unitPromise = null;
          return false;
        }
      };

      if (await tryStart()) return;
      // Passive: keep trying to take over. Takeover is only possible AFTER the
      // previous owner released the port following its own drain, and it
      // re-opens + re-hydrates the store before listening again.
      runtime.retryTimer = setInterval(() => {
        if (state.disposed === true || runtime.driver === null) return;
        if (mutex.owned === true) return;
        tryStart().then((active) => {
          if (active && runtime.retryTimer !== null) {
            clearInterval(runtime.retryTimer);
            runtime.retryTimer = null;
          }
        }).catch(() => {});
      }, 15_000);
      if (typeof runtime.retryTimer.unref === 'function') runtime.retryTimer.unref();
    }

    async _doDispose() {
      const state = this[STATE];
      if (state.autoContinue !== null) {
        const runtime = state.autoContinue;
        state.autoContinue = null;
        if (runtime.retryTimer !== null) { clearInterval(runtime.retryTimer); runtime.retryTimer = null; }
        // Fail-closed default: ownership is released ONLY after a clean stop()
        // that proves the drain. A thrown stop or an unknown driver state keeps
        // the port and the unit rather than risking a second driver.
        let releaseSafe = false;
        let stopReason = 'drain_incomplete_owner_retained';
        if (runtime.driver === null) {
          releaseSafe = true;
        } else {
          try {
            await runtime.driver.stop();
            if (runtime.driver.releaseSafe === true) {
              releaseSafe = true;
            } else {
              stopReason = 'drain_incomplete_owner_retained';
            }
          } catch {
            releaseSafe = false;
            stopReason = 'stop_failed_owner_retained';
          }
        }
        if (releaseSafe === false) {
          // An in-flight Host call ignored abort, or stop() threw. Keep the
          // port and the unit: a new process must not take over while an old
          // call may still land.
          runtime.reason = stopReason;
        } else {
          try { if (runtime.unit !== null) await runtime.unit.close(); } catch { /* already closed */ }
          try { await runtime.mutex.release(); } catch { /* already released */ }
        }
      }
      if (state.autoResume !== null) {
        try {
          await state.autoResume.dispose();
        } catch {
          // Recovery is already failing closed; dispose continues.
        }
        state.autoResume = null;
      }
      const ops = state.ops;
      if (ops !== null) {
        ops.close();
        try {
          await ops.drain();
        } catch {
          // Drain is best effort: the chain is already settling.
        }
      }
      if (state.planStore !== null) {
        try {
          await state.planStore.close();
        } catch {
          // Accepted plan writes already drained above.
        }
      }
      if (state.store !== null) {
        try {
          await state.store.close();
        } catch {
          // Already closed.
        }
      }
      if (state.planUnit !== null) {
        try {
          await state.planUnit.close();
        } catch {
          // Already closed.
        }
      }
      if (state.unit !== null) {
        try {
          await state.unit.close();
        } catch {
          // Already closed.
        }
      }
    }
  }

  // The public decorator protocol, called exactly as a plain function. The
  // initializer runs immediately against the class prototype, so no private
  // descriptor symbol is ever written by hand.
  Remote(QuotaQueueService.prototype.dispatch, {
    kind: 'method',
    name: 'dispatch',
    static: false,
    private: false,
    addInitializer(initializer) {
      initializer.call(Object.create(QuotaQueueService.prototype));
    },
  });

  return QuotaQueueService;
}

/** Endpoint this service exports, for diagnostics and tests. */
export const remoteEndpoint = DISPATCH_ENDPOINT;

/** Effect label used by the plugin entry, re-exported for tests. */
export const disposeEffectLabel = EFFECT_LABEL;

/** Capability snapshot this build reports, re-exported for tests. */
export const reportedCapabilities = CAPABILITIES;
