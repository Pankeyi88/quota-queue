/**
 * quota-queue/core — durable session-continuation policy (PURE).
 *
 * The question this module answers: after a turn has durably ended with an
 * error, is there a defensible reason to continue that session later — and if
 * so, when, how often, and under which fresh facts?
 *
 * It performs no I/O, starts no timer, reads no credential and never sends a
 * message. The Host driver supplies observations; every decision is a value.
 *
 * ## The stop matrix (deliberately strict)
 *
 * A continuation ticket exists ONLY for an explicit, allowlisted failure:
 *
 *   QUOTA / ACCOUNT_QUOTA            -> quota       (wait out the window)
 *   TRANSPORT / TIMEOUT / SERVER /   -> network     (backoff)
 *   CONNECTION_RESET / EMPTY_RESPONSE / OVERLOADED
 *   RATE_LIMIT, bare HTTP 429        -> rate_limit  (backoff, honours Retry-After)
 *   HTTP 408 / 5xx with no code      -> network     (backoff)
 *
 * Everything else STOPS: authentication/permission (a human must fix it),
 * user cancellation (the user's stop is not a retry request), request-level
 * errors, configuration errors, an unrecognized code, an unreadable error —
 * and any failure whose turn may have left a tool outcome unknown.
 *
 * ## Why the request id is derived, not random
 *
 * The Host prompt endpoint records a user-rpc source and refuses to insert a
 * second message whose `rpcId` is already in its in-memory inbox or durable
 * log. Deriving the id from durable ticket identity (session + failed turn +
 * attempt) means a crash-recovered driver reuses the SAME id for the SAME
 * attempt, so the Host's own dedupe is the idempotency anchor. The id alone is
 * never treated as proof of delivery: an accepted message must be read back
 * from the session log before the fence is cleared.
 */
import { createHash } from 'node:crypto';
import {
  classifyFailure,
  QUOTA_CODES,
  TRANSIENT_CODES,
  RATE_LIMIT_CODES,
  AUTH_CODES,
  USER_CANCEL_CODES,
} from './failure.mjs';
import { isPlainObject } from './util.mjs';

/** Snapshot version of the continuation store. */
export const CONTINUE_STORE_VERSION = 1;

/** The one text this driver ever sends. It is not model output. */
export const CONTINUE_TEXT = '继续';

/** Prefix of every derived request id. */
export const REQUEST_ID_PREFIX = 'qqc-';

/** Ticket lifecycle. `claimed` and `unknown` are fences, not free retries. */
export const CONTINUE_STATES = Object.freeze([
  'waiting',
  'claimed',
  'delivered',
  'unknown',
  'done',
  'cancelled',
  'needs_attention',
]);

/** Recoverable classes only. */
export const CONTINUE_CLASSES = Object.freeze(['network', 'rate_limit', 'quota']);

/** Waiting ladders in milliseconds, indexed by completed attempt count. */
export const ATTEMPT_LADDERS = Object.freeze({
  network: Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]),
  rate_limit: Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000]),
  quota: Object.freeze([300_000, 900_000, 1_800_000, 3_600_000, 7_200_000]),
});

/**
 * Upper bound for a provider-supplied Retry-After.
 *
 * There is no ticket age cap any more, so this ceiling is the only guard: a
 * provider-supplied delay is honoured exactly as stated, up to 30 days. The
 * attempt count still bounds how many continuations a chain may send.
 */
export const RETRY_AFTER_CEILING_MS = 30 * 24 * 3_600_000;

