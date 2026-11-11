/**
 * quota-queue/host — durable continuation-ticket store.
 *
 * Owns ONE storage unit (`quota_continue_v1`) whose global singleton holds the
 * versioned ticket map. The unit is separate from the legacy queue snapshot so
 * a continuation ticket can never rewrite queue state, and so a corrupt ticket
 * file cannot take the queue down with it.
 *
 * The medium's global write is last-write-wins and offers no compare-and-swap.
 * This store therefore claims only what it can prove:
 *  - one in-process writer chain (mutations are serialized here);
 *  - a durable commit barrier (a mutation resolves only after `setGlobal`);
 *  - fail-closed behavior: a write failure marks the store `locked`, and no
 *    caller may treat an unpersisted intent as sent.
 * It does NOT claim cross-process mutual exclusion. That requires the separate
 * owner lease in `host/owner-lock.js`, and even that is a lease, not a kernel
 * guarantee.
 */
import { validateTicket, CONTINUE_STORE_VERSION } from '../core/continue-ticket.mjs';
import { isPlainObject } from '../core/util.mjs';

export const CONTINUE_UNIT = 'quota_continue_v1';

const SNAPSHOT_KEYS = ['version', 'revision', 'tickets', 'updatedAt'];

export function emptyContinueSnapshot(nowIso = new Date(0).toISOString()) {
  return { version: CONTINUE_STORE_VERSION, revision: 0, tickets: {}, updatedAt: nowIso };
}

/** Structural validation of the stored snapshot. */
export function validateContinueSnapshot(snapshot) {
  const issues = [];
  if (!isPlainObject(snapshot)) return ['snapshot_not_object'];
  for (const key of Object.keys(snapshot)) if (!SNAPSHOT_KEYS.includes(key)) issues.push(`unknown_key:${key}`);
  if (snapshot.version !== CONTINUE_STORE_VERSION) issues.push('version');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) issues.push('revision');
  if (typeof snapshot.updatedAt !== 'string') issues.push('updatedAt');
  if (!isPlainObject(snapshot.tickets)) issues.push('tickets');
  else {
    for (const [key, ticket] of Object.entries(snapshot.tickets)) {
      const ticketIssues = validateTicket(ticket);
      if (ticketIssues.length > 0) issues.push(`ticket:${key}:${ticketIssues.join('+')}`);
    }
  }
  return issues;
}

/**
 * @param {{load: () => Promise<unknown>, save: (value: object) => Promise<void>, now?: () => number}} ports
 */
export function createContinueStore(ports) {
  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  let opened = false;
  let closed = false;
  let locked = false;
  let degraded = false;
  let reason = null;
  let snapshot = emptyContinueSnapshot();
  let chain = Promise.resolve();

  const clone = (value) => structuredClone(value);

  return Object.freeze({
    get opened() { return opened; },
    get closed() { return closed; },
    get locked() { return locked; },
    get degraded() { return degraded; },
    get reason() { return reason; },
    getSnapshot() { return snapshot; },

    async open() {
      if (opened) return this;
      const loaded = await ports.load();
      if (loaded === null || loaded === undefined) {
        snapshot = emptyContinueSnapshot(new Date(now()).toISOString());
      } else {
        const issues = validateContinueSnapshot(loaded);
        if (issues.length > 0) {
          // Preserve the file: never overwrite unreadable evidence with an
          // empty snapshot. The driver stays passive and reports the reason.
          degraded = true;
          reason = 'continue_store_invalid';
          snapshot = emptyContinueSnapshot(new Date(now()).toISOString());
          opened = true;
          return this;
        }
        snapshot = clone(loaded);
      }
      opened = true;
      return this;
    },

    /**
     * Serialized read-modify-write. The returned promise resolves only after
     * the new snapshot is durably committed.
     */
    async mutate(fn) {
      const run = chain.then(async () => {
        if (!opened || closed) throw new Error('continue_store_closed');
        if (degraded || locked) throw new Error(reason ?? 'continue_store_locked');
        const draft = clone(snapshot);
        const result = await fn(draft);
        draft.revision = snapshot.revision + 1;
        draft.updatedAt = new Date(now()).toISOString();
        await ports.save(clone(draft));
        snapshot = draft;
        return result;
      });
      chain = run.then(() => undefined, () => undefined);
      try {
        return await run;
      } catch (error) {
        if (reason === null && error?.message !== 'continue_store_closed') {
          // A failed durable write means the driver may not know what is on
          // disk. Stop all further automatic sending and report it.
          locked = true;
          reason = 'continue_persist_failed';
        }
        throw error;
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      opened = false;
      await chain;
    },
  });
}
