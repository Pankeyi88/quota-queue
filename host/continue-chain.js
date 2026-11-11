/**
 * Unmounted, read-only correlation of persisted continuation records.
 * The caller supplies a complete, authoritative selected-session inspection and
 * previously verified/persisted anchor and attempt records. This function cannot
 * establish their provenance, inspection freshness/completeness, authorization,
 * exclusive ownership, delivery permission, or external side effects.
 */
import { taskIdentityFromInspection } from './task-identity.js';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (reason) => ({ verified: false, reason });

/**
 * attempts: nonempty, chronological [{requestId, messageId, turn, endSeq}].
 * Each is an observed failed continuation, not a request to dispatch one.
 * Even a successful match is identity correlation only; authorization must be
 * established separately, and the full inspection must be independently trusted.
 */
export function correlateContinueChain(input) {
  try { return correlate(input); } catch { return invalid('inspection_invalid'); }
}

function correlate(input) {
  if (!object(input) || !id(input.sessionId) || !id(input.rootMessageId)
    || !id(input.generation) || !integer(input.originalEndSeq) || !integer(input.failureTurn)
    || !Array.isArray(input.attempts) || input.attempts.length === 0
    || !object(input.inspection) || !Array.isArray(input.inspection.events)) return invalid('input_invalid');
  const events = input.inspection.events;
  if (input.originalEndSeq >= events.length) return invalid('original_boundary_missing');
  for (let n = 0; n < events.length; n++) {
    const e = events[n];
    if (!object(e) || e.seq !== n || !id(e.type) || !object(e.data)) return invalid('inspection_invalid');
  }
  const requests = new Set();
  const messages = new Set([input.rootMessageId]);
  let previousTurn = input.failureTurn;
  let previousEnd = input.originalEndSeq;
  for (const a of input.attempts) {
    if (!object(a) || !id(a.requestId) || !id(a.messageId) || !integer(a.turn) || !integer(a.endSeq)
      || a.turn <= previousTurn || a.endSeq <= previousEnd
      || requests.has(a.requestId) || messages.has(a.messageId)) return invalid('attempt_record_invalid');
    requests.add(a.requestId); messages.add(a.messageId);
    previousTurn = a.turn; previousEnd = a.endSeq;
    if (a.endSeq >= events.length) return invalid('attempt_boundary_missing');
  }
  const original = taskIdentityFromInspection(input.sessionId, {
    ...input.inspection, events: events.slice(0, input.originalEndSeq + 1),
  });
  const end = events[input.originalEndSeq];
  // A later synthetic failure has no proven binding to the root here.
  if (!original.verified || original.rootMessageId !== input.rootMessageId
    || original.generation !== input.generation || !original.turnEnded
    || original.turn !== input.failureTurn || original.turnEndKind !== 'error'
    || end.type !== 'turn/end' || end.data.turn !== input.failureTurn
    || end.data.reason?.kind !== 'error') return invalid('original_identity_changed');
  // The anchor must close the very turn containing the root, not a reused turn
  // number or an end emitted while a step is still open. Competing Goal/user
  // messages in that turn make its attribution ambiguous.
  let originalStep = null;
  let originalLastStep = 0;
  for (let n = original.turnStartSeq + 1; n < input.originalEndSeq; n++) {
    const e = events[n];
    if (e.type === 'turn/start' || e.type === 'turn/end') return invalid('original_boundary_invalid');
    if (e.type === 'step/start') {
      if (originalStep !== null || e.data.turn !== input.failureTurn || e.data.step !== originalLastStep + 1) return invalid('original_boundary_invalid');
      originalStep = e.data.step; originalLastStep = e.data.step;
    }
    if (e.type === 'step/end') {
      if (originalStep === null || e.data.turn !== input.failureTurn || e.data.step !== originalStep) return invalid('original_boundary_invalid');
      originalStep = null;
    }
    if (e.type === 'user/message' && n === original.rootMessageSeq && originalStep !== 1) return invalid('original_message_conflict');
    if (e.type === 'user/message' && (e.data.source?.kind === 'goal'
      || (e.data.source?.kind === 'user' && n !== original.rootMessageSeq)))
      return invalid('original_message_conflict');
  }
  if (originalStep !== null) return invalid('original_boundary_invalid');

  let index = 0;
  let current = null;
  let step = null;
  let lastStep = 0;
  let seen = false;
  for (let n = input.originalEndSeq + 1; n < events.length; n++) {
    const e = events[n];
    if (e.type === 'turn/start') {
      if (current !== null || index >= input.attempts.length
        || e.data.turn !== input.attempts[index].turn) return invalid('unexpected_turn');
      current = e.data.turn; step = null; lastStep = 0; seen = false;
    } else if (e.type === 'step/start') {
      if (current === null || e.data.turn !== current || step !== null
        || !integer(e.data.step) || e.data.step !== lastStep + 1) return invalid('turn_boundary_invalid');
      step = e.data.step; lastStep = step;
    } else if (e.type === 'step/end') {
      if (current === null || step === null || e.data.turn !== current || e.data.step !== step)
        return invalid('turn_boundary_invalid');
      step = null;
    } else if (e.type === 'user/message') {
      if (current === null || step === null || index >= input.attempts.length) return invalid('unexpected_message');
      // The agent loop may append its own runtime snapshot during this step.
      // It is context, not a second human/Goal continuation or authorization.
      if (e.data.role === 'user' && e.data.source?.kind === 'runtime-context') continue;
      const a = input.attempts[index];
      if (seen || e.data.role !== 'user' || e.data.source?.kind !== 'user'
        || e.data.source.rpcId !== a.requestId || e.data.id !== a.messageId)
        return invalid('unexpected_message');
      if (step !== 1) return invalid('continuation_not_first_step');
      const content = e.data.content;
      if (!Array.isArray(content) || content.length !== 1 || !object(content[0])
        || content[0].type !== 'text' || content[0].text !== '继续') return invalid('request_payload_mismatch');
      seen = true;
    } else if (e.type === 'turn/end') {
      if (current === null || step !== null || e.data.turn !== current || index >= input.attempts.length)
        return invalid('turn_boundary_invalid');
      const a = input.attempts[index];
      if (n !== a.endSeq || !seen || e.data.reason?.kind !== 'error') return invalid('attempt_boundary_invalid');
      index++; current = null;
    }
  }
  if (current !== null || index !== input.attempts.length) return invalid('attempt_incomplete');
  const latest = input.attempts[input.attempts.length - 1];
  return {
    verified: true, sessionId: input.sessionId, rootMessageId: input.rootMessageId,
    generation: input.generation, originalEndSeq: input.originalEndSeq,
    originalFailureTurn: input.failureTurn, latestFailureTurn: latest.turn,
    latestFailureEndSeq: latest.endSeq, latestRequestId: latest.requestId,
    latestMessageId: latest.messageId, attemptCount: input.attempts.length,
    observedThroughSeq: events.length - 1, authorizationRequired: true,
    completenessRequiresIndependentVerification: true,
  };
}
