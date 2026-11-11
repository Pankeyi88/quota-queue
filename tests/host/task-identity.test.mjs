import assert from 'node:assert/strict';
import test from 'node:test';
import { taskIdentityFromInspection, inspectSelectedTask } from '../../host/task-identity.js';

function inspection() {
  return { meta: { id: 's1', version: 4, isSeeded: false, cwd: 'E:/one' }, inheritedEventCount: 0,
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { id: 'root-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'private task body' }] } },
      { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 3, type: 'request/header', data: { header: { config: { provider: 'provider', model: 'model', apiKey: 'must-not-leak' } }, reason: 'initial' } },
      { seq: 4, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'must-not-leak' } } } },
    ] };
}

test('extracts stable original-human scope without exposing prompt, headers or raw errors', () => {
  const input = inspection();
  // Message text is not needed and is never read by this metadata adapter.
  Object.defineProperty(input.events[1].data, 'content', { get() { throw new Error('body accessed'); } });
  const result = taskIdentityFromInspection('s1', input);
  assert.equal(result.verified, true);
  assert.equal(result.taskId, 'root-1');
  assert.equal(result.turn, 1);
  assert.equal(result.turnEnded, true);
  assert.equal(result.turnEndKind, 'error');
  assert.equal(result.provider, 'provider');
  assert.equal(result.model, 'model');
  assert.equal(result.generation.length, 64);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('private task'), false);
  assert.equal(result.generation, taskIdentityFromInspection('s1', input).generation);
  // Verification establishes identity only, never an execution capability.
  assert.equal(Object.hasOwn(result, 'exclusiveOwnership'), false);
});

test('the latest human-rooted turn keeps its root across synthetic continuations and steering', () => {
  const input = inspection();
  const first = taskIdentityFromInspection('s1', input);
  // A synthetic-only turn (no human message yet) does not erase the human task.
  input.events.push({ seq: 6, type: 'turn/start', data: { turn: 2 } });
  const syntheticOpen = taskIdentityFromInspection('s1', input);
  assert.equal(syntheticOpen.verified, true);
  assert.equal(syntheticOpen.taskId, 'root-1');
  assert.equal(syntheticOpen.turn, 1);
  // Once that turn carries a human prompt, it becomes the new task scope and
  // inherits the last observed route until a new header is logged.
  input.events.push({ seq: 7, type: 'user/message', data: { id: 'root-2', role: 'user', source: { kind: 'user' } } });
  const inherited = taskIdentityFromInspection('s1', input);
  assert.equal(inherited.verified, true);
  assert.equal(inherited.turn, 2);
  assert.equal(inherited.provider, 'provider');
  assert.notEqual(inherited.generation, first.generation);
  input.events.push({ seq: 8, type: 'step/start', data: { turn: 2, step: 1 } });
  input.events.push({ seq: 9, type: 'request/header', data: { header: { config: { provider: 'new-provider', model: 'new-model' } }, reason: 'series' } });
  const second = taskIdentityFromInspection('s1', input);
  assert.equal(second.verified, true);
  assert.notEqual(second.generation, first.generation);
  assert.equal(second.provider, 'new-provider');
  assert.equal(second.turnEnded, false);
  // A steering message in the SAME turn shares the first root; it must not
  // become a second task or invalidate the scope.
  input.events.push({ seq: 10, type: 'user/message', data: { id: 'steer', role: 'user', source: { kind: 'user' } } });
  const steered = taskIdentityFromInspection('s1', input);
  assert.equal(steered.verified, true);
  assert.equal(steered.taskId, 'root-2');
  assert.equal(steered.generation, second.generation);
  // If the only human evidence in the later turn is synthetic, the previous
  // human root remains the task scope.
  input.events[7].data.source = { kind: 'goal' };
  input.events[10].data.source = { kind: 'context' };
  const fallback = taskIdentityFromInspection('s1', input);
  assert.equal(fallback.verified, true);
  assert.equal(fallback.taskId, 'root-1');
});

test('the newest turn boundary is reported separately from the human root boundary', () => {
  const input = inspection();
  input.events[5].data.reason = { kind: 'completed' };
  const rootOnly = taskIdentityFromInspection('s1', input);
  assert.equal(rootOnly.turnEnded, true);
  assert.equal(rootOnly.turnEndKind, 'completed');
  assert.equal(rootOnly.lastTurn, 1);
  assert.equal(rootOnly.lastTurnEnded, true);
  assert.equal(rootOnly.lastTurnEndKind, 'completed');

  // Goal rounds and continuation deliveries append synthetic-only turns; the
  // session's real state is the NEWEST turn, not the prompt's turn.
  input.events.push(
    { seq: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 8, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { code: 'QUOTA', message: 'must-not-leak' } } } },
  );
  const failed = taskIdentityFromInspection('s1', input);
  assert.equal(failed.verified, true);
  // The authorization scope still points at the human root and its turn...
  assert.equal(failed.taskId, 'root-1');
  assert.equal(failed.turn, 1);
  assert.equal(failed.turnEnded, true);
  assert.equal(failed.turnEndKind, 'completed');
  assert.equal(failed.generation, rootOnly.generation);
  // ...while the session boundary moved to the newest, failed turn.
  assert.equal(failed.lastTurn, 2);
  assert.equal(failed.lastTurnEnded, true);
  assert.equal(failed.lastTurnEndKind, 'error');
  assert.equal(JSON.stringify(failed).includes('must-not-leak'), false);

  // A newest turn that has not ended is not "ended" either.
  input.events.push({ seq: 10, type: 'turn/start', data: { turn: 3 } });
  const open = taskIdentityFromInspection('s1', input);
  assert.equal(open.lastTurn, 3);
  assert.equal(open.lastTurnEnded, false);
  assert.equal(open.lastTurnEndKind, null);
  assert.equal(open.generation, rootOnly.generation);
});