/** Reason codes a ticket/attempt can end on. Safe to display. */
export const CONTINUE_REASONS = Object.freeze([
  'scheduled',
  'backoff',
  'ready',
  'agent_busy',
  'owner_passive',
  'paused',
  'turn_not_settled',
  'turn_outcome_unknown',
  'tool_outcome_unknown',
  'new_user_instruction',
  'user_stopped',
  'session_opt_out',
  'goal_paused',
  'goal_blocked',
  'goal_complete',
  'goal_budget_exhausted',
  'goal_resumed',
  'delivered',
  'delivery_unknown',
  'delivery_unconfirmed',
  'max_attempts',
  'optin_task_changed',
  'identity_unverified',
  'inspection_unavailable',
  'authentication_required',
  'user_cancelled',
  'evidence_conflict',
  'not_recoverable',
  'unclassified_failure',
  'error_missing',
  'classification_failed',
  'turn_mismatch',
  'reconciled',
  // Quota gate: the task settled, but the account cannot pay for a turn yet.
  'quota_waiting',
  'quota_unknown',
  'quota_auth_required',
]);

const QUOTA_STATES = new Set(['available', 'exhausted', 'rate_limited', 'auth_required', 'unknown']);

const AUTH_SET = new Set(AUTH_CODES);
const USER_CANCEL_SET = new Set(USER_CANCEL_CODES);
const QUOTA_SET = new Set(QUOTA_CODES);
const TRANSIENT_SET = new Set(TRANSIENT_CODES);
const RATE_LIMIT_SET = new Set(RATE_LIMIT_CODES);
const KNOWN = new Set([...QUOTA_CODES, ...TRANSIENT_CODES, ...RATE_LIMIT_CODES, ...AUTH_CODES, ...USER_CANCEL_CODES]);
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A code is echoed only when it is both allowlisted and shape-safe. */
function echoCode(code) {
  return typeof code === 'string' && SAFE_CODE_RE.test(code) && KNOWN.has(code) ? code : null;
}

/** Stable short hash for ids that must survive a restart. */
export function stableId(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part)).join('\u0000')).digest('hex').slice(0, 40);
}

/**
 * The Host-side idempotency anchor for one attempt.
 * Same (session, failed turn, attempt) always yields the same id.
 */
export function continueRequestId(sessionId, turn, attempt) {
  return REQUEST_ID_PREFIX + stableId('continue', sessionId, turn, attempt);
}

/**
 * Read a provider-supplied retry delay.
 *
 * The Host's LlmFailure carries `providerRetryAfterMs`; older/other shapes use
 * `retryAfterMs` or a whole-second `retryAfter`. Only numbers are accepted —
 * prose is never parsed. The value is NEVER shortened: a delay beyond the
 * ceiling returns the ceiling, and `decideTicket` escalates instead of
 * retrying before the provider's stated instant.
 */
