import assert from 'node:assert/strict';
import test from 'node:test';
import { createExistingTaskReader } from '../../host/existing-tasks.js';
import { createSession } from './harness.mjs';

function row(overrides = {}) {
  return {
    sessionId: 'session-1', blank: false, running: false, agentAvailable: false,
    cwd: 'E:/work',
    projections: { kind: 'cached', asOfSeq: 10, values: {
      sessionListMetadata: { blank: false, lastPromptAt: 1000 }, title: 'Existing task',
      secret: 'must-not-leak', modelSelection: { next: { provider: 'hidden' } },
    } },
    ...overrides,
  };
}

const reader = (items) => createExistingTaskReader(() => ({ list: async () => ({ items }) }));

test('service bootstrap uses public controller lazily and never authorizes a list hint', async () => {
  const session = await createSession({ services: { sessionController: undefined } });
  const absent = (await session.call('bootstrap', {})).data;
  assert.equal(absent.existingTasks.available, false);
  let calls = 0;
  session.setService('sessionController', { list: async () => { calls++; return { items: [row()] }; } });
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(calls, 1);
  assert.equal(view.existingTasks.items[0].sessionId, 'session-1');
  assert.equal(view.existingTasks.items[0].selectable, false);
  assert.equal(view.capabilities.execution, false);
  assert.equal(session.storage.state.saves, 0);
  session.setService('sessionController', undefined);
  assert.equal((await session.call('bootstrap', {})).data.existingTasks.available, false);
  await session.service.dispose();
});

test('lists only documented positive human-task hints and whitelists the output', async () => {
  let creates = 0;
  let seen;
  const controller = {
    list: async (request, signal) => { seen = { request, signal }; return { items: [row()] }; },
    create() { creates++; }, resolveAgent() { creates++; }, inspect() { creates++; },
  };
  const signal = new AbortController().signal;
  const result = await createExistingTaskReader(() => controller).list(signal);
  assert.equal(result.available, true);
  assert.deepEqual(seen.request, {});
  assert.equal(seen.signal, signal);
  assert.equal(creates, 0);
  assert.deepEqual(result.items, [{ sessionId: 'session-1', title: 'Existing task', workspacePath: 'E:/work',
    running: false, source: 'cached', asOfSeq: 10, selectable: false, reason: 'task_execution_identity_unverified' }]);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('blank=false cache miss is not sufficient evidence', async () => {
  assert.deepEqual((await reader([row({ projections: undefined })]).list()).items, []);
  for (const lastPromptAt of [null, undefined, '1000', 0, -1, NaN, Infinity]) {
    const r = row(); r.projections.values.sessionListMetadata.lastPromptAt = lastPromptAt;
    assert.deepEqual((await reader([r]).list()).items, []);
  }
});

test('subagents forks blank unknown and malformed rows never become selectable tasks', async () => {
  const result = await reader([
    row({ origin: 'subagent' }), row({ parentSessionId: 'parent' }), row({ blank: true }),
    row({ running: undefined }), row({ agentAvailable: undefined }), row({ sessionId: '' }),
    row({ projections: { kind: 'unknown', asOfSeq: 1, values: {} } }),
    null, 1, {}, row(), row(),
  ]).list();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].selectable, false);
});

test('controller is resolved per call and failures do not leak exception text', async () => {
  let controller;
  const r = createExistingTaskReader(() => controller);
  assert.equal((await r.list()).reason, 'session_registry_unavailable');
  controller = { list: async () => ({ items: [row()] }) };
  assert.equal((await r.list()).items.length, 1);
  controller = { list: async () => { throw new Error('private-token'); } };
  const failed = await r.list();
  assert.equal(failed.reason, 'existing_task_list_failed');
  assert.equal(JSON.stringify(failed).includes('private-token'), false);
  controller = { list: async () => [] };
  assert.equal((await r.list()).reason, 'existing_task_list_invalid');
});

test('throwing service/result/row getters become fixed safe list failures', async () => {
  const badController = createExistingTaskReader(() => ({ get list() { throw new Error('private-token'); } }));
  assert.deepEqual(await badController.list(), { available: false, reason: 'existing_task_list_failed', items: [] });
  const badResult = createExistingTaskReader(() => ({ list: async () => ({ get items() { throw new Error('private-token'); } }) }));
  assert.equal((await badResult.list()).reason, 'existing_task_list_failed');
  const badRow = { get sessionId() { throw new Error('private-token'); } };
  const bad = await reader([badRow]).list();
  assert.equal(bad.reason, 'existing_task_list_failed');
  assert.equal(JSON.stringify(bad).includes('private-token'), false);
});

test('aborted callers do not enumerate and a late list result is discarded', async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  const r = createExistingTaskReader(() => ({ list: async () => { calls++; return { items: [row()] }; } }));
  assert.equal((await r.list(abort.signal)).reason, 'cancelled');
  assert.equal(calls, 0);
  const active = new AbortController();
  const late = createExistingTaskReader(() => ({ list: async () => { active.abort(); return { items: [row()] }; } }));
  assert.equal((await late.list(active.signal)).reason, 'cancelled');
});
