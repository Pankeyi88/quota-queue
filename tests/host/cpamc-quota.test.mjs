import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpamcQuotaSource } from '../../host/cpamc-quota.js';
import { validateQuotaSnapshot } from '../../core/quota.mjs';

const NOW = Date.parse('2026-10-19T13:40:00Z');
const baseAccount = {
  auth_index: 'a1', provider: 'codex', plan: 'plus', status: 'available',
  credential_state: 'active', fetched_at: '2026-10-19T13:39:30Z',
};
function bodyWith({ weekly = 77, five = 80, account = {} } = {}) {
  return {
    accounts: [{
      ...baseAccount,
      ...account,
      windows: [
        { id: 'primary', used_percent: 100 - five, remaining_percent: five, reset_at: '2026-10-19T16:10:39Z', window_seconds: 18000 },
        { id: 'secondary', used_percent: 100 - weekly, remaining_percent: weekly, reset_at: '2026-10-25T04:24:55Z', window_seconds: 604800 },
      ],
    }],
    cache_ttl: '30m', cached: false, generated_at: '2026-10-19T13:39:30Z',
  };
}
function sourceFor(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const source = createCpamcQuotaSource({
    baseUrl: 'https://cpa.example', managementKey: 'secret-key', authIndex: 'a1',
    fetchImpl, now: () => NOW, weeklyMinRemaining: 10, ...extra,
  });
  return { source, calls };
}
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });

test('queries the fixed endpoint with the key and returns an available snapshot', async () => {
  const { source, calls } = sourceFor(() => json(200, bodyWith()));
  const snapshot = await source.check();
  assert.deepEqual(validateQuotaSnapshot(snapshot), []);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.releaseRecommended, true);
  assert.equal(snapshot.remaining, 77);
  assert.equal(calls[0].url, 'https://cpa.example/v0/management/plugins/cpa-quota-api-extension/v1/quotas?provider=codex&refresh=true');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret-key');
  assert.equal(JSON.stringify(snapshot).includes('secret-key'), false);
});

test('the weekly gate keeps work blocked at 10% and below', async () => {
  for (const weekly of [0, 5, 9]) {
    const { source } = sourceFor(() => json(200, bodyWith({ weekly })));
    const snapshot = await source.check();
    assert.equal(snapshot.state, 'exhausted', String(weekly));
    assert.deepEqual(validateQuotaSnapshot(snapshot), []);
    assert.ok(snapshot.blockingWindows.some((window) => window.id === 'weekly'));
  }
  for (const weekly of [10, 11]) {
    const { source } = sourceFor(() => json(200, bodyWith({ weekly })));
    assert.equal((await source.check()).state, 'available');
  }
});

test('the five-hour window only has to be non-zero', async () => {
  const zero = sourceFor(() => json(200, bodyWith({ five: 0 }))).source;
  const blocked = await zero.check();
  assert.equal(blocked.state, 'exhausted');
  assert.ok(blocked.blockingWindows.some((window) => window.id === 'five-hour'));
  const one = sourceFor(() => json(200, bodyWith({ five: 1 }))).source;
  assert.equal((await one.check()).state, 'available');
});

test('auth, rate limit, unknown account, malformed body and stale observation never release', async () => {
  const cases = [
    [() => json(401, {}), 'auth_required'],
    [() => json(403, {}), 'auth_required'],
    [() => json(429, {}), 'rate_limited'],
    [() => json(200, { accounts: [] }), 'unknown'],
    [() => json(200, { nope: 1 }), 'unknown'],
    [() => json(200, bodyWith({ account: { status: 'error', error: { upstream_status: 401 } } })), 'auth_required'],
    [() => json(200, bodyWith({ account: { status: 'error', error: { upstream_status: 500 } } })), 'unknown'],
    [() => json(200, bodyWith({ account: { fetched_at: '2026-10-19T13:00:00Z' } })), 'unknown'],
    [() => Promise.reject(new Error('network down')), 'unknown'],
  ];
  for (const [handler, expected] of cases) {
    const { source } = sourceFor(handler);
    const snapshot = await source.check();
    assert.equal(snapshot.state, expected, JSON.stringify(snapshot.reasons));
    assert.equal(snapshot.releaseRecommended, false);
    assert.deepEqual(validateQuotaSnapshot(snapshot), []);
  }
});

test('a transient credential_state=unavailable does not masquerade as auth failure', async () => {
  const { source } = sourceFor(() => json(200, bodyWith({ account: { credential_state: 'unavailable' } })));
  const snapshot = await source.check();
  assert.deepEqual(validateQuotaSnapshot(snapshot), []);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.releaseRecommended, true);
  assert.equal(snapshot.remaining, 77);
  assert.equal(snapshot.observedWindows.length, 2);
  assert.ok(snapshot.reasons.includes('cpamc_credential_unavailable'));
});

test('only credential states that prove auth/permission failure stay auth_required', async () => {
  for (const credential_state of ['disabled', 'unauthorized', 'forbidden']) {
    const { source } = sourceFor(() => json(200, bodyWith({ account: { credential_state } })));
    const snapshot = await source.check();
    assert.equal(snapshot.state, 'auth_required', credential_state);
    assert.equal(snapshot.releaseRecommended, false);
    assert.ok(snapshot.reasons.includes(`cpamc_credential_${credential_state}`));
  }
  const upstreamAuth = sourceFor(() => json(200, bodyWith({
    account: { credential_state: 'unavailable', status: 'error', error: { upstream_status: 401 } },
  }))).source;
  assert.equal((await upstreamAuth.check()).state, 'auth_required');
});

test('an upstream 429 is rate-limited, not an auth failure or unknown', async () => {
  const { source } = sourceFor(() => json(200, bodyWith({
    account: { credential_state: 'unavailable', status: 'error', error: { upstream_status: 429 } },
  })));
  const snapshot = await source.check();
  assert.equal(snapshot.state, 'rate_limited');
  assert.equal(snapshot.releaseRecommended, false);
  assert.ok(snapshot.reasons.includes('cpamc_upstream_rate_limited'));
});

test('a missing authIndex or invalid configuration cannot be constructed', () => {
  for (const override of [
    { baseUrl: 'http://cpa.example' }, { baseUrl: 'https://cpa.example/path' },
    { managementKey: '' }, { authIndex: '' }, { weeklyMinRemaining: 101 }, { fiveHourMinRemaining: -1 },
  ]) {
    assert.throws(() => createCpamcQuotaSource({
      baseUrl: 'https://cpa.example', managementKey: 'k', authIndex: 'a1',
      fetchImpl: async () => json(200, bodyWith()), ...override,
    }));
  }
});
