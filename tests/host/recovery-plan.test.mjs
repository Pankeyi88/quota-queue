/**
 * Editable existing-task ordering plan over its own storage unit.
 *
 * This surface can save and reorder inert plan entries and nothing else:
 * capabilities stay false, every item keeps authorization disabled and an
 * unbound quota scope, and adding an entry never creates/prompts a session.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROUTE,
  createFakeSessionController,
  createFakeStorage,
  createSession,
  inspectionFor,
  seededSnapshot,
  seedTask,
} from './harness.mjs';

const PLAN_UNIT = 'quota_recovery_plan_v1';
const COMPLETED = 'completed';

function controllerFor(overrides = {}) {
  return createFakeSessionController({
    sessions: {
      's-a': inspectionFor('s-a'),
      's-b': inspectionFor('s-b'),
      's-done': inspectionFor('s-done', { endKind: COMPLETED }),
      's-elsewhere': inspectionFor('s-elsewhere', { path: 'E:/not-registered' }),
      ...overrides,
    },
  });
}

async function planSession(options = {}) {
  const storage = options.storage ?? createFakeStorage();
  const controller = options.controller ?? controllerFor();
  const session = await createSession({
    storage,
    ...(options.sessionOptions ?? {}),
    services: { sessionController: controller, ...(options.services ?? {}) },
  });
  return { session, storage, controller };
}

const add = (sessionId, expectedRevision, batch = 0, requestId = `add-${sessionId}-${expectedRevision}`) => [
  'planAdd', { sessionId, batch, expectedRevision }, { requestId },
];

test('P05 rehearsal: legacy 0.1.1 history and a pre-existing plan stay isolated across reload', async () => {
  const history = seededSnapshot([
    seedTask({ id: 'old-queued', dedupeKey: 'manual::old-1' }),
    seedTask({ id: 'old-running', status: 'running', attempts: 1 }),
    seedTask({ id: 'old-resume', kind: 'resume-session', status: 'waiting_quota' }),
  ], 9);
  history.sessionOptIns = { 's-a': false };
  const storage = createFakeStorage({
    initialGlobal: structuredClone(history),
    initialUnits: { [PLAN_UNIT]: seededPlan() },
  });
  const { session } = await planSession({ storage });

  const initial = (await session.call('bootstrap', {})).data;
  assert.deepEqual(initial.tasks.map((task) => task.id), ['old-queued', 'old-running', 'old-resume']);
  assert.equal(initial.revision, 9);
  assert.equal(initial.recoveryPlan.revision, 4);
  assert.equal(storage.state.saves, 0);

  // Every retired mutation is refused and nothing is written.
  for (const [op, payload, code] of [
    ['addManual', { prompt: 'new', workspaceId: 'ws-1', routeId: ROUTE.id }, 'capability_missing'],
    ['editPending', { id: 'old-queued', prompt: 'changed' }, 'capability_missing'],
    ['cancelQueued', { id: 'old-queued' }, 'not_cancellable'],
    ['setSessionOptIn', { sessionId: 's-a', enabled: true }, 'capability_missing'],
  ]) {
    const refused = await session.call(op, payload, { requestId: 'p05-' + op });
    assert.equal(refused.ok, false, op);
    assert.equal(refused.error.code, code, op);
  }
  assert.deepEqual(storage.state.global, history);
  assert.equal(storage.state.saves, 0);

  // A plan edit touches only the plan unit, leaving legacy bytes intact.
  const paused = await session.call('planPause', { paused: true, expectedRevision: 4 });
  assert.equal(paused.ok, true);
  assert.equal(paused.data.recoveryPlan.paused, true);
  assert.deepEqual(storage.state.global, history);
  assert.equal(storage.state.saves, 1);

  await session.service.dispose();
  const second = await planSession({ storage });
  const reloaded = (await second.session.call('bootstrap', {})).data;
  assert.deepEqual(reloaded.tasks.map((task) => task.id), ['old-queued', 'old-running', 'old-resume']);
  assert.equal(reloaded.revision, 9);
  assert.equal(reloaded.recoveryPlan.revision, 5);
  assert.equal(reloaded.recoveryPlan.paused, true);
  // Reported exactly as persisted: the pre-seeded plan carried enabled items,
  // so the View must not pretend otherwise.
  assert.deepEqual(reloaded.recoveryPlan.items.map((item) => item.authorizationEnabled), [true, false, true, true]);
  assert.deepEqual(reloaded.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.deepEqual(storage.state.global, history);
  await second.session.service.dispose();
});

test('scenario: build a parallel batch, configure, pause, skip and reload', async () => {
  const { session, storage } = await planSession({
    controller: controllerFor({ 's-c': inspectionFor('s-c') }),
  });
  const ids = {};
  let plan = (await session.call(...add('s-a', 0))).data.recoveryPlan;
  plan = (await session.call(...add('s-b', plan.revision, 1))).data.recoveryPlan;
  const third = await session.call(...add('s-c', plan.revision, 2));
  assert.equal(third.ok, true, JSON.stringify(third));
  plan = third.data.recoveryPlan;
  for (const item of plan.items) ids[item.sessionId] = item.id;
  assert.deepEqual(plan.batches, [[ids['s-a']], [ids['s-b']], [ids['s-c']]]);

  const moved = await session.call('planMove', {
    id: ids['s-b'], batch: 0, position: 1, expectedRevision: plan.revision,
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.data.recoveryPlan.batches, [[ids['s-a'], ids['s-b']], [ids['s-c']]]);

  const configured = await session.call('planConfigure', { maxConcurrent: 2, expectedRevision: moved.data.recoveryPlan.revision });
  assert.equal(configured.data.recoveryPlan.maxConcurrent, 2);
  const paused = await session.call('planPause', { paused: true, expectedRevision: configured.data.recoveryPlan.revision });
  const itemPaused = await session.call('planItemPause', {
    id: ids['s-a'], paused: true, expectedRevision: paused.data.recoveryPlan.revision,
  });
  const skipped = await session.call('planSkip', {
    id: ids['s-b'], confirmed: true, expectedRevision: itemPaused.data.recoveryPlan.revision,
  });
  assert.equal(skipped.ok, true);
  const beforeReload = skipped.data.recoveryPlan;
  assert.equal(beforeReload.revision, 8);

  await session.service.dispose();
  const second = await planSession({ storage });
  const view = (await second.session.call('bootstrap', {})).data;
  const reloaded = view.recoveryPlan;
  assert.equal(reloaded.revision, beforeReload.revision);
  assert.equal(reloaded.maxConcurrent, 2);
  assert.equal(reloaded.paused, true);
  assert.deepEqual(reloaded.batches, [[ids['s-a'], ids['s-b']], [ids['s-c']]]);
  const byId = new Map(reloaded.items.map((item) => [item.id, item]));
  assert.equal(byId.get(ids['s-a']).paused, true);
  assert.equal(byId.get(ids['s-b']).skipped, true);
  assert.equal(reloaded.items.every((item) => item.authorizationEnabled === false), true);
  assert.deepEqual(view.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  assert.equal(storage.state.global, null, 'legacy unit untouched');
  await second.session.service.dispose();
});

test('plan operations are idempotent absolute target states', async () => {
  const { session, storage } = await planSession();
  let plan = (await session.call(...add('s-a', 0))).data.recoveryPlan;
  plan = (await session.call(...add('s-b', plan.revision, 1))).data.recoveryPlan;
  const [a, b] = [plan.items[0].id, plan.items[1].id];
  plan = (await session.call('planConfigure', { maxConcurrent: 2, expectedRevision: plan.revision })).data.recoveryPlan;
  const savesAfterConfigure = storage.state.saves;
  // Identical retries (even with the older revision) are no-op successes.
  for (const [op, payload] of [
    ['planConfigure', { maxConcurrent: 2, expectedRevision: plan.revision - 1 }],
    ['planPause', { paused: false, expectedRevision: plan.revision - 1 }],
    ['planItemPause', { id: a, paused: false, expectedRevision: plan.revision - 1 }],
    ['planMove', { id: a, batch: 0, position: 0, expectedRevision: plan.revision - 1 }],
  ]) {
    const retried = await session.call(op, payload);
    assert.equal(retried.ok, true, `${op} ${JSON.stringify(retried)}`);
    assert.equal(retried.data.recoveryPlan.revision, plan.revision, op);
  }
  assert.equal(storage.state.saves, savesAfterConfigure);

  plan = (await session.call('planItemPause', { id: a, paused: true, expectedRevision: plan.revision })).data.recoveryPlan;
  const pausedAgain = await session.call('planItemPause', { id: a, paused: true, expectedRevision: plan.revision - 1 });
  assert.equal(pausedAgain.ok, true);
  plan = (await session.call('planRemove', { id: b, expectedRevision: plan.revision })).data.recoveryPlan;
  // Removal with no execution history is a REAL exit: the entry is gone, so a
  // retry of that exact id is a fixed invalid request, not a silent no-op.
  assert.equal(plan.items.some((item) => item.id === b), false);
  const removedAgain = await session.call('planRemove', { id: b, expectedRevision: plan.revision - 1 });
  assert.equal(removedAgain.ok, false);
  assert.equal(removedAgain.error.code, 'invalid_request');
  plan = (await session.call('planSkip', { id: a, confirmed: true, expectedRevision: plan.revision })).data.recoveryPlan;
  const skippedAgain = await session.call('planSkip', { id: a, confirmed: true, expectedRevision: plan.revision - 1 });
  assert.equal(skippedAgain.ok, true);
  assert.equal(skippedAgain.data.recoveryPlan.revision, plan.revision);

  // A DIFFERENT target with a stale revision is a real conflict, not a no-op.
  const changed = await session.call('planConfigure', { maxConcurrent: 3, expectedRevision: 0 });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'revision_conflict');
  // Unknown item ids are a fixed invalid request.
  const missing = await session.call('planItemPause', { id: 'plan-missing', paused: true, expectedRevision: plan.revision });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'invalid_request');
});

test('a lost write acknowledgement is never published but is reconciled on reload', async () => {
  const storage = createFakeStorage({ failSaveAfterWrite: true });
  const first = await planSession({ storage });
  const failed = await first.session.call('planConfigure', { maxConcurrent: 3, expectedRevision: 0 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'persistence_failed');
  const locked = (await first.session.call('bootstrap', {})).data.recoveryPlan;
  assert.equal(locked.revision, 0, 'nothing is published before the caller is told success');
  assert.equal(locked.maxConcurrent, 1);
  assert.equal(locked.editable, false);
  await first.session.service.dispose();

  // The write was durable; a restart sees the committed candidate instead of
  // silently discarding or duplicating it.
  const second = await planSession({ storage });
  const reloaded = (await second.session.call('bootstrap', {})).data.recoveryPlan;
  assert.equal(reloaded.revision, 1);
  assert.equal(reloaded.maxConcurrent, 3);
  assert.equal(reloaded.editable, true);
  await second.session.service.dispose();
});

test('a fresh plugin exposes an editable empty plan and saves nothing', async () => {
  const { session, storage } = await planSession();
  const view = (await session.call('bootstrap', {})).data;
  assert.deepEqual(view.recoveryPlan, {
    available: true, editable: true, reason: null,
    revision: 0, maxConcurrent: 1, paused: false, batches: [], items: [],
  });
  assert.equal(storage.state.saves, 0);
  assert.equal(storage.state.units.has(PLAN_UNIT), false);
  assert.deepEqual(view.capabilities, { quotaCheck: false, execution: false, autoResume: false });
});

test('planAdd inspects the selected task, saves an inert entry and never touches legacy data', async () => {
  const { session, storage, controller } = await planSession();
  const result = await session.call(...add('s-a', 0));
  assert.equal(result.ok, true, JSON.stringify(result));
  const plan = result.data.recoveryPlan;
  assert.equal(plan.revision, 1);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.items.length, 1);
  const item = plan.items[0];
  assert.match(item.id, /^plan-[0-9a-f]{32}$/);
  assert.equal(item.sessionId, 's-a');
  assert.equal(item.workspacePath, 'E:/ws/one');
  assert.equal(item.status, 'ready');
  assert.equal(item.batchIndex, 0);
  assert.equal(item.authorizationEnabled, false);
  assert.equal(item.executionHeld, false);
  assert.equal(item.reason, 'execution_capability_missing');
  // No task body/generation/credential crosses the wire.
  assert.equal(JSON.stringify(result.data).includes('root-s-a'), false);
  assert.equal(JSON.stringify(result.data).includes('generation'), false);
  assert.equal(JSON.stringify(result.data).includes('common-codex-ref'), false);
  assert.equal(controller.calls.inspect, 1);
  // Legacy unit untouched; plan unit holds the inert record.
  assert.equal(storage.state.global, null);
  const persisted = storage.state.units.get(PLAN_UNIT);
  assert.equal(persisted.items[0].ref.quotaScopeId, null);
  assert.deepEqual(persisted.items[0].authorization, {
    sessionId: 's-a', generation: persisted.items[0].ref.generation, enabled: false,
  });
  assert.equal(persisted.items[0].attempts, 0);
  assert.equal(persisted.items[0].fence, null);
});

test('planAdd rejects unverified, completed, foreign and duplicate targets without executing', async () => {
  const { session, storage, controller } = await planSession();
  const noController = await createSession({ storage: createFakeStorage(), services: { sessionController: undefined } });
  const missing = await noController.call(...add('s-a', 0));
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'capability_missing');

  const completed = await session.call(...add('s-done', 0));
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, 'task_not_recoverable');
  assert.equal(completed.error.message, 'The selected task is not a recoverable execution scope.');

  const foreign = await session.call(...add('s-elsewhere', 0));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'workspace_unavailable');

  const unknown = await session.call(...add('s-unknown', 0));
  assert.equal(unknown.ok, false);
  // Not listed by the Host at all: still a selection/capability refusal.
  assert.equal(unknown.error.code, 'capability_missing');

  const first = await session.call(...add('s-a', 0));
  assert.equal(first.ok, true);
  // Same target batch: idempotent success (a lost response may be retried).
  const duplicate = await session.call(...add('s-a', 1));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.data.recoveryPlan.revision, first.data.recoveryPlan.revision);
  // A different batch target is a real conflict, never a silent relocation.
  const differentBatch = await session.call(...add('s-a', 1, 1));
  assert.equal(differentBatch.ok, false);
  assert.equal(differentBatch.error.code, 'plan_conflict');
  // Removal really exits: the entry is deleted, so the SAME session can be
  // queued again right away (no orphaned identity blocking the way back).
  const removed = await session.call('planRemove', { id: first.data.recoveryPlan.items[0].id, expectedRevision: first.data.recoveryPlan.revision });
  assert.equal(removed.ok, true);
  assert.equal(removed.data.recoveryPlan.items.length, 0);
  assert.deepEqual(removed.data.recoveryPlan.batches, []);
  const readd = await session.call(...add('s-a', removed.data.recoveryPlan.revision));
  assert.equal(readd.ok, true, JSON.stringify(readd));
  assert.equal(readd.data.recoveryPlan.items.length, 1);
  assert.equal(readd.data.recoveryPlan.items[0].authorizationEnabled, false);
  const stale = await session.call(...add('s-b', 0));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'revision_conflict');
  // Only the two accepted identity inspections ran; nothing was activated.
  assert.equal(controller.calls.create, 0);
  assert.equal(controller.calls.resolveAgent, 0);
  assert.equal(controller.calls.prompt, 0);
  assert.equal(storage.state.global, null);
  assert.equal(storage.state.units.get(PLAN_UNIT).items.length, 1);
});

/**
 * Append synthetic-only turns after the human-rooted one (Goal rounds,
 * auto-continue deliveries). Each entry is that turn's end kind, or 'open' for
 * a turn that has not ended. Seq numbering stays contiguous for the inspector.
 */
