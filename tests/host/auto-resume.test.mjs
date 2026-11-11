import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoResume, bindingRevisionOf } from '../../host/auto-resume.js';
import { validateQuotaSnapshot } from '../../core/quota.mjs';

const NOW = Date.now();
const SCOPE = 'cpamc:codex:a1';
const REVISION = bindingRevisionOf({
  baseUrl: 'https://cpa.example', authIndex: 'a1',
  weeklyMinRemaining: 10, fiveHourMinRemaining: 0,
});

function inspection() {
  return {
    meta: { id: 's1', version: 4, isSeeded: false, cwd: 'E:\\work' },
    inheritedEventCount: 0,
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { id: 'm1', role: 'user', source: { kind: 'user' } } },
      { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 3, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    ],
  };
}

function availableSnapshot() {
  return {
    scopeKey: SCOPE, state: 'available', source: 'proxy-query',
    observedAt: new Date(NOW).toISOString(), validUntil: new Date(NOW + 60_000).toISOString(),
    modelMappingVerified: false, remaining: 77, unit: 'percent',
    resetAt: null, resetConfidence: null, nextResetAt: null,
    blockingWindows: [], observedWindows: [], saturated: false, credits: null,
    errorClass: null, releaseRecommended: true, reasons: ['cpamc_query'],
  };
}

function payload() {
  return {
    agent: { session: { id: 's1' } },
    turn: 1, step: 1, provider: 'p',
    failure: { code: 'QUOTA', status: 429 },
    signal: new AbortController().signal,
  };
}

function harness({ optIn = true } = {}) {
  const snapshot = availableSnapshot();
  assert.deepEqual(validateQuotaSnapshot(snapshot), []);
  const calls = { inspect: 0, query: 0, next: 0, optIn: [] };
  const auto = createAutoResume({
    resolveInspection: () => ({ inspect: async () => { calls.inspect += 1; return inspection(); } }),
    resolveAgents: () => ({ get: () => ({ status: 'running' }) }),
    getOptIn: (sessionId) => { calls.optIn.push(sessionId); return optIn; },
    quotaSource: {
      configured: true, scopeKey: SCOPE,
      check: async (signal) => { calls.query += 1; assert.equal(signal instanceof AbortSignal, true); return snapshot; },
    },
    bindingRevision: REVISION,
    maxWaitMs: 60_000, maxChecks: 2,
    clock: {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });
  const next = async () => { calls.next += 1; return { kind: 'delegate' }; };
  return { auto, calls, next };
}

test('an authorized live quota failure asks the loop to retry the same step', async () => {
  const { auto, calls, next } = harness();
  try {
    const outcome = await auto.listener(payload(), next);
    assert.deepEqual(outcome, { kind: 'retry' });
    assert.equal(calls.query, 1);
    assert.equal(calls.inspect, 3, 'resolveTask plus inspect before and after the quota query');
    assert.equal(calls.next, 0, 'retry must not delegate');
  } finally {
    await auto.dispose();
  }
});

test('without the durable session switch every failure delegates unchanged', async () => {
  const { auto, calls, next } = harness({ optIn: false });
  try {
    const outcome = await auto.listener(payload(), next);
    assert.deepEqual(outcome, { kind: 'delegate' });
    assert.equal(calls.query, 0);
    assert.equal(calls.inspect, 0);
    assert.equal(calls.next, 1);
  } finally {
    await auto.dispose();
  }
});

test('non-quota failures and closed adapters never query', async () => {
  const { auto, calls, next } = harness();
  try {
    const nonQuota = { ...payload(), failure: { code: 'TIMEOUT', status: 504 } };
    assert.deepEqual(await auto.listener(nonQuota, next), { kind: 'delegate' });
    await auto.dispose();
    assert.deepEqual(await auto.listener(payload(), next), { kind: 'delegate' });
    assert.equal(calls.query, 0);
  } finally {
    await auto.dispose();
  }
});
