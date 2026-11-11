/** Real operation engine over fake IO; legacy reservations are read-only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SAFE_MESSAGES } from '../../host/errors.js';
import {
  ROUTE, ROUTE_B, createFakeStorage, createFakeWorkspaceRegistry,
  createSession, seededSnapshot, seedTask, workspaceRecord,
} from './harness.mjs';

const WORKSPACE = 'ws-1';
const ADD = { prompt: 'Do the thing', workspaceId: WORKSPACE, routeId: ROUTE.id };

function assertNoSensitiveKeys(value) {
  const text = JSON.stringify(value);
  for (const needle of ['"credentialRef"', 'common-codex-ref', '"credential_ref"', '"credential"', '"headers"', '"authorization"', '"cause"', '"rawResponse"', '"token"']) {
    assert.equal(text.includes(needle), false, `View leaked ${needle}`);
  }
}
function assertFailure(result, code) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { code, message: SAFE_MESSAGES[code] });
}
function historicalSession(tasks = [seedTask()], options = {}) {
  const storage = createFakeStorage({ initialGlobal: seededSnapshot(tasks) });
  return createSession({ ...options, storage });
}

test('bootstrap returns the fixed safe View and keeps every capability disabled', async () => {
  const session = await createSession();
  const result = await session.call('bootstrap', {});
  assert.equal(result.ok, true);
  const view = result.data;
  assert.equal(view.version, 1);
  assert.equal(typeof view.revision, 'number');
  assert.equal(view.paused, false);
  assert.equal(view.configuration.ready, false);
  assert.deepEqual(view.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  for (const reason of ['stable_credential_reference_unconfirmed', 'quota_query_auth_contract_unverified', 'exclusive_execution_ownership_unproven', 'auto_resume_ownership_unverified']) {
    assert.ok(view.configuration.reasons.includes(reason), `missing reason ${reason}`);
  }
  assert.deepEqual(view.workspaces, [{ id: WORKSPACE, name: 'one', path: 'E:/ws/one', available: true }]);
  assert.equal(view.routes.length, 1);
  assert.equal(view.routes[0].available, false);
  assert.equal(view.routes[0].selectable, true);
  assert.equal(view.routes[0].reason, 'execution_capability_missing');
  assert.equal(view.routes[0].provider, ROUTE.provider);
  assert.deepEqual(view.tasks, []);
  assert.deepEqual(view.sessionOptIns, {});
  assertNoSensitiveKeys(view);
  const queueDescriptor = session.storage.state.descriptors.find((entry) => entry.name === 'quota_queue_v1');
  assert.equal(queueDescriptor.version, 1);
  assert.equal(queueDescriptor.hasGlobal, true);
  assert.deepEqual(queueDescriptor.tables, []);
  // The editable plan has its own isolated unit.
  const planDescriptor = session.storage.state.descriptors.find((entry) => entry.name === 'quota_recovery_plan_v1');
  assert.equal(planDescriptor.version, 1);
  assert.equal(planDescriptor.hasGlobal, true);
  assert.deepEqual(session.storage.state.units.get('quota_recovery_plan_v1'), undefined);
  assert.deepEqual(view.existingTasks, { available: false, reason: 'session_registry_unavailable', items: [] });
  assert.deepEqual(view.recoveryPlan, {
    available: true, editable: true, reason: null,
    revision: 0, maxConcurrent: 1, paused: false, batches: [], items: [],
  });
});

test('a workspace with a missing directory is reported unavailable, not silently usable', async () => {
  const session = await createSession({ workspaces: {
    get() { return undefined; },
    list() { return [{ id: 'ws-2', path: 'E:/gone', title: 'gone', status: async () => 'missing-dir' }]; },
  } });
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.workspaces[0].available, false);
  assert.equal(view.configuration.ready, false);
});

test('retired addManual rejects valid requests and retries without ever saving a new task', async () => {
  const session = await createSession();
  for (const [requestId, payload] of [['add-1', ADD], ['add-1', ADD], ['add-2', { ...ADD, prompt: 'other' }]]) {
    assertFailure(await session.call('addManual', payload, { requestId }), 'capability_missing');
  }
  assert.equal(session.storage.state.global, null);
  assert.equal(session.storage.state.saves, 0);
  assert.deepEqual((await session.call('bootstrap', {})).data.tasks, []);
});

test('every non-terminal historical row shows why it is not running (C02)', async () => {
  const session = await historicalSession([
    seedTask({ id: 'queued-1' }),
    seedTask({ id: 'paused-1', status: 'paused' }),
    seedTask({ id: 'waiting-1', status: 'waiting_quota' }),
    seedTask({ id: 'cancelled-1', status: 'cancelled' }),
  ]);
  const originalTasks = structuredClone(session.storage.state.global.tasks);
  const initial = (await session.call('bootstrap', {})).data;
  const byId = new Map(initial.tasks.map(task => [task.id, task]));
  assert.equal(byId.get('queued-1').reason, 'execution_capability_missing');
  assert.equal(byId.get('paused-1').reason, 'task_paused_by_operator');
  assert.equal(byId.get('waiting-1').reason, 'waiting_for_quota_recheck');
  assert.equal(byId.get('cancelled-1').reason, undefined);
  const paused = await session.call('pauseDispatch', { paused: true });
  assert.equal(paused.data.paused, true);
  assert.equal(paused.data.tasks.find(task => task.id === 'queued-1').reason, 'dispatch_paused');
  const resumed = await session.call('pauseDispatch', { paused: false });
  assert.equal(resumed.data.tasks.find(task => task.id === 'queued-1').reason, 'execution_capability_missing');
  assert.deepEqual(session.storage.state.global.tasks, originalTasks);
});

test('a persisted old requestId cannot reactivate or replace its historical task', async () => {
  const task = seedTask({ id: 'old-manual', dedupeKey: 'manual::fixed', prompt: 'original' });
  const session = await historicalSession([task], { config: { storageBackend: 'json', routes: [ROUTE, ROUTE_B] } });
  const before = structuredClone(session.storage.state.global);
  for (const payload of [ADD, { ...ADD, prompt: 'changed' }, { ...ADD, routeId: ROUTE_B.id }]) {
    assertFailure(await session.call('addManual', payload, { requestId: 'fixed' }), 'capability_missing');
  }
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('an explicit autoExecute authorization is refused while execution is disabled', async () => {
  const session = await createSession();
  assertFailure(await session.call('addManual', { ...ADD, autoExecute: true }), 'capability_missing');
  assert.equal(session.storage.state.saves, 0);
});

test('retired additions stay disabled for unknown or unconfigured routes and workspaces', async () => {
  const session = await createSession();
  for (const payload of [{ ...ADD, routeId: 'nope' }, { ...ADD, workspaceId: 'nope' }]) {
    assertFailure(await session.call('addManual', payload), 'capability_missing');
  }
  const unconfigured = await createSession({ config: { storageBackend: 'json', routes: [] } });
  assertFailure(await unconfigured.call('addManual', ADD), 'capability_missing');
  const view = (await unconfigured.call('bootstrap', {})).data;
  assert.deepEqual(view.routes, []);
  assert.ok(view.configuration.reasons.includes('no_fixed_route_configured'));
  assert.equal(view.configuration.ready, false);
  assert.equal(session.storage.state.saves + unconfigured.storage.state.saves, 0);
});

test('a missing workspace registry reports configuration reasons and never permits additions', async () => {
  const session = await createSession({ services: { workspaceRegistry: undefined } });
  const view = (await session.call('bootstrap', {})).data;
  assert.deepEqual(view.workspaces, []);
  assert.ok(view.configuration.reasons.includes('workspace_registry_unavailable'));
  assertFailure(await session.call('addManual', ADD), 'capability_missing');
  assert.equal(session.storage.state.saves, 0);
});

test('the View reports the compiled runtime version, and nothing can override it', async () => {
  const { PLUGIN_VERSION } = await import('../../host/constants.js');
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(PLUGIN_VERSION, manifest.version);
  const session = await createSession();
  assert.equal((await session.call('bootstrap', {})).data.runtimeVersion, PLUGIN_VERSION);
  const hostile = await createSession({ config: { storageBackend: 'json', routes: [ROUTE], runtimeVersion: '9.9.9' } });
  assert.equal((await hostile.call('bootstrap', {})).data.runtimeVersion, PLUGIN_VERSION);
  for (const op of ['bootstrap', 'addManual', 'editPending', 'cancelQueued', 'pauseDispatch', 'setSessionOptIn', 'checkQuota', 'requestStop']) {
    assertFailure(await session.call(op, { runtimeVersion: '9.9.9' }), 'invalid_request');
  }
  assert.equal((await session.call('bootstrap', {})).data.runtimeVersion, PLUGIN_VERSION);
});

test('a late registry is observed dynamically without restoring retired mutation capabilities', async () => {
  const session = await historicalSession([seedTask()], { services: { workspaceRegistry: undefined } });
  const before = structuredClone(session.storage.state.global);
  assert.ok((await session.call('bootstrap', {})).data.configuration.reasons.includes('workspace_registry_unavailable'));
  assertFailure(await session.call('addManual', ADD), 'capability_missing');
  session.setService('workspaceRegistry', createFakeWorkspaceRegistry([workspaceRecord(WORKSPACE, 'E:/ws/one', 'one')]));
  const after = (await session.call('bootstrap', {})).data;
  assert.deepEqual(after.workspaces.map(workspace => workspace.id), [WORKSPACE]);
  assert.equal(after.workspaces[0].available, true);
  assert.equal(after.configuration.reasons.includes('workspace_registry_unavailable'), false);
  assertFailure(await session.call('addManual', ADD), 'capability_missing');
  session.setService('workspaceRegistry', undefined);
  const removed = (await session.call('bootstrap', {})).data;
  assert.deepEqual(removed.workspaces, []);
  assert.ok(removed.configuration.reasons.includes('workspace_registry_unavailable'));
  assertFailure(await session.call('editPending', { id: 'task-seed', title: 'must not edit' }), 'capability_missing');
  session.setService('workspaceRegistry', createFakeWorkspaceRegistry([workspaceRecord('ws-9', 'E:/ws/nine', 'nine')]));
  const replaced = (await session.call('bootstrap', {})).data;
  assert.deepEqual(replaced.workspaces.map(workspace => workspace.id), ['ws-9']);
  assert.equal(replaced.configuration.reasons.includes('workspace_registry_unavailable'), false);
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('retired editPending rejects title, prompt and route edits including identical retries', async () => {
  const session = await historicalSession([seedTask({ id: 'edit-1', title: 'before', prompt: 'before' })]);
  const before = structuredClone(session.storage.state.global);
  for (const payload of [
    { id: 'edit-1', title: 'after', prompt: 'after text' },
    { id: 'edit-1', title: 'after', prompt: 'after text' },
    { id: 'edit-1', routeId: ROUTE_B.id },
    { id: 'edit-1', routeId: 'nope' },
  ]) assertFailure(await session.call('editPending', payload), 'capability_missing');
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('editPending rejects resume tasks, attempted, dispatched and missing identities uniformly', async () => {
  const session = await historicalSession([
    seedTask({ id: 'resume-1', kind: 'resume-session', sessionId: 'session-1' }),
    seedTask({ id: 'attempted-1', attempts: 2 }),
    seedTask({ id: 'dispatched-1', dispatchedAt: '2024-01-01T00:00:00.000Z', dispatchedMessageId: 'm-1' }),
  ]);
  const before = structuredClone(session.storage.state.global);
  for (const id of ['resume-1', 'attempted-1', 'dispatched-1', 'nope']) {
    assertFailure(await session.call('editPending', { id, prompt: 'x' }), 'capability_missing');
  }
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('retired edits cannot erase old prompts and malformed envelopes still fail validation', async () => {
  const session = await historicalSession();
  const before = structuredClone(session.storage.state.global);
  assertFailure(await session.call('editPending', { id: 'task-seed', prompt: '   ' }), 'capability_missing');
  assertFailure(await session.call('editPending', { id: 'task-seed', prompt: 'x', actor: 'operator' }), 'invalid_request');
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('cancelQueued cannot mutate queued, running, cancelled or missing legacy entries', async () => {
  const session = await historicalSession([
    seedTask({ id: 'queued-1' }), seedTask({ id: 'running-1', status: 'running' }),
    seedTask({ id: 'cancelled-1', status: 'cancelled' }),
  ]);
  const before = structuredClone(session.storage.state.global);
  for (const id of ['queued-1', 'queued-1', 'running-1', 'cancelled-1', 'nope']) {
    assertFailure(await session.call('cancelQueued', { id }), 'not_cancellable');
  }
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('pauseDispatch persists an absolute value and stops no execution', async () => {
  const session = await historicalSession();
  const tasks = structuredClone(session.storage.state.global.tasks);
  const paused = await session.call('pauseDispatch', { paused: true });
  assert.equal(paused.ok, true);
  assert.equal(paused.data.paused, true);
  const pausedAgain = await session.call('pauseDispatch', { paused: true });
  assert.equal(pausedAgain.data.revision, paused.data.revision);
  const resumed = await session.call('pauseDispatch', { paused: false });
  assert.equal(resumed.data.paused, false);
  assert.equal(session.storage.state.global.dispatchPaused, false);
  assert.equal(session.storage.state.global.dispatchPausedReason, null);
  assert.deepEqual(session.storage.state.global.tasks, tasks);
});

test('setSessionOptIn refuses to enable and persists only the disabled state', async () => {
  const session = await createSession();
  assertFailure(await session.call('setSessionOptIn', { sessionId: 's-1', enabled: true }), 'capability_missing');
  assert.equal(session.storage.state.saves, 0);
  const disabled = await session.call('setSessionOptIn', { sessionId: 's-1', enabled: false });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.data.sessionOptIns['s-1'], false);
  const again = await session.call('setSessionOptIn', { sessionId: 's-1', enabled: false });
  assert.equal(again.data.revision, disabled.data.revision);
  assert.equal(session.storage.state.global.sessionOptIns['s-1'], false);
});

test('checkQuota reports configuration_incomplete without any network call', async () => {
  const transport = { calls: 0, async fetch() { transport.calls += 1; return { status: 200 }; } };
  const session = await createSession({ transport });
  assertFailure(await session.call('checkQuota', {}), 'configuration_incomplete');
  assert.equal(transport.calls, 0);
  assert.equal(session.quotaBridge.transport, transport);
});

test('requestStop reports a miss for unknown ids and capability_missing for historical ones', async () => {
  const session = await historicalSession();
  const before = structuredClone(session.storage.state.global);
  assertFailure(await session.call('requestStop', { id: 'nope' }), 'not_found');
  assertFailure(await session.call('requestStop', { id: 'task-seed' }), 'capability_missing');
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('every retired operation returns a fixed safe summary without echoing payload text', async () => {
  const session = await historicalSession();
  const secretShapedText = 'do not echo private diagnostic detail';
  for (const [op, payload, code] of [
    ['addManual', { ...ADD, prompt: secretShapedText }, 'capability_missing'],
    ['editPending', { id: 'task-seed', prompt: secretShapedText }, 'capability_missing'],
    ['cancelQueued', { id: secretShapedText }, 'not_cancellable'],
  ]) {
    const result = await session.call(op, payload);
    assertFailure(result, code);
    assert.equal(JSON.stringify(result).includes(secretShapedText), false);
    assert.equal(JSON.stringify(result).includes('at '), false);
  }
});

test('legacy task projections omit original prompt while persisted history stays intact', async () => {
  const task = seedTask({ title: 'historical task title', prompt: 'historical private body' });
  const session = await historicalSession([task]);
  const before = structuredClone(session.storage.state.global);
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.tasks.length, 1);
  assert.equal(Object.hasOwn(view.tasks[0], 'prompt'), false);
  assert.equal(JSON.stringify(view).includes('historical private body'), false);
  assertNoSensitiveKeys(view);
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});

test('concurrent retired mutation requests cannot alter history or allocate fresh task identities', async () => {
  const session = await historicalSession();
  const before = structuredClone(session.storage.state.global);
  const results = await Promise.all([
    session.call('addManual', ADD),
    session.call('editPending', { id: 'task-seed', title: 'racing edit' }),
    session.call('cancelQueued', { id: 'task-seed' }),
  ]);
  results.forEach((result, index) => assertFailure(result, index === 2 ? 'not_cancellable' : 'capability_missing'));
  assert.deepEqual(session.storage.state.global, before);
  assert.equal(session.storage.state.saves, 0);
});
