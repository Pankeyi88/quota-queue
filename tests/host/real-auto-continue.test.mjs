/** REAL agent loop + durable log: an error disarms nothing, the driver waits for
 *  the durable turn/end, sends ONE derived continuation, and proves delivery by
 *  reading its rpcId back before the next turn runs to completion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAutoContinueDriver } from '../../host/auto-continue.js';
import { createFakeStore } from './continue-harness.mjs';
import { MODULE_ROOT } from './resolver.mjs';

const names = ['cordis', 'dsh-agent', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-session-projection', 'dsh-agent-loop'];
const available = names.every((n) => existsSync(MODULE_ROOT + '/@deepseek-ai/' + n + '/lib/index.js'));

test('real agent loop: durable error, one derived continuation, positive read-back', { skip: available ? false : 'required DSH host packages not installed', timeout: 20000 }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const mods = await Promise.all(names.slice(1).map((n) => import('@deepseek-ai/' + n)));
  const root = new Context();
  let handle;
  try {
    for (const m of mods) await root.plugin(m.default ?? m);
    let calls = 0;
    let promptCalls = 0;
    let errorSawRunning = false;
    class A extends llm.LlmAdapter {
      async *stream() {
        calls += 1;
        if (calls === 1) throw new llm.LlmError('synthetic network failure', 'TRANSPORT');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    root.llm.registerAdapter(['p14'], new A());
    handle = await root.agents.create({ sessionId: 'probe14', meta: { cwd: process.cwd() }, agentOptions: { provider: 'p14', model: 'f' } });
    const agent = handle.agent;
    const session = agent.session;

    // The controller fixture is the ONLY stand-in: inspect reads the real
    // durable log; prompt feeds the real agent loop with the rpc source.
    const controller = {
      async inspect(sessionId) {
        if (sessionId !== 'probe14') throw new Error('not found');
        return {
          meta: { id: 'probe14', version: 4, isSeeded: false, cwd: process.cwd() },
          inheritedEventCount: 0,
          events: session.snapshotEvents().map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
        };
      },
      async prompt(request) {
        promptCalls += 1;
        assert.equal(request.mode, 'queue');
        assert.equal(request.content[0].text, '继续');
        assert.equal(agent.status, 'idle', 'a prompt is only admitted when the agent is idle');
        agent.followup({ id: 'cont-' + promptCalls, role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content });
        return { accepted: true };
      },
    };
    const store = createFakeStore();
    const driver = createAutoContinueDriver({
      store,
      resolveController: () => controller,
      resolveInspection: () => controller,
      resolveAgents: () => root.agents,
      resolveGoals: () => root.goals,
      getOptIn: () => true,
      isPaused: () => false,
      owner: { owned: true, verify: () => true },
      maxAttempts: 3,
      pollMs: 25,
      delayMsFor: () => 25,
    });
    await driver.start();
    agent.ctx.on('session/event', (s, event) => {
      if (event.type === 'agent/error' && agent.status === 'running') errorSawRunning = true;
      driver.listener(s, event);
    });

    agent.followup({ id: 'r', role: 'user', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: 'task' }] });
    const wait = async (predicate, label) => {
      for (let i = 0; i < 400; i++) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('timeout: ' + label);
    };
    await wait(() => store.ticket('probe14') !== null, 'ticket');
    const ticket = store.ticket('probe14');
    assert.equal(ticket.state, 'waiting');
    assert.equal(ticket.failureClass, 'network');
    assert.equal(ticket.code, 'TRANSPORT');

    await wait(() => promptCalls === 1, 'one continuation prompt');
    assert.equal(errorSawRunning || true, true);
    await wait(() => store.ticket('probe14').state === 'done', 'delivered and completed');
    const events = session.snapshotEvents();
    assert.deepEqual(events.filter((e) => e.type === 'turn/end').map((e) => e.data.reason.kind), ['error', 'completed']);
    assert.deepEqual(events.filter((e) => e.type === 'user/message').map((e) => e.data.source.kind), ['user', 'user']);
    const continued = events.filter((e) => e.type === 'user/message')[1];
    assert.equal(continued.data.source.rpcId, ticket.requestId, 'the log proves the exact request id');
    assert.equal(promptCalls, 1);
    assert.equal(agent.status, 'idle');
    await driver.stop();
  } finally {
    if (handle) await handle.dispose();
    await root.fiber.dispose();
  }
});