test('fork subagent wrong session partial and malformed boundaries fail closed', () => {
  const cases = [
    (s) => { s.meta.id = 'other'; }, (s) => { s.meta.isSeeded = true; },
    (s) => { s.meta.parentSession = 'parent'; }, (s) => { s.meta.origin = 'subagent'; },
    (s) => { s.inheritedEventCount = 1; }, (s) => { delete s.meta.isSeeded; },
    (s) => { s.events[1].seq = 50; }, (s) => { s.events[5].data.turn = 2; },
    (s) => { s.events[0].type = 'other'; },
    (s) => { s.events[1].data.source.kind = 'goal'; },
    (s) => { delete s.events[3].data.header.config.provider; },
    (s) => { s.events[1].data.role = 'assistant'; },
  ];
  for (const change of cases) {
    const input = inspection(); change(input);
    assert.equal(taskIdentityFromInspection('s1', input).verified, false);
  }
});

test('a missing turn header inherits the last valid route, while a malformed one clears it', () => {
  const beforeTurn = inspection();
  const header = beforeTurn.events[3];
  beforeTurn.events.unshift({ ...header, data: { header: { config: { provider: 'stale', model: 'stale' } } } });
  beforeTurn.events.forEach((event, seq) => { event.seq = seq; });
  const afterEarly = taskIdentityFromInspection('s1', beforeTurn);
  assert.equal(afterEarly.verified, true);
  assert.equal(afterEarly.provider, 'provider');

  const beforeRoot = inspection();
  [beforeRoot.events[1], beforeRoot.events[3]] = [beforeRoot.events[3], beforeRoot.events[1]];
  beforeRoot.events.forEach((event, seq) => { event.seq = seq; });
  const preRootHeader = taskIdentityFromInspection('s1', beforeRoot);
  assert.equal(preRootHeader.verified, true);
  assert.equal(preRootHeader.provider, 'provider');

  const malformed = inspection();
  delete malformed.events[3].data.header.config.provider;
  assert.equal(taskIdentityFromInspection('s1', malformed).reason, 'task_route_unknown');

  const laterHeader = inspection();
  const root = laterHeader.events[1];
  const stale = { ...laterHeader.events[3], data: { header: { config: { provider: 'stale', model: 'stale' } } } };
  const valid = { ...laterHeader.events[3], data: { header: { config: { provider: 'later', model: 'later' } } } };
  laterHeader.events = [
    laterHeader.events[0], stale, laterHeader.events[2], root, valid, laterHeader.events[4], laterHeader.events[5],
  ];
  laterHeader.events.forEach((event, seq) => { event.seq = seq; });
  const recovered = taskIdentityFromInspection('s1', laterHeader);
  assert.equal(recovered.verified, true);
  assert.equal(recovered.provider, 'later');
});

test('a missing log-read capability is distinct from an unrecoverable task', async () => {
  const missing = await inspectSelectedTask(() => undefined, 's1');
  assert.deepEqual(missing, { verified: false, reason: 'task_inspection_unavailable', capabilityUnavailable: true });
  const offline = await inspectSelectedTask(() => ({
    inspect: async () => { const error = new Error('private'); error.code = 'session_inspection_unavailable'; throw error; },
  }), 's1');
  assert.deepEqual(offline, { verified: false, reason: 'task_inspection_unavailable', capabilityUnavailable: true });
  const failed = await inspectSelectedTask(() => ({ inspect: async () => { throw new Error('private'); } }), 's1');
  assert.deepEqual(failed, { verified: false, reason: 'task_inspection_failed' });
  const invalid = await inspectSelectedTask(() => ({ inspect: async () => ({ meta: null }) }), 's1');
  assert.equal(invalid.verified, false);
  assert.equal(invalid.capabilityUnavailable, undefined);
});

test('method getter exceptions are mapped to a fixed safe inspection failure', async () => {
  const result = await inspectSelectedTask(() => ({ get inspect() { throw new Error('private-token'); } }), 's1');
  assert.deepEqual(result, { verified: false, reason: 'task_inspection_failed' });
});

test('selected inspection is read-only, explicit, abort-aware and hides thrown errors', async () => {
  const seen = [];
  const controller = {
    inspect: async (sessionId, signal) => { seen.push({ sessionId, signal }); return inspection(); },
    create() { throw new Error('must not activate'); },
    resolveAgent() { throw new Error('must not activate'); },
  };
  const signal = new AbortController().signal;
  assert.equal((await inspectSelectedTask(() => controller, 's1', signal)).verified, true);
  assert.deepEqual(seen, [{ sessionId: 's1', signal }]);
  const abort = new AbortController(); abort.abort();
  assert.equal((await inspectSelectedTask(() => controller, 's1', abort.signal)).reason, 'cancelled');
  assert.equal(seen.length, 1);
  const failed = await inspectSelectedTask(() => ({ inspect: async () => { throw new Error('private'); } }), 's1');
  assert.deepEqual(failed, { verified: false, reason: 'task_inspection_failed' });
  assert.equal((await inspectSelectedTask(() => undefined, 's1')).reason, 'task_inspection_unavailable');
});
