/** Driver behavior: durable tickets, claim-before-send, positive correlation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoContinueDriver, factsFromInspection } from '../../host/auto-continue.js';
import {
  continueRequestId, createTicket, decideError, decideTicket, markAttention, markCancelled, markClaimed, markDelivered,
} from '../../core/continue-ticket.mjs';
import { NOW, createClock, createFakeStore, inspectionFor, userMessage, errorEnd } from './continue-harness.mjs';

function createHarness(options = {}) {
  const clock = createClock();
  const store = options.store ?? createFakeStore();
  let inspection = options.inspection;
  const calls = { prompt: 0, resume: 0, inspect: 0 };
  const prompts = [];
  const resumes = [];
  const agent = options.agent === null ? null : { status: options.status ?? 'idle', inbox: options.inbox ?? { nextTurn: [], nextStep: [] } };
  const controller = {
    async inspect(sessionId) {
      calls.inspect += 1;
      if (options.inspectError === true || (typeof options.failInspect === 'function' && options.failInspect())) throw new Error('no');
      const chosen = (options.inspections && options.inspections[sessionId]) || inspection;
      return structuredClone(chosen);
    },
    async prompt(request) {
      calls.prompt += 1;
      prompts.push({ ...request, ticketState: store.ticket(request.sessionId)?.state ?? null });
      if (options.promptError !== undefined) throw options.promptError;
      return { accepted: options.accept !== false };
    },
  };
  const goals = {
    get() { return options.goal ?? null; },
    resume(_agent, ref) { calls.resume += 1; resumes.push(ref); if (options.resumeError === true) throw new Error('rejected'); return { revision: (ref.revision ?? 1) + 1 }; },
  };
  const owner = options.owner === undefined
    ? { owned: true, verify: () => true }
    : options.owner;
  const driver = createAutoContinueDriver({
    store,
    resolveController: () => controller,
    resolveInspection: () => controller,
    resolveAgents: () => ({ get: () => agent }),
    resolveGoals: () => goals,
    getOptIn: (sessionId) => (typeof options.getOptIn === 'function'
      ? options.getOptIn(sessionId)
      : options.optIn !== false),
    isPaused: () => options.paused === true,
    listOptIns: options.listOptIns,
    owner,
    clock,
    maxAttempts: 3,
    pollMs: 5_000,
    fenceGraceMs: 120_000,
    readQuota: options.readQuota,
    quotaGateRetryMs: options.quotaGateRetryMs,
    quotaCheckMs: options.quotaCheckMs,
  });
  return {
    clock, store, controller, driver, calls, prompts, resumes,
    setInspection(next) { inspection = next; },
    get inspection() { return inspection; },
  };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a durable TRANSPORT error becomes a ticket and one derived prompt', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.state, 'waiting');
  assert.equal(ticket.failureClass, 'network');
  assert.equal(ticket.requestId, continueRequestId('s1', 1, 0));

  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
  assert.equal(h.prompts[0].requestId, ticket.requestId);
  assert.equal(h.prompts[0].content[0].text, '继续');
  assert.equal(h.prompts[0].ticketState, 'claimed', 'claim is durable BEFORE the prompt');

  // Accepted is not proof: still claimed until the rpcId is in the log.
  assert.equal(h.store.ticket('s1').state, 'claimed');
  h.setInspection(inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }], {
    rpcOutside: [userMessage('m2', ticket.requestId)],
  }));
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').state, 'delivered');
  assert.equal(h.store.ticket('s1').deliveredTurn, null, 'no turn started after the message yet');

  h.setInspection(inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 2, messages: [userMessage('m2', ticket.requestId)], end: { kind: 'completed' } },
  ]));
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').state, 'done');
  assert.equal(h.calls.prompt, 1, 'exactly one prompt for one attempt');
});

test('non-recoverable, cancelled, unknown-code and tool-unknown turns create no ticket', async () => {
  for (const end of [
    errorEnd('AUTH'), errorEnd('ABORTED'), errorEnd('MADE_UP'), { kind: 'aborted' },
    errorEnd('TRANSPORT', { status: 401 }), errorEnd('CONTEXT_WINDOW_EXCEEDED'),
  ]) {
    const h = createHarness({ inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end }]) });
    await h.driver.start();
    h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: end } });
    await settle();
    assert.equal(h.store.ticket('s1'), null, JSON.stringify(end));
  }
  // A dispatched tool call with no recorded result is TOOL_OUTCOME_UNKNOWN.
  const inspection = inspectionFor('s1', [{
    turn: 1, messages: [userMessage('m1')],
    tools: [{ type: 'tool/call', data: { callId: 'c1' } }],
    end: errorEnd('TRANSPORT'),
  }]);
  const h = createHarness({ inspection });
  const facts = factsFromInspection(inspection, { endSeq: -1, rpcIds: [] });
  assert.equal(facts.toolOutcomeUnknown, true);
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  const unknownTicket = h.store.ticket('s1');
  assert.equal(unknownTicket.state, 'needs_attention');
  assert.equal(unknownTicket.lastReason, 'tool_outcome_unknown');
});

test('the provider fallback code (PI_AI_ERROR) is continued like any transient failure', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('PI_AI_ERROR') }]),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('PI_AI_ERROR') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'the overload must not be dropped as unclassified');
  assert.equal(ticket.failureClass, 'network');
  assert.equal(ticket.code, 'PI_AI_ERROR');
  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
  assert.equal(h.prompts[0].content[0].text, '继续');
});
test('ambiguous delivery is fenced: never resent, then escalated', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TIMEOUT') }]),
    promptError: Object.assign(new Error('transport broke'), { code: 'gateway/internal' }),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TIMEOUT') } });
  await settle();
  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').state, 'unknown');
  const requestId = h.store.ticket('s1').requestId;
  for (let i = 0; i < 4; i++) { h.clock.advance(60_000); await h.driver.tick(); }
  assert.equal(h.calls.prompt, 1, 'no blind resend after an ambiguous outcome');
  assert.equal(h.store.ticket('s1').state, 'needs_attention');
  assert.equal(h.store.ticket('s1').requestId, requestId);
});

test('a human message cancels; opt-out, pause and passive owner hold instead of sending', async () => {
  const withHuman = createHarness({ inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]) });
  await withHuman.driver.start();
  withHuman.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  withHuman.driver.listener({ id: 's1' }, { type: 'user/message', data: userMessage('m2') });
  await settle();
  assert.equal(withHuman.store.ticket('s1').state, 'cancelled');
  assert.equal(withHuman.store.ticket('s1').lastReason, 'new_user_instruction');

  for (const [name, options] of [
    ['opt-out', { optIn: false }],
    ['paused', { paused: true }],
    ['passive', { owner: { owned: false, verify: () => false } }],
    ['no-mutex', { owner: null }],
  ]) {
    const h = createHarness({
      inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]),
      ...options,
    });
    await h.driver.start();
    h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
    await settle();
    h.clock.advance(15_000);
    await h.driver.tick();
    assert.equal(h.calls.prompt, 0, name);
  }
});

test('Goal state is not consulted: a Goal round failure gets a normal prompt', async () => {
  // A completed/blocked/paused Goal used to veto the continuation entirely, which
  // stranded a session whose turn failed AFTER its Goal was marked complete.
  // Continuing only asks the session to keep working; no Goal CAS is attempted.
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    goal: { id: 'g1', phase: 'complete', activation: 'disarmed', revision: 9, roundsStarted: 9, maxGoalRounds: 4 },
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.calls.resume, 0, 'no Goal CAS resume');
  assert.equal(h.calls.prompt, 1, 'a normal 继续 prompt');
});

test('a blocked Goal and a spent round budget no longer veto the continuation', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    goal: { id: 'g1', phase: 'blocked', activation: 'disarmed', revision: 3, roundsStarted: 4, maxGoalRounds: 4 },
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.calls.resume, 0);
  assert.notEqual(h.store.ticket('s1').state, 'cancelled');
  assert.equal(h.calls.prompt, 1);
});

test('provider Retry-After is honoured before the first attempt', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('RATE_LIMIT', { providerRetryAfterMs: 120_000 }) }]),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('RATE_LIMIT', { providerRetryAfterMs: 120_000 }) } });
  await settle();
  assert.equal(h.store.ticket('s1').nextAt, NOW + 120_000);
  h.clock.advance(60_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 0);
  h.clock.advance(60_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
  assert.equal(h.prompts[0].requestId, continueRequestId('s1', 1, 0));
});

test('restart reconciliation clears a claim only on positive rpc evidence', async () => {
  const store = createFakeStore();
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const first = createHarness({ store, inspection });
  await first.driver.start();
  first.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  first.clock.advance(15_000);
  await first.driver.tick();
  assert.equal(first.store.ticket('s1').state, 'claimed');
  await first.driver.stop();

  const requestId = store.ticket('s1').requestId;
  const restored = createHarness({
    store,
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }], {
      rpcOutside: [userMessage('m2', requestId)],
    }),
  });
  await restored.driver.start();
  await restored.driver.tick();
  assert.equal(store.ticket('s1').state, 'delivered');
  assert.equal(restored.calls.prompt, 0, 'a restarted driver must not re-send');
});
test('a passive instance performs NO durable write at all', async () => {
  const store = createFakeStore();
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const passive = createHarness({ store, inspection, owner: { owned: false, verify: () => false } });
  await passive.driver.start();
  passive.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  passive.driver.listener({ id: 's1' }, { type: 'user/message', data: userMessage('m9') });
  await settle();
  passive.clock.advance(60_000);
  await passive.driver.tick();
  assert.equal(store.saves, 0, 'passive must not touch the last-write-wins medium');
  assert.equal(store.getSnapshot().revision, 0);
  assert.equal(store.ticket('s1'), null);
  assert.equal(passive.calls.prompt, 0);
});

test('stop() drains an in-flight prompt before the owner can be released', async () => {
  const order = [];
  let releasePrompt;
  let promptStarted;
  const started = new Promise((resolve) => { promptStarted = resolve; });
  const store = createFakeStore();
  const clock = createClock();
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  let promptSignal = null;
  const controller = {
    async inspect() { return structuredClone(inspection); },
    prompt(request, signal) {
      promptSignal = signal;
      order.push('prompt_started');
      promptStarted();
      return new Promise((resolve) => {
        releasePrompt = () => { order.push('prompt_settled'); resolve({ accepted: true }); };
      });
    },
  };
  const driver = createAutoContinueDriver({
    store,
    resolveController: () => controller,
    resolveInspection: () => controller,
    resolveAgents: () => ({ get: () => agent }),
    resolveGoals: () => ({ get: () => null, resume() {} }),
    getOptIn: () => true,
    isPaused: () => false,
    owner: { owned: true, verify: () => true },
    clock,
    pollMs: 5_000,
  });
  await driver.start();
  driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  clock.advance(15_000);
  const ticking = driver.tick();
  await started;
  assert.equal(promptSignal.aborted, false);

  let stopResolved = false;
  const stopping = driver.stop().then(() => { stopResolved = true; order.push('stop_resolved'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopResolved, false, 'stop must wait for the in-flight call');
  assert.equal(promptSignal.aborted, true, 'stop aborts the in-flight Host call');
  releasePrompt();
  await stopping;
  await ticking;
  assert.deepEqual(order, ['prompt_started', 'prompt_settled', 'stop_resolved']);
});
/** Real dsh-session crash-recovery shape: synthetic closers carry data.error. */
const syntheticCloser = (callId, code, turn = 1, step = 1) => ({
  type: 'tool/result',
  data: {
    turn,
    step,
    message: {
      id: code + '-tool-result-' + callId,
      role: 'tool',
      toolCallId: callId,
      isError: true,
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text: 'closer' }],
    },
    error: { name: code === 'TOOL_OUTCOME_UNKNOWN' ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError', code },
  },
});

