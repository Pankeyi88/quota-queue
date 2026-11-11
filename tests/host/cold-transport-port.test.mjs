import test from 'node:test';
import assert from 'node:assert/strict';
import { ColdRecovery } from '../../core/cold-recovery.mjs';
import { createContinueTransport } from '../../host/continue-transport.js';
import { createColdTransportPort } from '../../host/cold-transport-port.js';
import { createColdIdentity } from '../../host/cold-identity.js';
import { inspectContinueFailure } from '../../host/continue-failure.js';
import { correlateContinueInspection } from '../../host/continue-evidence.js';
const id = { sessionId: 's', taskId: 'task', generation: 'gen', workspaceId: 'w', rootMessageId: 'root', failedTurnId: '1', requestId: 'request' };

test('core persists its claim before the real transport calls prompt', async () => {
  let persisted = null, calls = 0;
  const signal = new AbortController().signal;
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async (request, passedSignal) => {
    calls++; assert.equal(persisted.entries[0].fenced, true); assert.equal(persisted.entries[0].status, 'claimed');
    assert.equal(passedSignal, signal); assert.equal(request.requestId, id.requestId);
    assert.deepEqual(request.content, [{ type: 'text', text: '继续' }]); return { accepted: true };
  } }) });
  const core = new ColdRecovery({ load: async () => persisted, save: async (next) => { persisted = structuredClone(next); }, send: createColdTransportPort({ transport, signal }) });
  await core.open();
  assert.deepEqual(await core.dispatch(id), { kind: 'accepted' });
  assert.equal(calls, 1); assert.equal(persisted.entries[0].status, 'accepted'); assert.equal(persisted.entries[0].fenced, true);
  await assert.rejects(core.dispatch(id), /duplicate_or_fenced/); assert.equal(calls, 1);
});

test('uncertain or mismatched transport receipt never becomes accepted', async () => {
  for (const result of [{ status: 'unknown', requestId: 'request' }, { status: 'accepted', requestId: 'other' }, { status: 'accepted' }, null]) {
    const send = createColdTransportPort({ transport: { send: async () => result }, signal: new AbortController().signal });
    assert.deepEqual(await send(id), { status: 'unknown' });
  }
  const send = createColdTransportPort({ transport: { send: async () => { throw new Error('private'); } }, signal: new AbortController().signal });
  assert.deepEqual(await send(id), { status: 'unknown' });
});

test('aborted signal is never interpreted as a delivered message', async () => {
  let calls = 0;
  const abort = new AbortController(); abort.abort();
  const transport = createContinueTransport({ resolveController: () => ({ prompt: () => { calls++; return { accepted: true }; } }) });
  const send = createColdTransportPort({ transport, signal: abort.signal });
  assert.deepEqual(await send(id), { status: 'unknown' });
  assert.equal(calls, 0);
});
test('stubbed cross-component flow correlates failure, durable claim and turn settlement', async () => {
  const inspection = { meta:{ id:'s', version:4, isSeeded:false, cwd:'E:/w' }, inheritedEventCount:0, events:[
    { seq:0, type:'turn/start', data:{ turn:1 } },
    { seq:1, type:'user/message', data:{ id:'root', role:'user', source:{ kind:'user' } } },
    { seq:2, type:'request/header', data:{ header:{ config:{ provider:'p', model:'m' } } } },
    { seq:3, type:'turn/end', data:{ turn:1, reason:{ kind:'error', error:{ code:'TRANSPORT', status:503 } } } },
  ] };
  const failure = inspectContinueFailure('s', inspection);
  const intent = createColdIdentity({ failure, workspaceId:'w', requestId:'r1' });
  let persisted = null;
  const signal = new AbortController().signal;
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async (request) => {
    assert.equal(persisted.entries[0].fenced, true);
    inspection.events.push({ seq:4, type:'turn/start', data:{ turn:2 } });
    inspection.events.push({ seq:5, type:'step/start', data:{ turn:2, step:1 } });
    inspection.events.push({ seq:6, type:'user/message', data:{ id:'m2', role:'user', source:{ kind:'user', rpcId:request.requestId }, content:request.content } });
    inspection.events.push({ seq:7, type:'step/end', data:{ turn:2, step:1 } });
    inspection.events.push({ seq:8, type:'turn/end', data:{ turn:2, reason:{ kind:'completed' } } });
    return { accepted:true };
  } }) });
  const core = new ColdRecovery({ load: async () => persisted, save: async next => { persisted = structuredClone(next); }, send:createColdTransportPort({ transport, signal }) });
  await core.open(); assert.equal((await core.dispatch(intent)).kind, 'accepted');
  assert.equal(core.getSnapshot().entries[0].fenced, true);
  const correlated = correlateContinueInspection({ sessionId:'s', requestId:'r1', rootMessageId:failure.rootMessageId, generation:failure.generation, originalEndSeq:failure.originalEndSeq, failureTurn:failure.turn, inspection });
  assert.equal(correlated.status, 'completed');
  await core.bindObservation({ identity:intent, messageId:correlated.messageId, turnId:String(correlated.turn), proofId:'stub-observation' });
  await core.reconcile({ identity:intent, kind:'completed', messageId:correlated.messageId, turnId:String(correlated.turn), proofId:'stub-terminal' });
  assert.equal(core.getSnapshot().entries[0].fenced, false);
});
