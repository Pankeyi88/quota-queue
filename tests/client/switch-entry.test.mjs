/**
 * Client 侧唯一入口证明：会话下方的开关（actions.setRecoverySwitch）就是
 * 调度计划成员 + 授权的事实。
 *
 *   开：计划里没有该会话 -> planAdd（入队/恢复）后 planAuthorize；
 *       已有条目            -> planAuthorize；
 *   关：有条目 -> planRemove（真的移出计划，同时清会话偏好）；
 *       无条目 -> setSessionOptIn(false)（清历史偏好）。
 *
 * 计划行不再有第二个开关：宿主两份存储的一致性由
 * tests/host/switch-sync.test.mjs 证明，本文件只证明客户端只有一个入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeCtx, makeT, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
const t = makeT(internals.dictionaries.en);

function planView(items, overrides = {}) {
  return {
    available: true, editable: true, reason: null, revision: 7, maxConcurrent: 1, paused: false,
    batches: items.map((item) => [item.id]),
    items,
    ...overrides,
  };
}
function item(id, sessionId, extra = {}) {
  return {
    id, sessionId, title: id, workspacePath: 'E:/ws', batchIndex: 0, status: 'ready',
    paused: false, removed: false, skipped: false, authorizationEnabled: false,
    quotaScopeBound: true, executionHeld: false, attempts: 0,
    reason: 'execution_capability_missing', blockers: [], ...extra,
  };
}

const CONFIGURED_QUOTA = {
  configured: true, state: 'available', remaining: 90, weeklyRemaining: 90,
  fiveHourRemaining: 90, resetAt: null, observedAt: null, reasons: [],
};
const base = (plan, overrides = {}) => validView({
  quotaScopeId: 'cpamc:codex:test-auth-index',
  quota: CONFIGURED_QUOTA,
  sessionOptIns: {},
  recoveryPlan: plan,
  ...overrides,
});

/** A transport that answers each op with its own View and records requests. */
function controllerWith(handler) {
  const calls = [];
  const harness = makeCtx({
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          const request = payload.args.request;
          calls.push(request);
          const view = handler(request);
          if (view === null) return { ok: true, value: { ok: false, error: { code: 'capability_missing' } } };
          return { ok: true, value: { ok: true, data: view } };
        },
      },
    },
  });
  const controller = internals.createController(harness.ctx, { t, now: () => 1000 });
  return { controller, calls };
}

test('client: 开启开关时先把会话加入计划，再用返回的条目授权', async () => {
  const empty = planView([]);
  const queued = planView([item('plan-a', 's-a')]);
  const authorized = planView([item('plan-a', 's-a', { authorizationEnabled: true })]);
  const { controller, calls } = controllerWith((request) => {
    if (request.op === 'planAdd') return base(queued);
    if (request.op === 'planAuthorize') return base(authorized);
    return base(empty);
  });
  await controller.actions.refresh();
  calls.length = 0;
  const result = await controller.actions.setRecoverySwitch('s-a', true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.op), ['planAdd', 'planAuthorize']);
  assert.equal(calls[0].payload.sessionId, 's-a');
  assert.equal(Number.isSafeInteger(calls[0].payload.expectedRevision), true);
  assert.equal(calls[1].payload.id, 'plan-a');
  assert.equal(calls[1].payload.enabled, true);
  controller.dispose();
});

test('client: 已在计划里的会话开启只用一次 planAuthorize，不重复入队', async () => {
  const plan = planView([item('plan-a', 's-a')]);
  const { controller, calls } = controllerWith(() => base(plan));
  await controller.actions.refresh();
  calls.length = 0;
  const result = await controller.actions.setRecoverySwitch('s-a', true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.op), ['planAuthorize']);
  assert.equal(calls[0].payload.id, 'plan-a');
  assert.equal(calls[0].payload.enabled, true);
  controller.dispose();
});

