import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryPlanStore } from '../../core/recovery-plan-store.mjs';
import { createRecoveryPlan } from '../../core/recovery-plan.mjs';

function medium(initial = null) {
  const state = { value: structuredClone(initial), saves: 0, fail: false };
  return { state, ports: {
    async load() { return structuredClone(state.value); },
    async save(next) { state.saves++; if (state.fail) throw new Error('sensitive'); state.value = structuredClone(next); },
  } };
}
const pause = (paused = true) => ({ type: 'pausePlan', paused });

test('command cloning never invokes getters or launders custom prototypes', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports); await store.open();
  let reads = 0;
  const accessor = { type: 'pausePlan', get paused() { reads++; throw new Error('private'); } };
  await assert.rejects(store.commit(0, accessor), /invalid_intent/);
  const custom = Object.assign(Object.create({ marker: true }), pause());
  await assert.rejects(store.commit(0, custom), /invalid_intent/);
  const symbol = pause(); symbol[Symbol('secret')] = true;
  await assert.rejects(store.commit(0, symbol), /invalid_intent/);
  assert.equal(reads, 0);
  assert.equal(m.state.saves, 0);
  assert.equal(store.locked, false);
  assert.equal(store.getSnapshot().revision, 0);
});

test('idempotent open returns the current detached snapshot after commits', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports);
  await store.open(); await store.commit(0, pause());
  const reopened = await store.open();
  assert.equal(reopened.revision, 1);
  reopened.paused = false;
  assert.equal(store.getSnapshot().paused, true);
});

test('new plan defaults to no tasks; loaded v1 queue cannot become an executable plan', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports);
  assert.deepEqual(await store.open(), createRecoveryPlan());
  assert.equal(m.state.saves, 0);
  const legacy = new RecoveryPlanStore(medium({ schemaVersion: 1, tasks: [] }).ports);
  await assert.rejects(legacy.open(), /invalid_snapshot/);
  assert.equal(legacy.locked, true);
  assert.equal(legacy.opened, false);
});

test('save failure publishes nothing and permanently locks later writes', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports); await store.open();
  const before = store.getSnapshot(); m.state.fail = true;
  await assert.rejects(store.commit(0, pause()), /save_failed/);
  assert.deepEqual(store.getSnapshot(), before);
  assert.equal(store.locked, true);
  await assert.rejects(store.commit(0, pause()), /locked/);
  assert.equal(m.state.saves, 1);
});

test('concurrent submissions use one durable revision; stale write never saves', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports); await store.open();
  const results = await Promise.allSettled([store.commit(0, pause()), store.commit(0, pause(false))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(m.state.saves, 1);
  assert.equal(store.getSnapshot().revision, 1);
  assert.equal(store.getSnapshot().paused, true);
});

test('candidate and caller objects stay detached across save and reads', async () => {
  const m = medium(); const store = new RecoveryPlanStore(m.ports); await store.open();
  const command = pause(); const pending = store.commit(0, command); command.paused = false;
  const result = await pending; result.paused = false;
  const read = store.getSnapshot(); read.paused = false;
  assert.equal(store.getSnapshot().paused, true);
  assert.equal(m.state.value.paused, true);
});

test('publication waits for durable save; close drains accepted work and rejects new commands', async () => {
  let release, entered;
  const barrier = new Promise((resolve) => { entered = resolve; });
  const store = new RecoveryPlanStore({ load: async () => null, save: async () => {
    entered(); await new Promise((resolve) => { release = resolve; });
  } });
  await store.open();
  const pending = store.commit(0, pause()); await barrier;
  assert.equal(store.getSnapshot().paused, false);
  const closing = store.close();
  await assert.rejects(store.commit(0, pause()), /closed/);
  release(); await pending; await closing;
  assert.equal(store.getSnapshot().paused, true);
  assert.equal(store.close(), closing);
});

test('load error and corrupt snapshot never publish; valid plan survives reload', async () => {
  const bad = new RecoveryPlanStore({ load: async () => { throw new Error('private'); }, save: async () => {} });
  await assert.rejects(bad.open(), /load_failed/); assert.equal(bad.locked, true);
  assert.throws(() => bad.getSnapshot(), /not_open/);
  const m = medium(); const first = new RecoveryPlanStore(m.ports); await first.open();
  await first.commit(0, pause()); await first.close();
  const second = new RecoveryPlanStore(m.ports); assert.equal((await second.open()).paused, true);
  assert.equal(second.getSnapshot().revision, 1);
});
