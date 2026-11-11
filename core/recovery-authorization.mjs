/**
 * Independent, unmounted authorization store. Only a trusted Host may hold the
 * object capability and call grant/revoke after a real human confirmation.
 * Never expose that capability or these methods to a client command handler.
 * save must resolve only when durable; revision is instance-local, NOT CAS.
 * Revoke blocks future checks synchronously in this instance, but cannot cancel
 * dispatch already started. The Host must recheck at its dispatch boundary and
 * coordinate cancellation/ownership. A failed revoke may leave an older durable
 * grant after restart. Loaded grants are disarmed until a new explicit durable
 * grant. close is not a persistent revoke; the Host must remediate failed writes.
 */
const fields = ['session', 'root', 'generation', 'workspace', 'provider', 'model'];
const keys = [...fields, 'planRevision', 'expiresAt'];
const empty = () => ({ schemaVersion: 1, revision: 0, grant: null });
const plain = (o) => o !== null && typeof o === 'object' && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
function copyRecord(value, allowed) {
  if (!plain(value)) throw new Error('recovery_authorization_invalid_input');
  const names = Reflect.ownKeys(value);
  if (names.length !== allowed.length || names.some(k => typeof k !== 'string' || !allowed.includes(k))) throw new Error('recovery_authorization_invalid_input');
  const out = {};
  for (const key of allowed) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) throw new Error('recovery_authorization_invalid_input');
    out[key] = d.value;
  }
  return out;
}
function binding(value, withExpiry) {
  const b = copyRecord(value, withExpiry ? keys : [...fields, 'planRevision']);
  if (fields.some(k => typeof b[k] !== 'string' || b[k].trim().length === 0)
      || !Number.isSafeInteger(b.planRevision) || b.planRevision < 0
      || (withExpiry && (!Number.isSafeInteger(b.expiresAt) || b.expiresAt <= 0))) {
    throw new Error('recovery_authorization_invalid_input');
  }
  return b;
}
function snapshot(raw) {
  const s = copyRecord(raw, ['schemaVersion', 'revision', 'grant']);
  if (s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0) throw new Error('invalid');
  return { schemaVersion: 1, revision: s.revision, grant: s.grant === null ? null : binding(s.grant, true) };
}
export class RecoveryAuthorizationStore {
  #ports; #capability; #clock; #state = null; #locked = false; #closed = false;
  #chain = Promise.resolve(); #opening = null; #closing = null; #epoch = 0; #revocations = 0;
  #armed = false; #highWater = 0;
  constructor(ports, { humanCapability, now = Date.now } = {}) {
    if (!ports || typeof ports.load !== 'function' || typeof ports.save !== 'function'
      || humanCapability === null || typeof humanCapability !== 'object' || typeof now !== 'function') throw new TypeError('load/save, trusted humanCapability and clock required');
    this.#ports = ports; this.#capability = humanCapability; this.#clock = now;
  }
  get locked() { return this.#locked; }
  get opened() { return this.#state !== null; }
  get closed() { return this.#closed; }
  #queue(fn) { const result = this.#chain.then(fn); this.#chain = result.then(() => {}, () => {}); return result; }
  #ready() {
    if (this.#locked) throw new Error('recovery_authorization_locked');
    if (!this.#state) throw new Error('recovery_authorization_not_open');
  }
  #authority(capability) { if (capability !== this.#capability) throw new Error('recovery_authorization_human_confirmation_required'); }
  open() {
    if (this.#closed) return Promise.reject(new Error('recovery_authorization_closed'));
    if (!this.#opening) this.#opening = this.#queue(async () => {
      let raw;
      try { raw = await this.#ports.load(); } catch { this.#locked = true; throw new Error('recovery_authorization_load_failed'); }
      try { this.#state = raw == null ? empty() : snapshot(raw); }
      catch { this.#locked = true; throw new Error('recovery_authorization_invalid_snapshot'); }
    });
    return this.#opening.then(() => this.getSnapshot());
  }
  getSnapshot() { if (!this.#state) throw new Error('recovery_authorization_not_open'); return structuredClone(this.#state); }
  // High-water is local to this instance; loaded grants always start disarmed.
  #time() {
    let now;
    try { now = this.#clock(); } catch { this.#armed = false; throw new Error('recovery_authorization_clock'); }
    if (!Number.isSafeInteger(now) || now < this.#highWater) {
      this.#armed = false; throw new Error('recovery_authorization_clock');
    }
    this.#highWater = now;
    return now;
  }
  /** Exact current Host facts; missing/invalid facts and clock fail closed. */
  isAuthorized(context) {
    if (this.#closed || this.#locked || this.#revocations || !this.#armed || !this.#state?.grant) return false;
    const state = this.#state, g = state.grant, epoch = this.#epoch;
    try {
      const b = binding(context, false); const now = this.#time();
      if (now >= g.expiresAt) { this.#armed = false; return false; }
      return !this.#closed && !this.#locked && !this.#revocations && this.#armed
        && this.#epoch === epoch && this.#state === state && state.grant === g
        && [...fields, 'planRevision'].every(k => b[k] === g[k]);
    } catch { return false; }
  }
  /** A fresh, explicit host-confirmed grant replaces rather than inherits any prior one. */
  grant(capability, expectedRevision, facts) {
    if (this.#closed) return Promise.reject(new Error('recovery_authorization_closed'));
    let b;
    try { this.#authority(capability); b = binding(facts, true); }
    catch (e) { return Promise.reject(e); }
    if (this.#closed) return Promise.reject(new Error('recovery_authorization_closed'));
    if (this.#revocations) return Promise.reject(new Error('recovery_authorization_revoking'));
    const epoch = this.#epoch;
    return this.#queue(async () => {
      this.#ready();
      if (epoch !== this.#epoch) throw new Error('recovery_authorization_revoked');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.#state.revision) throw new Error('recovery_authorization_revision_conflict');
      const now = this.#time();
      if (epoch !== this.#epoch || this.#revocations || this.#closed) throw new Error('recovery_authorization_revoked');
      if (b.expiresAt <= now) throw new Error('recovery_authorization_expired');
      const next = { schemaVersion: 1, revision: this.#state.revision + 1, grant: b };
      await this.#save(next);
      this.#armed = epoch === this.#epoch && !this.#revocations && !this.#closed;
      // A revoke submitted during save blocks checks immediately, and is queued
      // to persist a tombstone even though this grant was already in flight.
      return this.getSnapshot();
    });
  }
  /** Host-confirmed revocation wins over queued grants, without stale-revision rejection. */
  revoke(capability) {
    if (this.#closed) return Promise.reject(new Error('recovery_authorization_closed'));
    try { this.#authority(capability); } catch (e) { return Promise.reject(e); }
    this.#epoch++; this.#revocations++; this.#armed = false;
    return this.#queue(async () => {
      try {
        this.#ready();
        await this.#save({ schemaVersion: 1, revision: this.#state.revision + 1, grant: null });
        return this.getSnapshot();
      } finally { this.#revocations--; }
    });
  }
  async #save(next) {
    if (!Number.isSafeInteger(next.revision)) { this.#locked = true; throw new Error('recovery_authorization_revision_overflow'); }
    try { await this.#ports.save(structuredClone(next)); }
    catch { this.#locked = true; throw new Error('recovery_authorization_save_failed'); }
    this.#state = next;
  }
  close() { if (this.#closing) return this.#closing; this.#closed = true; this.#armed = false; this.#closing = this.#chain; return this.#closing; }
}
