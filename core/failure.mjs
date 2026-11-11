/**
 * quota-queue/core — structured failure classification.
 *
 * Routing is by stable machine code first, HTTP status second. Human-readable
 * error prose is never parsed, never accepted and never stored. The returned
 * `code` is echoed ONLY when it is on this module's explicit allowlist: a
 * shape-matching string is not proof that it is not a secret fragment.
 */
import { InputValidationError } from './errors.mjs';
import { isPlainObject, isInteger, allowlistedCode } from './util.mjs';

/** Normalized codes that mean "this account/route is out of quota". */
export const QUOTA_CODES = Object.freeze(['QUOTA', 'ACCOUNT_QUOTA']);

/** Normalized code owned by the native bounded retry policy. */
export const RATE_LIMIT_CODES = Object.freeze(['RATE_LIMIT']);

/** Codes that mean credentials/permission must be fixed by a human. */
export const AUTH_CODES = Object.freeze([
  'AUTH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'TOKEN_REVOKED',
  'EXPIRED_TOKEN',
]);

/** Codes that mean the user stopped the run; never a quota ticket. */
export const USER_CANCEL_CODES = Object.freeze([
  'ABORTED',
  'ABORT',
  'CANCELED',
  'CANCELLED',
  'USER_CANCEL',
  'USER_CANCELLED',
]);

/** Codes the native bounded retry policy already owns. */
export const TRANSIENT_CODES = Object.freeze([
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'OVERLOADED',
  'CONNECTION_RESET',
  // The pi-ai adapter's FALLBACK code: it reaches this module only after that
  // adapter failed to recognize 401/403, quota, 429, 4xx, 5xx, timeout or
  // transport text. Upstream overloads ('servers are currently overloaded')
  // land here, so treating it as unknown-and-permanent silently disabled
  // recovery for a real transient outage. It is accepted as transient and the
  // ordinary attempt cap bounds the cost; a 401/403 status still stops, and a
  // 429 status is still an evidence conflict.
  'PI_AI_ERROR',
]);

/** Codes that are request-level problems, not account state. */
export const REQUEST_ERROR_CODES = Object.freeze([
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_ARGS',
  'INVARIANT',
  'IMAGE_OFFLOAD_REQUIRED',
]);

/** Codes that mean the plugin/host wiring is wrong. */
export const CONFIGURATION_CODES = Object.freeze(['NO_ADAPTER', 'CONFIG_INVALID', 'NOT_CONFIGURED']);

/**
 * The complete set of codes this module will ever echo back. Everything else is
 * reported as `codeRecognized: false` with `code: null`.
 */
export const KNOWN_CODES = Object.freeze([
  ...QUOTA_CODES,
  ...RATE_LIMIT_CODES,
  ...AUTH_CODES,
  ...USER_CANCEL_CODES,
  ...TRANSIENT_CODES,
  ...REQUEST_ERROR_CODES,
  ...CONFIGURATION_CODES,
]);

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

/** Evidence conflicts that suppress automatic ticket creation. */
export const FAILURE_CONFLICTS = Object.freeze([
  'quota_code_with_auth_status',
  'quota_code_with_incompatible_status',
]);

const KNOWN_SET = new Set(KNOWN_CODES);
const QUOTA_SET = new Set(QUOTA_CODES);
const RATE_LIMIT_SET = new Set(RATE_LIMIT_CODES);
const AUTH_SET = new Set(AUTH_CODES);
const USER_CANCEL_SET = new Set(USER_CANCEL_CODES);
const TRANSIENT_SET = new Set(TRANSIENT_CODES);
const REQUEST_ERROR_SET = new Set(REQUEST_ERROR_CODES);
const CONFIGURATION_SET = new Set(CONFIGURATION_CODES);

