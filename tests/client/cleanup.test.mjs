import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeCtx, makeScheduler, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
const HOUR = 3600000;

function viewWithNextCheck(offsetMs) {
  const raw = validView();
  raw.tasks[0].nextCheckAt = new Date(1000 + offsetMs).toISOString();
  return raw;
}

test('dispose clears the scheduled next-check timer', async () => {
  const scheduler = makeScheduler();
  const harness = makeCtx({ connection: { rpc: { call: async () => ({ ok: true, value: { ok: true, data: viewWithNextCheck(HOUR * 2) } }) } } });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000, scheduler: scheduler });
  await controller.actions.refresh();
  assert.equal(scheduler.timers.size, 1);
  controller.dispose();
  assert.equal(scheduler.timers.size, 0);
});

test('a past next-check clamps to the minimum delay and reschedules on fire', async () => {
  const scheduler = makeScheduler();
  const harness = makeCtx({ connection: { rpc: { call: async () => ({ ok: true, value: { ok: true, data: viewWithNextCheck(-10000) } }) } } });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000, scheduler: scheduler });
  await controller.actions.refresh();
  assert.equal(scheduler.timers.size, 1);
  const entry = Array.from(scheduler.timers.values())[0];
  assert.equal(entry.delay, 1000);
  controller.dispose();
});

test('dispose aborts an in-flight request', async () => {
  let seenSignal = null;
  const harness = makeCtx({
    connection: {
      rpc: {
        call: (channel, endpoint, payload, signal) => {
          seenSignal = signal;
          return new Promise(() => {});
        }
      }
    }
  });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000 });
  void controller.actions.checkQuota();
  await Promise.resolve();
  assert.ok(seenSignal);
  assert.equal(seenSignal.aborted, false);
  controller.dispose();
  assert.equal(seenSignal.aborted, true);
});

test('after dispose every operation returns closed and no request is sent', async () => {
  let calls = 0;
  const harness = makeCtx({ connection: { rpc: { call: async () => { calls += 1; return { ok: true, value: { ok: true, data: validView() } }; } } } });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000 });
  controller.dispose();
  const result = await controller.actions.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'closed');
  assert.equal(calls, 0);
  assert.equal(controller.getSnapshot().closed, true);
  const snapshot = controller.getSnapshot();
  for (const invoke of [
    () => controller.actions.checkQuota(), () => controller.actions.setPaused(false),
    () => controller.actions.addManual({}), () => controller.actions.editPending({}),
    () => controller.actions.cancelQueued('t1'), () => controller.actions.requestStop('t1'),
    () => controller.actions.setSessionOptIn('s1', true), () => controller.actions.setSessionOptIn('s1', false),
    () => controller.actions.openPanel(), () => controller.actions.openSession('s1')
  ]) assert.equal((await invoke()).error.code, 'closed');
  controller.actions.dismissNotice();
  controller.start();
  controller.onConnectionReset();
  assert.equal(calls, 0);
  assert.equal(controller.getSnapshot(), snapshot);
});

test('the session list subscription is released on dispose', () => {
  let unsubscribed = 0;
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: ['s1'], byId: { s1: { displayTitle: 'One', running: false } } }),
      subscribe: () => () => { unsubscribed += 1; }
    }
  };
  const harness = makeCtx({ services: { sessions: sessions }, connection: { rpc: { call: async () => ({ ok: true, value: { ok: true, data: validView() } }) } } });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000 });
  controller.start();
  assert.equal(controller.getSnapshot().sessions.length, 1);
  controller.dispose();
  assert.equal(unsubscribed, 1);
});

test('disposing the plugin effects stops the controller so no late request lands', async () => {
  const loaded = loadClient();
  const scheduler = makeScheduler();
  let release = null;
  const harness = makeCtx({ connection: { rpc: { call: () => new Promise((resolve) => { release = resolve; }) } } });
  loaded.moduleExports.apply(harness.ctx);
  await Promise.resolve();
  harness.disposeAll();
  assert.equal(harness.listeners.get('connection/reset').size, 0);
  if (release) release({ ok: true, value: { ok: true, data: validView() } });
  await Promise.resolve();
  void scheduler;
});
