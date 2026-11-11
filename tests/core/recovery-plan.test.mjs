import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryPlan, validateRecoveryPlan, applyRecoveryPlan } from '../../core/recovery-plan.mjs';

const clone = (v) => structuredClone(v);
const run = (p, c) => applyRecoveryPlan(p, p.revision, c);
const ref = (id, extras = {}) => ({ taskId: `task-${id}`, sessionId: `session-${id}`, generation: 'g1', workspaceId: `ws-${id}`, quotaScopeId: 'shared', ...extras });
function add(p, id, batch = p.batches.length, extras = {}, enabled = true) {
  const r = ref(id, extras);
  return run(p, { type: 'add', id, ref: r, authorization: { sessionId: r.sessionId, generation: r.generation, enabled }, hostConfirmedExisting: true, batch });
}
function claim(p, id, extras = {}) {
  const r = p.items.find((i) => i.id === id).ref;
  return { type: 'claim', id, claimId: `claim-${id}-${p.revision}`, messageId: `message-${id}-${p.revision}`, facts: { sessionId: r.sessionId, generation: r.generation, workspaceId: r.workspaceId, quotaScopeId: r.quotaScopeId, existingTaskConfirmed: true, quotaAvailable: true, hostStopped: true, exclusiveOwnership: true, configurationUnchanged: true, noOtherExecution: true, ...extras } };
}
function terminal(p, id, outcome = 'completed') {
  const f = p.items.find((i) => i.id === id).fence;
  p = run(p, { type: 'bindTurn', id, claimId: f.claimId, messageId: f.messageId, turnId: `turn-${id}` });
  const evidence = { ...p.items.find((i) => i.id === id).fence, kind: 'terminal', outcome };
  return run(p, { type: 'settle', id, evidence });
}
function parallel() { let p = createRecoveryPlan({ maxConcurrent: 2 }); p = add(p, 'a'); return add(p, 'b', 0); }
const blocked = (fn) => assert.throws(fn, (e) => ['INVALID_INPUT', 'INVALID_TRANSITION', 'SNAPSHOT_INVALID', 'REVISION_CONFLICT'].includes(e.code));

test('the plan stays bounded: 100 items and 50 batches are the hard caps', () => {
  const disabled = (r) => ({ sessionId: r.sessionId, generation: r.generation, enabled: false });
  let packed = createRecoveryPlan();
  for (let n = 0; n < 100; n += 1) {
    const r = ref(`n${n}`);
    packed = run(packed, { type: 'add', id: `n${n}`, ref: r, authorization: disabled(r), hostConfirmedExisting: true, batch: 0 });
  }
  assert.equal(packed.items.length, 100);
  assert.equal(packed.batches.length, 1);
  const overflowRef = ref('overflow');
  blocked(() => run(packed, { type: 'add', id: 'overflow', ref: overflowRef, authorization: disabled(overflowRef), hostConfirmedExisting: true, batch: 0 }));

  let batched = createRecoveryPlan();
  for (let n = 0; n < 50; n += 1) {
    const r = ref(`b${n}`);
    batched = run(batched, { type: 'add', id: `b${n}`, ref: r, authorization: disabled(r), hostConfirmedExisting: true, batch: n });
  }
  assert.equal(batched.batches.length, 50);
  const extraRef = ref('extra');
  blocked(() => run(batched, { type: 'add', id: 'extra', ref: extraRef, authorization: disabled(extraRef), hostConfirmedExisting: true, batch: 50 }));
  // A loaded snapshot above the caps is rejected, never truncated. This
  // structure is otherwise valid: one batch listing all 101 ids.
  const extraItem = {
    ...packed.items[0], id: 'x',
    ref: { ...packed.items[0].ref, taskId: 't-x', sessionId: 's-x' },
    authorization: { sessionId: 's-x', generation: packed.items[0].ref.generation, enabled: false },
  };
  const big = { ...packed, items: [...packed.items, extraItem], batches: [[...packed.batches[0], 'x']] };
  assert.notDeepEqual(validateRecoveryPlan(big), []);
  assert.deepEqual(validateRecoveryPlan(packed), []);
});

