/**
 * Unmounted cold-recovery intent owner. Only trusted Host adapters may call it.
 * Ports: load(), save(snapshot), send(identity). save must resolve only after a
 * durable atomic replacement; load must return its latest durable value. This
 * class serializes one instance, not multiple processes or multiple instances.
 * The Host must hold exclusive storage/execution ownership and validate live
 * session, task, authorization, user intent, and transport binding at dispatch.
 *
 * Identity: sessionId, taskId, generation, workspaceId, rootMessageId,
 * failedTurnId, requestId. The new messageId and turnId are unknown until Host
 * observes them; bindObservation durably records their trusted correlation.
 * Host bridge normalizes numeric failed/new turn values to canonical decimal
 * strings before passing either dispatch or observation/evidence to this API.
 * requestId is supplied by Host and permanently
 * unique in this store. Each failure (session + root/task + failedTurnId) has
 * one tombstone; a distinct failure may proceed only after the session fence is
 * released. Entries are never deleted or re-sent.
 * A fence is persisted before send. A reloaded fence is never dispatchable.
 * Only send({status:'accepted'}) means receipt, not completion. Other recognized
 * outcomes, malformed returns and rejected sends are unknown and stay fenced.
 * Reconciliation accepts matched terminal evidence or positive not-delivered/
 * stopped evidence; a mere idle state, receipt, timeout, or absence proves none.
 * Host must verify correlation/proofs, including that not_delivered excludes
 * future delivery by in-flight sends. This module does not verify proof contents.
 * cancel() revokes immediately in memory and persists a permanent tombstone;
 * an already invoked non-cooperative send cannot be undone by this class.
 * close drains queued storage work, not a pending send; late results do not save.
 * Any candidate validation, revision-exhaustion, or save failure locks this
 * instance and publishes no candidate. Failed cancellation may exist only in
 * memory, including when no write was attempted. The Host must quarantine that
 * storage/session across restart or independently establish the durable outcome.
 * A successful save requires real durability; there is no cross-process CAS.
 */
