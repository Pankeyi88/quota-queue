/** Continuation policy: strict stop matrix, provider delays, positive correlation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideError,
  backoffDelay,
  createTicket,
  validateTicket,
  continueRequestId,
  decideTicket,
  reconcileFence,
  markClaimed,
  ticketSummary,
  nextAttempt,
  RETRY_AFTER_CEILING_MS,
} from '../../core/continue-ticket.mjs';

const NOW = 1_700_000_000_000;
const LIMITS = { now: NOW, maxAttempts: 5 };
const baseTicket = (overrides = {}) => createTicket({
  sessionId: 's-1', turn: 3, endSeq: 10, now: NOW,
  decision: { action: 'ticket', failureClass: 'network', code: 'TRANSPORT', status: null, retryAfterMs: null },
  ...overrides,
});

test('stop matrix: only explicit recoverable failures create a ticket', () => {
  assert.equal(decideError({ code: 'TRANSPORT' }).failureClass, 'network');
  assert.equal(decideError({ code: 'TIMEOUT', status: 504 }).failureClass, 'network');
  assert.equal(decideError({ code: 'QUOTA', status: 429 }).failureClass, 'quota');
  assert.equal(decideError({ code: 'RATE_LIMIT' }).failureClass, 'rate_limit');
  assert.equal(decideError({ status: 429 }).failureClass, 'rate_limit');
  assert.equal(decideError({ status: 503 }).failureClass, 'network');

  // The pi-ai adapter's fallback (overloads with no recognizable status/text)
  // is a transient continuation, not an unclassified stop.
  assert.equal(decideError({ code: 'PI_AI_ERROR' }).action, 'ticket');
  assert.equal(decideError({ code: 'PI_AI_ERROR' }).failureClass, 'network');
  assert.equal(decideError({ code: 'PI_AI_ERROR', status: 401 }).action, 'stop');
  assert.equal(decideError({ code: 'PI_AI_ERROR', status: 429 }).reason, 'evidence_conflict');

  for (const input of [
    { code: 'AUTH' }, { code: 'TOKEN_REVOKED' }, { status: 401 }, { status: 403 },
    { code: 'ABORTED' }, { code: 'USER_CANCEL' }, { code: 'CONTEXT_WINDOW_EXCEEDED' },
    { code: 'UNKNOWN_CODE' }, { code: 'MADE_UP', status: 500 }, {}, null,
  ]) {
    assert.equal(decideError(input).action, 'stop', JSON.stringify(input));
  }
});

test('identity/permission statuses override transient-looking codes', () => {
  assert.equal(decideError({ code: 'TRANSPORT', status: 401 }).reason, 'authentication_required');
  assert.equal(decideError({ code: 'QUOTA', status: 403 }).reason, 'authentication_required');
  assert.equal(decideError({ code: 'QUOTA', status: 400 }).reason, 'not_recoverable');
  assert.equal(decideError({ code: 'TRANSPORT', status: 429 }).reason, 'evidence_conflict');
  assert.equal(decideError({ code: 'RATE_LIMIT', status: 503 }).reason, 'evidence_conflict');
});

test('provider retry delay is read from providerRetryAfterMs and never shortened', () => {
  const decision = decideError({ code: 'RATE_LIMIT', providerRetryAfterMs: 120_000 });
  assert.equal(decision.retryAfterMs, 120_000);
  assert.equal(decideError({ code: 'RATE_LIMIT', retryAfterMs: 45_000 }).retryAfterMs, 45_000);
  assert.equal(decideError({ code: 'RATE_LIMIT', retryAfter: 90 }).retryAfterMs, 90_000);
  // A very long delay is not clipped into an early retry.
  assert.equal(decideError({ code: 'RATE_LIMIT', providerRetryAfterMs: RETRY_AFTER_CEILING_MS * 2 }).retryAfterMs, RETRY_AFTER_CEILING_MS);
  const ticket = createTicket({
    sessionId: 's-1', turn: 3, endSeq: 10, now: NOW,
    decision: decideError({ code: 'RATE_LIMIT', providerRetryAfterMs: 120_000 }),
  });
  assert.equal(ticket.nextAt, NOW + 120_000);
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  const decisionAt = decideTicket(ticket, facts, { now: NOW + 60_000, maxAttempts: 5 });
  assert.equal(decisionAt.action, 'wait', 'must still wait before the provider instant');
  assert.equal(decideTicket(ticket, facts, { now: NOW + 120_000, maxAttempts: 5 }).action, 'send');
});

test('a long provider delay is waited out, never retried early', () => {
  const ticket = createTicket({
    sessionId: 's-1', turn: 3, endSeq: 10, now: NOW,
    decision: decideError({ code: 'QUOTA', providerRetryAfterMs: 600_000 }),
  });
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  const early = decideTicket(ticket, facts, { now: NOW + 1, maxAttempts: 5 });
  assert.equal(early.action, 'wait');
  assert.equal(early.reason, 'backoff');
  assert.equal(decideTicket(ticket, facts, { now: NOW + 600_000, maxAttempts: 5 }).action, 'send');
});

test('every blocker produces a specific reason', () => {
  const ticket = baseTicket();
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  assert.equal(decideTicket(ticket, facts, { now: NOW + 15_000, maxAttempts: 5 }).action, 'send');
  assert.equal(decideTicket(ticket, { ...facts, optIn: false }, LIMITS).reason, 'session_opt_out');
  assert.equal(decideTicket(ticket, { ...facts, userAfter: true }, LIMITS).reason, 'new_user_instruction');
  assert.equal(decideTicket(ticket, { ...facts, openTurn: true }, LIMITS).reason, 'turn_outcome_unknown');
  assert.equal(decideTicket(ticket, { ...facts, toolOutcomeUnknown: true }, LIMITS).reason, 'tool_outcome_unknown');
  assert.equal(decideTicket(ticket, { ...facts, owner: false }, LIMITS).reason, 'owner_passive');
  assert.equal(decideTicket(ticket, { ...facts, paused: true }, LIMITS).reason, 'paused');
  assert.equal(decideTicket(ticket, { ...facts, agentStatus: 'running' }, LIMITS).reason, 'agent_busy');
  assert.equal(decideTicket(ticket, { ...facts, inboxPending: 1 }, LIMITS).reason, 'agent_busy');
  // Goal state is deliberately not consulted: a paused/blocked/complete Goal no
  // longer vetoes the continuation.
  for (const phase of ['paused', 'blocked', 'complete']) {
    assert.equal(decideTicket(ticket, { ...facts, goal: { phase } }, { now: NOW + 15_000, maxAttempts: 5 }).action, 'send', phase);
  }
  assert.equal(decideTicket(ticket, { ...facts, lastEnd: { turn: 4, kind: 'error', seq: 20 } }, LIMITS).reason, 'turn_mismatch');
});

test('a queued synthetic notice never blocks the continuation, a human one does', () => {
  const ticket = baseTicket();
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 2, inboxHuman: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  assert.equal(decideTicket(ticket, facts, { now: NOW + 15_000, maxAttempts: 5 }).action, 'send');
  assert.equal(decideTicket(ticket, { ...facts, inboxHuman: 1 }, { now: NOW + 15_000, maxAttempts: 5 }).reason, 'agent_busy');
  // A Host that reports only the coarse count keeps the strict behaviour.
  const coarse = { ...facts };
  delete coarse.inboxHuman;
  assert.equal(decideTicket(ticket, coarse, { now: NOW + 15_000, maxAttempts: 5 }).reason, 'agent_busy');
});
test('the quota gate sits after the interruption checks and never counts as an attempt', () => {
  const ticket = baseTicket({
    decision: { action: 'ticket', failureClass: 'quota', code: 'QUOTA', status: null, retryAfterMs: null },
  });
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  const due = ticket.nextAt + 1;
  const gate = { now: due, maxAttempts: 5, quotaRequired: true, quotaRetryMs: 600_000 };

  // No observation is never read as permission.
  assert.equal(decideTicket(ticket, facts, gate).action, 'wait');
  assert.equal(decideTicket(ticket, facts, gate).reason, 'quota_unknown');
  assert.equal(decideTicket(ticket, { ...facts, quota: null }, gate).reason, 'quota_unknown');
  assert.equal(decideTicket(ticket, { ...facts, quota: { state: 'weird' } }, gate).reason, 'quota_unknown');

  // Exhausted (and any non-available scheduling state) waits out the interval.
  for (const state of ['exhausted', 'rate_limited', 'unknown']) {
    const wait = decideTicket(ticket, { ...facts, quota: { state } }, gate);
    assert.equal(wait.action, 'wait', state);
    assert.equal(wait.reason, state === 'exhausted' ? 'quota_waiting' : 'quota_unknown', state);
    assert.equal(wait.waitMs, 600_000, state);
  }

  // Available sends; a broken credential escalates to a human instead.
  assert.equal(decideTicket(ticket, { ...facts, quota: { state: 'available' } }, gate).action, 'send');
  const auth = decideTicket(ticket, { ...facts, quota: { state: 'auth_required' } }, gate);
  assert.equal(auth.action, 'attention');
  assert.equal(auth.reason, 'quota_auth_required');

  // Interruption evidence still wins over the account: a running agent is not
  // resumed even when the quota is healthy.
  assert.equal(decideTicket(ticket, { ...facts, agentStatus: 'running', quota: { state: 'available' } }, gate).reason, 'agent_busy');
  assert.equal(decideTicket(ticket, { ...facts, openTurn: true, quota: { state: 'available' } }, gate).reason, 'turn_outcome_unknown');

  // Deployments without a verified quota source keep the time-only policy.
  assert.equal(decideTicket(ticket, facts, { now: due, maxAttempts: 5 }).action, 'send');
});

test('a newer turn is never treated as delivery, failure or retry', () => {
  const ticket = baseTicket();
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 9, kind: 'completed', seq: 99 },
  };
  assert.equal(decideTicket(ticket, facts, LIMITS).action, 'attention');
  assert.equal(decideTicket(ticket, facts, LIMITS).reason, 'turn_mismatch');
});

test('fence never resends and escalates after the grace period', () => {
  const ticket = markClaimed(baseTicket(), { now: NOW, requestId: baseTicket().requestId });
  const facts = {
    rpcSeen: false, userAfter: false, openTurn: false, inboxPending: 0, agentStatus: 'idle',
    lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  assert.equal(reconcileFence(ticket, facts, { now: NOW + 1_000, fenceGraceMs: 120_000 }).action, 'hold');
  assert.equal(reconcileFence(ticket, facts, { now: NOW + 200_000, fenceGraceMs: 120_000 }).action, 'attention');
  assert.equal(reconcileFence(ticket, { ...facts, rpcSeen: true }, { now: NOW + 1_000, fenceGraceMs: 120_000 }).action, 'delivered');
});

test('per-session opt-in does not carry to a later human task root', () => {
  const ticket = baseTicket({ rootMessageId: 'root-a' });
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    rootMessageId: 'root-b', goal: null, lastEnd: { turn: 3, kind: 'error', seq: 10 },
  };
  assert.equal(decideTicket(ticket, facts, LIMITS).reason, 'optin_task_changed');
});

test('ticket ids and request ids are stable, validated and attempt-specific', () => {
  const requestId = continueRequestId('s-1', 3, 0);
  assert.match(requestId, /^qqc-[0-9a-f]{40}$/);
  assert.equal(continueRequestId('s-1', 3, 0), requestId);
  assert.notEqual(continueRequestId('s-1', 3, 1), requestId);
  const ticket = baseTicket();
  assert.deepEqual(validateTicket(ticket), []);
  assert.equal(ticket.id, baseTicket().id);
  const next = nextAttempt(ticket, {
    now: NOW, turn: 7, endSeq: 70,
    decision: { action: 'ticket', failureClass: 'network', code: 'TRANSPORT', retryAfterMs: null },
  });
  assert.equal(next.turn, 7);
  assert.equal(next.attempt, 1);
  assert.notEqual(next.requestId, ticket.requestId);
  assert.deepEqual(validateTicket({ ...ticket, state: 'nope' }), ['state']);
});

test('backoff ladders are deterministic and respect the provider floor', () => {
  assert.equal(backoffDelay('network', 0), 15_000);
  assert.equal(backoffDelay('network', 99), 300_000);
  assert.equal(backoffDelay('quota', 0), 300_000);
  assert.equal(backoffDelay('rate_limit', 0, 400_000), 400_000);
  assert.equal(backoffDelay('network', 0, 5_000), 15_000);
});

test('ticket summary never exposes prompt or raw error text', () => {
  const summary = ticketSummary(baseTicket());
  assert.deepEqual(Object.keys(summary).sort(), [
    'attempt', 'code', 'deliveredTurn', 'failureClass', 'nextAt', 'reason', 'sessionId', 'state', 'status', 'turn',
  ]);
});
test('a chain is bounded only by attempts: no age, no expiry field', () => {
  const decision = { action: 'ticket', failureClass: 'quota', code: 'QUOTA', status: null, retryAfterMs: null };
  const first = createTicket({ sessionId: 's-1', turn: 1, endSeq: 1, decision, now: NOW });
  assert.equal(Object.hasOwn(first, 'expiresAt'), false);
  assert.equal(Object.hasOwn(first, 'episodeStartAt'), false);
  // A failure more than 96h later still continues the chain and is never aged out.
  const later = NOW + 100 * 3_600_000;
  const second = nextAttempt(first, { now: later, turn: 2, endSeq: 20, decision });
  assert.equal(second.attempt, 1);
  assert.equal(Object.hasOwn(second, 'expiresAt'), false);
  const facts = {
    optIn: true, paused: false, owner: true, agentStatus: 'idle', inboxPending: 0,
    userAfter: false, openTurn: false, pendingStep: false, toolOutcomeUnknown: false,
    goal: null, lastEnd: { turn: 2, kind: 'error', seq: 20 },
  };
  const yearsLater = later + 365 * 24 * 3_600_000;
  assert.equal(decideTicket(second, facts, { now: yearsLater, maxAttempts: 200 }).action, 'send',
    'age is never a reason to stop');
  assert.equal(decideTicket(second, facts, { now: yearsLater, maxAttempts: 1 }).reason, 'max_attempts',
    'the attempt budget is the only stop');
});