test('a synthetic TOOL_OUTCOME_UNKNOWN closer never proves the tool finished', async () => {
  const inspection = inspectionFor('s1', [{
    turn: 1,
    messages: [userMessage('m1')],
    tools: [
      { type: 'tool/call', data: { callId: 'c1' } },
      syntheticCloser('c1', 'TOOL_OUTCOME_UNKNOWN'),
    ],
    end: errorEnd('TRANSPORT'),
  }]);
  const facts = factsFromInspection(inspection, { endSeq: -1, rpcIds: [] });
  assert.equal(facts.toolOutcomeUnknown, true, 'unknown side effect must stay unknown');
  const h = createHarness({ inspection });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  const blocked = h.store.ticket('s1');
  assert.equal(blocked.state, 'needs_attention', 'the refusal is durable and visible');
  assert.equal(blocked.lastReason, 'tool_outcome_unknown');
  assert.equal(h.calls.prompt, 0);
});

test('TOOL_NOT_STARTED is distinguished: no side effect, continuation allowed', async () => {
  const inspection = inspectionFor('s1', [{
    turn: 1,
    messages: [userMessage('m1')],
    tools: [syntheticCloser('c2', 'TOOL_NOT_STARTED')],
    end: errorEnd('TRANSPORT'),
  }]);
  const facts = factsFromInspection(inspection, { endSeq: -1, rpcIds: [] });
  assert.equal(facts.toolOutcomeUnknown, false);
  assert.equal(facts.toolNotStarted, 1);
  const h = createHarness({ inspection });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  assert.equal(h.store.ticket('s1').state, 'waiting');
  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
});

