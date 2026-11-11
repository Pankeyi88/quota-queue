/**
 * Pure, separate schema for EXISTING-task recovery. No I/O or Host imports.
 * API: createRecoveryPlan(options?), validateRecoveryPlan(value) -> issues[],
 * applyRecoveryPlan(plan, expectedRevision, command) -> detached next snapshot.
 *
 * Integration MUST serialize read/transform/durable-save/publication and only
 * execute a claim AFTER its returned fence is durable. A rejected save means
 * discard the candidate and execute nothing. Revision is NOT backend CAS or a
 * Host lock. All Host facts are trusted adapter assertions, not authentication.
 * Never expose these commands directly as model tools. Host must confirm the
 * original task, explicit user actions, current facts, and exclusive ownership.
 * Quota transport, singleflight, cooldown, route binding and external execution
 * observation remain Host responsibilities. This module does not migrate the
 * old queue schema. Unknown/corrupt snapshots are rejected, never repaired.
 */
import { InputValidationError, SnapshotValidationError, RevisionConflictError, StateTransitionError } from './errors.mjs';

const STATES = ['ready', 'waiting_quota', 'running', 'needs_attention', 'succeeded', 'failed', 'stopped'];
// The plan is rendered on every bootstrap and re-validated on every command, so
// it must stay bounded. These caps are part of the schema: loaded snapshots
// above them are rejected rather than silently truncated.
const MAX_ITEMS = 100;
const MAX_BATCHES = 50;
const RESULTS = ['completed', 'error', 'aborted', 'quota', 'unknown'];
const fail = () => { throw new InputValidationError('invalid recovery plan input'); };
const invariant = (ok) => { if (!ok) fail(); };
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && v.trim() === v && !/[\u0000-\u001f]/u.test(v);
const uint = (v) => Number.isSafeInteger(v) && v >= 0;
const bool = (v) => typeof v === 'boolean';

