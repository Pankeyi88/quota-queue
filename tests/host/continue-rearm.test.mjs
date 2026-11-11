import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinueRearm } from '../../host/continue-rearm.js';

function fixture(goal = { id: 'g', revision: 3, phase: 'active', activation: 'disarmed' }) {
  const agent = { id: 's', status: 'idle' };
  const calls = { get: 0, resume: 0, args: null };
  const goals = {
    get(a) { calls.get++; assert.equal(a, agent); return goal; },
    resume(a, ref) { calls.resume++; calls.args = ref; return { ...goal, activation: 'armed', revision: goal.revision + 1 }; },
  };
  const rearm = createContinueRearm({ resolveAgents: () => ({ get: id => (id === 's' ? agent : undefined) }), resolveGoals: () => goals });
  return { rearm, calls, goal, agent };
}

test('an error-disarmed active goal is re-armed through the exact CAS reference', () => {
  const f = fixture();
  assert.deepEqual(f.rearm.rearm('s'), { status: 'armed', goalId: 'g', revision: 4 });
  assert.deepEqual(f.calls.args, { id: 'g', revision: 3 });
  assert.equal(f.calls.resume, 1);
});

test('paused, blocked, complete and already-armed goals are never resumed', () => {
  for (const [change, status] of [
    [{ phase: 'paused' }, 'not_active'],
    [{ phase: 'blocked' }, 'not_active'],
    [{ phase: 'complete' }, 'not_active'],
    [{ activation: 'armed' }, 'already_armed'],
    [{ activation: 'unknown' }, 'not_active'],
  ]) {
    const f = fixture({ id: 'g', revision: 1, phase: 'active', activation: 'disarmed', ...change });
    assert.deepEqual(f.rearm.rearm('s'), { status });
    assert.equal(f.calls.resume, 0);
  }
});

test('missing live agent, goal service or goal never re-arms', () => {
  const none = createContinueRearm({ resolveAgents: () => undefined, resolveGoals: () => undefined });
  assert.equal(none.rearm('s').status, 'not_live');
  const noGoal = fixture(null);
  assert.equal(noGoal.rearm.rearm('s').status, 'no_goal');
  assert.equal(noGoal.calls.resume, 0);
  assert.equal(noGoal.rearm.rearm('s ').status, 'not_live');
  const throwing = createContinueRearm({
    resolveAgents: () => ({ get() { throw new Error('private'); } }), resolveGoals: () => ({ get() { return {}; }, resume() { return {}; } }),
  });
  assert.equal(throwing.rearm('s').status, 'not_live');
});

test('a rejected resume stays disarmed without leaking the error', () => {
  const agent = { id: 's' };
  const rearm = createContinueRearm({
    resolveAgents: () => ({ get: () => agent }),
    resolveGoals: () => ({ get: () => ({ id: 'g', revision: 2, phase: 'active', activation: 'disarmed' }), resume() { throw new Error('GOAL_STALE_REVISION secret'); } }),
  });
  assert.deepEqual(rearm.rearm('s'), { status: 'resume_rejected' });
});

test('a re-arm happens only after a human turn completes, never mid-turn', async () => {
  const f = fixture();
  const session = { id: 's' };
  const end = (turn, kind = 'completed') => f.rearm.listener(session, { type: 'turn/end', data: { turn, reason: { kind } } });
  const human = () => f.rearm.listener(session, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r' } } });

  // Synthetic-only turns never re-arm.
  for (const source of [{ kind: 'goal', goalId: 'g', revision: 1, round: 1 }, { kind: 'runtime-context' }, { kind: 'subagent' }, null]) {
    f.rearm.listener(session, { type: 'turn/start', data: { turn: 1 } });
    f.rearm.listener(session, { type: 'user/message', data: { source } });
    end(1);
    await Promise.resolve();
    assert.equal(f.calls.resume, 0, JSON.stringify(source));
  }

  // A human message admitted mid-turn must NOT arm while the turn runs.
  f.rearm.listener(session, { type: 'turn/start', data: { turn: 2 } });
  human();
  assert.equal(f.calls.resume, 0, 'arming during a running turn is refused');
  await Promise.resolve();
  assert.equal(f.calls.resume, 0);

  // A failed human turn keeps the goal disarmed.
  end(2, 'error');
  await Promise.resolve();
  assert.equal(f.calls.resume, 0);

  // A completed human turn re-arms after the append, not inside it.
  f.rearm.listener(session, { type: 'turn/start', data: { turn: 3 } });
  human();
  end(3);
  assert.equal(f.calls.resume, 0, 'the re-arm must not run inside the append');
  await Promise.resolve();
  assert.equal(f.calls.resume, 1);

  // A turn/end that does not match the recorded turn is ignored, and malformed
  // events never throw.
  end(9);
  f.rearm.listener({}, { type: 'turn/start', data: { turn: 1 } });
  f.rearm.listener(session, null);
  f.rearm.listener(session, { type: 'user/message', data: null });
  await Promise.resolve();
  assert.equal(f.calls.resume, 1);
});
test('sessions are isolated and synthetic sources never leak across them', async () => {
  const a = fixture();
  const b = fixture();
  const agents = { get: (id) => (id === 's' ? { id: 's' } : id === 't' ? { id: 't' } : undefined) };
  const goals = {
    get: (agent) => (agent.id === 's' ? { id: 'g', revision: 1, phase: 'active', activation: 'disarmed' } : { id: 'h', revision: 1, phase: 'active', activation: 'disarmed' }),
    resume: (agent) => ({ id: agent.id === 's' ? 'g' : 'h', revision: 2, phase: 'active', activation: 'armed' }),
  };
  const rearm = createContinueRearm({ resolveAgents: () => agents, resolveGoals: () => goals });
  const s = { id: 's' };
  rearm.listener(s, { type: 'turn/start', data: { turn: 1 } });
  rearm.listener(s, { type: 'user/message', data: { source: { kind: 'user' } } });
  // Another session's completed turn must not re-arm this one.
  rearm.listener({ id: 't' }, { type: 'turn/start', data: { turn: 1 } });
  rearm.listener({ id: 't' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await Promise.resolve();
  assert.equal(rearm.rearm('s').status, 'armed', 'the pending human turn in s is still armed explicitly');
});

test('attach binds live agents, disposes every subscription and tolerates absence', () => {
  const offs = [];
  const agent = { id: 's', ctx: { on: (name) => { offs.push(name); return () => offs.push('off:' + name); } } };
  const registered = [];
  const ctx = {
    get: (name) => (name === 'agents' ? { list: () => [agent] } : undefined),
    on: (name) => { registered.push(name); return () => registered.push('off:' + name); },
  };
  const rearm = createContinueRearm({ resolveAgents: () => undefined, resolveGoals: () => undefined });
  const dispose = rearm.attach(ctx);
  assert.deepEqual(registered.slice(0, 1), ['agent/created']);
  assert.deepEqual(offs.slice(0, 1), ['session/event']);
  dispose();
  assert.deepEqual(registered.slice(-1), ['off:agent/created']);
  assert.deepEqual(offs.slice(-1), ['off:session/event']);
  // A context without the agents service still attaches and disposes cleanly.
  const bare = rearm.attach({ get: () => undefined, on: () => () => {} });
  assert.equal(typeof bare, 'function');
  assert.throws(() => rearm.attach(null), /Cordis context/);
});