function withLaterTurns(inspection, endKinds) {
  const nextTurn = () => inspection.events.filter((event) => event.type === 'turn/start').length + 1;
  for (const endKind of endKinds) {
    const turn = nextTurn();
    const seq = inspection.events.length;
    inspection.events.push({ seq, type: 'turn/start', data: { turn } });
    if (endKind !== 'open') {
      inspection.events.push({ seq: seq + 1, type: 'turn/end', data: { turn, reason: { kind: endKind } } });
    }
  }
  return inspection;
}

test('a quota-exhausted session that outlived its prompt turn can still be queued', async () => {
  // The real shape: the human prompt's turn completed, then Goal/continuation
  // turns ran, and the NEWEST turn stopped on a quota error. Judging "already
  // completed" from the root turn (the old behaviour) refused exactly the
  // sessions this queue exists for.
  const controller = controllerFor({
    's-quota': withLaterTurns(inspectionFor('s-quota', { endKind: COMPLETED }), ['completed', 'error']),
    's-interrupted': withLaterTurns(inspectionFor('s-interrupted', { endKind: COMPLETED }), ['open']),
    's-finished': withLaterTurns(inspectionFor('s-finished', { endKind: COMPLETED }), ['completed']),
  });
  const { session, storage, controller: fake } = await planSession({ controller });

  const quota = await session.call(...add('s-quota', 0));
  assert.equal(quota.ok, true, JSON.stringify(quota));
  assert.equal(quota.data.recoveryPlan.items[0].sessionId, 's-quota');

  // A turn that never ended is a stopped/interrupted scope, not a finished one.
  const interrupted = await session.call(...add('s-interrupted', quota.data.recoveryPlan.revision, 1));
  assert.equal(interrupted.ok, true, JSON.stringify(interrupted));

  // A newest turn that did complete successfully is a finished task.
  const finished = await session.call(...add('s-finished', interrupted.data.recoveryPlan.revision));
  assert.equal(finished.ok, false);
  assert.equal(finished.error.code, 'task_not_recoverable');
  assert.equal(finished.error.message, 'The selected task is not a recoverable execution scope.');

  // Adding remains inert: no session was created, activated or prompted.
  assert.equal(fake.calls.create, 0);
  assert.equal(fake.calls.resolveAgent, 0);
  assert.equal(fake.calls.prompt, 0);
  assert.equal(storage.state.global, null);
  assert.equal(storage.state.units.get(PLAN_UNIT).items.length, 2);
  assert.equal(quota.data.capabilities.execution, false);
});