/**
 * Classify one structured model-request failure.
 *
 * A quota code combined with contradicting transport evidence (401/403, or any
 * other non-success status that a quota rejection cannot carry) never creates a
 * ticket: it degrades to `auth_required` or `unknown` with `conflict` set.
 *
 * @param {{ code?: unknown, status?: unknown }} input
 * @returns {{
 *   class: string, code: string|null, codeRecognized: boolean, status: number|null,
 *   conflict: string|null, createsQuotaTicket: boolean, retryableNatively: boolean,
 *   quotaEvidence: 'normalized_code'|'none', safeSummary: string
 * }}
 */
export function classifyFailure(input = {}) {
  if (!isPlainObject(input)) {
    throw new InputValidationError('classifyFailure expects a plain object', ['input']);
  }
  const code = allowlistedCode(input.code, KNOWN_SET);
  const codeRecognized = code !== null;
  const status = isInteger(input.status) && input.status >= 100 && input.status <= 599 ? input.status : null;

  if (code !== null) {
    if (QUOTA_SET.has(code)) {
      if (status === 401 || status === 403) {
        return decision('auth_required', { code: null, status, conflict: 'quota_code_with_auth_status' });
      }
      if (status !== null && status !== 429 && status !== 402 && (status < 200 || status >= 300)) {
        return decision('unknown', { code: null, status, conflict: 'quota_code_with_incompatible_status' });
      }
      return decision('quota', { code, status, createsQuotaTicket: true, quotaEvidence: 'normalized_code' });
    }
    if (RATE_LIMIT_SET.has(code)) return decision('rate_limit', { code, status, retryableNatively: true });
    if (AUTH_SET.has(code)) return decision('auth_required', { code, status });
    if (USER_CANCEL_SET.has(code)) return decision('user_cancelled', { code, status });
    if (TRANSIENT_SET.has(code)) return decision('transient', { code, status, retryableNatively: true });
    if (REQUEST_ERROR_SET.has(code)) return decision('request_error', { code, status });
    if (CONFIGURATION_SET.has(code)) return decision('configuration', { code, status });
  }

  if (status !== null) {
    if (status === 401 || status === 403) return decision('auth_required', { status });
    // A bare 429 is not proof of quota exhaustion (A05): it stays a rate limit.
    if (status === 429) return decision('rate_limit', { status, retryableNatively: true });
    if (status === 408 || status >= 500) return decision('transient', { status, retryableNatively: true });
    // 402 is contract-dependent; never auto-classified as account quota.
    if (status >= 400 && status < 500) return decision('request_error', { status });
  }

  return decision('unknown', { codeRecognized });
}

function decision(failureClass, {
  code = null,
  codeRecognized = code !== null,
  status = null,
  conflict = null,
  createsQuotaTicket = false,
  retryableNatively = false,
  quotaEvidence = 'none',
} = {}) {
  return Object.freeze({
    class: failureClass,
    code,
    codeRecognized,
    status,
    conflict,
    createsQuotaTicket,
    retryableNatively,
    quotaEvidence,
    safeSummary: summaryFor(failureClass, { code, status, conflict }),
  });
}

const SUMMARIES = Object.freeze({
  quota: 'provider reported an exhausted quota',
  rate_limit: 'rate limited; a bare throttle is not proof of quota exhaustion',
  auth_required: 'authentication or permission failure; quota recovery stays disabled',
  transient: 'transient provider or transport failure; native bounded retry owns it',
  request_error: 'request-level failure; not an account quota condition',
  configuration: 'route or adapter configuration failure',
  user_cancelled: 'stopped by the user; never re-queued automatically',
  unknown: 'unrecognized failure; handled conservatively',
});

function summaryFor(failureClass, { code, status, conflict }) {
  const parts = [SUMMARIES[failureClass] ?? SUMMARIES.unknown];
  if (conflict !== null) parts.push(`conflict=${conflict}`);
  if (code !== null) parts.push(`code=${code}`);
  if (status !== null) parts.push(`http=${status}`);
  return parts.join(' | ').slice(0, 200);
}