test('a real tool result (known outcome) clears the pending call', () => {
  const realResult = {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'r1', role: 'tool', toolCallId: 'c3', source: { kind: 'tool', callId: 'c3' },
        content: [{ type: 'text', text: 'done' }],
      },
    },
  };
  const inspection = inspectionFor('s1', [{
    turn: 1, messages: [userMessage('m1')],
    tools: [{ type: 'tool/call', data: { callId: 'c3' } }, realResult],
    end: errorEnd('TRANSPORT'),
  }]);
  const facts = factsFromInspection(inspection, { endSeq: -1, rpcIds: [] });
  assert.equal(facts.toolOutcomeUnknown, false);
  assert.equal(facts.pendingToolCalls, 0);
});
test('unverifiable identity holds instead of cancelling as a task change', () => {
  const ticket = createTicket({
    sessionId: 's1', turn: 1, endSeq: 1, now: NOW,
    decision: { action: 'ticket', failureClass: 'network', code: 'TRANSPORT', retryAfterMs: null },
    rootMessageId: 'root-a',
  });
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    rootMessageId: null, goal: null, lastEnd: { turn: 1, kind: 'error', seq: 1 },
  };
  const decision = decideTicket(ticket, facts, { now: NOW + 15_000, maxAttempts: 5 });
  assert.equal(decision.action, 'hold');
  assert.equal(decision.reason, 'identity_unverified');
  // A DIFFERENT verified root is still a real change.
  assert.equal(decideTicket(ticket, { ...facts, rootMessageId: 'root-b' }, { now: NOW + 15_000, maxAttempts: 5 }).reason, 'optin_task_changed');
});

test('a stale tool call from an earlier task does not block a later task', () => {
  const stale = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], tools: [{ type: 'tool/call', data: { callId: 'old' } }], end: errorEnd('TRANSPORT') },
    { turn: 2, messages: [userMessage('m2')], end: errorEnd('TRANSPORT') },
  ]);
  const facts = factsFromInspection(stale, { endSeq: 5, rpcIds: [] }, 3);
  assert.equal(facts.toolOutcomeUnknown, false, 'scope starts at the current task root');
  // A verified task root is what produces that boundary; the pure observation
  // above proves the scoping itself.
  assert.equal(facts.pendingToolCalls, 0);
});

