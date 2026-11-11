/**
 * OPTIONAL real-Cordis smoke test.
 *
 * Unlike every other file under tests/host, this one imports the REAL
 * `@deepseek-ai/cordis` and `@deepseek-ai/dsh-typert-protocol` packages from
 * the installed DSH module root, so it covers the seam the fake harness cannot:
 *
 *  1. the PRODUCTION entry (`index.js`, not `host/plugin.js`) really activates
 *     on a Cordis Context once `storage` is provided, registering the
 *     `quotaQueue` service through its lazy Host-protocol import;
 *  2. the real `Remote` decorator marks `dispatch` such that
 *     `remoteMethods(service)` reports it;
 *  3. a Gateway-shaped receiver
 *     (`ctx.extend({invocation}).get('quotaQueue')`) reaches `dispatch` with
 *     `this.ctx.invocation` populated — the Cordis contextual-proxy path that
 *     makes `#private` members unusable;
 *  4. a plain `ctx.get('quotaQueue').dispatch(...)` call has no invocation and
 *     is refused;
 *  5. disposing the Cordis root closes the storage unit.
 *
 * It performs no network access, reads no credential or profile data, and
 * skips cleanly when the module root is absent.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;

const available = existsSync(`${MODULE_ROOT}/@deepseek-ai/cordis/lib/index.js`)
  && existsSync(`${MODULE_ROOT}/@deepseek-ai/dsh-typert-protocol/lib/index.js`);

/** Fake storage medium: one durable global per named unit, one open each. */
function createMedium() {
  const state = { units: new Map(), opens: 0, closes: 0, activeOpens: 0 };
  const kv = {
    async open(descriptor) {
      assert.ok(['quota_queue_v1', 'quota_recovery_plan_v1'].includes(descriptor.name));
      assert.equal(descriptor.hasGlobal, true);
      const name = descriptor.name;
      state.opens += 1;
      state.activeOpens += 1;
      let closed = false;
      return {
        async loadAll() { return { tables: {}, global: state.units.has(name) ? structuredClone(state.units.get(name)) : null }; },
        async setGlobal(value) { state.units.set(name, structuredClone(value)); },
        async close() {
          if (closed) return;
          closed = true;
          state.activeOpens -= 1;
          state.closes += 1;
        },
      };
    },
  };
  return { state, storage: { backend: { get: (name) => (name === 'json' ? { kv } : undefined) } } };
}

const ROUTE = { id: 'codex-common', label: 'Common Codex', provider: 'westlake-hpc', model: 'deepseek-flash', credentialRef: 'common-codex-ref' };

test('real Cordis + Typert protocol: activation, Remote marker and contextual receiver', { skip: available ? false : 'DSH module root not found' }, async () => {
  const resolverUrl = new URL('./resolver.mjs', import.meta.url);
  register(resolverUrl.href, pathToFileURL(`${process.cwd()}/`).href);
  await new Promise((resolve) => setImmediate(resolve));

  const { Context } = await import('@deepseek-ai/cordis');
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol');
  // The PRODUCTION entry, not host/plugin.js: this is the module the Loader row
  // imports, and the one the P3 install defect broke.
  const plugin = await import('../../index.js');

  const medium = createMedium();
  const operator = { id: 'operator-peer', principal: { kind: 'owner' } };
  const root = new Context();

  await root.plugin({
    name: 'smoke-infra',
    apply(ctx) {
      ctx.provide('storage', medium.storage);
      ctx.provide('connection', { operator });
    },
  });
  await root.plugin(plugin, { storageBackend: 'json', routes: [ROUTE] });

  // 1. The service is registered under the quotaQueue key.
  const service = root.get('quotaQueue');
  assert.ok(service !== undefined && service !== null, 'quotaQueue service must be registered');
  assert.equal(medium.state.opens, 2, 'one legacy unit and one recovery-plan unit');
  assert.equal(medium.state.activeOpens, 2);

  // 2. The real Remote marker is on the prototype, discovered by the protocol.
  const original = Reflect.get(service, Symbol.for('cordis.original')) ?? service;
  const markers = remoteMethods(original);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].method, 'dispatch');
  assert.equal(markers[0].invocation.kind, 'direct');

  const request = { version: 1, op: 'bootstrap', requestId: 'smoke-1', payload: {} };
  const signal = new AbortController().signal;

  // 3. A plain call through the calling context carries no invocation.
  const direct = await service.dispatch(request, signal);
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, 'not_remote');

  // 4. The Gateway-shaped receiver derives this.ctx.invocation and succeeds.
  const invocation = {
    service: 'quotaQueue',
    request: { namespace: 'quotaQueue', method: 'dispatch', args: { request } },
    peer: operator,
    signal,
    uplink() { throw new Error('no uplink'); },
  };
  const receiverContext = root.extend({ invocation });
  assert.notEqual(receiverContext.get('quotaQueue'), service, 'the receiver is a contextual proxy, not the instance');
  const callReceiver = receiverContext.get('quotaQueue');
  const result = await callReceiver.dispatch(request, signal);
  assert.equal(result.ok, true, `contextual dispatch failed: ${JSON.stringify(result)}`);
  assert.equal(result.data.version, 1);
  assert.equal(result.data.configuration.ready, false);
  assert.deepEqual(result.data.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.equal(result.data.routes[0].available, false);
  assert.equal(result.data.routes[0].selectable, true);

  // A write through the same receiver persists and stays unexecuted.
  const addRequest = {
    version: 1,
    op: 'addManual',
    requestId: 'smoke-2',
    payload: { prompt: 'smoke', workspaceId: 'ws-1', routeId: ROUTE.id },
  };
  const addResult = await root.extend({
    invocation: { ...invocation, request: { namespace: 'quotaQueue', method: 'dispatch', args: { request: addRequest } } },
  }).get('quotaQueue').dispatch(addRequest, signal);
  // No workspace registry is provided in this smoke test, so the write is
  // refused with capability_missing rather than silently succeeding.
  assert.equal(addResult.ok, false);
  assert.equal(addResult.error.code, 'capability_missing');

  // A plan mutation travels the same real contextual receiver, persists in its
  // own unit and still grants no execution capability.
  const planRequest = {
    version: 1,
    op: 'planPause',
    requestId: 'smoke-3',
    payload: { paused: true, expectedRevision: 0 },
  };
  const planResult = await root.extend({
    invocation: { ...invocation, request: { namespace: 'quotaQueue', method: 'dispatch', args: { request: planRequest } } },
  }).get('quotaQueue').dispatch(planRequest, signal);
  assert.equal(planResult.ok, true, `plan dispatch failed: ${JSON.stringify(planResult)}`);
  assert.equal(planResult.data.recoveryPlan.revision, 1);
  assert.equal(planResult.data.recoveryPlan.paused, true);
  assert.deepEqual(planResult.data.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.equal(medium.state.units.has('quota_recovery_plan_v1'), true);
  assert.equal(medium.state.units.has('quota_queue_v1'), false);

  // 5. Unloading the root runs the plugin disposer and releases both units.
  await root.fiber.dispose();
  assert.equal(medium.state.closes, 2);
  assert.equal(medium.state.activeOpens, 0);
});
