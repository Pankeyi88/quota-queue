/**
 * Real-Cordis startup-order simulation: a workspace registry that becomes
 * ACTIVE only after this plugin activated.
 *
 * The P3 defect was a one-shot `ctx.get('workspaceRegistry')` at activation.
 * Recreating it needs the REAL service lifecycle, not a fake map: a
 * `Service` subclass whose `[Service.init]` is deferred is registered but not
 * ACTIVE, and `ctx.get(name)` returns `undefined` for a non-ACTIVE provider.
 *
 * This test drives one service instance through:
 *   1. registry absent at activation  -> unavailable, and the queue still works
 *      enough to report the reason;
 *   2. registry registered but its init still pending -> still unavailable, no
 *      crash;
 *   3. init released -> the SAME instance sees the workspaces, while retired
 *      reservation operations remain disabled;
 *   4. provider disposed (temporary removal) -> unavailable again;
 *   5. a replacement registry mounted -> the new one is read.
 *
 * Real Cordis and the real Typert protocol come from the installed DSH module
 * root through the shared resolver hook; no network, no host installation is
 * touched.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;
const HOST_AVAILABLE = existsSync(`${MODULE_ROOT}/@deepseek-ai/cordis/lib/index.js`)
  && existsSync(`${MODULE_ROOT}/@deepseek-ai/dsh-typert-protocol/lib/index.js`);

const ROUTE = { id: 'codex-common', label: 'Common Codex', provider: 'westlake-hpc', model: 'deepseek-flash', credentialRef: 'common-codex-ref' };

/** One registry entity shaped like the real projection surface. */
function workspaceEntity(id, path, title) {
  return { id, path, title, status: async () => 'ok' };
}

/** A fake storage medium: one durable global slot, one open at a time. */
function createMedium() {
  const state = { global: null, opens: 0, closes: 0, activeOpens: 0 };
  const kv = {
    async open(descriptor) {
      assert.equal(descriptor.name, 'quota_queue_v1');
      state.opens += 1;
      state.activeOpens += 1;
      let closed = false;
      return {
        async loadAll() { return { tables: {}, global: structuredClone(state.global) }; },
        async setGlobal(value) { state.global = structuredClone(value); },
        async close() { if (closed) return; closed = true; state.activeOpens -= 1; state.closes += 1; },
      };
    },
  };
  return { state, storage: { backend: { get: (name) => (name === 'json' ? { kv } : undefined) } } };
}

test('a registry that activates after this plugin is observed without re-activation', { skip: HOST_AVAILABLE ? false : 'DSH module root not found' }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(`${process.cwd()}/`).href);
  await new Promise((resolve) => setImmediate(resolve));

  const { Context, Service } = await import('@deepseek-ai/cordis');
  const plugin = await import('../../index.js');

  const medium = createMedium();
  const operator = { id: 'operator-peer', principal: { kind: 'owner' } };
  const ctx = new Context();
  await ctx.plugin({
    name: 'late-registry-infra',
    apply(inner) {
      inner.provide('storage', medium.storage);
      inner.provide('connection', { operator });
    },
  });
  await ctx.plugin(plugin, { storageBackend: 'json', routes: [ROUTE] });

  let counter = 0;
  const dispatch = async (op, payload) => {
    counter += 1;
    const request = { version: 1, op, requestId: `late-${counter}`, payload: payload === undefined ? {} : payload };
    const signal = new AbortController().signal;
    const invocation = {
      service: 'quotaQueue',
      request: { namespace: 'quotaQueue', method: 'dispatch', args: { request } },
      peer: operator,
      signal,
      uplink() { throw new Error('no uplink'); },
    };
    return ctx.extend({ invocation }).get('quotaQueue').dispatch(request, signal);
  };

  // 1. No registry at activation.
  const absent = await dispatch('bootstrap', {});
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.data.workspaces, []);
  assert.ok(absent.data.configuration.reasons.includes('workspace_registry_unavailable'));

  // 2. A real Service subclass, registered but with its init deferred.
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  class LateWorkspaceRegistry extends Service {
    constructor(inner, config) {
      super(inner, 'workspaceRegistry');
    }
    async [Service.init]() {
      await gate;
    }
    list() { return [workspaceEntity('ws-late', 'E:/ws/late', 'late')]; }
    get(id) { return this.list().find((workspace) => workspace.id === id); }
  }
  const provider = ctx.plugin(LateWorkspaceRegistry);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.get('workspaceRegistry'), undefined, 'a non-ACTIVE provider must stay invisible');
  const pending = await dispatch('bootstrap', {});
  assert.equal(pending.ok, true);
  assert.deepEqual(pending.data.workspaces, []);
  assert.ok(pending.data.configuration.reasons.includes('workspace_registry_unavailable'));

  // 3. Init released: the same service instance must pick it up.
  releaseGate();
  await provider;
  assert.notEqual(ctx.get('workspaceRegistry'), undefined, 'the provider must now be ACTIVE');

  const active = await dispatch('bootstrap', {});
  assert.equal(active.ok, true);
  assert.deepEqual(active.data.workspaces, [{ id: 'ws-late', name: 'late', path: 'E:/ws/late', available: true }]);
  assert.equal(active.data.configuration.reasons.includes('workspace_registry_unavailable'), false);

  const retired = await dispatch('addManual', { prompt: 'after late registry', workspaceId: 'ws-late', routeId: ROUTE.id });
  assert.equal(retired.ok, false);
  assert.equal(retired.error.code, 'capability_missing');
  assert.equal(active.data.configuration.ready, false);
  assert.deepEqual(active.data.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.deepEqual(active.data.tasks, []);
  assert.equal(medium.state.global, null, 'registry activation must not persist a reservation');

  // 4. Temporary removal.
  await provider.dispose();
  assert.equal(ctx.get('workspaceRegistry'), undefined);
  const removed = await dispatch('bootstrap', {});
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.data.workspaces, []);
  assert.ok(removed.data.configuration.reasons.includes('workspace_registry_unavailable'));
  const refused = await dispatch('addManual', { prompt: 'p', workspaceId: 'ws-late', routeId: ROUTE.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'capability_missing');

  // 5. Replacement.
  await ctx.plugin({
    name: 'replacement-workspace',
    apply(inner) {
      inner.provide('workspaceRegistry', {
        list: () => [workspaceEntity('ws-replaced', 'E:/ws/new', 'new')],
        get: (id) => (id === 'ws-replaced' ? workspaceEntity('ws-replaced', 'E:/ws/new', 'new') : undefined),
      });
    },
  });
  const replaced = await dispatch('bootstrap', {});
  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.data.workspaces.map((workspace) => workspace.id), ['ws-replaced']);
  assert.equal(replaced.data.configuration.reasons.includes('workspace_registry_unavailable'), false);
  const edit = await dispatch('editPending', { id: 'old-item', title: 'cannot edit' });
  assert.equal(edit.ok, false);
  assert.equal(edit.error.code, 'capability_missing');
  const cancel = await dispatch('cancelQueued', { id: 'old-item' });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.error.code, 'not_cancellable');
  assert.equal(medium.state.global, null);

  await ctx.fiber.dispose();
  assert.equal(medium.state.closes, 1);
  assert.equal(medium.state.activeOpens, 0);
});