test('a legacy tombstone for the same session is restored in place, not duplicated', async () => {
  // An earlier build kept removed entries as tombstones. The switch now has to
  // be able to queue that session again: planAdd restores the SAME record and
  // refreshes its identity, with the authorization left disabled.
  const legacy = {
    schemaVersion: 1, revision: 3, maxConcurrent: 1, paused: false,
    batches: [['plan-legacy']],
    items: [{
      id: 'plan-legacy',
      ref: { taskId: 'task-legacy', sessionId: 's-a', generation: 'legacy-generation', workspaceId: 'ws-1', quotaScopeId: 'scope-x' },
      authorization: { sessionId: 's-a', generation: 'legacy-generation', enabled: false },
      status: 'ready', paused: false, removed: true, skip: null, result: null, attempts: 0, fence: null,
    }],
    usedClaimIds: [], usedMessageIds: [],
  };
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: legacy } });
  const { session } = await planSession({ storage });
  const restored = await session.call(...add('s-a', legacy.revision));
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const plan = restored.data.recoveryPlan;
  assert.equal(plan.items.length, 1, 'one row per session, not a second copy');
  assert.equal(plan.items[0].id, 'plan-legacy');
  assert.equal(plan.items[0].removed, false);
  assert.equal(plan.items[0].authorizationEnabled, false, 'restoring is not authorizing');
  const persisted = storage.state.units.get(PLAN_UNIT);
  assert.equal(persisted.items[0].id, 'plan-legacy');
  assert.notEqual(persisted.items[0].ref.generation, 'legacy-generation');
  assert.equal(persisted.items[0].ref.sessionId, 's-a');
  assert.equal(persisted.items[0].removed, false);
});

