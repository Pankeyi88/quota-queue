/**
 * Offline-testable HOT request-error waiting adapter. No Host hook, networking,
 * message creation, tool replay, or production enablement exists here.
 *
 * createHotRecoveryCoordinator({inspect, query, clock}, options?) exposes:
 *   waitForRetry(identityWithSignal) -> Promise<{kind:'retry'}|{kind:'stop',reason}>
 *   revoke({sessionId,rootMessageId,generation}) -> permanently revoke this cut
 *   close() -> abort and drain all coordinator waits (idempotent)
 *
 * ONLY a trusted Host adapter may construct inputs and implement ports. An
 * arbitrary Client boolean is NOT proof of authorization or exclusive ownership.
 * inspect receives {...identity,signal}, and returns exactly {...identity,
 * authorized,bindingConfirmed,ownershipConfirmed,requestSettled,noOtherRequest,
 * quotaFailureConfirmed,configurationUnchanged}; every flag must be true.
 * query receives {scopeId,bindingRevision,signal} and returns exactly
 * {bindingRevision,snapshot}; snapshot is core/quota.mjs's proxy-query schema.
 * clock is {now(),setTimeout(callback,ms),clearTimeout(handle)}.
 *
 * Port promises MUST honor AbortSignal to drain their own underlying I/O. The
 * coordinator races cancellation/deadline even if a faulty port never resolves,
 * suppresses late results and catches late rejections; it cannot forcibly stop
 * a non-cooperative port's side effects. close drains coordinator work, not such
 * orphaned external I/O. No new port invocation occurs after cancellation.
 *
 * Each full session/root/generation/turn/step identity gets at most ONE owner
 * and ONE retry decision for this coordinator lifetime. Repeated events do not
 * reset this tombstone. generation is the AUTHORIZED TASK RANGE, never a retry
 * counter. Do not increment it to bypass dedupe or inherit authorization. This
 * minimal API cannot prove a distinct second error at the same turn/step, so it
 * conservatively refuses another retry there. Recurring exhaustion requires a
 * future positively correlated recoveryAttemptId (for example assistant-stream
 * attemptId) integration; that feature is intentionally NOT provided here.
 * This is process-local callback dedupe, NOT a production/distributed lock.
 *
 * Returning retry merely proposes a same-loop action. Host MUST still verify
 * binding at actual prepare/dispatch and arbitrate other retry/Goal listeners.
 * A stop result must not be naively mapped to waterfall undefined when another
 * always-retry listener can fallback. Cold restart cannot resume this callback.
 */
import { InputValidationError } from './errors.mjs';
import { validateQuotaSnapshot, SNAPSHOT_TTL_MS } from './quota.mjs';

const ID = ['sessionId', 'rootMessageId', 'generation', 'turn', 'step', 'scopeId', 'bindingRevision'];
const FLAGS = ['authorized', 'bindingConfirmed', 'ownershipConfirmed', 'requestSettled', 'noOtherRequest', 'quotaFailureConfirmed', 'configurationUnchanged'];
const abortReason = () => new Error('hot_recovery_cancelled');
const requireInput = (ok) => { if (!ok) throw new InputValidationError('invalid hot recovery input'); };
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && v.trim() === v && !/[\u0000-\u001f]/u.test(v);
function plain(value, seen = new Set()) {
  if (value === null || ['boolean', 'string'].includes(typeof value)) return;
  if (typeof value === 'number') { requireInput(Number.isFinite(value)); return; }
  requireInput(value !== null && typeof value === 'object' && !seen.has(value));
  const a = Array.isArray(value);
  requireInput(a ? Object.getPrototypeOf(value) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (a) requireInput(keys.length === value.length + 1);
  for (const key of keys) {
    if (a && key === 'length') continue;
    requireInput(typeof key === 'string');
    if (a) requireInput(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length);
    const d = Object.getOwnPropertyDescriptor(value, key);
    requireInput(d.enumerable && Object.hasOwn(d, 'value'));
    plain(d.value, seen);
  }
  seen.delete(value);
}
function shape(value, keys) {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireInput(Reflect.ownKeys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k)));
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); requireInput(d.enumerable && Object.hasOwn(d, 'value')); }
}
function identity(value) {
  for (const key of ID) requireInput(['turn', 'step'].includes(key) ? Number.isSafeInteger(value[key]) && value[key] >= 0 : text(value[key]));
}
const cutKey = (r) => JSON.stringify([r.sessionId, r.rootMessageId, r.generation]);
const failureKey = (r) => JSON.stringify([r.sessionId, r.rootMessageId, r.generation, r.turn, r.step]);
const scopeKey = (r) => JSON.stringify([r.scopeId, r.bindingRevision]);
const stop = (reason) => ({ kind: 'stop', reason });