test('an unknown tool outcome INSIDE the current task blocks visibly', async () => {
  // Same task: turn 2 is a synthetic continuation, not a new human root.
  const scoped = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], tools: [
      { type: 'tool/call', data: { callId: 'c1' } },
      syntheticCloser('c1', 'TOOL_OUTCOME_UNKNOWN'),
    ], end: errorEnd('TRANSPORT') },
    { turn: 2, end: errorEnd('TRANSPORT') },
  ]);
  const h = createHarness({ inspection: scoped });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 2, reason: errorEnd('TRANSPORT') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.state, 'needs_attention');
  assert.equal(ticket.lastReason, 'tool_outcome_unknown');
  assert.equal(h.calls.prompt, 0);
});

test('queued work blocks the continuation only when it is a HUMAN instruction', async () => {
  const failed = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const synthetic = { id: 'n1', role: 'user', content: [], source: { kind: 'agent-message' } };
  const human = { id: 'h1', role: 'user', content: [], source: { kind: 'user' } };
  const malformed = { id: 'x1', role: 'user', content: [] };
  const cases = [
    ['synthetic notice', synthetic, 1],
    ['human instruction', human, 0],
    ['unreadable item', malformed, 0],
  ];
  for (const [label, item, expected] of cases) {
    const h = createHarness({
      inspection: failed,
      inbox: { nextTurn: [], nextStep: [item] },
    });
    await h.driver.start();
    h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
    await settle();
    h.clock.advance(15_000);
    await h.driver.tick();
    assert.equal(h.calls.prompt, expected, label);
    if (expected === 0) assert.equal(h.store.ticket('s1').lastReason, 'agent_busy', label);
    await h.driver.stop();
  }
});

test('a sustained busy hold becomes visible instead of waiting for the age cap', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]),
    inbox: { nextTurn: [{ id: 'h1', role: 'user', content: [], source: { kind: 'user' } }], nextStep: [] },
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').lastReason, 'agent_busy');
  h.clock.advance(5 * 60_000);
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').state, 'needs_attention');
  assert.equal(h.store.ticket('s1').lastReason, 'agent_busy');
  assert.equal(h.calls.prompt, 0);
});
test('quota waits use their own long pace and are not aged out', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  const first = h.store.ticket('s1');
  assert.equal(first.nextAt - NOW, 300_000, 'first quota probe after 5 minutes');
  assert.equal(Object.hasOwn(first, 'expiresAt'), false, 'no age cap exists any more');
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
  // Our delivered turn fails on quota again: the NEXT attempt is hourly.
  h.setInspection(inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') },
    { turn: 2, messages: [userMessage('m2', first.requestId)], end: errorEnd('QUOTA') },
  ]));
  await settle();
  for (let i = 0; i < 3; i++) { h.clock.advance(1_000); await h.driver.tick(); }
  const second = h.store.ticket('s1');
  assert.equal(second.attempt, 1);
  assert.ok(second.nextAt - second.createdAt >= 3_599_000, 'later quota attempts are hourly');
});

test('a session without opt-in is never inspected and gets no ticket', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]),
    optIn: false,
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  assert.equal(h.calls.inspect, 0, 'no log read for an unselected session');
  assert.equal(h.store.ticket('s1'), null);
});

