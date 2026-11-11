/** Real Goal service + real round driver, offline fake adapter.
 *  Turn 1: TRANSPORT error -> the driver disarms the Goal.
 *  Human “继续” -> turn 2 completes -> the Host re-arm restores automatic rounds,
 *  which run until the goal's own round cap blocks them (no hang, no new session).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createContinueRearm } from '../../host/continue-rearm.js';
import { MODULE_ROOT } from './resolver.mjs';

const names = ['cordis','dsh-agent','dsh-session','dsh-llm','dsh-tools','dsh-system-prompt','dsh-session-projection','dsh-agent-loop','dsh-goal','dsh-goal-round-driver'];
const available = names.every(n => existsSync(MODULE_ROOT + '/@deepseek-ai/' + n + '/lib/index.js'));

test('real goal and driver: an error disarms, “继续” re-arms, rounds stop at the cap', { skip: available ? false : 'required DSH host packages not installed', timeout: 15000 }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const mods = await Promise.all(names.slice(1).map(n => import('@deepseek-ai/' + n)));
  const root = new Context(); let handle;
  try {
    for (const m of mods) await root.plugin(m.default ?? m);
    await root.plugin({ name:'rearm-probe', apply(ctx) {
      const h = createContinueRearm({ resolveAgents: () => ctx.get('agents'), resolveGoals: () => ctx.get('goals'), logger: { warn() {} } });
      ctx.effect(() => h.attach(ctx), 'r');
    } });
    let calls = 0;
    class A extends llm.LlmAdapter {
      async *stream() {
        calls++;
        if (calls === 1) throw new llm.LlmError('synthetic network failure', 'TRANSPORT');
        yield { type:'block-start', index:0, blockType:'text' };
        yield { type:'text-delta', index:0, text:'ok' };
        yield { type:'block-end', index:0, block:{type:'text',text:'ok'} };
        yield { type:'finish', reason:{kind:'stop'} };
      }
    }
    root.llm.registerAdapter(['p3'], new A());
    handle = await root.agents.create({ sessionId:'probe3', meta:{cwd:process.cwd()}, agentOptions:{provider:'p3',model:'f'} });
    const agent = handle.agent, session = agent.session;
    root.goals.create(agent, { objective:'probe3', maxGoalRounds:2 });
    const wait = async (p, l) => { for (let i=0;i<200;i++) { if (p()) return true; await new Promise(r=>setTimeout(r,10)); } return false; };

    agent.followup({ id:'r', role:'user', source:{kind:'user',rpcId:'r'}, content:[{type:'text',text:'task'}] });
    assert.equal(await wait(() => session.snapshotEvents().some(e => e.type === 'turn/end'), 't1'), true);
    const events = () => session.snapshotEvents();
    assert.deepEqual(events().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['error']);
    assert.equal(root.goals.get(agent).activation, 'disarmed');

    agent.followup({ id:'c', role:'user', source:{kind:'user',rpcId:'c'}, content:[{type:'text',text:'继续'}] });
    assert.equal(await wait(() => root.goals.get(agent)?.phase !== 'active', 'goal settles at its round cap'), true);
    const goal = root.goals.get(agent);
    assert.equal(goal.phase, 'blocked');
    assert.equal(goal.blockedReason.code, 'round-limit');
    assert.equal(goal.roundsStarted, 2);
    assert.deepEqual(events().filter(e => e.type === 'turn/end').map(e => e.data.reason.kind), ['error','completed','completed','completed']);
    assert.deepEqual(events().filter(e => e.type === 'user/message').map(e => e.data.source.kind), ['user','user','goal','goal']);
    assert.equal(agent.status, 'idle');
    assert.equal(calls, 4);
  } finally { if (handle) await handle.dispose(); await root.fiber.dispose(); }
});
