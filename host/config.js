/**
 * quota-queue/host — plugin configuration.
 *
 * The configuration may declare `storageBackend` and a list of *fixed routes*.
 * A route carries only `provider`, `model` and a user-named
 * `credentialRef` reference: there is no field for a token, an authorization
 * header, an arbitrary management URL, an `authIndex`, or a capability flag.
 * Unknown keys fail validation instead of being ignored.
 *
 * A configured route never turns execution on. It only makes a manual task
 * persistable in a safe, unexecuted state; `capabilities.execution` stays
 * false until exclusive execution ownership is proven.
 */
import { isNonEmptyString, isPlainObject } from '../core/util.mjs';
import { DEFAULT_STORAGE_BACKEND } from './constants.js';

const TOP_LEVEL_KEYS = Object.freeze(['storageBackend', 'routes', 'quotaSource', 'autoResume', 'autoContinue']);
const ROUTE_KEYS = Object.freeze(['id', 'label', 'provider', 'model', 'credentialRef']);
const QUOTA_SOURCE_KEYS = Object.freeze([
  'kind', 'baseUrl', 'managementKeyEnv', 'authIndex',
  'weeklyMinRemaining', 'fiveHourMinRemaining', 'timeoutMs', 'maxAgeMs',
]);
const ROUTE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HTTPS_ORIGIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

const AUTO_RESUME_KEYS = Object.freeze(['enabled', 'maxWaitMs', 'maxChecks']);
// `maxAgeMs` is accepted but ignored: the age cap was removed (a failure chain
// is bounded by attempts only). Keeping the key in the allowlist lets an older
// deployment's config load instead of failing activation on upgrade.
const AUTO_CONTINUE_KEYS = Object.freeze(['enabled', 'maxAttempts', 'maxAgeMs', 'pollMs', 'fenceGraceMs', 'quotaGateRetryMs']);

/**
 * Parse the durable automatic-continuation switch.
 *
 * Default OFF. Turning it on does not by itself authorize anything: a send also
 * requires the session's own opt-in, the OS owner mutex on the fixed global
 * port (host/constants.js OWNER_LOCK_PORT), the exact failed turn and a
 * recovered condition.
 */
function parseAutoContinue(raw, issues) {
  const fallback = { enabled: false, maxAttempts: 5, pollMs: 5000, fenceGraceMs: 120_000, quotaGateRetryMs: 600_000 };
  if (raw === undefined || raw === null) return fallback;
  if (!isPlainObject(raw)) {
    issues.push('autoContinue must be a plain object');
    return fallback;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTO_CONTINUE_KEYS.includes(key)) issues.push(`autoContinue has unknown key "${key}"`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') issues.push('autoContinue.enabled must be a boolean');
  const integer = (key, fallbackValue, min, max) => {
    if (raw[key] === undefined) return fallbackValue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) {
      issues.push(`autoContinue.${key} must be an integer in [${min}, ${max}]`);
      return fallbackValue;
    }
    return raw[key];
  };
  return {
    enabled: raw.enabled === true,
    maxAttempts: integer('maxAttempts', fallback.maxAttempts, 1, 20),
    pollMs: integer('pollMs', fallback.pollMs, 1_000, 60_000),
    fenceGraceMs: integer('fenceGraceMs', fallback.fenceGraceMs, 30_000, 3_600_000),
    // How long a quota-blocked continuation waits before asking the account
    // again. The wait is not an attempt: nothing is sent while it is blocked.
    quotaGateRetryMs: integer('quotaGateRetryMs', fallback.quotaGateRetryMs, 60_000, 86_400_000),
  };
}

/** Configuration used when the row declares none. */
export function defaultConfig() {
  return {
    storageBackend: DEFAULT_STORAGE_BACKEND,
    routes: [],
    quotaSource: null,
    autoResume: { enabled: false, maxWaitMs: 3_600_000, maxChecks: 30 },
    autoContinue: { enabled: false, maxAttempts: 5, pollMs: 5000, fenceGraceMs: 120_000, quotaGateRetryMs: 600_000 },
  };
}

/** Parse the optional HOT request-error recovery switch. */
function parseAutoResume(raw, quotaSource, issues) {
  const fallback = { enabled: false, maxWaitMs: 3_600_000, maxChecks: 30 };
  if (raw === undefined || raw === null) return fallback;
  if (!isPlainObject(raw)) {
    issues.push('autoResume must be a plain object');
    return fallback;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTO_RESUME_KEYS.includes(key)) issues.push(`autoResume has unknown key "${key}"`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') issues.push('autoResume.enabled must be a boolean');
  const enabled = raw.enabled === true;
  const integer = (key, fallbackValue, min, max) => {
    if (raw[key] === undefined) return fallbackValue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) {
      issues.push(`autoResume.${key} must be an integer in [${min}, ${max}]`);
      return fallbackValue;
    }
    return raw[key];
  };
  const maxWaitMs = integer('maxWaitMs', 3_600_000, 1_000, 86_400_000);
  const maxChecks = integer('maxChecks', 30, 1, 1000);
  if (enabled && quotaSource === null) issues.push('autoResume.enabled requires a configured quotaSource');
  return { enabled, maxWaitMs, maxChecks };
}

