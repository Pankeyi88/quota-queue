/** Shared fixtures for continuation tests (no host, no network). */
import { CONTINUE_STORE_VERSION } from '../../core/continue-ticket.mjs';

export const NOW = 1_700_000_000_000;

export function createClock() {
  let at = NOW;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => at,
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance: (ms) => { at += ms; },
    fire: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    get pending() { return timers.size; },
  };
}

export function createFakeStore(initial = null) {
  const state = {
    snapshot: initial ?? { version: CONTINUE_STORE_VERSION, revision: 0, tickets: {}, updatedAt: new Date(0).toISOString() },
    saves: 0,
    closed: false,
  };
  return {
    get opened() { return true; },
    get closed() { return state.closed; },
    get locked() { return false; },
    get degraded() { return false; },
    get reason() { return null; },
    get saves() { return state.saves; },
    getSnapshot() { return state.snapshot; },
    async open() { return this; },
    async close() { state.closed = true; },
    async mutate(fn) {
      const draft = structuredClone(state.snapshot);
      const result = await fn(draft);
      draft.revision = state.snapshot.revision + 1;
      draft.updatedAt = new Date(NOW).toISOString();
      state.saves += 1;
      state.snapshot = draft;
      return result;
    },
    ticket(sessionId) { return state.snapshot.tickets[sessionId] ?? null; },
  };
}

/** Build a session inspection from a compact spec of turns. */
export function inspectionFor(sessionId, turns, { rootId = 'root-1', extra = [], rpcOutside = [], baseTime = null } = {}) {
  const events = [];
  for (const turn of turns) {
    events.push({ type: 'turn/start', data: { turn: turn.turn } });
    for (const message of turn.messages ?? []) events.push({ type: 'user/message', data: message });
    for (const tool of turn.tools ?? []) events.push(tool);
    if (turn.end !== null) {
      const endEvent = { type: 'turn/end', data: { turn: turn.turn, reason: turn.end } };
      // Durable event time: the backfill age cap reads this, never the clock.
      if (Number.isSafeInteger(turn.endTime)) endEvent.time = turn.endTime;
      events.push(endEvent);
    }
  }
  for (const message of rpcOutside) events.push({ type: 'user/message', data: message });
  events.push(...extra);
  const stamped = events.map((event, seq) => {
    const next = { seq, ...event };
    if (next.time === undefined && baseTime !== null) next.time = baseTime + seq;
    return next;
  });
  return {
    meta: { id: sessionId, version: 4, isSeeded: false, cwd: 'E:/ws/one' },
    inheritedEventCount: 0,
    events: stamped,
  };
}

export const userMessage = (id, rpcId) => ({
  id, role: 'user', content: [], source: rpcId === undefined ? { kind: 'user' } : { kind: 'user', rpcId },
});

export const errorEnd = (code, extra = {}) => ({ kind: 'error', error: { code, ...extra } });
