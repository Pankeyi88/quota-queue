import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../../host/config.js';
import { ROUTE, createSession } from './harness.mjs';

const QUOTA = {
  kind: 'cpamc',
  baseUrl: 'https://cpa.example.com',
  managementKeyEnv: 'QQ_TEST_CPAMC_KEY',
  authIndex: 'test-auth-index',
};

function accountBody(weekly = 77, five = 80) {
  const now = new Date().toISOString();
  return {
    accounts: [{
      auth_index: QUOTA.authIndex, provider: 'codex', plan: 'plus', status: 'available',
      credential_state: 'active', fetched_at: now,
      windows: [
        { id: 'primary', used_percent: 100 - five, remaining_percent: five, reset_at: now, window_seconds: 18000 },
        { id: 'secondary', used_percent: 100 - weekly, remaining_percent: weekly, reset_at: now, window_seconds: 604800 },
      ],
    }],
    generated_at: now, cached: false,
  };
}

test('quotaSource config is strict and stores only an env var name', () => {
  const parsed = parseConfig({ quotaSource: QUOTA });
  assert.equal(parsed.quotaSource.managementKeyEnv, 'QQ_TEST_CPAMC_KEY');
  assert.equal(parsed.quotaSource.weeklyMinRemaining, 10);
  assert.equal(parsed.quotaSource.fiveHourMinRemaining, 0);
  for (const bad of [
    { ...QUOTA, managementKey: 'secret' },
    { ...QUOTA, managementKeyEnv: 'not-a-name' },
    { ...QUOTA, baseUrl: 'http://cpa.example.com' },
    { ...QUOTA, baseUrl: 'https://cpa.example.com/path' },
    { ...QUOTA, kind: 'other' },
    { ...QUOTA, authIndex: 'has space' },
    { ...QUOTA, weeklyMinRemaining: 101 },
    { ...QUOTA, extra: 1 },
  ]) {
    assert.throws(() => parseConfig({ quotaSource: bad }), TypeError, JSON.stringify(bad));
  }
});

test('a configured quota source enables only quotaCheck and reports weekly/five-hour values', async () => {
  const previous = process.env.QQ_TEST_CPAMC_KEY;
  const previousFetch = globalThis.fetch;
  process.env.QQ_TEST_CPAMC_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 200, ok: true, async json() { return accountBody(); } };
  };
  try {
    const session = await createSession({
      config: { storageBackend: 'json', routes: [ROUTE], quotaSource: QUOTA },
    });
    const initial = (await session.call('bootstrap', {})).data;
    assert.equal(initial.capabilities.quotaCheck, true);
    assert.equal(initial.capabilities.execution, false);
    assert.equal(initial.capabilities.autoResume, false);
    assert.equal(initial.configuration.reasons.includes('quota_query_auth_contract_unverified'), false);
    assert.equal(initial.configuration.reasons.includes('exclusive_execution_ownership_unproven'), true);
    assert.equal(initial.quota.configured, true);
    assert.equal(initial.quota.state, null);
    assert.equal(calls, 0, 'bootstrap never performs a network query');

    const checked = await session.call('checkQuota', {});
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.data.quota.state, 'available');
    assert.equal(checked.data.quota.weeklyRemaining, 77);
    assert.equal(checked.data.quota.fiveHourRemaining, 80);
    assert.equal(JSON.stringify(checked.data).includes('test-key'), false);
    assert.equal(calls, 1);
    await session.service.dispose();
  } finally {
    if (previous === undefined) delete process.env.QQ_TEST_CPAMC_KEY; else process.env.QQ_TEST_CPAMC_KEY = previous;
    globalThis.fetch = previousFetch;
  }
});

test('autoResume requires the source and enables the per-session switch only then', async () => {
  assert.throws(() => parseConfig({ autoResume: { enabled: true } }), /quotaSource/);
  const previous = process.env.QQ_TEST_CPAMC_KEY;
  const previousFetch = globalThis.fetch;
  process.env.QQ_TEST_CPAMC_KEY = 'test-key';
  globalThis.fetch = async () => ({ status: 200, ok: true, async json() { return accountBody(); } });
  try {
    const session = await createSession({
      config: {
        storageBackend: 'json', routes: [ROUTE], quotaSource: QUOTA,
        autoResume: { enabled: true, maxWaitMs: 120_000, maxChecks: 2 },
      },
    });
    const view = (await session.call('bootstrap', {})).data;
    assert.equal(view.capabilities.autoResume, true);
    assert.equal(view.capabilities.execution, false);
    assert.notEqual(session.service.getAutoResume(), null);
    const enabled = await session.call('setSessionOptIn', { sessionId: 's-1', enabled: true });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.equal(enabled.data.sessionOptIns['s-1'], true);
    const disabled = await session.call('setSessionOptIn', { sessionId: 's-1', enabled: false });
    assert.equal(disabled.data.sessionOptIns['s-1'], false);
    await session.service.dispose();
  } finally {
    if (previous === undefined) delete process.env.QQ_TEST_CPAMC_KEY; else process.env.QQ_TEST_CPAMC_KEY = previous;
    globalThis.fetch = previousFetch;
  }
});

test('a configured source without its environment key stays unconfigured', async () => {
  const previous = process.env.QQ_TEST_CPAMC_KEY;
  delete process.env.QQ_TEST_CPAMC_KEY;
  try {
    const session = await createSession({
      config: { storageBackend: 'json', routes: [ROUTE], quotaSource: QUOTA },
    });
    const view = (await session.call('bootstrap', {})).data;
    assert.equal(view.capabilities.quotaCheck, false);
    assert.ok(view.configuration.reasons.includes('quota_query_auth_contract_unverified'));
    assert.ok(view.configuration.reasons.includes('management_key_missing'));
    const checked = await session.call('checkQuota', {});
    assert.equal(checked.ok, false);
    assert.equal(checked.error.code, 'configuration_incomplete');
    await session.service.dispose();
  } finally {
    if (previous !== undefined) process.env.QQ_TEST_CPAMC_KEY = previous;
  }
});