test('a non-cooperative prompt keeps ownership until it really settles', async () => {
  const net = await import('node:net');
  const freePort = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const fsStub = { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} };
  const { createOwnerMutex } = await import('../../host/owner-lock.js');
  const owner = createOwnerMutex({ port: freePort, instanceId: 'owner-a', fs: fsStub });
  assert.equal((await owner.acquire()).active, true);
  let resolved = false;
  const store = createFakeStore();
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  const controller = {
    async inspect() { return structuredClone(inspection); },
    prompt() {
      // Ignores abort and resolves only when the test says so.
      return new Promise((resolve) => { resolved = () => resolve({ accepted: true }); });
    },
  };
  const driver = createAutoContinueDriver({
    store,
    resolveController: () => controller,
    resolveInspection: () => controller,
    resolveAgents: () => ({ get: () => agent }),
    resolveGoals: () => ({ get: () => null, resume() {} }),
    getOptIn: () => true,
    isPaused: () => false,
    owner,
    pollMs: 5_000,
    sendTimeoutMs: 20,
    drainTimeoutMs: 50,
    delayMsFor: () => 0,
  });
  await driver.start();
  driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  // The start() tick runs on its own; wait for it instead of racing it.
  for (let i = 0; i < 200; i++) {
    const state = store.ticket('s1')?.state;
    if (state === 'unknown' || state === 'needs_attention') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(store.ticket('s1').state, 'unknown');

  await driver.stop();
  assert.equal(driver.releaseSafe, false, 'an unsettled call makes release unsafe');
  assert.equal(owner.verify(), true, 'the owner port is still held');
  const rival = createOwnerMutex({ port: freePort, instanceId: 'owner-b', fs: fsStub });
  assert.deepEqual(await rival.acquire(), { active: false, reason: 'held_by_peer' }, 'a second instance must not take over');

  resolved();
  await new Promise((r) => setTimeout(r, 10));
  await owner.release();
  assert.equal(owner.verify(), false);
});
test('our own auto continuation is not a new human root: a second failure still retries', async () => {
  const first = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const h = createHarness({ inspection: first });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  h.clock.advance(15_000);
  await h.driver.tick();
  const t0 = h.store.ticket('s1');
  assert.equal(t0.state, 'claimed');
  assert.equal(t0.rootMessageId, 'm1');

  // The Host logs our admitted prompt as source.kind=user with our rpcId, and
  // the continued turn fails again.
  h.setInspection(inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 2, messages: [userMessage('m2', t0.requestId)], end: errorEnd('TRANSPORT') },
  ]));
  await settle();
  await h.driver.tick(); // reconcile our rpcId -> delivered on turn 2
  h.clock.advance(1_000);
  await h.driver.tick(); // settle the failed continued turn -> attempt 1
  const t1 = h.store.ticket('s1');
  assert.equal(t1.attempt, 1, 'a second automatic attempt is allowed');
  assert.equal(t1.rootMessageId, 'm1', 'the ORIGINAL human root is inherited');
  assert.equal(t1.lastReason, 'scheduled', 'not cancelled as optin_task_changed');

  // Late recovery: the second attempt is delivered and that turn completes.
  h.clock.advance(30_000);
  await h.driver.tick();
  const t1Sent = h.store.ticket('s1');
  h.setInspection(inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 2, messages: [userMessage('m2', t0.requestId)], end: errorEnd('TRANSPORT') },
    { turn: 3, messages: [userMessage('m3', t1Sent.requestId)], end: { kind: 'completed' } },
  ]));
  await settle();
  for (let i = 0; i < 3; i++) { h.clock.advance(1_000); await h.driver.tick(); }
  const finalTicket = h.store.ticket('s1');
  assert.equal(finalTicket.state, 'done', JSON.stringify({ state: finalTicket.state, reason: finalTicket.lastReason, attempt: finalTicket.attempt, deliveredTurn: finalTicket.deliveredTurn, turn: finalTicket.turn }));
  assert.equal(h.calls.prompt, 2);
});

test('a real new human message still cancels, and an interrupted turn never creates a ticket', async () => {
  const h = createHarness({ inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]) });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  h.driver.listener({ id: 's1' }, { type: 'user/message', data: userMessage('human-2') });
  await settle();
  assert.equal(h.store.ticket('s1').state, 'cancelled');
  assert.equal(h.store.ticket('s1').lastReason, 'new_user_instruction');

  const interrupted = createHarness({ inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: { kind: 'interrupted' } }]) });
  await interrupted.driver.start();
  interrupted.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } });
  await settle();
  assert.equal(interrupted.store.ticket('s1'), null, 'interrupted is not a network failure');
});
test('cold scan (KD-2): a durable error with no ticket is recovered at startup, opt-in only', async () => {
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const h = createHarness({ inspection, listOptIns: () => ['s1'] });
  await h.driver.start();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'the durable failure is discovered without any live event');
  assert.equal(ticket.turn, 1);
  assert.equal(ticket.attempt, 0);
  assert.equal(ticket.failureClass, 'network');
  assert.equal(ticket.rootMessageId, 'm1');
  assert.equal(h.driver.coldScan.created, 1);
});

test('cold scan never reads a session that is not opted in', async () => {
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const h = createHarness({ inspection, listOptIns: () => ['s1'], getOptIn: () => false });
  await h.driver.start();
  assert.equal(h.store.ticket('s1'), null);
  assert.equal(h.calls.inspect, 0);
});

test('cold scan skips interrupted, unknown tool outcome and open turns', async () => {
  const cases = [
    inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: { kind: 'interrupted' } }]),
    inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], tools: [
      { type: 'tool/call', data: { callId: 'c1' } },
      syntheticCloser('c1', 'TOOL_OUTCOME_UNKNOWN'),
    ], end: errorEnd('TRANSPORT') }]),
    inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: null }]),
  ];
  for (const inspection of cases) {
    const h = createHarness({ inspection, listOptIns: () => ['s1'] });
    await h.driver.start();
    assert.equal(h.store.ticket('s1'), null, 'fail-closed: no ticket');
    await h.driver.stop();
  }
});

