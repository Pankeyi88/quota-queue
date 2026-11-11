/**
 * quota-queue/host — read-only CPAMC quota source.
 *
 * One fixed GET against the CPAMC plugin endpoint:
 *   GET {baseUrl}/v0/management/plugins/cpa-quota-api-extension/v1/quotas?provider=codex
 * with `Authorization: Bearer <management key>` taken from an environment
 * variable named by the Host config (the key value never enters the View, the
 * Client, logs, or this repository).
 *
 * The source selects ONE fixed `auth_index` from config. It never switches
 * accounts, never resets quota and never writes. The returned object is a core
 * QuotaSnapshot (validated by core validateQuotaSnapshot) so it can only reach
 * the scheduler through the same gate as every other quota evidence.
 *
 * Gate adopted for this deployment (user decision):
 *   weekly remaining >= weeklyMinRemaining (default 10)
 *   five-hour remaining > fiveHourMinRemaining (default 0) when that window exists
 * Auth failure, unknown/missing windows, stale observation or a missing key
 * never release work.
 */
import { SNAPSHOT_TTL_MS, validateQuotaSnapshot } from '../core/quota.mjs';

const ENDPOINT_PATH = '/v0/management/plugins/cpa-quota-api-extension/v1/quotas';
const WEEKLY_SECONDS = 604800;
const FIVE_HOUR_SECONDS = 18000;

/**
 * Only these credential states prove an authentication/permission failure.
 * `unavailable` and `rate_limited` are host scheduling states: CPA can keep
 * reporting `unavailable` after a 429 cooldown while the credential file is
 * active and the quota windows are healthy. Treating that as auth failure
 * hides real quota and permanently disables HOT recovery.
 */
const AUTH_BLOCKING_CREDENTIAL_STATES = new Set(['disabled', 'unauthorized', 'forbidden', 'revoked', 'invalid']);

const iso = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const percent = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

function windowRemaining(window) {
  const direct = percent(window.remaining_percent ?? window.remainingPercent);
  if (direct !== null) return direct;
  const used = percent(window.used_percent ?? window.usedPercent);
  return used === null ? null : 100 - used;
}

function observedWindow(id, window) {
  return {
    id,
    usedPercent: percent(window.used_percent ?? window.usedPercent),
    windowSeconds: typeof window.window_seconds === 'number' && Number.isFinite(window.window_seconds)
      ? window.window_seconds
      : null,
    resetAt: iso(window.reset_at ?? window.resetAt),
    resetConfidence: iso(window.reset_at ?? window.resetAt) === null ? null : 'confirmed',
    blocked: false,
    saturation: false,
  };
}

function blockingWindow(id, window, reason) {
  return {
    id,
    reason,
    usedPercent: percent(window?.used_percent ?? window?.usedPercent),
    resetAt: iso(window?.reset_at ?? window?.resetAt),
    resetConfidence: iso(window?.reset_at ?? window?.resetAt) === null ? null : 'confirmed',
    blocked: true,
  };
}

function snapshot(scopeKey, nowMs, state, extra = {}) {
  return {
    scopeKey,
    state,
    source: 'proxy-query',
    observedAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + SNAPSHOT_TTL_MS).toISOString(),
    modelMappingVerified: false,
    remaining: extra.remaining ?? null,
    unit: extra.unit ?? null,
    resetAt: extra.resetAt ?? null,
    resetConfidence: extra.resetConfidence ?? null,
    nextResetAt: extra.nextResetAt ?? null,
    blockingWindows: extra.blockingWindows ?? [],
    observedWindows: extra.observedWindows ?? [],
    saturated: false,
    credits: null,
    errorClass: extra.errorClass ?? null,
    releaseRecommended: state === 'available',
    reasons: extra.reasons ?? ['cpamc_query'],
  };
}

