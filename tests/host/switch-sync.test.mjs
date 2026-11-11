/**
 * 双向开关同步（dev.26 验收）：同一入口 + 四向测试。
 *
 * 约束：
 *  - 全部在隔离的 fake 存储上运行，不接触 ~/.dsh/storages；
 *  - 关闭执行能力（execution=false）、不挂载 recovery consumer，
 *    因此任何一次授权都不会释放批次、不会开新任务、不会碰真实会话；
 *  - 四个方向都断言"另一处立即一致"与"重载后保持"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeStorage, createSession } from './harness.mjs';

const PLAN_UNIT = 'quota_recovery_plan_v1';
const FIXED_SCOPE = 'cpamc:codex:test-auth-index';
const ROUTE = Object.freeze({
  id: 'route-1', label: 'flash', provider: 'westlake-hpc', model: 'deepseek-flash',
});

const scopedConfig = () => ({
  storageBackend: 'json',
  routes: [ROUTE],
  // 恢复 consumer 已挂载（与现有 planAuthorize 测试同构），但执行能力仍由
  // 本构建关闭，因此授权不会释放任何批次。
  quotaSource: {
    kind: 'cpamc', baseUrl: 'https://cpa.example.com', managementKeyEnv: 'CPAMC_MANAGEMENT_KEY',
    authIndex: 'test-auth-index', weeklyMinRemaining: 10, fiveHourMinRemaining: 0,
  },
  autoContinue: { enabled: true },
});

function seededPlan(enabled = false, quotaScopeId = FIXED_SCOPE) {
  const item = {
    id: 'plan-s-a',
    ref: { taskId: 't-a', sessionId: 's-a', generation: 'g-a', workspaceId: 'ws-1', quotaScopeId },
    authorization: { sessionId: 's-a', generation: 'g-a', enabled },
    status: 'ready', paused: false, removed: false, skip: null, result: null, attempts: 0, fence: null,
  };
  return {
    schemaVersion: 1, revision: 1, maxConcurrent: 1, paused: false,
    batches: [['plan-s-a']], items: [item], usedClaimIds: [], usedMessageIds: [],
  };
}

function globalWith(optIn) {
  return {
    schemaVersion: 1, revision: 3, seq: 3, dispatchPaused: false, dispatchPausedReason: null,
    tasks: [], dedupeIndex: {}, sessionOptIns: { 's-a': optIn }, quotaScopes: {},
    updatedAt: '2026-10-29T00:00:00.000Z',
  };
}

/** view 里两个界面读取到的"同一事实"是否一致。 */
function readBothSurfaces(view) {
  const item = view.recoveryPlan.items[0];
  return {
    planSwitch: item.authorizationEnabled === true,
    composerSwitch: view.sessionOptIns['s-a'] === true,
    persistedOptIn: view.sessionOptIns['s-a'],
  };
}

async function boot({ plan, optIn }) {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({
    initialGlobal: globalWith(optIn),
    initialUnits: { [PLAN_UNIT]: plan },
  });
  const session = await createSession({ storage, config: scopedConfig() });
  const view = (await session.call('bootstrap', {})).data;
  return { storage, session, view };
}

test('D0 初始：两处一致（全关），且执行能力保持关闭', async () => {
  const { session, view } = await boot({ plan: seededPlan(false), optIn: false });
  const both = readBothSurfaces(view);
  assert.equal(both.planSwitch, false);
  assert.equal(both.composerSwitch, false);
  assert.equal(view.capabilities.execution, false);
  assert.equal(view.capabilities.autoResume, false);
  await session.service.dispose();
});

test('D1 计划项开关 -> 开：会话偏好同步为开，刷新/重启后保持', async () => {
  const { storage, session, view } = await boot({ plan: seededPlan(false), optIn: false });
  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: view.recoveryPlan.revision });
  assert.equal(on.ok, true, JSON.stringify(on));
  const both = readBothSurfaces(on.data);
  assert.equal(both.planSwitch, true, '计划项开关已开');
  assert.equal(both.composerSwitch, true, '会话偏好同步为开');
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);
  // 授权不等于执行：能力仍关闭，也没有任何任务/批次被释放。
  assert.equal(on.data.capabilities.execution, false);
  assert.equal(on.data.tasks.length, 0);
  assert.ok(on.data.recoveryPlan.items[0].blockers.includes('execution_capability_missing'));

  await session.service.dispose();
  const second = await createSession({ storage, config: scopedConfig() });
  const reloaded = (await second.call('bootstrap', {})).data;
  const after = readBothSurfaces(reloaded);
  assert.equal(after.planSwitch, true, '重载后计划项仍为开');
  assert.equal(after.composerSwitch, true, '重载后会话偏好仍为开');
  await second.service.dispose();
});