test('cold scan does not duplicate a ticket that already exists for the same turn', async () => {
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const store = createFakeStore();
  const first = createHarness({ store, inspection, listOptIns: () => [] });
  await first.driver.start();
  first.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  const before = store.ticket('s1');
  assert.equal(before.state, 'waiting');
  await first.driver.stop();

  const restored = createHarness({ store, inspection, listOptIns: () => ['s1'] });
  await restored.driver.start();
  const after = store.ticket('s1');
  assert.equal(after.id, before.id, 'no second ticket for the same turn');
  assert.equal(restored.driver.coldScan.created, 0);
});
test('cold scan covers every opted-in session across bounded batches', async () => {
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  const inspections = Object.fromEntries(ids.map((id) => [id, inspectionFor(id, [
    { turn: 1, messages: [userMessage('m-' + id)], end: errorEnd('TRANSPORT') },
  ])]));
  const optedOut = new Set();
  const h = createHarness({
    inspections,
    listOptIns: () => ids,
    getOptIn: (id) => !optedOut.has(id),
  });
  await h.driver.start();
  const first = h.driver.coldScan;
  assert.equal(first.created, 5, 'first batch is capped by maxColdScanSessions');
  assert.equal(first.done, false);
  // A session that opts out between batches is re-verified and skipped.
  optedOut.add('s6');
  await h.driver.coldScanNow();
  const second = h.driver.coldScan;
  assert.equal(second.done, true);
  assert.equal(h.driver.tickets.length, 7, 'all opted-in sessions were scanned, s6 skipped');
  assert.equal(h.store.ticket('s6'), null);
  assert.equal(h.store.ticket('s8').state, 'waiting');
});
test('a cold log that cannot be read is visible, written once, and counted', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
  await settle();
  const before = h.store.getSnapshot().revision;
  h.setInspection(null);
  h.clock.advance(15_000);
  await h.driver.tick();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.lastReason, 'inspection_unavailable');
  assert.ok(h.store.getSnapshot().revision > before, 'the failure is durable, not silent');
  assert.equal(h.driver.projection().diagnostics.inspectFailures, 1);
  assert.equal(h.driver.projection().diagnostics.tickCount >= 1, true);
  const afterFirst = h.store.getSnapshot().revision;
  h.clock.advance(15_000);
  await h.driver.tick();
  assert.equal(h.store.getSnapshot().revision, afterFirst, 'the same reason is not rewritten every tick');
  assert.equal(h.driver.projection().diagnostics.inspectFailures, 2);
});

test('no automatic turn is spent until the account can pay for it', async () => {
  let quota = { state: 'exhausted' };
  let reads = 0;
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    readQuota: () => { reads += 1; return quota; },
    quotaGateRetryMs: 600_000,
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  assert.equal(h.store.ticket('s1').failureClass, 'quota');

  // Due (first quota retry at 5 min) and the session is proven interrupted,
  // but the account is exhausted: no turn is sent and no attempt is burnt.
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 0, 'quota exhaustion must not be paid for with a turn');
  const waiting = h.store.ticket('s1');
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.lastReason, 'quota_waiting');
  assert.equal(waiting.attempt, 0, 'a quota wait is not an attempt');
  assert.equal(waiting.nextAt, h.clock.now() + 600_000, 're-check paced by quotaGateRetryMs');

  // Fast ticks keep that schedule instead of re-querying or sending.
  const readsAfterGate = reads;
  for (let i = 0; i < 10; i++) { h.clock.advance(5_000); await h.driver.tick(); }
  assert.equal(reads, readsAfterGate, 'one gate query per interval, not per tick');
  assert.equal(h.calls.prompt, 0);

  // Quota returns: the next due tick sends exactly one turn.
  quota = { state: 'available', remaining: 42 };
  h.clock.advance(600_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 1);
  assert.equal(h.prompts[0].content[0].text, '继续');
});

test('an unreadable quota observation holds instead of sending', async () => {
  for (const [label, readQuota] of [
    ['no answer', () => null],
    ['throws', () => { throw new Error('management endpoint down'); }],
    ['unknown state', () => ({ state: 'weird' })],
    ['rate limited', () => ({ state: 'rate_limited' })],
  ]) {
    const h = createHarness({
      inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
      readQuota,
    });
    await h.driver.start();
    h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
    await settle();
    h.clock.advance(300_000);
    await h.driver.tick();
    assert.equal(h.calls.prompt, 0, label);
    assert.equal(h.store.ticket('s1').lastReason, 'quota_unknown', label);
  }

  // A credential/permission answer is not a wait: a human must fix it.
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    readQuota: () => ({ state: 'auth_required' }),
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.calls.prompt, 0);
  assert.equal(h.store.ticket('s1').state, 'needs_attention');
  assert.equal(h.store.ticket('s1').lastReason, 'quota_auth_required');
});

test('a quota wait keeps its gate reason between checks', async () => {
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    readQuota: () => ({ state: 'exhausted', resetAt: new Date(NOW + 3_600_000).toISOString() }),
    quotaGateRetryMs: 600_000,
    quotaCheckMs: 1_000,
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  h.clock.advance(300_000);
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').lastReason, 'quota_waiting');
  // Fast ticks do not replace the explanation with a bare backoff.
  h.clock.advance(5_000);
  await h.driver.tick();
  assert.equal(h.store.ticket('s1').lastReason, 'quota_waiting');
  assert.equal(h.calls.prompt, 0);
});
test('the quota wait wakes just after the blocked window resets', async () => {
  const resetAt = new Date(NOW + 3_600_000).toISOString();
  const h = createHarness({
    inspection: inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA') }]),
    readQuota: () => ({ state: 'exhausted', resetAt }),
    quotaGateRetryMs: 600_000,
    quotaCheckMs: 1_000,
  });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  h.clock.advance(300_000);
  await h.driver.tick();
  const waiting = h.store.ticket('s1');
  assert.equal(waiting.lastReason, 'quota_waiting');
  // Wake a few seconds after the window reset instead of polling blindly.
  assert.equal(waiting.nextAt, Date.parse(resetAt) + 5_000);
  assert.equal(h.calls.prompt, 0);
});