export function retryAfterOf(error) {
  if (!isPlainObject(error)) return null;
  const candidates = [error.providerRetryAfterMs, error.retryAfterMs];
  for (const ms of candidates) {
    if (Number.isSafeInteger(ms) && ms >= 0) return Math.min(ms, RETRY_AFTER_CEILING_MS);
  }
  const seconds = error.retryAfter;
  if (Number.isSafeInteger(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CEILING_MS);
  return null;
}

/**
 * Classify one durably recorded turn error.
 *
 * @param {unknown} error the durable `turn/end` reason.error value
 * @returns {{
 *   action: 'ticket'|'stop', failureClass?: string, code?: string|null,
 *   status?: number|null, retryAfterMs?: number|null, reason: string
 * }}
 */
export function decideError(error) {
  if (!isPlainObject(error)) return { action: 'stop', reason: 'error_missing' };
  const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const rawCode = typeof error.code === 'string' ? error.code : null;
  const code = rawCode === null ? null : echoCode(rawCode);
  const retryAfterMs = retryAfterOf(error);

  // Code/status consistency is checked for EVERY class before routing. An
  // identity/permission status must never be turned into an automatic retry by
  // a transient-looking code (and vice versa).
  if (status === 401 || status === 403) {
    return { action: 'stop', reason: 'authentication_required', code, status };
  }
  if (status !== null && status >= 400 && status < 500 && status !== 402 && status !== 408 && status !== 429) {
    return { action: 'stop', reason: 'not_recoverable', code, status };
  }

  if (rawCode !== null) {
    // An unrecognized code is not evidence of a transient failure: stop.
    if (code === null) return { action: 'stop', reason: 'unclassified_failure', code: null, status };
    if (USER_CANCEL_SET.has(code)) return { action: 'stop', reason: 'user_cancelled', code, status };
    if (AUTH_SET.has(code)) return { action: 'stop', reason: 'authentication_required', code, status };
    if (QUOTA_SET.has(code)) {
      // A quota code contradicted by 401/403 or another non-success status is
      // not a quota condition (classifyFailure owns that conflict rule).
      let classified;
      try { classified = classifyFailure({ code, status: status ?? undefined }); } catch { return { action: 'stop', reason: 'classification_failed' }; }
      if (classified.class !== 'quota' || classified.createsQuotaTicket !== true) {
        return { action: 'stop', reason: classified.class === 'auth_required' ? 'authentication_required' : 'unclassified_failure', code, status };
      }
      return { action: 'ticket', failureClass: 'quota', code, status, retryAfterMs, reason: 'ready' };
    }
    if (TRANSIENT_SET.has(code)) {
      // A transport code paired with a throttle status is contradictory
      // evidence: neither class may be trusted, so neither is retried.
      if (status === 429) return { action: 'stop', reason: 'evidence_conflict', code, status };
      return { action: 'ticket', failureClass: 'network', code, status, retryAfterMs, reason: 'ready' };
    }
    if (RATE_LIMIT_SET.has(code)) {
      if (status !== null && status >= 500) return { action: 'stop', reason: 'evidence_conflict', code, status };
      return { action: 'ticket', failureClass: 'rate_limit', code, status, retryAfterMs, reason: 'ready' };
    }
    // Every other allowlisted code (request-level, configuration, unknown
    // class) stops. This is the UNKNOWN half of the stop matrix.
    return { action: 'stop', reason: 'not_recoverable', code, status };
  }

  if (status === 429) return { action: 'ticket', failureClass: 'rate_limit', code: null, status, retryAfterMs, reason: 'ready' };
  if (status === 408 || (status !== null && status >= 500)) {
    return { action: 'ticket', failureClass: 'network', code: null, status, retryAfterMs, reason: 'ready' };
  }
  return { action: 'stop', reason: status === 401 || status === 403 ? 'authentication_required' : 'not_recoverable', code: null, status };
}

/** Delay before the next attempt of one class. Retry-After only raises it. */
export function backoffDelay(failureClass, attempt, retryAfterMs = null) {
  const ladder = ATTEMPT_LADDERS[failureClass] ?? ATTEMPT_LADDERS.network;
  const index = Math.max(0, Math.min(ladder.length - 1, Number.isSafeInteger(attempt) ? attempt : 0));
  const base = ladder[index];
  const floor = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, RETRY_AFTER_CEILING_MS) : 0;
  return Math.max(base, floor);
}

/**
 * Build the first ticket for a durable failed turn.
 * Callers MUST persist the returned value before any delivery attempt.
 */