/** Options are bounded; malformed values throw INVALID_INPUT synchronously. */
export function createHotRecoveryCoordinator(ports, options = {}) {
  shape(ports, ['inspect', 'query', 'clock']);
  requireInput(typeof ports.inspect === 'function' && typeof ports.query === 'function');
  shape(ports.clock, ['now', 'setTimeout', 'clearTimeout']);
  for (const key of ['now', 'setTimeout', 'clearTimeout']) requireInput(typeof ports.clock[key] === 'function');
  plain(options);
  requireInput(options !== null && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every((k) => ['maxWaitMs', 'maxChecks', 'backoffMs'].includes(k)));
  const maxWaitMs = Object.hasOwn(options, 'maxWaitMs') ? options.maxWaitMs : 3600000;
  const maxChecks = Object.hasOwn(options, 'maxChecks') ? options.maxChecks : 30;
  const backoff = Object.hasOwn(options, 'backoffMs') ? structuredClone(options.backoffMs) : [1000, 5000, 15000, 60000];
  requireInput(Number.isSafeInteger(maxWaitMs) && maxWaitMs >= 1 && maxWaitMs <= 86400000);
  requireInput(Number.isSafeInteger(maxChecks) && maxChecks >= 1 && maxChecks <= 1000);
  requireInput(Array.isArray(backoff) && backoff.length > 0 && backoff.length <= 32 && backoff.every((v, i) => Number.isSafeInteger(v) && v >= 1 && v <= 3600000 && (i === 0 || v >= backoff[i - 1])));
  const clock = ports.clock;
  let closed = false, closePromise = null;
  const jobs = new Set(), seen = new Set(), revoked = new Set(), flights = new Map(), cooldown = new Map();
  const now = () => { const t = clock.now(); requireInput(Number.isSafeInteger(t) && t >= 0); return t; };
  const delayAt = (checks) => backoff[Math.min(Math.max(checks - 1, 0), backoff.length - 1)];

  // Race *every* async boundary against the job signal. The callback is invoked
  // in a microtask only after checking cancellation, preventing late new I/O.
  function boundary(signal, callback) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (done) return; done = true; signal.removeEventListener('abort', onAbort); fn(value); };
      const onAbort = () => finish(reject, abortReason());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      Promise.resolve().then(() => { if (signal.aborted) throw abortReason(); return callback(); }).then((v) => finish(resolve, v), (e) => finish(reject, e));
    });
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => { if (timer !== null) clock.clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(abortReason()); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      timer = clock.setTimeout(() => { cleanup(); resolve(); }, ms);
    });
  }
  function validFacts(f, r) {
    plain(f); shape(f, [...ID, ...FLAGS]); identity(f);
    return ID.every((k) => f[k] === r[k]) && FLAGS.every((k) => f[k] === true);
  }
  function snapshotState(raw, r, time) {
    plain(raw); shape(raw, ['bindingRevision', 'snapshot']);
    const q = raw.snapshot;
    if (raw.bindingRevision !== r.bindingRevision || validateQuotaSnapshot(q).length || q.scopeKey !== r.scopeId || q.source !== 'proxy-query') return 'invalid';
    const observed = Date.parse(q.observedAt), until = Date.parse(q.validUntil);
    if (!Number.isFinite(observed) || !Number.isFinite(until) || observed > time || time - observed > SNAPSHOT_TTL_MS || until <= time || until <= observed || until - observed > SNAPSHOT_TTL_MS) return 'stale';
    if (q.state === 'auth_required') return 'auth_required';
    if (q.state === 'available' && q.releaseRecommended === true && q.blockingWindows.length === 0 && q.errorClass === null) return 'available';
    return 'blocked';
  }
  async function query(r, signal, checks) {
    const key = scopeKey(r);
    let f = flights.get(key);
    if (!f) {
      const controller = new AbortController();
      f = { controller, users: 0, promise: null };
      flights.set(key, f);
      const input = Object.freeze({ scopeId: r.scopeId, bindingRevision: r.bindingRevision, signal: controller.signal });
      f.promise = boundary(controller.signal, () => ports.query(input));
      // Catch both resolution paths and update only live, owned flight state.
      f.promise.then(() => finishFlight(), () => finishFlight());
      const finishFlight = () => {
        if (flights.get(key) === f) flights.delete(key);
        const liveUser = [...jobs].some((j) => !j.controller.signal.aborted && scopeKey(j.r) === key);
        if (!closed && !controller.signal.aborted && liveUser) {
          try { cooldown.set(key, now() + delayAt(checks)); } catch { /* invalid clock fails waiter closed */ }
        }
      };
    }
    f.users++;
    try { return await boundary(signal, () => f.promise); }
    finally {
      f.users--;
      if (f.users === 0 && flights.get(key) === f) { flights.delete(key); f.controller.abort(); }
    }
  }

  function waitForRetry(request) {
    shape(request, [...ID, 'signal']); identity(request);
    requireInput(request.signal instanceof AbortSignal);
    const r = Object.freeze(Object.fromEntries(ID.map((k) => [k, request[k]])));
    if (closed) return Promise.resolve(stop('closed'));
    if (request.signal.aborted) return Promise.resolve(stop('cancelled'));
    if (revoked.has(cutKey(r))) return Promise.resolve(stop('revoked'));
    const key = failureKey(r);
    if (seen.has(key)) return Promise.resolve(stop('duplicate'));
    seen.add(key);
    const controller = new AbortController();
    const job = { r, controller, promise: null, reason: null };
    const cancel = () => { job.reason ??= 'cancelled'; controller.abort(); };
    request.signal.addEventListener('abort', cancel, { once: true });
    const start = now(), deadline = start + maxWaitMs;
    requireInput(Number.isSafeInteger(deadline));
    const timer = clock.setTimeout(() => { job.reason ??= 'max_wait'; controller.abort(); }, maxWaitMs);
    let lastTime = start;
    const live = () => {
      if (closed || controller.signal.aborted || request.signal.aborted || revoked.has(cutKey(r))) return false;
      const time = now();
      if (time < lastTime || time >= deadline) { job.reason ??= time < lastTime ? 'clock_changed' : 'max_wait'; controller.abort(); return false; }
      lastTime = time; return true;
    };
    const run = async () => {
      let checks = 0;
      try {
        while (live()) {
          if (checks >= maxChecks) return stop('max_checks');
          const f = await boundary(controller.signal, () => ports.inspect(Object.freeze({ ...r, signal: controller.signal })));
          if (!live()) break;
          if (!validFacts(f, r)) return stop('facts_changed');
          const nextAt = cooldown.get(scopeKey(r)) ?? 0;
          if (now() < nextAt && !flights.has(scopeKey(r))) {
            await sleep(Math.min(nextAt - now(), Math.max(deadline - now(), 1)), controller.signal);
            continue; // re-inspect after backoff, never trust earlier facts
          }
          checks++;
          const raw = await query(r, controller.signal, checks);
          if (!live()) break;
          const state = snapshotState(raw, r, now());
          if (state === 'invalid') return stop('invalid_quota');
          if (state === 'auth_required') return stop('auth_required');
          if (state === 'available') {
            const finalFacts = await boundary(controller.signal, () => ports.inspect(Object.freeze({ ...r, signal: controller.signal })));
            if (!live()) break;
            if (!validFacts(finalFacts, r)) return stop('facts_changed');
            if (snapshotState(raw, r, now()) !== 'available') continue;
            return { kind: 'retry' };
          }
          if (checks >= maxChecks) return stop('max_checks');
          await sleep(Math.min(delayAt(checks), Math.max(deadline - now(), 1)), controller.signal);
        }
        return stop(job.reason ?? (closed ? 'closed' : 'cancelled'));
      } catch {
        return stop(job.reason ?? (controller.signal.aborted ? 'cancelled' : 'port_error'));
      } finally {
        clock.clearTimeout(timer);
        request.signal.removeEventListener('abort', cancel);
        jobs.delete(job);
      }
    };
    jobs.add(job);
    job.promise = Promise.resolve().then(run);
    return job.promise;
  }
  function revoke(cut) {
    plain(cut); shape(cut, ['sessionId', 'rootMessageId', 'generation']);
    requireInput(['sessionId', 'rootMessageId', 'generation'].every((k) => text(cut[k])));
    if (closed) return;
    const key = cutKey(cut); revoked.add(key);
    for (const job of jobs) if (cutKey(job.r) === key) { job.reason = 'revoked'; job.controller.abort(); }
  }
  function close() {
    if (closePromise !== null) return closePromise;
    closed = true;
    for (const job of jobs) { job.reason = 'closed'; job.controller.abort(); }
    for (const f of flights.values()) f.controller.abort();
    flights.clear(); cooldown.clear();
    closePromise = Promise.allSettled([...jobs].map((j) => j.promise)).then(() => { seen.clear(); revoked.clear(); });
    return closePromise;
  }
  return Object.freeze({ waitForRetry, revoke, close });
}
