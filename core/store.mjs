/**
 * quota-queue/core — versioned, single-writer queue snapshot store.
 *
 * Contract with the injected persistence port:
 *  - `load()` reads the single versioned snapshot; null/undefined means "no
 *    queue yet". Anything else is validated strictly before use.
 *  - `save(snapshot)` must resolve only after the write is durable. Resolving
 *    means persisted; rejecting means not persisted.
 *
 * Properties this store does and does not provide:
 *  - one process-wide write chain, so commits never interleave;
 *  - publication only after `save` resolved (a failed write publishes nothing);
 *  - a persistence failure locks the store permanently: every later write and
 *    every scheduler step fails with a clear error instead of continuing on
 *    unpersisted state;
 *  - `revision` is an in-process single-instance guard only. It is NOT a
 *    compare-and-swap and proves nothing about other processes. Proving a
 *    single active plugin owner across processes is a host capability that the
 *    core cannot supply.
 */
import {
  ClosedError,
  InputValidationError,
  PersistenceError,
  PortContractError,
  RevisionConflictError,
  SnapshotValidationError,
  StoreLockedError,
} from './errors.mjs';
import { deepCopy, isPlainObject, isNonEmptyString, isInteger, isValidIsoInstant } from './util.mjs';
import { SCHEMA_VERSION, validateTask } from './tasks.mjs';
import { validateQuotaSnapshot } from './quota.mjs';

/** Every top-level key a snapshot may carry. Unknown keys are rejected. */
export const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'revision',
  'seq',
  'dispatchPaused',
  'dispatchPausedReason',
  'tasks',
  'dedupeIndex',
  'sessionOptIns',
  'quotaScopes',
  'updatedAt',
]);

const SNAPSHOT_KEY_SET = new Set(SNAPSHOT_KEYS);

/** A brand-new, empty queue snapshot. */
export function createEmptySnapshot(nowIso = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    seq: 0,
    dispatchPaused: false,
    dispatchPausedReason: null,
    tasks: [],
    dedupeIndex: {},
    sessionOptIns: {},
    quotaScopes: {},
    updatedAt: nowIso,
  };
}

/**
 * Strict validation of a full snapshot (both a loaded one and a commit
 * candidate). Every failure is reported; nothing is silently repaired.
 * @returns {string[]} issues (empty array means valid)
 */
export function validateSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) return ['snapshot'];
  const issues = [];
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEY_SET.has(key)) issues.push(`unknownField:${key}`);
  }
  if (snapshot.schemaVersion !== SCHEMA_VERSION) issues.push('schemaVersion');
  if (!isInteger(snapshot.revision) || snapshot.revision < 0) issues.push('revision');
  if (!isInteger(snapshot.seq) || snapshot.seq < 0) issues.push('seq');
  if (typeof snapshot.dispatchPaused !== 'boolean') issues.push('dispatchPaused');
  if (!(snapshot.dispatchPausedReason === null || typeof snapshot.dispatchPausedReason === 'string')) {
    issues.push('dispatchPausedReason');
  }
  if (!(snapshot.updatedAt === null || isValidIsoInstant(snapshot.updatedAt))) issues.push('updatedAt');

  const tasks = snapshot.tasks;
  if (!Array.isArray(tasks)) {
    issues.push('tasks');
  } else {
    const ids = new Set();
    const dedupeKeys = new Set();
    for (const [index, task] of tasks.entries()) {
      issues.push(...validateTask(task, `tasks[${index}]`));
      if (isPlainObject(task)) {
        if (isNonEmptyString(task.id)) {
          if (ids.has(task.id)) issues.push(`duplicateTaskId:${task.id}`);
          ids.add(task.id);
        }
        if (isNonEmptyString(task.dedupeKey)) {
          if (dedupeKeys.has(task.dedupeKey)) issues.push(`duplicateDedupeKey:${task.dedupeKey}`);
          dedupeKeys.add(task.dedupeKey);
        }
      }
    }
  }

  const dedupeIndex = snapshot.dedupeIndex;
  if (!isPlainObject(dedupeIndex)) {
    issues.push('dedupeIndex');
  } else if (Array.isArray(tasks)) {
    const byId = new Map(tasks.filter(isPlainObject).map((task) => [task.id, task]));
    for (const [key, value] of Object.entries(dedupeIndex)) {
      const task = byId.get(value);
      if (!task || task.dedupeKey !== key) issues.push(`dedupeIndex[${key}]`);
    }
    for (const task of tasks) {
      if (isPlainObject(task) && isNonEmptyString(task.dedupeKey) && dedupeIndex[task.dedupeKey] !== task.id) {
        issues.push(`missingDedupeEntry:${task.dedupeKey}`);
      }
    }
  }

  const sessionOptIns = snapshot.sessionOptIns;
  if (!isPlainObject(sessionOptIns)) {
    issues.push('sessionOptIns');
  } else {
    for (const [key, value] of Object.entries(sessionOptIns)) {
      if (!isNonEmptyString(key) || typeof value !== 'boolean') issues.push(`sessionOptIns[${key}]`);
    }
  }

  const quotaScopes = snapshot.quotaScopes;
  if (!isPlainObject(quotaScopes)) {
    issues.push('quotaScopes');
  } else {
    for (const [key, value] of Object.entries(quotaScopes)) {
      for (const issue of validateQuotaSnapshot(value)) issues.push(`quotaScopes[${key}]:${issue}`);
    }
  }
  return issues;
}