const ID = ['sessionId', 'taskId', 'generation', 'workspaceId', 'rootMessageId', 'failedTurnId', 'requestId'];
const TERMINAL = ['completed', 'failed', 'aborted'];
const PROOFS = ['not_delivered', 'stopped'];
const str = x => typeof x === 'string' && x.length > 0 && x.length <= 512 && x.trim() === x && !/[\u0000-\u001f]/u.test(x);
const fail = name => { throw new Error('cold_recovery_' + name); };
function copy(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (!v || typeof v !== 'object' || seen.has(v)) fail('invalid_input');
  const a = Array.isArray(v), proto = Object.getPrototypeOf(v);
  if (a ? proto !== Array.prototype : ![Object.prototype, null].includes(proto)) fail('invalid_input');
  const keys = Reflect.ownKeys(v), out = a ? [] : Object.create(null);
  if (a && keys.length !== v.length + 1) fail('invalid_input');
  seen.add(v);
  for (const k of keys) {
    if (a && k === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (typeof k !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') ||
        (a && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length))) fail('invalid_input');
    Object.defineProperty(out, k, { value: copy(d.value, seen), enumerable: true, writable: true, configurable: true });
  }
  seen.delete(v); return out;
}
function shape(v, keys) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) fail('invalid_input');
}
function identity(v) { shape(v, ID); if (!ID.every(k => str(v[k]))) fail('invalid_input'); }
function validate(p) {
  shape(p, ['schemaVersion', 'revision', 'entries', 'revokedSessions']);
  if (!Array.isArray(p.revokedSessions) || !p.revokedSessions.every(str) || new Set(p.revokedSessions).size !== p.revokedSessions.length || p.revokedSessions.length > 10000) fail('invalid_input');
  if (p.schemaVersion !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 0 || !Array.isArray(p.entries) || p.entries.length > 10000) fail('invalid_input');
  const req = new Set(), roots = new Set(), tasks = new Set(), messages = new Set(), active = new Set();
  for (const e of p.entries) {
    shape(e, ['identity', 'status', 'fenced', 'cancelled', 'observation', 'evidence']); identity(e.identity);
    const i = e.identity, root = JSON.stringify([i.sessionId, i.rootMessageId, i.failedTurnId]), task = JSON.stringify([i.sessionId, i.taskId, i.failedTurnId]);
    if (req.has(i.requestId) || roots.has(root) || tasks.has(task)) fail('invalid_input');
    req.add(i.requestId); roots.add(root); tasks.add(task);
    if (e.observation !== null) {
      checkObservation(e.observation); const message = JSON.stringify([i.sessionId, e.observation.messageId]);
      if (messages.has(message)) fail('invalid_input'); messages.add(message);
    }
    if (!['claimed', 'accepted', 'unknown', 'settled'].includes(e.status) || typeof e.fenced !== 'boolean' || typeof e.cancelled !== 'boolean') fail('invalid_input');
    if (e.cancelled !== p.revokedSessions.includes(i.sessionId)) fail('invalid_input');
    if (e.status === 'settled') {
      if (e.fenced || !e.evidence) fail('invalid_input');
      checkEvidence(e.evidence, i, e.observation);
    } else if (!e.fenced || e.evidence !== null) fail('invalid_input');
    if (e.fenced) { if (active.has(i.sessionId)) fail('invalid_input'); active.add(i.sessionId); }
  }
}
function checkObservation(o) {
  shape(o, ['messageId', 'turnId', 'proofId']);
  if (![o.messageId, o.turnId, o.proofId].every(str)) fail('invalid_observation');
}
function checkEvidence(e, i, observation) {
  shape(e, ['identity', 'kind', 'proofId', 'messageId', 'turnId']); identity(e.identity);
  if (!ID.every(k => e.identity[k] === i[k]) || ![...TERMINAL, ...PROOFS].includes(e.kind) || !str(e.proofId)) fail('invalid_evidence');
  if (e.kind === 'not_delivered') {
    if (observation !== null || e.messageId !== null || e.turnId !== null) fail('invalid_evidence');
  } else if (!observation || e.messageId !== observation.messageId || e.turnId !== observation.turnId) fail('invalid_evidence');
}
const sameFailure = (a, b) => a.sessionId === b.sessionId && a.failedTurnId === b.failedTurnId && (a.rootMessageId === b.rootMessageId || a.taskId === b.taskId);
const sameId = (a, b) => ID.every(k => a[k] === b[k]);
export class ColdRecovery {
  #ports; #snapshot = null; #chain = Promise.resolve(); #opening = null; #closing = null; #closed = false; #locked = false; #revoked = new Set();
  constructor(ports) {
    if (!ports || typeof ports.load !== 'function' || typeof ports.save !== 'function' || typeof ports.send !== 'function') throw new TypeError('ColdRecovery requires load/save/send ports');
    this.#ports = ports;
  }
  get locked() { return this.#locked; }
  get opened() { return this.#snapshot !== null; }
  get closed() { return this.#closed; }
  #enqueue(fn) { const p = this.#chain.then(fn); this.#chain = p.then(() => {}, () => {}); return p; }
  #ready() { if (this.#locked) fail('locked'); if (!this.#snapshot) fail('not_open'); }
  open() {
    if (this.#closed) return Promise.reject(new Error('cold_recovery_closed'));
    if (!this.#opening) this.#opening = this.#enqueue(async () => {
      let raw; try { raw = await this.#ports.load(); } catch { this.#locked = true; fail('load_failed'); }
      try { raw = raw == null ? { schemaVersion: 1, revision: 0, entries: [], revokedSessions: [] } : copy(raw); validate(raw); }
      catch { this.#locked = true; fail('invalid_snapshot'); }
      this.#snapshot = structuredClone(raw); return this.getSnapshot();
    });
    return this.#opening.then(() => this.getSnapshot());
  }
  getSnapshot() { if (!this.#snapshot) fail('not_open'); return structuredClone(this.#snapshot); }
  async #save(next) {
    try {
      if (next.revision >= Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
      next.revision++; validate(copy(next));
    } catch (error) { this.#locked = true; throw error; }
    try { await this.#ports.save(structuredClone(next)); } catch { this.#locked = true; fail('save_failed'); }
    this.#snapshot = structuredClone(next);
  }
  /** Sends at most once in this instance, after the exact claim is durable. */
  dispatch(input) {
    if (this.#closed) return Promise.reject(new Error('cold_recovery_closed'));
    let id; try { id = copy(input); identity(id); } catch { return Promise.reject(new Error('cold_recovery_invalid_input')); }
    const invoke = this.#enqueue(async () => {
      this.#ready();
      if (this.#revoked.has(id.sessionId) || this.#snapshot.revokedSessions.includes(id.sessionId)) fail('revoked');
      if (this.#snapshot.entries.some(e => e.identity.requestId === id.requestId || sameFailure(e.identity, id) || (e.fenced && e.identity.sessionId === id.sessionId))) fail('duplicate_or_fenced');
      const next = this.getSnapshot(); next.entries.push({ identity: structuredClone(id), status: 'claimed', fenced: true, cancelled: false, observation: null, evidence: null });
      await this.#save(next);
      if (this.#revoked.has(id.sessionId) || this.#closed) return { invoked: false };
      // Invoke before leaving the serialized section: cancellation arriving while
      // save is pending is observed, while no subsequent caller can race claim.
      let result; try { result = Promise.resolve(this.#ports.send(Object.freeze(structuredClone(id)))); } catch (e) { result = Promise.reject(e); }
      return { invoked: true, result };
    });
    return invoke.then(async ({ invoked, result }) => {
      if (!invoked) return { kind: 'not_sent' };
      let status = 'unknown';
      try {
        const response = copy(await result); shape(response, ['status']);
        if (response.status === 'accepted') status = 'accepted';
      } catch { /* rejected or malformed response is unknown */ }
      // A send result is advisory; even a failed status save leaves the durable
      // claim fenced. Never let a late result overwrite settlement or cancellation.
      if (this.#closed) return { kind: status };
      await this.#enqueue(async () => {
        if (this.#closed) return;
        this.#ready(); const next = this.getSnapshot(); const e = next.entries.find(x => sameId(x.identity, id));
        if (!e || !e.fenced || e.cancelled) return;
        e.status = status; await this.#save(next);
      });
      return { kind: status };
    });
  }
  /** Synchronously revoke session before queued work resumes. */
  cancel(sessionId) {
    if (!str(sessionId)) return Promise.reject(new Error('cold_recovery_invalid_input'));
    if (this.#closed) return Promise.reject(new Error('cold_recovery_closed'));
    this.#revoked.add(sessionId);
    return this.#enqueue(async () => {
      this.#ready(); const next = this.getSnapshot(); const entries = next.entries.filter(e => e.identity.sessionId === sessionId && !e.cancelled);
      if (!entries.length && next.revokedSessions.includes(sessionId)) return this.getSnapshot();
      if (!next.revokedSessions.includes(sessionId)) next.revokedSessions.push(sessionId);
      for (const e of entries) e.cancelled = true;
      await this.#save(next); return this.getSnapshot();
    });
  }
  /** Host positively correlates the actual created message and turn to requestId. */
  bindObservation(input) {
    if (this.#closed) return Promise.reject(new Error('cold_recovery_closed'));
    let v;
    try { v = copy(input); shape(v, ['identity', 'messageId', 'turnId', 'proofId']); identity(v.identity); checkObservation({ messageId: v.messageId, turnId: v.turnId, proofId: v.proofId }); }
    catch { return Promise.reject(new Error('cold_recovery_invalid_observation')); }
    return this.#enqueue(async () => {
      this.#ready(); const next = this.getSnapshot(); const e = next.entries.find(x => sameId(x.identity, v.identity));
      if (!e || !e.fenced || e.observation !== null || next.entries.some(x => x !== e && x.identity.sessionId === v.identity.sessionId && x.observation?.messageId === v.messageId)) fail('observation_mismatch');
      e.observation = { messageId: v.messageId, turnId: v.turnId, proofId: v.proofId };
      await this.#save(next); return this.getSnapshot();
    });
  }
  /** Trusted host-correlated evidence is required; it is not independently authenticated. */
  reconcile(input) {
    if (this.#closed) return Promise.reject(new Error('cold_recovery_closed'));
    let ev; try { ev = copy(input); shape(ev, ['identity', 'kind', 'proofId', 'messageId', 'turnId']); identity(ev.identity); if (![...TERMINAL, ...PROOFS].includes(ev.kind) || !str(ev.proofId) || !(ev.messageId === null || str(ev.messageId)) || !(ev.turnId === null || str(ev.turnId))) fail('invalid_evidence'); } catch { return Promise.reject(new Error('cold_recovery_invalid_evidence')); }
    return this.#enqueue(async () => {
      this.#ready(); const next = this.getSnapshot(); const e = next.entries.find(x => sameId(x.identity, ev.identity));
      if (!e || !e.fenced) fail('evidence_mismatch');
      checkEvidence(ev, e.identity, e.observation); e.status = 'settled'; e.fenced = false; e.evidence = structuredClone(ev);
      await this.#save(next); return this.getSnapshot();
    });
  }
  close() { if (!this.#closing) { this.#closed = true; this.#closing = this.#chain; } return this.#closing; }
}