// Reject getters, symbols, sparse arrays, cycles, custom prototypes, undefined,
// non-finite numbers and non-enumerable fields before reading any payload.
function json(v, ancestors = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') { invariant(Number.isFinite(v)); return; }
  invariant(typeof v === 'object' && !ancestors.has(v));
  const array = Array.isArray(v);
  invariant(array ? Object.getPrototypeOf(v) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(v)));
  const keys = Reflect.ownKeys(v);
  ancestors.add(v);
  if (array) invariant(keys.length === v.length + 1);
  for (const k of keys) {
    if (array && k === 'length') continue;
    invariant(typeof k === 'string');
    if (array) invariant(/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < v.length);
    const d = Object.getOwnPropertyDescriptor(v, k);
    invariant(d.enumerable && Object.hasOwn(d, 'value'));
    json(d.value, ancestors);
  }
  ancestors.delete(v);
}
function shape(o, keys) {
  invariant(o !== null && typeof o === 'object' && !Array.isArray(o));
  invariant(Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k)));
}
function fields(o, stringKeys = [], booleanKeys = []) {
  for (const k of stringKeys) invariant(text(o[k]));
  for (const k of booleanKeys) invariant(bool(o[k]));
}
function reference(r) {
  shape(r, ['taskId', 'sessionId', 'generation', 'workspaceId', 'quotaScopeId']);
  fields(r, ['taskId', 'sessionId', 'generation', 'workspaceId']);
  // An unbound plan may be edited without inventing an account scope. Null is
  // never sufficient for authorization, a claim, or an execution history.
  invariant(r.quotaScopeId === null || text(r.quotaScopeId));
}
function scope(a, r) {
  shape(a, ['sessionId', 'generation', 'enabled']);
  fields(a, ['sessionId', 'generation'], ['enabled']);
  invariant(a.sessionId === r.sessionId && a.generation === r.generation);
  invariant(a.enabled === false || text(r.quotaScopeId));
}
function fence(f, r) {
  shape(f, ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId', 'turnId']);
  fields(f, ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId']);
  invariant(f.turnId === null || text(f.turnId));
  invariant(['sessionId', 'generation', 'workspaceId'].every((k) => f[k] === r[k]));
}
function check(p) {
  json(p);
  shape(p, ['schemaVersion', 'revision', 'maxConcurrent', 'paused', 'batches', 'items', 'usedClaimIds', 'usedMessageIds']);
  invariant(p.schemaVersion === 1 && uint(p.revision));
  invariant(Number.isInteger(p.maxConcurrent) && p.maxConcurrent >= 1 && p.maxConcurrent <= 8 && bool(p.paused));
  invariant(Array.isArray(p.batches) && Array.isArray(p.items) && Array.isArray(p.usedClaimIds));
  invariant(p.items.length <= MAX_ITEMS && p.batches.length <= MAX_BATCHES);
  invariant(p.usedClaimIds.every(text) && new Set(p.usedClaimIds).size === p.usedClaimIds.length);
  invariant(Array.isArray(p.usedMessageIds) && p.usedMessageIds.every(text) && new Set(p.usedMessageIds).size === p.usedMessageIds.length && p.usedMessageIds.length === p.usedClaimIds.length);
  const ids = new Set(), refs = new Set(), activeSessions = new Set(), claims = new Set();
  for (const i of p.items) {
    shape(i, ['id', 'ref', 'authorization', 'status', 'paused', 'removed', 'skip', 'result', 'attempts', 'fence']);
    invariant(text(i.id) && !ids.has(i.id)); ids.add(i.id);
    reference(i.ref); scope(i.authorization, i.ref);
    const key = JSON.stringify([i.ref.sessionId, i.ref.generation]);
    invariant(!refs.has(key)); refs.add(key);
    invariant(STATES.includes(i.status) && bool(i.paused) && bool(i.removed) && uint(i.attempts));
    invariant(i.result === null || RESULTS.includes(i.result));
    if (i.skip !== null) { shape(i.skip, ['confirmed']); invariant(i.skip.confirmed === true); }
    if (!i.removed && !i.skip && !['succeeded', 'failed', 'stopped'].includes(i.status)) {
      invariant(!activeSessions.has(i.ref.sessionId)); activeSessions.add(i.ref.sessionId);
    }
    invariant((i.status === 'succeeded') === (i.result === 'completed'));
    if (i.status === 'succeeded') invariant(i.attempts > 0 && i.fence === null);
    if (i.result === 'error') invariant(i.status === 'failed' && i.fence === null);
    if (i.result === 'aborted') invariant(i.status === 'stopped' && i.fence === null);
    if (i.result === 'unknown') invariant(i.status === 'needs_attention' && i.fence === null);
    if (i.attempts === 0) invariant(i.status === 'ready' && i.result === null && i.fence === null);
    if (i.attempts > 0) invariant(text(i.ref.quotaScopeId));
    if (i.status === 'ready') invariant(i.attempts === 0);
    if (i.status === 'waiting_quota') invariant(i.attempts > 0 && i.result === 'quota' && i.fence === null);
    if (i.status === 'failed') invariant(i.attempts > 0 && i.result === 'error' && i.fence === null);
    if (i.status === 'stopped') invariant(i.attempts > 0 && i.result === 'aborted' && i.fence === null);
    if (i.status === 'running') invariant(i.attempts > 0 && i.fence !== null && (i.result === null || i.result === 'quota'));
    if (i.status === 'needs_attention') invariant(i.attempts > 0 && (i.fence === null ? i.result === 'unknown' : i.result === null || i.result === 'quota'));
    if (i.fence !== null) {
      fence(i.fence, i.ref);
      invariant(i.attempts > 0 && p.usedClaimIds.includes(i.fence.claimId) && p.usedMessageIds[p.usedClaimIds.indexOf(i.fence.claimId)] === i.fence.messageId && !claims.has(i.fence.claimId));
      claims.add(i.fence.claimId);
    }
  }
  const totalAttempts = p.items.reduce((sum, i) => sum + i.attempts, 0);
  invariant(Number.isSafeInteger(totalAttempts) && totalAttempts === p.usedClaimIds.length);
  const listed = new Set();
  for (const b of p.batches) {
    invariant(Array.isArray(b) && b.length > 0);
    for (const id of b) { invariant(ids.has(id) && !listed.has(id)); listed.add(id); }
  }
  invariant(listed.size === ids.size);
  // Loaded fences may exceed a newly lowered limit, but never overlap a session
  // or workspace: a corrupt snapshot must not be used for further scheduling.
  const sessions = new Set(), workspaces = new Set();
  for (const i of p.items.filter((i) => i.fence !== null)) {
    invariant(!sessions.has(i.ref.sessionId) && !workspaces.has(i.ref.workspaceId));
    sessions.add(i.ref.sessionId); workspaces.add(i.ref.workspaceId);
  }
}

/** Return a detached empty v1 plan; default maxConcurrent=1. */
export function createRecoveryPlan(options = {}) {
  json(options);
  invariant(options !== null && typeof options === 'object' && !Array.isArray(options) && Object.keys(options).every((k) => k === 'maxConcurrent'));
  const p = { schemaVersion: 1, revision: 0, maxConcurrent: Object.hasOwn(options, 'maxConcurrent') ? options.maxConcurrent : 1, paused: false, batches: [], items: [], usedClaimIds: [], usedMessageIds: [] };
  check(p); return p;
}
/** All entry points validate the complete snapshot, including unknown fields. */
export function validateRecoveryPlan(value) {
  try { check(value); return []; } catch { return ['invalid_recovery_plan']; }
}
function blocked() { throw new StateTransitionError('recovery plan transition blocked'); }
function requireThat(ok) { if (!ok) blocked(); }
function item(p, id) { invariant(text(id)); const i = p.items.find((i) => i.id === id); invariant(i !== undefined); return i; }
function matching(f, e) {
  return ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId'].every((k) => e[k] === f[k]);
}

/**
 * Strict commands (all fields required; see switch shapes below).
 * add: Host-confirmed reference plus exact authorization scope, existing batch
 * index or batches.length to append. No prompts/credentials/new-session data.
 * claim: current Host facts and unique claim/message IDs. Returned snapshot is
 * an INTENT, not permission to execute before durability/Host locking.
 * bindTurn: persisted message->turn correlation; cannot overwrite another turn.
 * settle: only matched terminal evidence or positive stopped evidence releases
 * a fence; idle/accepted/receipt are deliberately not evidence types.
 * recover: marks all fenced entries needs_attention WITHOUT releasing fences.
 * remove is a REAL exit for an entry that never ran (no attempt, no fence): the
 * record and its batch slot are deleted so the same session can be queued again.
 * An entry with execution history keeps its tombstone instead; skip never erases
 * records or fences. Reorder is a full permutation and cannot move any attempted
 * item, including temporarily unfenced quota waits.
 * restore brings a tombstone back for the SAME session (as when this Host had no
 * verified account scope yet), refreshing its identity and keeping authorization
 * DISABLED: restoring is not authorizing.
 * rebindScope: Host-only binding of one fixed account scope to an untried item;
 * it can never enable an authorization by itself.
 */
export function applyRecoveryPlan(plan, expectedRevision, command) {
  if (validateRecoveryPlan(plan).length) throw new SnapshotValidationError('invalid recovery plan');
  invariant(uint(expectedRevision));
  if (expectedRevision !== plan.revision) throw new RevisionConflictError('recovery plan revision mismatch', { expected: expectedRevision, actual: plan.revision });
  invariant(plan.revision < Number.MAX_SAFE_INTEGER);
  json(command); invariant(command !== null && typeof command === 'object' && !Array.isArray(command));
  const p = structuredClone(plan), c = command;
  switch (c.type) {
    case 'add': {
      shape(c, ['type', 'id', 'ref', 'authorization', 'hostConfirmedExisting', 'batch']);
      invariant(text(c.id) && c.hostConfirmedExisting === true && uint(c.batch) && c.batch <= p.batches.length);
      reference(c.ref); scope(c.authorization, c.ref);
      requireThat(!p.items.some((i) => i.id === c.id || (i.ref.sessionId === c.ref.sessionId && i.ref.generation === c.ref.generation)));
      p.items.push({ id: c.id, ref: structuredClone(c.ref), authorization: structuredClone(c.authorization), status: 'ready', paused: false, removed: false, skip: null, result: null, attempts: 0, fence: null });
      if (c.batch === p.batches.length) p.batches.push([]);
      p.batches[c.batch].push(c.id); break;
    }
    case 'configure':
      shape(c, ['type', 'maxConcurrent']); p.maxConcurrent = c.maxConcurrent; break;
    case 'rebindScope': {
      // Host-only fact, never requested by the Client: bind the deployment's
      // one fixed account scope to an already-added item. Authorizations stay
      // untouched (an authorization without a scope is always false).
      shape(c, ['type', 'id', 'quotaScopeId']);
      invariant(text(c.quotaScopeId)); const bound = item(p, c.id);
      requireThat(bound.attempts === 0 && bound.fence === null);
      bound.ref.quotaScopeId = c.quotaScopeId;
      break;
    }
    case 'pausePlan':
      shape(c, ['type', 'paused']); invariant(bool(c.paused)); p.paused = c.paused; break;
    case 'pause': {
      shape(c, ['type', 'id', 'paused']); invariant(bool(c.paused)); item(p, c.id).paused = c.paused; break;
    }
    case 'authorize': {
      shape(c, ['type', 'id', 'authorization']); const i = item(p, c.id); scope(c.authorization, i.ref);
      requireThat(!i.removed && !i.skip && i.status !== 'succeeded'); i.authorization = structuredClone(c.authorization); break;
    }
    case 'remove': {
      shape(c, ['type', 'id']); const i = item(p, c.id);
      // "Remove from the plan" must actually exit. An entry that never ran and
      // holds no fence owns no execution history, so its record and batch slot
      // are deleted and nothing keeps the session from being queued again.
      // An attempted/fenced entry stays as a tombstone: its claim evidence must
      // not disappear just because the user stopped ordering it.
      if (i.attempts === 0 && i.fence === null) {
        p.items = p.items.filter((v) => v.id !== i.id);
        p.batches = p.batches.map((b) => b.filter((id) => id !== i.id)).filter((b) => b.length > 0);
        break;
      }
      i.removed = true; i.authorization.enabled = false; break;
    }
    case 'restore': {
      // A tombstone is not a dead end: the user may queue the SAME session
      // again. The identity is refreshed to what the Host just verified (a
      // later human prompt is a new generation) and the authorization stays
      // disabled, so restoring never grants a permission the user did not give
      // through the one switch.
      shape(c, ['type', 'id', 'ref']);
      const t = item(p, c.id); reference(c.ref);
      requireThat(t.removed === true && t.attempts === 0 && t.fence === null
        && t.skip === null && t.status === 'ready');
      requireThat(c.ref.sessionId === t.ref.sessionId);
      requireThat(!p.items.some((v) => v.id !== t.id && v.ref.sessionId === c.ref.sessionId
        && v.ref.generation === c.ref.generation));
      requireThat(!p.items.some((v) => v.id !== t.id && v.ref.sessionId === c.ref.sessionId
        && !v.removed && v.skip === null && !['succeeded', 'failed', 'stopped'].includes(v.status)));
      t.ref = structuredClone(c.ref);
      t.authorization = { sessionId: c.ref.sessionId, generation: c.ref.generation, enabled: false };
      t.removed = false; break;
    }
    case 'skip': {
      shape(c, ['type', 'id', 'confirmed']); invariant(c.confirmed === true); const i = item(p, c.id);
      requireThat(i.fence === null && i.status !== 'running');
      i.skip = { confirmed: true }; i.authorization.enabled = false; break;
    }
    case 'reorder': {
      shape(c, ['type', 'batches']); invariant(Array.isArray(c.batches));
      const position = (bs, id) => JSON.stringify(bs.flatMap((b, n) => b.map((v, m) => [v, n, m])).find(([v]) => v === id));
      for (const i of p.items) if (i.attempts > 0 || i.fence !== null) requireThat(position(p.batches, i.id) === position(c.batches, i.id));
      p.batches = structuredClone(c.batches); break;
    }
    case 'claim': {
      shape(c, ['type', 'id', 'claimId', 'messageId', 'facts']); fields(c, ['claimId', 'messageId']);
      const i = item(p, c.id), f = c.facts;
      shape(f, ['sessionId', 'generation', 'workspaceId', 'quotaScopeId', 'existingTaskConfirmed', 'quotaAvailable', 'hostStopped', 'exclusiveOwnership', 'configurationUnchanged', 'noOtherExecution']);
      fields(f, ['sessionId', 'generation', 'workspaceId', 'quotaScopeId'], ['existingTaskConfirmed', 'quotaAvailable', 'hostStopped', 'exclusiveOwnership', 'configurationUnchanged', 'noOtherExecution']);
      requireThat(['sessionId', 'generation', 'workspaceId', 'quotaScopeId'].every((k) => f[k] === i.ref[k]));
      requireThat(['existingTaskConfirmed', 'quotaAvailable', 'hostStopped', 'exclusiveOwnership', 'configurationUnchanged', 'noOtherExecution'].every((k) => f[k] === true));
      requireThat(!p.paused && !i.paused && !i.removed && !i.skip && i.authorization.enabled && ['ready', 'waiting_quota'].includes(i.status) && i.fence === null && !p.usedClaimIds.includes(c.claimId) && !p.usedMessageIds.includes(c.messageId));
      const held = p.items.filter((v) => v.fence !== null);
      requireThat(held.length < p.maxConcurrent && !held.some((v) => v.ref.sessionId === i.ref.sessionId || v.ref.workspaceId === i.ref.workspaceId));
      const batch = p.batches.findIndex((b) => b.includes(i.id));
      requireThat(p.batches.slice(0, batch).flat().every((id) => { const prev = item(p, id); return prev.fence === null && (prev.status === 'succeeded' || prev.skip?.confirmed === true); }));
      i.fence = { claimId: c.claimId, sessionId: i.ref.sessionId, generation: i.ref.generation, workspaceId: i.ref.workspaceId, messageId: c.messageId, turnId: null };
      i.status = 'running'; invariant(i.attempts < Number.MAX_SAFE_INTEGER); i.attempts++; p.usedClaimIds.push(c.claimId); p.usedMessageIds.push(c.messageId); break;
    }
    case 'bindTurn': {
      shape(c, ['type', 'id', 'claimId', 'messageId', 'turnId']); fields(c, ['claimId', 'messageId', 'turnId']); const i = item(p, c.id);
      requireThat(i.fence !== null && i.fence.claimId === c.claimId && i.fence.messageId === c.messageId && (i.fence.turnId === null || i.fence.turnId === c.turnId));
      i.fence.turnId = c.turnId; break;
    }
    case 'settle': {
      shape(c, ['type', 'id', 'evidence']); const i = item(p, c.id), e = c.evidence;
      invariant(e !== null && typeof e === 'object');
      if (e.kind === 'terminal') {
        shape(e, ['kind', 'claimId', 'sessionId', 'generation', 'workspaceId', 'messageId', 'turnId', 'outcome']);
        fields(e, ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId', 'turnId']);
        invariant(['completed', 'error', 'aborted', 'quota'].includes(e.outcome));
        requireThat(i.fence !== null && matching(i.fence, e) && i.fence.turnId !== null && i.fence.turnId === e.turnId);
      } else {
        shape(e, ['kind', 'claimId', 'sessionId', 'generation', 'workspaceId', 'messageId', 'hostStopped']);
        invariant(e.kind === 'stopped' && e.hostStopped === true);
        fields(e, ['claimId', 'sessionId', 'generation', 'workspaceId', 'messageId']);
        requireThat(i.fence !== null && matching(i.fence, e));
      }
      i.fence = null; i.result = e.kind === 'terminal' ? e.outcome : 'unknown';
      i.status = ({ completed: 'succeeded', error: 'failed', aborted: 'stopped', quota: 'waiting_quota', unknown: 'needs_attention' })[i.result];
      break;
    }
    case 'recover':
      shape(c, ['type']); for (const i of p.items) if (i.fence !== null) i.status = 'needs_attention'; break;
    default: fail();
  }
  p.revision++; check(p); return p;
}