function seededPlan() {
  const item = (id, overrides = {}) => ({
    id,
    ref: { taskId: `t-${id}`, sessionId: `s-${id}`, generation: `g-${id}`, workspaceId: `ws-${id}`, quotaScopeId: 'scope-x' },
    authorization: { sessionId: `s-${id}`, generation: `g-${id}`, enabled: true },
    status: 'ready', paused: false, removed: false, skip: null, result: null, attempts: 0, fence: null,
    ...overrides,
  });
  const succeeded = item('a', {
    status: 'succeeded', result: 'completed', attempts: 1,
  });
  const readyUnbound = item('b', {
    ref: { taskId: 't-b', sessionId: 's-b', generation: 'g-b', workspaceId: 'ws-b', quotaScopeId: null },
    authorization: { sessionId: 's-b', generation: 'g-b', enabled: false },
  });
  const readyLater = item('c');
  const held = item('d', {
    status: 'needs_attention', attempts: 1, result: null,
    fence: { claimId: 'claim-d', sessionId: 's-d', generation: 'g-d', workspaceId: 'ws-d', messageId: 'message-d', turnId: 'turn-d' },
  });
  return {
    schemaVersion: 1, revision: 4, maxConcurrent: 1, paused: false,
    batches: [['a'], ['b'], ['d'], ['c']],
    items: [succeeded, readyUnbound, readyLater, held],
    usedClaimIds: ['claim-a', 'claim-d'],
    usedMessageIds: ['message-a', 'message-d'],
  };
}

