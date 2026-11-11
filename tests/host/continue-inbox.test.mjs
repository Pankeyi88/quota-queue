import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateContinueInbox } from '../../host/continue-inbox.js';

const message = (id, kind = 'user', rpcId = undefined, content = '继续') => ({
  id, role: 'user', source: { kind, ...(rpcId === undefined ? {} : { rpcId }) },
  content: [{ type: 'text', text: content }],
});
function fixture() {
  return { sessionId: 's', requestId: 'r', afterSeq: 0, snapshotSeq: 0,
    inspection: { meta: { id: 's', version: 4, isSeeded: false }, inheritedEventCount: 0,
      events: [{ seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } }] } };
}
function splice(i, target, start, removedCount, inserted, outcome) {
  const data = { target, start, ...(removedCount === undefined ? {} : { removedCount }), inserted,
    ...(outcome === undefined ? {} : { outcome }) };
  const seq = i.inspection.events.length;
  i.inspection.events.push({ seq, type: 'agent/inbox/spliced', data }); i.snapshotSeq = seq;
}
function result(i) { return correlateContinueInbox(i); }

test('enqueue observes only matching request, never returns prompt contents', () => {
  const i = fixture(); splice(i, 'next-turn', 0, undefined, [message('m', 'user', 'r')]);
  assert.deepEqual(result(i), { status: 'observed', snapshotSeq: 1, messageId: 'm', enqueueSeq: 1,
    initialTarget: 'next-turn', initialPayloadMatches: true, seenInNextStep: false, modified: false,
    sourceChanged: false, discarded: false, removedWithoutOutcome: false, location: 'next-turn',
    currentPayloadMatches: true, competingUserPending: false, otherPending: false });
  assert.equal(JSON.stringify(result(i)).includes('继续'), false);
  const j = fixture(); splice(j, 'next-turn', 0, undefined, [message('m', 'user', 'r', 'private secret')]);
  assert.equal(result(j).initialPayloadMatches, false); assert.equal(result(j).currentPayloadMatches, false); assert.equal(JSON.stringify(result(j)).includes('secret'), false);
});
test('claim removal is observed without declaring delivery or cancellation', () => {
  const i = fixture(); splice(i, 'next-turn', 0, undefined, [message('m', 'user', 'r')]);
  splice(i, 'next-turn', 0, 1, []);
  const r = result(i); assert.equal(r.location, null); assert.equal(r.removedWithoutOutcome, true);
  assert.equal(r.discarded, false); assert.equal(r.status, 'observed');
});
test('steer uses discard then same message inserted next-step', () => {
  const i = fixture(), m = message('m', 'user', 'r');
  splice(i, 'next-turn', 0, undefined, [m]); splice(i, 'next-turn', 0, 1, [], 'canceled');
  assert.equal(result(i).discarded, true);
  splice(i, 'next-step', 0, undefined, [structuredClone(m)]);
  assert.deepEqual(result(i), { status: 'ambiguous', reason: 'message_id_reused', snapshotSeq: 3 });
  splice(i, 'next-step', 0, 1, []); assert.equal(result(i).status, 'ambiguous');
});
test('edit and cancellation remain distinguishable from claim', () => {
  const i = fixture(), m = message('m', 'user', 'r');
  splice(i, 'next-turn', 0, undefined, [m]);
  splice(i, 'next-turn', 0, 1, [message('m', 'user', 'r', 'sensitive')], 'canceled');
  assert.equal(result(i).modified, true); assert.equal(result(i).discarded, false);
  assert.equal(result(i).initialPayloadMatches, true); assert.equal(result(i).currentPayloadMatches, false);
  assert.equal(result(i).sourceChanged, false);
  assert.equal(JSON.stringify(result(i)).includes('sensitive'), false);
  splice(i, 'next-turn', 0, 1, [], 'canceled'); assert.equal(result(i).discarded, true);
  assert.equal(result(i).currentPayloadMatches, null);
});
test('existing queued users and other pending users compete, synthetic messages do not', () => {
  const i = fixture();
  // A pending user that predates the requested boundary must be reconstructed.
  i.inspection.events[0] = { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message('old', 'user', 'old')] } };
  splice(i, 'next-turn', 1, undefined, [message('m', 'user', 'r')]);
  splice(i, 'next-step', 0, undefined, [message('g', 'goal'), message('a', 'subagent'), message('ctx', 'runtime-context')]);
  assert.equal(result(i).competingUserPending, true);
  splice(i, 'next-turn', 0, 1, []); assert.equal(result(i).competingUserPending, false);
  assert.equal(result(i).otherPending, true);
  splice(i, 'next-step', 3, undefined, [message('other', 'user', 'else')]);
  assert.equal(result(i).competingUserPending, true);
  splice(i, 'next-step', 3, 1, [], 'canceled'); assert.equal(result(i).competingUserPending, false);
});
test('unobserved is not proof of no delivery; synthetic matching rpcId is ignored', () => {
  const i = fixture(); splice(i, 'next-step', 0, undefined, [message('g', 'goal', 'r')]);
  assert.deepEqual(result(i), { status: 'not_observed', snapshotSeq: 1, competingUserPending: false, otherPending: true });
});
test('reject malformed splices, duplicates and incomplete or out-of-scope histories', () => {
  const changes = [
    i => { i.inspection.events[0].seq = 1; },
    i => { i.snapshotSeq++; }, i => { i.afterSeq = 2; },
    i => { i.inspection.meta.id = 'other'; }, i => { i.inspection.inheritedEventCount = 1; },
    i => splice(i, 'next-turn', 1, undefined, [message('m')]),
    i => splice(i, 'bad', 0, undefined, [message('m')]),
    i => splice(i, 'next-turn', 0, 1, []),
    i => splice(i, 'next-turn', 0, undefined, [], 'canceled'),
    i => splice(i, 'next-turn', 0, undefined, [message('m'), message('m')]),
    i => { splice(i, 'next-turn', 0, undefined, [message('m')]); splice(i, 'next-step', 0, undefined, [message('m')]); },
    i => { splice(i, 'next-turn', 0, undefined, [message('m','user','r')]); splice(i, 'next-turn', 1, undefined, [message('n','user','r')]); },
    i => { i.inspection.events[0] = { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message('m','user','r')] } }; },
  ];
  for (const change of changes) { const i = fixture(); change(i); assert.equal(result(i).status, 'invalid'); }
});
test('unchanged replacement and source identity changes are distinguished', () => {
  const i = fixture(), m = message('m', 'user', 'r');
  splice(i, 'next-turn', 0, undefined, [m]);
  splice(i, 'next-turn', 0, 1, [structuredClone(m)], 'canceled');
  assert.equal(result(i).modified, false); assert.equal(result(i).sourceChanged, false);
  splice(i, 'next-turn', 0, 1, [message('m', 'user', 'different')], 'canceled');
  assert.equal(result(i).modified, true); assert.equal(result(i).sourceChanged, true);
  assert.equal(result(i).currentPayloadMatches, true);
  splice(i, 'next-turn', 0, 1, [m], 'canceled');
  assert.equal(result(i).modified, true); assert.equal(result(i).sourceChanged, true);
});
test('valid reuse after claim or nonadjacent steer folds but returns ambiguous', () => {
  for (const canceled of [false, true]) {
    const i = fixture(), m = message('m', 'user', 'r');
    splice(i, 'next-turn', 0, undefined, [m]);
    splice(i, 'next-turn', 0, 1, [], canceled ? 'canceled' : undefined);
    i.inspection.events.push({ seq: ++i.snapshotSeq, type: 'step/start', data: { turn: 1, step: 2 } });
    splice(i, 'next-step', 0, undefined, [structuredClone(m)]);
    assert.equal(result(i).status, 'ambiguous');
    // Even after ambiguity, a later impossible splice must fail closed.
    splice(i, 'next-step', 4, 1, []); assert.equal(result(i).status, 'invalid');
  }
});
test('unrelated historical reuse is ambiguous and current duplicate is invalid', () => {
  const i = fixture(); splice(i, 'next-turn', 0, undefined, [message('other')]);
  splice(i, 'next-turn', 0, 1, []); splice(i, 'next-step', 0, undefined, [message('other')]);
  splice(i, 'next-turn', 0, undefined, [message('m', 'user', 'r')]);
  assert.equal(result(i).status, 'ambiguous');
  splice(i, 'next-turn', 1, undefined, [message('other')]); assert.equal(result(i).status, 'invalid');
});
test('next-step first insertion and empty pending snapshots are explicit', () => {
  const i = fixture(); splice(i, 'next-step', 0, undefined, [message('m', 'user', 'r')]);
  assert.equal(result(i).seenInNextStep, true); assert.equal(result(i).location, 'next-step');
  assert.equal(result(i).otherPending, false); assert.equal(result(i).competingUserPending, false);
});

test('exceptions in inspection fail closed without leaking details', () => {
  const i = fixture(); Object.defineProperty(i.inspection.events[0], 'data', { get() { throw new Error('secret'); } });
  assert.deepEqual(result(i), { status: 'invalid', reason: 'inbox_history_invalid' });
});
