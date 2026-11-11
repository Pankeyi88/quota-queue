/**
 * Selected-session identity inspection over the plugin's read-only inspection
 * port (host/session-inspection.js, built on the public `sessionQuery`
 * observation seam). Unlike list(), it can read a complete log. Call only for a
 * user-selected session; never bulk-inspect to populate the sidebar. Message
 * content is neither accessed nor returned. This proves an identity, NOT
 * quota/account/ownership.
 */
import { createHash } from 'node:crypto';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
/**
 * One fail-closed result. `capabilityUnavailable` separates "the Host cannot
 * read the log at all" from "the log was read but this task is not a recoverable
 * scope": the plan operation reports them as different failures.
 */
const unavailable = (reason, capabilityUnavailable = false) => (capabilityUnavailable
  ? { verified: false, reason, capabilityUnavailable: true }
  : { verified: false, reason });

export function taskIdentityFromInspection(sessionId, inspection) {
  if (!id(sessionId) || !object(inspection) || !object(inspection.meta)
    || inspection.meta.id !== sessionId || inspection.meta.version !== 4
    || inspection.meta.isSeeded !== false || inspection.meta.parentSession !== undefined
    || inspection.meta.origin !== undefined || inspection.inheritedEventCount !== 0
    || !Array.isArray(inspection.events)) return unavailable('task_inspection_invalid');
  if (!id(inspection.meta.cwd)) return unavailable('task_workspace_unknown');

  let current = null;
  // The task scope is the LATEST turn that carries a real human prompt. A
  // later synthetic-only turn (subagent notification, Goal/context injection)
  // continues the same task and must not erase the human root. Additional
  // human messages inside that turn are steering; the first one is the root.
  let latest = null;
  // The session's NEWEST turn, whatever it carries. Goal rounds, auto-continue
  // deliveries and other synthetic turns append turns after the human one, so
  // "is this task finished?" can only be read from the newest turn. The root
  // above stays the authorization scope; this is the current runtime boundary.
  let newest = null;
  // DSH emits `request/header` only when the request route changes. A turn
  // with no header of its own inherits the last observed route.
  let lastRoute = null;
  for (let index = 0; index < inspection.events.length; index++) {
    const event = inspection.events[index];
    if (!object(event) || event.seq !== index || !id(event.type) || !object(event.data)) {
      return unavailable('task_inspection_invalid');
    }
    if (event.type === 'turn/start') {
      if (current !== null || !integer(event.data.turn)) return unavailable('task_boundary_invalid');
      current = { turn: event.data.turn, seq: event.seq, root: null, humanCount: 0, ended: false, endKind: null, step: null, route: lastRoute };
      newest = current;
    } else if (event.type === 'user/message') {
      // Synthetic context/Goal/agent notices are not a fresh user authorization.
      if (event.data.source?.kind !== 'user') continue;
      if (current === null || !id(event.data.id) || event.data.role !== 'user') {
        return unavailable('task_boundary_invalid');
      }
      current.humanCount++;
      if (current.root === null) {
        current.root = { messageId: event.data.id, messageSeq: event.seq };
        latest = current;
      }
    } else if (event.type === 'turn/end') {
      if (current === null || event.data.turn !== current.turn || !id(event.data.reason?.kind)) {
        return unavailable('task_boundary_invalid');
      }
      current.ended = true;
      current.endKind = event.data.reason.kind;
      current = null;
    } else if (event.type === 'step/start') {
      if (current === null || event.data.turn !== current.turn || !integer(event.data.step) || current.step !== null) {
        return unavailable('task_boundary_invalid');
      }
      current.step = event.data.step;
    } else if (event.type === 'step/end') {
      if (current === null || current.step === null || event.data.turn !== current.turn || event.data.step !== current.step) {
        return unavailable('task_boundary_invalid');
      }
      current.step = null;
    } else if (event.type === 'request/header') {
      // A header may be logged before the prompt that owns the step, and later
      // turns omit it when the route is unchanged. Record the last valid route
      // on the current turn and let subsequent turns inherit it; a malformed
      // header clears it instead of leaving a stale route behind.
      if (current === null) continue;
      const config = event.data.header?.config;
      const valid = object(config) && id(config.provider) && id(config.model);
      const next = valid ? { provider: config.provider, model: config.model } : null;
      lastRoute = next;
      current.route = next;
    }
  }
  if (latest === null || latest.root === null) return unavailable('task_scope_ambiguous');
  if (latest.route === null) return unavailable('task_route_unknown');
  const fingerprint = JSON.stringify([sessionId, latest.root.messageId, latest.root.messageSeq, latest.turn, latest.seq]);
  return {
    verified: true,
    sessionId,
    taskId: latest.root.messageId,
    generation: createHash('sha256').update(fingerprint).digest('hex'),
    rootMessageId: latest.root.messageId,
    rootMessageSeq: latest.root.messageSeq,
    turn: latest.turn,
    turnStartSeq: latest.seq,
    asOfSeq: inspection.events.length - 1,
    workspacePath: inspection.meta.cwd,
    provider: latest.route.provider,
    model: latest.route.model,
    // The human root's turn boundary: what the continuation/recovery
    // correlation code binds an authorization to.
    turnEnded: latest.ended,
    turnEndKind: latest.endKind,
    // The newest turn's boundary, independent of which turn carried a human
    // prompt. Enqueueing judges completion on this, never on a root turn that
    // may have completed many Goal/continuation turns ago.
    lastTurn: newest.turn,
    lastTurnEnded: newest.ended,
    lastTurnEndKind: newest.endKind,
  };
}

export async function inspectSelectedTask(resolveInspection, sessionId, signal) {
  if (!id(sessionId) || signal?.aborted) return unavailable(signal?.aborted ? 'cancelled' : 'task_inspection_invalid');
  let port;
  try { port = resolveInspection(); } catch { port = undefined; }
  if (port === null || port === undefined) return unavailable('task_inspection_unavailable', true);
  let inspect;
  try { inspect = port.inspect; } catch { return unavailable('task_inspection_failed'); }
  if (typeof inspect !== 'function') return unavailable('task_inspection_unavailable', true);
  try {
    const inspection = await inspect.call(port, sessionId, signal);
    if (signal?.aborted) return unavailable('cancelled');
    return taskIdentityFromInspection(sessionId, inspection);
  } catch (error) {
    if (signal?.aborted) return unavailable('cancelled');
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    if (code === 'session_inspection_unavailable') return unavailable('task_inspection_unavailable', true);
    return unavailable('task_inspection_failed');
  }
}