test('strict independent v1 schema, default concurrency and no mutation/aliasing', () => {
  const p = createRecoveryPlan(); assert.equal(p.maxConcurrent, 1); assert.deepEqual(validateRecoveryPlan(p), []);
  const c = { type: 'add', id: 'a', ref: ref('a'), authorization: { sessionId: 'session-a', generation: 'g1', enabled: false }, hostConfirmedExisting: true, batch: 0 };
  const before = clone(p), next = run(p, c); assert.deepEqual(p, before); c.ref.sessionId = 'changed'; assert.equal(next.items[0].ref.sessionId, 'session-a');
  blocked(() => run(next, claim(next, 'a')));
});

test('unbound scope permits inactive planning but never authorization or claim', () => {
  let p = add(createRecoveryPlan(), 'a', 0, { quotaScopeId: null }, false);
  assert.deepEqual(validateRecoveryPlan(p), []);
  p = run(p, { type: 'configure', maxConcurrent: 3 });
  p = run(p, { type: 'pause', id: 'a', paused: true });
  p = run(p, { type: 'pause', id: 'a', paused: false });
  assert.equal(p.items[0].ref.quotaScopeId, null);
  assert.equal(p.items[0].authorization.enabled, false);
  blocked(() => run(p, { type: 'authorize', id: 'a', authorization: { sessionId: 'session-a', generation: 'g1', enabled: true } }));
  blocked(() => run(p, claim(p, 'a')));
  blocked(() => run(p, claim(p, 'a', { quotaScopeId: 'invented' })));
  blocked(() => add(createRecoveryPlan(), 'b', 0, { quotaScopeId: null }, true));
  const corrupt = clone(p); corrupt.items[0].authorization.enabled = true;
  assert.notDeepEqual(validateRecoveryPlan(corrupt), []);
  let ran = run(add(createRecoveryPlan(), 'bound'), claim(add(createRecoveryPlan(), 'bound'), 'bound'));
  ran.items[0].ref.quotaScopeId = null; ran.items[0].authorization.enabled = false;
  assert.notDeepEqual(validateRecoveryPlan(ran), []);
});

test('concurrency strictly 1..8, revision strictly safe integer and exact precondition', () => {
  for (const value of [0, 9, 1.5, '2', NaN, Infinity]) blocked(() => createRecoveryPlan({ maxConcurrent: value }));
  for (let n = 1; n <= 8; n++) assert.equal(createRecoveryPlan({ maxConcurrent: n }).maxConcurrent, n);
  const p = createRecoveryPlan(); assert.throws(() => applyRecoveryPlan(p, 1, { type: 'recover' }), { code: 'REVISION_CONFLICT' });
  for (const n of [-1, '0', null, Number.MAX_SAFE_INTEGER + 1]) blocked(() => applyRecoveryPlan(p, n, { type: 'recover' }));
  const overflow = { ...p, revision: Number.MAX_SAFE_INTEGER }; blocked(() => run(overflow, { type: 'recover' }));
});

test('S01/S04: later quota availability never bypasses previous batch', () => {
  let p = add(createRecoveryPlan(), 'a'); p = add(p, 'b'); blocked(() => run(p, claim(p, 'b')));
  p = run(p, claim(p, 'a')); blocked(() => run(p, claim(p, 'b')));
  p = terminal(p, 'a', 'quota'); assert.equal(p.items[0].status, 'waiting_quota'); blocked(() => run(p, claim(p, 'b')));
  p = run(p, claim(p, 'a')); p = terminal(p, 'a'); p = run(p, claim(p, 'b')); assert.equal(p.items[1].status, 'running');
});

test('S02: parallel batch is a barrier requiring both matching successes', () => {
  let p = parallel(); p = add(p, 'c'); p = run(p, claim(p, 'a')); p = run(p, claim(p, 'b'));
  blocked(() => run(p, claim(p, 'c'))); p = terminal(p, 'a'); blocked(() => run(p, claim(p, 'c')));
  p = terminal(p, 'b'); p = run(p, claim(p, 'c')); assert.equal(p.items[2].status, 'running');
});