test('the plan View reports per-item blockers without granting authority', async () => {
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededPlan() } });
  const { session } = await planSession({ storage });
  const result = await session.call('bootstrap', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const plan = result.data.recoveryPlan;
  assert.equal(plan.available, true);
  assert.equal(plan.revision, 4);
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const blockers = (id) => byId.get(id).blockers;
  // A terminal item needs no reason to start; an unknown outcome keeps its slot.
  assert.deepEqual(blockers('a'), []);
  assert.deepEqual(blockers('d'), ['execution_outcome_unknown']);
  // Ready but unauthorized and unbound: inert for three independent reasons.
  assert.deepEqual(blockers('b'), ['authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing']);
  // Authorized and bound, yet execution is off and the earlier batch is not done.
  assert.deepEqual(blockers('c'), ['execution_capability_missing', 'earlier_batch_incomplete']);
  // The projected authorization is the persisted one, and it still cannot
  // release a batch while execution is off.
  assert.deepEqual(plan.items.map((item) => item.authorizationEnabled), [true, false, true, true]);
  assert.equal(byId.get('b').quotaScopeBound, false);
  assert.equal(byId.get('c').quotaScopeBound, true);
  assert.deepEqual(result.data.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  // Rendering a seeded plan never rewrites it.
  assert.equal(storage.state.saves, 0);
});

test('a plan item whose session is demonstrably running reports task_running', async () => {
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededPlan() } });
  const agents = { get(sessionId) { return sessionId === 's-c' ? { status: 'running' } : { status: 'idle' }; } };
  const { session } = await planSession({ storage, services: { agents } });
  const plan = (await session.call('bootstrap', {})).data.recoveryPlan;
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('c').blockers, ['task_running', 'execution_capability_missing', 'earlier_batch_incomplete']);
  // Running evidence is attached only to the live session, never inferred.
  assert.deepEqual(byId.get('b').blockers, ['authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing']);
  assert.deepEqual(byId.get('a').blockers, []);
  assert.equal(storage.state.saves, 0);
});

test('a demonstrably running task can be queued now and is reported as running', async () => {
  // The user queues a session WHILE it runs instead of waiting for it to stop.
  // Ordering grants nothing: the item is inert, and the live registry is the
  // only thing that says it is running (it clears when the run ends).
  const running = { get(sessionId) { return sessionId === 's-a' ? { status: 'running' } : { status: 'idle' }; } };
  const first = await planSession({ services: { agents: running } });
  const added = await first.session.call(...add('s-a', 0));
  assert.equal(added.ok, true, JSON.stringify(added));
  const plan = added.data.recoveryPlan;
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.items[0].blockers, ['task_running', 'authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing']);
  assert.equal(plan.items[0].authorizationEnabled, false);
  assert.equal(added.data.capabilities.execution, false);
  assert.equal(first.controller.calls.create, 0);
  assert.equal(first.controller.calls.resolveAgent, 0);
  assert.equal(first.controller.calls.prompt, 0);

  // The same plan read once the run is over no longer holds the item back.
  running.get = (sessionId) => (sessionId === 's-a' ? { status: 'idle' } : { status: 'idle' });
  const idle = (await first.session.call('bootstrap', {})).data.recoveryPlan;
  assert.deepEqual(idle.items[0].blockers, ['authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing']);

  // Unknown registry state is not treated as running; execution stays inert.
  const unknown = await planSession({ services: { agents: { get() { throw new Error('private'); } } } });
  assert.equal((await unknown.session.call(...add('s-a', 0))).ok, true);
  const absent = await planSession();
  assert.equal((await absent.session.call(...add('s-b', 0))).ok, true);
});

test('planAdd never inspects a session the Host does not list as a candidate', async () => {
  // The session would inspect successfully, but it is not a visible
  // existing-task candidate: selection is limited to the Host's own list.
  const inspections = [];
  const hidden = {
    async list() { return { items: [] }; },
    async inspect(sessionId) { inspections.push(sessionId); return inspectionFor(sessionId); },
  };
  const { session } = await planSession({ controller: hidden });
  const result = await session.call(...add('s-a', 0));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_missing');
  assert.equal(inspections.length, 0, 'no log inspection for an unlisted session');
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.revision, 0);

  const broken = {
    async list() { throw new Error('private failure'); },
    async inspect(sessionId) { inspections.push(sessionId); return inspectionFor(sessionId); },
  };
  const second = await planSession({ storage: createFakeStorage(), controller: broken });
  const failed = await second.session.call(...add('s-a', 0));
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'capability_missing');
  assert.equal(inspections.length, 0);
  assert.equal(JSON.stringify(failed).includes('private failure'), false);
});

