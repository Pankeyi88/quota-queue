import test from 'node:test';
import assert from 'node:assert/strict';
import { taskIdentityFromInspection } from '../../host/task-identity.js';
import { correlateContinueInspection } from '../../host/continue-evidence.js';

function input() {
  const inspection = { meta: { id: 's', version: 4, isSeeded: false, cwd: 'E:/work' }, inheritedEventCount: 0, events: [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'root', role: 'user', source: { kind: 'user' } } },
    { seq: 2, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
  ] };
  const identity = taskIdentityFromInspection('s', inspection);
  return { sessionId: 's', requestId: 'r', rootMessageId: 'root', generation: identity.generation, originalEndSeq: 3, failureTurn: 1, inspection };
}
function append(i, type, data) { i.inspection.events.push({ seq: i.inspection.events.length, type, data }); }
function continuation(i, requestId = 'r') {
  append(i, 'turn/start', { turn: 2 });
  append(i, 'step/start', { turn: 2, step: 1 });
  append(i, 'user/message', { id: 'message', role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: '继续' }] });
}

test('absence is unknown rather than proof of non-delivery', () => {
  assert.deepEqual(correlateContinueInspection(input()), { status: 'not_observed' });
});
test('correlates only an exact request in the original session and its terminal turn', () => {
  const i = input(); continuation(i);
  assert.deepEqual(correlateContinueInspection(i), { status: 'observed', messageId: 'message', turn: 2, endKind: null });
  append(i, 'step/end', { turn: 2, step: 1 });
  append(i, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.deepEqual(correlateContinueInspection(i), { status: 'completed', messageId: 'message', turn: 2, endKind: 'completed' });
  i.inspection.events.at(-1).data.reason.kind = 'error';
  assert.equal(correlateContinueInspection(i).status, 'failed');
});
test('ordinary manual messages and duplicate request ids cause conflict', () => {
  const i = input(); continuation(i, 'another');
  assert.deepEqual(correlateContinueInspection(i), { status: 'conflict', reason: 'other_user_message' });
  const j = input(); continuation(j);
  append(j, 'user/message', { id: 'dup', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '继续' }] });
  assert.deepEqual(correlateContinueInspection(j), { status: 'conflict', reason: 'duplicate_request_message' });
});
test('synthetic turns do not establish delivery or conflict', () => {
  const i = input();
  append(i, 'turn/start', { turn: 2 });
  append(i, 'user/message', { id: 'notice', role: 'user', source: { kind: 'goal' } });
  append(i, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.deepEqual(correlateContinueInspection(i), { status: 'not_observed' });
});
test('changed roots, boundaries, sessions and incomplete logs cannot correlate', () => {
  const cases = [
    i => { i.generation = 'different'; }, i => { i.rootMessageId = 'another'; },
    i => { i.originalEndSeq = 2; }, i => { i.sessionId = 'another'; },
    i => { i.inspection.events[2].seq = 22; },
    i => { continuation(i); append(i, 'turn/end', { turn: 3, reason: { kind: 'completed' } }); },
    i => { continuation(i); append(i, 'turn/end', { turn: 2, reason: { kind: 'invented' } }); },
    i => { continuation(i); append(i, 'turn/end', { turn: 2, reason: { kind: 'completed' } }); append(i, 'turn/start', { turn: 2 }); },
  ];
  for (const change of cases) { const i = input(); change(i); assert.equal(correlateContinueInspection(i).status, 'invalid'); }
});
test('recovery payload must match exactly; original body and errors do not leak', () => {
  const i = input(); continuation(i);
  Object.defineProperty(i.inspection.events[1].data, 'content', { get() { throw new Error('secret'); } });
  append(i, 'step/end', { turn: 2, step: 1 });
  append(i, 'turn/end', { turn: 2, reason: { kind: 'error', message: 'secret' } });
  const result = correlateContinueInspection(i);
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  i.inspection.events[6].data.content[0].text = 'different';
  assert.deepEqual(correlateContinueInspection(i), { status: 'conflict', reason: 'request_payload_mismatch' });
});
test('correlates a continuation after an identified later Goal failure', () => {
  const i = input();
  i.inspection.events[3].data.reason = { kind: 'completed' };
  append(i, 'turn/start', { turn: 2 });
  append(i, 'user/message', { id: 'g', role: 'user', source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } });
  append(i, 'turn/end', { turn: 2, reason: { kind: 'error' } });
  i.originalEndSeq = 6; i.failureTurn = 2;
  append(i, 'turn/start', { turn: 3 });
  append(i, 'step/start', { turn: 3, step: 1 });
  append(i, 'user/message', { id: 'control', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '继续' }] });
  append(i, 'step/end', { turn: 3, step: 1 });
  append(i, 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  assert.deepEqual(correlateContinueInspection(i), { status: 'completed', messageId: 'control', turn: 3, endKind: 'completed' });
});
test('a continuation steered into a later step or batched with a Goal is a conflict', () => {
  const steered = input();
  append(steered, 'turn/start', { turn: 2 });
  append(steered, 'step/start', { turn: 2, step: 1 });
  append(steered, 'step/end', { turn: 2, step: 1 });
  append(steered, 'step/start', { turn: 2, step: 2 });
  append(steered, 'user/message', { id: 'm', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '继续' }] });
  assert.deepEqual(correlateContinueInspection(steered), { status: 'conflict', reason: 'continuation_not_first_step' });
  const shared = input();
  append(shared, 'turn/start', { turn: 2 });
  append(shared, 'step/start', { turn: 2, step: 1 });
  append(shared, 'user/message', { id: 'g', role: 'user', source: { kind: 'goal' } });
  append(shared, 'user/message', { id: 'm', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '继续' }] });
  assert.deepEqual(correlateContinueInspection(shared), { status: 'conflict', reason: 'goal_in_recovery_turn' });
});