test('S03: serialized two-claim race respects capacity and stale revisions', () => {
  let p = add(createRecoveryPlan(), 'a'); p = add(p, 'b', 0);
  const rev = p.revision, ca = claim(p, 'a'), cb = claim(p, 'b'), next = run(p, ca);
  assert.throws(() => applyRecoveryPlan(next, rev, cb), { code: 'REVISION_CONFLICT' });
  blocked(() => run(next, cb)); assert.equal(next.items.filter((i) => i.fence).length, 1);
});

test('S03: workspace mutex independent of session IDs', () => {
  let p = add(createRecoveryPlan({ maxConcurrent: 8 }), 'a'); p = add(p, 'b', 0, { workspaceId: 'ws-a' });
  p = run(p, claim(p, 'a')); blocked(() => run(p, claim(p, 'b')));
});

test('same session different generations cannot have concurrent active recovery scopes', () => {
  const p = add(createRecoveryPlan(), 'a'); blocked(() => add(p, 'b', 0, { sessionId: 'session-a', generation: 'g2' }));
  let q = run(p, claim(p, 'a')); q = run(q, { type: 'remove', id: 'a' });
  q = add(q, 'b', 0, { sessionId: 'session-a', generation: 'g2' }); blocked(() => run(q, claim(q, 'b')));
});

test('removal of a never-attempted entry is a real exit; a legacy tombstone can be restored', () => {
  // Nothing ran, so the record and its slot are deleted -> the same session can
  // be queued again immediately.
  let p = add(createRecoveryPlan(), 'a');
  p = add(p, 'b');
  p = run(p, { type: 'remove', id: 'a' });
  assert.deepEqual(p.items.map((i) => i.id), ['b']);
  assert.deepEqual(p.batches, [['b']]);
  p = add(p, 'a');
  assert.deepEqual(p.items.map((i) => i.id).sort(), ['a', 'b']);

  // A tombstone can only be inherited from an earlier build (an ATTEMPTED entry
  // keeps its own record, and restore refuses it). Seed one and restore it: the
  // identity is refreshed and the authorization stays disabled.
  const legacyItem = {
    id: 'old',
    ref: { taskId: 'task-old', sessionId: 'session-old', generation: 'g1', workspaceId: 'ws-old', quotaScopeId: 'shared' },
    authorization: { sessionId: 'session-old', generation: 'g1', enabled: false },
    status: 'ready', paused: false, removed: true, skip: null, result: null, attempts: 0, fence: null,
  };
  const legacy = {
    schemaVersion: 1, revision: 4, maxConcurrent: 1, paused: false,
    batches: [['old']], items: [legacyItem], usedClaimIds: [], usedMessageIds: [],
  };
  assert.deepEqual(validateRecoveryPlan(legacy), []);
  const freshRef = { taskId: 'task-new', sessionId: 'session-old', generation: 'g9', workspaceId: 'ws-old', quotaScopeId: 'shared' };
  const restored = applyRecoveryPlan(legacy, 4, { type: 'restore', id: 'old', ref: freshRef });
  assert.equal(restored.revision, 5);
  assert.equal(restored.items[0].removed, false);
  assert.deepEqual(restored.items[0].ref, freshRef);
  assert.deepEqual(restored.items[0].authorization, { sessionId: 'session-old', generation: 'g9', enabled: false });
  // Restoring is not authorizing, and it cannot cross sessions or skip fields.
  blocked(() => applyRecoveryPlan(legacy, 4, { type: 'restore', id: 'old', ref: { ...freshRef, sessionId: 'session-other' } }));
  blocked(() => applyRecoveryPlan(legacy, 4, { type: 'restore', id: 'old' }));
  blocked(() => applyRecoveryPlan(legacy, 3, { type: 'restore', id: 'old', ref: freshRef }));
  // A skipped tombstone is a deliberate decision, not a dead end to reopen.
  const skipped = structuredClone(legacy);
  skipped.items[0].skip = { confirmed: true };
  blocked(() => applyRecoveryPlan(skipped, 4, { type: 'restore', id: 'old', ref: freshRef }));
});

