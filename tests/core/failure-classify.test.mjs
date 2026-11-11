/**
 * Failure classification: structured codes only, allowlisted echo, conflicts
 * that suppress automatic ticket creation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, KNOWN_CODES } from '../../core/index.mjs';

test('normalized quota codes create a ticket', () => {
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA']) {
    const decision = classifyFailure({ code });
    assert.equal(decision.class, 'quota', code);
    assert.equal(decision.createsQuotaTicket, true, code);
    assert.equal(decision.quotaEvidence, 'normalized_code', code);
    assert.equal(decision.code, code);
  }
});

test('REGRESSION: a quota code combined with 401/403 never creates a ticket', () => {
  for (const status of [401, 403]) {
    const decision = classifyFailure({ code: 'QUOTA', status });
    assert.equal(decision.class, 'auth_required', `status ${status}`);
    assert.equal(decision.createsQuotaTicket, false);
    assert.equal(decision.conflict, 'quota_code_with_auth_status');
    assert.equal(decision.code, null, 'the contradicting quota code is not echoed');
  }
});

test('REGRESSION: a quota code with an incompatible status degrades to unknown', () => {
  for (const status of [400, 404, 500, 503]) {
    const decision = classifyFailure({ code: 'QUOTA', status });
    assert.equal(decision.class, 'unknown', `status ${status}`);
    assert.equal(decision.createsQuotaTicket, false);
    assert.equal(decision.conflict, 'quota_code_with_incompatible_status');
  }
});

test('a quota code with 429 or no status still creates a ticket', () => {
  assert.equal(classifyFailure({ code: 'QUOTA', status: 429 }).createsQuotaTicket, true);
  assert.equal(classifyFailure({ code: 'QUOTA' }).createsQuotaTicket, true);
});

test('A05: a bare 429 is a rate limit, not quota evidence', () => {
  const decision = classifyFailure({ status: 429 });
  assert.equal(decision.class, 'rate_limit');
  assert.equal(decision.createsQuotaTicket, false);
  assert.equal(decision.retryableNatively, true);
});

test('A10: unknown or secret-shaped codes are never echoed', () => {
  const secret = 'sk-live-abcdef1234567890';
  const decision = classifyFailure({ code: secret });
  assert.equal(decision.class, 'unknown');
  assert.equal(decision.code, null);
  assert.equal(decision.codeRecognized, false);
  assert.ok(!decision.safeSummary.includes(secret));
  assert.ok(!decision.safeSummary.includes('sk-live'));
});

test('only allowlisted codes are ever returned', () => {
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'AUTH', 'ABORTED', 'TIMEOUT', 'TRANSPORT', 'SERVER', 'INVALID_ARGS', 'NO_ADAPTER', 'CONTEXT_WINDOW_EXCEEDED']) {
    const decision = classifyFailure({ code });
    assert.ok(KNOWN_CODES.includes(decision.code), code);
  }
  // token_revoked is on the auth allowlist, so it is normalized and echoed.
  const known = classifyFailure({ code: 'token_revoked' });
  assert.equal(known.class, 'auth_required');
  assert.equal(known.code, 'TOKEN_REVOKED');
  // Anything off the allowlist is dropped, never echoed.
  for (const code of ['insufficient_quota', 'Weird', 'x'.repeat(120)]) {
    const decision = classifyFailure({ code });
    assert.equal(decision.code, null, code);
    assert.equal(decision.codeRecognized, false, code);
  }
});

test('the pi-ai fallback code is transient, bounded by the ordinary caps', () => {
  // The adapter emits PI_AI_ERROR only after it failed to recognize auth, quota,
  // 429, 4xx, 5xx, timeout or transport text; upstream overloads land here.
  const decision = classifyFailure({ code: 'PI_AI_ERROR' });
  assert.equal(decision.class, 'transient');
  assert.equal(decision.code, 'PI_AI_ERROR');
  assert.equal(decision.codeRecognized, true);
  assert.equal(decision.createsQuotaTicket, false);
  assert.equal(decision.retryableNatively, true);
  // A contradicting status is handled by the continuation policy itself
  // (decideError checks 401/403 before the code) and is covered there.
});

test('documented code taxonomy maps to the expected classes', () => {
  const cases = [
    [['AUTH', null], 'auth_required'],
    [['MISSING_CREDENTIAL', null], 'auth_required'],
    [[null, 401], 'auth_required'],
    [[null, 403], 'auth_required'],
    [['ABORTED', null], 'user_cancelled'],
    [['CANCELLED', null], 'user_cancelled'],
    [['TIMEOUT', null], 'transient'],
    [['TRANSPORT', null], 'transient'],
    [['SERVER', null], 'transient'],
    [[null, 503], 'transient'],
    [['CONTEXT_WINDOW_EXCEEDED', null], 'request_error'],
    [['INVALID_ARGS', null], 'request_error'],
    [['NO_ADAPTER', null], 'configuration'],
    [[null, 402], 'request_error'],
    [[null, null], 'unknown'],
    [[null, 418], 'request_error'],
  ];
  for (const [[code, status], expected] of cases) {
    const decision = classifyFailure({ code, status });
    assert.equal(decision.class, expected, `${code}/${status}`);
    assert.equal(decision.createsQuotaTicket, false, `${code}/${status}`);
  }
});