test('a switch turned on AFTER the failure is backfilled with one normal ticket', async () => {
  const failedAt = NOW - 10 * 60_000;
  const inspection = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA'), endTime: failedAt },
  ], { baseTime: failedAt - 60_000 });
  let optIn = false;
  const h = createHarness({ inspection, getOptIn: () => optIn, listOptIns: () => (optIn ? ['s1'] : []) });
  await h.driver.start();
  assert.equal(h.store.ticket('s1'), null, 'nothing is guessed before the switch');

  // The user turns the switch on now: the failure predates it, so only the
  // backfill can see it.
  optIn = true;
  await h.driver.tick();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'the pre-existing failure is backfilled');
  assert.equal(ticket.state, 'waiting');
  assert.equal(ticket.turn, 1);
  assert.equal(ticket.failureClass, 'quota');
  assert.equal(ticket.attempt, 0, 'a backfilled failure owns a fresh attempt budget');
  assert.equal(h.calls.prompt, 0, 'a backfilled ticket still waits for the quota gate');

  // Later ticks only OBSERVE this ticket: no second backfill, no new ticket.
  const before = h.store.ticket('s1');
  h.clock.advance(5_000);
  await h.driver.tick();
  const after = h.store.ticket('s1');
  assert.equal(after.id, before.id);
  assert.equal(after.state, 'waiting');
  assert.equal(h.calls.prompt, 0);
});

test('backfill has no age cutoff: a long-past failure is still recoverable', async () => {
  const failedAt = NOW - 30 * 24 * 3_600_000;
  const inspection = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA'), endTime: failedAt },
  ], { baseTime: failedAt - 1_000 });
  let optIn = false;
  const h = createHarness({ inspection, getOptIn: () => optIn, listOptIns: () => (optIn ? ['s1'] : []) });
  await h.driver.start();
  optIn = true;
  await h.driver.tick();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'age is never a reason to refuse a failure');
  assert.equal(ticket.turn, 1);
  assert.equal(ticket.attempt, 0);
  assert.equal(h.calls.prompt, 0, 'the quota gate still paces the first probe');
});

test('backfill reopens a cancelled ticket that never delivered', async () => {
  const failedAt = NOW - 10 * 60_000;
  const decision = decideError({ code: 'QUOTA' });
  const cancelled = markCancelled(createTicket({
    sessionId: 's1', turn: 1, endSeq: 4, decision, attempt: 0, rootMessageId: 'm1',
    now: failedAt, delayMs: 300_000,
  }), { now: failedAt + 60_000, reason: 'session_opt_out' });
  assert.equal(cancelled.deliveredTurn, null);
  const store = createFakeStore({ version: 1, revision: 2, tickets: { s1: cancelled }, updatedAt: new Date(NOW).toISOString() });
  const inspection = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA'), endTime: failedAt },
  ], { baseTime: failedAt - 60_000 });
  let optIn = false;
  const h = createHarness({ store, inspection, getOptIn: () => optIn, listOptIns: () => (optIn ? ['s1'] : []) });
  await h.driver.start();
  assert.equal(h.store.ticket('s1').state, 'cancelled', 'opt-out stays cancelled until re-opted');
  optIn = true;
  await h.driver.tick();
  const reopened = h.store.ticket('s1');
  assert.equal(reopened.state, 'waiting');
  assert.equal(reopened.turn, 1);
  assert.equal(reopened.attempt, 0);
  assert.equal(Object.hasOwn(reopened, 'expiresAt'), false, 'no age field exists');
});

test('re-enabling a session after a later failure backfills again', async () => {
  const failedAt = NOW - 10 * 60_000;
  const completed = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: { kind: 'completed' }, endTime: failedAt },
  ], { baseTime: failedAt - 60_000 });
  let optIn = true;
  const h = createHarness({
    inspection: completed,
    getOptIn: () => optIn,
    listOptIns: () => (optIn ? ['s1'] : []),
  });
  await h.driver.start();
  assert.equal(h.store.ticket('s1'), null, 'a completed turn is not a failure');

  // The user disables the switch, then the session fails while disabled.
  optIn = false;
  await h.driver.tick();
  h.setInspection(inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: { kind: 'completed' }, endTime: failedAt },
    { turn: 2, end: errorEnd('QUOTA'), endTime: failedAt + 60_000 },
  ], { baseTime: failedAt - 60_000 }));

  // Enabling it again must scan once more instead of trusting the old mark.
  optIn = true;
  await h.driver.tick();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'the new failure is backfilled');
  assert.equal(ticket.turn, 2);
});
test('backfill never touches a running session, a completed turn or a delivered ticket', async () => {
  const failedAt = NOW - 10 * 60_000;
  const failed = inspectionFor('s1', [
    { turn: 1, messages: [userMessage('m1')], end: errorEnd('QUOTA'), endTime: failedAt },
  ], { baseTime: failedAt - 60_000 });
  // A running agent: the live path owns the turn, the log may still be open.
  const running = createHarness({ inspection: failed, status: 'running', listOptIns: () => ['s1'] });
  await running.driver.start();
  running.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('QUOTA') } });
  await settle();
  running.clock.advance(300_000);
  await running.driver.tick();
  assert.equal(running.calls.prompt, 0, 'a running agent is never continued');

  // A completed turn is not an interruption at all.
  const completed = inspectionFor('s2', [
    { turn: 1, messages: [userMessage('m2')], end: { kind: 'completed' }, endTime: failedAt },
  ], { baseTime: failedAt - 60_000 });
  const done = createHarness({ inspection: completed, listOptIns: () => ['s2'] });
  await done.driver.start();
  assert.equal(done.store.ticket('s2'), null);
});