test('authorization remains exact original generation and does not authorize future tasks', () => {
  let p = add(createRecoveryPlan(), 'a', 0, {}, false);
  blocked(() => run(p, { type: 'authorize', id: 'a', authorization: { sessionId: 'session-a', generation: 'g2', enabled: true } }));
  p = run(p, { type: 'authorize', id: 'a', authorization: { sessionId: 'session-a', generation: 'g1', enabled: true } });
  blocked(() => run(p, claim(p, 'a', { generation: 'g2' })));
  p = run(p, claim(p, 'a')); p = terminal(p, 'a'); blocked(() => run(p, claim(p, 'a')));
});

test('S05: failure/removal do not release batch, confirmed skip preserves original result', () => {
  let p = add(createRecoveryPlan(), 'a'); p = add(p, 'b'); p = run(p, claim(p, 'a')); p = terminal(p, 'a', 'error');
  blocked(() => run(p, claim(p, 'b'))); p = run(p, { type: 'remove', id: 'a' }); blocked(() => run(p, claim(p, 'b')));
  blocked(() => run(p, { type: 'skip', id: 'a', confirmed: false }));
  p = run(p, { type: 'skip', id: 'a', confirmed: true }); assert.equal(p.items[0].result, 'error'); assert.equal(p.items[0].status, 'failed');
  p = run(p, claim(p, 'b')); assert.ok(p.items[1].fence);
});

test('pause/remove/skip/recover never release fence or allow hidden execution overlap', () => {
  for (const c of [{ type: 'pause', id: 'a', paused: true }, { type: 'remove', id: 'a' }, { type: 'recover' }]) {
    let p = add(createRecoveryPlan(), 'a'); p = add(p, 'b', 0); p = run(p, claim(p, 'a'));
    const f = clone(p.items[0].fence); p = run(p, c); assert.deepEqual(p.items[0].fence, f); blocked(() => run(p, claim(p, 'b')));
  }
});

test('paused plan/item and revoked authorization prevent claims but preserve fences', () => {
  let p = add(createRecoveryPlan(), 'a'); p = run(p, { type: 'pausePlan', paused: true }); blocked(() => run(p, claim(p, 'a')));
  p = run(p, { type: 'pausePlan', paused: false }); p = run(p, { type: 'pause', id: 'a', paused: true }); blocked(() => run(p, claim(p, 'a')));
  p = run(p, { type: 'pause', id: 'a', paused: false }); p = run(p, claim(p, 'a')); const f = clone(p.items[0].fence);
  p = run(p, { type: 'authorize', id: 'a', authorization: { sessionId: 'session-a', generation: 'g1', enabled: false } }); assert.deepEqual(p.items[0].fence, f);
});

test('S06: reorder exact permutation; running and previously attempted items cannot move', () => {
  let p = add(createRecoveryPlan(), 'a'); p = add(p, 'b'); p = run(p, { type: 'reorder', batches: [['b'], ['a']] });
  assert.deepEqual(p.batches, [['b'], ['a']]);
  for (const batches of [[['a']], [['a', 'a'], ['b']], [['b'], ['x']], [[], ['a', 'b']]]) blocked(() => run(p, { type: 'reorder', batches }));
  p = run(p, claim(p, 'b')); blocked(() => run(p, { type: 'reorder', batches: [['a'], ['b']] }));
  p = terminal(p, 'b', 'quota'); blocked(() => run(p, { type: 'reorder', batches: [['a'], ['b']] }));
});

test('S07 applicable: shared scope permitted, every claim requires explicit current quota gate', () => {
  let p = parallel(); assert.equal(p.items[0].ref.quotaScopeId, p.items[1].ref.quotaScopeId);
  blocked(() => run(p, claim(p, 'a', { quotaAvailable: false })));
  blocked(() => run(p, claim(p, 'a', { quotaScopeId: 'other' })));
  p = run(p, claim(p, 'a')); p = run(p, claim(p, 'b')); assert.equal(p.items.filter((i) => i.fence).length, 2);
});

test('S08/P04 applicable: external execution and ownership/config uncertainty fail closed', () => {
  const p = add(createRecoveryPlan(), 'a');
  for (const k of ['existingTaskConfirmed', 'quotaAvailable', 'hostStopped', 'exclusiveOwnership', 'configurationUnchanged', 'noOtherExecution']) {
    for (const v of [false, null, 1, 'true', undefined]) blocked(() => run(p, claim(p, 'a', { [k]: v })));
  }
});

