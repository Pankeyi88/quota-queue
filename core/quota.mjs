/**
 * quota-queue/core — two-layer proxy quota normalization.
 *
 * The observed query chain wraps an upstream call: the management HTTP response
 * carries `{ status_code, header, body }` where `body` is itself the upstream
 * JSON (as an object or a JSON string). Every layer must agree before any state
 * other than `unknown` is produced.
 *
 * Hard rules implemented here:
 *  - outer HTTP 200 + inner status_code 401 / token_revoked => auth_required;
 *    never a quota countdown (A01).
 *  - `credits.balance = 0` never means exhausted (A02).
 *  - a JSON-string body and an object body normalize identically; malformed,
 *    missing or contradictory fields yield `unknown` (A03).
 *  - `used_percent` is "used"; a missing value never reads as 100% remaining,
 *    and a rounded 100 alone never exhausts the scope (A04).
 *  - a bare 429 is a short-term limit/unknown, not quota evidence (A05).
 *  - several applicable windows can block at once and ALL must clear; reset
 *    times only schedule a re-check (A06).
 *  - unrecognized model-scoped restrictions are conservatively `unknown`.
 *  - the raw upstream body, headers and error prose are never returned.
 */
import { InputValidationError } from './errors.mjs';
import {
  isPlainObject,
  isNonEmptyString,
  isFiniteNumber,
  isInteger,
  normalizePercent,
  resolveNow,
  toIso,
  safeCode,
  isValidIsoInstant,
  MAX_DATE_MS,
  findNonJsonValue,
} from './util.mjs';

export { findNonJsonValue };

/** Normalized quota states. */
export const QUOTA_STATES = Object.freeze(['available', 'exhausted', 'rate_limited', 'auth_required', 'unknown']);

/** Where a snapshot came from. */
export const QUOTA_SOURCES = Object.freeze(['proxy-query', 'inference-error', 'probe', 'manual']);

/** Reset-time confidence. */
export const RESET_CONFIDENCE = Object.freeze(['confirmed', 'estimated']);

/** Stable reason vocabulary. Free text never enters a snapshot. */
export const QUOTA_REASON_CODES = Object.freeze([
  'outer_status_missing',
  'outer_http_ok',
  'outer_http_auth',
  'outer_http_429',
  'outer_http_unavailable',
  'outer_http_failed',
  'envelope_missing',
  'inner_status_missing',
  'inner_status_ok',
  'inner_status_auth',
  'inner_status_429',
  'inner_status_unavailable',
  'inner_status_402_ambiguous',
  'inner_status_failed',
  'inner_body_object',
  'inner_body_json_string',
  'inner_body_malformed',
  'inner_body_missing',
  'inner_error_auth',
  'inner_error_present',
  'rate_limit_malformed',
  'rate_limit_missing',
  'allowed_limit_reached_conflict',
  'rate_limit_flag_not_boolean',
  'window_malformed',
  'used_percent_invalid',
  'used_percent_saturated',
  'reset_time_conflict',
  'model_restriction_unverified',
  'model_restriction_unrecognized',
  'model_usage_model_absent',
  'no_explicit_allow_signal',
  'explicit_allow',
  'explicit_block',
  'blocking_windows',
  'credits_ignored_for_state',
  'spend_control_reached',
  'rate_limit_reached_type',
]);

/** Snapshots are short-lived evidence; callers must re-check before release. */
export const SNAPSHOT_TTL_MS = 60_000;

/** reset_at and reset_after_seconds may disagree slightly; beyond this it is a conflict. */
export const RESET_TOLERANCE_MS = 120_000;

/** Upstream error codes that mean "fix the credential", not "wait for quota". */
export const AUTH_ERROR_CODES = Object.freeze([
  'TOKEN_REVOKED',
  'INVALID_TOKEN',
  'EXPIRED_TOKEN',
  'UNAUTHORIZED',
  'AUTHENTICATION_REQUIRED',
  'AUTH',
]);

const AUTH_ERROR_SET = new Set(AUTH_ERROR_CODES);

