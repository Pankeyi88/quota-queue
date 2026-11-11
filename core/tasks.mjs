/**
 * quota-queue/core — task shape, status vocabulary and validation.
 *
 * The task record is plugin-internal (it is not a Harness type). Every field is
 * JSON-persistable; absent values are stored as `null` (never `undefined`) so a
 * snapshot round-trips through JSON unchanged.
 */
import { InputValidationError } from './errors.mjs';
import {
  isNonEmptyString,
  isPlainObject,
  isFiniteNumber,
  isInteger,
  toEpochMs,
  isValidIsoInstant,
  findNonJsonValue,
} from './util.mjs';

/** Persisted snapshot schema version owned by this module. */
export const SCHEMA_VERSION = 1;

/** Every legal task status. */
export const TASK_STATUSES = Object.freeze([
  'draft',
  'queued',
  'waiting_quota',
  'ready',
  'running',
  'paused',
  'needs_attention',
  'completed',
  'failed',
  'cancelled',
]);

/** Statuses from which no automatic work will ever happen again. */
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/** Statuses eligible for scheduler consideration. */
export const DISPATCHABLE_STATUSES = Object.freeze(['queued', 'ready', 'waiting_quota']);

/** Statuses whose payload may still be edited by the user. */
export const EDITABLE_STATUSES = Object.freeze([
  'draft',
  'queued',
  'paused',
  'waiting_quota',
  'ready',
  'needs_attention',
]);

/** Statuses that may be cancelled outright. */
export const CANCELLABLE_STATUSES = Object.freeze([
  'draft',
  'queued',
  'paused',
  'waiting_quota',
  'ready',
  'needs_attention',
]);

/** The two task kinds. */
export const TASK_KINDS = Object.freeze(['new-session', 'resume-session']);

/** Turn-end reason that alone counts as success. */
export const TURN_END_SUCCESS = 'completed';

/**
 * Turn-end reasons this core knows how to classify. Anything outside this list
 * is treated as `needs_attention` rather than silently accepted.
 */
export const ACCEPTED_TURN_END_REASONS = Object.freeze([
  'completed',
  'error',
  'aborted',
  'canceled',
  'cancelled',
  'blocked',
  'max-tokens',
  'interrupted',
  'forked',
  'discarded',
]);

/**
 * Signals that are explicitly NOT completion evidence (see acceptance B04).
 * Passing any of these to `observeTurnEnd` is a hard error.
 */
export const REJECTED_SETTLE_REASONS = Object.freeze([
  'idle',
  'whenidle',
  'when_idle',
  'receipt',
  'accepted',
  'delivered',
  'delivery',
  'schedule',
  'scheduled',
  'session/disposed',
  'disposed',
  'dispose',
  'prompt/accepted',
]);

/** Failure classes returned by classifyFailure. */
export const FAILURE_CLASSES = Object.freeze([
  'quota',
  'rate_limit',
  'auth_required',
  'transient',
  'request_error',
  'configuration',
  'user_cancelled',
  'unknown',
]);

/** Quota scope granularity tags. */
export const LIMIT_TYPES = Object.freeze(['global', 'model', 'window', 'account']);

/** Who initiated an action. Only `user` may open per-session authorization. */
export const ACTORS = Object.freeze(['user', 'model', 'tool', 'system']);

/** Every key a task record may carry. Unknown keys are rejected on load. */
export const TASK_KEYS = Object.freeze([
  'id',
  'kind',
  'title',
  'prompt',
  'attachmentRefs',
  'workspaceId',
  'workspacePathSnapshot',
  'provider',
  'model',
  'credentialRef',
  'quotaScopeKey',
  'sessionId',
  'failedStepId',
  'generation',
  'dispatchedMessageId',
  'claimedTurnId',
  'sessionRevision',
  'dedupeKey',
  'status',
  'priority',
  'createdAt',
  'updatedAt',
  'dispatchedAt',
  'completedAt',
  'cancelledAt',
  'nextCheckAt',
  'attempts',
  'leaseOwner',
  'leaseUntil',
  'stopRequested',
  'requestedStopAt',
  'pendingQuotaWait',
  'dispatchUncertain',
  'executionFence',
  'fenceReason',
  'fenceSince',
  'autoResume',
  'lastFailure',
  'needsAttentionReason',
  'resolution',
]);

const TASK_KEY_SET = new Set(TASK_KEYS);

/** Field names that must never appear on a task record. */
export const FORBIDDEN_TASK_FIELDS = Object.freeze([
  'body',
  'header',
  'headers',
  'url',
  'target',
  'raw',
  'rawBody',
  'message',
  'authorization',
  'token',
  'apiKey',
  'apikey',
  'secret',
]);