/**
 * @param {object} input
 * @param {string} input.baseUrl https origin, no path/query
 * @param {string} input.managementKey secret value (never logged)
 * @param {string} input.authIndex fixed CPAMC auth index
 * @param {string} [input.scopeKey]
 * @param {number} [input.weeklyMinRemaining]
 * @param {number} [input.fiveHourMinRemaining]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.maxAgeMs] reject observations older than this
 * @param {Function} [input.fetchImpl]
 * @param {Function} [input.now]
 */
export function createCpamcQuotaSource(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('CPAMC quota source expects an input object');
  const { baseUrl, managementKey, authIndex } = input;
  if (typeof baseUrl !== 'string' || !/^https:\/\/[^/]+$/.test(baseUrl)) {
    throw new TypeError('baseUrl must be an https origin without a path');
  }
  if (typeof managementKey !== 'string' || managementKey.length === 0) throw new TypeError('a management key is required');
  if (typeof authIndex !== 'string' || authIndex.length === 0) throw new TypeError('authIndex is required');
  const weeklyMin = input.weeklyMinRemaining === undefined ? 10 : input.weeklyMinRemaining;
  const fiveHourMin = input.fiveHourMinRemaining === undefined ? 0 : input.fiveHourMinRemaining;
  const timeoutMs = input.timeoutMs === undefined ? 10_000 : input.timeoutMs;
  const maxAgeMs = input.maxAgeMs === undefined ? 5 * 60_000 : input.maxAgeMs;
  if (!Number.isFinite(weeklyMin) || weeklyMin < 0 || weeklyMin > 100) throw new TypeError('weeklyMinRemaining out of range');
  if (!Number.isFinite(fiveHourMin) || fiveHourMin < 0 || fiveHourMin > 100) throw new TypeError('fiveHourMinRemaining out of range');
  const fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  const scopeKey = typeof input.scopeKey === 'string' && input.scopeKey.length > 0 ? input.scopeKey : `cpamc:codex:${authIndex}`;
  // The plugin caches provider reads for its configured TTL. Recovery needs a
  // fresh observation, otherwise its 60s snapshot TTL rejects a cached read as
  // stale; force the provider refresh on every explicit check.
  const url = `${baseUrl}${ENDPOINT_PATH}?provider=codex&refresh=true`;

  async function check(signal) {
    const nowMs = now();
    if (signal !== undefined && signal !== null && signal.aborted) throw new Error('quota_query_cancelled');
    const timeout = AbortSignal.timeout(timeoutMs);
    const carrier = signal === undefined || signal === null ? timeout : AbortSignal.any([signal, timeout]);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${managementKey}`, accept: 'application/json' },
        signal: carrier,
      });
    } catch {
      if (signal !== undefined && signal !== null && signal.aborted) throw new Error('quota_query_cancelled');
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_transport_error'] });
    }
    if (response.status === 401 || response.status === 403) {
      return snapshot(scopeKey, nowMs, 'auth_required', { errorClass: 'auth_required', reasons: ['cpamc_http_auth'] });
    }
    if (response.status === 429) {
      return snapshot(scopeKey, nowMs, 'rate_limited', { errorClass: 'rate_limited', reasons: ['cpamc_http_429'] });
    }
    if (!response.ok) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_http_failed'] });
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_body_malformed'] });
    }
    const accounts = body !== null && typeof body === 'object' && Array.isArray(body.accounts) ? body.accounts : null;
    if (accounts === null) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_body_malformed'] });
    }
    const account = accounts.find((entry) => entry !== null && typeof entry === 'object'
      && entry.provider === 'codex' && entry.auth_index === authIndex);
    if (account === undefined) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_account_absent'] });
    }
    const credentialState = typeof account.credential_state === 'string' && account.credential_state.length > 0
      ? account.credential_state.trim().toLowerCase()
      : null;
    if (credentialState !== null && AUTH_BLOCKING_CREDENTIAL_STATES.has(credentialState)) {
      return snapshot(scopeKey, nowMs, 'auth_required', {
        errorClass: 'auth_required',
        reasons: [`cpamc_credential_${credentialState}`],
      });
    }
    if (account.status === 'error' || account.error !== undefined) {
      const upstream = account.error !== null && typeof account.error === 'object' ? account.error.upstream_status : undefined;
      if (upstream === 401 || upstream === 403) {
        return snapshot(scopeKey, nowMs, 'auth_required', { errorClass: 'auth_required', reasons: ['cpamc_upstream_auth'] });
      }
      if (upstream === 429) {
        return snapshot(scopeKey, nowMs, 'rate_limited', { errorClass: 'rate_limited', reasons: ['cpamc_upstream_rate_limited'] });
      }
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_upstream_error'] });
    }
    const fetchedAt = iso(account.fetched_at ?? account.fetchedAt) ?? iso(body.generated_at ?? body.generatedAt);
    if (fetchedAt === null) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_observed_missing'] });
    }
    const observedMs = Date.parse(fetchedAt);
    if (nowMs - observedMs > maxAgeMs || observedMs - nowMs > 60_000) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_snapshot_stale'] });
    }
    const windows = Array.isArray(account.windows) ? account.windows.filter((entry) => entry !== null && typeof entry === 'object') : [];
    const fiveHour = windows.find((entry) => entry.id === 'primary' || entry.window_seconds === FIVE_HOUR_SECONDS);
    const weekly = windows.find((entry) => entry.id === 'secondary' || (typeof entry.window_seconds === 'number' && entry.window_seconds >= WEEKLY_SECONDS));
    if (weekly === undefined) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_weekly_absent'] });
    }
    const weeklyRemaining = windowRemaining(weekly);
    const fiveHourRemaining = fiveHour === undefined ? null : windowRemaining(fiveHour);
    if (weeklyRemaining === null) {
      return snapshot(scopeKey, nowMs, 'unknown', { errorClass: 'unknown', reasons: ['cpamc_weekly_malformed'] });
    }
    const observedWindows = [observedWindow('weekly', weekly)];
    if (fiveHour !== undefined) observedWindows.push(observedWindow('five-hour', fiveHour));
    const credentialReason = credentialState !== null && credentialState !== 'active'
      ? `cpamc_credential_${credentialState}`
      : null;
    const queryReasons = credentialReason === null ? ['cpamc_query'] : ['cpamc_query', credentialReason];
    const blocking = [];
    if (weeklyRemaining < weeklyMin) blocking.push(blockingWindow('weekly', weekly, 'weekly_below_threshold'));
    if (fiveHour !== undefined) {
      if (fiveHourRemaining === null) blocking.push(blockingWindow('five-hour', fiveHour, 'five_hour_malformed'));
      else if (fiveHourRemaining <= fiveHourMin) blocking.push(blockingWindow('five-hour', fiveHour, 'five_hour_exhausted'));
    }
    const remainingCandidates = [weeklyRemaining, fiveHourRemaining].filter((value) => value !== null);
    const remaining = Math.min(...remainingCandidates);
    const resets = observedWindows.map((entry) => entry.resetAt).filter((value) => value !== null).sort();
    const resetAt = resets.length > 0 ? resets[0] : null;
    if (blocking.length > 0) {
      return snapshot(scopeKey, nowMs, 'exhausted', {
        remaining,
        unit: 'percent',
        resetAt,
        resetConfidence: resetAt === null ? null : 'confirmed',
        blockingWindows: blocking,
        observedWindows,
        errorClass: 'quota',
        reasons: [...queryReasons, 'quota_window_blocked'],
      });
    }
    return snapshot(scopeKey, nowMs, 'available', {
      remaining,
      unit: 'percent',
      resetAt,
      resetConfidence: resetAt === null ? null : 'confirmed',
      observedWindows,
      errorClass: null,
      reasons: [...queryReasons, 'weekly_ok', fiveHour === undefined ? 'five_hour_absent' : 'five_hour_ok'],
    });
  }

  return Object.freeze({
    configured: true,
    network: true,
    scopeKey,
    weeklyMinRemaining: weeklyMin,
    fiveHourMinRemaining: fiveHourMin,
    check,
    /** Exposed for tests/validation; never contains the key. */
    validate: (result) => validateQuotaSnapshot(result),
  });
}
