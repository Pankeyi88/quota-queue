/** Inspect a selected session's latest failed turn without inferring authority.
 * A recoverable classification is evidence only, not permission to send.
 * Runtime liveness, identity, authorization, ownership and readiness remain
 * separate preconditions and must be rechecked immediately before delivery.
 */
import { classifyFailure } from '../core/failure.mjs';
import { taskIdentityFromInspection } from './task-identity.js';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function inspectContinueFailure(sessionId, inspection) {
  try {
    if (!object(inspection) || !Array.isArray(inspection.events)) return { eligible: false, reason: 'inspection_invalid' };
    const identity = taskIdentityFromInspection(sessionId, inspection);
    if (!identity.verified) return { eligible: false, reason: 'identity_unverified' };
    if (!identity.turnEnded) return { eligible: false, reason: 'turn_not_ended' };
    const events = inspection.events;
    let endSeq = -1;
    for (let n = events.length - 1; n >= 0; n--) {
      if (events[n].type === 'turn/end') { endSeq = n; break; }
    }
    if (endSeq < 0) return { eligible: false, reason: 'task_not_latest_turn' };
    const failureTurn = events[endSeq].data.turn;
    if (!Number.isSafeInteger(failureTurn) || failureTurn < identity.turn) return { eligible: false, reason: 'task_not_latest_turn' };
    let goal = null;
    let humanInTurn = false;
    let start = endSeq - 1;
    while (start >= 0 && events[start].type !== 'turn/start') start--;
    if (start < 0 || events[start].data.turn !== failureTurn) return { eligible: false, reason: 'task_not_latest_turn' };
    for (let n = start + 1; n < endSeq; n++) {
      const event = events[n];
      if (event.type !== 'user/message') continue;
      const source = event.data.source;
      if (source?.kind === 'user') humanInTurn = true;
      if (source?.kind !== 'goal') continue;
      if (goal !== null || typeof source.goalId !== 'string' || source.goalId.length === 0
        || !Number.isSafeInteger(source.revision) || source.revision < 1
        || !Number.isSafeInteger(source.round) || source.round < 1) {
        return { eligible: false, reason: 'goal_identity_invalid' };
      }
      goal = { id: source.goalId, revision: source.revision, round: source.round };
    }
    // Steered human input can share a Goal turn. Its ownership is ambiguous.
    if (goal !== null && humanInTurn) return { eligible: false, reason: 'goal_user_competition' };
    if (failureTurn !== identity.turn && goal === null) return { eligible: false, reason: 'synthetic_turn_unattributed' };
    for (let n = endSeq + 1; n < events.length; n++) {
      if (events[n].type === 'turn/start' || events[n].type === 'user/message') return { eligible: false, reason: 'task_not_latest_turn' };
    }
    const end = events[endSeq].data.reason;
    if (!object(end) || end.kind !== 'error' || !object(end.error)) return { eligible: false, reason: 'not_failed_turn' };
    const classified = classifyFailure({ code: end.error.code, status: end.error.status });
    // Explicit authentication or non-transient client status must not be
    // overridden by a misleading TIMEOUT/TRANSPORT code.
    const status = classified.status;
    if (status === 401 || status === 403
      || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429
        && !(status === 402 && classified.class === 'quota'))) {
      return { eligible: false, reason: 'failure_not_recoverable' };
    }
    if (!['quota', 'transient', 'rate_limit'].includes(classified.class)) {
      return { eligible: false, reason: 'failure_not_recoverable' };
    }
    // A Goal source proves a round happened, not that the latest human root
    // authorized that Goal. Keep it disabled until a durable binding is proven.
    if (goal !== null) return { eligible: false, reason: 'goal_attribution_unverified' };
    return {
      eligible: true, sessionId: identity.sessionId, rootMessageId: identity.rootMessageId,
      generation: identity.generation, rootTurn: identity.turn, turn: failureTurn, originalEndSeq: endSeq,
      goal, goalAttribution: goal === null ? 'not_applicable' : 'unverified',
      observedThroughSeq: events.length - 1, failureClass: classified.class,
      code: classified.code, status: classified.status,
    };
  } catch { return { eligible: false, reason: 'inspection_invalid' }; }
}
