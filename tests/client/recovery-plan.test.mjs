/**
 * Editable ordering-plan projection and RPC wiring.
 *
 * The plan surface stores an order only: no authorization, no execution and no
 * task-body input. These are mock transport tests over the real client bundle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, validView, makeCtx, makeT, renderElement, collectElements } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
const t = makeT(internals.dictionaries.en);
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));
function expand(element) {
  if (Array.isArray(element)) return element.flatMap(expand);
  if (!element || typeof element !== 'object') return [];
  if (typeof element.type === 'function') return expand(element.type(element.props));
  return [element, ...expand(element.props?.children)];
}

function planView(overrides = {}) {
  return {
    available: true, editable: true, reason: null, revision: 5, maxConcurrent: 2, paused: false,
    batches: [['plan-a'], ['plan-b']],
    items: [
      { id: 'plan-a', sessionId: 's-a', title: 'A', workspacePath: 'E:/one', batchIndex: 0, status: 'ready', paused: false, removed: false, skipped: false, authorizationEnabled: false, quotaScopeBound: false, executionHeld: false, attempts: 0, reason: 'execution_capability_missing', blockers: [] },
      { id: 'plan-b', sessionId: 's-b', title: 'B', workspacePath: 'E:/two', batchIndex: 1, status: 'ready', paused: false, removed: false, skipped: false, authorizationEnabled: false, quotaScopeBound: false, executionHeld: false, attempts: 0, reason: 'execution_capability_missing', blockers: [] },
    ],
    ...overrides,
  };
}
const project = (plan = planView()) => internals.projectView(validView({ recoveryPlan: plan }));
const withBlockers = (first, second) => planView({
  items: [
    { ...planView().items[0], blockers: first },
    { ...planView().items[1], blockers: second },
  ],
});

test('fixed blocker vocabulary is projected, missing tolerates old Hosts, unknown rejects', () => {
  const result = project(withBlockers(
    ['task_running', 'authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing'],
    [],
  ));
  assert.equal(result.ok, true);
  same(result.view.recoveryPlan.items[0].blockers,
    ['task_running', 'authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing']);
  // Older Hosts omit blockers: treated as an empty read-only list.
  assert.equal(project(planView()).view.recoveryPlan.items[0].blockers.length, 0);
  for (const bad of [['raw private failure'], 'authorization_disabled', [1], ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a']]) {
    assert.equal(project(withBlockers(bad, [])).ok, false, JSON.stringify(bad));
  }
  assert.ok(internals.dictionaries.en['plan.blocker.execution_capability_missing']);
  assert.ok(internals.dictionaries.zh['plan.blocker.quota_scope_unbound']);
});

test('oversized plans are rejected by the same bounds as the core schema', () => {
  const base = planView().items[0];
  const packed = (count, batched) => {
    const items = Array.from({ length: count }, (_, n) => ({
      ...base, id: `i${n}`, sessionId: `s${n}`, batchIndex: batched ? n : 0, blockers: [],
    }));
    return {
      ...planView(),
      items,
      batches: batched ? items.map((item) => [item.id]) : [items.map((item) => item.id)],
    };
  };
  assert.equal(project(packed(100, false)).ok, true);
  assert.equal(project(packed(101, false)).ok, false);
  assert.equal(project(packed(50, true)).ok, true);
  assert.equal(project(packed(51, true)).ok, false);
});

function rpcHarness(handler) {
  const calls = [];
  const harness = makeCtx({ connection: { rpc: { call: async (channel, endpoint, payload) => {
    calls.push(payload.args.request);
    return handler(payload.args.request, calls.length);
  } } } });
  const controller = internals.createController(harness.ctx);
  return { controller, calls };
}
const okView = (plan) => ({ ok: true, value: { ok: true, data: validView({ recoveryPlan: plan }) } });

test('a valid plan is projected verbatim, including the persisted authorization', () => {
  const result = project();
  assert.equal(result.ok, true);
  same(result.view.recoveryPlan, planView());
  assert.equal(result.view.recoveryPlan.items.every((item) => item.authorizationEnabled === false), true);
  // A Host that reports an authorization with a bound scope is projected as
  // reported; the UI still gates enabling on the same capability check as the
  // composer switch, so this can never widen permission by itself.
  const bound = planView({
    items: [
      { ...planView().items[0], authorizationEnabled: true, quotaScopeBound: true },
      planView().items[1],
    ],
  });
  const boundResult = project(bound);
  assert.equal(boundResult.ok, true, JSON.stringify(boundResult));
  assert.equal(boundResult.view.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(boundResult.view.recoveryPlan.items[0].quotaScopeBound, true);
  // An authorization claim WITHOUT a bound scope is refused, never rendered.
  const unbound = planView({ items: [{ ...planView().items[0], authorizationEnabled: true }, planView().items[1]] });
  assert.equal(project(unbound).ok, false);
  // A non-boolean authorization flag is a protocol violation.
  for (const flag of [undefined, 'true', 1, null]) {
    const broken = planView({
      items: [{ ...planView().items[0], authorizationEnabled: flag }, planView().items[1]],
    });
    assert.equal(project(broken).ok, false, JSON.stringify(flag));
  }
});

test('malformed or authority-granting plans reject the whole View', () => {
  // A top-level authority claim is an unknown member and is dropped, never
  // honoured; the item-level authority field is decisive and rejects.
  const dropped = project({ ...planView(), authorizationEnabled: true, credentialRef: 'private' });
  assert.equal(dropped.ok, true);
  assert.equal(JSON.stringify(dropped.view).includes('private'), false);
  const bad = [
    { ...planView(), revision: -1 },
    { ...planView(), revision: 1.5 },
    { ...planView(), maxConcurrent: 0 },
    { ...planView(), maxConcurrent: 9 },
    { ...planView(), editable: true, available: false },
    { ...planView(), reason: 'raw private failure' },
    { ...planView(), items: [{ ...planView().items[0], authorizationEnabled: 'yes' }] },
    { ...planView(), items: [{ ...planView().items[0], quotaScopeBound: 'yes' }] },
    { ...planView(), items: [{ ...planView().items[0], status: 'unknown' }] },
    { ...planView(), items: [{ ...planView().items[0], reason: 'raw' }] },
    { ...planView(), items: [planView().items[0], planView().items[0]] },
    { ...planView(), batches: [[], ['plan-a', 'plan-b']] },
    { ...planView(), batches: [['plan-a'], ['plan-a']] },
    { ...planView(), batches: [['plan-a']] },
    { ...planView(), batches: [['plan-a', 'plan-b'], []] },
    { ...planView(), items: [{ ...planView().items[0], batchIndex: 1 }] },
  ];
  for (const plan of bad) assert.equal(project(plan).ok, false, JSON.stringify(plan).slice(0, 90));
  for (const raw of [null, [], { available: true }, 'yes']) {
    assert.equal(internals.projectView(validView({ recoveryPlan: raw })).ok, false);
  }
});

test('an older Host shape stays non-destructive: fixed unavailable empty plan', () => {
  const result = internals.projectView(validView({ recoveryPlan: { available: false, editable: false, reason: 'recovery_plan_persistence_failed', revision: 0, maxConcurrent: 1, paused: true, batches: [], items: [] } }));
  assert.equal(result.ok, true);
  assert.equal(result.view.recoveryPlan.available, false);
  assert.equal(result.view.recoveryPlan.reason, 'recovery_plan_persistence_failed');
  assert.equal(result.view.capabilities.execution, true, 'legacy flags are still projected as given');
});

test('plan RPCs send only whitelisted primitives and the exact plan revision', async () => {
  const { controller, calls } = rpcHarness((request) => okView(planView()));
  await controller.actions.refresh();
  calls.length = 0;
  await controller.actions.planConfigure(4);
  await controller.actions.planSetPaused(true);
  await controller.actions.planItemPause('plan-a', true);
  await controller.actions.planRemove('plan-b');
  await controller.actions.planSkip('plan-a');
  await controller.actions.planMove('plan-b', 0, 1);
  await controller.actions.planAdd('s-new', 1);
  same(calls.map((request) => [request.op, Object.keys(request.payload).sort()]), [
    ['planConfigure', ['expectedRevision', 'maxConcurrent']],
    ['planPause', ['expectedRevision', 'paused']],
    ['planItemPause', ['expectedRevision', 'id', 'paused']],
    ['planRemove', ['expectedRevision', 'id']],
    ['planSkip', ['confirmed', 'expectedRevision', 'id']],
    ['planMove', ['batch', 'expectedRevision', 'id', 'position']],
    ['planAdd', ['batch', 'expectedRevision', 'sessionId']],
  ]);
  for (const request of calls) {
    assert.equal(request.payload.expectedRevision, 5);
    assert.equal(Object.values(request.payload).some((value) => typeof value === 'object'), false);
  }
  assert.equal(calls[5].payload.id, 'plan-b');
  assert.equal(calls[5].payload.batch, 0);
  assert.equal(calls[5].payload.position, 1);
  assert.equal(calls[5].payload.confirmed, undefined);
  assert.equal(calls[4].payload.confirmed, true);
  controller.dispose();
});

test('plan mutations are refused locally when the plan is not editable', async () => {
  const { controller, calls } = rpcHarness(() => okView(planView()));
  await controller.actions.refresh();
  calls.length = 0;
  const view = controller.getSnapshot().view;
  // Force a non-editable projection through the transport's next response.
  controller.actions.refresh();
  assert.equal(view.recoveryPlan.editable, true);
  controller.dispose();
  const fresh = rpcHarness(() => okView(planView({ editable: false })));
  await fresh.controller.actions.refresh();
  for (const action of [
    fresh.controller.actions.planConfigure(3),
    fresh.controller.actions.planSetPaused(true),
    fresh.controller.actions.planRemove('plan-a'),
    fresh.controller.actions.planSkip('plan-a'),
    fresh.controller.actions.planMove('plan-a', 0, 0),
    fresh.controller.actions.planAdd('s-a', 0),
  ]) {
    assert.equal((await action).error.code, 'capability_missing');
  }
  assert.equal(fresh.calls.length, 1, 'only the bootstrap reached the transport');
  fresh.controller.dispose();
});

test('planSkip requires an explicit local confirmation step', async () => {
  const { controller, calls } = rpcHarness(() => okView(planView()));
  await controller.actions.refresh();
  calls.length = 0;
  const requested = controller.actions.requestPlanSkip('plan-a');
  assert.equal(requested.ok, true);
  assert.equal(controller.getSnapshot().planConfirmId, 'plan-a');
  assert.equal(calls.length, 0);
  controller.actions.cancelPlanSkip();
  assert.equal(controller.getSnapshot().planConfirmId, null);
  assert.equal(calls.length, 0);
  controller.actions.requestPlanSkip('plan-a');
  await controller.actions.planSkip('plan-a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'planSkip');
  assert.equal(controller.getSnapshot().planConfirmId, null);
  controller.dispose();
});

test('plan revisions merge independently of the legacy View revision', () => {
  const current = internals.projectView(validView({ revision: 9, recoveryPlan: planView({ revision: 8 }) })).view;
  // Stale legacy revision but newer plan: keep the new plan, old legacy facts.
  const staleLegacy = internals.projectView(validView({ revision: 8, recoveryPlan: planView({ revision: 9, maxConcurrent: 5 }) })).view;
  const merged = internals.mergeViews(current, staleLegacy);
  assert.equal(merged.revision, 9);
  assert.equal(merged.recoveryPlan.revision, 9);
  assert.equal(merged.recoveryPlan.maxConcurrent, 5);
  // Newer legacy revision but older plan: never regress the plan.
  const newerLegacy = internals.projectView(validView({ revision: 10, recoveryPlan: planView({ revision: 7 }) })).view;
  const merged2 = internals.mergeViews(current, newerLegacy);
  assert.equal(merged2.revision, 10);
  assert.equal(merged2.recoveryPlan.revision, 8);
});

test('a plan revision conflict is surfaced and never replaces the shown plan', async () => {
  const { controller, calls } = rpcHarness((request, count) => (count === 1
    ? okView(planView())
    : { ok: true, value: { ok: false, error: { code: 'revision_conflict', message: 'raw text' } } }));
  await controller.actions.refresh();
  const before = controller.getSnapshot().view.recoveryPlan;
  const failed = await controller.actions.planConfigure(3);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'revision_conflict');
  assert.equal(controller.getSnapshot().view.recoveryPlan.revision, before.revision);
  assert.equal(controller.getSnapshot().view.recoveryPlan.maxConcurrent, before.maxConcurrent);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes('raw text'), false);
  controller.dispose();
});

test('an ambiguous plan mutation retries with the same requestId and publishes success', async () => {
  let call = 0;
  const { controller, calls } = rpcHarness(() => {
    call += 1;
    if (call === 1) return okView(planView());
    if (call === 2) return { ok: false, error: { code: 'transport_error' } };
    return okView(planView({ maxConcurrent: 3 }));
  });
  await controller.actions.refresh();
  const ambiguous = await controller.actions.planConfigure(3);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.ambiguous, true);
  const retried = await controller.actions.planConfigure(3);
  assert.equal(retried.ok, true);
  assert.equal(calls[1].requestId, calls[2].requestId, 'same logical transaction keeps its requestId');
  assert.equal(controller.getSnapshot().view.recoveryPlan.maxConcurrent, 3);
  controller.dispose();
});

test('an ambiguous planAdd retry reuses the requestId and publishes the plan', async () => {
  let call = 0;
  const addedPlan = planView({
    revision: 6,
    batches: [['plan-a'], ['plan-b', 'plan-new']],
    items: [...planView().items, {
      ...planView().items[0], id: 'plan-new', sessionId: 's-new', title: 'New', batchIndex: 1, blockers: [],
    }],
  });
  const { controller, calls } = rpcHarness(() => {
    call += 1;
    if (call === 1) return okView(planView());
    if (call === 2) return { ok: false, error: { code: 'transport_error' } };
    return okView(addedPlan);
  });
  await controller.actions.refresh();
  const ambiguous = await controller.actions.planAdd('s-new', 1);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.ambiguous, true);
  const retried = await controller.actions.planAdd('s-new', 1);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(calls[1].requestId, calls[2].requestId);
  assert.equal(calls[1].payload.sessionId, 's-new');
  assert.equal(calls[1].payload.batch, 1);
  assert.equal(controller.getSnapshot().view.recoveryPlan.items.some((item) => item.id === 'plan-new'), true);
  controller.dispose();
});

test('a repeated pending plan mutation is busy and sends one request', async () => {
  let release;
  const { controller, calls } = rpcHarness((request) => (request.op === 'planConfigure'
    ? new Promise((resolve) => { release = () => resolve(okView(planView({ maxConcurrent: 4 }))); })
    : okView(planView())));
  await controller.actions.refresh();
  calls.length = 0;
  const first = controller.actions.planConfigure(4);
  const second = await controller.actions.planConfigure(4);
  assert.equal(second.error.code, 'busy');
  assert.equal(calls.length, 1);
  release();
  assert.equal((await first).ok, true);
  controller.dispose();
});

test('the plan row reports authorization but offers no second switch', () => {
  const plan = planView({
    items: [
      { ...planView().items[0], authorizationEnabled: true, quotaScopeBound: true },
      planView().items[1],
    ],
  });
  const view = internals.projectView(validView({ recoveryPlan: plan, quotaScopeId: 'cpamc:codex:test-auth-index' })).view;
  const snapshot = {
    phase: 'ready', view, error: null, notice: null, warning: null, pending: {},
    sessions: [], hasTransport: true, lastUpdatedAt: 1, planConfirmId: null, closed: false,
  };
  const actions = {
    refresh() {}, checkQuota() {}, setPaused() {}, openPanel() {}, openSession() {},
    planItemPause() {}, planRemove() {}, planSkip() {}, cancelPlanSkip() {}, requestPlanSkip() {},
    planMove() {}, planConfigure() {}, planSetPaused() {},
  };
  const tree = internals.components.QuotaQueuePanel({
    t, store: { getSnapshot: () => snapshot, subscribe: () => () => {} }, actions, sessionId: 's-a',
  });
  // One entry only: the session switch under the composer. The plan reports
  // the persisted authorization instead of offering a second control.
  assert.equal(expand(tree).filter((node) => node.props && node.props.role === 'switch').length, 0);
  assert.ok(renderElement(tree).includes(internals.dictionaries.en['plan.authorized']));
});

test('the plan panel renders batches, reasons and no execution control', () => {
  const plan = planView({ paused: true });
  plan.items = plan.items.map((item) => ({ ...item, blockers: ['execution_capability_missing'] }));
  const view = internals.projectView(validView({ recoveryPlan: plan })).view;
  const snapshot = { phase: 'ready', view, error: null, notice: null, warning: null, pending: {}, sessions: [], hasTransport: true, lastUpdatedAt: 1, planConfirmId: 'plan-a', closed: false };
  const tree = internals.components.QuotaQueuePanel({ t, store: { getSnapshot: () => snapshot, subscribe: () => () => {} }, actions: { refresh() {}, checkQuota() {}, setPaused() {}, openPanel() {}, openSession() {}, planItemPause() {}, planRemove() {}, planSkip() {}, cancelPlanSkip() {}, requestPlanSkip() {}, planMove() {}, planConfigure() {}, planSetPaused() {} }, sessionId: 's-a' });
  const out = renderElement(tree);
  for (const text of [internals.dictionaries.en['plan.heading'], 'Batch 1', 'Batch 2', 'A', 'B']) {
    assert.ok(out.includes(text), text);
  }
  // The order-only note and the execution-pending blocker are no longer
  // repeated under the plan: the header states the mode once.
  assert.equal(out.includes(internals.dictionaries.en['plan.noExecution']), false);
  assert.equal(out.includes(internals.dictionaries.en['plan.blocker.execution_capability_missing']), false);
  const labels = expand(tree).filter((node) => node.type === 'button' && node.props && node.props['aria-label'])
    .map((node) => node.props['aria-label']);
  assert.equal(labels.includes(internals.dictionaries.en['plan.confirmSkip']), true, 'skip requires confirmation');
  assert.equal(labels.some((label) => /execute|run now|resume task/i.test(label)), false);
});
