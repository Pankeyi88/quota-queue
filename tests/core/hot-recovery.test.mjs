import test from 'node:test';
import assert from 'node:assert/strict';
import { createHotRecoveryCoordinator } from '../../core/hot-recovery.mjs';
import { normalizeQuota } from '../../core/quota.mjs';

const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
function manualClock() {
  let time = 1000000, seq = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  return {
    clock, now: () => time, jump: (ms) => { time += ms; }, count: () => timers.size,
    async advance(ms) {
      await flush(); const target = time + ms;
      for (let n = 0; n < 1000; n++) {
        const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = target; await flush(); return; }
        time = Math.max(time, next[1].at); timers.delete(next[0]); next[1].fn(); await flush();
      }
      throw new Error('timer loop');
    },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const request = (extras = {}) => ({ sessionId: 'session', rootMessageId: 'root', generation: 'task-g1', turn: 1, step: 2, scopeId: 'quota', bindingRevision: 'binding-1', signal: new AbortController().signal, ...extras });
const facts = (input, extras = {}) => {
  const { signal, ...r } = input;
  return { ...r, authorized: true, bindingConfirmed: true, ownershipConfirmed: true, requestSettled: true, noOtherRequest: true, quotaFailureConfirmed: true, configurationUnchanged: true, ...extras };
};
function quota(m, state = 'available', bindingRevision = 'binding-1') {
  return { bindingRevision, snapshot: normalizeQuota({ scopeKey: 'quota', now: m.now(), outerStatus: state === 'auth_required' ? 401 : 200, envelope: { status_code: 200, body: state === 'unknown' ? {} : { rate_limit: { allowed: state === 'available', limit_reached: state === 'exhausted' } } } }) };
}
function setup({ inspect, query, options } = {}) {
  const m = manualClock(); const calls = { inspect: [], query: [] };
  const core = createHotRecoveryCoordinator({
    clock: m.clock,
    inspect: (r) => { calls.inspect.push(r); return inspect ? inspect(r, m, calls) : facts(r); },
    query: (r) => { calls.query.push(r); return query ? query(r, m, calls) : quota(m); },
  }, options ?? { maxWaitMs: 10000, maxChecks: 3, backoffMs: [100, 200] });
  return { core, m, calls };
}

test('same hot identity, exact facts before and after actual proxy quota return retry without messages', async () => {
  const { core, calls, m } = setup();
  assert.deepEqual(await core.waitForRetry(request()), { kind: 'retry' });
  assert.equal(calls.inspect.length, 2); assert.equal(calls.query.length, 1);
  assert.deepEqual(Object.keys(calls.query[0]).sort(), ['bindingRevision', 'scopeId', 'signal']);
  assert.ok(calls.inspect[0].signal instanceof AbortSignal); assert.ok(Object.isFrozen(calls.inspect[0]));
  assert.equal(m.count(), 0); await core.close();
});

test('duplicate simultaneous callback has one owner and cannot receive a second retry after completion', async () => {
  const d = deferred(), { core, calls, m } = setup({ query: () => d.promise });
  const first = core.waitForRetry(request()); const second = core.waitForRetry(request()); await flush();
  assert.deepEqual(await second, { kind: 'stop', reason: 'duplicate' }); assert.equal(calls.query.length, 1);
  d.resolve(quota(m)); assert.deepEqual(await first, { kind: 'retry' });
  assert.deepEqual(await core.waitForRetry(request()), { kind: 'stop', reason: 'duplicate' });
  // No correlated recoveryAttemptId exists in this API: repeated exhaustion of
  // this task turn/step remains unsupported, never mint a new task generation.
  await core.close();
});

test('different failures same scope share one in-flight quota query', async () => {
  const d = deferred(), { core, calls, m } = setup({ query: () => d.promise });
  const a = core.waitForRetry(request()), b = core.waitForRetry(request({ sessionId: 'other-session', rootMessageId: 'other-root' }));
  await flush(); assert.equal(calls.query.length, 1); d.resolve(quota(m));
  assert.deepEqual(await a, { kind: 'retry' }); assert.deepEqual(await b, { kind: 'retry' });
  await core.close(); assert.equal(m.count(), 0);
});

test('one shared waiter cancelled does not abort another authorized owner', async () => {
  const d = deferred(), aSignal = new AbortController(), { core, calls, m } = setup({ query: () => d.promise });
  const a = core.waitForRetry(request({ signal: aSignal.signal })), b = core.waitForRetry(request({ sessionId: 'b' }));
  await flush(); aSignal.abort(); assert.deepEqual(await a, { kind: 'stop', reason: 'cancelled' });
  assert.equal(calls.query[0].signal.aborted, false); d.resolve(quota(m)); assert.deepEqual(await b, { kind: 'retry' }); await core.close();
});

test('binding, identity, authorization, ownership and settled-request changes after query never retry', async () => {
  for (const extras of [{ bindingRevision: 'changed' }, { rootMessageId: 'new-user-message' }, { generation: 'future' }, { turn: 2 }, { step: 3 }, { scopeId: 'other' }, { authorized: false }, { ownershipConfirmed: false }, { bindingConfirmed: false }, { requestSettled: false }, { noOtherRequest: false }, { quotaFailureConfirmed: false }, { configurationUnchanged: false }]) {
    let count = 0;
    const { core } = setup({ inspect: (r) => facts(r, ++count === 2 ? extras : {}) });
    assert.deepEqual(await core.waitForRetry(request()), { kind: 'stop', reason: 'facts_changed' }); await core.close();
  }
});

test('initial missing/negative Host evidence refuses before querying', async () => {
  for (const mutation of [(f) => { delete f.authorized; }, (f) => { f.authorized = 'true'; }, (f) => { f.bindingConfirmed = false; }, (f) => { f.ownershipConfirmed = false; }, (f) => { f.raw = 'not permitted'; }]) {
    const { core, calls } = setup({ inspect: (r) => { const f = facts(r); mutation(f); return f; } });
    assert.notEqual((await core.waitForRetry(request())).kind, 'retry'); assert.equal(calls.query.length, 0); await core.close();
  }
});

test('abort hanging quota returns promptly, aborts port and ignores late success', async () => {
  const d = deferred(), signal = new AbortController(), { core, calls, m } = setup({ query: () => d.promise });
  const p = core.waitForRetry(request({ signal: signal.signal })); await flush(); signal.abort();
  assert.deepEqual(await p, { kind: 'stop', reason: 'cancelled' }); assert.equal(calls.query[0].signal.aborted, true);
  const inspected = calls.inspect.length; d.resolve(quota(m)); await flush(); assert.equal(calls.inspect.length, inspected); assert.equal(calls.query.length, 1); assert.equal(m.count(), 0); await core.close();
});

test('abort during backoff clears wait timers and starts no late queries', async () => {
  const signal = new AbortController(), { core, calls, m } = setup({ query: (r, m) => quota(m, 'exhausted') });
  const p = core.waitForRetry(request({ signal: signal.signal })); await flush(); assert.equal(calls.query.length, 1);
  signal.abort(); assert.equal((await p).kind, 'stop'); assert.equal(m.count(), 0);
  await m.advance(10000); assert.equal(calls.query.length, 1); await core.close();
});

test('revoke aborts active cut and prevents future calls; other generation is not implicitly authorized', async () => {
  const d = deferred(), { core, calls } = setup({ query: () => d.promise, inspect: (r) => facts(r, { authorized: r.generation === 'task-g1' }) });
  const p = core.waitForRetry(request()); await flush();
  core.revoke({ sessionId: 'session', rootMessageId: 'root', generation: 'task-g1' });
  assert.deepEqual(await p, { kind: 'stop', reason: 'revoked' }); assert.equal(calls.query[0].signal.aborted, true);
  assert.deepEqual(await core.waitForRetry(request()), { kind: 'stop', reason: 'revoked' });
  assert.deepEqual(await core.waitForRetry(request({ generation: 'future' })), { kind: 'stop', reason: 'facts_changed' });
  d.reject(new Error('late external failure')); await flush(); await core.close();
});

test('close merges lifetime cancellation and drains non-cooperative inspect/query and backoff waits', async () => {
  for (const phase of ['inspect', 'query', 'wait']) {
    const d = deferred();
    const { core, m, calls } = setup({ inspect: phase === 'inspect' ? () => d.promise : undefined, query: phase === 'query' ? () => d.promise : phase === 'wait' ? (r, m) => quota(m, 'exhausted') : undefined });
    const p = core.waitForRetry(request()); await flush(); const closing = core.close(); assert.equal(core.close(), closing); await closing;
    assert.deepEqual(await p, { kind: 'stop', reason: 'closed' }); assert.equal(m.count(), 0);
    const before = [calls.query.length, calls.inspect.length]; d.resolve(phase === 'inspect' ? facts(request()) : quota(m)); await flush();
    assert.deepEqual([calls.query.length, calls.inspect.length], before);
    assert.deepEqual(await core.waitForRetry(request({ step: 20 })), { kind: 'stop', reason: 'closed' });
  }
});

test('unknown/exhausted snapshots wait with controlled increasing backoff until maxChecks', async () => {
  const { core, m, calls } = setup({ query: (r, m) => quota(m, 'unknown') });
  const p = core.waitForRetry(request()); await flush(); assert.equal(calls.query.length, 1);
  await m.advance(99); assert.equal(calls.query.length, 1);
  await m.advance(1); assert.equal(calls.query.length, 2);
  await m.advance(199); assert.equal(calls.query.length, 2);
  await m.advance(1); assert.equal(calls.query.length, 3);
  assert.deepEqual(await p, { kind: 'stop', reason: 'max_checks' }); assert.equal(m.count(), 0); await core.close();
});

test('shared cooldown prevents new failures from bypassing scope backoff', async () => {
  let available = false;
  const { core, m, calls } = setup({ query: (r, m) => quota(m, available ? 'available' : 'exhausted') });
  const a = core.waitForRetry(request()); await flush();
  const b = core.waitForRetry(request({ sessionId: 'b' })); await flush(); assert.equal(calls.query.length, 1);
  available = true; await m.advance(100); assert.equal(calls.query.length, 2);
  assert.deepEqual(await a, { kind: 'retry' });
  // An already-settled query is not a cached permission. A waiter that misses
  // the in-flight interval observes shared cooldown then performs a fresh read.
  await m.advance(200); assert.deepEqual(await b, { kind: 'retry' }); assert.ok(calls.query.length <= 3); await core.close();
});

test('auth, wrong source/binding/scope or malformed quota never releases', async () => {
  for (const mutate of [
    (q, m) => quota(m, 'auth_required'),
    (q) => ({ ...q, bindingRevision: 'different' }),
    (q) => { q.snapshot.source = 'manual'; return q; },
    (q) => { q.snapshot.scopeKey = 'different'; return q; },
    (q) => { q.snapshot.releaseRecommended = false; return q; },
    (q) => { q.snapshot.secret = 'forbidden'; return q; },
  ]) {
    const { core, m } = setup({ query: (r, m) => mutate(quota(m), m), options: { maxChecks: 1, maxWaitMs: 1000, backoffMs: [10] } });
    assert.notEqual((await core.waitForRetry(request())).kind, 'retry'); await core.close(); assert.equal(m.count(), 0);
  }
});

test('observedAt/TTL checked before and after second inspect, not just validUntil', async () => {
  for (const variant of ['stale-observation', 'future', 'expired', 'excessive-ttl', 'expires-during-inspect']) {
    let inspections = 0;
    const { core, m } = setup({
      inspect: (r, m) => { if (++inspections === 2 && variant === 'expires-during-inspect') m.jump(60001); return facts(r); },
      query: (r, m) => {
        const q = quota(m);
        if (variant === 'stale-observation') q.snapshot.observedAt = new Date(m.now() - 60001).toISOString();
        if (variant === 'future') q.snapshot.observedAt = new Date(m.now() + 1).toISOString();
        if (variant === 'expired') q.snapshot.validUntil = new Date(m.now()).toISOString();
        if (variant === 'excessive-ttl') q.snapshot.validUntil = new Date(m.now() + 60001).toISOString();
        return q;
      },
      options: { maxChecks: 1, maxWaitMs: 100000, backoffMs: [10] },
    });
    assert.notEqual((await core.waitForRetry(request())).kind, 'retry'); await core.close(); assert.equal(m.count(), 0);
  }
});

test('maxWait deadline cancels hanging query and does not deadlock', async () => {
  const { core, m, calls } = setup({ query: () => new Promise(() => {}), options: { maxChecks: 10, maxWaitMs: 50, backoffMs: [10] } });
  const p = core.waitForRetry(request()); await flush(); await m.advance(50);
  assert.deepEqual(await p, { kind: 'stop', reason: 'max_wait' }); assert.equal(calls.query[0].signal.aborted, true); assert.equal(m.count(), 0); await core.close();
});

test('pre-aborted signal, invalid options/input and late rejecting ports cannot produce retry', async () => {
  const signal = new AbortController(); signal.abort(); const { core, calls } = setup();
  assert.deepEqual(await core.waitForRetry(request({ signal: signal.signal })), { kind: 'stop', reason: 'cancelled' }); assert.equal(calls.inspect.length, 0);
  for (const r of [request({ signal: null }), request({ turn: -1 }), request({ step: '2' }), { ...request(), raw: 'no' }]) assert.throws(() => core.waitForRetry(r), { code: 'INVALID_INPUT' });
  const m = manualClock(), ports = { inspect: facts, query: () => quota(m), clock: m.clock };
  for (const options of [{ maxChecks: 0 }, { maxWaitMs: 0 }, { backoffMs: [] }, { backoffMs: [0] }, { backoffMs: [20, 10] }, { enable: true }, { maxChecks: undefined }]) assert.throws(() => createHotRecoveryCoordinator(ports, options), { code: 'INVALID_INPUT' });
  await core.close();
});