/** Window-ish keys we can interpret without guessing a provider contract. */
const WINDOW_KEYS = Object.freeze(['used_percent', 'limit_reached', 'allowed', 'reset_at', 'reset_after_seconds', 'limit_window_seconds']);

const MODEL_SCOPED_FIELDS = Object.freeze(['model_usage', 'additional_rate_limits']);

/**
 * Normalize one two-layer quota query result.
 *
 * @param {object} input
 * @param {unknown} input.outerStatus outer management HTTP status
 * @param {unknown} input.envelope    `{ status_code, header?, body }`
 * @param {string}  input.scopeKey    quota scope this snapshot belongs to
 * @param {unknown} input.now         Date | epoch ms | ISO string
 * @param {boolean} [input.modelMappingVerified] verified route->model mapping evidence
 * @param {string}  [input.model]     model id, used only to match `model_usage` entries
 * @returns {object} normalized snapshot (plain, JSON-safe, no raw payload)
 */
export function normalizeQuota(input = {}) {
  if (!isPlainObject(input)) throw new InputValidationError('normalizeQuota expects a plain object', ['input']);
  const { outerStatus, envelope, scopeKey, now, modelMappingVerified = false, model } = input;
  if (!isNonEmptyString(scopeKey)) throw new InputValidationError('scopeKey must be a non-empty string', ['scopeKey']);
  const nowMs = resolveNow(now);
  const observedAt = toIso(nowMs);
  const reasons = [];
  const verified = modelMappingVerified === true;

  /** @type {object[]} */
  const blocking = [];
  /** @type {object[]} */
  const observed = [];
  let contradiction = null;
  let credits = null;
  let saturated = false;
  let allowed = null;
  let limitReached = null;

  const snapshot = (state, extra = {}) => ({
    scopeKey,
    state,
    source: 'proxy-query',
    observedAt,
    validUntil: toIso(nowMs + SNAPSHOT_TTL_MS),
    modelMappingVerified: verified,
    remaining: extra.remaining ?? null,
    unit: extra.unit ?? null,
    resetAt: extra.resetAt ?? null,
    resetConfidence: extra.resetConfidence ?? null,
    nextResetAt: extra.nextResetAt ?? null,
    blockingWindows: extra.blockingWindows ?? blocking,
    observedWindows: extra.observedWindows ?? observed,
    saturated: extra.saturated ?? saturated,
    credits: extra.credits ?? credits,
    errorClass: extra.errorClass ?? null,
    // Trusted `allowed`/`limit_reached` evidence decides. A saturated
    // (rounded-to-100) percentage is reported but never closes the gate on its
    // own, which is exactly what A04 requires.
    releaseRecommended: state === 'available',
    reasons: extra.reasons ?? [...reasons],
  });

  const outer = isInteger(outerStatus) && outerStatus >= 100 && outerStatus <= 599 ? outerStatus : null;
  if (outer === null) {
    reasons.push('outer_status_missing');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (outer === 401 || outer === 403) {
    reasons.push('outer_http_auth');
    return snapshot('auth_required', { errorClass: 'auth_required' });
  }
  if (outer === 429) {
    reasons.push('outer_http_429');
    return snapshot('rate_limited', { errorClass: 'rate_limited' });
  }
  if (outer === 408 || outer >= 500) {
    reasons.push('outer_http_unavailable');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (outer < 200 || outer >= 300) {
    reasons.push('outer_http_failed');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  reasons.push('outer_http_ok');

  if (!isPlainObject(envelope)) {
    reasons.push('envelope_missing');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  const inner = isInteger(envelope.status_code) ? envelope.status_code : null;
  if (inner === null) {
    reasons.push('inner_status_missing');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (inner === 401 || inner === 403) {
    reasons.push('inner_status_auth');
    return snapshot('auth_required', { errorClass: 'auth_required' });
  }
  if (inner === 429) {
    reasons.push('inner_status_429');
    return snapshot('rate_limited', { errorClass: 'rate_limited' });
  }
  if (inner === 408 || inner >= 500) {
    reasons.push('inner_status_unavailable');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (inner === 402) {
    // 402 cannot be interpreted without a verified proxy contract.
    reasons.push('inner_status_402_ambiguous');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (inner !== 200) {
    reasons.push('inner_status_failed');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  reasons.push('inner_status_ok');

  const bodyResult = parseInnerBody(envelope.body);
  if (!bodyResult.ok) {
    reasons.push(bodyResult.reason);
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  const body = bodyResult.body;
  reasons.push(bodyResult.coerced ? 'inner_body_json_string' : 'inner_body_object');

  const rawError = body.error;
  if (rawError !== undefined && rawError !== null) {
    const errorCode = isPlainObject(rawError) ? safeCode(rawError.code) : null;
    if (errorCode !== null && AUTH_ERROR_SET.has(errorCode)) {
      reasons.push('inner_error_auth');
      return snapshot('auth_required', { errorClass: 'auth_required' });
    }
    reasons.push('inner_error_present');
    return snapshot('unknown', { errorClass: 'unknown' });
  }

  const rateLimit = body.rate_limit;
  if (rateLimit !== undefined && !isPlainObject(rateLimit)) {
    reasons.push('rate_limit_malformed');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (isPlainObject(rateLimit)) {
    if (typeof rateLimit.allowed === 'boolean') allowed = rateLimit.allowed;
    else if (rateLimit.allowed !== undefined) contradiction = 'rate_limit_flag_not_boolean';
    if (typeof rateLimit.limit_reached === 'boolean') limitReached = rateLimit.limit_reached;
    else if (rateLimit.limit_reached !== undefined) contradiction = 'rate_limit_flag_not_boolean';
    if (allowed !== null && limitReached !== null && allowed === limitReached) {
      // (true,true) and (false,false) are both self-contradictory.
      contradiction = 'allowed_limit_reached_conflict';
    }
  }

  for (const id of ['primary_window', 'secondary_window']) {
    const raw = isPlainObject(rateLimit) ? rateLimit[id] : undefined;
    if (raw === undefined) continue;
    if (!isPlainObject(raw)) {
      reasons.push('window_malformed');
      return snapshot('unknown', { errorClass: 'unknown' });
    }
    const read = readWindow(raw, id, nowMs, reasons);
    if (read.ok === false) {
      reasons.push(read.issue);
      return snapshot('unknown', { errorClass: 'unknown' });
    }
    observed.push(read.window);
    if (read.window.blocked) blocking.push(toBlockingWindow(read.window));
    if (read.window.saturation) saturated = true;
  }

  // ---- model-scoped restrictions: unrecognized => conservative unknown ----
  const presentModelFields = MODEL_SCOPED_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null);
  if (presentModelFields.length > 0 && !verified) {
    reasons.push('model_restriction_unverified');
    return snapshot('unknown', { errorClass: 'unknown' });
  }
  if (presentModelFields.length > 0) {
    const modelResult = readModelScoped(body, { model, nowMs, reasons });
    if (!modelResult.ok) {
      reasons.push(modelResult.reason);
      return snapshot('unknown', { errorClass: 'unknown' });
    }
    for (const window of modelResult.windows) {
      observed.push(window);
      if (window.blocked) blocking.push(toBlockingWindow(window));
      if (window.saturation) saturated = true;
    }
  }

  // ---- explicit non-window signals ----
  // A whole-scope signal blocks too, and inherits the reset evidence of the
  // observed windows so the wait is not needlessly downgraded to "unknown".
  const globalReset = aggregateReset(observed, 'max');
  const reachedType = body.rate_limit_reached_type;
  if (reachedType !== undefined && reachedType !== null) {
    // The value is only evidence that SOMETHING was reached; it is never echoed
    // because its vocabulary is unverified and could carry identifying text.
    reasons.push('rate_limit_reached_type');
    blocking.push({
      id: 'rate_limit_reached_type',
      reason: 'reached_type_reported',
      usedPercent: null,
      resetAt: globalReset.iso,
      resetConfidence: globalReset.confidence,
      blocked: true,
    });
  }
  if (isPlainObject(body.spend_control) && body.spend_control.reached === true) {
    reasons.push('spend_control_reached');
    blocking.push({
      id: 'spend_control',
      reason: 'spend_control_reached',
      usedPercent: null,
      resetAt: globalReset.iso,
      resetConfidence: globalReset.confidence,
      blocked: true,
    });
  }

  if (isPlainObject(rateLimit) && (allowed === false || limitReached === true)) {
    reasons.push('explicit_block');
    blocking.push({
      id: 'rate_limit',
      reason: limitReached === true ? 'limit_reached_true' : 'allowed_false',
      usedPercent: null,
      resetAt: globalReset.iso,
      resetConfidence: globalReset.confidence,
      blocked: true,
    });
  }

  if (body.credits !== undefined && body.credits !== null) {
    if (!isPlainObject(body.credits)) {
      reasons.push('rate_limit_malformed');
      return snapshot('unknown', { errorClass: 'unknown' });
    }
    // Zero credits never exhausts the scope; the value is recorded, not acted on.
    credits = {
      hasCredits: typeof body.credits.has_credits === 'boolean' ? body.credits.has_credits : null,
      balance: isFiniteNumber(body.credits.balance) ? body.credits.balance : null,
      ignoredForState: true,
    };
    reasons.push('credits_ignored_for_state');
  }

  if (contradiction !== null) {
    reasons.push(contradiction);
    return snapshot('unknown', { errorClass: 'unknown' });
  }

  const nextResetAt = aggregateReset(observed, 'min').iso;
  if (blocking.length > 0) {
    reasons.push('blocking_windows');
    const aggregate = aggregateReset(blocking, 'max');
    return snapshot('exhausted', {
      errorClass: 'quota',
      resetAt: aggregate.iso,
      resetConfidence: aggregate.confidence,
      nextResetAt,
      remaining: computeRemaining(observed),
      unit: 'percent',
    });
  }

  if (allowed === true && limitReached === false) {
    reasons.push('explicit_allow');
    if (saturated) reasons.push('used_percent_saturated');
    return snapshot('available', {
      errorClass: null,
      nextResetAt,
      remaining: computeRemaining(observed),
      unit: 'percent',
    });
  }

  reasons.push(rateLimit === undefined ? 'rate_limit_missing' : 'no_explicit_allow_signal');
  return snapshot('unknown', { errorClass: 'unknown', nextResetAt, remaining: computeRemaining(observed), unit: 'percent' });
}

function parseInnerBody(body) {
  if (isPlainObject(body)) return { ok: true, body, coerced: false };
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (!isPlainObject(parsed)) return { ok: false, reason: 'inner_body_malformed' };
      return { ok: true, body: parsed, coerced: true };
    } catch {
      return { ok: false, reason: 'inner_body_malformed' };
    }
  }
  return { ok: false, reason: 'inner_body_missing' };
}

/** Fields a recognized window may carry. */
const WINDOW_ALLOWED_KEYS = Object.freeze([
  'used_percent',
  'limit_window_seconds',
  'limit_reached',
  'allowed',
  'reset_at',
  'reset_after_seconds',
]);

/** Informational window metadata that is never echoed and never interpreted. */
const WINDOW_META_KEYS = Object.freeze([
  'limit_name',
  'metered_feature',
  'name',
  'id',
  'window_id',
  'description',
  'scope',
]);

/**
 * Read one window strictly. Any invalid field, conflicting flag pair or
 * unrecognized field is a hard failure: the caller turns the whole snapshot
 * into `unknown`. A reason-only downgrade is never allowed, because a hidden
 * restriction could otherwise be skipped.
 * @returns {{ok: true, window: object}|{ok: false, issue: string}}
 */
function readWindow(raw, id, nowMs, reasons) {
  if (!isPlainObject(raw)) return { ok: false, issue: 'window_malformed' };
  for (const key of Object.keys(raw)) {
    if (!WINDOW_ALLOWED_KEYS.includes(key) && !WINDOW_META_KEYS.includes(key)) {
      return { ok: false, issue: 'window_field_unrecognized' };
    }
  }
  let usedPercent = null;
  if (raw.used_percent !== undefined && raw.used_percent !== null) {
    usedPercent = normalizePercent(raw.used_percent);
    if (usedPercent === undefined) return { ok: false, issue: 'used_percent_invalid' };
  }
  let windowSeconds = null;
  if (raw.limit_window_seconds !== undefined && raw.limit_window_seconds !== null) {
    if (!isFiniteNumber(raw.limit_window_seconds) || raw.limit_window_seconds <= 0) {
      return { ok: false, issue: 'limit_window_seconds_invalid' };
    }
    windowSeconds = raw.limit_window_seconds;
  }
  let allowed = null;
  let limitReached = null;
  if (raw.allowed !== undefined && raw.allowed !== null) {
    if (typeof raw.allowed !== 'boolean') return { ok: false, issue: 'window_flag_not_boolean' };
    allowed = raw.allowed;
  }
  if (raw.limit_reached !== undefined && raw.limit_reached !== null) {
    if (typeof raw.limit_reached !== 'boolean') return { ok: false, issue: 'window_flag_not_boolean' };
    limitReached = raw.limit_reached;
  }
  if (allowed !== null && limitReached !== null && allowed === limitReached) {
    // (true,true) and (false,false) both contradict themselves.
    return { ok: false, issue: 'window_flag_conflict' };
  }
  const reset = readReset(raw, nowMs, reasons);
  if (reset.ok === false) return reset;
  return {
    ok: true,
    window: {
      id,
      usedPercent,
      windowSeconds,
      resetAt: reset.resetAt,
      resetConfidence: reset.resetConfidence,
      blocked: allowed === false || limitReached === true,
      saturation: usedPercent === 100,
    },
  };
}

/**
 * Read reset evidence without ever throwing. An epoch that is finite but whose
 * millisecond scaling overflows is an explicit failure, not a silent ignore.
 * @returns {{ok: true, resetAt: string|null, resetConfidence: string|null}|{ok: false, issue: string}}
 */
function readReset(raw, nowMs, reasons) {
  let fromResetAt;
  if (raw.reset_at !== undefined && raw.reset_at !== null) {
    if (!isFiniteNumber(raw.reset_at) || raw.reset_at <= 0) return { ok: false, issue: 'reset_at_invalid' };
    const scaled = raw.reset_at * 1000;
    if (!Number.isFinite(scaled) || Math.abs(scaled) > MAX_DATE_MS) return { ok: false, issue: 'reset_at_out_of_range' };
    fromResetAt = scaled;
  }
  let fromAfter;
  if (raw.reset_after_seconds !== undefined && raw.reset_after_seconds !== null) {
    if (!isFiniteNumber(raw.reset_after_seconds) || raw.reset_after_seconds < 0) {
      return { ok: false, issue: 'reset_after_seconds_invalid' };
    }
    const scaled = raw.reset_after_seconds * 1000;
    if (!Number.isFinite(scaled)) return { ok: false, issue: 'reset_after_seconds_out_of_range' };
    const candidate = nowMs + scaled;
    if (!Number.isFinite(candidate) || Math.abs(candidate) > MAX_DATE_MS) {
      return { ok: false, issue: 'reset_after_seconds_out_of_range' };
    }
    fromAfter = candidate;
  }
  if (fromResetAt === undefined && fromAfter === undefined) return { ok: true, resetAt: null, resetConfidence: null };
  if (fromResetAt === undefined) return { ok: true, resetAt: toIso(fromAfter), resetConfidence: 'estimated' };
  if (fromAfter === undefined) return { ok: true, resetAt: toIso(fromResetAt), resetConfidence: 'confirmed' };
  if (Math.abs(fromResetAt - fromAfter) > RESET_TOLERANCE_MS) {
    // Conflicting reset evidence: take the later time so we never re-check early.
    reasons.push('reset_time_conflict');
    return { ok: true, resetAt: toIso(Math.max(fromResetAt, fromAfter)), resetConfidence: 'estimated' };
  }
  return { ok: true, resetAt: toIso(fromResetAt), resetConfidence: 'confirmed' };
}

function readModelScoped(body, { model, nowMs, reasons }) {
  const windows = [];
  const additional = body.additional_rate_limits;
  if (additional !== undefined && additional !== null) {
    // Object keys are never echoed: ids are stable synthetic indices.
    const entries = Array.isArray(additional)
      ? additional.map((value, index) => [`additional_rate_limits[${index}]`, value])
      : isPlainObject(additional)
        ? Object.values(additional).map((value, index) => [`additional_rate_limits[${index}]`, value])
        : null;
    if (entries === null) return { ok: false, reason: 'model_restriction_unrecognized' };
    for (const [id, entry] of entries) {
      if (!isPlainObject(entry)) return { ok: false, reason: 'model_restriction_unrecognized' };
      const inner = isPlainObject(entry.rate_limit) ? entry.rate_limit : null;
      const candidate = inner ?? entry;
      const read = readWindow(candidate, id, nowMs, reasons);
      if (read.ok === false) return { ok: false, reason: read.issue };
      windows.push(read.window);
      if (inner !== null && (typeof entry.allowed === 'boolean' || typeof entry.limit_reached === 'boolean')) {
        const outerRead = readWindow({ allowed: entry.allowed, limit_reached: entry.limit_reached }, `${id}:outer`, nowMs, reasons);
        if (outerRead.ok === false) return { ok: false, reason: outerRead.issue };
        windows.push(outerRead.window);
      }
    }
  }
  const modelUsage = body.model_usage;
  if (modelUsage !== undefined && modelUsage !== null) {
    if (!isPlainObject(modelUsage) || !isNonEmptyString(model)) {
      return { ok: false, reason: 'model_restriction_unrecognized' };
    }
    if (!Object.prototype.hasOwnProperty.call(modelUsage, model)) {
      return { ok: false, reason: 'model_usage_model_absent' };
    }
    const entry = modelUsage[model];
    const candidate = isPlainObject(entry) && isPlainObject(entry.rate_limit) ? entry.rate_limit : entry;
    const read = readWindow(candidate, 'model_usage[matched]', nowMs, reasons);
    if (read.ok === false) return { ok: false, reason: read.issue };
    windows.push(read.window);
  }
  return { ok: true, windows };
}

/** Project an observed window onto the blocking-window schema. */
function toBlockingWindow(window) {
  return {
    id: window.id,
    reason: window.reason ?? 'window_blocked',
    usedPercent: window.usedPercent ?? null,
    resetAt: window.resetAt ?? null,
    resetConfidence: window.resetConfidence ?? null,
    blocked: true,
  };
}

function aggregateReset(windows, mode) {
  const parseable = windows.map((window) => (isNonEmptyString(window.resetAt) ? Date.parse(window.resetAt) : Number.NaN));
  if (windows.length === 0 || parseable.some((value) => Number.isNaN(value))) {
    return { iso: null, confidence: null };
  }
  const value = mode === 'min' ? Math.min(...parseable) : Math.max(...parseable);
  const confidence = windows.every((window) => window.resetConfidence === 'confirmed') ? 'confirmed' : 'estimated';
  return { iso: toIso(value), confidence };
}

function computeRemaining(observed) {
  if (observed.length === 0) return null;
  if (observed.some((window) => window.usedPercent === null)) return null;
  const used = Math.max(...observed.map((window) => window.usedPercent));
  return Math.max(0, Math.min(100, 100 - used));
}

/**
 * Build a scheduling-gate snapshot from an inference-time quota failure.
 * It intentionally carries no reset time: recovery is decided by a re-check.
 */
export function makeInferenceErrorSnapshot({ scopeKey, now, classification, attempt = 1 } = {}) {
  if (!isNonEmptyString(scopeKey)) throw new InputValidationError('scopeKey must be a non-empty string', ['scopeKey']);
  const nowMs = resolveNow(now);
  const observedAt = toIso(nowMs);
  return {
    scopeKey,
    state: 'exhausted',
    source: 'inference-error',
    observedAt,
    validUntil: toIso(nowMs + SNAPSHOT_TTL_MS),
    modelMappingVerified: false,
    remaining: null,
    unit: null,
    resetAt: null,
    resetConfidence: null,
    nextResetAt: null,
    blockingWindows: [
      {
        id: 'inference-error',
        reason: classification?.code ?? 'quota_failure',
        usedPercent: null,
        resetAt: null,
        resetConfidence: null,
        blocked: true,
      },
    ],
    observedWindows: [],
    saturated: false,
    credits: null,
    errorClass: 'quota',
    releaseRecommended: false,
    attempt,
    reasons: ['failure_class_quota', 'awaiting_recheck'],
  };
}

/**
 * Every top-level key a normalized snapshot may carry. Anything else — a raw
 * `body`, `header`, a mistyped field, a future addition — is rejected so a
 * port can never smuggle unvalidated or non-JSON data into stored state.
 */
export const ALLOWED_SNAPSHOT_KEYS = Object.freeze([
  'scopeKey',
  'state',
  'source',
  'observedAt',
  'validUntil',
  'modelMappingVerified',
  'remaining',
  'unit',
  'resetAt',
  'resetConfidence',
  'nextResetAt',
  'blockingWindows',
  'observedWindows',
  'saturated',
  'credits',
  'errorClass',
  'releaseRecommended',
  'reasons',
  'attempt',
]);

const ALLOWED_SNAPSHOT_KEY_SET = new Set(ALLOWED_SNAPSHOT_KEYS);
const FORBIDDEN_SNAPSHOT_KEYS = Object.freeze([
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
  'apikey',
  'apiKey',
]);

const OPTIONAL_INSTANTS = Object.freeze(['validUntil', 'resetAt', 'nextResetAt']);
const BLOCKING_WINDOW_KEYS = Object.freeze(['id', 'reason', 'usedPercent', 'resetAt', 'resetConfidence', 'blocked']);
const OBSERVED_WINDOW_KEYS = Object.freeze(['id', 'usedPercent', 'windowSeconds', 'resetAt', 'resetConfidence', 'blocked', 'saturation']);
const CREDITS_KEYS = Object.freeze(['hasCredits', 'balance', 'ignoredForState']);
const ERROR_CLASSES = Object.freeze(['quota', 'rate_limited', 'auth_required', 'unknown']);
const REASON_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** A stable reason code (no free text, no whitespace, bounded length). */
export function isSafeReasonCode(value) {
  return typeof value === 'string' && REASON_PATTERN.test(value);
}

function validateWindow(window, path, allowedKeys, { requireReason = false } = {}) {
  const issues = [];
  if (!isPlainObject(window)) return [path];
  for (const key of Object.keys(window)) {
    if (!allowedKeys.includes(key)) issues.push(`${path}.${key}`);
  }
  for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(window, key)) issues.push(`${path}.forbidden:${key}`);
  }
  if (!isNonEmptyString(window.id)) issues.push(`${path}.id`);
  if (typeof window.blocked !== 'boolean') issues.push(`${path}.blocked`);
  if (window.usedPercent !== null && window.usedPercent !== undefined && !(isFiniteNumber(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100)) {
    issues.push(`${path}.usedPercent`);
  }
  if (window.resetAt !== null && window.resetAt !== undefined && !isValidIsoInstant(window.resetAt)) {
    issues.push(`${path}.resetAt`);
  }
  if (window.resetConfidence !== null && window.resetConfidence !== undefined && !RESET_CONFIDENCE.includes(window.resetConfidence)) {
    issues.push(`${path}.resetConfidence`);
  }
  if (requireReason && window.reason !== undefined && window.reason !== null && !isSafeReasonCode(window.reason)) {
    issues.push(`${path}.reason`);
  }
  if (allowedKeys.includes('windowSeconds') && window.windowSeconds !== null && window.windowSeconds !== undefined) {
    if (!(isFiniteNumber(window.windowSeconds) && window.windowSeconds > 0)) issues.push(`${path}.windowSeconds`);
  }
  if (allowedKeys.includes('saturation') && typeof window.saturation !== 'boolean') issues.push(`${path}.saturation`);
  return issues;
}

/**
 * Strict validation for any snapshot a port hands back to the core, in depth:
 * unknown top-level AND nested fields, forbidden raw fields, JSON-safety of
 * every reachable value, and per-field type/range checks.
 * @returns {string[]} issues (empty array means acceptable)
 */
export function validateQuotaSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return ['snapshot'];
  const issues = [...findNonJsonValue(snapshot, 'snapshot')];
  for (const key of Object.keys(snapshot)) {
    if (!ALLOWED_SNAPSHOT_KEY_SET.has(key)) issues.push(`unknownField:${key}`);
  }
  for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) issues.push(`forbiddenField:${key}`);
  }
  if (!isNonEmptyString(snapshot.scopeKey)) issues.push('scopeKey');
  if (!QUOTA_STATES.includes(snapshot.state)) issues.push('state');
  if (!QUOTA_SOURCES.includes(snapshot.source)) issues.push('source');
  if (!isValidIsoInstant(snapshot.observedAt)) issues.push('observedAt');
  for (const key of OPTIONAL_INSTANTS) {
    const value = snapshot[key];
    if (value !== null && value !== undefined && !isValidIsoInstant(value)) issues.push(key);
  }
  if (typeof snapshot.releaseRecommended !== 'boolean') issues.push('releaseRecommended');
  if (typeof snapshot.modelMappingVerified !== 'boolean') issues.push('modelMappingVerified');
  if (typeof snapshot.saturated !== 'boolean') issues.push('saturated');
  if (snapshot.unit !== null && snapshot.unit !== undefined && snapshot.unit !== 'percent') issues.push('unit');
  if (snapshot.errorClass !== null && snapshot.errorClass !== undefined && !ERROR_CLASSES.includes(snapshot.errorClass)) {
    issues.push('errorClass');
  }
  if (snapshot.attempt !== undefined && !(Number.isInteger(snapshot.attempt) && snapshot.attempt >= 0)) issues.push('attempt');
  if (!Array.isArray(snapshot.blockingWindows)) issues.push('blockingWindows');
  if (!Array.isArray(snapshot.observedWindows)) issues.push('observedWindows');
  if (snapshot.resetConfidence !== null && snapshot.resetConfidence !== undefined && !RESET_CONFIDENCE.includes(snapshot.resetConfidence)) {
    issues.push('resetConfidence');
  }
  if (snapshot.remaining !== null && snapshot.remaining !== undefined && !(isFiniteNumber(snapshot.remaining) && snapshot.remaining >= 0 && snapshot.remaining <= 100)) {
    issues.push('remaining');
  }
  if (!Array.isArray(snapshot.reasons)) {
    issues.push('reasons');
  } else {
    for (const [index, reason] of snapshot.reasons.entries()) {
      if (!isSafeReasonCode(reason)) issues.push(`reasons[${index}]`);
    }
  }
  if (snapshot.credits !== null && snapshot.credits !== undefined) {
    if (!isPlainObject(snapshot.credits)) {
      issues.push('credits');
    } else {
      for (const key of Object.keys(snapshot.credits)) {
        if (!CREDITS_KEYS.includes(key)) issues.push(`credits.${key}`);
      }
      if (snapshot.credits.hasCredits !== null && typeof snapshot.credits.hasCredits !== 'boolean') issues.push('credits.hasCredits');
      if (snapshot.credits.balance !== null && !isFiniteNumber(snapshot.credits.balance)) issues.push('credits.balance');
      if (typeof snapshot.credits.ignoredForState !== 'boolean') issues.push('credits.ignoredForState');
    }
  }
  if (Array.isArray(snapshot.blockingWindows)) {
    for (const [index, window] of snapshot.blockingWindows.entries()) {
      issues.push(...validateWindow(window, `blockingWindows[${index}]`, BLOCKING_WINDOW_KEYS, { requireReason: true }));
    }
  }
  if (Array.isArray(snapshot.observedWindows)) {
    for (const [index, window] of snapshot.observedWindows.entries()) {
      issues.push(...validateWindow(window, `observedWindows[${index}]`, OBSERVED_WINDOW_KEYS));
    }
  }
  if (snapshot.state === 'available' && Array.isArray(snapshot.blockingWindows) && snapshot.blockingWindows.length > 0) {
    issues.push('availableWithBlockingWindows');
  }
  if (snapshot.state !== 'available' && snapshot.releaseRecommended === true) issues.push('releaseWithoutAvailable');
  return issues;
}