export function createTicket({
  sessionId, turn, endSeq, decision, attempt = 0, goalId = null, rootMessageId = null,
  rpcIds = [], now, delayMs = null,
}) {
  if (decision?.action !== 'ticket') throw new TypeError('createTicket requires a ticket decision');
  if (attempt < 0 || !Number.isSafeInteger(attempt)) throw new TypeError('attempt must be a non-negative integer');
  const failureClass = decision.failureClass;
  return Object.freeze({
    id: stableId('ticket', sessionId, turn, attempt),
    sessionId,
    turn,
    endSeq,
    failureClass,
    code: decision.code ?? null,
    status: decision.status ?? null,
    attempt,
    state: 'waiting',
    requestId: continueRequestId(sessionId, turn, attempt),
    goalId: goalId === undefined ? null : goalId,
    // The human task root this continuation belongs to. An opt-in for one task
    // is NOT inherited by a later task in the same session.
    rootMessageId: rootMessageId === undefined ? null : rootMessageId,
    createdAt: now,
    updatedAt: now,
    nextAt: now + (Number.isSafeInteger(delayMs) && delayMs >= 0
      ? delayMs
      : backoffDelay(failureClass, attempt, decision.retryAfterMs ?? null)),
    // Every earlier rpc id of the same failure chain is inherited so the driver
    // recognises its own earlier messages as NOT human roots on later attempts.
    // There is NO age/expiry field: retries are bounded only by `attempt`.
    rpcIds: Object.freeze(Array.isArray(rpcIds) ? [...rpcIds] : []),
    deliveredTurn: null,
    lastReason: 'scheduled',
  });
}

/** Immutable ticket transition. Unknown target states are rejected loudly. */
export function transition(ticket, patch) {
  if (!CONTINUE_STATES.includes(patch.state)) throw new TypeError('unknown ticket state');
  return Object.freeze({ ...ticket, ...patch, updatedAt: patch.updatedAt ?? ticket.updatedAt });
}

/** Record the durable claim before a send. */
export function markClaimed(ticket, { now, requestId }) {
  if (ticket.state !== 'waiting' && ticket.state !== 'claimed') throw new TypeError('claim requires waiting/claimed');
  const ids = ticket.rpcIds.includes(requestId) ? ticket.rpcIds : Object.freeze([...ticket.rpcIds, requestId]);
  return transition(ticket, { state: 'claimed', requestId, rpcIds: ids, claimedAt: now, updatedAt: now, lastReason: 'ready' });
}

/** Mark acceptance only when the acceptance is evidenced. */
export function markDelivered(ticket, { now, deliveredTurn = null, reason = 'delivered' }) {
  return transition(ticket, { state: 'delivered', deliveredTurn, updatedAt: now, lastReason: reason });
}

/** Ambiguous outcome: fenced. Never resent without positive reconciliation. */
export function markUnknown(ticket, { now, reason = 'delivery_unknown' }) {
  return transition(ticket, { state: 'unknown', unknownAt: now, updatedAt: now, lastReason: reason });
}

export function markCancelled(ticket, { now, reason }) {
  return transition(ticket, { state: 'cancelled', updatedAt: now, lastReason: reason });
}

export function markAttention(ticket, { now, reason }) {
  return transition(ticket, { state: 'needs_attention', updatedAt: now, lastReason: reason });
}

export function markDone(ticket, { now, reason = 'delivered' }) {
  return transition(ticket, { state: 'done', updatedAt: now, lastReason: reason });
}

/** A follow-up attempt after our own delivery failed again. */
export function nextAttempt(ticket, { now, turn, endSeq, decision }) {
  if (decision?.action !== 'ticket') throw new TypeError('nextAttempt requires a ticket decision');
  if (!Number.isSafeInteger(turn) || turn < 1) throw new TypeError('nextAttempt requires the exact failed turn');
  return createTicket({
    sessionId: ticket.sessionId,
    turn,
    endSeq,
    decision,
    attempt: ticket.attempt + 1,
    goalId: ticket.goalId,
    rootMessageId: ticket.rootMessageId,
    rpcIds: ticket.rpcIds,
    now,
  });
}

/**
 * The single decision point for a `waiting` ticket.
 *
 * @param {object} ticket
 * @param {object} facts fresh observation (see host/auto-continue.js)
 * @param {{now:number, maxAttempts:number}} limits
 */
