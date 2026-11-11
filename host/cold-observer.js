/** Unmounted, read-only observation of one selected session. The two samples
 * bracket the plugin's SessionInspection port, but are non-atomic: ABA
 * transitions and changes immediately after return are invisible. Idle/empty
 * imply neither ownership nor authority, durable flush, settlement, or a
 * complete snapshot. Never dispatch from this.
 */
import { inspectContinueFailure } from './continue-failure.js';

const bad = reason => ({ ok: false, reason });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const object = value => value !== null && typeof value === 'object';

/** Resolvers must return current services, not cached handles. */
export function createColdObserver({ resolveInspection, resolveAgents, resolveGoals } = {}) {
  async function observe(sessionId, signal) {
    try {
      if (!validId(sessionId)) return bad('invalid_session');
      if (signal?.aborted) return bad('cancelled');
      if (typeof resolveInspection !== 'function' || typeof resolveAgents !== 'function') return bad('service_unavailable');
      const inspectionPort = resolveInspection();
      if (!object(inspectionPort) || typeof inspectionPort.inspect !== 'function') return bad('inspection_unavailable');
      const registry = resolveAgents();
      if (!object(registry) || typeof registry.get !== 'function') return bad('agents_unavailable');
      const goals = typeof resolveGoals === 'function' ? resolveGoals() : undefined;
      const sample = () => {
        const agent = registry.get(sessionId);
        if (agent == null) return { agent: null, state: 'missing', queue: null, goal: { state: 'unavailable' } };
        if (!object(agent) || agent.id !== sessionId) throw 0;
        const state = agent.status;
        if (state !== 'idle' && state !== 'running') return { agent, state: 'unknown', queue: null, goal: { state: 'unavailable' } };
        const inbox = agent.inbox;
        if (!object(inbox) || !Array.isArray(inbox.nextTurn) || !Array.isArray(inbox.nextStep)) throw 0;
        const queue = { nextTurn: inbox.nextTurn.length, nextStep: inbox.nextStep.length };
        let goal;
        if (goals == null) goal = { state: 'unavailable' };
        else {
          if (typeof goals.get !== 'function') throw 0;
          const view = goals.get(agent);
          if (view == null) goal = { state: 'none' };
          else {
            if (!object(view) || !['active','paused','blocked','complete'].includes(view.phase) || !['armed','disarmed'].includes(view.activation)) throw 0;
            goal = { state: 'present', phase: view.phase, activation: view.activation };
          }
        }
        return { agent, state, queue, goal };
      };
      const before = sample();
      if (signal?.aborted) return bad('cancelled');
      const inspection = await inspectionPort.inspect(sessionId, signal);
      if (signal?.aborted) return bad('cancelled');
      if (resolveInspection() !== inspectionPort || resolveAgents() !== registry || (typeof resolveGoals === 'function' && resolveGoals() !== goals)) return bad('observation_changed');
      const after = sample();
      if (signal?.aborted) return bad('cancelled');
      if (before.agent !== after.agent || before.state !== after.state || JSON.stringify(before.queue) !== JSON.stringify(after.queue) || JSON.stringify(before.goal) !== JSON.stringify(after.goal)) return bad('observation_changed');
      const evidence = inspectContinueFailure(sessionId, inspection);
      if (signal?.aborted) return bad('cancelled');
      if (resolveInspection() !== inspectionPort || resolveAgents() !== registry || (typeof resolveGoals === 'function' && resolveGoals() !== goals)) return bad('observation_changed');
      const final = sample();
      if (final.agent !== after.agent || final.state !== after.state || JSON.stringify(final.queue) !== JSON.stringify(after.queue) || JSON.stringify(final.goal) !== JSON.stringify(after.goal)) return bad('observation_changed');
      if (signal?.aborted) return bad('cancelled');
      // Identity and source strings are intentionally excluded from this view.
      const failure = evidence.eligible
        ? { eligible: true, failureClass: evidence.failureClass, code: evidence.code, status: evidence.status, turn: evidence.turn }
        : { eligible: false, reason: evidence.reason };
      return { ok: true, reason: 'observation_only', agent: { state: after.state, queue: after.queue }, goal: after.goal, failure };
    } catch {
      try { if (signal?.aborted) return bad('cancelled'); } catch { /* malformed signal */ }
      return bad('observation_failed');
    }
  }
  return { observe };
}
