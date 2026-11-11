/** Continuation store: fail-closed on invalid data and on write failure. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinueStore, validateContinueSnapshot } from '../../host/continue-store.js';
import { CONTINUE_STORE_VERSION, createTicket } from '../../core/continue-ticket.mjs';

const NOW = 1_700_000_000_000;
const ticket = () => createTicket({
  sessionId: 's-1', turn: 1, endSeq: 1, now: NOW,
  decision: { action: 'ticket', failureClass: 'network', code: 'TRANSPORT', retryAfterMs: null },
});

const ports = (initial, { failSave = false } = {}) => {
  let value = initial === undefined ? null : structuredClone(initial);
  return {
    get value() { return value; },
    async load() { return value === null ? null : structuredClone(value); },
    async save(next) { if (failSave) throw new Error('disk full'); value = structuredClone(next); },
    now: () => NOW,
  };
};

test('a fresh unit starts empty and commits increment revisions', async () => {
  const p = ports(undefined);
  const store = createContinueStore(p);
  await store.open();
  assert.equal(store.getSnapshot().revision, 0);
  await store.mutate((draft) => { draft.tickets['s-1'] = ticket(); });
  assert.equal(p.value.revision, 1);
  assert.equal(store.getSnapshot().revision, 1);
  assert.deepEqual(validateContinueSnapshot(store.getSnapshot()), []);
});

test('an invalid stored snapshot is preserved and locks the driver out', async () => {
  const p = ports({ version: CONTINUE_STORE_VERSION, revision: 4, tickets: { bad: { nope: true } }, updatedAt: 'x' });
  const store = createContinueStore(p);
  await store.open();
  assert.equal(store.degraded, true);
  assert.equal(store.reason, 'continue_store_invalid');
  await assert.rejects(() => store.mutate(() => {}), /continue_store_invalid/);
  assert.equal(p.value.revision, 4, 'never overwrites the unreadable evidence');
});

test('a failed durable write locks the store: nothing may look committed', async () => {
  const p = ports(undefined, { failSave: true });
  const store = createContinueStore(p);
  await store.open();
  await assert.rejects(() => store.mutate((draft) => { draft.tickets['s-1'] = ticket(); }), /disk full/);
  assert.equal(store.locked, true);
  assert.equal(store.reason, 'continue_persist_failed');
  await assert.rejects(() => store.mutate(() => {}), /continue_persist_failed/);
});