/** Parse the optional read-only CPAMC quota source. */
function parseQuotaSource(raw, issues) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    issues.push('quotaSource must be a plain object');
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!QUOTA_SOURCE_KEYS.includes(key)) issues.push(`quotaSource has unknown key "${key}"`);
  }
  if (raw.kind !== 'cpamc') issues.push('quotaSource.kind must be "cpamc"');
  if (!isNonEmptyString(raw.baseUrl) || !HTTPS_ORIGIN_RE.test(raw.baseUrl)) {
    issues.push('quotaSource.baseUrl must be an https origin without a path or query');
  }
  if (!isNonEmptyString(raw.managementKeyEnv) || !ENV_NAME_RE.test(raw.managementKeyEnv)) {
    issues.push('quotaSource.managementKeyEnv must be an environment variable name, not a key');
  }
  if (!isNonEmptyString(raw.authIndex) || raw.authIndex.length > 200 || /[^A-Za-z0-9_.:-]/.test(raw.authIndex)) {
    issues.push('quotaSource.authIndex must be an opaque index made of [A-Za-z0-9_.:-]');
  }
  const range = (key, fallback, min, max) => {
    if (raw[key] === undefined) return fallback;
    if (!Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) {
      issues.push(`quotaSource.${key} must be a number in [${min}, ${max}]`);
      return fallback;
    }
    return raw[key];
  };
  const weeklyMinRemaining = range('weeklyMinRemaining', 10, 0, 100);
  const fiveHourMinRemaining = range('fiveHourMinRemaining', 0, 0, 100);
  const timeoutMs = range('timeoutMs', 10_000, 1_000, 60_000);
  const maxAgeMs = range('maxAgeMs', 300_000, 5_000, 3_600_000);
  if (issues.length > 0) return null;
  return {
    kind: 'cpamc',
    baseUrl: raw.baseUrl,
    managementKeyEnv: raw.managementKeyEnv,
    authIndex: raw.authIndex,
    weeklyMinRemaining,
    fiveHourMinRemaining,
    timeoutMs,
    maxAgeMs,
  };
}

/**
 * Validate and normalize a plugin config.
 * @param {unknown} value
 * @returns {{storageBackend: string, routes: Array<{id:string,label:string,provider:string,model:string,credentialRef:string}>}}
 * @throws {TypeError} with a message listing every issue
 */
export function parseConfig(value) {
  const issues = [];
  const raw = value === undefined || value === null ? {} : value;
  if (!isPlainObject(raw)) throw new TypeError('config must be a plain object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) issues.push(`unknown config key "${key}"`);
  }
  let storageBackend = DEFAULT_STORAGE_BACKEND;
  if (raw.storageBackend !== undefined) {
    if (!isNonEmptyString(raw.storageBackend)) issues.push('storageBackend must be a non-empty string');
    else storageBackend = raw.storageBackend.trim();
  }
  const routes = [];
  const seen = new Set();
  const rawRoutes = raw.routes === undefined || raw.routes === null ? [] : raw.routes;
  if (!Array.isArray(rawRoutes)) {
    issues.push('routes must be an array');
  } else {
    for (const [index, entry] of rawRoutes.entries()) {
      const where = `routes[${index}]`;
      if (!isPlainObject(entry)) {
        issues.push(`${where} must be a plain object`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!ROUTE_KEYS.includes(key)) issues.push(`${where} has unknown key "${key}"`);
      }
      for (const key of ['id', 'provider', 'model', 'credentialRef']) {
        if (!isNonEmptyString(entry[key])) issues.push(`${where}.${key} must be a non-empty string`);
      }
      if (entry.label !== undefined && typeof entry.label !== 'string') issues.push(`${where}.label must be a string`);
      if (!isNonEmptyString(entry.id) || !isNonEmptyString(entry.provider) || !isNonEmptyString(entry.model) || !isNonEmptyString(entry.credentialRef)) {
        continue;
      }
      if (!ROUTE_ID_RE.test(entry.id)) {
        issues.push(`${where}.id must contain only [A-Za-z0-9_.:-]`);
        continue;
      }
      if (seen.has(entry.id)) {
        issues.push(`${where}.id duplicates an earlier route id`);
        continue;
      }
      seen.add(entry.id);
      routes.push({
        id: entry.id,
        label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : entry.id,
        provider: entry.provider.trim(),
        model: entry.model.trim(),
        credentialRef: entry.credentialRef.trim(),
      });
    }
  }
  // Every fixed route must bind to the ONE user-confirmed common credential.
  // Multiple providers/models may be listed, but arbitrary multi-account
  // selection is refused: the queue never chooses between accounts.
  const credentialRefs = new Set(routes.map((route) => route.credentialRef));
  if (credentialRefs.size > 1) {
    issues.push('all routes must share the same credentialRef; multi-account selection is not supported');
  }
  const quotaSource = parseQuotaSource(raw.quotaSource, issues);
  const autoResume = parseAutoResume(raw.autoResume, quotaSource, issues);
  const autoContinue = parseAutoContinue(raw.autoContinue, issues);
  if (issues.length > 0) throw new TypeError(issues.join('; '));
  return { storageBackend, routes, quotaSource, autoResume, autoContinue };
}

/**
 * Standard-schema face consumed by Cordis' `resolveConfig`.
 * `~standard.validate` is synchronous, as the loader requires.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'quota-queue',
    /**
     * @param {unknown} value raw row config
     * @returns {{value: object}|{issues: Array<{message:string}>}}
     */
    validate(value) {
      try {
        return { value: parseConfig(value) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid config';
        return { issues: message.split('; ').map((part) => ({ message: part })) };
      }
    },
  }),
});
