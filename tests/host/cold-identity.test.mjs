import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectContinueFailure } from '../../host/continue-failure.js';
import { createColdIdentity } from '../../host/cold-identity.js';
function evidence() {
  const inspection = { meta: { id:'s', version:4, isSeeded:false, cwd:'E:/w' }, inheritedEventCount:0, events: [
    { seq:0, type:'turn/start', data:{ turn:7 } },
    { seq:1, type:'user/message', data:{ id:'root', role:'user', source:{ kind:'user' } } },
    { seq:2, type:'request/header', data:{ header:{ config:{ provider:'p', model:'m' } } } },
    { seq:3, type:'turn/end', data:{ turn:7, reason:{ kind:'error', error:{ code:'TRANSPORT', status:503 } } } },
  ] };
  return inspectContinueFailure('s', inspection);
}
test('maps an inspected numeric turn to canonical core identity', () => {
  const failure = evidence(); assert.equal(failure.eligible, true);
  const value = createColdIdentity({ failure, workspaceId:'w', requestId:'r' });
  assert.equal(value.failedTurnId, '7'); assert.equal(value.taskId, 'root');
  assert.equal(value.generation, failure.generation); assert.equal(Object.isFrozen(value), true);
});
test('invalid identities and unauthoritative failure shapes are rejected', () => {
  const f = evidence();
  for (const bad of [{ ...f, eligible:false }, { ...f, turn:-1 }, { ...f, turn:1.5 }, { ...f, generation:'fake' }, { ...f, sessionId:'x'.repeat(257) }]) {
    assert.throws(() => createColdIdentity({ failure:bad, workspaceId:'w', requestId:'r' }), /invalid recovery identity/);
  }
  for (const requestId of ['', ' bad', 'x'.repeat(257), 'x\x7f']) assert.throws(() => createColdIdentity({ failure:f, workspaceId:'w', requestId }), /invalid recovery identity/);
});
