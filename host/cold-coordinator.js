/** Unmounted orchestration. Trust boundary: withLease MUST hold a Host-provided
 * atomic exclusion covering session changes, queue, authorization, config and
 * storage through the actual prompt invocation; this module cannot prove it.
 * readInspection returns {inspection,snapshotSeq}; check returns scoped Host
 * attestations with stable revision and an exact identity binding. waitReady
 * must distinguish quota, transient network, and rate_limit. No retry or new
 * session. A bounded caller may return while a non-cooperative port is still
 * running: withLease must retain the lease until its callback actually ends.
 * quarantine is a trusted Host operation, not proof of cross-restart isolation.
 * A failed/timed-out quarantine requires Host to block future auto execution.
 */
import { isDeepStrictEqual } from 'node:util';
import { addAbortListener } from 'node:events';
import { inspectContinueFailure } from './continue-failure.js';
import { createColdIdentity } from './cold-identity.js';
import { correlateContinueInbox } from './continue-inbox.js';
import { ColdRecovery } from '../core/cold-recovery.mjs';
import { createContinueTransport } from './continue-transport.js';
import { createColdTransportPort } from './cold-transport-port.js';

const fail = () => { throw new Error('cold_coordinator_precondition'); };
const keys = ['authorized','failureBound','stopped','exclusive','configStable','queueClear','notCancelled'];
export function createColdCoordinator(ports, { timeoutMs = 30000 } = {}) {
  for (const k of ['withLease','readInspection','check','waitReady','load','save','resolveController','quarantine'])
    if (typeof ports?.[k] !== 'function') throw new TypeError('missing port: ' + k);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('invalid timeout');
  let used = false, controller, core, session, cancelled = false, invoked = false, quarantinePromise;
  // Resolve only on a positive Host acknowledgement. A timeout or error is an
  // explicit fatal outcome; no in-process signal proves durable quarantine.
  const quarantine = (reason) => {
    if (!quarantinePromise) quarantinePromise = (async () => {
      let timer;
      try {
        const expiry = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
        const result = await Promise.race([Promise.resolve().then(() => ports.quarantine({sessionId:session, reason})), expiry]);
        if (result !== true) throw new Error('cold_coordinator_quarantine_failed');
      } catch { throw new Error('cold_coordinator_quarantine_failed'); }
      finally { clearTimeout(timer); }
    })();
    return quarantinePromise;
  };
  const cancel = () => {
    cancelled = true; controller?.abort();
    if (core && session && !core.closed) core.cancel(session).catch(() => {});
    // Before run there is no session identifier; run quarantines once known.
    return session ? quarantine('cancelled') : Promise.resolve();
  };
  return Object.freeze({
    cancel,
    async run({ sessionId, workspaceId, requestId, signal } = {}) {
      if (used) throw new Error('cold_coordinator_single_use');
      used = true; session = sessionId; controller = new AbortController();
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('invalid signal');
      const onAbort = () => { cancel().catch(() => {}); };
      let subscription;
      if (cancelled || signal?.aborted) onAbort(); else if (signal) subscription = addAbortListener(signal, onAbort);
      const deadline = performance.now() + timeoutMs;
      const ensureTime = () => { if (performance.now() >= deadline) { onAbort(); fail(); } };
      const timer = setTimeout(onAbort, timeoutMs);
      const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({kind:'cancelled'}), {once:true}));
      const work = Promise.resolve().then(() => ports.withLease({sessionId, signal:controller.signal}, async () => {
        ensureTime(); if (controller.signal.aborted) fail();
        const first = structuredClone(await ports.readInspection({sessionId, signal:controller.signal}));
        ensureTime();
        const failure = inspectContinueFailure(sessionId, first?.inspection);
        if (!failure.eligible || first.snapshotSeq !== failure.observedThroughSeq) fail();
        const identity = createColdIdentity({failure, workspaceId, requestId});
        const check = async (phase, revision, ready) => {
          ensureTime(); if (controller.signal.aborted) fail();
          const att = await ports.check({ identity, failure, phase, signal:controller.signal });
          ensureTime();
          if (controller.signal.aborted || !att || !isDeepStrictEqual(att.identity, identity)
              || typeof att.revision !== 'string' || !att.revision || (revision !== undefined && att.revision !== revision)
              || !keys.every(k => att[k] === true) || (ready && att.ready !== true)) fail();
          const current = await ports.readInspection({sessionId, signal:controller.signal});
          ensureTime(); if (controller.signal.aborted) fail();
          const f = inspectContinueFailure(sessionId, current?.inspection);
          if (!isDeepStrictEqual(f, failure) || !isDeepStrictEqual(current.inspection, first.inspection)
              || current.snapshotSeq !== failure.observedThroughSeq) fail();
          const inbox = correlateContinueInbox({sessionId, requestId, afterSeq:failure.originalEndSeq,
            snapshotSeq:current.snapshotSeq, inspection:current.inspection});
          if (inbox.status !== 'not_observed' || inbox.competingUserPending || inbox.otherPending) fail();
          return att.revision;
        };
        const revision = await check('initial', undefined, false);
        await ports.waitReady({identity, failureClass:failure.failureClass, signal:controller.signal});
        ensureTime();
        await check('before_fence', revision, true);
        const transport = createContinueTransport({resolveController:ports.resolveController, timeoutMs});
        const send = createColdTransportPort({transport, signal:controller.signal});
        core = new ColdRecovery({load:ports.load, save:ports.save, send:async id => {
          try { await check('after_fence', revision, true); } catch { return {status:'unknown'}; }
          try { ensureTime(); } catch { return {status:'unknown'}; }
          if (controller.signal.aborted) return {status:'unknown'};
          invoked = true;
          return send(id);
        }});
        try {
          await core.open();
          ensureTime(); if (controller.signal.aborted) fail();
          const result = await core.dispatch(identity);
          if (result.kind === 'unknown') await quarantine('delivery_unknown');
          return result;
        } catch (error) {
          await quarantine(invoked ? 'delivery_unknown' : 'storage_unknown');
          if (error?.message === 'cold_coordinator_quarantine_failed') throw error;
          return {kind:invoked ? 'unknown' : 'closed'};
        } finally { await core.close(); }
      })).catch(async () => {
        if (core || invoked) {
          await quarantine(invoked ? 'delivery_unknown' : 'storage_unknown');
          return {kind: invoked ? 'unknown' : 'closed'};
        }
        return {kind:'closed'};
      });
      try {
        const result = controller.signal.aborted ? {kind:'cancelled'} : await Promise.race([work, aborted]);
        if (result.kind === 'cancelled') {
          await quarantine('cancelled');
          return invoked ? {kind:'unknown'} : result;
        }
        return result;
      } finally { clearTimeout(timer); subscription?.[Symbol.dispose](); }
    },
  });
}
