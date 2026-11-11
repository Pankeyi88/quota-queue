/** Lifecycle and immutable legacy-history coverage over fake storage. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, createFakeStorage, createSession, seededSnapshot, seedTask } from './harness.mjs';

const ADD = { prompt: 'p', workspaceId: 'ws-1', routeId: ROUTE.id };

test('init is idempotent and opens each unit once', async () => {
  const storage = createFakeStorage();
  const session = await createSession({ storage });
  await session.service.init();
  await session.service.init();
  // One legacy queue unit plus one isolated recovery-plan unit.
  assert.equal(storage.state.opens, 2);
  assert.equal(storage.state.activeOpens, 2);
  assert.deepEqual(storage.state.descriptors.map((entry) => entry.name), ['quota_queue_v1', 'quota_recovery_plan_v1']);
});

test('dispose closes both units exactly once and fails later calls closed', async () => {
  const storage = createFakeStorage();
  const session = await createSession({ storage });
  assert.equal(session.service.disposed, false);
  await session.service.dispose();
  assert.equal(session.service.disposed, true);
  assert.equal(storage.state.closes, 2);
  assert.equal(storage.state.activeOpens, 0);
  await session.service.dispose();
  assert.equal(storage.state.closes, 2);
  const after = await session.call('bootstrap', {});
  assert.equal(after.ok, false);
  assert.equal(after.error.code, 'unavailable');
});

test('a second owner on the queue unit is refused', async () => {
  const storage = createFakeStorage();
  const first = await createSession({ storage });
  assert.equal(storage.state.activeOpens, 2);
  // The second activation fails on the already-open legacy unit; its failure
  // path must not leave a leaked plan unit behind.
  await assert.rejects(createSession({ storage }), error => error.code === 'configuration_incomplete');
  assert.equal(storage.state.activeOpens, 2);
  await first.service.dispose();
  const second = await createSession({ storage });
  assert.equal(storage.state.opens, 4);
  assert.equal(storage.state.activeOpens, 2);
  await second.service.dispose();
});

test('legacy reservations survive reload unchanged and cannot become executable existing tasks', async () => {
  const snapshot = seededSnapshot([
    seedTask({ id: 'old-queued', dedupeKey: 'manual::reload-1', autoResume: true }),
    seedTask({ id: 'old-running', status: 'running', attempts: 1 }),
    seedTask({ id: 'old-resume', kind: 'resume-session', status: 'waiting_quota' }),
  ]);
  const storage = createFakeStorage({ initialGlobal: structuredClone(snapshot) });
  const first = await createSession({ storage });
  const initial = await first.call('bootstrap', {});
  assert.equal(initial.ok, true);
  assert.equal(initial.data.tasks.length, 3);
  assert.deepEqual(initial.data.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.deepEqual(initial.data.existingTasks.items, []);
  await first.service.dispose();
  const second = await createSession({ storage });
  const reloaded = await second.call('bootstrap', {});
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.data.tasks, initial.data.tasks);
  assert.equal(reloaded.data.revision, snapshot.revision);
  assert.deepEqual(reloaded.data.existingTasks.items, []);
  assert.equal(reloaded.data.capabilities.execution, false);
  for (const [op, payload, code] of [
    ['addManual', ADD, 'capability_missing'],
    ['editPending', { id: 'old-queued', prompt: 'retry old' }, 'capability_missing'],
    ['cancelQueued', { id: 'old-queued' }, 'not_cancellable'],
  ]) {
    const result = await second.call(op, payload, { requestId: 'reload-1' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
  assert.deepEqual(storage.state.global, snapshot);
  assert.equal(storage.state.saves, 0);
  await second.service.dispose();
});

test('dispose drains an accepted pause write before releasing the unit', async () => {
  const history = seededSnapshot([seedTask()]);
  const storage = createFakeStorage({ initialGlobal: structuredClone(history) });
  const session = await createSession({ storage });
  const write = session.call('pauseDispatch', { paused: true });
  const disposal = session.service.dispose();
  const [result] = await Promise.all([write, disposal]);
  assert.equal(result.ok, true);
  assert.equal(result.data.paused, true);
  assert.equal(storage.state.activeOpens, 0);
  assert.equal(storage.state.global.dispatchPaused, true);
  assert.equal(storage.state.global.revision, history.revision + 1);
  assert.deepEqual(storage.state.global.tasks, history.tasks);
  assert.equal(storage.state.saves, 1);
  assert.equal(storage.state.closes, 2);
  const refused = await session.call('pauseDispatch', { paused: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'unavailable');
});

test('a global pause survives reload without rewriting any legacy task', async () => {
  const history = seededSnapshot([seedTask({ status: 'waiting_quota' })]);
  const storage = createFakeStorage({ initialGlobal: structuredClone(history) });
  const first = await createSession({ storage });
  const paused = await first.call('pauseDispatch', { paused: true });
  assert.equal(paused.ok, true);
  await first.service.dispose();
  const second = await createSession({ storage });
  const view = (await second.call('bootstrap', {})).data;
  assert.equal(view.paused, true);
  assert.equal(view.revision, paused.data.revision);
  assert.deepEqual(storage.state.global.tasks, history.tasks);
  assert.equal(storage.state.saves, 1);
  assert.equal(view.capabilities.execution, false);
  assert.equal(view.capabilities.autoResume, false);
  await second.service.dispose();
});