export function decideTicket(ticket, facts, limits) {
  const { now, maxAttempts } = limits;
  if (facts === null || typeof facts !== 'object') return { action: 'hold', reason: 'turn_not_settled' };
  if (facts.optIn !== true) return { action: 'cancel', reason: 'session_opt_out' };
  // A per-session opt-in belongs to the task root it was granted for. Two
  // different things must not be conflated:
  //  - no positive identity evidence (null) is NOT a task change: hold;
  //  - a DIFFERENT verified root is a real change: cancel.
  if (ticket.rootMessageId !== null && facts.rootMessageId === null) {
    return { action: 'hold', reason: 'identity_unverified' };
  }
  if (ticket.rootMessageId !== null && typeof facts.rootMessageId === 'string'
    && facts.rootMessageId !== ticket.rootMessageId) {
    return { action: 'cancel', reason: 'optin_task_changed' };
  }
  if (facts.userAfter === true) return { action: 'cancel', reason: 'new_user_instruction' };
  if (facts.openTurn === true) return { action: 'attention', reason: 'turn_outcome_unknown' };
  // A recorded tool call without a recorded result (or an open step) means the
  // side effect of that turn is unknown. Never auto-continue from it.
  if (facts.pendingStep === true || facts.toolOutcomeUnknown === true) return { action: 'attention', reason: 'tool_outcome_unknown' };
  // Goal state is deliberately NOT consulted. A completed/blocked/paused Goal
  // used to veto the continuation entirely, which silently stranded a session
  // whose turn failed AFTER the Goal was marked complete. Continuing only asks
  // the session to keep working; the Host's own Goal driver still decides what
  // a Goal round may do.
  if (facts.owner !== true) return { action: 'hold', reason: 'owner_passive' };
  if (facts.paused === true) return { action: 'hold', reason: 'paused' };
  if (facts.agentStatus === 'running') return { action: 'hold', reason: 'agent_busy' };
  // Only a queued HUMAN instruction replaces the continuation. Synthetic
  // notices (subagent relays, settled notices, Goal/context injections) are
  // consumed by the next turn, so treating them as busy deadlocked a settled
  // failure against its own inbox. Hosts that do not report `inboxHuman` fall
  // back to the coarse count (older contract, stricter).
  const queuedHuman = Number.isSafeInteger(facts.inboxHuman)
    ? facts.inboxHuman
    : (Number.isSafeInteger(facts.inboxPending) ? facts.inboxPending : null);
  if (queuedHuman !== null && queuedHuman > 0) return { action: 'hold', reason: 'agent_busy' };
  const lastEnd = facts.lastEnd;
  if (lastEnd === null || lastEnd === undefined) return { action: 'wait', reason: 'turn_not_settled' };
  // No inference from turn NUMBERS. A newer turn is not evidence that this
  // ticket was delivered, nor that it failed: only the exact failed turn this
  // ticket was created from may authorize a send.
  if (lastEnd.turn !== ticket.turn) return { action: 'attention', reason: 'turn_mismatch' };
  if (lastEnd.kind !== 'error') {
    return { action: lastEnd.kind === 'completed' ? 'done' : 'cancel', reason: lastEnd.kind === 'aborted' ? 'user_stopped' : 'not_recoverable' };
  }
  // The attempt count is the ONLY bound on a failure chain: there is no age or
  // expiry. A chain ends when it reaches max_attempts, when the turn settles as
  // completed/aborted, or when a human instruction replaces it.
  if (ticket.attempt >= maxAttempts) return { action: 'attention', reason: 'max_attempts' };
  if (now < ticket.nextAt) return { action: 'wait', reason: 'backoff' };
  // Second gate, in the order the user asked for: the session must be proven
  // INTERRUPTED and settled (every check above) before the account is
  // consulted, and a turn is only spent when the Host's mandatory read-only
  // quota observation says the account can pay for it.
  //
  // A quota wait never increments the attempt count — nothing was sent — and a
  // missing observation is never read as "available".
  if (limits.quotaRequired === true) {
    const waitMs = Number.isSafeInteger(limits.quotaRetryMs) && limits.quotaRetryMs > 0 ? limits.quotaRetryMs : null;
    const quota = facts.quota;
    if (quota === null || typeof quota !== 'object' || !QUOTA_STATES.has(quota.state)) {
      return { action: 'wait', reason: 'quota_unknown', waitMs };
    }
    if (quota.state === 'auth_required') return { action: 'attention', reason: 'quota_auth_required' };
    if (quota.state !== 'available') {
      return { action: 'wait', reason: quota.state === 'exhausted' ? 'quota_waiting' : 'quota_unknown', waitMs };
    }
  }
  return { action: 'send', reason: 'ready' };
}