test('planAdd reports a missing log-read capability instead of a finished task', async () => {
  // The session is a visible candidate, but the Host does not expose the
  // read-only observation seam. That is a capability failure, not evidence the
  // task already completed; conflating them is what hid the DSH 0.2.2 removal.
  const { session } = await planSession({ services: { sessionQuery: null } });
  const result = await session.call(...add('s-a', 0));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'capability_missing');
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.revision, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('configure, pause, item pause, skip, remove and move follow exact revisions', async () => {
  const { session, storage } = await planSession();
  let plan = (await session.call(...add('s-a', 0))).data.recoveryPlan;
  plan = (await session.call(...add('s-b', plan.revision, 1))).data.recoveryPlan;
  const [a, b] = plan.items.map((item) => item.id);
  assert.deepEqual(plan.batches, [[a], [b]]);

  const configured = await session.call('planConfigure', { maxConcurrent: 2, expectedRevision: plan.revision });
  assert.equal(configured.ok, true);
  assert.equal(configured.data.recoveryPlan.maxConcurrent, 2);

  const paused = await session.call('planPause', { paused: true, expectedRevision: configured.data.recoveryPlan.revision });
  assert.equal(paused.data.recoveryPlan.paused, true);
  assert.equal(paused.data.recoveryPlan.items[0].reason, 'plan_paused');
  const resumed = await session.call('planPause', { paused: false, expectedRevision: paused.data.recoveryPlan.revision });
  assert.equal(resumed.data.recoveryPlan.paused, false);

  const itemPaused = await session.call('planItemPause', { id: a, paused: true, expectedRevision: resumed.data.recoveryPlan.revision });
  assert.equal(itemPaused.data.recoveryPlan.items[0].paused, true);
  assert.equal(itemPaused.data.recoveryPlan.items[0].reason, 'task_paused');
  const itemResumed = await session.call('planItemPause', { id: a, paused: false, expectedRevision: itemPaused.data.recoveryPlan.revision });

  const skipped = await session.call('planSkip', { id: a, confirmed: true, expectedRevision: itemResumed.data.recoveryPlan.revision });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.data.recoveryPlan.items[0].skipped, true);
  assert.equal(skipped.data.recoveryPlan.items[0].reason, 'skipped');
  const skipUnconfirmed = await session.call('planSkip', { id: b, confirmed: false, expectedRevision: skipped.data.recoveryPlan.revision });
  assert.equal(skipUnconfirmed.ok, false);
  assert.equal(skipUnconfirmed.error.code, 'invalid_request');

  // Move b ahead of a inside batch 0, dropping the now-empty second batch.
  const moved = await session.call('planMove', {
    id: b, batch: 0, position: 0, expectedRevision: skipped.data.recoveryPlan.revision,
  });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual(moved.data.recoveryPlan.batches, [[b, a]]);
  assert.equal(moved.data.recoveryPlan.items.find((item) => item.id === b).batchIndex, 0);

  const removed = await session.call('planRemove', { id: a, expectedRevision: moved.data.recoveryPlan.revision });
  assert.equal(removed.ok, true);
  // Never attempted: the entry and its batch slot are deleted, not tombstoned.
  assert.equal(removed.data.recoveryPlan.items.some((item) => item.id === a), false);
  assert.deepEqual(removed.data.recoveryPlan.batches, [[b]]);

  // Bad move targets are refused without a write.
  const saves = storage.state.saves;
  const badBatch = await session.call('planMove', { id: b, batch: 9, position: 0, expectedRevision: removed.data.recoveryPlan.revision });
  assert.equal(badBatch.ok, false);
  assert.equal(badBatch.error.code, 'invalid_request');
  const badPosition = await session.call('planMove', { id: b, batch: 0, position: 9, expectedRevision: removed.data.recoveryPlan.revision });
  assert.equal(badPosition.ok, false);
  assert.equal(storage.state.saves, saves);
  // An actual change with a stale revision is a conflict (a no-op retry is not).
  const staleConfigure = await session.call('planConfigure', { maxConcurrent: 4, expectedRevision: 0 });
  assert.equal(staleConfigure.ok, false);
  assert.equal(staleConfigure.error.code, 'revision_conflict');
  const noopMove = await session.call('planMove', { id: b, batch: 0, position: 0, expectedRevision: 0 });
  assert.equal(noopMove.ok, true);
});