test('D2 计划项开关 -> 关：会话偏好同步为关，重启后保持', async () => {
  const { storage, session, view } = await boot({ plan: seededPlan(true), optIn: true });
  assert.equal(readBothSurfaces(view).planSwitch, true);
  assert.equal(readBothSurfaces(view).composerSwitch, true);
  const off = await session.call('planAuthorize', { id: 'plan-s-a', enabled: false, expectedRevision: view.recoveryPlan.revision });
  assert.equal(off.ok, true, JSON.stringify(off));
  const both = readBothSurfaces(off.data);
  assert.equal(both.planSwitch, false);
  assert.equal(both.composerSwitch, false);
  assert.equal(storage.state.global.sessionOptIns['s-a'], false);

  await session.service.dispose();
  const second = await createSession({ storage, config: scopedConfig() });
  const reloaded = (await second.call('bootstrap', {})).data;
  const after = readBothSurfaces(reloaded);
  assert.equal(after.planSwitch, false);
  assert.equal(after.composerSwitch, false);
  await second.service.dispose();
});

test('D3 会话开关 -> 开（计划内会话仍走计划项）：两处一致并持久化', async () => {
  const { storage, session, view } = await boot({ plan: seededPlan(false), optIn: false });
  // Client 的 setRecoverySwitch 对已计划会话转为 planAuthorize(item.id, ...)；
  // Host 侧等价于用该会话的计划项 id 调用计划项入口。
  const on = await session.call('planAuthorize', { id: 'plan-s-a', enabled: true, expectedRevision: view.recoveryPlan.revision });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.data.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(on.data.sessionOptIns['s-a'], true);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);

  await session.service.dispose();
  const second = await createSession({ storage, config: scopedConfig() });
  const reloaded = (await second.call('bootstrap', {})).data;
  assert.equal(reloaded.recoveryPlan.items[0].authorizationEnabled, true);
  assert.equal(reloaded.sessionOptIns['s-a'], true);
  await second.service.dispose();
});

test('D4 会话开关 -> 关：两处一致并持久化', async () => {
  const { storage, session, view } = await boot({ plan: seededPlan(true), optIn: true });
  const off = await session.call('planAuthorize', { id: 'plan-s-a', enabled: false, expectedRevision: view.recoveryPlan.revision });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.data.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(off.data.sessionOptIns['s-a'], false);
  assert.equal(storage.state.units.get(PLAN_UNIT).items[0].authorization.enabled, false);
  assert.equal(storage.state.global.sessionOptIns['s-a'], false);

  await session.service.dispose();
  const second = await createSession({ storage, config: scopedConfig() });
  const reloaded = (await second.call('bootstrap', {})).data;
  assert.equal(reloaded.recoveryPlan.items[0].authorizationEnabled, false);
  assert.equal(reloaded.sessionOptIns['s-a'], false);
  await second.service.dispose();
});

test('D5 计划外会话：仅会话偏好可写，计划里保持没有条目（不伪造第二处）', async () => {
  process.env.CPAMC_MANAGEMENT_KEY = 'test-key-not-a-secret';
  const storage = createFakeStorage({ initialGlobal: globalWith(false) });
  const session = await createSession({ storage, config: scopedConfig() });
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.recoveryPlan.items.length, 0);
  const direct = await session.call('setSessionOptIn', { sessionId: 's-a', enabled: true });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal(direct.data.sessionOptIns['s-a'], true);
  assert.equal(storage.state.global.sessionOptIns['s-a'], true);
  // 计划里没有该会话的条目：不伪造第二处（不创建计划项）。
  assert.equal(storage.state.units.get(PLAN_UNIT), undefined);
  assert.equal(direct.data.recoveryPlan.items.length, 0);

  // 先释放本实例持有的存储单元，再模拟"刷新/重启"重读。
  await session.service.dispose();
  const again = await createSession({ storage, config: scopedConfig() });
  const reloaded = (await again.call('bootstrap', {})).data;
  assert.equal(reloaded.sessionOptIns['s-a'], true, '重载后会话偏好保持为开');
  assert.equal(reloaded.recoveryPlan.items.length, 0);
  await again.service.dispose();
});