test('a new failure outside the ticket chain restarts the attempt budget', async () => {
  const OLD = NOW - 8 * 3_600_000;
  const decision = decideError({ code: 'TRANSPORT' });
  const dead = markAttention(createTicket({
    sessionId: 's1', turn: 5, endSeq: 4, decision, attempt: 2, rootMessageId: 'm1',
    now: OLD,
  }), { now: OLD + 60_000, reason: 'max_attempts' });
  assert.equal(dead.state, 'needs_attention');
  const store = createFakeStore({
    version: 1, revision: 2, tickets: { s1: dead }, updatedAt: new Date(NOW).toISOString(),
  });
  const inspection = inspectionFor('s1', [
    { turn: 5, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 6, messages: [userMessage('m2')], end: errorEnd('TRANSPORT') },
  ]);
  const h = createHarness({ store, inspection });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 6, reason: errorEnd('TRANSPORT') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.turn, 6);
  assert.equal(ticket.state, 'waiting', 'the new failure is recoverable again');
  assert.equal(ticket.attempt, 0, 'a new failure owns a fresh attempt budget');
  assert.equal(Object.hasOwn(ticket, 'expiresAt'), false, 'no age field exists');
  assert.equal(h.calls.prompt, 0, 'still gated by its own backoff');
});

test('a failure of OUR OWN delivered turn continues the attempt chain', async () => {
  const OLD = NOW - 5 * 3_600_000;
  const decision = decideError({ code: 'TRANSPORT' });
  const base = createTicket({
    sessionId: 's1', turn: 5, endSeq: 4, decision, attempt: 1, rootMessageId: 'm1',
    now: OLD,
  });
  const delivered = markDelivered(base, { now: OLD + 60_000, deliveredTurn: 6 });
  const store = createFakeStore({
    version: 1, revision: 2, tickets: { s1: delivered }, updatedAt: new Date(NOW).toISOString(),
  });
  const inspection = inspectionFor('s1', [
    { turn: 5, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 6, messages: [userMessage('m2', base.requestId)], end: errorEnd('TRANSPORT') },
  ]);
  const h = createHarness({ store, inspection });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 6, reason: errorEnd('TRANSPORT') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.turn, 6);
  assert.equal(ticket.attempt, 2, 'our own continuation chain keeps counting attempts');
});

test('an in-flight send with no recorded turn still continues the chain', async () => {
  const OLD = NOW - 3_600_000;
  const decision = decideError({ code: 'TRANSPORT' });
  const waiting = createTicket({
    sessionId: 's1', turn: 5, endSeq: 4, decision, attempt: 1, rootMessageId: 'm1',
    now: OLD,
  });
  const claimed = markClaimed(waiting, { now: NOW - 60_000, requestId: continueRequestId('s1', 5, 1) });
  assert.equal(claimed.deliveredTurn, null);
  const store = createFakeStore({
    version: 1, revision: 2, tickets: { s1: claimed }, updatedAt: new Date(NOW).toISOString(),
  });
  const inspection = inspectionFor('s1', [
    { turn: 5, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') },
    { turn: 6, messages: [userMessage('m2')], end: errorEnd('TRANSPORT') },
  ]);
  const h = createHarness({ store, inspection });
  await h.driver.start();
  h.driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 6, reason: errorEnd('TRANSPORT') } });
  await settle();
  const ticket = h.store.ticket('s1');
  assert.equal(ticket.attempt, 2, 'an unconfirmed send is never treated as a fresh chain');
});

test('backfill after a closed ticket restarts the attempt budget', async () => {
  const OLD = NOW - 8 * 3_600_000;
  const failedAt = NOW - 10 * 60_000;
  const decision = decideError({ code: 'QUOTA' });
  const dead = markAttention(createTicket({
    sessionId: 's1', turn: 5, endSeq: 4, decision, attempt: 3, rootMessageId: 'm1',
    now: OLD,
  }), { now: OLD + 60_000, reason: 'max_attempts' });
  const store = createFakeStore({
    version: 1, revision: 2, tickets: { s1: dead }, updatedAt: new Date(NOW).toISOString(),
  });
  const inspection = inspectionFor('s1', [
    { turn: 5, messages: [userMessage('m1')], end: errorEnd('QUOTA'), endTime: OLD + 1_000 },
    { turn: 6, messages: [userMessage('m2')], end: errorEnd('QUOTA'), endTime: failedAt },
  ], { baseTime: OLD - 1_000 });
  let optIn = false;
  const h = createHarness({ store, inspection, getOptIn: () => optIn, listOptIns: () => (optIn ? ['s1'] : []) });
  await h.driver.start();
  optIn = true;
  await h.driver.tick();
  const ticket = h.store.ticket('s1');
  assert.ok(ticket !== null, 'the new failure is recoverable after the old chain closed');
  assert.equal(ticket.turn, 6);
  assert.equal(ticket.attempt, 0);
  assert.equal(Object.hasOwn(ticket, 'expiresAt'), false);
});
