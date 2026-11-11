/**
 * Persistence-failure behaviour.
 *
 * A failed durable write must never be reported as a queued task, and the
 * store must stop accepting writes instead of continuing on state whose
 * durability is unknown.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, createFakeStorage, createSession, seededSnapshot, seedTask } from './harness.mjs';

test('a failed durable write locks the store and never reports a saved task', async () => {
  const storage = createFakeStorage({ failSave: true });
  const session = await createSession({ storage });

  const first = await session.call('pauseDispatch', { paused: true }, { requestId: 'w-1' });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'persistence_failed');
  assert.equal(storage.state.global, null, 'nothing may be persisted');
  assert.equal(storage.state.saves, 1);
  assert.equal(session.service.storageDegraded, true);

  // Every later write fails too: no task is ever started on unknown durability.
  const second = await session.call('pauseDispatch', { paused: true }, { requestId: 'w-2' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'persistence_failed');
  assert.equal(storage.state.saves, 1, 'a locked store must not attempt another save');

  // Reads stay truthful: the published queue is still empty, and the View says
  // the persistence layer is locked.
  const view = await session.call('bootstrap', {});
  assert.equal(view.ok, true);
  assert.deepEqual(view.data.tasks, []);
  assert.equal(view.data.paused, false, 'a failed pause must not publish the candidate state');
  assert.ok(view.data.configuration.reasons.includes('persistence_locked'));
  assert.equal(view.data.configuration.ready, false);
});

test('a failed pause write preserves seeded legacy history and its published revision', async () => {
  const snapshot = seededSnapshot([seedTask({ id: 'history-1', prompt: 'old body' })]);
  const storage = createFakeStorage({ initialGlobal: structuredClone(snapshot), failSave: true });
  const session = await createSession({ storage });
  const before = (await session.call('bootstrap', {})).data;
  const result = await session.call('pauseDispatch', { paused: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'persistence_failed');
  const after = (await session.call('bootstrap', {})).data;
  assert.equal(after.paused, false);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.tasks, before.tasks);
  assert.deepEqual(storage.state.global, snapshot);
  assert.equal(storage.state.saves, 1);
  assert.equal(after.capabilities.execution, false);
});

test('a persisted snapshot that fails validation is never projected as a queue', async () => {
  const storage = createFakeStorage({ initialGlobal: { schemaVersion: 999, tasks: 'nope' } });
  const session = await createSession({ storage });

  assert.equal(session.service.storageDegraded, true);
  const view = await session.call('bootstrap', {});
  assert.equal(view.ok, false);
  assert.equal(view.error.code, 'persistence_failed');

  const write = await session.call('pauseDispatch', { paused: true }, { requestId: 'w-3' });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'persistence_failed');
  assert.equal(storage.state.saves, 0);
});

test('an unavailable storage unit fails plugin activation loudly', async () => {
  const openFailure = createFakeStorage({ failOpen: true });
  await assert.rejects(createSession({ storage: openFailure }), (error) => error.code === 'configuration_incomplete');

  const noKv = createFakeStorage({ noKv: true });
  await assert.rejects(createSession({ storage: noKv }), (error) => error.code === 'configuration_incomplete');

  const noStorage = createFakeStorage({ noStorage: true });
  await assert.rejects(createSession({ storage: noStorage }), (error) => error.code === 'configuration_incomplete');
});

test('an unknown configured backend name fails activation instead of skipping storage', async () => {
  const storage = createFakeStorage();
  await assert.rejects(
    createSession({ storage, config: { storageBackend: 'sqlite', routes: [ROUTE] } }),
    (error) => error.code === 'configuration_incomplete',
  );
});

test('the queue and plan units are opened with fixed single-global descriptors', async () => {
  const storage = createFakeStorage();
  await createSession({ storage });
  assert.deepEqual(storage.state.descriptors, [
    { name: 'quota_queue_v1', version: 1, tables: [], hasGlobal: true, layout: 'single' },
    { name: 'quota_recovery_plan_v1', version: 1, tables: [], hasGlobal: true, layout: 'single' },
  ]);
});
