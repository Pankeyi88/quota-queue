import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContinueFailure } from '../../host/continue-failure.js';
function fixture(code, status) {
  return { meta: { id: 's', version: 4, isSeeded: false, cwd: 'E:/work' }, inheritedEventCount: 0, events: [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'root', role: 'user', source: { kind: 'user' } } },
    { seq: 2, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code, status, message: 'secret' } } } },
  ] };
}
test('classifies structured network, quota and rate-limit failures separately', () => {
  for (const [code, status, expected] of [['TIMEOUT', 504, 'transient'], ['QUOTA', 429, 'quota'], [undefined, 429, 'rate_limit']]) {
    const result = inspectContinueFailure('s', fixture(code, status));
    assert.equal(result.eligible, true); assert.equal(result.failureClass, expected);
    assert.equal(result.originalEndSeq, 3); assert.equal(result.observedThroughSeq, 3);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});
test('authentication, cancellation, request errors and contradictory quota never qualify', () => {
  for (const [code, status] of [['AUTH', 401], ['ABORTED', undefined], ['INVALID_ARGS', 400], ['QUOTA', 403], ['TIMEOUT', 401], ['TRANSPORT', 403], ['TIMEOUT', 400], [undefined, 402], [undefined, undefined]]) {
    assert.equal(inspectContinueFailure('s', fixture(code, status)).eligible, false);
  }
});
test('active, completed or later turns do not revive a stale failure', () => {
  const i = fixture('TIMEOUT', 504); i.events.pop();
  assert.equal(inspectContinueFailure('s', i).reason, 'turn_not_ended');
  const j = fixture('TIMEOUT', 504); j.events[3].data.reason = { kind: 'completed' };
  assert.equal(inspectContinueFailure('s', j).reason, 'not_failed_turn');
  const k = fixture('TIMEOUT', 504); k.events.push({ seq: 4, type: 'turn/start', data: { turn: 2 } });
  assert.equal(inspectContinueFailure('s', k).reason, 'task_not_latest_turn');
});
test('it establishes neither authorization nor runtime liveness', () => {
  const result = inspectContinueFailure('s', fixture('TRANSPORT', 503));
  assert.equal(result.eligible, true);
  for (const key of ['authorized', 'ownershipConfirmed', 'running', 'quotaAvailable']) assert.equal(Object.hasOwn(result, key), false);
});
test('untrusted getters and wrong session produce fixed errors', () => {
  const i = fixture('TIMEOUT', 504); Object.defineProperty(i.events[3].data.reason.error, 'code', { get() { throw new Error('secret'); } });
  assert.deepEqual(inspectContinueFailure('s', i), { eligible: false, reason: 'inspection_invalid' });
  assert.equal(inspectContinueFailure('other', fixture('TIMEOUT', 504)).eligible, false);
});
test('a Goal round requires separate proof linking it to the human task', () => {
  const i = fixture('TIMEOUT', 504);
  i.events[3].data.reason = { kind: 'completed' };
  i.events.push({ seq: 4, type: 'turn/start', data: { turn: 2 } });
  i.events.push({ seq: 5, type: 'user/message', data: { id: 'g', role: 'user', source: { kind: 'goal', goalId: 'g1', revision: 2, round: 1 } } });
  i.events.push({ seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'TRANSPORT', status: 503 } } } });
  const result = inspectContinueFailure('s', i);
  assert.deepEqual(result, { eligible: false, reason: 'goal_attribution_unverified' });
  i.events[5].data.source = { kind: 'context' };
  assert.equal(inspectContinueFailure('s', i).reason, 'synthetic_turn_unattributed');
  i.events[5].data.source = { kind: 'goal', goalId: 'g1', revision: 0, round: 1 };
  assert.equal(inspectContinueFailure('s', i).reason, 'goal_identity_invalid');
});
test('a goal turn that includes user steering is ambiguous', () => {
  const i = fixture('TIMEOUT', 504); i.events[3].data.reason = { kind: 'completed' };
  i.events.push({ seq: 4, type: 'turn/start', data: { turn: 2 } });
  i.events.push({ seq: 5, type: 'user/message', data: { id: 'g', role: 'user', source: { kind: 'goal', goalId: 'g1', revision: 2, round: 1 } } });
  i.events.push({ seq: 6, type: 'user/message', data: { id: 'human', role: 'user', source: { kind: 'user' } } });
  i.events.push({ seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'TIMEOUT' } } } });
  assert.equal(inspectContinueFailure('s', i).reason, 'goal_user_competition');
});
