/**
 * quota-queue/core — small pure helpers. No I/O, no host imports.
 */
import { InputValidationError } from './errors.mjs';

/** Plain JSON-style object (not an array, not a class instance, not null). */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Defensive deep copy so callers can never mutate internal state. */
export function deepCopy(value) {
  return structuredClone(value);
}

/** Non-empty (after trim) string. */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Finite number check. */
export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Finite integer check. */
export function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Normalize a time-ish value to epoch milliseconds.
 * @returns {number|undefined} undefined when the value is absent or unparseable
 */
export function toEpochMs(value) {
  const within = (t) => (Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : undefined);
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return within(value.getTime());
  if (typeof value === 'number') return within(value);
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return within(t);
  }
  return undefined;
}

/** Largest epoch-ms value representable by an ISO-8601 instant (±100,000,000 days). */
export const MAX_DATE_MS = 8.64e15;

/**
 * Epoch milliseconds -> ISO-8601 UTC string.
 * @throws {RangeError} when the value is outside the representable instant range
 */
export function toIso(epochMs) {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_DATE_MS) {
    throw new RangeError('epoch milliseconds outside the ISO-8601 instant range');
  }
  return new Date(epochMs).toISOString();
}

/** True only for a string that round-trips through Date as a finite instant. */
export function isValidIsoInstant(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || Math.abs(t) > MAX_DATE_MS) return false;
  try {
    return new Date(t).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Echo a code only when it is on the caller's allowlist. Anything else becomes
 * null: string shape alone never proves a value is not a secret fragment.
 * @param {unknown} value
 * @param {ReadonlySet<string>|readonly string[]} allowlist
 * @returns {string|null}
 */
export function allowlistedCode(value, allowlist) {
  if (typeof value !== 'string') return null;
  const set = allowlist instanceof Set ? allowlist : new Set(allowlist);
  const trimmed = value.trim().toUpperCase().replace(/[.-]/g, '_');
  return set.has(trimmed) ? trimmed : null;
}

/**
 * Resolve `now` for an entry point.
 * @returns {number} epoch milliseconds; throws InputValidationError when absent
 */
export function resolveNow(now) {
  const t = toEpochMs(now);
  if (t === undefined) {
    throw new InputValidationError('now must be a Date, epoch-ms number or ISO string', ['now']);
  }
  return t;
}

/**
 * Accept only a short machine-code-shaped string. Anything else (error prose,
 * URLs, token fragments) becomes null so it can never leak into stored state.
 * @returns {string|null} upper-cased code, or null
 */
export function safeCode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(trimmed)) return null;
  return trimmed.toUpperCase().replace(/[.-]/g, '_');
}

/** Clamp a numeric percentage into [0, 100]; non-finite values yield undefined. */
export function normalizePercent(value) {
  if (!isFiniteNumber(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
}

/** Stable, order-independent JSON string for structural comparisons. */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/**
 * Deep JSON-safety scan: every reachable value must be null, boolean, a finite
 * number, a string, a plain object or an array thereof. Functions, undefined,
 * bigint, Date, symbol and non-finite numbers are reported with their path.
 * @returns {string[]} issues
 */
export function findNonJsonValue(value, path = 'value') {
  if (value === null) return [];
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return [];
  if (type === 'number') return Number.isFinite(value) ? [] : [`nonJson:${path}`];
  if (Array.isArray(value)) {
    const issues = [];
    for (const [index, item] of value.entries()) issues.push(...findNonJsonValue(item, `${path}[${index}]`));
    return issues;
  }
  if (isPlainObject(value)) {
    const issues = [];
    for (const [key, item] of Object.entries(value)) issues.push(...findNonJsonValue(item, `${path}.${key}`));
    return issues;
  }
  return [`nonJson:${path}`];
}

/** Assert a value is a plain object, else throw InputValidationError. */
export function assertPlainObject(value, field) {
  if (!isPlainObject(value)) {
    throw new InputValidationError(`${field} must be a plain object`, [field]);
  }
  return value;
}

/** Assert a non-empty string, else throw InputValidationError. */
export function assertNonEmptyString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new InputValidationError(`${field} must be a non-empty string`, [field]);
  }
  return value;
}

/**
 * Reject payload fields that would smuggle raw error text, URLs or credentials
 * into the core. Deny-by-name is intentionally blunt: the core has no use for
 * any of these, so anything matching is a caller bug, not a feature request.
 * @param {object} payload
 * @param {readonly string[]} denied
 */
export function rejectDeniedFields(payload, denied) {
  if (!isPlainObject(payload)) return;
  const hits = Object.keys(payload).filter((key) => denied.includes(key));
  if (hits.length > 0) {
    throw new InputValidationError(
      `payload fields are not accepted by the core: ${hits.join(', ')}`,
      hits,
    );
  }
}