test('client: 关闭开关真的移出计划（走 planRemove，而不是只关授权）', async () => {
  const plan = planView([item('plan-a', 's-a', { authorizationEnabled: true })]);
  const { controller, calls } = controllerWith((request) => (request.op === 'planRemove' ? base(planView([])) : base(plan)));
  await controller.actions.refresh();
  calls.length = 0;
  const result = await controller.actions.setRecoverySwitch('s-a', false);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.op), ['planRemove']);
  assert.equal(calls[0].payload.id, 'plan-a');
  assert.equal(controller.getSnapshot().view.recoveryPlan.items.length, 0);
  controller.dispose();
});

test('client: 计划里没有条目时关闭只清历史会话偏好', async () => {
  const { controller, calls } = controllerWith(() => base(planView([])));
  await controller.actions.refresh();
  calls.length = 0;
  const result = await controller.actions.setRecoverySwitch('s-a', false);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.map((call) => call.op), ['setSessionOptIn']);
  assert.equal(calls[0].payload.enabled, false);
  controller.dispose();
});

test('client: 非布尔输入不发任何请求', async () => {
  const { controller, calls } = controllerWith(() => base(planView([item('plan-a', 's-a')])));
  await controller.actions.refresh();
  calls.length = 0;
  for (const bad of ['yes', 1, null, undefined]) {
    const result = await controller.actions.setRecoverySwitch('s-a', bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_input');
  }
  assert.equal(calls.length, 0);
  controller.dispose();
});

function expandTree(element) {
  if (Array.isArray(element)) return element.flatMap(expandTree);
  if (!element || typeof element !== 'object') return [];
  if (typeof element.type === 'function') return expandTree(element.type(element.props));
  return [element, ...expandTree(element.props && element.props.children)];
}
const actions = { refresh() {}, checkQuota() {}, setPaused() {}, openPanel() {}, openSession() {}, planAuthorize() {}, planRemove() {}, setSessionOptIn() {}, planAdd() {} };

function panelSwitchCount(view) {
  const snapshot = {
    phase: 'ready', view, error: null, notice: null, warning: null, pending: {},
    sessions: [], hasTransport: true, lastUpdatedAt: 1, planConfirmId: null, closed: false
  };
  const tree = internals.components.QuotaQueuePanel({
    t, store: { getSnapshot: () => snapshot, subscribe: () => () => {} }, actions, sessionId: 's-a'
  });
  return expandTree(tree).filter((node) => node.props && node.props.role === 'switch').length;
}

test('client: 计划行没有第二个开关，唯一开关在会话下方', () => {
  const view = internals.projectView(base(planView([item('plan-a', 's-a')]))).view;
  // Panel (plan + status) has no switch at all now.
  assert.equal(panelSwitchCount(view), 0);
  // The composer dock still owns the one switch.
  const dock = expandTree(internals.components.QuotaQueueDockStatus({
    t, store: { getSnapshot: () => ({ phase: 'ready', view, error: null, notice: null, warning: null, pending: {}, closed: false }), subscribe: () => () => {} },
    actions, sessionId: 's-a'
  }));
  const switches = dock.filter((node) => node.props && node.props.role === 'switch');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].props.disabled, false);
  assert.equal(switches[0].props.title, t('resume.switchHint'));
});

test('client: 宿主没有已验证作用域时唯一开关锁定并说明原因', () => {
  const view = internals.projectView(base(planView([item('plan-a', 's-a')]), { quotaScopeId: null })).view;
  const dock = expandTree(internals.components.QuotaQueueDockStatus({
    t, store: { getSnapshot: () => ({ phase: 'ready', view, error: null, notice: null, warning: null, pending: {}, closed: false }), subscribe: () => () => {} },
    actions, sessionId: 's-a'
  }));
  const sw = dock.find((node) => node.props && node.props.role === 'switch');
  assert.ok(sw, 'dock switch exists');
  assert.equal(sw.props.disabled, true);
  assert.equal(sw.props.title, t('plan.scope.unavailable'));
});
