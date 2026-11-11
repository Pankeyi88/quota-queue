/**
 * Shared test adapters for the quota-queue host integration tests.
 *
 * These are TEST DOUBLES, not a host. They stand in for the Cordis Context,
 * the Typert protocol binding, the workspace registry and the storage KV unit
 * so that the REAL host modules (`host/service.js`, `host/ops.js`,
 * `host/wire.js`, `host/views.js`, `host/config.js`) and the REAL core
 * `core/store.mjs` run against fake ports.
 *
 * Stated limitation: the stub service base assigns `invocation` onto
 * `ctx.invocation` directly. It does NOT reproduce Cordis' traceable-proxy
 * receiver derivation (`receiverContext.extend({invocation}).get(serviceKey)`).
 * That path — and the reason this service must avoid `#private` members — is
 * covered only by the optional real-Cordis smoke test. Nothing here is
 * presented as real host integration evidence.
 */
import { createEmptySnapshot } from '../../core/store.mjs';
import { createTask } from '../../core/tasks.mjs';
import { createQuotaBridge } from '../../host/quota.js';
import { createQuotaQueueService } from '../../host/service.js';

export const ROUTE_ID = 'codex-common';
export const CREDENTIAL_REF = 'common-codex-ref';
export const ROUTE = Object.freeze({
  id: ROUTE_ID,
  label: 'Common Codex',
  provider: 'westlake-hpc',
  model: 'deepseek-flash',
  credentialRef: CREDENTIAL_REF,
});
export const ROUTE_B = Object.freeze({
  id: 'codex-alt',
  label: 'Common Codex (alt model)',
  provider: 'westlake-hpc',
  model: 'glm-flash',
  credentialRef: CREDENTIAL_REF,
});

/** Recording Typert protocol binding: same public contract, no Cordis. */
export function createRecordingProtocol() {
  const marks = [];
  const initializers = [];
  class StubTypertRemoteService {
    constructor(ctx, serviceKey) {
      this.ctx = ctx;
      this.name = serviceKey;
      this.typertRemote = Object.freeze({ service: this, serviceKey, namespace: serviceKey });
    }
  }
  function Remote(method, context) {
    marks.push({ method, context });
    context.addInitializer(function initializer() {
      initializers.push({ context, prototype: Object.getPrototypeOf(this) });
    });
  }
  function bindTypertRemote(service, serviceKey, options = {}) {
    return Object.freeze({
      service,
      serviceKey,
      namespace: options.namespace === undefined ? serviceKey : options.namespace,
    });
  }
  return { protocol: { TypertRemoteService: StubTypertRemoteService, Remote, bindTypertRemote }, marks, initializers };
}

/**
 * A fake storage medium with per-unit global slots. Each descriptor name has at
 * most one open unit at a time, mimicking the real hub's duplicate-owner guard,
 * while the legacy queue unit and the recovery-plan unit can be open together.
 * Reopening after close sees whatever was persisted, so reload is testable.
 */
