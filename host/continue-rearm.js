/**
 * Unmounted Host helper: deterministically re-arm a Goal after a human
 * continuation message.
 *
 * Why: an API/network failure ends the turn with an error, and the goal-round
 * driver disarms the Goal (durable phase stays `active`, process activation
 * becomes `disarmed`). The documented recovery is that a human continuation
 * re-arms it, but that currently depends on the MODEL calling update_goal. This
 * helper performs the re-arm in the Host so sending “继续” works even when the
 * model does not.
 *
 * Scope: only an exact LIVE agent, only `phase === 'active'` with
 * `activation === 'disarmed'` (the state an error produces). `paused`,
 * `blocked` and `complete` are never resumed here: a human pause is a
 * deliberate stop, and the model-facing tool refuses paused goals by design.
 * It performs no I/O, sends no message, creates no session and grants no new
 * authority; the durable Goal phase and round budget are unchanged and
 * `resume` still validates the exact {id, revision} CAS.
 */
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);

export const REARM_REASONS = Object.freeze([
  'armed', 'not_live', 'no_goal', 'not_active', 'already_armed', 'resume_rejected',
]);

/**
 * @param {object} input
 * @param {() => object|undefined} input.resolveAgents
 * @param {() => object|undefined} input.resolveGoals
 * @param {{warn?: Function}} [input.logger]
 */
export function createContinueRearm(input = {}) {
  const { resolveAgents, resolveGoals } = input;
  if (typeof resolveAgents !== 'function' || typeof resolveGoals !== 'function') {
    throw new TypeError('continue rearm requires resolveAgents and resolveGoals');
  }
  const logger = input.logger ?? null;

  /** @returns {{status:string, goalId?:string, revision?:number}} */
  function rearm(sessionId) {
    if (!text(sessionId)) return { status: 'not_live' };
    let agents; let goals;
    try { agents = resolveAgents(); } catch { return { status: 'not_live' }; }
    try { goals = resolveGoals(); } catch { return { status: 'not_live' }; }
    if (agents === null || agents === undefined || typeof agents.get !== 'function') return { status: 'not_live' };
    if (goals === null || goals === undefined || typeof goals.get !== 'function'
      || typeof goals.resume !== 'function') return { status: 'not_live' };
    let agent; let goal;
    try { agent = agents.get(sessionId); } catch { return { status: 'not_live' }; }
    if (agent === null || agent === undefined || typeof agent !== 'object') return { status: 'not_live' };
    try { goal = goals.get(agent); } catch { return { status: 'not_live' }; }
    if (goal === null || goal === undefined) return { status: 'no_goal' };
    if (!text(goal.id) || !Number.isSafeInteger(goal.revision)) return { status: 'no_goal' };
    if (goal.phase !== 'active') return { status: 'not_active' };
    if (goal.activation === 'armed') return { status: 'already_armed' };
    if (goal.activation !== 'disarmed') return { status: 'not_active' };
    try {
      const next = goals.resume(agent, { id: goal.id, revision: goal.revision });
      return { status: 'armed', goalId: goal.id, revision: next?.revision ?? goal.revision };
    } catch {
      // A concurrent change, a live-instance mismatch or an exhausted round
      // budget rejects here; the caller keeps its previous (disarmed) state.
      try { logger?.warn?.('quota-queue: goal re-arm rejected after a continuation'); } catch { /* best effort */ }
      return { status: 'resume_rejected' };
    }
  }

  // A re-arm is only requested AFTER the human continuation's own turn ends
  // `completed`. Arming during that turn lets the round driver queue an
  // automatic round against a running agent; the product semantics of an armed
  // Goal are uninterrupted automatic rounds, so the boundary must be a settled
  // turn, not an admitted message.
  const humanTurn = new Map();

  /**
   * Waterfall-free session/event listener.
   * `turn/start`/`turn/end` and `user/message` are observed together because a
   * raw user/message carries no turn number of its own.
   */
  function listener(session, event) {
    try {
      if (event === null || typeof event !== 'object') return;
      const sessionId = session?.id;
      if (!text(sessionId)) return;
      const data = event.data;
      if (data === null || typeof data !== 'object') return;
      if (event.type === 'turn/start') {
        if (Number.isSafeInteger(data.turn)) humanTurn.set(sessionId, { turn: data.turn, human: false });
        return;
      }
      if (event.type === 'user/message') {
        const source = data.source;
        if (source === null || typeof source !== 'object' || source.kind !== 'user') return;
        const state = humanTurn.get(sessionId);
        if (state !== undefined) state.human = true;
        return;
      }
      if (event.type === 'turn/end') {
        const state = humanTurn.get(sessionId);
        humanTurn.delete(sessionId);
        if (state === undefined || state.human !== true || data.turn !== state.turn) return;
        if (data.reason?.kind !== 'completed') return;
        // Deferred: Session.append forbids a re-entrant append while it publishes
        // session/event, and Goal resume appends goal/change.
        queueMicrotask(() => { rearm(sessionId); });
      }
    } catch { /* observation only */ }
  }

  /**
   * Register on every live agent's own scoped context: \`session/event\` is
   * agent-scoped, so a root-level listener would never see the session log.
   * Returns a disposer that removes every subscription.
   */
  function attach(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
      throw new TypeError('continue rearm attach requires a Cordis context');
    }
    const disposers = [];
    const bind = (agent) => {
      try {
        const agentCtx = agent?.ctx;
        if (agentCtx === null || agentCtx === undefined || typeof agentCtx.on !== 'function') return;
        const off = agentCtx.on('session/event', (session, event) => listener(session, event));
        if (typeof off === 'function') disposers.push(off);
      } catch { /* a racing disposal only loses its subscription */ }
    };
    try {
      const offCreated = ctx.on('agent/created', ({ agent }) => bind(agent));
      if (typeof offCreated === 'function') disposers.push(offCreated);
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      if (agents && typeof agents.list === 'function') {
        for (const agent of agents.list()) bind(agent);
      }
    } catch { /* degraded: no subscription, no authority */ }
    return () => {
      for (const off of disposers.splice(0)) {
        try { off(); } catch { /* idempotent */ }
      }
    };
  }

  return Object.freeze({ rearm, listener, attach });
}
