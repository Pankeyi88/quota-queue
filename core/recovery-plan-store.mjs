/**
 * Durable single-instance owner of the existing-task plan.
 *
 * This serializes validate -> apply -> save -> publish. It does NOT establish
 * cross-process execution ownership; a Host adapter must prove that separately.
 * The v1 queue is never loaded or rewritten here. A dedicated storage unit keeps
 * legacy reservations intact and outside the new execution plan.
 */
import { createRecoveryPlan, validateRecoveryPlan, applyRecoveryPlan } from './recovery-plan.mjs';

// Validate descriptors BEFORE cloning: structuredClone otherwise invokes getters
// and erases prototypes, laundering a command the pure model would reject.
function detachedIntent(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('recovery_plan_invalid_intent');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) {
    throw new Error('recovery_plan_invalid_intent');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error('recovery_plan_invalid_intent');
  const out = array ? [] : Object.create(null);
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
      throw new Error('recovery_plan_invalid_intent');
    }
    out[key] = detachedIntent(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return out;
}

export class RecoveryPlanStore {
  #ports;
  #plan = null;
  #chain = Promise.resolve();
  #opening = null;
  #closing = null;
  #closed = false;
  #locked = false;

  constructor(ports) {
    if (!ports || typeof ports.load !== 'function' || typeof ports.save !== 'function') {
      throw new TypeError('RecoveryPlanStore requires load/save ports');
    }
    this.#ports = ports;
  }

  get opened() { return this.#plan !== null; }
  get locked() { return this.#locked; }
  get closed() { return this.#closed; }

  open() {
    if (this.#closed) return Promise.reject(new Error('recovery_plan_closed'));
    if (this.#opening === null) {
      this.#opening = this.#enqueue(async () => {
        let raw;
        try { raw = await this.#ports.load(); }
        catch { this.#locked = true; throw new Error('recovery_plan_load_failed'); }
        const plan = raw === null || raw === undefined ? createRecoveryPlan() : raw;
        if (validateRecoveryPlan(plan).length !== 0) {
          this.#locked = true;
          throw new Error('recovery_plan_invalid_snapshot');
        }
        this.#plan = structuredClone(plan);
        return this.getSnapshot();
      });
    }
    return this.#opening.then(() => this.getSnapshot());
  }

  getSnapshot() {
    if (this.#plan === null) throw new Error('recovery_plan_not_open');
    return structuredClone(this.#plan);
  }

  /** The command may only contain Host-validated facts, never UI authority. */
  commit(expectedRevision, command) {
    if (this.#closed) return Promise.reject(new Error('recovery_plan_closed'));
    // Freeze the submitted intent now: a caller cannot mutate a queued command.
    let intent;
    try { intent = detachedIntent(command); }
    catch { return Promise.reject(new Error('recovery_plan_invalid_intent')); }
    return this.#enqueue(async () => {
      if (this.#locked) throw new Error('recovery_plan_locked');
      if (this.#plan === null) throw new Error('recovery_plan_not_open');
      const next = applyRecoveryPlan(this.#plan, expectedRevision, intent);
      if (validateRecoveryPlan(next).length !== 0) throw new Error('recovery_plan_invalid_candidate');
      try { await this.#ports.save(structuredClone(next)); }
      catch { this.#locked = true; throw new Error('recovery_plan_save_failed'); }
      this.#plan = structuredClone(next);
      return this.getSnapshot();
    });
  }

  #enqueue(job) {
    const result = this.#chain.then(job);
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Accepted writes drain before the Host closes its storage handle. */
  close() {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#closing = this.#chain;
    return this.#closing;
  }
}