export function createFakeStorage(options = {}) {
  const initial = new Map();
  if (options.initialGlobal !== undefined) initial.set('quota_queue_v1', options.initialGlobal);
  for (const [name, value] of Object.entries(options.initialUnits ?? {})) initial.set(name, value);
  const state = {
    units: initial,
    active: new Map(),
    opens: 0,
    saves: 0,
    loads: 0,
    closes: 0,
    descriptors: [],
    get global() { return state.units.get('quota_queue_v1') ?? null; },
    set global(value) { state.units.set('quota_queue_v1', value); },
    get activeOpens() { return [...state.active.values()].reduce((sum, count) => sum + count, 0); },
    get descriptor() { return state.descriptors.length === 0 ? null : state.descriptors[state.descriptors.length - 1]; },
  };
  const kv = {
    async open(descriptor) {
      if (options.failOpen === true) throw new Error('simulated unit-open failure');
      if (Array.isArray(options.failOpenUnits) && options.failOpenUnits.includes(descriptor.name)) {
        throw new Error('simulated unit-open failure');
      }
      const name = descriptor.name;
      if ((state.active.get(name) ?? 0) > 0) throw new Error('unit already open');
      state.active.set(name, 1);
      state.opens += 1;
      state.descriptors.push(descriptor);
      let closed = false;
      return {
        async loadAll() {
          if (closed) throw new Error('unit closed');
          state.loads += 1;
          const value = state.units.get(name);
          return { tables: {}, global: value === undefined ? null : structuredClone(value) };
        },
        async setGlobal(value) {
          if (closed) throw new Error('unit closed');
          state.saves += 1;
          if (options.failSave === true) throw new Error('simulated durable-write failure');
          if (Array.isArray(options.failSaveUnits) && options.failSaveUnits.includes(name)) {
            throw new Error('simulated durable-write failure');
          }
          state.units.set(name, structuredClone(value));
          // Simulates a durable commit whose acknowledgement is lost: the write
          // is real but the caller must treat the outcome as unknown.
          if (options.failSaveAfterWrite === true) throw new Error('simulated lost write acknowledgement');
        },
        async close() {
          if (closed) return;
          closed = true;
          state.active.delete(name);
          state.closes += 1;
        },
      };
    },
  };
  const backendName = options.backendName === undefined ? 'json' : options.backendName;
  const get = (name) => {
    if (name !== backendName) throw new Error(`backend-not-found: ${name}`);
    if (options.noKv === true) return { async close() {} };
    return { kv };
  };
  const storage = options.noStorage === true ? undefined : { backend: { get } };
  return { storage, state, kv, backendName };
}

/** Workspace record shaped like the real registry entity's read-only surface. */
export function workspaceRecord(id, path, title, status = 'ok') {
  return {
    id,
    path,
    title,
    status: async () => {
      if (status === 'throw') throw new Error('simulated status failure');
      return status;
    },
  };
}

export function createFakeWorkspaceRegistry(entries) {
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    get(id) { return map.get(id); },
    list() { return [...map.values()]; },
  };
}

/**
 * One real-shaped SessionInspection: a single human prompt turn with its own
 * request/header inside a step. `content` is intentionally empty here; the
 * identity adapter must never need it.
 */
export function inspectionFor(sessionId, options = {}) {
  const path = options.path === undefined ? 'E:/ws/one' : options.path;
  const provider = options.provider === undefined ? 'westlake-hpc' : options.provider;
  const model = options.model === undefined ? 'deepseek-flash' : options.model;
  const endKind = options.endKind === undefined ? 'error' : options.endKind;
  const rootId = options.rootId === undefined ? `root-${sessionId}` : options.rootId;
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: rootId, role: 'user', source: { kind: 'user' }, content: [] } },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, type: 'request/header', data: { header: { config: { provider, model } }, reason: 'initial' } },
    { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
  ];
  if (endKind !== 'open') events.push({ seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: endKind } } });
  return {
    meta: { id: sessionId, version: 4, isSeeded: false, cwd: path },
    inheritedEventCount: 0,
    events,
  };
}

/** Read-only sessionController double recording any activation attempt. */
export function createFakeSessionController(options = {}) {
  const sessions = options.sessions === undefined ? {} : options.sessions;
  const calls = { list: 0, inspect: 0, create: 0, resolveAgent: 0, prompt: 0, cancel: 0, selectModel: 0 };
  return {
    calls,
    async inspect(sessionId) {
      calls.inspect += 1;
      const found = sessions[sessionId];
      if (found === undefined) throw new Error('not found');
      return structuredClone(found);
    },
    // Header-only list shape with the documented positive human-task hint used
    // by the visibility filter (no message bodies, no model selection).
    async list() {
      calls.list += 1;
      return {
        items: Object.entries(sessions).map(([sessionId, inspection]) => ({
          sessionId,
          agentAvailable: false,
          updatedAt: 1000,
          running: false,
          blank: false,
          cwd: inspection.meta.cwd,
          projections: {
            kind: 'cached',
            asOfSeq: inspection.events.length - 1,
            values: {
              sessionListMetadata: { blank: false, lastPromptAt: 1000 },
              title: sessionId,
            },
          },
        })),
      };
    },
    create() { calls.create += 1; throw new Error('must not create'); },
    resolveAgent() { calls.resolveAgent += 1; throw new Error('must not activate'); },
    prompt() { calls.prompt += 1; throw new Error('must not prompt'); },
    cancel() { calls.cancel += 1; throw new Error('must not cancel'); },
    selectModel() { calls.selectModel += 1; throw new Error('must not select'); },
  };
}

