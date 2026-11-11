/**
 * Production assembly: the REAL `index.js` plugin entry, the REAL service, the
 * REAL storage units and the REAL Cordis event plumbing — with fake host
 * services only where the product services would live.
 *
 * It proves three things the fake-driver tests cannot:
 *  1. `service.init` mounts the driver and opens the third unit;
 *  2. a `session/event` delivered through the agent-scoped Cordis context
 *     registered by `host/plugin.js` really creates a durable ticket;
 *  3. a second instance that cannot bind the owner port is passive and opens
 *     no continuation unit (zero writes on the last-write-wins medium).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;
const available = existsSync(`${MODULE_ROOT}/@deepseek-ai/cordis/lib/index.js`)
  && existsSync(`${MODULE_ROOT}/@deepseek-ai/dsh-typert-protocol/lib/index.js`);

const UNIT_NAMES = ['quota_queue_v1', 'quota_recovery_plan_v1', 'quota_continue_v1'];

function createMedium() {
  const state = { units: new Map(), opens: [], active: new Map(), saves: [] };
  const kv = {
    async open(descriptor) {
      assert.ok(UNIT_NAMES.includes(descriptor.name), descriptor.name);
      const name = descriptor.name;
      if ((state.active.get(name) ?? 0) > 0) throw new Error('unit already open');
      state.active.set(name, 1);
      state.opens.push(name);
      let closed = false;
      return {
        async loadAll() { return { tables: {}, global: state.units.has(name) ? structuredClone(state.units.get(name)) : null }; },
        async setGlobal(value) { state.saves.push(name); state.units.set(name, structuredClone(value)); },
        async close() { if (closed) return; closed = true; state.active.delete(name); },
      };
    },
  };
  return { state, storage: { backend: { get: (name) => (name === 'json' ? { kv } : undefined) } } };
}

const ROUTE = { id: 'codex-common', label: 'Common Codex', provider: 'westlake-hpc', model: 'deepseek-flash', credentialRef: 'common-codex-ref' };
const SESSION_ID = 'session-auto-1';

function inspection() {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'm1', role: 'user', content: [], source: { kind: 'user' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT' } } } },
  ];
  return {
    meta: { id: SESSION_ID, version: 4, isSeeded: false, cwd: 'E:/ws/one' },
    inheritedEventCount: 0,
    events: events.map((event, seq) => ({ seq, ...event })),
  };
}

async function freePort() {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('production entry mounts the driver and a real session event persists a ticket', { skip: available ? false : 'DSH module root not found', timeout: 20000 }, async (t) => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(`${process.cwd()}/`).href);
  const { Context } = await import('@deepseek-ai/cordis');
  const plugin = await import('../../index.js');
  // The owner port is a GLOBAL constant. When a real DSH instance holds it,
  // this in-process assembly cannot become the owner, so skip instead of
  // pretending. The driver-level tests cover the same logic on a free port.
  const ownerPortFree = await (async () => {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen({ port: 43_187, host: '127.0.0.1' }, () => server.close(() => resolve(true)));
    });
  })();
  if (!ownerPortFree) { t.skip('owner port 43187 is held by a running DSH'); return; }
  const port = 43_187;
  const medium = createMedium();
  const operator = { id: 'operator-peer', principal: { kind: 'owner' } };

  const agentEvents = new EventEmitter();
  const agent = {
    id: SESSION_ID,
    session: { id: SESSION_ID },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { on: (type, handler) => { agentEvents.on(type, handler); return () => agentEvents.off(type, handler); } },
  };
  const prompts = [];
  const controller = {
    async inspect(sessionId) { assert.equal(sessionId, SESSION_ID); return structuredClone(inspection()); },
    async prompt(request) { prompts.push(request); return { accepted: true }; },
  };
  const root = new Context();
  try {
    await root.plugin({
      name: 'assembly-infra',
      apply(ctx) {
        ctx.provide('storage', medium.storage);
        ctx.provide('connection', { operator });
        ctx.provide('agents', { list: () => [agent], get: (id) => (id === SESSION_ID ? agent : undefined) });
        ctx.provide('sessionController', controller);
        ctx.provide('goals', { get: () => null, resume() { throw new Error('no goal'); } });
      },
    });
    await root.plugin(plugin, {
      storageBackend: 'json',
      routes: [ROUTE],
      autoContinue: { enabled: true, pollMs: 1000 },
    });
    const service = root.get('quotaQueue');
    const driver = service.getAutoContinue();
    assert.ok(driver !== null, 'the production entry must mount the continuation driver');
    assert.equal(medium.state.opens.includes('quota_continue_v1'), true, 'the continuation unit is opened by the owner');

    // Enable the session's own opt-in through the real operator-gated op.
    const optInRequest = {
      version: 1, op: 'setSessionOptIn', requestId: 'assembly-optin',
      payload: { sessionId: SESSION_ID, enabled: true },
    };
    const optIn = await root.extend({
      invocation: {
        service: 'quotaQueue',
        request: { namespace: 'quotaQueue', method: 'dispatch', args: { request: optInRequest } },
        peer: operator, signal: new AbortController().signal, uplink() { throw new Error('no uplink'); },
      },
    }).get('quotaQueue').dispatch(optInRequest, new AbortController().signal);
    assert.equal(optIn.ok, true, JSON.stringify(optIn));
    assert.equal(optIn.data.sessionOptIns[SESSION_ID], true);

    // A real agent-scoped session/event, exactly as the product dispatches it.
    agentEvents.emit('session/event', agent.session, {
      type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT' } } },
    });
    for (let i = 0; i < 40; i++) {
      if (medium.state.saves.includes('quota_continue_v1')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(medium.state.saves.includes('quota_continue_v1'), true, 'a durable ticket was committed through the real assembly');
    const stored = medium.state.units.get('quota_continue_v1');
    const ticket = stored.tickets[SESSION_ID];
    assert.equal(ticket.state, 'waiting');
    assert.equal(ticket.failureClass, 'network');

    // The View carries the safe projection.
    const request = { version: 1, op: 'bootstrap', requestId: 'assembly-1', payload: {} };
    const invocation = {
      service: 'quotaQueue',
      request: { namespace: 'quotaQueue', method: 'dispatch', args: { request } },
      peer: operator,
      signal: new AbortController().signal,
      uplink() { throw new Error('no uplink'); },
    };
    const view = await root.extend({ invocation }).get('quotaQueue').dispatch(request, new AbortController().signal);
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.equal(view.data.autoContinue.enabled, true);
    assert.equal(view.data.autoContinue.owner, 'active');
    assert.equal(view.data.autoContinue.tickets[0].state, 'waiting');

    // A second instance on the SAME port must be passive and write nothing.
    const secondMedium = createMedium();
    const secondRoot = new Context();
    try {
      await secondRoot.plugin({
        name: 'assembly-infra-2',
        apply(ctx) {
          ctx.provide('storage', secondMedium.storage);
          ctx.provide('connection', { operator });
        },
      });
      await secondRoot.plugin(plugin, {
        storageBackend: 'json', routes: [ROUTE], autoContinue: { enabled: true },
      });
      const secondService = secondRoot.get('quotaQueue');
      const passiveDriver = secondService.getAutoContinue();
      assert.ok(passiveDriver !== null, 'the passive instance keeps a passive driver for later takeover');
      assert.equal(passiveDriver.projection().owner, 'passive');
      assert.equal(secondMedium.state.opens.includes('quota_continue_v1'), false, 'the passive instance opens no continuation unit');
      assert.equal(secondMedium.state.saves.includes('quota_continue_v1'), false, 'the passive instance writes nothing');
    } finally {
      await secondRoot.fiber.dispose();
    }
  } finally {
    await root.fiber.dispose();
  }
});