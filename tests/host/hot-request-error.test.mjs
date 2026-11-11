/**
 * Hot request-error adapter: waterfall contract, delegation and disposal.
 *
 * The adapter never vetoes other policies: it returns a retry verdict only
 * after its coordinator authorizes one, and otherwise calls `next()` exactly
 * once. The second half runs the REAL Cordis waterfall.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHotRequestErrorAdapter } from '../../host/hot-request-error.js';

const IDENTITY = {
  sessionId: 's1', rootMessageId: 'root-1', generation: 'g1',
  turn: 1, step: 2, scopeId: 'quota', bindingRevision: 'binding-1',
};
const payload = (overrides = {}) => ({
  agent: { id: 's1' }, turn: 1, step: 2, provider: 'westlake-hpc',
  failure: { code: 'QUOTA' }, retryPolicy: { mode: 'normal' },
  signal: new AbortController().signal, ...overrides,
});
function coordinator(decision = { kind: 'retry' }) {
  const calls = [];
  return {
    calls,
    async waitForRetry(request) { calls.push(request); return decision; },
  };
}
const adapterFor = (co, resolveTask = () => IDENTITY) => createHotRequestErrorAdapter({ coordinator: co, resolveTask });

test('an unmapped or malformed identity delegates without asking the coordinator', async () => {
  for (const resolver of [() => null, () => ({}), () => ({ ...IDENTITY, turn: -1 }), () => ({ ...IDENTITY, extra: 1 }), () => { throw new Error('private'); }]) {
    const co = coordinator();
    const adapter = adapterFor(co, resolver);
    let calls = 0;
    assert.equal(await adapter.listener(payload(), () => { calls += 1; return 'inner'; }), 'inner');
    assert.equal(calls, 1);
    assert.equal(co.calls.length, 0);
    await adapter.dispose();
  }
});

test('only an authorized retry verdict is returned; other verdicts delegate once', async () => {
  const co = coordinator({ kind: 'retry' });
  const retry = adapterFor(co);
  let called = 0;
  assert.deepEqual(await retry.listener(payload(), () => { called += 1; return 'inner'; }), { kind: 'retry' });
  assert.equal(called, 0);
  assert.equal(co.calls[0].sessionId, 's1');
  assert.equal(co.calls[0].turn, 1);
  assert.equal(co.calls[0].step, 2);
  assert.ok(co.calls[0].signal instanceof AbortSignal);
  await retry.dispose();

  for (const decision of [{ kind: 'stop', reason: 'duplicate' }, { kind: 'stop', reason: 'cancelled' }, null, 'retry', {}]) {
    const adapter = adapterFor(coordinator(decision));
    let calls = 0;
    assert.equal(await adapter.listener(payload(), () => { calls += 1; return 'inner'; }), 'inner');
    assert.equal(calls, 1, JSON.stringify(decision));
    await adapter.dispose();
  }
});

test('adapter and coordinator failures delegate instead of swallowing the chain', async () => {
  const failing = createHotRequestErrorAdapter({
    coordinator: { waitForRetry: async () => { throw new Error('port broke'); } },
    resolveTask: () => IDENTITY,
  });
  let calls = 0;
  assert.equal(await failing.listener(payload(), () => { calls += 1; return 'inner'; }), 'inner');
  assert.equal(calls, 1);
  await failing.dispose();
});

test('an aborted turn never waits; disposal prevents a late retry and drains', async () => {
  let release;
  const co = { calls: [], waitForRetry() { return new Promise((resolve) => { release = resolve; }); } };
  const adapter = adapterFor(co);
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  assert.equal(await adapter.listener(payload({ signal: aborted.signal }), () => { calls += 1; return 'inner'; }), 'inner');
  assert.equal(co.calls.length, 0);
  calls = 0;

  let pending = adapter.listener(payload(), () => { calls += 1; return 'inner'; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.activeCount(), 1);
  release({ kind: 'retry' });
  assert.deepEqual(await pending, { kind: 'retry' });
  assert.equal(calls, 0);
  assert.equal(adapter.isClosed(), false);

  pending = adapter.listener(payload({ step: 3 }), () => { calls += 1; return 'inner'; });
  await new Promise((resolve) => setImmediate(resolve));
  const disposing = adapter.dispose();
  release({ kind: 'retry' });
  await disposing;
  assert.equal(await pending, 'inner');
  assert.equal(adapter.isClosed(), true);
  assert.equal(adapter.activeCount(), 0);
  assert.equal(await adapter.listener(payload({ step: 4 }), () => 'after'), 'after');
});

test('construction requires a coordinator and a trusted resolver', () => {
  assert.throws(() => createHotRequestErrorAdapter({ resolveTask: () => null }), /coordinator/);
  assert.throws(() => createHotRequestErrorAdapter({ coordinator: coordinator() }), /resolveTask/);
  assert.throws(() => createHotRequestErrorAdapter(null), /input object/);
});

const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;
const cordisAvailable = existsSync(`${MODULE_ROOT}/@deepseek-ai/cordis/lib/index.js`);

test('REAL Cordis: retry is adopted, delegation reaches the inner policy, unload removes the listener', { skip: cordisAvailable ? false : 'Cordis not found' }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(`${process.cwd()}/`).href);
  await new Promise((resolve) => setImmediate(resolve));
  const { Context } = await import('@deepseek-ai/cordis');
  const root = new Context();
  const co = coordinator({ kind: 'retry' });
  let inner = 0;
  let always = true;

  // Outermost policy (like the shipped always-retry): awaits downstream, adopts
  // a retry decision, otherwise falls back to its own retry.
  await root.plugin({
    name: 'outer-policy',
    apply(ctx) {
      ctx.on('agent/request-error', async (p, next) => {
        if (!always) return next();
        const decision = await next();
        return decision !== null && typeof decision === 'object' && decision.kind === 'retry'
          ? decision
          : { kind: 'retry', source: 'outer-fallback' };
      }, { prepend: true });
    },
  });
  // The real adapter mounted in its own plugin with effect-owned disposal.
  await root.plugin({
    name: 'hot-adapter',
    apply(ctx) {
      const adapter = createHotRequestErrorAdapter({ coordinator: co, resolveTask: () => IDENTITY });
      ctx.on('agent/request-error', adapter.listener);
      ctx.effect(() => async () => { await adapter.dispose(); }, 'dispose-hot-adapter');
    },
  });

  const innerNext = () => { inner += 1; return undefined; };
  const dispatch = () => root.waterfall('agent/request-error', payload(), innerNext);

  // Adapter authorizes: its retry is the downstream decision the outer adopts.
  assert.deepEqual(await dispatch(), { kind: 'retry' });
  assert.equal(inner, 0);

  // Adapter declines: delegation reaches the inner terminal policy, and the
  // always-style outer still applies its own fallback — the adapter cannot veto it.
  co.waitForRetry = async () => ({ kind: 'stop', reason: 'duplicate' });
  assert.deepEqual(await dispatch(), { kind: 'retry', source: 'outer-fallback' });
  assert.equal(inner, 1);

  // Without the always-style outer, a decline is plain delegation to inner next.
  always = false;
  inner = 0;
  assert.equal(await dispatch(), undefined);
  assert.equal(inner, 1);

  // Unloading the owning fiber removes both listeners: only the inner next runs.
  inner = 0;
  await root.fiber.dispose();
  const before = co.calls.length;
  assert.equal(await dispatch(), undefined);
  assert.equal(inner, 1);
  assert.equal(co.calls.length, before, 'no coordinator call after unload');
});