/**
 * Public `ctx.sessionQuery` double for the 0.2.2 composition.
 *
 * The production inspection port reads a complete log through
 * `observeSession(id, { signal, projectionMode: 'none' })`. This double wraps the
 * same fake session logs the controller double holds and returns the documented
 * observation lease shape, so host tests exercise the real port contract.
 */
export function createFakeSessionQuery(controller) {
  if (controller === null || typeof controller !== 'object' || typeof controller.inspect !== 'function') {
    throw new TypeError('a session controller double is required');
  }
  const calls = { observe: 0, disposed: 0, projectionModes: [] };
  return {
    calls,
    async observeSession(sessionId, options = {}) {
      calls.observe += 1;
      calls.projectionModes.push(options.projectionMode);
      if (options.projectionMode !== 'none') throw new Error('projections must not be requested');
      const inspection = await controller.inspect(sessionId);
      return {
        source: 'prepared',
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        get events() { return inspection.events; },
        [Symbol.dispose]() { calls.disposed += 1; },
      };
    },
  };
}

/** Mutable fake Context: `invocation` and services are swapped per call. */
export function createFakeCtx(options = {}) {
  const services = options.services === undefined ? {} : options.services;
  return {
    invocation: options.invocation,
    get(name) { return services[name]; },
    effect() { return () => undefined; },
    logger: { info() {}, warn() {}, error() {} },
  };
}

export function createInvocation(options = {}) {
  return {
    service: options.service === undefined ? 'quotaQueue' : options.service,
    request: {
      namespace: options.namespace === undefined ? 'quotaQueue' : options.namespace,
      method: options.method === undefined ? 'dispatch' : options.method,
      args: options.args === undefined ? {} : options.args,
    },
    peer: options.peer === undefined ? { id: 'operator-peer', principal: { kind: 'owner' } } : options.peer,
    signal: options.signal === undefined ? new AbortController().signal : options.signal,
    uplink() { throw new Error('no uplink'); },
  };
}

/** Valid snapshot seed, built with the core factories so it always validates. */
export function seededSnapshot(tasks, revision = 7) {
  const snapshot = createEmptySnapshot('2024-01-01T00:00:00.000Z');
  snapshot.revision = revision;
  snapshot.seq = tasks.length;
  snapshot.updatedAt = '2024-01-01T00:00:00.000Z';
  for (const task of tasks) {
    snapshot.tasks.push(task);
    snapshot.dedupeIndex[task.dedupeKey] = task.id;
  }
  return snapshot;
}

/**
 * Build one task record through the core factory.
 * @param {object} [overrides]
 * @returns {object}
 */
