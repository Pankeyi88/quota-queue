/**
 * Read-only correlation of a durable continuation request against a selected
 * session inspection. This does not send messages, acquire ownership, infer
 * not-dispatched from absence, or assert that a completed turn achieved a Goal.
 * Inspect only a session the caller has explicitly selected and authorized.
 */
import { taskIdentityFromInspection } from './task-identity.js';

const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failure = (reason) => ({ status: 'invalid', reason });
const endKinds = new Set(['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']);

export function correlateContinueInspection(input) {
  try { return correlate(input); }
  catch { return failure('inspection_invalid'); }
}

function correlate(input) {
  if (!record(input) || !text(input.sessionId) || !text(input.requestId)
    || !text(input.rootMessageId) || !text(input.generation) || !integer(input.originalEndSeq) || !integer(input.failureTurn)
    || !record(input.inspection) || !Array.isArray(input.inspection.events)) return failure('inspection_invalid');
  const events = input.inspection.events;
  if (input.originalEndSeq >= events.length) return failure('original_boundary_missing');
  for (let n = 0; n < events.length; n++) {
    const event = events[n];
    if (!record(event) || event.seq !== n || !text(event.type) || !record(event.data)) return failure('inspection_invalid');
  }
  const prefix = { ...input.inspection, events: events.slice(0, input.originalEndSeq + 1) };
  const original = taskIdentityFromInspection(input.sessionId, prefix);
  const end = events[input.originalEndSeq];
  if (!original.verified || original.rootMessageId !== input.rootMessageId
    || original.generation !== input.generation || !original.turnEnded
    || end.type !== 'turn/end' || end.data.turn !== input.failureTurn
    || input.failureTurn < original.turn || end.data.reason?.kind !== 'error') return failure('original_identity_changed');

  let current = null;
  let lastTurn = input.failureTurn;
  let currentStep = null;
  let lastStep = 0;
  let goalInTurn = false;
  let observed = null;
  for (let n = input.originalEndSeq + 1; n < events.length; n++) {
    const event = events[n];
    if (event.type === 'turn/start') {
      if (current !== null || !integer(event.data.turn) || event.data.turn <= lastTurn) return failure('turn_boundary_invalid');
      current = event.data.turn;
      lastTurn = current;
      currentStep = null;
      lastStep = 0;
      goalInTurn = false;
    } else if (event.type === 'step/start') {
      if (current === null || event.data.turn !== current || currentStep !== null
        || !integer(event.data.step) || event.data.step <= lastStep) return failure('turn_boundary_invalid');
      currentStep = event.data.step;
      lastStep = currentStep;
    } else if (event.type === 'step/end') {
      if (current === null || event.data.turn !== current || event.data.step !== currentStep || currentStep === null) return failure('turn_boundary_invalid');
      currentStep = null;
    } else if (event.type === 'turn/end') {
      const kind = event.data.reason?.kind;
      if (current === null || currentStep !== null || event.data.turn !== current || !endKinds.has(kind)) return failure('turn_boundary_invalid');
      if (observed !== null && observed.turn === current) observed.endKind = kind;
      current = null;
    } else if (event.type === 'user/message' && event.data.source?.kind === 'goal') {
      if (current === null) return failure('turn_boundary_invalid');
      goalInTurn = true;
      if (observed !== null && observed.turn === current) return { status: 'conflict', reason: 'goal_in_recovery_turn' };
    } else if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      if (current === null || event.data.role !== 'user' || !text(event.data.id)) return failure('turn_boundary_invalid');
      if (event.data.source.rpcId !== input.requestId) return { status: 'conflict', reason: 'other_user_message' };
      if (currentStep !== 1) return { status: 'conflict', reason: 'continuation_not_first_step' };
      if (goalInTurn) return { status: 'conflict', reason: 'goal_in_recovery_turn' };
      // An rpcId is caller-chosen, not an authenticated identity. Require the
      // exact intended payload too, but do not treat either as ownership proof.
      const content = event.data.content;
      if (!Array.isArray(content) || content.length !== 1 || !record(content[0])
        || content[0].type !== 'text' || content[0].text !== '继续') {
        return { status: 'conflict', reason: 'request_payload_mismatch' };
      }
      if (observed !== null) return { status: 'conflict', reason: 'duplicate_request_message' };
      observed = { messageId: event.data.id, turn: current, endKind: null };
    }
  }
  if (observed === null) return { status: 'not_observed' };
  if (observed.endKind === null) return { status: 'observed', ...observed };
  return { status: observed.endKind === 'completed' ? 'completed' : 'failed', ...observed };
}
