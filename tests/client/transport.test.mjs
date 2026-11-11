import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeCtx, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;

function controllerFor(call, options) {
  const harness = makeCtx({ connection: call === null ? undefined : { rpc: { call: call } } });
  const merged = Object.assign({ t: (key) => key, now: () => 1000 }, options || {});
  return { harness: harness, controller: internals.createController(harness.ctx, merged) };
}

test('a successful dispatch publishes the projected view', async () => {
  const calls = [];
  const built = controllerFor(async (channel, endpoint, payload, signal) => {
    calls.push({ channel: channel, endpoint: endpoint, payload: payload, signal: signal });
    return { ok: true, value: { ok: true, data: validView() } };
  });
  const result = await built.controller.actions.refresh();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'quotaQueue/dispatch');
  // Verified Gateway wire: exactly one 'args' key, and the Host method
  // parameter named 'request' receives the whole request object.
  assert.equal(Object.keys(calls[0].payload).join(','), 'args');
  assert.equal(Object.keys(calls[0].payload.args).join(','), 'request');
  assert.equal(typeof calls[0].payload.args.request.requestId, 'string');
  assert.ok(calls[0].payload.args.request.requestId.length >= 36);
  assert.equal(calls[0].payload.args.request.version, 1);
  assert.equal(calls[0].payload.args.request.op, 'bootstrap');
  assert.equal(built.controller.getSnapshot().view.revision, 3);
  assert.equal(built.controller.getSnapshot().error, null);
});

test('a missing connection service is capability_missing and performs no network call', async () => {
  let called = false;
  const harness = makeCtx({ connection: undefined });
  const controller = internals.createController(harness.ctx, { t: (key) => key, now: () => 1000 });
  const result = await controller.actions.checkQuota();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_missing');
  assert.equal(called, false);
  assert.equal(controller.getSnapshot().error.code, 'capability_missing');
  assert.equal(controller.getSnapshot().view, null);
});

test('a Connection transport failure never echoes the host message', async () => {
  const built = controllerFor(async () => ({ ok: false, error: { code: 'unauthenticated', message: 'token abc http://hidden' } }));
  const result = await built.controller.actions.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'request_failed');
  const snapshot = built.controller.getSnapshot();
  assert.equal(snapshot.error.code, 'request_failed');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.indexOf('token abc'), -1);
  assert.equal(serialized.indexOf('hidden'), -1);
  assert.equal(snapshot.view, null);
});

test('an application-level error keeps its whitelisted code and a fixed message', async () => {
  const built = controllerFor(async () => ({ ok: true, value: { ok: false, error: { code: 'CONFIGURATION_INCOMPLETE', message: 'raw secret https://x' } } }));
  const result = await built.controller.actions.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'configuration_incomplete');
  assert.equal(built.controller.getSnapshot().error.code, 'configuration_incomplete');
  assert.equal(JSON.stringify(built.controller.getSnapshot()).indexOf('raw secret'), -1);
});

test('a malformed Host view is discarded as protocol_error', async () => {
  const built = controllerFor(async () => ({ ok: true, value: { ok: true, data: { version: 9, revision: 1 } } }));
  const result = await built.controller.actions.refresh();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'protocol_error');
  assert.equal(built.controller.getSnapshot().view, null);
});

test('a thrown transport exception is transport_error and changes no view', async () => {
  const built = controllerFor(async () => { throw new Error('socket closed'); });
  const result = await built.controller.actions.checkQuota();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'transport_error');
  assert.equal(built.controller.getSnapshot().error.code, 'transport_error');
});

test('a failed mutation leaves the previous view reference untouched', async () => {
  let mode = 'ok';
  const built = controllerFor(async () => {
    if (mode === 'ok') return { ok: true, value: { ok: true, data: validView() } };
    return { ok: true, value: { ok: false, error: { code: 'PERSIST_FAILED', message: 'disk' } } };
  });
  await built.controller.actions.refresh();
  const published = built.controller.getSnapshot().view;
  assert.ok(published);
  mode = 'fail';
  const result = await built.controller.actions.cancelQueued('t1');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'persistence_failed');
  assert.equal(built.controller.getSnapshot().view, published);
});

