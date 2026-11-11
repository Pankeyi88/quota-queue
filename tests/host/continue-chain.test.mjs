import test from 'node:test';
import assert from 'node:assert/strict';
import { taskIdentityFromInspection } from '../../host/task-identity.js';
import { correlateContinueInspection } from '../../host/continue-evidence.js';
import { correlateContinueChain } from '../../host/continue-chain.js';

function fixture() {
  const inspection = { meta: { id: 's', version: 4, isSeeded: false, cwd: 'E:/work' }, inheritedEventCount: 0, events: [] };
  const push = (type, data) => inspection.events.push({ seq: inspection.events.length, type, data });
  push('turn/start', { turn: 1 });
  push('step/start', { turn: 1, step: 1 });
  push('user/message', { id: 'root', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'private task' }] });
  push('request/header', { header: { config: { provider: 'p', model: 'm', apiKey: 'secret' } } });
  push('step/end', { turn: 1, step: 1 });
  push('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', message: 'private' } } });
  const identity = taskIdentityFromInspection('s', inspection);
  const attempts = [];
  for (const [turn, requestId, messageId, code] of [[2, 'r1', 'm1', 'TIMEOUT'], [3, 'r2', 'm2', 'QUOTA']]) {
    push('turn/start', { turn });
    push('step/start', { turn, step: 1 });
    push('user/message', { id: messageId, role: 'user', source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text: '继续' }] });
    push('step/end', { turn, step: 1 });
    push('turn/end', { turn, reason: { kind: 'error', error: { code, message: 'private' } } });
    attempts.push({ requestId, messageId, turn, endSeq: inspection.events.length - 1 });
  }
  return { sessionId: 's', rootMessageId: 'root', generation: identity.generation,
    originalEndSeq: 5, failureTurn: 1, attempts, inspection };
}
function renumber(i) { i.inspection.events.forEach((e, n) => { e.seq = n; }); }
function rejected(i) { assert.equal(correlateContinueChain(i).verified, false); }

test('two distinct successive failures retain the original verified root', () => {
  const i = fixture();
  // Existing single-attempt adapter treats the first continuation as the root.
  const old = correlateContinueInspection({ ...i, requestId: 'r2', originalEndSeq: 10, failureTurn: 2 });
  assert.equal(old.reason, 'original_identity_changed');
  const result = correlateContinueChain(i);
  assert.deepEqual(result, { verified: true, sessionId: 's', rootMessageId: 'root', generation: i.generation,
    originalEndSeq: 5, originalFailureTurn: 1, latestFailureTurn: 3, latestFailureEndSeq: 15,
    latestRequestId: 'r2', latestMessageId: 'm2', attemptCount: 2, observedThroughSeq: 15,
    authorizationRequired: true, completenessRequiresIndependentVerification: true });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  for (const key of ['authorized', 'ownershipConfirmed', 'externalEffects', 'eligible']) assert.equal(Object.hasOwn(result, key), false);
});

test('anchor and inspection must match persisted original evidence', () => {
  const changes = [
    i => { i.sessionId = 'other'; }, i => { i.rootMessageId = 'other'; },
    i => { i.generation = 'other'; }, i => { i.originalEndSeq = 2; },
    i => { i.failureTurn = 2; }, i => { i.inspection.meta.isSeeded = true; },
    i => { i.inspection.inheritedEventCount = 1; }, i => { i.inspection.events[5].data.reason.kind = 'completed'; },
    i => { i.inspection.events[3].seq = 99; }, i => { i.inspection.events[5].data.turn = 2; },
  ];
  for (const change of changes) { const i = fixture(); change(i); rejected(i); }
});

test('unrecorded human races, steer and Goal messages always invalidate the chain', () => {
  for (const source of [{ kind: 'user', rpcId: 'other' }, { kind: 'goal' }, { kind: 'context' }]) {
    for (const position of [8, 9, 13, 14]) {
      const i = fixture();
      i.inspection.events.splice(position, 0, { seq: 0, type: 'user/message', data: { id: 'intruder', role: 'user', source, content: [{ type: 'text', text: '继续' }] } });
      renumber(i); for (const a of i.attempts) if (a.endSeq >= position) a.endSeq++;
      rejected(i);
    }
  }
  const before = fixture();
  before.inspection.events.splice(6, 0, { seq: 0, type: 'turn/start', data: { turn: 99 } });
  renumber(before); before.attempts.forEach(a => a.endSeq++); rejected(before);
  const after = fixture();
  after.inspection.events.push({ seq: 16, type: 'turn/start', data: { turn: 4 } }); rejected(after);
});

test('rpcId, message ID, exact content, first step and turn must match records', () => {
  const changes = [
    i => { i.inspection.events[8].data.source.rpcId = 'wrong'; },
    i => { i.inspection.events[8].data.id = 'wrong'; },
    i => { i.inspection.events[8].data.content[0].text = '继续 '; },
    i => { i.inspection.events[8].data.content.push({ type: 'text', text: '' }); },
    i => { i.inspection.events[8].data.role = 'assistant'; },
    i => { i.attempts[0].turn = 4; }, i => { i.inspection.events[6].data.turn = 4; },
    i => { i.inspection.events[7].data.step = 2; },
    i => { [i.inspection.events[7], i.inspection.events[8]] = [i.inspection.events[8], i.inspection.events[7]]; renumber(i); },
  ];
  for (const change of changes) { const i = fixture(); change(i); rejected(i); }
});

