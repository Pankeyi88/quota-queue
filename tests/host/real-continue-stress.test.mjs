/** Repeated error→“继续” cycles must never wedge the agent.
 *  The loop may open extra context-only turns, so the assertions are about
 *  invariants (every started turn ends, the agent settles idle, continuations
 *  still reach the model) rather than an exact turn count. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createContinueRearm } from '../../host/continue-rearm.js';
import { MODULE_ROOT } from './resolver.mjs';

const names = ['cordis','dsh-agent','dsh-session','dsh-llm','dsh-tools','dsh-system-prompt','dsh-session-projection','dsh-agent-loop','dsh-goal','dsh-goal-round-driver'];
const available = names.every(n => existsSync(MODULE_ROOT + '/@deepseek-ai/' + n + '/lib/index.js'));

test('repeated error→continue keeps turns balanced and the agent idle', { skip: available ? false : 'required DSH host packages not installed', timeout: 25000 }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const mods = await Promise.all(names.slice(1).map(n => import('@deepseek-ai/' + n)));
  const root = new Context(); let handle;
  try {
    for (const m of mods) await root.plugin(m.default ?? m);
    await root.plugin({ name:'rearm-stress', apply(ctx) {
      const h = createContinueRearm({ resolveAgents: () => ctx.get('agents'), resolveGoals: () => ctx.get('goals'), logger: { warn() {} } });
      ctx.effect(() => h.attach(ctx), 'r');
    } });
    let calls = 0;
    class Flaky extends llm.LlmAdapter {
      async *stream() {
        calls++;
        // The first request of each continuation attempt fails once.
        if (calls === 1 || calls === 3) throw new llm.LlmError('synthetic network failure', 'TRANSPORT');
        yield { type:'block-start', index:0, blockType:'text' };
        yield { type:'text-delta', index:0, text:'ok' };
        yield { type:'block-end', index:0, block:{type:'text',text:'ok'} };
        yield { type:'finish', reason:{kind:'stop'} };
      }
    }
    root.llm.registerAdapter(['stress'], new Flaky());
    handle = await root.agents.create({ sessionId:'stress', meta:{cwd:process.cwd()}, agentOptions:{provider:'stress',model:'f'} });
    const agent = handle.agent, session = agent.session;
    const events = () => session.snapshotEvents();
    const ends = () => events().filter(e => e.type === 'turn/end');
    const starts = () => events().filter(e => e.type === 'turn/start');
    const settle = async (label) => {
      for (let i = 0; i < 600; i++) {
        if (agent.status === 'idle' && starts().length === ends().length) return true;
        await new Promise(r => setTimeout(r, 10));
      }
      return false;
    };

    agent.followup({ id:'r0', role:'user', source:{kind:'user',rpcId:'r0'}, content:[{type:'text',text:'task'}] });
    assert.equal(await settle('first turn'), true, 'first turn settles');

    for (const id of ['c1', 'c2', 'c3']) {
      const before = ends().length;
      agent.followup({ id, role:'user', source:{kind:'user',rpcId:id}, content:[{type:'text',text:'继续'}] });
      assert.equal(await settle(id), true, id + ' settles: ' + JSON.stringify({ calls, status: agent.status, ends: ends().map(e => e.data.turn + ':' + e.data.reason.kind) }));
      assert.equal(ends().length > before, true, id + ' produced a new turn');
    }
    const kinds = ends().map(e => e.data.reason.kind);
    assert.equal(kinds[0], 'error', 'the first turn fails as scripted');
    assert.equal(kinds.includes('completed'), true, 'a continuation completed after the error');
    assert.deepEqual(agent.inbox.nextTurn, []);
    assert.deepEqual(agent.inbox.nextStep, []);
    assert.equal(agent.status, 'idle');
  } finally { if (handle) await handle.dispose(); await root.fiber.dispose(); }
});