test('a successful plan survives reload in its own unit with no authority added', async () => {
  const { session, storage } = await planSession();
  const added = await session.call(...add('s-a', 0));
  assert.equal(added.ok, true);
  await session.service.dispose();
  const storageAfter = storage.state;
  const second = await planSession({ storage });
  const view = (await second.session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.revision, added.data.recoveryPlan.revision);
  assert.equal(view.recoveryPlan.items.length, 1);
  assert.equal(view.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(storageAfter.global, null, 'legacy data must stay untouched across reload');
  assert.deepEqual(view.capabilities, { quotaCheck: false, execution: false, autoResume: false });
  await second.session.service.dispose();
});

test('a usable legacy queue is independent of the plan unit', async () => {
  const { session, storage } = await planSession();
  // Pause is a legacy write; it must not move the plan revision.
  const planBefore = (await session.call('bootstrap', {})).data.recoveryPlan;
  const paused = await session.call('pauseDispatch', { paused: true });
  assert.equal(paused.ok, true);
  assert.equal(paused.data.recoveryPlan.revision, planBefore.revision);
  assert.equal(storage.state.global.dispatchPaused, true);
  const plan = await session.call(...add('s-a', planBefore.revision));
  assert.equal(plan.ok, true);
  const reloaded = (await session.call('bootstrap', {})).data;
  assert.equal(reloaded.paused, true);
  assert.equal(reloaded.recoveryPlan.items.length, 1);
});

test('plan unit open failure keeps legacy access and disables only plan editing', async () => {
  const storage = createFakeStorage({ failOpenUnits: [PLAN_UNIT] });
  const { session } = await planSession({ storage });
  const view = (await session.call('bootstrap', {})).data;
  assert.deepEqual(view.recoveryPlan, {
    available: false, editable: false, reason: 'recovery_plan_unavailable',
    revision: 0, maxConcurrent: 1, paused: true, batches: [], items: [],
  });
  assert.equal(view.capabilities.execution, false);
  // Legacy pause still works; plan writes fail with a fixed code.
  assert.equal((await session.call('pauseDispatch', { paused: true })).ok, true);
  const write = await session.call('planPause', { paused: true, expectedRevision: 0 });
  assert.equal(write.ok, false);
  assert.equal(write.error.code, 'configuration_incomplete');
});

test('a plan save failure locks editing, publishes nothing and never fakes success', async () => {
  const storage = createFakeStorage({ failSaveUnits: [PLAN_UNIT] });
  const { session } = await planSession({ storage });
  const failed = await session.call('planConfigure', { maxConcurrent: 3, expectedRevision: 0 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'persistence_failed');
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.revision, 0);
  assert.equal(view.recoveryPlan.maxConcurrent, 1);
  assert.equal(view.recoveryPlan.editable, false);
  assert.equal(view.recoveryPlan.reason, 'recovery_plan_persistence_failed');
  const later = await session.call('planPause', { paused: true, expectedRevision: 0 });
  assert.equal(later.error.code, 'persistence_failed');
  assert.equal(storage.state.saves, 1);
  assert.equal(storage.state.units.has(PLAN_UNIT), false);
});

test('corrupt plan data is never replaced by a fresh plan', async () => {
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: { schemaVersion: 1, revision: 0 } } });
  const { session } = await planSession({ storage });
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.available, false);
  assert.equal(view.recoveryPlan.reason, 'recovery_plan_unavailable');
  const write = await session.call('planPause', { paused: true, expectedRevision: 0 });
  assert.equal(write.ok, false);
  assert.equal(storage.state.saves, 0);
  assert.deepEqual(storage.state.units.get(PLAN_UNIT), { schemaVersion: 1, revision: 0 });
});

test('a pending plan write drains on dispose and the units are released', async () => {
  const { session, storage } = await planSession();
  const pending = session.call(...add('s-a', 0));
  const disposal = session.service.dispose();
  const [result] = await Promise.all([pending, disposal]);
  assert.equal(result.ok, true);
  assert.equal(storage.state.activeOpens, 0);
  assert.equal(storage.state.units.get(PLAN_UNIT).items.length, 1);
  assert.equal(storage.state.global, null);
});

const FIXED_SCOPE = 'cpamc:codex:test-auth-index';
const scopedConfig = () => ({
  storageBackend: 'json',
  routes: [ROUTE],
  autoContinue: { enabled: true },
  quotaSource: {
    kind: 'cpamc', baseUrl: 'https://cpa.example.com', managementKeyEnv: 'CPAMC_MANAGEMENT_KEY',
    authIndex: 'test-auth-index', weeklyMinRemaining: 10, fiveHourMinRemaining: 0,
  },
});
function seededOptedInPlan(paused = false, quotaScopeId = FIXED_SCOPE) {
  const item = {
    id: 'plan-s-a',
    ref: { taskId: 't-a', sessionId: 's-a', generation: 'g-a', workspaceId: 'ws-1', quotaScopeId },
    authorization: { sessionId: 's-a', generation: 'g-a', enabled: false },
    status: 'ready', paused: false, removed: false, skip: null, result: null, attempts: 0, fence: null,
  };
  return {
    schemaVersion: 1, revision: 1, maxConcurrent: 1, paused,
    batches: [['plan-s-a']], items: [item], usedClaimIds: [], usedMessageIds: [],
  };
}

test('planAuthorize is the single entry point: plan item and session opt-in move together', async () => {
  // The deployment's real quota source binding (fixed auth index -> one scope).
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan() } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const before = (await session.call('bootstrap', {})).data;
  assert.equal(before.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(before.sessionOptIns['s-a'], undefined);
  const savesBefore = storage.state.saves;

  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.data.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(on.data.sessionOptIns['s-a'], true);
  assert.equal(storage.state.saves, savesBefore + 2, 'plan unit and queue unit both written');
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);
  // Still inert: authorization never releases a batch while execution is off.
  assert.equal(on.data.capabilities.execution, false);
  assert.equal(on.data.capabilities.autoResume, false);
  assert.ok(on.data.recoveryPlan.items[0].blockers.includes('execution_capability_missing'));

  const savesAfterOn = storage.state.saves;
  const retry = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(retry.ok, true);
  assert.equal(storage.state.saves, savesAfterOn);

  const off = await session.call('planAuthorize', { id: 'plan-s-a', enabled: false, expectedRevision: retry.data.recoveryPlan.revision });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.data.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(off.data.sessionOptIns['s-a'], false);

  await session.service.dispose();
  const second = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const reloaded = (await second.session.call('bootstrap', {})).data;
  assert.equal(reloaded.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(reloaded.sessionOptIns['s-a'], false);
  await second.session.service.dispose();
});

