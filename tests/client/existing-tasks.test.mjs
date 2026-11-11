import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, validView, makeCtx, makeT, renderElement } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
function hint(overrides = {}) {
  return { sessionId: 's-existing', title: 'Existing task', workspacePath: 'E:/existing', running: false, source: 'sequenced', asOfSeq: 12, selectable: false, reason: 'task_execution_identity_unverified', ...overrides };
}
const withHints = (existingTasks) => internals.projectView(validView({ existingTasks }));

test('an older Host without existingTasks projects an unavailable empty list', () => {
  const result = internals.projectView(validView());
  assert.equal(result.ok, true);
  assert.equal(result.view.existingTasks.available, false);
  assert.equal(result.view.existingTasks.items.length, 0);
});

test('valid cached and sequenced hints are projected with selection permanently disabled', () => {
  for (const source of ['cached', 'sequenced']) {
    const result = withHints({ available: true, reason: null, items: [hint({ source })] });
    assert.equal(result.ok, true);
    assert.equal(result.view.existingTasks.items[0].source, source);
    assert.equal(result.view.existingTasks.items[0].asOfSeq, 12);
    assert.equal(result.view.existingTasks.items[0].selectable, false);
    assert.equal(result.view.existingTasks.items[0].reason, 'task_execution_identity_unverified');
  }
});

test('unknown hint fields, task bodies and raw errors are dropped', () => {
  const result = withHints({ available: true, reason: null, token: 'top-secret', items: [hint({ prompt: 'original body', rawError: 'private failure', credentialRef: 'private-ref', authorization: 'Bearer hidden' })] });
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.view.existingTasks);
  for (const secret of ['top-secret', 'original body', 'private failure', 'private-ref', 'Bearer hidden']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(result.view.existingTasks.items[0]).sort(), ['asOfSeq', 'reason', 'running', 'selectable', 'sessionId', 'source', 'title', 'workspacePath']);
});

test('malformed existingTasks rejects the whole View rather than fabricating hints', () => {
  for (const raw of [null, [], {}, { available: 'yes', reason: null, items: [] }, { available: false, items: [] }, { available: false, reason: {}, items: [] }, { available: true, reason: null, items: {} }]) assert.equal(withHints(raw).ok, false, JSON.stringify(raw));
});

test('decisive list hint fields are required and strictly typed', () => {
  for (const field of ['sessionId', 'title', 'workspacePath', 'running', 'source', 'asOfSeq', 'selectable', 'reason']) {
    const partial = hint();
    delete partial[field];
    assert.equal(withHints({ available: true, reason: null, items: [partial] }).ok, false, field);
  }
  for (const override of [{ sessionId: '' }, { title: 12 }, { workspacePath: {} }, { running: 'false' }, { source: 'unknown' }, { asOfSeq: -1 }, { asOfSeq: 1.2 }, { selectable: true }, { selectable: 0 }, { reason: 'raw error' }]) assert.equal(withHints({ available: true, reason: null, items: [hint(override)] }).ok, false, JSON.stringify(override));
});

test('duplicate session hints are rejected and nullable workspace paths are preserved', () => {
  assert.equal(withHints({ available: true, reason: null, items: [hint(), hint()] }).ok, false);
  const result = withHints({ available: true, reason: null, items: [hint({ workspacePath: null })] });
  assert.equal(result.ok, true);
  assert.equal(result.view.existingTasks.items[0].workspacePath, null);
});

test('unknown top-level reasons map to a fixed local failure instead of raw text', () => {
  const result = withHints({ available: false, reason: 'secret token http://internal', items: [] });
  assert.equal(result.ok, true);
  assert.equal(result.view.existingTasks.reason, 'existing_task_list_invalid');
  assert.equal(JSON.stringify(result.view).includes('secret token'), false);
});

test('fixed top-level list reasons remain usable without granting execution', () => {
  for (const reason of ['session_registry_unavailable', 'existing_task_list_failed', 'existing_task_list_invalid', 'cancelled']) {
    const result = withHints({ available: false, reason, items: [] });
    assert.equal(result.ok, true);
    assert.equal(result.view.existingTasks.reason, reason);
    assert.equal(result.view.existingTasks.available, false);
  }
});

test('bootstrap carries hints through the existing RPC and does not call a new API', async () => {
  const calls = [];
  const harness = makeCtx({ connection: { rpc: { call: async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, request: payload.args.request });
    return { ok: true, value: { ok: true, data: validView({ existingTasks: { available: true, reason: null, items: [hint()] } }) } };
  } } } });
  const controller = internals.createController(harness.ctx);
  assert.equal((await controller.actions.refresh()).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, '/api');
  assert.equal(calls[0].endpoint, 'quotaQueue/dispatch');
  assert.equal(calls[0].request.op, 'bootstrap');
  assert.equal(controller.getSnapshot().view.existingTasks.items.length, 1);
  // Enabling is a normal boolean RPC now; the Host decides whether the HOT
  // adapter exists and rejects with capability_missing when it does not.
  assert.equal((await controller.actions.setSessionOptIn('s-existing', true)).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request.payload.enabled, true);
  const tree = internals.components.QuotaQueuePanel({ t: makeT(internals.dictionaries.en), store: controller.store, actions: controller.actions });
  // The read-only list is no longer a surface: hints still arrive in the View
  // (the Host uses them for plan titles) but the panel never renders them.
  const out = renderElement(tree);
  assert.equal(out.includes('List hints do not verify task execution identity'), false);
  assert.equal(out.includes('E:/existing'), false);
  assert.equal(out.includes('s-existing'), false);
  controller.dispose();
});

 test('hint text is bounded and control characters removed before display', () => {
  const result = withHints({ available: true, reason: null, items: [hint({ title: 'a\u0000b\n' + 'x'.repeat(300), workspacePath: 'E:/\u0000' + 'y'.repeat(2000) })] });
  assert.equal(result.ok, true);
  const item = result.view.existingTasks.items[0];
  assert.ok(item.title.length <= 200);
  assert.ok(item.workspacePath.length <= 1024);
  assert.equal(item.title.includes('\u0000'), false);
  assert.equal(item.title.includes('\n'), false);
});