test('a repeated operation while one is pending returns busy and sends one request', async () => {
  let calls = 0;
  let release = null;
  const built = controllerFor(() => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  });
  const first = built.controller.actions.checkQuota();
  const second = await built.controller.actions.checkQuota();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'busy');
  assert.equal(calls, 1);
  release({ ok: true, value: { ok: true, data: validView() } });
  const settled = await first;
  assert.equal(settled.ok, true);
  built.controller.dispose();
});

test('a bare View, a missing data member or null data is never success', async () => {
  const bare = controllerFor(async () => ({ ok: true, value: validView() }));
  const bareResult = await bare.controller.actions.refresh();
  assert.equal(bareResult.ok, false);
  assert.equal(bareResult.error.code, 'protocol_error');

  const missing = controllerFor(async () => ({ ok: true, value: { ok: true } }));
  assert.equal((await missing.controller.actions.refresh()).error.code, 'protocol_error');

  const empty = controllerFor(async () => ({ ok: true, value: { ok: true, data: null } }));
  assert.equal((await empty.controller.actions.refresh()).error.code, 'protocol_error');

  const appNoFlag = controllerFor(async () => ({ ok: true, value: { data: validView() } }));
  assert.equal((await appNoFlag.controller.actions.refresh()).error.code, 'protocol_error');
});

test('an ambiguous failure remembers the request and a same-payload retry reuses its id', async () => {
  const seen = [];
  let mode = 'throw';
  const built = controllerFor(async (channel, endpoint, payload) => {
    seen.push(payload.args.request);
    if (mode === 'throw') throw new Error('socket closed');
    return { ok: true, value: { ok: true, data: validView() } };
  });
  const input = true;
  const first = await built.controller.actions.setPaused(input);
  assert.equal(first.ok, false);
  assert.equal(first.error.ambiguous, true);
  assert.equal(built.controller.getSnapshot().warning, 'notice.ambiguous');

  mode = 'ok';
  const second = await built.controller.actions.setPaused(input);
  assert.equal(second.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].requestId, seen[1].requestId);
  assert.equal(built.controller.getSnapshot().warning, null);
});

test('changing the payload after an ambiguous failure starts a new transaction and says so', async () => {
  const seen = [];
  let mode = 'throw';
  const built = controllerFor(async (channel, endpoint, payload) => {
    seen.push(payload.args.request);
    if (mode === 'throw') throw new Error('socket closed');
    return { ok: true, value: { ok: true, data: validView() } };
  });
  await built.controller.actions.setPaused(true);
  mode = 'ok';
  const result = await built.controller.actions.setPaused(false);
  assert.equal(result.ok, true);
  assert.notEqual(seen[0].requestId, seen[1].requestId);
  assert.equal(built.controller.getSnapshot().warning, 'notice.unresolvedPrevious');
});

test('a stale revision from a slower response never overwrites a newer one', async () => {
  const release = [];
  const built = controllerFor(() => new Promise((resolve) => { release.push(resolve); }));
  const boot = built.controller.actions.refresh();
  const add = built.controller.actions.checkQuota();
  await Promise.resolve();
  assert.equal(release.length, 2);
  release[1]({ ok: true, value: { ok: true, data: validView({ revision: 5 }) } });
  const added = await add;
  assert.equal(added.ok, true);
  assert.equal(built.controller.getSnapshot().view.revision, 5);
  release[0]({ ok: true, value: { ok: true, data: validView({ revision: 3 }) } });
  const booted = await boot;
  assert.equal(booted.ok, true);
  assert.equal(built.controller.getSnapshot().view.revision, 5);
});

test('the request signal is handed to the transport', async () => {
  let seenSignal = null;
  const built = controllerFor(async (channel, endpoint, payload, signal) => {
    seenSignal = signal;
    return { ok: true, value: { ok: true, data: validView() } };
  });
  await built.controller.actions.refresh();
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal.aborted, false);
});
