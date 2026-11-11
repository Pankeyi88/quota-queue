import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_MESSAGES } from '../../host/errors.js';
import { loadClient, makeCtx, makeT, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
const en = internals.dictionaries.en;
const zh = internals.dictionaries.zh;

function controllerFor(call) {
  const harness = makeCtx({ connection: { rpc: { call } } });
  return internals.createController(harness.ctx, { t: makeT(en), now: () => 1000 });
}

test('every fixed Host failure code maps to a localized canonical code', () => {
  const codes = Object.keys(SAFE_MESSAGES);
  assert.ok(codes.length >= 19, 'unexpected Host catalog size');
  for (const code of codes) {
    const mapped = internals.normalizeErrorCode(code);
    assert.notEqual(mapped, 'request_failed', code + ' degenerated to request_failed');
    assert.equal(typeof zh['error.' + mapped], 'string', 'zh missing error.' + mapped);
    assert.equal(typeof en['error.' + mapped], 'string', 'en missing error.' + mapped);
  }
  assert.equal(internals.normalizeErrorCode('a_code_from_the_future'), 'request_failed');
  assert.equal(internals.normalizeErrorCode(undefined), 'request_failed');
});

test('operator, workspace, route, persistence and conflict failures are explicit', () => {
  assert.equal(internals.normalizeErrorCode('operator_required'), 'authorization_denied');
  assert.equal(internals.normalizeErrorCode('workspace_not_found'), 'workspace_unavailable');
  assert.equal(internals.normalizeErrorCode('workspace_unavailable'), 'workspace_unavailable');
  assert.equal(internals.normalizeErrorCode('route_unavailable'), 'route_unavailable');
  assert.equal(internals.normalizeErrorCode('persistence_failed'), 'persistence_failed');
  assert.equal(internals.normalizeErrorCode('request_conflict'), 'request_conflict');
  assert.equal(internals.normalizeErrorCode('invalid_request'), 'invalid_input');
  assert.equal(internals.normalizeErrorCode('not_editable'), 'not_editable');
  assert.equal(internals.normalizeErrorCode('not_cancellable'), 'not_cancellable');
  assert.ok(zh['error.persistence_failed'].indexOf('调度已停止') !== -1);
  assert.ok(zh['error.request_conflict'].indexOf('requestId') !== -1);
  assert.ok(zh['error.workspace_unavailable'].indexOf('工作区') !== -1);
  assert.ok(zh['error.route_unavailable'].indexOf('路由') !== -1);
  assert.ok(zh['error.authorization_denied'].indexOf('授权') !== -1);
  assert.ok(zh['error.not_editable'].length > 0);
  assert.ok(zh['error.not_cancellable'].length > 0);
});

test('no Host failure leaks its raw message and each keeps the mapped code', async () => {
  for (const code of Object.keys(SAFE_MESSAGES)) {
    const controller = controllerFor(async () => ({ ok: true, value: { ok: false, error: { code: code, message: SAFE_MESSAGES[code] } } }));
    const result = await controller.actions.refresh();
    const mapped = internals.normalizeErrorCode(code);
    assert.equal(result.ok, false, code);
    assert.equal(result.error.code, mapped, code);
    assert.equal(controller.getSnapshot().error.code, mapped, code);
    assert.equal(JSON.stringify(controller.getSnapshot()).indexOf(SAFE_MESSAGES[code]), -1, 'raw message leaked for ' + code);
  }
});

test('a Host internal failure keeps the same mutation requestId on a same-payload retry', async () => {
  const seen = [];
  let mode = 'internal';
  const controller = controllerFor(async (channel, endpoint, payload) => {
    seen.push(payload.args.request);
    if (mode === 'internal') return { ok: true, value: { ok: false, error: { code: 'internal', message: SAFE_MESSAGES.internal } } };
    return { ok: true, value: { ok: true, data: validView() } };
  });
  const input = true;
  const first = await controller.actions.setPaused(input);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'internal');
  assert.equal(first.error.ambiguous, true);
  assert.equal(controller.getSnapshot().warning, en['notice.ambiguous']);
  mode = 'ok';
  const second = await controller.actions.setPaused(input);
  assert.equal(second.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].requestId, seen[1].requestId);
});

test('an unknown Host code is ambiguous and reuses the requestId too', async () => {
  const seen = [];
  let mode = 'unknown';
  const controller = controllerFor(async (channel, endpoint, payload) => {
    seen.push(payload.args.request);
    if (mode === 'unknown') return { ok: true, value: { ok: false, error: { code: 'a_code_from_the_future', message: 'raw future text' } } };
    return { ok: true, value: { ok: true, data: validView() } };
  });
  const input = true;
  const first = await controller.actions.setPaused(input);
  assert.equal(first.error.code, 'request_failed');
  assert.equal(first.error.ambiguous, true);
  mode = 'ok';
  await controller.actions.setPaused(input);
  assert.equal(seen[0].requestId, seen[1].requestId);
  assert.equal(JSON.stringify(controller.getSnapshot()).indexOf('raw future text'), -1);
});

test('a definite Host conflict is not ambiguous and a retry is a fresh transaction', async () => {
  const seen = [];
  let mode = 'conflict';
  const controller = controllerFor(async (channel, endpoint, payload) => {
    seen.push(payload.args.request);
    if (mode === 'conflict') return { ok: true, value: { ok: false, error: { code: 'request_conflict', message: SAFE_MESSAGES.request_conflict } } };
    return { ok: true, value: { ok: true, data: validView() } };
  });
  const input = true;
  const first = await controller.actions.setPaused(input);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'request_conflict');
  assert.equal(first.error.ambiguous, false);
  assert.equal(controller.getSnapshot().warning, null);
  mode = 'ok';
  await controller.actions.setPaused(input);
  assert.notEqual(seen[0].requestId, seen[1].requestId);
});

test('a persistence failure is definite and says dispatch is stopped', async () => {
  const controller = controllerFor(async () => ({ ok: true, value: { ok: false, error: { code: 'persistence_failed', message: SAFE_MESSAGES.persistence_failed } } }));
  const result = await controller.actions.setPaused(true);
  assert.equal(result.error.code, 'persistence_failed');
  assert.equal(result.error.ambiguous, false);
  assert.equal(controller.getSnapshot().view, null);
  assert.equal(controller.getSnapshot().notice.text, en['error.persistence_failed']);
});