export function seedTask(overrides = {}) {
  const id = overrides.id === undefined ? 'task-seed' : overrides.id;
  const kind = overrides.kind === undefined ? 'new-session' : overrides.kind;
  const fields = {
    id,
    kind,
    workspaceId: 'ws-1',
    workspacePathSnapshot: 'E:/ws/one',
    provider: ROUTE.provider,
    model: ROUTE.model,
    credentialRef: CREDENTIAL_REF,
    quotaScopeKey: 'seed::scope',
    sessionId: 'session-seed',
    dedupeKey: `seed::${id}`,
    status: 'queued',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
  if (kind === 'resume-session') {
    fields.prompt = null;
    // The core's resume identity is fail-closed: sessionId + failedStepId +
    // generation are all required for a loadable record.
    if (fields.failedStepId === undefined) fields.failedStepId = 'step-1';
    if (fields.generation === undefined) fields.generation = 'gen-1';
  } else if (fields.prompt === undefined) {
    fields.prompt = 'seeded prompt';
  }
  if (fields.status === 'running' && fields.dispatchedMessageId === undefined) {
    // The core refuses a running task with no persisted message id.
    fields.dispatchedMessageId = `message-${id}`;
    if (fields.dispatchedAt === undefined) fields.dispatchedAt = '2024-01-01T00:00:00.000Z';
  }
  return createTask(fields);
}

/**
 * Build a service plus a `call` helper over the fake context.
 * @param {object} [options]
 */
export async function createSession(options = {}) {
  const protocol = options.protocol === undefined ? createRecordingProtocol() : options.protocol;
  const storage = options.storage === undefined ? createFakeStorage() : options.storage;
  const workspaces = options.workspaces === undefined
    ? createFakeWorkspaceRegistry([workspaceRecord('ws-1', 'E:/ws/one', 'one')])
    : options.workspaces;
  const quotaBridge = options.quotaBridge === undefined
    ? createQuotaBridge({ transport: options.transport })
    : options.quotaBridge;
  const operatorPeer = options.operatorPeer === undefined
    ? { id: 'operator-peer', principal: { kind: 'owner' } }
    : options.operatorPeer;
  const connection = options.connection === undefined ? { operator: operatorPeer } : options.connection;
  const services = {
    storage: storage.storage,
    workspaceRegistry: workspaces,
    connection,
    ...(options.services === undefined ? {} : options.services),
  };
  // The real 0.2.2 composition mounts both services. Derive the query double
  // from the controller double unless a test explicitly supplies (or nulls) it,
  // so host tests keep proving the production inspection port.
  if (services.sessionQuery === undefined && services.sessionController !== undefined) {
    services.sessionQuery = createFakeSessionQuery(services.sessionController);
  }
  const ctx = createFakeCtx({ services });
  const Service = createQuotaQueueService(protocol.protocol === undefined ? protocol : protocol.protocol);
  const config = options.config === undefined ? { storageBackend: 'json', routes: [ROUTE] } : options.config;
  const service = new Service(ctx, config);
  if (options.init !== false) await service.init();

  let counter = 0;
  const dispatchRaw = async (request, callOptions = {}) => {
    const signal = callOptions.signal === undefined ? new AbortController().signal : callOptions.signal;
    if (callOptions.invocation === null) {
      ctx.invocation = undefined;
    } else if (callOptions.invocation === undefined) {
      ctx.invocation = createInvocation({
        peer: callOptions.peer === undefined ? operatorPeer : callOptions.peer,
        signal,
        namespace: callOptions.namespace,
        method: callOptions.method,
        service: callOptions.service,
        args: callOptions.args === undefined ? { request } : callOptions.args,
      });
    } else {
      ctx.invocation = callOptions.invocation;
    }
    const signalParameter = callOptions.signalParameter === undefined ? signal : callOptions.signalParameter;
    return signalParameter === 'omit' ? service.dispatch(request) : service.dispatch(request, signalParameter);
  };
  const call = async (op, payload, callOptions = {}) => {
    counter += 1;
    const requestId = callOptions.requestId === undefined ? `req-${counter}` : callOptions.requestId;
    return dispatchRaw(
      { version: 1, op, requestId, payload: payload === undefined ? {} : payload },
      callOptions,
    );
  };

  /**
   * Swap one service a later operation will resolve. The production port face
   * resolves the workspace registry per call, so these tests must be able to
   * make it appear, vanish and change without re-creating the service.
   * @param {string} name
   * @param {unknown} value
   */
  const setService = (name, value) => {
    services[name] = value;
  };

  return { service, ctx, storage, workspaces, quotaBridge, protocol, operatorPeer, connection, config, services, setService, call, dispatchRaw };
}
