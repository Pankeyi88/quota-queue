/**
 * Unmounted, read-only projection of one explicitly selected session snapshot.
 * The caller supplies the full inspected event list, its independently known
 * last sequence, and the exclusive request boundary. This reports durable
 * observations, never ownership, non-delivery, or successful claim delivery.
 */
import { isDeepStrictEqual } from 'node:util';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = (x) => typeof x === 'string' && x.length > 0 && x.length <= 512
  && x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x);
const index = (x) => Number.isSafeInteger(x) && x >= 0;
const invalid = () => ({ status: 'invalid', reason: 'inbox_history_invalid' });
const matchesPayload = (m) => m.content.length === 1 && object(m.content[0])
  && m.content[0].type === 'text' && m.content[0].text === '继续';

/**
 * input: { sessionId, requestId, afterSeq, snapshotSeq, inspection }.
 * inspection must be the complete, non-inherited v4 session history from seq 0;
 * snapshotSeq must be independently obtained from that same snapshot. Only
 * matches strictly after afterSeq belong to this request scope.
 * Competing input is counted at the snapshot, not across historical turns.
 * A cross-event ID reuse is a valid fold but cannot prove occurrence identity:
 * return ambiguous, including for the remove/insert shape used by steer.
 * modified and sourceChanged are ever-observed same-ID replacements; discarded
 * means a canceled removal without same-ID replacement (also used by steer).
 * A removal without outcome is not evidence of successful delivery.
 */
export function correlateContinueInbox(input) {
  try { return fold(input); } catch { return invalid(); }
}

function fold(input) {
  if (!object(input) || !id(input.sessionId) || !id(input.requestId)
      || !index(input.afterSeq) || !index(input.snapshotSeq)
      || input.afterSeq > input.snapshotSeq || !object(input.inspection)) return invalid();
  const { inspection, requestId, afterSeq, snapshotSeq, sessionId } = input;
  if (!object(inspection.meta) || inspection.meta.id !== sessionId
      || inspection.meta.version !== 4 || inspection.meta.isSeeded !== false
      || inspection.meta.parentSession !== undefined || inspection.meta.origin !== undefined
      || inspection.inheritedEventCount !== 0 || !Array.isArray(inspection.events)
      || inspection.events.length !== snapshotSeq + 1) return invalid();

  const lists = { 'next-turn': [], 'next-step': [] };
  const seen = new Set();
  let target = null;
  let ambiguous = false;
  for (let seq = 0; seq < inspection.events.length; seq++) {
    const event = inspection.events[seq];
    if (!object(event) || event.seq !== seq || !id(event.type) || !object(event.data)) return invalid();
    if (event.type !== 'agent/inbox/spliced') continue;
    const d = event.data;
    if ((d.target !== 'next-turn' && d.target !== 'next-step') || !index(d.start)
        || (d.removedCount !== undefined && !index(d.removedCount))
        || !Array.isArray(d.inserted) || (d.outcome !== undefined && d.outcome !== 'canceled')) return invalid();
    const list = lists[d.target];
    const count = d.removedCount ?? 0;
    if (d.start > list.length || count > list.length - d.start
        || (count === 0 && d.inserted.length === 0)
        || (d.outcome === 'canceled' && count === 0)) return invalid();
    const removed = list.slice(d.start, d.start + count);
    const removedById = new Map(removed.map((m) => [m.id, m]));
    for (const m of d.inserted) {
      if (!object(m) || !id(m.id) || m.role !== 'user' || !object(m.source)
          || !id(m.source.kind) || !Array.isArray(m.content)) return invalid();
      const replacement = removedById.has(m.id);
      // The host only requires IDs to be unique among currently pending
      // messages. A later insertion of a removed ID could be a different
      // occurrence, even when it resembles updateQueue(steer).
      if (seen.has(m.id) && !replacement) ambiguous = true;
      if (replacement && m.id === target?.messageId && !ambiguous) {
        const old = removedById.get(m.id);
        if (!isDeepStrictEqual(old, m)) target.modified = true;
        if (!isDeepStrictEqual(old.source, m.source)) target.sourceChanged = true;
      }
      if (!seen.has(m.id)) {
        seen.add(m.id);
        if (m.source.kind === 'user' && m.source.rpcId === requestId) {
          if (seq <= afterSeq || target !== null) return invalid();
          target = {
            messageId: m.id, enqueueSeq: seq, initialTarget: d.target,
            initialPayloadMatches: matchesPayload(m),
            seenInNextStep: d.target === 'next-step', modified: false,
            sourceChanged: false, discarded: false, removedWithoutOutcome: false,
          };
        }
      }
    }
    if (!ambiguous && target && removedById.has(target.messageId)) {
      const replaced = d.inserted.some((m) => m.id === target.messageId);
      if (d.outcome === 'canceled' && !replaced) target.discarded = true;
      if (d.outcome === undefined && !replaced) target.removedWithoutOutcome = true;
    }
    list.splice(d.start, count, ...d.inserted);
    const pendingIds = new Set();
    for (const m of [...lists['next-turn'], ...lists['next-step']]) {
      if (pendingIds.has(m.id)) return invalid();
      pendingIds.add(m.id);
    }
  }
  // Still validate and fold all later splices after detecting ambiguity. Do not
  // infer which occurrence a reused ID denotes, even for an apparent steer.
  if (ambiguous) return { status: 'ambiguous', reason: 'message_id_reused', snapshotSeq };
  let competingUserPending = false;
  let otherPending = false;
  let location = null;
  let currentPayloadMatches = null;
  for (const place of ['next-turn', 'next-step']) {
    for (const m of lists[place]) {
      if (target && m.id === target.messageId) {
        location = place;
        currentPayloadMatches = matchesPayload(m);
      } else {
        otherPending = true;
        if (m.source.kind === 'user') competingUserPending = true;
      }
    }
  }
  return target === null
    ? { status: 'not_observed', snapshotSeq, competingUserPending, otherPending }
    : { status: 'observed', snapshotSeq, ...target, location, currentPayloadMatches,
        competingUserPending, otherPending };
}