test('absent, incomplete, reordered or duplicate attempt records are rejected', () => {
  const changes = [
    i => { i.attempts = []; }, i => { i.attempts.pop(); }, i => { i.attempts.shift(); },
    i => { i.attempts.push({ ...i.attempts[1] }); }, i => { i.attempts.reverse(); },
    i => { i.attempts[1].requestId = i.attempts[0].requestId; },
    i => { i.attempts[1].messageId = i.attempts[0].messageId; },
    i => { i.attempts[0].messageId = 'root'; },
    i => { delete i.attempts[0].endSeq; }, i => { i.attempts[0].endSeq++; },
    i => { i.inspection.events.splice(8, 1); renumber(i); i.attempts.forEach(a => a.endSeq--); },
  ];
  for (const change of changes) { const i = fixture(); change(i); rejected(i); }
});

test('truncated inspections, malformed steps and incorrect terminal states fail closed', () => {
  const changes = [
    i => { i.inspection.events.length = 15; }, i => { i.inspection.events.length = 5; },
    i => { i.inspection.events[10].data.reason.kind = 'completed'; },
    i => { i.inspection.events[15].data.reason.kind = 'aborted'; },
    i => { i.inspection.events[15].data.reason.kind = 'unknown'; },
    i => { i.inspection.events[15].data.turn = 2; },
    i => { i.inspection.events[9].data.step = 2; },
    i => { i.inspection.events[9].type = 'other'; },
  ];
  for (const change of changes) { const i = fixture(); change(i); rejected(i); }
});

test('original anchor rejects open steps and competing Goal or steering messages', () => {
  for (const event of [
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: { id: 'g', role: 'user', source: { kind: 'goal' } } },
    { type: 'user/message', data: { id: 'steer', role: 'user', source: { kind: 'user' } } },
  ]) {
    const i = fixture(); i.inspection.events.splice(5, 0, { seq: 0, ...event }); renumber(i);
    i.originalEndSeq++; i.attempts.forEach(a => a.endSeq++); rejected(i);
  }
});

test('root body is not accessed, inputs are unchanged and thrown getters are hidden', () => {
  const i = fixture();
  Object.defineProperty(i.inspection.events[3].data, 'content', { get() { throw new Error('root secret'); } });
  assert.equal(correlateContinueChain(i).verified, true);
  const j = fixture(); const before = JSON.stringify(j);
  correlateContinueChain(j); assert.equal(JSON.stringify(j), before);
  Object.defineProperty(j.inspection.events[8].data, 'content', { get() { throw new Error('secret'); } });
  assert.deepEqual(correlateContinueChain(j), { verified: false, reason: 'inspection_invalid' });
});
test('host runtime-context snapshots are not human or Goal continuations', () => {
  const i = fixture();
  i.inspection.events.splice(9, 0, { seq:0, type:'user/message', data:{ id:'runtime', role:'user', source:{ kind:'runtime-context' }, content:[{ type:'text', text:'current context' }] } });
  renumber(i); i.attempts.forEach(a => { if (a.endSeq >= 9) a.endSeq++; });
  assert.equal(correlateContinueChain(i).verified, true);
});
test('rejects skipped steps and unmatched original step endings', () => {
  const i = fixture();
  i.inspection.events.splice(10, 0,
    { seq:0, type:'step/start', data:{ turn:2, step:3 } },
    { seq:0, type:'step/end', data:{ turn:2, step:3 } });
  renumber(i); i.attempts.forEach(a => { if (a.endSeq >= 10) a.endSeq += 2; });
  rejected(i);
  const j = fixture();
  j.inspection.events.splice(5, 0, { seq:0, type:'step/end', data:{ turn:1, step:null } });
  renumber(j); j.originalEndSeq++; j.attempts.forEach(a => a.endSeq++); rejected(j);
});

test('original human root must occur inside the first open step', () => {
  const missing = fixture();
  missing.inspection.events.splice(4, 1);
  missing.inspection.events.splice(1, 1);
  renumber(missing); missing.originalEndSeq -= 2;
  missing.attempts.forEach(a => { a.endSeq -= 2; });
  missing.generation = taskIdentityFromInspection('s', { ...missing.inspection, events: missing.inspection.events.slice(0, missing.originalEndSeq + 1) }).generation;
  assert.equal(correlateContinueChain(missing).reason, 'original_message_conflict');

  const after = fixture();
  const [root] = after.inspection.events.splice(2, 1);
  after.inspection.events.splice(4, 0, root);
  renumber(after);
  after.generation = taskIdentityFromInspection('s', { ...after.inspection, events: after.inspection.events.slice(0, after.originalEndSeq + 1) }).generation;
  assert.equal(correlateContinueChain(after).reason, 'original_message_conflict');

  const second = fixture();
  const [steer] = second.inspection.events.splice(2, 1);
  second.inspection.events.splice(4, 0,
    { seq: 0, type: 'step/start', data: { turn: 1, step: 2 } },
    steer,
    { seq: 0, type: 'step/end', data: { turn: 1, step: 2 } });
  renumber(second); second.originalEndSeq += 2; second.attempts.forEach(a => { a.endSeq += 2; });
  second.generation = taskIdentityFromInspection('s', { ...second.inspection, events: second.inspection.events.slice(0, second.originalEndSeq + 1) }).generation;
  assert.equal(correlateContinueChain(second).reason, 'original_message_conflict');
});

test('runtime-context in the original first step does not compete with the human root', () => {
  const i = fixture();
  i.inspection.events.splice(2, 0, { seq: 0, type: 'user/message', data: { id: 'runtime-root', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] } });
  renumber(i); i.originalEndSeq++; i.attempts.forEach(a => { a.endSeq++; });
  i.generation = taskIdentityFromInspection('s', { ...i.inspection, events: i.inspection.events.slice(0, i.originalEndSeq + 1) }).generation;
  assert.equal(correlateContinueChain(i).verified, true);
});