test('an unbound legacy item is bound to the fixed scope before its switch is judged', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan(false, null) } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const res = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  // The bind happened first, so the switch is a REAL state change, not a no-op:
  // the item carries the deployment scope and both surfaces are enabled.
  assert.equal(res.data.recoveryPlan.items[0].quotaScopeBound, true);
  assert.equal(res.data.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(res.data.sessionOptIns['s-a'], true);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].ref.quotaScopeId, FIXED_SCOPE);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);
  await session.service.dispose();
});

test('planAuthorize refuses enabling without a mounted recovery consumer and leaves both units untouched', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan() } });
  const { session } = await planSession({ storage });
  const refused = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'capability_missing');
  assert.equal(storage.state.saves, 0);
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(view.sessionOptIns['s-a'], undefined);
  const off = await session.call('planAuthorize', { id: 'plan-s-a', enabled: false, expectedRevision: 1 });
  assert.equal(off.ok, true);
  await session.service.dispose();
});

test('planAuthorize keeps both units consistent when the second save fails', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({
    initialUnits: { [PLAN_UNIT]: seededOptedInPlan() },
    failSaveUnits: ['quota_queue_v1'],
  });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const failed = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'persistence_failed');
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, false);
  assert.equal(storage.state.global, null);
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.items[0].authorizationEnabled, false);
  await session.service.dispose();
});

test('planAuthorize refuses unknown and removed items without writing', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan() } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const unknown = await session.call('planAuthorize', { id: 'plan-missing', enabled: true, expectedRevision: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'invalid_request');
  const removed = await session.call('planRemove', { id: 'plan-s-a', expectedRevision: 1 });
  assert.equal(removed.ok, true);
  const afterRemove = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: removed.data.recoveryPlan.revision });
  assert.equal(afterRemove.ok, false);
  assert.equal(afterRemove.error.code, 'invalid_request');
  await session.service.dispose();
});

test('removing an authorized plan item also clears the session opt-in', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan() } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(on.ok, true);
  assert.equal(on.data.sessionOptIns['s-a'], true);
  const removed = await session.call('planRemove', { id: 'plan-s-a', expectedRevision: on.data.recoveryPlan.revision });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.data.sessionOptIns['s-a'], false);
  assert.equal(storage.state.global.sessionOptIns['s-a'], false);
  await session.service.dispose();
});
test('a real pre-existing plan item is bound to the deployment scope and can be authorized end to end', async () => {
  // Shape of the plan actually on disk (quota_recovery_plan_v1.json): added
  // before any scope existed, so quotaScopeId is null and the item was inert.
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan(false, null) } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const before = (await session.call('bootstrap', {})).data;
  assert.equal(before.quotaScopeId, FIXED_SCOPE, 'the Host reports its one verified scope');
  assert.equal(before.recoveryPlan.items[0].quotaScopeBound, false);
  assert.ok(before.recoveryPlan.items[0].blockers.includes('quota_scope_unbound'));
  const savesBefore = storage.state.saves;

  // Enabling: the commit first binds the fixed scope, then authorizes both
  // surfaces. Nothing here executes, claims or opens a session.
  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.data.recoveryPlan.items[0].quotaScopeBound, true);
  assert.equal(on.data.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(on.data.sessionOptIns['s-a'], true);
  assert.equal(on.data.capabilities.execution, false);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].ref.quotaScopeId, FIXED_SCOPE);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);
  assert.equal(storage.state.saves, savesBefore + 3, 'scope bind + authorize + opt-in');

  // Disabling flips both surfaces back; the scope stays bound.
  const off = await session.call('planAuthorize', { id: 'plan-s-a', enabled: false, expectedRevision: on.data.recoveryPlan.revision });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.data.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(off.data.recoveryPlan.items[0].quotaScopeBound, true);
  assert.equal(off.data.sessionOptIns['s-a'], false);

  // Reload: the binding and both authorization facts survive a restart.
  await session.service.dispose();
  const second = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const reloaded = (await second.session.call('bootstrap', {})).data;
  assert.equal(reloaded.recoveryPlan.items[0].quotaScopeBound, true);
  assert.equal(reloaded.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(reloaded.sessionOptIns['s-a'], false);
  await second.session.service.dispose();
});

test('without a verified quota source the Host reports no scope and refuses enabling loudly', async () => {
  const previous = process.env.CPAMC_MANAGEMENT_KEY;
  delete process.env.CPAMC_MANAGEMENT_KEY;
  const storage = createFakeStorage({ initialUnits: { [PLAN_UNIT]: seededOptedInPlan(false, null) } });
  const { session } = await planSession({ storage, sessionOptions: { config: scopedConfig() } });
  const before = (await session.call('bootstrap', {})).data;
  assert.equal(before.quotaScopeId, null);
  const savesBefore = storage.state.saves;
  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: 1 });
  assert.equal(on.ok, false);
  assert.equal(on.error.code, 'capability_missing');
  assert.equal(storage.state.saves, savesBefore, 'a refused switch changes nothing');
  const after = (await session.call('bootstrap', {})).data;
  assert.equal(after.recoveryPlan.items[0].authorizationEnabled, false);
  assert.notEqual(after.sessionOptIns['s-a'], true);
  await session.service.dispose();
  if (previous !== undefined) process.env.CPAMC_MANAGEMENT_KEY = previous;
});
