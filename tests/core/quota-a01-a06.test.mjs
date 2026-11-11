/**
 * A01-A06 — two-layer quota normalization (offline, no network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuota, validateQuotaSnapshot, QUOTA_STATES } from '../../core/index.mjs';
import { envelope, usagePayload, ISO } from './helpers.mjs';

const NOW = ISO;
const SCOPE = 'qs:["provider-a","model-a","default","global"]';

function normalize(env, extra = {}) {
  return normalizeQuota({ outerStatus: 200, envelope: env, scopeKey: SCOPE, now: NOW, ...extra });
}

test('A01: outer HTTP 200 + inner 401 => auth_required, never a quota countdown', () => {
  const snapshot = normalize(envelope({ error: { code: 'token_revoked' } }, 401));
  assert.equal(snapshot.state, 'auth_required');
  assert.equal(snapshot.errorClass, 'auth_required');
  assert.equal(snapshot.resetAt, null);
  assert.deepEqual(snapshot.blockingWindows, []);
  assert.equal(snapshot.releaseRecommended, false);
  assert.ok(snapshot.reasons.includes('inner_status_auth'));
});

test('A01: inner 200 carrying error.code=token_revoked => auth_required', () => {
  const snapshot = normalize(envelope({ error: { code: 'token_revoked' } }, 200));
  assert.equal(snapshot.state, 'auth_required');
  assert.equal(snapshot.releaseRecommended, false);
  assert.ok(snapshot.reasons.includes('inner_error_auth'));
});

test('A01: outer 401 and 403 are auth_required too', () => {
  for (const status of [401, 403]) {
    const snapshot = normalizeQuota({ outerStatus: status, envelope: envelope({}), scopeKey: SCOPE, now: NOW });
    assert.equal(snapshot.state, 'auth_required', `outer ${status}`);
  }
});

test('A02: allowed=true, limit_reached=false, credits.balance=0 is not exhausted', () => {
  const snapshot = normalize(envelope(usagePayload({ nowIso: NOW })), { modelMappingVerified: true });
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.releaseRecommended, true);
  assert.deepEqual(snapshot.credits, { hasCredits: false, balance: 0, ignoredForState: true });
  assert.ok(snapshot.reasons.includes('credits_ignored_for_state'));
});

test('A03: JSON-string body and object body normalize identically except the provenance tag', () => {
  const payload = usagePayload({ nowIso: NOW });
  const fromObject = normalize(envelope(payload), { modelMappingVerified: true });
  const fromString = normalize(envelope(JSON.stringify(payload)), { modelMappingVerified: true });
  const stripReasons = ({ reasons, ...rest }) => rest;
  assert.deepEqual(stripReasons(fromString), stripReasons(fromObject));
  assert.ok(fromString.reasons.includes('inner_body_json_string'));
  assert.ok(fromObject.reasons.includes('inner_body_object'));
});

test('A03: malformed / missing / contradictory bodies are unknown, never available', () => {
  const cases = [
    ['malformed json string', envelope('{not json'), 'inner_body_malformed'],
    ['body missing', envelope(undefined), 'inner_body_missing'],
    ['rate_limit missing', envelope({ plan_type: 'plus' }), 'rate_limit_missing'],
    ['allowed/limit_reached conflict', envelope({ rate_limit: { allowed: true, limit_reached: true } }), 'allowed_limit_reached_conflict'],
    ['flag not boolean', envelope({ rate_limit: { allowed: 'yes', limit_reached: false } }), 'rate_limit_flag_not_boolean'],
    ['window not object', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: 3 } }), 'window_malformed'],
    ['window flag not boolean', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { allowed: 'no', used_percent: 10 } } }), 'window_flag_not_boolean'],
    ['window flag conflict', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { allowed: true, limit_reached: true } } }), 'window_flag_conflict'],
    ['used_percent invalid', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: -1 } } }), 'used_percent_invalid'],
    ['used_percent not a number', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: '10' } } }), 'used_percent_invalid'],
    ['window seconds invalid', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10, limit_window_seconds: 0 } } }), 'limit_window_seconds_invalid'],
    ['window field unrecognized', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10, mystery_limit: true } } }), 'window_field_unrecognized'],
    ['reset_at overflow', envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10, reset_at: 1e308 } } }), 'reset_at_out_of_range'],
    ['inner error without an auth code', envelope({ error: { code: 'weird' } }), 'inner_error_present'],
  ];
  for (const [label, env, reason] of cases) {
    const snapshot = normalize(env, { modelMappingVerified: true });
    assert.equal(snapshot.state, 'unknown', label);
    assert.equal(snapshot.releaseRecommended, false, label);
    assert.ok(snapshot.reasons.includes(reason), `${label}: ${snapshot.reasons.join(',')}`);
  }
});

test('A04: used_percent is "used"; a missing value never reads as 100% remaining', () => {
  const snapshot = normalize(envelope({
    rate_limit: { allowed: true, limit_reached: false, primary_window: { limit_window_seconds: 18000 } },
  }));
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.remaining, null);
});

test('A04: a rounded 100 does not exhaust the scope and does not close the gate', () => {
  const snapshot = normalize(envelope({
    rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100 } },
  }));
  assert.notEqual(snapshot.state, 'exhausted');
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.saturated, true);
  assert.equal(snapshot.releaseRecommended, true);
  assert.equal(snapshot.remaining, 0);
});

test('A04: percentage 100 without any trusted allow/block flag stays unknown', () => {
  const snapshot = normalize(envelope({ rate_limit: { primary_window: { used_percent: 100 } } }));
  assert.equal(snapshot.state, 'unknown');
  assert.notEqual(snapshot.state, 'exhausted');
});

test('A05: bare 429 (outer or inner) is rate limited, not quota evidence', () => {
  const outer = normalizeQuota({ outerStatus: 429, envelope: envelope({}), scopeKey: SCOPE, now: NOW });
  assert.equal(outer.state, 'rate_limited');
  assert.equal(outer.releaseRecommended, false);
  const inner = normalize(envelope({}, 429));
  assert.equal(inner.state, 'rate_limited');
  const payment = normalize(envelope({}, 402));
  assert.equal(payment.state, 'unknown');
});

test('A06: multiple blocking windows must ALL clear; resetAt is the latest of them', () => {
  const firstReset = Math.floor(Date.parse(NOW) / 1000) + 3600;
  const secondReset = firstReset + 7200;
  const both = normalize(envelope({
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_reached: true, reset_at: firstReset },
      secondary_window: { used_percent: 90, limit_reached: true, reset_at: secondReset },
    },
  }));
  assert.equal(both.state, 'exhausted');
  assert.equal(both.blockingWindows.length, 3);
  assert.equal(both.resetAt, new Date(secondReset * 1000).toISOString());
  assert.equal(both.resetConfidence, 'confirmed');

  const oneCleared = normalize(envelope({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 10, limit_reached: false },
      secondary_window: { used_percent: 90, limit_reached: true, reset_at: secondReset },
    },
  }));
  assert.equal(oneCleared.state, 'exhausted');
  assert.equal(oneCleared.resetAt, new Date(secondReset * 1000).toISOString());

  const allCleared = normalize(envelope({
    rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10 }, secondary_window: { used_percent: 90 } },
  }));
  assert.equal(allCleared.state, 'available');
});

test('model-scoped restrictions are conservatively unknown until the mapping is verified', () => {
  const payload = { ...usagePayload({ nowIso: NOW }), model_usage: { 'model-a': { used_percent: 10 } } };
  const unverified = normalize(envelope(payload));
  assert.equal(unverified.state, 'unknown');
  assert.ok(unverified.reasons.includes('model_restriction_unverified'));
  const verifiedNoMatch = normalize(envelope(payload), { modelMappingVerified: true });
  assert.equal(verifiedNoMatch.state, 'unknown');
  assert.ok(verifiedNoMatch.reasons.includes('model_restriction_unrecognized'));
  const verifiedMatch = normalize(envelope(payload), { modelMappingVerified: true, model: 'model-a' });
  assert.equal(verifiedMatch.state, 'available');
});

test('additional_rate_limits uses synthetic ids and never echoes object keys', () => {
  const secretKey = 'SECRET-ACCOUNT-IDENTIFIER-9f8a';
  const payload = {
    ...usagePayload({ nowIso: NOW }),
    additional_rate_limits: { [secretKey]: { limit_reached: true, used_percent: 100 } },
  };
  const snapshot = normalize(envelope(payload), { modelMappingVerified: true });
  assert.equal(snapshot.state, 'exhausted');
  assert.ok(snapshot.observedWindows.some((window) => window.id === 'additional_rate_limits[0]'));
  assert.ok(!JSON.stringify(snapshot).includes(secretKey));
});

test('normalizeQuota never returns raw bodies, headers or unknown fields', () => {
  const marker = 'RAW-SECRET-MARKER-VALUE';
  const snapshot = normalize(envelope({
    ...usagePayload({ nowIso: NOW }),
    note: marker,
    header: { authorization: `Bearer ${marker}` },
  }), { modelMappingVerified: true });
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(marker));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'body'));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'header'));
  assert.deepEqual(validateQuotaSnapshot(snapshot), []);
});

test('INVARIANT: every normalizeQuota state round-trips through validateQuotaSnapshot', () => {
  const cases = [
    ['available', 200, envelope(usagePayload({ nowIso: NOW })), true],
    ['available-string-body', 200, envelope(JSON.stringify(usagePayload({ nowIso: NOW }))), true],
    ['auth_required', 200, envelope({ error: { code: 'token_revoked' } }, 401), true],
    ['rate_limited', 200, envelope({}, 429), true],
    ['unknown', 200, envelope('{oops'), true],
    ['unknown-missing-body', 200, envelope(undefined), true],
    ['unknown-outer-5xx', 503, envelope({}), true],
    ['exhausted', 200, envelope({ rate_limit: { allowed: true, limit_reached: true } }), true],
    ['exhausted-window', 200, envelope({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 100, limit_reached: true, reset_at: 4102444800 } } }), true],
    ['model-unverified', 200, envelope({ ...usagePayload({ nowIso: NOW }), model_usage: { 'model-a': { used_percent: 1 } } }), false],
  ];
  for (const [label, outerStatus, env, modelMappingVerified] of cases) {
    const snapshot = normalizeQuota({ outerStatus, envelope: env, scopeKey: SCOPE, now: NOW, modelMappingVerified });
    assert.ok(QUOTA_STATES.includes(snapshot.state), label);
    const issues = validateQuotaSnapshot(snapshot);
    assert.deepEqual(issues, [], `${label} -> ${snapshot.state}: ${issues.join(',')}`);
  }
});