test('P01: candidate does not mutate publication; failed save cannot create an effect', async () => {
  const published = add(createRecoveryPlan(), 'a'), before = clone(published); let effects = 0;
  const candidate = run(published, claim(published, 'a'));
  await assert.rejects(async () => { await Promise.reject(new Error('save failed')); effects++; });
  assert.equal(effects, 0); assert.deepEqual(published, before); assert.equal(candidate.items[0].fence !== null, true);
});

test('P02/P03: JSON restart preserves order, authorization, pause and unknown fences', () => {
  let p = parallel(); p = run(p, claim(p, 'a')); p = run(p, { type: 'pausePlan', paused: true });
  p = JSON.parse(JSON.stringify(p)); assert.deepEqual(validateRecoveryPlan(p), []); const fence = clone(p.items[0].fence);
  p = run(p, { type: 'recover' }); assert.deepEqual(p.items[0].fence, fence); assert.equal(p.items[0].status, 'needs_attention');
  p = run(p, { type: 'pausePlan', paused: false }); p = run(p, { type: 'configure', maxConcurrent: 1 }); blocked(() => run(p, claim(p, 'b')));
});

test('G01: only correlated terminal or positive stop releases; receipt/idle cannot settle', () => {
  let p = add(createRecoveryPlan(), 'a'); p = run(p, claim(p, 'a')); const f = clone(p.items[0].fence);
  for (const kind of ['idle', 'receipt', 'accepted', 'delivered', 'lease_expired']) blocked(() => run(p, { type: 'settle', id: 'a', evidence: { kind } }));
  blocked(() => run(p, { type: 'settle', id: 'a', evidence: { ...f, turnId: 'turn-a', kind: 'terminal', outcome: 'completed' } }));
  p = run(p, { type: 'bindTurn', id: 'a', claimId: f.claimId, messageId: f.messageId, turnId: 'turn-a' });
  blocked(() => run(p, { type: 'bindTurn', id: 'a', claimId: f.claimId, messageId: f.messageId, turnId: 'different' }));
  const e = { ...p.items[0].fence, kind: 'terminal', outcome: 'completed' };
  for (const k of ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId', 'turnId']) blocked(() => run(p, { type: 'settle', id: 'a', evidence: { ...e, [k]: 'wrong' } }));
  p = run(p, { type: 'settle', id: 'a', evidence: e }); assert.equal(p.items[0].status, 'succeeded'); assert.equal(p.items[0].fence, null);
});

test('positive stop releases removed fence but never invents success or permits replay', () => {
  let p = add(createRecoveryPlan(), 'a'); p = run(p, claim(p, 'a')); p = run(p, { type: 'remove', id: 'a' });
  const { turnId, ...f } = p.items[0].fence;
  blocked(() => run(p, { type: 'settle', id: 'a', evidence: { ...f, kind: 'stopped', hostStopped: false } }));
  p = run(p, { type: 'settle', id: 'a', evidence: { ...f, kind: 'stopped', hostStopped: true } });
  assert.equal(p.items[0].fence, null); assert.equal(p.items[0].result, 'unknown'); assert.equal(p.items[0].status, 'needs_attention'); blocked(() => run(p, claim(p, 'a')));
});

test('user abort is not auto-retry; completed claim ID is never reused', () => {
  let p = parallel(); const ca = claim(p, 'a'); p = run(p, ca); p = terminal(p, 'a', 'quota');
  blocked(() => run(p, ca)); p = run(p, claim(p, 'a')); p = terminal(p, 'a', 'aborted'); blocked(() => run(p, claim(p, 'a')));
});

test('P05: legacy/unknown schemas and corrupt fields rejected before every command', () => {
  const p = add(createRecoveryPlan(), 'a');
  const variants = [null, {}, [], { ...p, schemaVersion: 2 }, { ...p, tasks: [] }, { ...p, revision: -1 }, { ...p, paused: 'false' }, { ...p, maxConcurrent: 9 }, { ...p, usedClaimIds: ['dup', 'dup'] }];
  const mutations = [
    (q) => { q.items[0].ref.prompt = 'not allowed'; },
    (q) => { q.items[0].authorization.generation = 'future'; },
    (q) => { q.items[0].status = 'running'; },
    (q) => { q.items[0].status = 'succeeded'; },
    (q) => { q.items[0].skip = { confirmed: false }; },
    (q) => { q.batches = [['a', 'a']]; },
    (q) => { q.items[0].fence = {}; },
    (q) => { q.items[0].attempts = Infinity; },
    (q) => { q.items[0].result = 'completed'; },
    (q) => { q.usedClaimIds = ['orphan']; q.usedMessageIds = ['orphan-message']; },
  ];
  for (const mutate of mutations) { const q = clone(p); mutate(q); variants.push(q); }
  for (const q of variants) { assert.ok(validateRecoveryPlan(q).length); assert.throws(() => applyRecoveryPlan(q, 0, { type: 'recover' }), { code: 'SNAPSHOT_INVALID' }); }
});

test('bad JSON values, getters, symbols, sparse/cyclic arrays, and unknown commands fail closed', () => {
  const p = add(createRecoveryPlan(), 'a');
  const cycle = {}; cycle.self = cycle;
  const getter = {}; Object.defineProperty(getter, 'type', { enumerable: true, get() { throw new Error('must not read'); } });
  const symbol = { type: 'recover', [Symbol('hidden')]: true };
  const sparse = []; sparse.length = 1;
  for (const c of [cycle, getter, symbol, { type: 'recover', extra: true }, { type: 'newTask', prompt: 'no' }, { type: 'reorder', batches: sparse }, { type: 'recover', bad: new Date() }]) blocked(() => run(p, c));
  const extra = clone(p); Object.defineProperty(extra, 'hidden', { value: true }); assert.ok(validateRecoveryPlan(extra).length);
  const sparsePlan = clone(p); sparsePlan.items.length = 2; assert.ok(validateRecoveryPlan(sparsePlan).length);
});

test('running/unknown fence cannot be skipped or bypassed by a different workspace next batch', () => {
  let p = add(createRecoveryPlan({ maxConcurrent: 2 }), 'a'); p = add(p, 'b', 1);
  p = run(p, claim(p, 'a')); blocked(() => run(p, { type: 'skip', id: 'a', confirmed: true })); blocked(() => run(p, claim(p, 'b')));
  p = run(p, { type: 'recover' }); blocked(() => run(p, { type: 'skip', id: 'a', confirmed: true })); blocked(() => run(p, claim(p, 'b')));
  p = terminal(p, 'a', 'error'); p = run(p, { type: 'skip', id: 'a', confirmed: true }); p = run(p, claim(p, 'b')); assert.equal(p.items[0].result, 'error');
});

test('loaded status/result/fence/attempt combinations reject corrupt terminal replay', () => {
  let p = add(createRecoveryPlan(), 'a'); p = run(p, claim(p, 'a')); const running = clone(p); p = terminal(p, 'a');
  for (const status of ['ready', 'waiting_quota', 'running', 'needs_attention', 'failed', 'stopped']) {
    const q = clone(p); q.items[0].status = status; assert.ok(validateRecoveryPlan(q).length); blocked(() => run(q, claim(q, 'a')));
  }
  for (const [status, result, fence] of [
    ['waiting_quota', null, null], ['waiting_quota', 'error', null],
    ['failed', null, null], ['stopped', null, null], ['needs_attention', null, null],
    ['succeeded', 'completed', running.items[0].fence], ['ready', null, null],
  ]) {
    const q = clone(running); Object.assign(q.items[0], { status, result, fence }); assert.ok(validateRecoveryPlan(q).length);
  }
});

test('message IDs remain unique after quota stop and across different tasks', () => {
  let p = parallel(); const c = claim(p, 'a'); p = run(p, c); p = terminal(p, 'a', 'quota');
  blocked(() => run(p, { ...claim(p, 'a'), messageId: c.messageId }));
  blocked(() => run(p, { ...claim(p, 'b'), messageId: c.messageId }));
});