const LAST_FAILURE_KEYS = Object.freeze(['class', 'code', 'status', 'safeSummary', 'observedAt']);

/** Deterministic backoff ladder used when no trusted reset time exists. */
export const BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 900_000]);

/** Backoff for the given 1-based attempt count, capped at the last rung. */
export function backoffDelayMs(attempts) {
  const n = Number.isFinite(attempts) ? Math.floor(attempts) : 0;
  const index = Math.min(Math.max(n, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

/**
 * Scope key that a quota restriction applies to. It deliberately avoids a
 * bare model name as a global lock: provider route, model, credential
 * reference and limit type all participate.
 */
export function quotaScopeKey({ provider, model, credentialRef = null, limitType = 'global' } = {}) {
  if (!isNonEmptyString(provider)) throw new InputValidationError('provider must be a non-empty string', ['provider']);
  if (!isNonEmptyString(model)) throw new InputValidationError('model must be a non-empty string', ['model']);
  if (!LIMIT_TYPES.includes(limitType)) {
    throw new InputValidationError(`limitType must be one of ${LIMIT_TYPES.join(', ')}`, ['limitType']);
  }
  // JSON tuple encoding: length-prefixed structure, so values containing any
  // separator (or each other) can never produce the same key.
  return `qs:${JSON.stringify([
    provider.trim(),
    model.trim(),
    isNonEmptyString(credentialRef) ? credentialRef.trim() : 'default',
    limitType,
  ])}`;
}

/** Dedupe key for an auto-captured resume task (A07). */
export function resumeDedupeKey({ sessionId, failedStepId, generation }) {
  for (const [field, value] of [['sessionId', sessionId], ['failedStepId', failedStepId], ['generation', generation]]) {
    // All three are part of the failure identity. No defaulting and no numeric
    // coercion: a host that tracks a numeric generation must convert it to a
    // string explicitly, so the core never fabricates a key.
    if (!isNonEmptyString(value)) {
      throw new InputValidationError(
        `${field} must be a non-empty string supplied by the host (numeric generations must be converted explicitly)`,
        [field],
      );
    }
  }
  return `resume:${JSON.stringify([sessionId, failedStepId, generation])}`;
}

function nullableString(value) {
  return isNonEmptyString(value) ? value : null;
}

function requireField(fields, name) {
  const value = fields[name];
  if (name === 'prompt') {
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new InputValidationError('prompt must be a string or null', ['prompt']);
    }
    return value ?? null;
  }
  return value;
}

/**
 * Build a fully-populated task record. Validation is strict: a task that cannot
 * be scheduled or reconciled safely is rejected at creation time.
 *
 * @param {object} fields
 * @returns {object} task record (plain, JSON-persistable)
 */
export function createTask(fields) {
  if (!isPlainObject(fields)) throw new InputValidationError('task fields must be a plain object', ['fields']);
  const kind = fields.kind;
  if (!TASK_KINDS.includes(kind)) {
    throw new InputValidationError(`kind must be one of ${TASK_KINDS.join(', ')}`, ['kind']);
  }
  const status = fields.status ?? 'queued';
  if (!TASK_STATUSES.includes(status)) {
    throw new InputValidationError(`status must be one of ${TASK_STATUSES.join(', ')}`, ['status']);
  }
  for (const name of ['id', 'workspaceId', 'provider', 'model', 'quotaScopeKey', 'dedupeKey', 'createdAt']) {
    if (!isNonEmptyString(fields[name])) {
      throw new InputValidationError(`${name} must be a non-empty string`, [name]);
    }
  }

  const prompt = requireField(fields, 'prompt');
  const sessionId = nullableString(fields.sessionId);
  if (kind === 'resume-session') {
    if (!sessionId) throw new InputValidationError('resume-session tasks require sessionId', ['sessionId']);
    for (const name of ['failedStepId', 'generation']) {
      if (!isNonEmptyString(fields[name])) {
        throw new InputValidationError(`resume-session tasks require ${name}`, [name]);
      }
    }
    if (prompt !== null) {
      // The resume task must never carry the original prompt: recovery delivers a
      // minimal continue message instead of replaying the whole task.
      throw new InputValidationError('resume-session tasks must not store a prompt', ['prompt']);
    }
  }
  if (kind === 'new-session') {
    if (!sessionId) {
      // The stable session id must exist before the host create call so a crash
      // can never produce a second session (B07).
      throw new InputValidationError('new-session tasks require a pre-generated sessionId', ['sessionId']);
    }
    if (!isNonEmptyString(prompt)) {
      throw new InputValidationError('new-session tasks require a non-empty prompt', ['prompt']);
    }
  }

  const priority = fields.priority ?? 0;
  if (!isFiniteNumber(priority)) throw new InputValidationError('priority must be a finite number', ['priority']);

  const attachmentRefs = Array.isArray(fields.attachmentRefs) ? fields.attachmentRefs : [];
  for (const ref of attachmentRefs) {
    if (!isNonEmptyString(ref)) throw new InputValidationError('attachmentRefs entries must be non-empty strings', ['attachmentRefs']);
  }
  return {
    id: fields.id,
    kind,
    title: typeof fields.title === 'string' && fields.title.length > 0 ? fields.title : deriveTitle(kind, prompt, sessionId),
    prompt,
    attachmentRefs: [...attachmentRefs],
    workspaceId: fields.workspaceId,
    workspacePathSnapshot: nullableString(fields.workspacePathSnapshot),
    provider: fields.provider,
    model: fields.model,
    credentialRef: nullableString(fields.credentialRef),
    quotaScopeKey: fields.quotaScopeKey,
    sessionId,
    failedStepId: nullableString(fields.failedStepId),
    generation: nullableString(fields.generation),
    dispatchedMessageId: nullableString(fields.dispatchedMessageId),
    claimedTurnId: nullableString(fields.claimedTurnId),
    sessionRevision: nullableString(fields.sessionRevision),
    dedupeKey: fields.dedupeKey,
    status,
    priority,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt ?? fields.createdAt,
    dispatchedAt: nullableString(fields.dispatchedAt),
    completedAt: nullableString(fields.completedAt),
    cancelledAt: nullableString(fields.cancelledAt),
    nextCheckAt: nullableString(fields.nextCheckAt),
    attempts: isInteger(fields.attempts) && fields.attempts >= 0 ? fields.attempts : 0,
    leaseOwner: nullableString(fields.leaseOwner),
    leaseUntil: nullableString(fields.leaseUntil),
    stopRequested: fields.stopRequested === true,
    requestedStopAt: nullableString(fields.requestedStopAt),
    pendingQuotaWait: fields.pendingQuotaWait === true,
    dispatchUncertain: fields.dispatchUncertain === true,
    // An execution fence means "the host may still be running this task". It
    // outlives any status change, blocks the queue until positive stop evidence
    // arrives, and is never cleared by lease expiry.
    executionFence: fields.executionFence === true,
    fenceReason: nullableString(fields.fenceReason),
    fenceSince: nullableString(fields.fenceSince),
    autoResume: fields.autoResume === true,
    lastFailure: normalizeLastFailure(fields.lastFailure),
    needsAttentionReason: nullableString(fields.needsAttentionReason),
    resolution: nullableString(fields.resolution),
  };
}

/** Default human-facing title when the caller omits one. */
export function deriveTitle(kind, prompt, sessionId) {
  if (kind === 'new-session' && typeof prompt === 'string') {
    const firstLine = prompt.split(/\r?\n/, 1)[0].trim();
    if (firstLine.length > 0) return firstLine.slice(0, 120);
  }
  return kind === 'resume-session' ? `Continue session ${sessionId}` : 'Untitled task';
}

/** Normalize a stored lastFailure, dropping any unexpected (possibly raw) fields. */
export function normalizeLastFailure(value) {
  if (!isPlainObject(value)) return null;
  const out = {
    class: FAILURE_CLASSES.includes(value.class) ? value.class : 'unknown',
    code: isNonEmptyString(value.code) ? value.code : null,
    status: isInteger(value.status) ? value.status : null,
    safeSummary: typeof value.safeSummary === 'string' ? value.safeSummary.slice(0, 200) : 'failure recorded',
    observedAt: isNonEmptyString(value.observedAt) ? value.observedAt : null,
  };
  return out;
}

/**
 * Strict validation of a persisted task record.
 * @returns {string[]} issue strings (empty array means valid)
 */
export function validateTask(task, path = 'task') {
  if (!isPlainObject(task)) return [path];
  const issues = [];
  const req = (name, test) => {
    if (!test(task[name])) issues.push(`${path}.${name}`);
  };
  for (const key of Object.keys(task)) {
    if (!TASK_KEY_SET.has(key)) issues.push(`${path}.unknownField:${key}`);
  }
  for (const key of FORBIDDEN_TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(task, key)) issues.push(`${path}.forbidden:${key}`);
  }
  issues.push(...findNonJsonValue(task, path));
  req('id', isNonEmptyString);
  req('kind', (v) => TASK_KINDS.includes(v));
  req('status', (v) => TASK_STATUSES.includes(v));
  req('workspaceId', isNonEmptyString);
  req('provider', isNonEmptyString);
  req('model', isNonEmptyString);
  req('quotaScopeKey', isNonEmptyString);
  req('dedupeKey', isNonEmptyString);
  req('createdAt', (v) => toEpochMs(v) !== undefined && isValidIsoInstant(v));
  req('updatedAt', (v) => toEpochMs(v) !== undefined && isValidIsoInstant(v));
  req('attempts', (v) => isInteger(v) && v >= 0);
  req('priority', isFiniteNumber);
  if (typeof task.title !== 'string') issues.push(`${path}.title`);
  if (!(task.prompt === null || typeof task.prompt === 'string')) issues.push(`${path}.prompt`);
  if (task.kind === 'resume-session') {
    if (task.prompt !== null) issues.push(`${path}.prompt`);
    // Resume identity is fail-closed: without all three, dedupe and recovery
    // cannot be proven and the record must not be loaded.
    for (const name of ['sessionId', 'failedStepId', 'generation']) {
      if (!isNonEmptyString(task[name])) issues.push(`${path}.resumeIdentity:${name}`);
    }
  }
  if (task.kind === 'new-session' && (!isNonEmptyString(task.sessionId) || !isNonEmptyString(task.prompt))) {
    issues.push(`${path}.newSessionBinding`);
  }
  if (task.status === 'running' && !isNonEmptyString(task.dispatchedMessageId)) {
    // A running task must be bound to a persisted messageId, otherwise its turn
    // can never be correlated and settled.
    issues.push(`${path}.runningWithoutMessage`);
  }
  for (const name of [
    'workspacePathSnapshot',
    'credentialRef',
    'failedStepId',
    'generation',
    'dispatchedMessageId',
    'claimedTurnId',
    'sessionRevision',
    'dispatchedAt',
    'completedAt',
    'cancelledAt',
    'nextCheckAt',
    'leaseOwner',
    'leaseUntil',
    'requestedStopAt',
    'needsAttentionReason',
    'resolution',
    'fenceReason',
    'fenceSince',
  ]) {
    if (!(task[name] === null || isNonEmptyString(task[name]))) issues.push(`${path}.${name}`);
  }
  for (const name of ['stopRequested', 'pendingQuotaWait', 'dispatchUncertain', 'executionFence', 'autoResume']) {
    if (typeof task[name] !== 'boolean') issues.push(`${path}.${name}`);
  }
  if (task.executionFence === true) {
    // A fence without a bound delivery cannot be reconciled, and a fence
    // without a reason cannot be explained to the operator.
    if (!isNonEmptyString(task.dispatchedMessageId)) issues.push(`${path}.fenceWithoutMessage`);
    if (!isNonEmptyString(task.fenceReason)) issues.push(`${path}.fenceWithoutReason`);
  }
  for (const name of ['dispatchedAt', 'completedAt', 'cancelledAt', 'nextCheckAt', 'leaseUntil', 'requestedStopAt']) {
    if (task[name] !== null && !isValidIsoInstant(task[name])) issues.push(`${path}.${name}`);
  }
  if (task.lastFailure !== null) {
    if (!isPlainObject(task.lastFailure)) {
      issues.push(`${path}.lastFailure`);
    } else {
      for (const key of Object.keys(task.lastFailure)) {
        if (!LAST_FAILURE_KEYS.includes(key)) issues.push(`${path}.lastFailure.${key}`);
      }
      if (!FAILURE_CLASSES.includes(task.lastFailure.class)) issues.push(`${path}.lastFailure.class`);
      if (task.lastFailure.code !== null && !isNonEmptyString(task.lastFailure.code)) issues.push(`${path}.lastFailure.code`);
      if (task.lastFailure.status !== null && !isInteger(task.lastFailure.status)) issues.push(`${path}.lastFailure.status`);
    }
  }
  if (!Array.isArray(task.attachmentRefs)) {
    issues.push(`${path}.attachmentRefs`);
  } else {
    for (const [index, ref] of task.attachmentRefs.entries()) {
      if (!isNonEmptyString(ref)) issues.push(`${path}.attachmentRefs[${index}]`);
    }
  }
  if (task.claimedTurnId !== null && task.dispatchedMessageId === null) {
    // A claim can only exist for a message we actually persisted before sending.
    issues.push(`${path}.claimedWithoutMessage`);
  }
  return issues;
}