/**
 * Reconcile a fenced ticket (`claimed`/`unknown`) against the durable log.
 * A claimed attempt may be retried with the SAME request id only when no
 * acceptance evidence exists at all and nothing is running.
 */
export function reconcileFence(ticket, facts, { now, fenceGraceMs }) {
  if (facts === null || typeof facts !== 'object') return { action: 'hold', reason: 'reconciled' };
  // POSITIVE association only: our exact request id must appear on a durable
  // user message. A newer turn number, elapsed time, an empty inbox or an idle
  // agent are NOT proof that a delayed call will not still be admitted, so they
  // never clear a fence and never authorize a resend.
  if (facts.rpcSeen === true) return { action: 'delivered', reason: 'reconciled' };
  if (facts.userAfter === true) return { action: 'cancel', reason: 'new_user_instruction' };
  const since = Number.isSafeInteger(ticket.claimedAt) ? ticket.claimedAt : ticket.updatedAt;
  if (now - since < fenceGraceMs) return { action: 'hold', reason: 'reconciled' };
  return { action: 'attention', reason: 'delivery_unconfirmed' };
}

/** Structural validation for a persisted ticket. */
export function validateTicket(ticket) {
  const issues = [];
  if (!isPlainObject(ticket)) return ['ticket_not_object'];
  if (typeof ticket.id !== 'string' || ticket.id.length === 0 || ticket.id.length > 64) issues.push('id');
  if (typeof ticket.sessionId !== 'string' || ticket.sessionId.length === 0 || ticket.sessionId.length > 512) issues.push('sessionId');
  if (!Number.isSafeInteger(ticket.turn) || ticket.turn < 1) issues.push('turn');
  if (!Number.isSafeInteger(ticket.endSeq) || ticket.endSeq < 0) issues.push('endSeq');
  if (!CONTINUE_CLASSES.includes(ticket.failureClass)) issues.push('failureClass');
  if (!CONTINUE_STATES.includes(ticket.state)) issues.push('state');
  if (!Number.isSafeInteger(ticket.attempt) || ticket.attempt < 0) issues.push('attempt');
  if (typeof ticket.requestId !== 'string' || !/^qqc-[0-9a-f]{40}$/.test(ticket.requestId)) issues.push('requestId');
  if (!Array.isArray(ticket.rpcIds) || ticket.rpcIds.some((id) => typeof id !== 'string' || !/^qqc-[0-9a-f]{40}$/.test(id))) issues.push('rpcIds');
  if (ticket.rootMessageId !== null && (typeof ticket.rootMessageId !== 'string' || ticket.rootMessageId.length > 256)) issues.push('rootMessageId');
  for (const key of ['createdAt', 'updatedAt', 'nextAt']) {
    if (!Number.isSafeInteger(ticket[key]) || ticket[key] < 0) issues.push(key);
  }
  return issues;
}

/** Freeze the safe projection of one ticket (no prompts, no raw error text). */
export function ticketSummary(ticket) {
  return {
    sessionId: ticket.sessionId,
    turn: ticket.turn,
    state: ticket.state,
    failureClass: ticket.failureClass,
    code: ticket.code,
    status: ticket.status,
    attempt: ticket.attempt,
    nextAt: ticket.nextAt,
    deliveredTurn: ticket.deliveredTurn,
    reason: ticket.lastReason,
  };
}