/**
 * Single-writer, versioned snapshot store.
 */
export class QueueStore {
  #load;
  #save;
  #snapshot = null;
  #opened = false;
  #closed = false;
  #closing = false;
  #locked = false;
  #lockReason = null;
  #chain = Promise.resolve();
  #writeCount = 0;

  /**
   * @param {{ load: () => Promise<object|null|undefined>, save: (snapshot: object) => Promise<void> }} ports
   */
  constructor(ports = {}) {
    if (!isPlainObject(ports) && typeof ports !== 'object') {
      throw new InputValidationError('QueueStore expects a ports object', ['ports']);
    }
    if (typeof ports.load !== 'function') throw new PortContractError('QueueStore requires a load() port', ['load']);
    if (typeof ports.save !== 'function') throw new PortContractError('QueueStore requires a save() port', ['save']);
    this.#load = ports.load;
    this.#save = ports.save;
  }

  get opened() { return this.#opened; }
  get closed() { return this.#closed; }
  get closing() { return this.#closing; }
  get locked() { return this.#locked; }
  get lockReason() { return this.#lockReason; }
  get writeCount() { return this.#writeCount; }
  get revision() { return this.#snapshot === null ? null : this.#snapshot.revision; }

  /** Load and validate the persisted snapshot (or start from an empty one). */
  async open() {
    return this.#enqueue(async () => {
      if (this.#opened) return this.getSnapshot();
      let raw;
      try {
        raw = await this.#load();
      } catch (cause) {
        this.#lock('initial load failed');
        throw new PersistenceError('persisted queue snapshot could not be loaded', { cause });
      }
      if (raw === null || raw === undefined) {
        this.#snapshot = createEmptySnapshot();
      } else {
        const issues = validateSnapshot(raw);
        if (issues.length > 0) {
          this.#lock('persisted snapshot failed validation');
          throw new SnapshotValidationError('persisted queue snapshot failed strict validation', issues);
        }
        this.#snapshot = deepCopy(raw);
      }
      this.#opened = true;
      return this.getSnapshot();
    }, { allowBeforeOpen: true });
  }

  /** Last published snapshot, deep-copied so callers cannot mutate it. */
  getSnapshot() {
    if (!this.#opened || this.#snapshot === null) {
      throw new PortContractError('queue store must be opened before it can be read', ['open']);
    }
    return deepCopy(this.#snapshot);
  }

  /** True when the last published snapshot still satisfies validation. */
  inspectIssues() {
    return this.#snapshot === null ? ['notOpen'] : validateSnapshot(this.#snapshot);
  }

  /**
   * Atomic read-modify-write on the single write chain. The mutator receives a
   * deep copy; returning undefined keeps the draft. Publication happens only
   * after the port confirms durability.
   */
  async update(mutator) {
    return this.#enqueue(async () => {
      if (typeof mutator !== 'function') throw new InputValidationError('update expects a mutator function', ['mutator']);
      const current = deepCopy(this.#snapshot);
      const draft = deepCopy(this.#snapshot);
      const produced = await mutator(draft, current);
      // The store owns the revision: whatever the mutator did to it is ignored.
      return this.#persist(produced === undefined ? draft : produced, {
        expectedRevision: this.#snapshot.revision,
        requireExactIncrement: false,
      });
    });
  }

  /**
   * Commit an explicit snapshot against an expected in-process revision.
   * @param {number} expectedRevision
   * @param {object} next
   */
  async commit(expectedRevision, next) {
    return this.#enqueue(async () => {
      if (!isInteger(expectedRevision)) throw new InputValidationError('expectedRevision must be an integer', ['expectedRevision']);
      if (this.#snapshot.revision !== expectedRevision) {
        throw new RevisionConflictError('in-process revision mismatch (not a backend CAS)', {
          expected: expectedRevision,
          actual: this.#snapshot.revision,
        });
      }
      return this.#persist(next, { expectedRevision, requireExactIncrement: true });
    });
  }

  /**
   * Stop accepting writes and drain every write that was accepted before this
   * call. A job already queued is never rejected because close() started.
   */
  async close() {
    if (this.#closing || this.#closed) {
      await this.#chain;
      return;
    }
    this.#closing = true;
    const accepted = this.#chain;
    await accepted;
    this.#closed = true;
    this.#closing = false;
  }

  async #persist(candidate, { expectedRevision, requireExactIncrement }) {
    if (!isPlainObject(candidate)) throw new InputValidationError('snapshot must be a plain object', ['snapshot']);
    const next = deepCopy(candidate);
    if (requireExactIncrement) {
      if (next.revision !== expectedRevision + 1) {
        throw new InputValidationError(
          `snapshot revision must be exactly expectedRevision + 1 (${expectedRevision + 1}); revision is store-owned`,
          ['revision'],
        );
      }
    } else {
      next.revision = expectedRevision + 1;
    }
    const issues = validateSnapshot(next);
    if (issues.length > 0) throw new SnapshotValidationError('candidate snapshot failed strict validation', issues);
    this.#writeCount += 1;
    try {
      await this.#save(deepCopy(next));
    } catch (cause) {
      // Nothing is published and the store locks: a scheduler must never run on
      // state whose durability is unknown.
      this.#lock(`write #${this.#writeCount} failed`);
      throw new PersistenceError('persisted snapshot write failed; store locked and dispatch must stop', { cause });
    }
    this.#snapshot = deepCopy(next);
    return this.getSnapshot();
  }

  #lock(reason) {
    this.#locked = true;
    this.#lockReason = this.#lockReason ?? reason;
  }

  #enqueue(job, { allowBeforeOpen = false } = {}) {
    // Closed state is evaluated at SUBMISSION time: a job accepted before
    // close() is still drained, while anything submitted after (or during the
    // drain) fails fast.
    if (this.#closed || this.#closing) {
      return Promise.reject(new ClosedError('queue store is closed; no further writes are accepted'));
    }
    const run = this.#chain.then(async () => {
      if (this.#locked) throw new StoreLockedError(`queue store is locked: ${this.#lockReason ?? 'unknown reason'}`);
      if (!allowBeforeOpen && !this.#opened) {
        throw new PortContractError('queue store must be opened before use', ['open']);
      }
      return job();
    });
    // The chain must never stay rejected, or later writes would inherit the error.
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
