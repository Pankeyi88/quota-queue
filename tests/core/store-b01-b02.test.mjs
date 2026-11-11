/**
 * B01/B02 (storage side) — single-writer snapshot store semantics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QueueStore, createEmptySnapshot, validateSnapshot, createTask,
  PersistenceError, StoreLockedError, ClosedError, RevisionConflictError,
  SnapshotValidationError, InputValidationError, QueueService,
} from '../../core/index.mjs';
import { memoryStorePort, makeClock, makeIds, fakeQuota, fakeSession, fullCapabilities, ISO, PROVIDER, MODEL } from './helpers.mjs';

async function openStore(port = memoryStorePort()) {
  const store = new QueueStore({ load: port.load, save: port.save });
  await store.open();
  return { store, port };
}

test('B01: a failed write publishes nothing and locks the store', { timeout: 10_000 }, async () => {
  const { store, port } = await openStore();
  const before = store.getSnapshot();
  port.failNextSaves(1);
  await assert.rejects(
    store.update((draft) => { draft.dispatchPaused = true; }),
    (error) => error.code === 'PERSIST_FAILED' && error.cause instanceof Error,
  );
  assert.equal(store.locked, true);
  assert.deepEqual(store.getSnapshot(), before, 'the failed candidate is not published');
  assert.equal(port.state.persisted, null, 'nothing was made durable');
  await assert.rejects(store.update((draft) => { draft.dispatchPaused = true; }), (error) => error.code === 'STORE_LOCKED');
  await assert.rejects(store.commit(0, { ...before, revision: 1 }), (error) => error.code === 'STORE_LOCKED');
});

test('B01: addManual rejects when the durable write fails and schedules nothing', { timeout: 10_000 }, async () => {
  const port = memoryStorePort();
  const store = new QueueStore({ load: port.load, save: port.save });
  await store.open();
  const service = new QueueService({
    store,
    quota: fakeQuota(null, { now: () => ISO }),
    session: fakeSession(),
    clock: makeClock(ISO),
    ids: makeIds('t'),
    capabilities: fullCapabilities(),
  });
  port.failNextSaves(1);
  await assert.rejects(
    service.addManual({ prompt: 'p', workspaceId: 'ws-1', provider: PROVIDER, model: MODEL, autoResume: true }),
    (error) => error.code === 'PERSIST_FAILED',
  );
  assert.equal(service.list().tasks.length, 0, 'no task is reported as reliably queued');
  await assert.rejects(service.tick(), (error) => error.code === 'STORE_LOCKED');
  await assert.rejects(service.addManual({ prompt: 'p', workspaceId: 'ws-1', provider: PROVIDER, model: MODEL }), (error) => error.code === 'STORE_LOCKED');
});

test('store: getSnapshot deep-copies so callers cannot mutate internal state', { timeout: 10_000 }, async () => {
  const { store } = await openStore();
  const mutated = store.getSnapshot();
  mutated.dispatchPaused = true;
  mutated.tasks.push({ id: 'injected' });
  mutated.sessionOptIns['x'] = true;
  const fresh = store.getSnapshot();
  assert.equal(fresh.dispatchPaused, false);
  assert.deepEqual(fresh.tasks, []);
  assert.deepEqual(fresh.sessionOptIns, {});
});

test('store: revision is store-owned; commit requires exactly expected+1', { timeout: 10_000 }, async () => {
  const { store } = await openStore();
  const first = store.getSnapshot();
  first.revision = 1;
  first.updatedAt = ISO;
  const committed = await store.commit(0, first);
  assert.equal(committed.revision, 1);
  await assert.rejects(store.commit(0, { ...first, revision: 1 }), (error) => error.code === 'REVISION_CONFLICT');
  await assert.rejects(store.commit(1, { ...first, revision: 5 }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(store.commit(1, { ...first, revision: 1 }), (error) => error.code === 'INVALID_INPUT');
  const updated = await store.update((draft) => { draft.revision = 999; draft.updatedAt = ISO; });
  assert.equal(updated.revision, 2, 'the mutator cannot change the revision');
});

test('store: committed snapshots are deep-copied, so later caller mutation is harmless', { timeout: 10_000 }, async () => {
  const { store } = await openStore();
  const candidate = store.getSnapshot();
  candidate.revision = 1;
  candidate.sessionOptIns['session-1'] = true;
  const committed = await store.commit(0, candidate);
  candidate.sessionOptIns['session-1'] = false;
  assert.equal(committed.sessionOptIns['session-1'], true);
  assert.equal(store.getSnapshot().sessionOptIns['session-1'], true);
});

test('store: open() rejects a snapshot with unknown fields or unsafe values', { timeout: 10_000 }, async () => {
  const cases = [
    ['unknown top-level field', { ...createEmptySnapshot(), mystery: 1 }, 'unknownField:mystery'],
    ['unknown task field', { ...createEmptySnapshot(), tasks: [corrupt(taskWith(), (task) => { task.mystery = 1; })], dedupeIndex: { 'manual:t1': 't1' } }, 'tasks[0].unknownField:mystery'],
    ['non-json value', { ...createEmptySnapshot(), tasks: [corrupt(taskWith(), (task) => { task.priority = Number.NaN; })], dedupeIndex: { 'manual:t1': 't1' } }, 'nonJson:tasks[0].priority'],
    ['running without a message binding', { ...createEmptySnapshot(), tasks: [taskWith({ status: 'running', dispatchedMessageId: null })], dedupeIndex: { 'manual:t1': 't1' } }, 'tasks[0].runningWithoutMessage'],
    ['fence without a bound message', { ...createEmptySnapshot(), tasks: [corrupt(taskWith(), (task) => { task.executionFence = true; task.fenceReason = 'executing'; })], dedupeIndex: { 'manual:t1': 't1' } }, 'tasks[0].fenceWithoutMessage'],
    ['fence without a reason', { ...createEmptySnapshot(), tasks: [corrupt(taskWith(), (task) => { task.executionFence = true; task.dispatchedMessageId = 'msg-1'; })], dedupeIndex: { 'manual:t1': 't1' } }, 'tasks[0].fenceWithoutReason'],
    ['resume without its failure identity', { ...createEmptySnapshot(), tasks: [corrupt(resumeTaskWith(), (task) => { task.generation = null; })], dedupeIndex: { 'resume:x': 't1' } }, 'tasks[0].resumeIdentity:generation'],
    ['bad schema version', { ...createEmptySnapshot(), schemaVersion: 99 }, 'schemaVersion'],
  ];
  for (const [label, snapshot, expectedIssue] of cases) {
    const port = memoryStorePort({ initial: snapshot });
    const store = new QueueStore({ load: port.load, save: port.save });
    await assert.rejects(store.open(), (error) => {
      assert.equal(error.code, 'SNAPSHOT_INVALID', label);
      assert.ok(error.issues.some((issue) => issue.includes(expectedIssue)), `${label}: ${error.issues.join(',')}`);
      return true;
    });
    assert.equal(store.locked, true, label);
  }
});

test('store: validateSnapshot reports every issue instead of repairing silently', () => {
  const snapshot = { ...createEmptySnapshot(), schemaVersion: 7, revision: -1, dispatchPaused: 'yes', extra: true };
  const issues = validateSnapshot(snapshot);
  assert.ok(issues.includes('schemaVersion'));
  assert.ok(issues.includes('revision'));
  assert.ok(issues.includes('dispatchPaused'));
  assert.ok(issues.includes('unknownField:extra'));
});

test('store: close drains an accepted write but rejects new submissions', { timeout: 10_000 }, async () => {
  const { store, port } = await openStore();
  const accepted = store.update((draft) => { draft.updatedAt = ISO; });
  const closing = store.close();
  await accepted;
  await closing;
  assert.equal(port.state.persisted.updatedAt, ISO, 'the accepted write was drained');
  await assert.rejects(store.update((draft) => { draft.updatedAt = ISO; }), (error) => error.code === 'CLOSED');
  await store.close();
});

test('store: a load failure locks the store with an explicit error', { timeout: 10_000 }, async () => {
  const store = new QueueStore({
    load: async () => { throw new Error('unreachable storage'); },
    save: async () => {},
  });
  await assert.rejects(store.open(), (error) => error.code === 'PERSIST_FAILED');
  assert.equal(store.locked, true);
  await assert.rejects(store.open(), (error) => error.code === 'STORE_LOCKED');
});

test('store: ports are mandatory', () => {
  assert.throws(() => new QueueStore({ save: async () => {} }), (error) => error.code === 'PORT_CONTRACT');
  assert.throws(() => new QueueStore({ load: async () => null }), (error) => error.code === 'PORT_CONTRACT');
});

function corrupt(task, mutate) {
  mutate(task);
  return task;
}

function taskWith(overrides = {}) {
  return createTask({
    id: 't1',
    kind: 'new-session',
    prompt: 'p',
    workspaceId: 'ws-1',
    provider: PROVIDER,
    model: MODEL,
    quotaScopeKey: 'qs:["p","m","default","global"]',
    sessionId: 'session-1',
    dedupeKey: 'manual:t1',
    status: 'queued',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  });
}

function resumeTaskWith(overrides = {}) {
  return createTask({
    id: 't1',
    kind: 'resume-session',
    workspaceId: 'ws-1',
    provider: PROVIDER,
    model: MODEL,
    quotaScopeKey: 'qs:["p","m","default","global"]',
    sessionId: 'session-1',
    failedStepId: 'step-1',
    generation: '1',
    dedupeKey: 'resume:x',
    status: 'waiting_quota',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  });
}
