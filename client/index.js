/**
 * Quota Queue - browser half (P2 client).
 *
 * Contract: quota-queue/docs/WIRE-CONTRACT.md (v1). The client talks to the Host
 * through the authenticated Connection RPC channel, never through fetch/XHR of
 * its own. It holds no credentials, no credential reference and no raw host
 * error text: every value that reaches the UI is projected through a whitelist
 * (schema projection defense) and every failure is surfaced as a fixed,
 * localized machine code.
 *
 * Evidence for the public surfaces used here (installation checkout
 * <DSH_MODULE_ROOT>/@deepseek-ai):
 *  - lazy factory + require('react') from the browser module table:
 *    dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js
 *  - ctx.slots.inject / ctx.slots.register (register-disposer owned by ctx.effect):
 *    dsh-client-ui-renderer/lib/types/client/registry.d.ts:85-118
 *  - slot keys, kinds, scopes and register options:
 *    dsh-client-ui-layout/lib/types/client/index.d.ts:53 ('main', keyed, key required)
 *    dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:46 ('sidebar.panellist')
 *    dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:225
 *      ('conversation.composer.dock')
 *    dsh-cordis-client-runner/lib/client.js:3884,5067,2704 (live slot catalog)
 *  - registration example: dsh-client-ui-plugin-manager/lib/client.js:3712-3775,
 *    dsh-client-ui-schedule/lib/client.js:6685-6733,6793-6810
 *  - ctx.connection.rpc.call(channel, endpoint, payload, signal):
 *    dsh-client-connection/lib/types/rpc.d.ts:208-230,
 *    dsh-client-connection/lib/client.js:1403-1477 (ctx.provide('connection', handle))
 *  - ctx.locale.register(ns, {zh, en}) / bind(ns):
 *    dsh-client-locale/lib/types/client/index.d.ts:199,226
 *  - product navigation: ctx.get('uiWorkspace').openSession(SessionTarget) and
 *    ctx.get('layout').selectPanel(MainPanelId):
 *    dsh-client-ui-workspace/lib/types/client/navigation.d.ts:10-15,
 *    dsh-client-ui-layout/lib/types/client/service.d.ts:24-32
 *  - theme tokens: dsh-client-ui-theme/lib/client.js (--dsw-alias-* set)
 *
 * No browser storage, no credential headers, no arbitrary network calls, no
 * embedded frames, no document or DOM injection, no second application root.
 */
window.__ModuleLoader__.load({
  id: '@local/quota-queue',
  factory(require) {
    'use strict';

    var React = require('react');
    var h = React.createElement;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    var NS = 'quota-queue';
    var PANEL_ID = 'quota-queue';
    var DOCK_ID = 'quota-queue.status';
    var CHANNEL = '/api';
    var ENDPOINT = 'quotaQueue/dispatch';
    var VIEW_VERSION = 1;
    var REQUEST_VERSION = 1;
    var MAX_FIELD_LEN = 20000;

    var TASK_STATUSES = ['draft', 'queued', 'waiting_quota', 'ready', 'running', 'paused', 'needs_attention', 'completed', 'failed', 'cancelled'];
    var TASK_STATUS_SET = new Set(TASK_STATUSES);
    var TASK_KINDS = ['new-session', 'resume-session'];
    var TASK_KIND_SET = new Set(TASK_KINDS);
    var WAITING_STATUSES = new Set(['queued', 'waiting_quota', 'ready', 'paused', 'draft']);

    // Canonical client codes: every code that may reach the UI. The Host never
    // sends its raw message; only these codes select a local localized string.
    var KNOWN_ERROR_CODES = {
      // Client-owned
      invalid_input: 1, busy: 1, closed: 1, protocol_error: 1, transport_error: 1,
      request_failed: 1,
      // Host fixed vocabulary (quota-queue/host/errors.js SAFE_MESSAGES)
      unsupported_operation: 1, not_remote: 1, invalid_invocation: 1,
      authorization_denied: 1, configuration_incomplete: 1, capability_missing: 1,
      workspace_unavailable: 1, route_unavailable: 1, request_conflict: 1,
      not_found: 1, not_editable: 1, not_cancellable: 1, persistence_failed: 1,
      revision_conflict: 1, unavailable: 1, cancelled: 1, internal: 1,
      task_not_recoverable: 1, plan_conflict: 1
    };

    // Host/core codes folded onto a canonical code with an existing safe string.
    var ERROR_CODE_ALIASES = {
      invalid_request: 'invalid_input',
      invalid_transition: 'invalid_input',
      unknown_op: 'unsupported_operation',
      operator_required: 'authorization_denied',
      workspace_not_found: 'workspace_unavailable',
      persist_failed: 'persistence_failed',
      store_locked: 'persistence_failed',
      snapshot_invalid: 'persistence_failed',
      port_contract: 'configuration_incomplete',
      dispatch_refused: 'request_failed'
    };

    var OP_FIELDS = {
      bootstrap: { optional: ['sessionId'] },
      cancelQueued: { required: ['id'] },
      pauseDispatch: { required: ['paused'], types: { paused: 'boolean' } },
      setSessionOptIn: { required: ['sessionId', 'enabled'], types: { enabled: 'boolean' } },
      checkQuota: { required: [] },
      requestStop: { required: ['id'] },
      planAdd: { required: ['sessionId', 'batch', 'expectedRevision'], types: { batch: 'integer', expectedRevision: 'integer' } },
      planConfigure: { required: ['maxConcurrent', 'expectedRevision'], types: { maxConcurrent: 'concurrency', expectedRevision: 'integer' } },
      planPause: { required: ['paused', 'expectedRevision'], types: { paused: 'boolean', expectedRevision: 'integer' } },
      planItemPause: { required: ['id', 'paused', 'expectedRevision'], types: { paused: 'boolean', expectedRevision: 'integer' } },
      planRemove: { required: ['id', 'expectedRevision'], types: { expectedRevision: 'integer' } },
      planSkip: { required: ['id', 'confirmed', 'expectedRevision'], types: { confirmed: 'true', expectedRevision: 'integer' } },
      planMove: { required: ['id', 'batch', 'position', 'expectedRevision'], types: { batch: 'integer', position: 'integer', expectedRevision: 'integer' } },
      planAuthorize: { required: ['id', 'enabled', 'expectedRevision'], types: { enabled: 'boolean', expectedRevision: 'integer' } }
    };
    var AUTO_CONTINUE_STATES = ['waiting', 'claimed', 'delivered', 'unknown', 'done', 'cancelled', 'needs_attention'];
var AUTO_CONTINUE_OWNERS = ['active', 'passive', 'disabled', 'unshared'];
var PLAN_OPERATIONS = ['planAdd', 'planConfigure', 'planPause', 'planItemPause', 'planRemove', 'planSkip', 'planMove', 'planAuthorize'];
    var PLAN_STATUSES = ['ready', 'waiting_quota', 'running', 'needs_attention', 'succeeded', 'failed', 'stopped'];
    var QUOTA_STATES = ['available', 'exhausted', 'rate_limited', 'auth_required', 'unknown'];
    var PLAN_REASONS = ['execution_capability_missing', 'removed', 'skipped', 'task_paused', 'plan_paused', 'execution_outcome_unknown'];
    var PLAN_BLOCKERS = ['execution_outcome_unknown', 'removed', 'skipped', 'task_running', 'plan_paused', 'item_paused',
      'authorization_disabled', 'quota_scope_unbound', 'execution_capability_missing', 'earlier_batch_incomplete'];
    var PLAN_AVAILABILITY_REASONS = ['recovery_plan_unavailable', 'recovery_plan_persistence_failed'];
    // Mirrors the core schema bounds so an oversized plan never reaches the UI.
    var MAX_PLAN_ITEMS = 100;
    var MAX_PLAN_BATCHES = 50;

    // ------------------------------------------------------------------
    // Locale dictionaries
    // ------------------------------------------------------------------

    var zh = {
      'plan.heading': '已有任务排序计划',
      'plan.note': '仅编辑已有任务的批次与顺序，不会启动执行或授予自动恢复权限。批次内可并行，前一批次成功或明确跳过后才放行下一批次。',
      'plan.unavailable': '宿主未提供可编辑的已有任务计划，请刷新或升级插件。',
      'plan.persistenceFailed': '计划无法可靠保存，编辑已锁定；下方保留最近可靠状态。',
      'plan.empty': '计划为空。请在已有任务列表中核验后加入，不会创建新任务。',
      'plan.batch': '批次 {number}',
      'plan.appendBatch': '末尾新批次',
      'plan.add': '核验并加入计划',
      'plan.alreadyAdded': '该会话已在计划或历史中；同一任务范围不能重复加入。',
      'plan.concurrent': '计划并发上限（1–8）',
      'plan.configure': '保存并发上限',
      'plan.pause': '暂停计划后续启动',
      'plan.resume': '恢复计划后续启动',
      'plan.itemPause': '暂停该项后续恢复',
      'plan.itemResume': '解除该项暂停',
      'plan.remove': '移出计划',
      'plan.skip': '跳过此项并放行后续',
      'plan.skipHeading': '确认跳过此项？',
      'plan.skipWarning': '跳过不会将任务标为成功，可能放行后续批次。不会停止原会话中的运行任务。',
      'plan.skipConfirm': '确认跳过并放行',
      'plan.skipCancel': '保留此项',
      'plan.move': '保存位置',
      'plan.targetBatch': '目标批次',
      'plan.position': '批次内位置（从 1 开始）',
      'plan.moveLocked': '尝试过或持有执行占用的项不能移动。',
      'plan.executionDisabled': '执行及自动恢复未启用；保存顺序不是执行授权。',
      'plan.itemRemoved': '已移出（只读历史）',
      'plan.itemSkipped': '已明确跳过（保留原结果）',
      'plan.reason.execution_capability_missing': '执行能力未接通，当前仅保存顺序。',
      'plan.reason.removed': '已移出计划；原任务与历史保留。',
      'plan.reason.skipped': '用户已明确跳过；原结果未改为成功。',
      'plan.reason.task_paused': '该项后续恢复已暂停。',
      'plan.reason.plan_paused': '整个计划的后续启动已暂停。',
      'plan.reason.execution_outcome_unknown': '原执行结果不明，执行占用保留。',
      'plan.notice.saved': '已有任务计划已可靠保存；没有启动执行。',
      'status.succeeded': '选定执行范围成功',
      'status.stopped': '已停止',
      'recovery.unavailable': '宿主已有任务恢复、执行所有权及串并行调度契约尚未接入；当前不能授权恢复或安排执行。',
      'history.newSession': '旧 new-session 记录：仅只读历史，不可编辑、执行或转为已有任务。',
      'history.readOnly': '旧队列只读记录；不代表已有任务恢复已可用。',
      'panel.title': '已有任务调度',
      'panel.subtitle': '已有任务状态与旧队列只读历史',
      'panel.runtime': '运行时 {version}',
      'action.refresh': '读取最新状态',
      'action.checkQuota': '立即检查额度',
      'action.pauseDispatch': '暂停后续调度',
      'action.resumeDispatch': '恢复后续调度',
      'action.cancelQueued': '取消排队',
      'action.stopCurrent': '停止当前执行',
      'action.confirmStop': '确认停止',
      'action.keepRunning': '保持执行',
      'action.openSession': '打开会话',
      'action.openPanel': '打开已有任务调度',
      'action.retry': '重试',
      'action.enable': '开启',
      'action.disable': '关闭',
      'hint.pauseDispatch': '只暂停后续调度，不会停止正在执行的任务',
      'hint.resume': '开启后，额度恢复时插件会在原会话继续执行，后台会产生模型请求费用；默认关闭',
      'hint.resumeDisabledCapability': '宿主未提供独占的自动恢复能力，无法开启',
      'hint.resumeDisabledConfig': '配置未完成：固定路由或凭据尚未绑定，无法开启',
      'hint.stopPending': '已请求停止；在宿主确认停止前不会释放执行权',
      'queue.heading': '已有队列（只读历史）',
      'queue.empty': '暂无历史记录；已有任务恢复与排序尚未接入',
      'queue.count': '共 {count} 项',
      'queue.source': '以下条目、上方开关与下方计划取自同一份宿主记录；列表为空即确实没有条目。',
      'queue.planItem': '计划·批次 {batch}',
      'queue.planJoined': '已加入计划：开关与计划项同步保存',
      'plan.authorized': '已授权自动恢复',
      'kind.new': '旧预约历史',
      'kind.resume': '继续原会话',
      'status.draft': '草稿',
      'status.queued': '已排队',
      'status.waiting_quota': '等待额度',
      'status.ready': '可以执行',
      'status.running': '执行中',
      'status.paused': '已暂停',
      'status.needs_attention': '需要处理',
      'status.completed': '已完成',
      'status.failed': '失败',
      'status.cancelled': '已取消',
      'field.workspace': '工作区',
      'field.route': '路由',
      'field.attempts': '尝试 {count} 次',
      'field.nextCheck': '下次复查 {time}',
      'field.session': '会话',
      'field.reason': '等待原因',
      'field.unknown': '未知',
      'field.locked': '已锁定',
      'config.ready': '旧队列配置就绪（不代表恢复可用）',
      'config.notReady': '配置未完成',
      'config.recoveryReady': '额度恢复已就绪',
      'config.executionNotReady': '单会话额度恢复已就绪；执行/批次能力尚未启用（以下为未接通项）',
      'cap.heading': '宿主能力',
      'cap.quotaCheck': '额度查询',
      'cap.execution': '执行',
      'cap.autoResume': '自动恢复',
      'cap.on': '可用',
      'cap.off': '不可用',
      'quota.notConfigured': '额度查询：未配置',
      'quota.notChecked': '尚未检查',
      'quota.summary': '额度：周剩余 {weekly} · 5 小时剩余 {five} · {state}',
      'quota.state.available': '可用',
      'quota.state.exhausted': '额度不足',
      'quota.state.rate_limited': '限流',
      'quota.state.auth_required': '认证失败',
      'quota.state.unknown': '未知',
      'quota.reasons': '额度原因：{reasons}',
      'resume.heading': '原会话恢复授权',
      'resume.switchLabel': '允许该会话自动恢复',
      'resume.switchHint': '开启＝加入调度计划并授权自动恢复；关闭＝移出计划',
      'continue.waiting': '等待重试 · 下次 {time}',
      'continue.quotaWaiting': '等待额度 · 下次 {time}',
      'continue.quotaUnknown': '额度未知，暂不恢复 · 下次 {time}',
      'continue.pending': '已发出「继续」，等待确认',
      'continue.delivered': '已自动继续',
      'continue.needsAttention': '自动恢复需要你处理',
      'resume.selectSession': '选择会话',
      'resume.noSession': '当前没有可授权的会话',
      'dock.title': '已有任务调度',
      'dock.summary': '历史记录：等待 {waiting} · 执行状态 {running} · 需处理 {attention}',
      'dock.openPanel': '打开队列',
      'dock.noView': '尚未读取到宿主状态',
      'notice.cancelled': '已取消排队',
      'notice.paused': '已暂停后续调度',
      'notice.resumed': '已恢复后续调度',
      'notice.quotaRequested': '已请求额度检查',
      'notice.stopRequested': '已请求停止，等待宿主确认',
      'notice.optInOn': '已开启原会话自动恢复',
      'notice.optInOff': '已关闭原会话自动恢复',
      'notice.planAdded': '已加入调度计划（仅排序，不会执行）',
      'notice.planUpdated': '调度计划已保存',
      'plan.heading': '调度计划（串行 / 并行批次）',
      'plan.note': '每个批次内可并行，前一批全部成功后才会放行下一批。这里只保存执行顺序，不会启动任何任务。',
      'plan.empty': '还没有加入任何已有任务。请先在上方核验并加入。',
      'plan.revision': '计划版本 {revision}',
      'plan.concurrency': '并发上限',
      'plan.applyConcurrency': '应用并发上限',
      'plan.pause': '暂停整个计划',
      'plan.resume': '恢复整个计划',
      'plan.paused': '计划已暂停：不会启动后续批次',
      'plan.readonly': '计划存储不可编辑；已显示最后一次可靠保存的内容',
      'plan.unavailable': '计划存储当前不可用；不会覆盖或重建损坏数据',
      'plan.batch': '批次 {index}',
      'plan.batchParallel': '批次 {index}（可并行）',
      'plan.moveUp': '前移',
      'plan.moveDown': '后移',
      'plan.remove': '移出计划',
      'plan.skip': '跳过并放行后续',
      'plan.confirmSkip': '确认跳过（保留原结果）',
      'plan.cancelSkip': '取消跳过',
      'plan.itemPaused': '暂停本项',
      'plan.itemResume': '恢复本项',
      'plan.removed': '已移出',
      'plan.skipped': '已跳过',
      'plan.held': '执行结果不明，保持占用',
      'plan.noExecution': '执行、额度查询与自动恢复仍未接通；计划永远以未授权状态保存。',
      'plan.reason.execution_capability_missing': '等待执行能力接入（当前禁执行）',
      'plan.reason.removed': '已移出计划',
      'plan.reason.skipped': '已显式跳过，后续批次可放行',
      'plan.reason.task_paused': '本项已暂停',
      'plan.reason.plan_paused': '整个计划已暂停',
      'plan.reason.execution_outcome_unknown': '上次执行结果不明，需人工对账',
      'plan.blockers': '阻塞原因',
      'plan.blocker.execution_outcome_unknown': '上次执行结果不明，保持占用',
      'plan.blocker.removed': '已移出计划',
      'plan.blocker.skipped': '已显式跳过',
      'plan.blocker.task_running': '该任务当前正在运行（不能在计划中当作空闲项）',
      'plan.blocker.plan_paused': '整个计划已暂停',
      'plan.blocker.item_paused': '本项已暂停',
      'plan.blocker.authorization_disabled': '未授权自动恢复（本版不会自动授权）',
      'plan.blocker.quota_scope_unbound': '尚未绑定额度范围',
      'plan.scope.unavailable': '宿主没有已验证的额度账户作用域，无法启用自动恢复',
      'plan.scope.bound': '已绑定宿主的固定额度范围（只读额度源）',
      'plan.blocker.execution_capability_missing': '执行能力尚未接通',
      'plan.blocker.earlier_batch_incomplete': '前一批尚未全部成功',
      'notice.ambiguous': '上次请求的结果未知，可能已经生效；请读取最新状态',
      'notice.unresolvedPrevious': '存在一次结果未知的提交；已按新内容发起新的请求',
      'error.generic': '操作失败，本地状态未更新；结果可能未知',
      'error.transport_error': '与宿主连接失败，结果未知；请读取最新状态确认',
      'error.protocol_error': '宿主返回的数据不符合契约，结果未知；请读取最新状态确认',
      'error.request_failed': '宿主返回了未识别的错误，结果未知；请读取最新状态确认',
      'error.internal': '宿主内部错误，结果未知；请重试或读取最新状态确认',
      'error.capability_missing': '宿主缺少所需能力，未执行',
      'error.configuration_incomplete': '配置未完成，未执行',
      'error.invalid_input': '输入不完整或非法',
      'error.unsupported_operation': '宿主不支持该操作',
      'error.not_remote': '该操作只能通过已认证的 Connection Remote 执行',
      'error.invalid_invocation': 'Remote 调用缺少必要身份',
      'error.authorization_denied': '授权被拒绝：该操作只能由用户显式发起',
      'error.workspace_unavailable': '所选工作区未注册或当前不可用，未执行',
      'error.route_unavailable': '所选路由不在宿主固定配置中，不可用',
      'error.request_conflict': '同一 requestId 已用于不同内容；没有重复提交',
      'error.persistence_failed': '无法可靠保存队列快照，调度已停止',
      'error.not_found': '找不到目标任务',
      'error.not_editable': '只有尚未开始的手动任务可以编辑',
      'error.not_cancellable': '只有排队或待处理的任务可以取消',
      'error.revision_conflict': '队列或计划状态已变化，请刷新后重试',
      'error.task_not_recoverable': '所选任务不能作为恢复范围（例如已经成功完成）；未加入计划',
      'error.plan_conflict': '该任务身份已在调度计划中（含已移出历史）；本轮没有恢复操作',
      'error.unavailable': '队列服务已关闭',
      'error.cancelled': '调用在完成前被取消，结果未知',
      'error.closed': '插件已关闭',
      'error.busy': '上一次操作仍在进行',
      'a11y.queueList': '额度队列任务列表',
      'a11y.notice': '操作结果',
      'a11y.error': '错误',
      'a11y.pending': '处理中',
      'a11y.switch': '开关'
    };

    var en = {
      'plan.heading': 'Existing-task ordering plan',
      'plan.note': 'Edit batches and order only; this does not start execution or authorize auto recovery. Tasks within a batch may run in parallel; later batches wait for success or an explicit skip.',
      'plan.unavailable': 'The Host does not expose an editable existing-task plan; refresh or upgrade the plugin.',
      'plan.persistenceFailed': 'The plan could not be saved reliably; editing is locked. The last durable state remains visible.',
      'plan.empty': 'The plan is empty. Verify an existing task below to add it; no new task is created.',
      'plan.batch': 'Batch {number}',
      'plan.appendBatch': 'New final batch',
      'plan.add': 'Verify and add to plan',
      'plan.alreadyAdded': 'This session is already in the plan or history; the same task range cannot be added twice.',
      'plan.concurrent': 'Plan concurrency limit (1–8)',
      'plan.configure': 'Save concurrency limit',
      'plan.pause': 'Pause later starts in plan',
      'plan.resume': 'Resume later starts in plan',
      'plan.itemPause': 'Pause later recovery for this item',
      'plan.itemResume': 'Unpause this item',
      'plan.remove': 'Remove from plan',
      'plan.skip': 'Skip item and release later batches',
      'plan.skipHeading': 'Skip this item?',
      'plan.skipWarning': 'Skipping does not mark the task successful and may release later batches. It does not stop a run in the original session.',
      'plan.skipConfirm': 'Confirm skip and release',
      'plan.skipCancel': 'Keep this item',
      'plan.move': 'Save position',
      'plan.targetBatch': 'Target batch',
      'plan.position': 'Position within batch (starts at 1)',
      'plan.moveLocked': 'Attempted items and held executions cannot be moved.',
      'plan.executionDisabled': 'Execution and auto recovery remain disabled; saving order is not execution authorization.',
      'plan.itemRemoved': 'Removed (read-only history)',
      'plan.itemSkipped': 'Explicitly skipped (original outcome retained)',
      'plan.reason.execution_capability_missing': 'Execution is not connected; only order is saved.',
      'plan.reason.removed': 'Removed from the plan; original task and history remain.',
      'plan.reason.skipped': 'Explicitly skipped; the original result was not changed to success.',
      'plan.reason.task_paused': 'Later recovery for this item is paused.',
      'plan.reason.plan_paused': 'Later starts for the whole plan are paused.',
      'plan.reason.execution_outcome_unknown': 'The original outcome is unknown; its execution fence is retained.',
      'plan.notice.saved': 'Existing-task plan saved durably; no execution was started.',
      'status.succeeded': 'Selected execution range succeeded',
      'status.stopped': 'Stopped',
      'recovery.unavailable': 'Host contracts for existing-task recovery, execution ownership and serial/parallel scheduling are not connected; recovery authorization and execution ordering are unavailable.',
      'history.newSession': 'Legacy new-session record: read-only history, not editable, executable or convertible into an existing task.',
      'history.readOnly': 'Read-only legacy queue record; this does not mean existing-task recovery is available.',
      'panel.title': 'Existing task scheduling',
      'panel.subtitle': 'Existing task status and read-only legacy queue history',
      'panel.runtime': 'Runtime {version}',
      'action.refresh': 'Read current state',
      'action.checkQuota': 'Check quota now',
      'action.pauseDispatch': 'Pause later dispatch',
      'action.resumeDispatch': 'Resume later dispatch',
      'action.cancelQueued': 'Cancel queued',
      'action.stopCurrent': 'Stop current run',
      'action.confirmStop': 'Confirm stop',
      'action.keepRunning': 'Keep running',
      'action.openSession': 'Open session',
      'action.openPanel': 'Open existing task scheduling',
      'action.retry': 'Retry',
      'action.enable': 'Enable',
      'action.disable': 'Disable',
      'hint.pauseDispatch': 'Pauses later dispatch only; it never stops the running task',
      'hint.resume': 'When enabled the plugin continues the original session after quota recovery and background model requests are billed; off by default',
      'hint.resumeDisabledCapability': 'The host exposes no exclusive auto-resume capability, so this cannot be enabled',
      'hint.resumeDisabledConfig': 'Configuration is incomplete: no fixed route or credential is bound yet',
      'hint.stopPending': 'Stop requested; the execution lease is not released until the host confirms',
      'queue.heading': 'Existing queue (read-only history)',
      'queue.empty': 'No history; existing-task recovery and ordering are not connected yet',
      'queue.count': '{count} item(s)',
      'queue.source': 'These rows, the switches above and the plan below come from the same Host records; an empty list means there really are none.',
      'queue.planItem': 'Plan · batch {batch}',
      'queue.planJoined': 'In the plan: the switch and the plan item are saved together',
      'plan.authorized': 'Auto resume authorized',
      'kind.new': 'Legacy reservation history',
      'kind.resume': 'Continue original session',
      'status.draft': 'Draft',
      'status.queued': 'Queued',
      'status.waiting_quota': 'Waiting for quota',
      'status.ready': 'Ready',
      'status.running': 'Running',
      'status.paused': 'Paused',
      'status.needs_attention': 'Needs attention',
      'status.completed': 'Completed',
      'status.failed': 'Failed',
      'status.cancelled': 'Cancelled',
      'field.workspace': 'Workspace',
      'field.route': 'Route',
      'field.attempts': '{count} attempt(s)',
      'field.nextCheck': 'Next check {time}',
      'field.session': 'Session',
      'field.reason': 'Waiting reason',
      'field.unknown': 'unknown',
      'field.locked': 'locked',
      'config.ready': 'Legacy configuration ready (recovery unavailable)',
      'config.notReady': 'Configuration incomplete',
      'config.recoveryReady': 'Quota recovery ready',
      'config.executionNotReady': 'Single-session quota recovery is ready; execution/batch capability is not enabled (remaining items below)',
      'cap.heading': 'Host capabilities',
      'cap.quotaCheck': 'Quota check',
      'cap.execution': 'Execution',
      'cap.autoResume': 'Auto resume',
      'cap.on': 'available',
      'cap.off': 'unavailable',
      'quota.notConfigured': 'Quota check: not configured',
      'quota.notChecked': 'not checked yet',
      'quota.summary': 'Quota: weekly {weekly} · 5-hour {five} · {state}',
      'quota.state.available': 'available',
      'quota.state.exhausted': 'exhausted',
      'quota.state.rate_limited': 'rate limited',
      'quota.state.auth_required': 'auth required',
      'quota.state.unknown': 'unknown',
      'quota.reasons': 'Quota reason: {reasons}',
      'resume.heading': 'Original-session resume authorization',
      'resume.switchLabel': 'Allow auto resume for this session',
      'resume.switchHint': 'On = joins the schedule plan and authorizes auto resume; off = leaves the plan',
      'continue.waiting': 'Waiting to retry · next {time}',
      'continue.quotaWaiting': 'Waiting for quota · next {time}',
      'continue.quotaUnknown': 'Quota unknown, holding · next {time}',
      'continue.pending': 'Sent "continue", awaiting confirmation',
      'continue.delivered': 'Continued automatically',
      'continue.needsAttention': 'Auto resume needs your attention',
      'resume.selectSession': 'Select session',
      'resume.noSession': 'No session can be authorized right now',
      'dock.title': 'Existing task scheduling',
      'dock.summary': 'History: waiting {waiting} · recorded running {running} · attention {attention}',
      'dock.openPanel': 'Open queue',
      'dock.noView': 'Host state not read yet',
      'notice.cancelled': 'Removed from the queue',
      'notice.paused': 'Later dispatch paused',
      'notice.resumed': 'Later dispatch resumed',
      'notice.quotaRequested': 'Quota check requested',
      'notice.stopRequested': 'Stop requested; waiting for host confirmation',
      'notice.optInOn': 'Original-session auto resume enabled',
      'notice.optInOff': 'Original-session auto resume disabled',
      'notice.planAdded': 'Added to the ordering plan (ordering only; not executed)',
      'notice.planUpdated': 'Ordering plan saved',
      'plan.heading': 'Ordering plan (serial / parallel batches)',
      'plan.note': 'Tasks in one batch may run in parallel; the next batch is released only after every earlier task succeeds. This only saves an order and starts nothing.',
      'plan.empty': 'No existing task has been added yet. Verify and add one above.',
      'plan.revision': 'Plan revision {revision}',
      'plan.concurrency': 'Concurrency limit',
      'plan.applyConcurrency': 'Apply concurrency',
      'plan.pause': 'Pause the whole plan',
      'plan.resume': 'Resume the whole plan',
      'plan.paused': 'Plan paused: no later batch will start',
      'plan.readonly': 'Plan storage is read-only here; showing the last reliably saved content',
      'plan.unavailable': 'Plan storage is unavailable; corrupt data is never replaced or rebuilt',
      'plan.batch': 'Batch {index}',
      'plan.batchParallel': 'Batch {index} (may run in parallel)',
      'plan.moveUp': 'Move earlier',
      'plan.moveDown': 'Move later',
      'plan.remove': 'Remove from plan',
      'plan.skip': 'Skip and release later batches',
      'plan.confirmSkip': 'Confirm skip (keeps the original result)',
      'plan.cancelSkip': 'Cancel skip',
      'plan.itemPaused': 'Pause this item',
      'plan.itemResume': 'Resume this item',
      'plan.removed': 'Removed',
      'plan.skipped': 'Skipped',
      'plan.held': 'Outcome unknown; execution slot retained',
      'plan.noExecution': 'Execution, quota checks and auto resume are still not connected; every plan entry is stored unauthorized.',
      'plan.reason.execution_capability_missing': 'Waiting for execution to be connected (disabled)',
      'plan.reason.removed': 'Removed from the plan',
      'plan.reason.skipped': 'Explicitly skipped; later batches may release',
      'plan.reason.task_paused': 'This item is paused',
      'plan.reason.plan_paused': 'The whole plan is paused',
      'plan.reason.execution_outcome_unknown': 'Previous outcome unknown; reconcile before continuing',
      'plan.blockers': 'Blocked by',
      'plan.blocker.execution_outcome_unknown': 'Previous outcome unknown; the slot stays held',
      'plan.blocker.removed': 'Removed from the plan',
      'plan.blocker.skipped': 'Explicitly skipped',
      'plan.blocker.task_running': 'This task is currently running and cannot be treated as idle',
      'plan.blocker.plan_paused': 'The whole plan is paused',
      'plan.blocker.item_paused': 'This item is paused',
      'plan.blocker.authorization_disabled': 'Auto resume is not authorized (this build never authorizes it)',
      'plan.blocker.quota_scope_unbound': 'No quota scope is bound',
      'plan.scope.unavailable': 'The Host holds no verified quota account scope, so auto-resume cannot be enabled',
      'plan.scope.bound': 'Bound to the Host\'s fixed quota scope (read-only source)',
      'plan.blocker.execution_capability_missing': 'Execution is not connected',
      'plan.blocker.earlier_batch_incomplete': 'An earlier batch has not fully succeeded',
      'notice.ambiguous': 'The previous request outcome is unknown and may already have applied; read the current state',
      'notice.unresolvedPrevious': 'A previous submission had an unknown outcome; a new request was started for the changed content',
      'error.generic': 'The operation failed; local state was not changed and the outcome may be unknown',
      'error.transport_error': 'The host connection failed; the outcome is unknown - read the current state to confirm',
      'error.protocol_error': 'The host payload did not match the contract; the outcome is unknown - read the current state to confirm',
      'error.request_failed': 'The host returned an unrecognized error; the outcome is unknown - read the current state to confirm',
      'error.internal': 'The host failed internally; the outcome is unknown - retry or read the current state',
      'error.capability_missing': 'A required host capability is missing; nothing ran',
      'error.configuration_incomplete': 'Configuration is incomplete; nothing ran',
      'error.invalid_input': 'Input is missing or invalid',
      'error.unsupported_operation': 'The host does not support this operation',
      'error.not_remote': 'This operation is only available over the authenticated Connection Remote',
      'error.invalid_invocation': 'The Remote invocation is missing required identity',
      'error.authorization_denied': 'Authorization denied: only the user may start this operation',
      'error.workspace_unavailable': 'The selected workspace is not registered or is currently unavailable; nothing ran',
      'error.route_unavailable': 'The selected route is not one of the fixed routes configured on the host',
      'error.request_conflict': 'The same requestId was already used with different content; nothing was submitted twice',
      'error.persistence_failed': 'The queue snapshot could not be persisted reliably; dispatch stays stopped',
      'error.not_found': 'The target task was not found',
      'error.not_editable': 'Only an unstarted manual task can be edited',
      'error.not_cancellable': 'Only a queued or pending task can be cancelled',
      'error.revision_conflict': 'The queue or plan changed underneath this operation; refresh and retry',
      'error.task_not_recoverable': 'The selected task is not a recoverable scope (for example, it already completed); nothing was added',
      'error.plan_conflict': 'This task identity is already in the ordering plan (including removed history); there is no restore operation yet',
      'error.unavailable': 'The queue service is closed',
      'error.cancelled': 'The call was cancelled before it completed; the outcome is unknown',
      'error.closed': 'The plugin is closed',
      'error.busy': 'The previous operation is still running',
      'a11y.queueList': 'Quota queue task list',
      'a11y.notice': 'Operation result',
      'a11y.error': 'Error',
      'a11y.pending': 'In progress',
      'a11y.switch': 'switch'
    };

    function interpolate(text, params) {
      if (typeof text !== 'string') return '';
      if (!params) return text;
      var out = text;
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        var token = '{' + keys[i] + '}';
        out = out.split(token).join(String(params[keys[i]]));
      }
      return out;
    }

    function fallbackT(key, params) {
      var text = en[key];
      if (typeof text !== 'string') text = key;
      return interpolate(text, params);
    }

    // ------------------------------------------------------------------
    // Pure helpers (no I/O, no host)
    // ------------------------------------------------------------------

    function isPlainObject(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      var proto = Object.getPrototypeOf(value);
      if (proto === null) return true;
      // Cross-realm safe: Object.prototype of ANY realm is itself prototyped by
      // null, while a class/array/Map instance is not. This keeps the projection
      // strict without rejecting a payload that reached us from another realm.
      return Object.getPrototypeOf(proto) === null;
    }

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    function nonEmptyString(value) {
      return typeof value === 'string' && value.trim().length > 0 ? value : null;
    }

    function sanitizeText(value, maxLen) {
      if (typeof value !== 'string') return null;
      var out = '';
      for (var i = 0; i < value.length && out.length < maxLen; i++) {
        var c = value.charCodeAt(i);
        if (c === 10 || c === 13 || c === 9) { out = out + ' '; continue; }
        if (c < 32 || c === 127) continue;
        out = out + value.charAt(i);
      }
      return out.trim();
    }

    function optionalString(raw, maxLen) {
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== 'string') return undefined;
      return sanitizeText(raw, maxLen);
    }

    /**
     * Verbatim optional string. Manual task content (title, prompt) must survive
     * the round trip unchanged: a display sanitizer must never rewrite a task
     * body that the user may later edit and submit.
     */
    function optionalRawString(raw) {
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== 'string') return undefined;
      return raw;
    }

    /** Stable, order-independent JSON of a request payload for transaction identity. */
    function stableStringify(value) {
      if (Array.isArray(value)) {
        var items = [];
        for (var i = 0; i < value.length; i++) items.push(stableStringify(value[i]));
        return '[' + items.join(',') + ']';
      }
      if (isPlainObject(value)) {
        var keys = Object.keys(value).sort();
        var parts = [];
        for (var j = 0; j < keys.length; j++) parts.push(JSON.stringify(keys[j]) + ':' + stableStringify(value[keys[j]]));
        return '{' + parts.join(',') + '}';
      }
      return JSON.stringify(value === undefined ? null : value);
    }

    function projectStringList(raw, maxItems, maxLen) {
      if (!Array.isArray(raw)) return null;
      var out = [];
      for (var i = 0; i < raw.length && out.length < maxItems; i++) {
        if (typeof raw[i] !== 'string') return null;
        var text = sanitizeText(raw[i], maxLen);
        if (text !== null && text.length > 0) out.push(text);
      }
      return out;
    }

    function localizedError(t, code) {
      var key = 'error.' + String(code || 'generic').toLowerCase();
      var text = t(key);
      if (typeof text !== 'string' || text === key) text = t('error.generic');
      return text;
    }

    function normalizeErrorCode(value) {
      if (typeof value !== 'string') return 'request_failed';
      var code = value.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(ERROR_CODE_ALIASES, code)) return ERROR_CODE_ALIASES[code];
      return KNOWN_ERROR_CODES[code] === 1 ? code : 'request_failed';
    }

    /**
     * A full, collision-resistant request id. Retry dedupe depends on its
     * uniqueness, so this is the complete UUID rather than an abbreviation.
     */
    function makeRequestId(sequence) {
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
          return crypto.randomUUID();
        }
      } catch (error) { /* fall through to the entropy fallback */ }
      return 'qq-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffffffff).toString(36) + '-' + sequence.toString(36);
    }

    /**
     * Codes that mean "the Host may or may not have applied this mutation".
     * Besides transport/protocol failures this includes the Host internal and
     * unknown-code fallback (request_failed): a mutation can commit and then
     * fail while the response View is built, so the same requestId must be kept
     * for a retry instead of minting a new one and queueing twice. 'cancelled'
     * is treated the same way because cancellation can race a commit.
     */
    function isAmbiguousCode(code) {
      return code === 'transport_error'
        || code === 'protocol_error'
        || code === 'request_failed'
        || code === 'internal'
        || code === 'cancelled';
    }

    /** Compatibility helper: legacy task editing is permanently retired. */
    function canEditTask() { return false; }

    // ------------------------------------------------------------------
    // Schema projection defense (Host View -> safe UI model)
    // ------------------------------------------------------------------

    function projectFailure(reason) {
      return { ok: false, error: { code: 'protocol_error', detail: reason } };
    }

    function projectTask(raw) {
      if (!isPlainObject(raw)) return null;
      var id = nonEmptyString(raw.id);
      if (id === null) return null;
      if (!TASK_KIND_SET.has(raw.kind)) return null;
      if (!TASK_STATUS_SET.has(raw.status)) return null;
      if (typeof raw.title !== 'string') return null;
      var provider = nonEmptyString(raw.provider);
      var model = nonEmptyString(raw.model);
      var workspaceId = nonEmptyString(raw.workspaceId);
      if (provider === null || model === null || workspaceId === null) return null;
      var attempts = (Number.isInteger(raw.attempts) && raw.attempts >= 0) ? raw.attempts : 0;

      var prompt = optionalRawString(raw.prompt);
      if (prompt === undefined) return null;
      var workspacePathSnapshot = optionalString(raw.workspacePathSnapshot, 1024);
      if (workspacePathSnapshot === undefined) return null;
      var routeId = optionalString(raw.routeId, 256);
      if (routeId === undefined) return null;
      var sessionId = optionalString(raw.sessionId, 256);
      if (sessionId === undefined) return null;
      var nextCheckAt = optionalString(raw.nextCheckAt, 64);
      if (nextCheckAt === undefined) return null;
      if (nextCheckAt !== null && !isFinite(Date.parse(nextCheckAt))) nextCheckAt = null;
      var reason = optionalString(raw.reason, 160);
      if (reason === undefined) reason = null;
      if (raw.kind === 'resume-session') {
        // The resume task must never carry the original prompt through the UI.
        prompt = null;
      }
      // All legacy rows are historical; old Host editability is not authority.
      var editable = false;
      return {
        id: id,
        kind: raw.kind,
        title: raw.title,
        prompt: prompt,
        editable: editable,
        promptOverflow: typeof prompt === 'string' && prompt.length > MAX_FIELD_LEN,
        workspaceId: workspaceId,
        workspacePathSnapshot: workspacePathSnapshot,
        routeId: routeId,
        provider: provider,
        model: model,
        status: raw.status,
        reason: reason,
        sessionId: sessionId,
        nextCheckAt: nextCheckAt,
        attempts: attempts
      };
    }

    function projectWorkspace(raw) {
      if (!isPlainObject(raw)) return null;
      var id = nonEmptyString(raw.id);
      if (id === null) return null;
      var path = typeof raw.path === 'string' ? raw.path : '';
      var name = nonEmptyString(raw.name);
      return {
        id: id,
        name: name === null ? id : name,
        path: path,
        available: raw.available === true
      };
    }

    function projectRoute(raw) {
      if (!isPlainObject(raw)) return null;
      var id = nonEmptyString(raw.id);
      var provider = nonEmptyString(raw.provider);
      var model = nonEmptyString(raw.model);
      if (id === null || provider === null || model === null) return null;
      var label = nonEmptyString(raw.label);
      var reason = optionalString(raw.reason, 160);
      return {
        id: id,
        label: label === null ? id : label,
        provider: provider,
        model: model,
        // available = verified executable. selectable = may still be chosen to
        // save a not-executed task; a Host that does not project it falls back
        // to available (never inventing selectability).
        available: raw.available === true,
        selectable: typeof raw.selectable === 'boolean' ? raw.selectable : raw.available === true,
        reason: reason === undefined ? null : reason
      };
    }

    /** Optional Host list hints, never an execution or selection grant. */
    function projectExistingTasks(raw) {
      if (raw === undefined) return { available: false, reason: 'session_registry_unavailable', items: [] };
      if (!isPlainObject(raw) || typeof raw.available !== 'boolean' || !Array.isArray(raw.items)) return null;
      if (raw.reason !== null && typeof raw.reason !== 'string') return null;
      var items = [];
      var seen = new Set();
      for (var i = 0; i < raw.items.length; i++) {
        var item = raw.items[i];
        if (!isPlainObject(item) || nonEmptyString(item.sessionId) === null || typeof item.title !== 'string') return null;
        if (item.workspacePath !== null && typeof item.workspacePath !== 'string') return null;
        if (typeof item.running !== 'boolean' || (item.source !== 'cached' && item.source !== 'sequenced')) return null;
        if (!Number.isInteger(item.asOfSeq) || item.asOfSeq < 0 || item.selectable !== false || item.reason !== 'task_execution_identity_unverified') return null;
        if (seen.has(item.sessionId)) return null;
        seen.add(item.sessionId);
        items.push({ sessionId: item.sessionId, title: sanitizeText(item.title, 200), workspacePath: item.workspacePath === null ? null : sanitizeText(item.workspacePath, 1024), running: item.running, source: item.source, asOfSeq: item.asOfSeq, selectable: false, reason: 'task_execution_identity_unverified' });
      }
      var safeReasons = ['session_registry_unavailable', 'existing_task_list_failed', 'existing_task_list_invalid', 'cancelled'];
      return { available: raw.available, reason: raw.reason === null ? null : (safeReasons.indexOf(raw.reason) >= 0 ? raw.reason : 'existing_task_list_invalid'), items: items };
    }

    /**
     * Strict projection of the editable ordering plan.
     *
     * Authorization is never accepted from the Host: an item that claims it is
     * enabled rejects the payload. Batch ids must be an exact partition of the
     * item ids, so the UI can never render a phantom or duplicated entry.
     */
    function projectRecoveryPlan(raw) {
      var unavailable = {
        available: false, editable: false, reason: 'recovery_plan_unavailable',
        revision: 0, maxConcurrent: 1, paused: true, batches: [], items: []
      };
      if (raw === undefined) return unavailable;
      if (!isPlainObject(raw) || typeof raw.available !== 'boolean' || typeof raw.editable !== 'boolean') return null;
      if (raw.reason !== null && PLAN_AVAILABILITY_REASONS.indexOf(raw.reason) < 0) return null;
      if (!raw.available && raw.editable) return null;
      if (!Number.isInteger(raw.revision) || raw.revision < 0) return null;
      if (!Number.isInteger(raw.maxConcurrent) || raw.maxConcurrent < 1 || raw.maxConcurrent > 8) return null;
      if (typeof raw.paused !== 'boolean' || !Array.isArray(raw.batches) || !Array.isArray(raw.items)) return null;
      if (raw.items.length > MAX_PLAN_ITEMS || raw.batches.length > MAX_PLAN_BATCHES) return null;
      var items = [];
      var byId = {};
      for (var i = 0; i < raw.items.length; i++) {
        var item = raw.items[i];
        if (!isPlainObject(item)) return null;
        var itemId = nonEmptyString(item.id);
        var sessionId = nonEmptyString(item.sessionId);
        if (itemId === null || sessionId === null || byId[itemId] === true) return null;
        if (typeof item.title !== 'string') return null;
        if (item.workspacePath !== null && typeof item.workspacePath !== 'string') return null;
        if (!Number.isInteger(item.batchIndex) || item.batchIndex < 0) return null;
        if (PLAN_STATUSES.indexOf(item.status) < 0) return null;
        if (PLAN_REASONS.indexOf(item.reason) < 0) return null;
        if (typeof item.paused !== 'boolean' || typeof item.removed !== 'boolean' || typeof item.skipped !== 'boolean') return null;
        if (typeof item.executionHeld !== 'boolean' || !Number.isInteger(item.attempts) || item.attempts < 0) return null;
        // The Host reports the persisted authorization so both surfaces can
        // render the same fact. Anything but a real boolean, or an
        // authorization without a bound account scope, rejects the payload.
        if (typeof item.authorizationEnabled !== 'boolean') return null;
        var scopeBound = item.quotaScopeBound === undefined ? false : item.quotaScopeBound;
        if (typeof scopeBound !== 'boolean') return null;
        if (item.authorizationEnabled && item.quotaScopeBound !== true) return null;
        // Read-only diagnostic; an older Host may omit it, but a present list
        // must use the fixed vocabulary (no raw reasons from the Host).
        var blockers = item.blockers === undefined ? [] : item.blockers;
        if (!Array.isArray(blockers) || blockers.length > PLAN_BLOCKERS.length) return null;
        for (var blockerIndex = 0; blockerIndex < blockers.length; blockerIndex++) {
          if (PLAN_BLOCKERS.indexOf(blockers[blockerIndex]) < 0) return null;
        }
        byId[itemId] = true;
        items.push({
          id: itemId,
          sessionId: sessionId,
          title: sanitizeText(item.title, 200),
          workspacePath: item.workspacePath === null ? null : sanitizeText(item.workspacePath, 1024),
          batchIndex: item.batchIndex,
          status: item.status,
          paused: item.paused,
          removed: item.removed,
          skipped: item.skipped,
          authorizationEnabled: item.authorizationEnabled,
          quotaScopeBound: scopeBound,
          executionHeld: item.executionHeld,
          attempts: item.attempts,
          reason: item.reason,
          blockers: blockers.slice()
        });
      }
      var batches = [];
      var listed = {};
      var seen = 0;
      for (var b = 0; b < raw.batches.length; b++) {
        var batch = raw.batches[b];
        if (!Array.isArray(batch) || batch.length === 0) return null;
        var ids = [];
        for (var c = 0; c < batch.length; c++) {
          var id = nonEmptyString(batch[c]);
          if (id === null || byId[id] !== true || listed[id] === true) return null;
          listed[id] = true;
          seen += 1;
          ids.push(id);
        }
        batches.push(ids);
      }
      if (seen !== items.length) return null;
      for (var d = 0; d < items.length; d++) {
        var index = -1;
        for (var e = 0; e < batches.length; e++) {
          if (batches[e].indexOf(items[d].id) >= 0) { index = e; break; }
        }
        if (index !== items[d].batchIndex) return null;
      }
      return {
        available: raw.available,
        editable: raw.editable,
        reason: raw.reason,
        revision: raw.revision,
        maxConcurrent: raw.maxConcurrent,
        paused: raw.paused,
        batches: batches,
        items: items
      };
    }

    /**
     * Strict projection of the optional last quota check. The Host never sends
     * the management key, and any unrecognized state or reason rejects the
     * payload rather than being displayed as quota evidence.
     */
    function projectQuota(raw) {
      const unavailable = {
        configured: false, state: null, remaining: null, weeklyRemaining: null,
        fiveHourRemaining: null, resetAt: null, observedAt: null, reasons: []
      };
      if (raw === undefined) return unavailable;
      if (!isPlainObject(raw) || typeof raw.configured !== 'boolean') return null;
      if (raw.state !== null && QUOTA_STATES.indexOf(raw.state) < 0) return null;
      for (const key of ['remaining', 'weeklyRemaining', 'fiveHourRemaining']) {
        const value = raw[key];
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) return null;
      }
      for (const key of ['resetAt', 'observedAt']) {
        const value = raw[key];
        if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) return null;
      }
      if (!Array.isArray(raw.reasons) || raw.reasons.length > 8) return null;
      for (const reason of raw.reasons) {
        if (typeof reason !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(reason)) return null;
      }
      return {
        configured: raw.configured,
        state: raw.state,
        remaining: raw.remaining,
        weeklyRemaining: raw.weeklyRemaining,
        fiveHourRemaining: raw.fiveHourRemaining,
        resetAt: raw.resetAt,
        observedAt: raw.observedAt,
        reasons: raw.reasons.slice()
      };
    }

    /** Legacy fields follow the legacy revision; the plan follows its own. */
    function mergeViews(current, incoming) {
      if (!current) return incoming;
      var incomingPlan = incoming.recoveryPlan;
      var currentPlan = current.recoveryPlan;
      if (!isPlainObject(incomingPlan) || !isPlainObject(currentPlan)) {
        return incoming.revision >= current.revision ? incoming : current;
      }
      var base = incoming.revision >= current.revision ? incoming : current;
      var plan = incomingPlan.revision >= currentPlan.revision ? incomingPlan : currentPlan;
      if (base === incoming && plan === incoming.recoveryPlan) return incoming;
      var out = {};
      for (var key in base) out[key] = base[key];
      out.recoveryPlan = plan;
      return out;
    }

    /**
     * Projection of the automatic-continuation state. It is a read-only
     * diagnostic: no prompt, no error body and no credential ever crosses the
     * wire here. An older Host that omits the member is reported as disabled.
     */
    function projectAutoContinue(raw) {
      if (raw === undefined) return { enabled: false, owner: 'disabled', tickets: [] };
      if (!isPlainObject(raw) || typeof raw.enabled !== 'boolean') return null;
      var owner = typeof raw.owner === 'string' && AUTO_CONTINUE_OWNERS.indexOf(raw.owner) >= 0 ? raw.owner : 'disabled';
      var list = raw.tickets === undefined ? [] : raw.tickets;
      if (!Array.isArray(list) || list.length > 20) return null;
      var tickets = [];
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (!isPlainObject(entry)) return null;
        var sessionId = nonEmptyString(entry.sessionId);
        if (sessionId === null) return null;
        if (AUTO_CONTINUE_STATES.indexOf(entry.state) < 0) return null;
        var reason = typeof entry.reason === 'string' && entry.reason.length > 0 && entry.reason.length <= 64
          && /^[a-z0-9_]+$/.test(entry.reason) ? entry.reason : null;
        var failureClass = typeof entry.failureClass === 'string' && /^(network|rate_limit|quota)$/.test(entry.failureClass)
          ? entry.failureClass : null;
        tickets.push({
          sessionId: sessionId,
          state: entry.state,
          reason: reason,
          failureClass: failureClass,
          attempt: Number.isSafeInteger(entry.attempt) && entry.attempt >= 0 ? entry.attempt : 0,
          nextAt: Number.isSafeInteger(entry.nextAt) && entry.nextAt >= 0 ? entry.nextAt : null
        });
      }
      return { enabled: raw.enabled, owner: owner, tickets: tickets };
    }
    function projectSessionOptIns(raw) {
      var out = {};
      if (!isPlainObject(raw)) return out;
      var keys = Object.keys(raw);
      for (var i = 0; i < keys.length; i++) {
        if (raw[keys[i]] === true) out[keys[i]] = true;
      }
      return out;
    }

    /**
     * Strict projection of the Host View. Any structural violation rejects the
     * whole payload (the UI keeps its previous state instead of showing a
     * fabricated one). Unknown members - including credentialRef, raw errors and
     * request headers - are dropped, never echoed.
     */
    function projectView(raw) {
      if (!isPlainObject(raw)) return projectFailure('view_not_object');
      if (raw.version !== VIEW_VERSION) return projectFailure('version');
      if (!Number.isInteger(raw.revision) || raw.revision < 0) return projectFailure('revision');
      if (typeof raw.paused !== 'boolean') return projectFailure('paused');
      if (!isPlainObject(raw.configuration) || typeof raw.configuration.ready !== 'boolean') return projectFailure('configuration');
      var reasons = projectStringList(raw.configuration.reasons, 8, 160);
      if (reasons === null) return projectFailure('configuration_reasons');
      var caps = isPlainObject(raw.capabilities) ? raw.capabilities : {};
      var capabilities = {
        // Absent or non-boolean capability is false, and nothing can flip it true.
        quotaCheck: caps.quotaCheck === true,
        execution: caps.execution === true,
        autoResume: caps.autoResume === true
      };
      if (!Array.isArray(raw.tasks)) return projectFailure('tasks');
      var tasks = [];
      for (var i = 0; i < raw.tasks.length; i++) {
        var task = projectTask(raw.tasks[i]);
        if (task === null) return projectFailure('task_' + i);
        tasks.push(task);
      }
      if (!Array.isArray(raw.workspaces)) return projectFailure('workspaces');
      var workspaces = [];
      for (var j = 0; j < raw.workspaces.length; j++) {
        var workspace = projectWorkspace(raw.workspaces[j]);
        if (workspace === null) return projectFailure('workspace_' + j);
        workspaces.push(workspace);
      }
      if (!Array.isArray(raw.routes)) return projectFailure('routes');
      var routes = [];
      for (var k = 0; k < raw.routes.length; k++) {
        var route = projectRoute(raw.routes[k]);
        if (route === null) return projectFailure('route_' + k);
        routes.push(route);
      }
      var existingTasks = projectExistingTasks(raw.existingTasks);
      if (existingTasks === null) return projectFailure('existing_tasks');
      var recoveryPlan = projectRecoveryPlan(raw.recoveryPlan);
      if (recoveryPlan === null) return projectFailure('recovery_plan');
      var quota = projectQuota(raw.quota);
      if (quota === null) return projectFailure('quota');
      var autoContinue = projectAutoContinue(raw.autoContinue);
      if (autoContinue === null) return projectFailure('auto_continue');
      // Read-only diagnostic from a compiled Host constant; absent on old Hosts.
      // Never truncate or sanitize a version: a rewritten version proves nothing.
      var runtimeVersion = null;
      if (raw.runtimeVersion !== undefined && raw.runtimeVersion !== null) {
        if (typeof raw.runtimeVersion !== 'string' || raw.runtimeVersion.length > 64
          || raw.runtimeVersion.trim() !== raw.runtimeVersion
          || /[\u0000-\u001f\u007f]/.test(raw.runtimeVersion)) {
          return projectFailure('runtime_version');
        }
        runtimeVersion = raw.runtimeVersion;
      }
      return {
        ok: true,
        view: {
          existingTasks: existingTasks,
          recoveryPlan: recoveryPlan,
          quota: quota,
          autoContinue: autoContinue,
          runtimeVersion: runtimeVersion,
          version: VIEW_VERSION,
          revision: raw.revision,
          paused: raw.paused,
          configuration: { ready: raw.configuration.ready === true, reasons: reasons },
          capabilities: capabilities,
          tasks: tasks,
          workspaces: workspaces,
          routes: routes,
          sessionOptIns: projectSessionOptIns(raw.sessionOptIns),
          quotaScopeId: typeof raw.quotaScopeId === 'string' && raw.quotaScopeId.length > 0
            && raw.quotaScopeId.length <= 200 ? raw.quotaScopeId : null
        }
      };
    }

    // ------------------------------------------------------------------
    // Request construction + transport (Connection RPC only)
    // ------------------------------------------------------------------

    function buildRequest(op, payload, requestId) {
      // Retired operations cannot reach the transport, even through old callers.
      if (op === 'addManual' || op === 'editPending') return { ok: false, error: { code: 'capability_missing' } };
      // The Host decides whether the HOT adapter is mounted; the client only
      // sends the user's explicit boolean for this session.
      if (op === 'setSessionOptIn' && (!isPlainObject(payload) || typeof payload.enabled !== 'boolean')) return { ok: false, error: { code: 'invalid_input' } };
      var spec = hasOwn(OP_FIELDS, op) ? OP_FIELDS[op] : undefined;
      if (spec === undefined) return { ok: false, error: { code: 'invalid_input' } };
      var body = isPlainObject(payload) ? payload : {};
      var required = spec.required || [];
      var optional = spec.optional || [];
      var allowed = {};
      var i;
      for (i = 0; i < required.length; i++) allowed[required[i]] = true;
      for (i = 0; i < optional.length; i++) allowed[optional[i]] = true;
      var keys = Object.keys(body);
      for (i = 0; i < keys.length; i++) {
        if (allowed[keys[i]] !== true) return { ok: false, error: { code: 'invalid_input' } };
      }
      var out = {};
      for (i = 0; i < required.length; i++) {
        var name = required[i];
        var value = body[name];
        if (value === undefined || value === null) return { ok: false, error: { code: 'invalid_input' } };
        if (spec.types && spec.types[name] === 'boolean') {
          if (typeof value !== 'boolean') return { ok: false, error: { code: 'invalid_input' } };
          out[name] = value;
        } else if (spec.types && spec.types[name] === 'true') {
          // A confirmation must be the literal boolean true, never a truthy text.
          if (value !== true) return { ok: false, error: { code: 'invalid_input' } };
          out[name] = true;
        } else if (spec.types && spec.types[name] === 'integer') {
          if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: { code: 'invalid_input' } };
          out[name] = value;
        } else if (spec.types && spec.types[name] === 'concurrency') {
          if (!Number.isSafeInteger(value) || value < 1 || value > 8) return { ok: false, error: { code: 'invalid_input' } };
          out[name] = value;
        } else {
          if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, error: { code: 'invalid_input' } };
          // Never silently truncate task content: an over-long field is refused.
          if (value.length > MAX_FIELD_LEN) return { ok: false, error: { code: 'invalid_input' } };
          out[name] = value;
        }
      }
      for (i = 0; i < optional.length; i++) {
        var oname = optional[i];
        if (body[oname] === undefined || body[oname] === null) continue;
        if (typeof body[oname] !== 'string' || body[oname].trim().length === 0) return { ok: false, error: { code: 'invalid_input' } };
        if (body[oname].length > MAX_FIELD_LEN) return { ok: false, error: { code: 'invalid_input' } };
        out[oname] = body[oname];
      }
      return {
        ok: true,
        request: { version: REQUEST_VERSION, op: op, requestId: requestId, payload: out }
      };
    }

    function resolveRpc(ctx) {
      var connection = ctx && ctx.connection;
      var rpc = connection && connection.rpc;
      return (rpc && typeof rpc.call === 'function') ? rpc : null;
    }

    /**
     * Decode the two contract layers: the Connection envelope
     * ({ok:true,value}|{ok:false,error}) and the Host application result
     * ({ok:true,data}|{ok:false,error:{code,message}}). Host message text is
     * normalized to a whitelisted code; the original text is never returned.
     */
    async function dispatchCall(rpc, request, signal) {
      var transport;
      try {
        // Verified Gateway wire: the payload has exactly one 'args' key and the
        // Host method parameter is named 'request'
        // (dsh-api-gateway/lib/index.js:1229 remoteRequest, :970 resolveParameter
        // by parameter name). Therefore args = { request }.
        transport = await rpc.call(CHANNEL, ENDPOINT, { args: { request: request } }, signal);
      } catch (error) {
        return { ok: false, error: { code: 'transport_error' } };
      }
      if (!isPlainObject(transport)) return { ok: false, error: { code: 'protocol_error' } };
      if (transport.ok === false) return { ok: false, error: { code: normalizeErrorCode(transport.error && transport.error.code) } };
      if (transport.ok !== true) return { ok: false, error: { code: 'protocol_error' } };
      var app = transport.value;
      if (!isPlainObject(app)) return { ok: false, error: { code: 'protocol_error' } };
      if (app.ok === false) return { ok: false, error: { code: normalizeErrorCode(app.error && app.error.code) } };
      // Every operation answers with {ok:true,data:View}. A bare View, a missing
      // data member or a null payload is NOT success: a mutation that cannot be
      // confirmed by a persisted View must never be reported as saved.
      if (app.ok !== true || !hasOwn(app, 'data') || !isPlainObject(app.data)) {
        return { ok: false, error: { code: 'protocol_error' } };
      }
      var projected = projectView(app.data);
      if (!projected.ok) return { ok: false, error: { code: 'protocol_error' } };
      return { ok: true, view: projected.view };
    }

    // ------------------------------------------------------------------
    // Controller (state + orchestration; framework-agnostic, testable)
    // ------------------------------------------------------------------

    function createStore(initial) {
      var snapshot = initial;
      var listeners = new Set();
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        set: function (next) {
          snapshot = next;
          var copy = Array.from(listeners);
          for (var i = 0; i < copy.length; i++) {
            try { copy[i](); } catch (error) { reportIsolated(error); }
          }
        }
      };
    }

    function reportIsolated(error) {
      try { if (typeof console !== 'undefined' && console && console.error) console.error('[quota-queue]', error); } catch (ignored) { /* never rethrow */ }
    }

    function createController(ctx, options) {
      var opts = options || {};
      var scheduler = opts.scheduler || { setTimeout: setTimeout, clearTimeout: clearTimeout };
      var now = opts.now || function () { return Date.now(); };
      var t = typeof opts.t === 'function' ? opts.t : fallbackT;

      var store = createStore({
        phase: 'idle',
        view: null,
        error: null,
        notice: null,
        warning: null,
        pending: {},
        sessions: [],
        hasTransport: false,
        lastUpdatedAt: null,
        planConfirmId: null,
        closed: false
      });

      var inflight = new Map();
      // Pending-key -> {requestId, signature} for submissions whose outcome is
      // unknown; a same-payload retry reuses the requestId, a changed payload
      // starts a new transaction and reports the unresolved one.
      var unresolved = new Map();
      var timer = null;
      var sessionUnsub = null;
      var closed = false;
      var started = false;
      var requestCounter = 0;

      function patch(partial) {
        var current = store.getSnapshot();
        var next = {};
        for (var key in current) next[key] = current[key];
        for (var key2 in partial) next[key2] = partial[key2];
        store.set(next);
      }

      function setPending(key, value) {
        var current = store.getSnapshot().pending;
        var next = {};
        for (var existing in current) next[existing] = current[existing];
        if (value) next[key] = true; else delete next[key];
        patch({ pending: next });
      }

      function fail(code) {
        return { ok: false, error: { code: code, message: code } };
      }

      function publishError(code) {
        var safe = normalizeErrorCode(code);
        patch({ error: { code: safe, message: safe }, notice: { kind: 'error', text: localizedError(t, safe) } });
      }

      function readSessions() {
        var sessions = (typeof ctx.get === 'function') ? ctx.get('sessions') : undefined;
        var list = sessions && sessions.list;
        if (!list || typeof list.getSnapshot !== 'function') return [];
        var snapshot = list.getSnapshot();
        if (!isPlainObject(snapshot) || !Array.isArray(snapshot.ids) || !isPlainObject(snapshot.byId)) return [];
        var out = [];
        for (var i = 0; i < snapshot.ids.length && out.length < 200; i++) {
          var id = snapshot.ids[i];
          var row = snapshot.byId[id];
          if (typeof id !== 'string' || !isPlainObject(row)) continue;
          out.push({
            id: id,
            title: (typeof row.displayTitle === 'string' && row.displayTitle.length > 0) ? sanitizeText(row.displayTitle, 200) : id,
            running: row.running === true,
            cwd: typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : null
          });
        }
        return out;
      }

      function attachSessions() {
        patch({ sessions: readSessions() });
        var sessions = (typeof ctx.get === 'function') ? ctx.get('sessions') : undefined;
        var list = sessions && sessions.list;
        if (list && typeof list.subscribe === 'function') {
          sessionUnsub = list.subscribe(function () { if (!closed) patch({ sessions: readSessions() }); });
        }
      }

      function clearTimer() {
        if (timer !== null) {
          scheduler.clearTimeout(timer);
          timer = null;
        }
      }

      function scheduleNextCheck() {
        clearTimer();
        var view = store.getSnapshot().view;
        if (!view) return;
        var soonest = null;
        for (var i = 0; i < view.tasks.length; i++) {
          var value = view.tasks[i].nextCheckAt;
          if (typeof value !== 'string' || value.length === 0) continue;
          var ms = Date.parse(value);
          if (!isFinite(ms)) continue;
          if (soonest === null || ms < soonest) soonest = ms;
        }
        if (soonest === null) return;
        var delay = soonest - now();
        if (delay < 1000) delay = 1000;
        if (delay > 3600000) delay = 3600000;
        timer = scheduler.setTimeout(function () {
          timer = null;
          actions.refresh();
        }, delay);
      }

      function signatureOf(request) {
        return request.op + '|' + stableStringify(request.payload);
      }

      async function run(pendingKey, op, payload, successKey) {
        if (closed) return fail('closed');
        if (inflight.has(pendingKey)) return fail('busy');
        var rpc = resolveRpc(ctx);
        if (rpc === null) {
          publishError('capability_missing');
          patch({ hasTransport: false, phase: store.getSnapshot().view ? 'ready' : 'error' });
          return fail('capability_missing');
        }
        requestCounter += 1;
        var built = buildRequest(op, payload, makeRequestId(requestCounter));
        if (!built.ok) {
          publishError(built.error.code);
          return built;
        }
        var signature = signatureOf(built.request);
        var prior = unresolved.get(pendingKey);
        var superseding = false;
        if (prior) {
          if (prior.signature === signature) {
            // Same logical transaction: reuse its requestId so a retry after an
            // ambiguous failure dedupes on the Host instead of queueing twice.
            built.request.requestId = prior.requestId;
          } else {
            unresolved.delete(pendingKey);
            superseding = true;
          }
        }
        var controller = new AbortController();
        inflight.set(pendingKey, controller);
        setPending(pendingKey, true);
        patch({
          error: null,
          notice: null,
          warning: superseding ? t('notice.unresolvedPrevious') : null,
          hasTransport: true,
          phase: store.getSnapshot().view ? 'ready' : 'loading'
        });
        try {
          var result = await dispatchCall(rpc, built.request, controller.signal);
          if (closed) return fail('closed');
          if (!result.ok) {
            var code = normalizeErrorCode(result.error.code);
            var ambiguous = isAmbiguousCode(code);
            if (ambiguous) {
              // The Host may have persisted this; remember the exact request so a
              // same-payload retry reuses its requestId.
              unresolved.set(pendingKey, { requestId: built.request.requestId, signature: signature });
            } else {
              unresolved.delete(pendingKey);
            }
            publishError(code);
            patch(ambiguous
              ? { phase: store.getSnapshot().view ? 'ready' : 'error', warning: t('notice.ambiguous') }
              : { phase: store.getSnapshot().view ? 'ready' : 'error' });
            return { ok: false, error: { code: code, message: code, ambiguous: ambiguous } };
          }
          unresolved.delete(pendingKey);
          var next = { phase: 'ready', error: null, lastUpdatedAt: now(), warning: superseding ? t('notice.unresolvedPrevious') : null };
          var currentView = store.getSnapshot().view;
          // Never regress either revision because a slower response landed last:
          // legacy state follows the View revision, plan state its own revision.
          if (result.view) next.view = mergeViews(currentView, result.view);
          if (successKey) next.notice = { kind: 'success', text: t(successKey) };
          if (op.indexOf('plan') === 0) next.planConfirmId = null;
          patch(next);
          scheduleNextCheck();
          return { ok: true, view: store.getSnapshot().view };
        } catch (error) {
          unresolved.set(pendingKey, { requestId: built.request.requestId, signature: signature });
          publishError('transport_error');
          patch({ phase: store.getSnapshot().view ? 'ready' : 'error', warning: t('notice.ambiguous') });
          return { ok: false, error: { code: 'transport_error', message: 'transport_error', ambiguous: true } };
        } finally {
          inflight.delete(pendingKey);
          // A disposed plugin must not patch its store after the fact.
          if (!closed) setPending(pendingKey, false);
        }
      }

      var actions = {
        refresh: function () { return run('bootstrap', 'bootstrap', {}, null); },
        checkQuota: function () { return run('checkQuota', 'checkQuota', {}, 'notice.quotaRequested'); },
        setPaused: function (paused) {
          return run('pauseDispatch', 'pauseDispatch', { paused: paused === true }, paused ? 'notice.paused' : 'notice.resumed');
        },
        addManual: function () { return Promise.resolve(fail(closed ? 'closed' : 'capability_missing')); },
        editPending: function () { return Promise.resolve(fail(closed ? 'closed' : 'capability_missing')); },
        cancelQueued: function (id) { return run('cancel:' + String(id), 'cancelQueued', { id: id }, 'notice.cancelled'); },
        requestStop: function (id) { return run('stop:' + String(id), 'requestStop', { id: id }, 'notice.stopRequested'); },
        setSessionOptIn: function (sessionId, enabled) {
          if (closed) return Promise.resolve(fail('closed'));
          if (typeof enabled !== 'boolean') return Promise.resolve(fail('invalid_input'));
          return run('optIn:' + String(sessionId), 'setSessionOptIn', { sessionId: sessionId, enabled: enabled }, enabled ? 'notice.optInOn' : 'notice.optInOff');
        },
        // One authorization entry point for BOTH surfaces: the plan item and
        // the session opt-in are saved together, so the switch and the plan
        // can never disagree.
        planAuthorize: function (id, enabled) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var itemId = nonEmptyString(id);
          if (itemId === null || typeof enabled !== 'boolean') return Promise.resolve(fail('invalid_input'));
          return run('planAuthorize:' + itemId, 'planAuthorize', {
            id: itemId, enabled: enabled, expectedRevision: view.recoveryPlan.revision
          }, enabled ? 'notice.optInOn' : 'notice.optInOff');
        },
        /**
         * THE one entry point (the switch under the composer).
         *
         * On = the session joins the schedule plan (added, or restored if an
         * older build left a tombstone) and is then authorized; off = it leaves
         * the plan for real through the same removal the plan row uses. There is
         * no second switch: the plan row only reports the state.
         */
        setRecoverySwitch: function (sessionId, enabled) {
          if (closed) return Promise.resolve(fail('closed'));
          var sid = nonEmptyString(sessionId);
          if (sid === null || typeof enabled !== 'boolean') return Promise.resolve(fail('invalid_input'));
          var view = store.getSnapshot().view;
          if (!view) return Promise.resolve(fail('capability_missing'));
          var item = planItemForSession(view.recoveryPlan, sid);
          if (enabled) {
            if (item !== null) return actions.planAuthorize(item.id, true);
            return actions.queueAndAuthorize(sid);
          }
          if (item !== null) return actions.planRemove(item.id);
          // A legacy opt-in with no plan entry is still this switch's fact.
          return actions.setSessionOptIn(sid, false);
        },
        /** Queue first, then authorize through the item the Host just saved. */
        queueAndAuthorize: function (sessionId) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          return actions.planAdd(sessionId, view.recoveryPlan.batches.length).then(function (added) {
            if (!added || added.ok !== true) return added;
            var item = planItemForSession(added.view ? added.view.recoveryPlan : null, sessionId);
            if (item === null) return { ok: false, error: { code: 'protocol_error', message: 'protocol_error', ambiguous: false } };
            return actions.planAuthorize(item.id, true);
          });
        },
        planAdd: function (sessionId, batch) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var sid = nonEmptyString(sessionId);
          if (sid === null) return Promise.resolve(fail('invalid_input'));
          var target = Number.isSafeInteger(batch) && batch >= 0 ? batch : view.recoveryPlan.batches.length;
          return run('planAdd:' + sid, 'planAdd', {
            sessionId: sid, batch: target, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planAdded');
        },
        planConfigure: function (maxConcurrent) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          return run('planConfigure', 'planConfigure', {
            maxConcurrent: maxConcurrent, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        planSetPaused: function (paused) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          return run('planPause', 'planPause', {
            paused: paused === true, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        planItemPause: function (id, paused) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var itemId = nonEmptyString(id);
          if (itemId === null) return Promise.resolve(fail('invalid_input'));
          return run('planItem:' + itemId, 'planItemPause', {
            id: itemId, paused: paused === true, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        requestPlanSkip: function (id) {
          if (closed) return fail('closed');
          var itemId = nonEmptyString(id);
          if (itemId === null) return fail('invalid_input');
          patch({ planConfirmId: itemId });
          return { ok: true };
        },
        cancelPlanSkip: function () {
          if (!closed) patch({ planConfirmId: null });
          return { ok: true };
        },
        planRemove: function (id) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var itemId = nonEmptyString(id);
          if (itemId === null) return Promise.resolve(fail('invalid_input'));
          return run('planRemove:' + itemId, 'planRemove', {
            id: itemId, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        planSkip: function (id) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var itemId = nonEmptyString(id);
          if (itemId === null) return Promise.resolve(fail('invalid_input'));
          return run('planSkip:' + itemId, 'planSkip', {
            id: itemId, confirmed: true, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        planMove: function (id, batch, position) {
          if (closed) return Promise.resolve(fail('closed'));
          var view = store.getSnapshot().view;
          if (!view || view.recoveryPlan.editable !== true) return Promise.resolve(fail('capability_missing'));
          var itemId = nonEmptyString(id);
          if (itemId === null || !Number.isSafeInteger(batch) || batch < 0
            || !Number.isSafeInteger(position) || position < 0) return Promise.resolve(fail('invalid_input'));
          return run('planMove:' + itemId, 'planMove', {
            id: itemId, batch: batch, position: position, expectedRevision: view.recoveryPlan.revision
          }, 'notice.planUpdated');
        },
        dismissNotice: function () { if (!closed) patch({ notice: null }); },
        openPanel: function () {
          if (closed) return fail('closed');
          var layout = (typeof ctx.get === 'function') ? ctx.get('layout') : undefined;
          if (!layout || typeof layout.selectPanel !== 'function') {
            publishError('capability_missing');
            return fail('capability_missing');
          }
          try {
            layout.selectPanel(PANEL_ID);
            return { ok: true };
          } catch (error) {
            publishError('capability_missing');
            return fail('capability_missing');
          }
        },
        openSession: function (sessionId) {
          if (closed) return fail('closed');
          var sid = nonEmptyString(sessionId);
          if (sid === null) return fail('invalid_input');
          var navigation = (typeof ctx.get === 'function') ? ctx.get('uiWorkspace') : undefined;
          if (!navigation || typeof navigation.openSession !== 'function') {
            publishError('capability_missing');
            return fail('capability_missing');
          }
          try {
            navigation.openSession(sid);
            return { ok: true };
          } catch (error) {
            publishError('capability_missing');
            return fail('capability_missing');
          }
        }
      };

      function start() {
        if (closed || started) return;
        started = true;
        patch({ hasTransport: resolveRpc(ctx) !== null });
        attachSessions();
        actions.refresh();
      }

      function onConnectionReset() {
        if (closed) return;
        patch({ hasTransport: resolveRpc(ctx) !== null });
        actions.refresh();
      }

      function dispose() {
        if (closed) return;
        closed = true;
        clearTimer();
        if (sessionUnsub) {
          try { sessionUnsub(); } catch (error) { reportIsolated(error); }
          sessionUnsub = null;
        }
        var controllers = Array.from(inflight.values());
        inflight.clear();
        for (var i = 0; i < controllers.length; i++) {
          try { controllers[i].abort(); } catch (error) { reportIsolated(error); }
        }
        patch({ closed: true, pending: {}, planConfirmId: null });
      }

      return {
        store: store,
        actions: actions,
        start: start,
        dispose: dispose,
        onConnectionReset: onConnectionReset,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe
      };
    }

    // ------------------------------------------------------------------
    // Styles (host theme tokens only; no literal colors)
    // ------------------------------------------------------------------

    var TOKENS = {
      bgBase: 'var(--dsw-alias-bg-base)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelCaption: 'var(--dsw-alias-label-caption)',
      labelInverted: 'var(--dsw-alias-label-primary-inverted)',
      borderL2: 'var(--dsw-alias-border-l2)',
      link: 'var(--dsw-alias-link)',
      buttonElevatedFill: 'var(--dsw-alias-button-elevated-fill)',
      buttonPrimaryFill: 'var(--dsw-alias-button-primary-fill)',
      buttonPrimaryHover: 'var(--dsw-alias-button-primary-hover)',
      interactiveHover: 'var(--dsw-alias-interactive-bg-hover)',
      // error-secondary is the same value as error-primary in dark mode, so it is
      // deliberately not carried here: surfaces use bg-layer-1, text/border use primary.
      errorPrimary: 'var(--dsw-alias-state-error-primary)',
      warnPrimary: 'var(--dsw-alias-state-warn-primary)',
      warnTertiary: 'var(--dsw-alias-state-warn-tertiary)',
      warnLabel: 'var(--dsw-alias-state-warn-label)',
      successPrimary: 'var(--dsw-alias-state-success-primary)',
      successTertiary: 'var(--dsw-alias-state-success-tertiary)',
      focus: 'var(--dsw-alias-brand-primary)'
    };

    var S = {
      panel: { height: '100%', width: '100%', overflowY: 'auto', background: TOKENS.bgBase, color: TOKENS.labelPrimary, padding: '20px 24px', boxSizing: 'border-box', font: 'inherit' },
      header: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '12px', marginBottom: '4px' },
      h1: { fontSize: '18px', fontWeight: 600, margin: 0, color: TOKENS.labelPrimary },
      subtitle: { fontSize: '12px', color: TOKENS.labelCaption },
      section: { marginTop: '18px', border: '1px solid ' + TOKENS.borderL2, borderRadius: '10px', padding: '12px 14px', background: TOKENS.bgLayer1 },
      sectionTitle: { fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0', color: TOKENS.labelPrimary },
      row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      banner: { marginTop: '10px', borderRadius: '8px', padding: '8px 10px', fontSize: '12px', lineHeight: '1.5' },
      // Contrast rule: never pair a semantic primary with its own same-valued
      // secondary as background/foreground. Error has no tertiary token, so its
      // surface is the neutral layer with the semantic color only as text/border.
      bannerError: { background: TOKENS.bgLayer1, color: TOKENS.errorPrimary, border: '1px solid ' + TOKENS.errorPrimary },
      bannerWarn: { background: TOKENS.warnTertiary, color: TOKENS.warnLabel, border: '1px solid ' + TOKENS.warnPrimary },
      bannerOk: { background: TOKENS.successTertiary, color: TOKENS.successPrimary, border: '1px solid ' + TOKENS.successPrimary },
      task: { border: '1px solid ' + TOKENS.borderL2, borderRadius: '8px', padding: '10px 12px', marginTop: '8px', background: TOKENS.bgLayer2 },
      taskHead: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      taskTitle: { fontSize: '13px', fontWeight: 600, color: TOKENS.labelPrimary, margin: 0 },
      taskMeta: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '12px', color: TOKENS.labelSecondary, marginTop: '6px' },
      caption: { fontSize: '12px', color: TOKENS.labelCaption },
      badge: { display: 'inline-flex', alignItems: 'center', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', border: '1px solid ' + TOKENS.borderL2, color: TOKENS.labelSecondary, background: TOKENS.bgBase },
      badgeRunning: { borderColor: TOKENS.link, color: TOKENS.link },
      badgeAttention: { borderColor: TOKENS.warnPrimary, color: TOKENS.warnLabel },
      badgeError: { borderColor: TOKENS.errorPrimary, color: TOKENS.errorPrimary },
      dock: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', margin: '4px 0 0', padding: '4px 2px', fontSize: '12px', color: TOKENS.labelSecondary, background: 'transparent', border: 0 },
      dockSummary: { color: TOKENS.labelCaption },
    };

    function btnStyle(variant, hovered, focused, disabled) {
      var style = {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        borderRadius: '6px', border: '1px solid ' + TOKENS.borderL2,
        background: TOKENS.buttonElevatedFill, color: TOKENS.labelPrimary,
        padding: '5px 10px', fontSize: '12px', font: 'inherit', cursor: 'pointer'
      };
      if (variant === 'primary') {
        style.background = TOKENS.buttonPrimaryFill;
        style.color = TOKENS.labelInverted;
        style.border = '1px solid transparent';
      } else if (variant === 'danger') {
        // Neutral surface + error text/border: error-primary and error-secondary
        // are the same value in dark mode, so they must not be paired.
        style.background = TOKENS.bgLayer1;
        style.color = TOKENS.errorPrimary;
        style.border = '1px solid ' + TOKENS.errorPrimary;
      } else if (variant === 'link') {
        style.background = 'none';
        style.border = 'none';
        style.color = TOKENS.link;
        style.padding = '2px 4px';
        style.textDecoration = 'underline';
      }
      if (disabled) {
        style.opacity = '0.55';
        style.cursor = 'not-allowed';
      } else if (hovered) {
        style.background = variant === 'primary' ? TOKENS.buttonPrimaryHover : (variant === 'link' ? 'none' : TOKENS.interactiveHover);
      }
      if (focused && !disabled) {
        style.outline = '2px solid ' + TOKENS.focus;
        style.outlineOffset = '2px';
      }
      return style;
    }

    // ------------------------------------------------------------------
    // Shared presentational components
    // ------------------------------------------------------------------

    function Btn(props) {
      var state = React.useState(false);
      var hovered = state[0];
      var setHovered = state[1];
      var focusState = React.useState(false);
      var focused = focusState[0];
      var setFocused = focusState[1];
      var disabled = props.disabled === true || props.pending === true;
      var label = props.pending === true ? (props.pendingLabel || props.label) : props.label;
      return h('button', {
        type: 'button',
        ref: props.buttonRef,
        disabled: disabled,
        title: props.title,
        'aria-label': props.ariaLabel || props.label,
        'aria-busy': props.pending === true ? 'true' : undefined,
        onClick: function (event) { if (!disabled && typeof props.onClick === 'function') props.onClick(event); },
        onMouseEnter: function () { setHovered(true); },
        onMouseLeave: function () { setHovered(false); },
        onFocus: function () { setFocused(true); },
        onBlur: function () { setFocused(false); },
        style: btnStyle(props.variant, hovered, focused, disabled)
      }, label);
    }

    function Switch(props) {
      var state = React.useState(false);
      var focused = state[0];
      var setFocused = state[1];
      var checked = props.checked === true;
      var disabled = props.disabled === true || props.pending === true;
      var track = {
        position: 'relative', width: '34px', height: '18px', borderRadius: '999px',
        border: '1px solid ' + TOKENS.borderL2,
        background: checked ? TOKENS.buttonPrimaryFill : TOKENS.buttonElevatedFill,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? '0.55' : '1',
        padding: 0, flex: '0 0 auto'
      };
      var thumb = {
        position: 'absolute', top: '2px', left: checked ? '18px' : '2px', width: '12px', height: '12px',
        borderRadius: '999px', background: TOKENS.bgBase, transition: 'left 120ms ease'
      };
      if (focused && !disabled) {
        track.outline = '2px solid ' + TOKENS.focus;
        track.outlineOffset = '2px';
      }
      var button = h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': props.ariaLabel || props.label,
        disabled: disabled,
        title: props.title,
        onClick: function () { if (!disabled && typeof props.onChange === 'function') props.onChange(!checked); },
        onFocus: function () { setFocused(true); },
        onBlur: function () { setFocused(false); },
        style: track
      }, h('span', { style: thumb, 'aria-hidden': true }));
      // Tag it so callers can find the control without walking the tree.
      button.props['data-quota-switch'] = props.label;
      return button;
    }

    function Badge(props) {
      var style = S.badge;
      if (props.tone === 'running' || props.tone === 'ok') style = Object.assign({}, S.badge, S.badgeRunning);
      else if (props.tone === 'warn') style = Object.assign({}, S.badge, S.badgeAttention);
      else if (props.tone === 'error') style = Object.assign({}, S.badge, S.badgeError);
      return h('span', { style: style }, props.children);
    }

    function statusTone(status) {
      if (status === 'running') return 'running';
      if (status === 'needs_attention' || status === 'paused') return 'warn';
      if (status === 'failed') return 'error';
      if (status === 'completed') return 'ok';
      return 'neutral';
    }

    function kindLabel(t, kind) {
      return kind === 'resume-session' ? t('kind.resume') : t('kind.new');
    }

    function statusLabel(t, status) {
      var key = 'status.' + status;
      var text = t(key);
      return (typeof text === 'string' && text !== key) ? text : status;
    }

    function formatTime(value) {
      var ms = Date.parse(value);
      if (!isFinite(ms)) return null;
      try { return new Date(ms).toLocaleTimeString(); } catch (error) { return null; }
    }

    function workspacePathOf(task, view) {
      if (task.workspacePathSnapshot) return task.workspacePathSnapshot;
      for (var i = 0; i < view.workspaces.length; i++) {
        if (view.workspaces[i].id === task.workspaceId) {
          var path = view.workspaces[i].path;
          if (path && path.length > 0) return path;
        }
      }
      return task.workspaceId;
    }

    function useStoreSnapshot(store) {
      var state = React.useState(function () { return store.getSnapshot(); });
      var snapshot = state[0];
      var setSnapshot = state[1];
      React.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnapshot(store.getSnapshot()); };
        sync();
        var unsubscribe = store.subscribe(sync);
        return function () { alive = false; unsubscribe(); };
      }, [store]);
      return snapshot;
    }

    function resolveT(props) {
      return (props && typeof props.t === 'function') ? props.t : fallbackT;
    }

    // ------------------------------------------------------------------
    // Task row
    // ------------------------------------------------------------------

    function TaskRow(props) {
      var t = props.t;
      var task = props.task;
      var canOpen = typeof task.sessionId === 'string' && task.sessionId.length > 0;
      var nextCheck = task.nextCheckAt ? formatTime(task.nextCheckAt) : null;
      return h('div', { style: S.task },
        h('div', { style: S.taskHead },
          h('h3', { style: S.taskTitle }, task.title),
          h(Badge, { tone: 'neutral' }, kindLabel(t, task.kind)),
          h(Badge, { tone: statusTone(task.status) }, statusLabel(t, task.status)),
          h(Badge, { tone: 'neutral' }, t('field.locked'))
        ),
        h('div', { style: S.taskMeta },
          h('span', null, t('field.workspace') + ': ' + workspacePathOf(task, props.view)),
          h('span', null, t('field.route') + ': ' + task.provider + '/' + task.model),
          h('span', null, t('field.attempts', { count: task.attempts })),
          nextCheck ? h('span', null, t('field.nextCheck', { time: nextCheck })) : null,
          canOpen ? h('span', null, t('field.session') + ': ' + task.sessionId) : null
        ),
        h('div', { style: S.caption }, task.kind === 'new-session' ? t('history.newSession') : t('history.readOnly')),
        task.reason ? h('div', { style: S.caption }, t('field.reason') + ': ' + task.reason) : null,
        canOpen ? h(Btn, { label: t('action.openSession'), variant: 'link', onClick: function () { props.actions.openSession(task.sessionId); } }) : null
      );
    }

    // ------------------------------------------------------------------
    // Main panel
    // ------------------------------------------------------------------

    function QuotaQueuePanel(props) {
      var t = resolveT(props);
      var snapshot = useStoreSnapshot(props.store);
      var actions = props.actions;
      var view = snapshot.view;

      if (!view) {
        return h('div', { style: S.panel },
          h('h1', { style: S.h1 }, t('panel.title')),
          h('div', { style: S.subtitle }, t('panel.subtitle')),
          h('div', { style: Object.assign({}, S.banner, S.bannerWarn) }, snapshot.phase === 'loading' ? t('a11y.pending') : t('dock.noView')),
          snapshot.error ? h('div', { style: Object.assign({}, S.banner, S.bannerError), role: 'alert' }, localizedError(t, snapshot.error.code)) : null,
          snapshot.warning ? h('div', { style: Object.assign({}, S.banner, S.bannerWarn), role: 'status' }, snapshot.warning) : null,
          snapshot.notice ? h('div', { style: Object.assign({}, S.banner, snapshot.notice.kind === 'error' ? S.bannerError : S.bannerOk), role: 'status' }, snapshot.notice.text) : null,
          h('div', { style: Object.assign({}, S.row, { marginTop: '12px' }) },
            h(Btn, { label: t('action.refresh'), pending: snapshot.pending.bootstrap, pendingLabel: t('a11y.pending'), onClick: function () { actions.refresh(); } })
          )
        );
      }

      var capabilities = view.capabilities;
      var quota = view.quota && typeof view.quota.configured === 'boolean'
        ? view.quota
        : { configured: false, state: null, remaining: null, weeklyRemaining: null, fiveHourRemaining: null, resetAt: null, observedAt: null, reasons: [] };
      var autoResumeReady = capabilities.autoResume === true && quota.configured === true;
      var pending = snapshot.pending;
      return h('div', { style: S.panel },
        h('div', { style: S.header },
          h('h1', { style: S.h1 }, t('panel.title')),
          h('span', { style: S.caption }, t('panel.runtime', {
            version: view.runtimeVersion === null ? t('field.unknown') : view.runtimeVersion
          }))
        ),
        // One status line: readiness, dispatch pause and the two facts that
        // decide whether a switch can act. The old duplicated capability banner
        // and reason list are gone; a real configuration failure still shows.
        h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
          h(Badge, { tone: autoResumeReady || view.configuration.ready ? 'ok' : 'warn' },
            autoResumeReady ? t('config.recoveryReady') : (view.configuration.ready ? t('config.ready') : t('config.notReady'))),
          view.paused ? h(Badge, { tone: 'warn' }, t('status.paused')) : null,
          h('span', { style: S.caption }, t('cap.heading') + ': ' + t('cap.quotaCheck') + '=' + (capabilities.quotaCheck ? t('cap.on') : t('cap.off'))
            + ' · ' + t('cap.autoResume') + '=' + (autoResumeReady ? t('cap.on') : t('cap.off'))
            + ' · ' + t('cap.execution') + '=' + t('cap.off'))
        ),
        !autoResumeReady && view.configuration.ready !== true
          ? h('div', { style: Object.assign({}, S.banner, S.bannerWarn) }, t('config.notReady'))
          : null,
        h('div', { style: Object.assign({}, S.caption, { marginTop: '8px' }) },
          quota.configured
            ? t('quota.summary', {
              weekly: quota.weeklyRemaining === null ? t('field.unknown') : String(Math.round(quota.weeklyRemaining)) + '%',
              five: quota.fiveHourRemaining === null ? t('field.unknown') : String(Math.round(quota.fiveHourRemaining)) + '%',
              state: quota.state === null ? t('quota.notChecked') : t('quota.state.' + quota.state)
            })
            : t('quota.notConfigured')
        ),
        quota.configured && quota.state !== 'available' && quota.reasons.length > 0
          ? h('div', { style: S.caption }, t('quota.reasons', { reasons: quota.reasons.join(' · ') }))
          : null,
        snapshot.error ? h('div', { style: Object.assign({}, S.banner, S.bannerError), role: 'alert' }, localizedError(t, snapshot.error.code)) : null,
        snapshot.warning ? h('div', { style: Object.assign({}, S.banner, S.bannerWarn), role: 'status' }, snapshot.warning) : null,
        snapshot.notice ? h('div', { style: Object.assign({}, S.banner, snapshot.notice.kind === 'error' ? S.bannerError : S.bannerOk), role: 'status' }, snapshot.notice.text) : null,
        h('div', { style: Object.assign({}, S.row, { marginTop: '12px' }) },
          h(Btn, { label: t('action.refresh'), pending: pending.bootstrap, pendingLabel: t('a11y.pending'), onClick: function () { actions.refresh(); } }),
          h(Btn, {
            label: t('action.checkQuota'),
            pending: pending.checkQuota,
            pendingLabel: t('a11y.pending'),
            disabled: !capabilities.quotaCheck,
            title: capabilities.quotaCheck ? undefined : t('cap.off'),
            onClick: function () { actions.checkQuota(); }
          }),
          h(Btn, {
            label: view.paused ? t('action.resumeDispatch') : t('action.pauseDispatch'),
            title: t('recovery.unavailable'),
            disabled: true,
            pending: pending.pauseDispatch,
            pendingLabel: t('a11y.pending'),
            onClick: function () { actions.setPaused(!view.paused); }
          })
        ),
        // The plan is the surface the user acts on, so it comes first.
        h(PlanSection, {
          t: t, plan: view.recoveryPlan, sessionOptIns: view.sessionOptIns, actions: actions, pending: pending,
          view: view, confirmSkipId: snapshot.planConfirmId
        })
      );
    }


    /** The live plan item that owns this session, if any. */
    function planItemForSession(plan, sessionId) {
      if (!plan || plan.available !== true) return null;
      for (var i = 0; i < plan.items.length; i++) {
        var item = plan.items[i];
        if (item.removed !== true && item.sessionId === sessionId) return item;
      }
      return null;
    }

    /**
     * The switch state for one session. A planned session is rendered from its
     * plan item (the authoritative record) so the plan and the switch cannot
     * show different answers; an unplanned session falls back to the plain
     * session opt-in.
     */
    /** One short, read-only line about this session's continuation ticket. */
    function autoContinueLine(t, view, sessionId) {
      var auto = view && view.autoContinue;
      if (!auto || auto.enabled !== true || !Array.isArray(auto.tickets)) return null;
      var ticket = null;
      for (var i = auto.tickets.length - 1; i >= 0; i--) {
        if (auto.tickets[i].sessionId === sessionId) { ticket = auto.tickets[i]; break; }
      }
      if (ticket === null) return null;
      if (ticket.state === 'needs_attention') return t('continue.needsAttention');
      if (ticket.state === 'claimed' || ticket.state === 'unknown') return t('continue.pending');
      if (ticket.state === 'delivered') return t('continue.delivered');
      if (ticket.state !== 'waiting') return null;
      var time = clockOf(ticket.nextAt);
      if (ticket.reason === 'quota_waiting') return t('continue.quotaWaiting', { time: time });
      if (ticket.reason === 'quota_unknown') return t('continue.quotaUnknown', { time: time });
      return t('continue.waiting', { time: time });
    }

    /** Local HH:MM for the next scheduled check; a missing instant is shown as --:--. */
    function clockOf(ms) {
      if (!Number.isSafeInteger(ms) || ms <= 0) return '--:--';
      var date = new Date(ms);
      var hh = date.getHours();
      var mm = date.getMinutes();
      return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    }
    function sessionAuthorization(plan, sessionId, sessionOptIns) {
      var item = planItemForSession(plan, sessionId);
      if (item !== null) {
        return {
          planned: true, itemId: item.id,
          enabled: item.authorizationEnabled === true,
          bound: item.quotaScopeBound === true,
          // Enabling needs a bound account scope; the plan reports why not.
          authorizeDisabledReason: item.quotaScopeBound === true ? null : 'quota_scope_unbound',
        };
      }
      return {
        planned: false, itemId: null,
        enabled: !!(sessionOptIns && sessionOptIns[sessionId] === true),
        bound: true
      };
    }


    /**
     * Compute the Host `planMove` target for one step. Moving later from the
     * last position of the last batch creates a following batch.
     */
    function planMoveTarget(plan, id, direction) {
      for (var b = 0; b < plan.batches.length; b++) {
        var position = plan.batches[b].indexOf(id);
        if (position < 0) continue;
        if (direction < 0) {
          if (position > 0) return { batch: b, position: position - 1 };
          if (b > 0) return { batch: b - 1, position: plan.batches[b - 1].length };
          return null;
        }
        if (position < plan.batches[b].length - 1) return { batch: b, position: position + 1 };
        if (b < plan.batches.length - 1) return { batch: b + 1, position: 0 };
        return { batch: plan.batches.length, position: 0 };
      }
      return null;
    }

    function PlanItem(props) {
      var t = props.t;
      var item = props.item;
      var plan = props.plan;
      var actions = props.actions;
      var pending = props.pending;
      var editable = plan.editable === true;
      var busy = pending['planItem:' + item.id] === true || pending['planMove:' + item.id] === true
        || pending['planRemove:' + item.id] === true || pending['planSkip:' + item.id] === true;
      var earlier = planMoveTarget(plan, item.id, -1);
      var later = planMoveTarget(plan, item.id, 1);
      var confirming = props.confirmSkipId === item.id;
      // Blockers are only shown when they say something the row does not: a
      // held/unknown outcome or a previous batch that has not succeeded.
      var blockers = (item.blockers || []).filter(function (blocker) {
        return blocker === 'execution_outcome_unknown' || blocker === 'earlier_batch_incomplete' || blocker === 'task_running';
      }).map(function (blocker) { return t('plan.blocker.' + blocker); });
      var showBlockers = blockers.length > 0;
      return h('div', { style: S.task },
        h('div', { style: S.taskHead },
          h('h3', { style: S.taskTitle }, item.title),
          h(Badge, { tone: statusTone(item.status) }, statusLabel(t, item.status)),
          item.paused ? h(Badge, { tone: 'warn' }, t('status.paused')) : null,
          item.executionHeld ? h(Badge, { tone: 'warn' }, t('plan.held')) : null,
          item.removed ? h(Badge, { tone: 'neutral' }, t('plan.removed')) : null,
          item.skipped ? h(Badge, { tone: 'neutral' }, t('plan.skipped')) : null
        ),
        h('div', { style: S.taskMeta },
          h('span', null, t('field.workspace') + ': ' + (item.workspacePath || t('field.unknown'))),
          item.attempts > 0 ? h('span', null, t('field.attempts', { count: item.attempts })) : null,
          item.paused ? h('span', null, t('plan.reason.task_paused')) : null
        ),
        // One short blocker line instead of a reason sentence plus a long list:
        // authorization and execution-pending are implied by the switch and the
        // runtime badge, so only a real hold or an earlier incomplete batch shows.
        showBlockers && blockers.length > 0
          ? h('div', { style: S.caption, role: 'note' }, t('plan.blockers') + ': ' + blockers.join(' · '))
          : null,
        h('div', { style: S.row },
          h(Btn, { label: t('action.openSession'), variant: 'link', onClick: function () { actions.openSession(item.sessionId); } }),
          // No switch here on purpose: the session switch under the composer is
          // the ONE entry. It queues, authorizes and removes this very item, so
          // a second control could only disagree with it.
          item.authorizationEnabled ? h(Badge, { tone: 'ok' }, t('plan.authorized')) : null
        ),
        h('div', { style: S.row },
          item.removed || item.skipped ? null : h(Btn, {
            label: item.paused ? t('plan.itemResume') : t('plan.itemPaused'),
            disabled: !editable, pending: busy, variant: 'link',
            onClick: function () { actions.planItemPause(item.id, item.paused !== true); }
          }),
          earlier === null ? null : h(Btn, {
            label: t('plan.moveUp'), disabled: !editable || busy, variant: 'link',
            onClick: function () { actions.planMove(item.id, earlier.batch, earlier.position); }
          }),
          later === null ? null : h(Btn, {
            label: t('plan.moveDown'), disabled: !editable || busy, variant: 'link',
            onClick: function () { actions.planMove(item.id, later.batch, later.position); }
          }),
          item.removed ? null : h(Btn, {
            label: t('plan.remove'), disabled: !editable || busy, variant: 'danger',
            onClick: function () { actions.planRemove(item.id); }
          }),
          item.removed || item.skipped ? null : (confirming
            ? h('span', { style: S.row },
              h(Btn, {
                label: t('plan.confirmSkip'), variant: 'danger', disabled: !editable, pending: pending['planSkip:' + item.id],
                onClick: function () { actions.planSkip(item.id); }
              }),
              h(Btn, { label: t('plan.cancelSkip'), onClick: function () { actions.cancelPlanSkip(); } }))
            : h(Btn, {
              label: t('plan.skip'), disabled: !editable || busy, variant: 'link',
              onClick: function () { actions.requestPlanSkip(item.id); }
            }))
        )
      );
    }

    function PlanSection(props) {
      var t = props.t;
      var plan = (props.plan && typeof props.plan.available === 'boolean')
        ? props.plan
        : { available: false, editable: false, reason: 'recovery_plan_unavailable', revision: 0, maxConcurrent: 1, paused: true, batches: [], items: [] };
      var actions = props.actions;
      var pending = props.pending || {};
      if (plan.available !== true) {
        return h('div', { style: S.section },
          h('h2', { style: S.sectionTitle }, t('plan.heading')),
          h('div', { style: Object.assign({}, S.banner, S.bannerWarn), role: 'note' }, t('plan.unavailable'))
        );
      }
      var editable = plan.editable === true;
      var quotaScopeId = props.view && typeof props.view.quotaScopeId === 'string' ? props.view.quotaScopeId : null;
      var concurrencyOptions = [];
      for (var value = 1; value <= 8; value++) concurrencyOptions.push(value);
      return h('div', { style: S.section },
        h('h2', { style: S.sectionTitle }, t('plan.heading')),
        // One meta line instead of three stacked explanations. The scope line is
        // the only place that explains a locked switch, so it stays visible.
        h('div', { style: S.taskMeta },
          h('span', null, t('plan.revision', { revision: plan.revision })),
          plan.paused ? h('span', null, t('plan.paused')) : null,
          h('span', { role: 'note' }, quotaScopeId === null ? t('plan.scope.unavailable') : t('plan.scope.bound'))
        ),
        editable ? null : h('div', { style: Object.assign({}, S.banner, S.bannerWarn), role: 'note' }, t('plan.readonly')),
        h('div', { style: Object.assign({}, S.row, { marginTop: '8px' }) },
          h('label', { style: S.caption, htmlFor: 'quota-queue-plan-concurrency' }, t('plan.concurrency')),
          h('select', {
            id: 'quota-queue-plan-concurrency',
            'aria-label': t('plan.concurrency'),
            disabled: !editable || plan.paused,
            value: String(plan.maxConcurrent),
            onChange: function (event) {
              var next = Number(event && event.target ? event.target.value : NaN);
              if (Number.isSafeInteger(next) && next >= 1 && next <= 8 && next !== plan.maxConcurrent) actions.planConfigure(next);
            }
          }, concurrencyOptions.map(function (option) {
            return h('option', { key: String(option), value: String(option) }, String(option));
          })),
          h(Btn, {
            label: plan.paused ? t('plan.resume') : t('plan.pause'),
            disabled: !editable,
            pending: pending.planPause,
            pendingLabel: t('a11y.pending'),
            onClick: function () { actions.planSetPaused(!plan.paused); }
          })
        ),
        plan.items.length === 0 ? h('div', { style: S.caption }, t('plan.empty')) : null,
        h('div', { role: 'list', 'aria-label': t('plan.heading') }, plan.batches.map(function (batch, index) {
          var byId = {};
          for (var i = 0; i < plan.items.length; i++) byId[plan.items[i].id] = plan.items[i];
          return h('div', { key: 'batch-' + String(index), role: 'group', 'aria-label': t('plan.batch', { index: index + 1 }), style: { marginTop: '10px' } },
            h('h3', { style: S.sectionTitle }, batch.length > 1
              ? t('plan.batchParallel', { index: index + 1 })
              : t('plan.batch', { index: index + 1 })),
            batch.map(function (id) {
              var item = byId[id];
              if (!item) return null;
              return h('div', { key: id, role: 'listitem' },
                h(PlanItem, {
                  t: t, item: item, plan: plan, actions: actions, pending: pending,
                  confirmSkipId: props.confirmSkipId
                })
              );
            })
          );
        }))
      );
    }


    // ------------------------------------------------------------------
    // Sidebar icon
    // ------------------------------------------------------------------

    function QuotaQueueIcon(props) {
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 18;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false, style: { display: 'block' }
      },
        h('path', { d: 'M4 6h16' }),
        h('path', { d: 'M4 12h10' }),
        h('path', { d: 'M4 18h6' }),
        h('path', { d: 'M17 14l3 3-3 3' })
      );
    }

    // ------------------------------------------------------------------
    // Conversation composer dock status bar
    // ------------------------------------------------------------------

    function QuotaQueueDockStatus(props) {
      var t = resolveT(props);
      var snapshot = useStoreSnapshot(props.store);
      var actions = props.actions;
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
      var view = snapshot.view;
      var waiting = 0;
      var running = 0;
      var attention = 0;

      if (view) {
        for (var i = 0; i < view.tasks.length; i++) {
          var task = view.tasks[i];
          if (sessionId !== null && task.sessionId !== sessionId) continue;
          if (task.status === 'running') running += 1;
          else if (task.status === 'needs_attention') attention += 1;
          else if (WAITING_STATUSES.has(task.status)) waiting += 1;
        }
      }

      return h('div', { style: S.dock },
        h('span', { style: { fontWeight: 600, color: TOKENS.labelSecondary } }, t('dock.title')),
        view
          ? h('span', { style: S.dockSummary }, t('dock.summary', { waiting: waiting, running: running, attention: attention }))
          : h('span', { style: S.dockSummary }, t('dock.noView')),
        view && !view.configuration.ready
          && !(view.capabilities && view.capabilities.autoResume === true && view.quota && view.quota.configured === true)
          ? h('span', { style: { color: TOKENS.warnLabel } }, t('config.notReady'))
          : null,
        sessionId !== null ? (function () {
          var canOptIn = view !== null && view !== undefined
            && view.capabilities && view.capabilities.autoResume === true
            && view.quota && view.quota.configured === true;
          var authorization = sessionAuthorization(view ? view.recoveryPlan : null, sessionId,
            view ? view.sessionOptIns : null);
          var scopeUnavailable = !view || !view.quotaScopeId;
          // A Host with no verified account scope cannot authorize anything; an
          // unbound legacy item is bindable by the Host's normalization on the
          // user's own action, so that case is NOT locked.
          var itemId = authorization.itemId;
          // This switch may run one or two Host calls (queue, then authorize, or
          // a plan removal), so it shows the pending state of any of them.
          var busy = snapshot.pending['optIn:' + sessionId] === true
            || snapshot.pending['planAdd:' + sessionId] === true
            || snapshot.pending['planRemove:' + sessionId] === true
            || (itemId !== null && snapshot.pending['planAuthorize:' + itemId] === true);
          // Read-only: what the continuation driver is doing for THIS session.
          var continueLine = autoContinueLine(t, view, sessionId);
          return h('span', { style: Object.assign({}, S.row, { gap: '6px' }) },
            h(Switch, {
              checked: authorization.enabled, disabled: !canOptIn || scopeUnavailable,
              pending: busy,
              label: t('resume.switchLabel'), ariaLabel: t('resume.switchLabel'),
              title: canOptIn
                ? (scopeUnavailable ? t('plan.scope.unavailable') : t('resume.switchHint'))
                : t('recovery.unavailable'),
              onChange: function (next) {
                if (canOptIn && !scopeUnavailable) actions.setRecoverySwitch(sessionId, next === true);
              }
            }),
            h('span', { style: S.dockSummary }, t('resume.switchLabel')),
            continueLine === null ? null : h('span', { style: S.dockSummary, role: 'status' }, continueLine)
          );
        })() : null,
        h(Btn, { label: t('action.openPanel'), variant: 'link', onClick: function () { actions.openPanel(); } }),
        snapshot.error ? h('span', { style: { color: TOKENS.errorPrimary }, role: 'alert' }, localizedError(t, snapshot.error.code)) : null,
        snapshot.warning ? h('span', { style: { color: TOKENS.warnLabel }, role: 'status' }, snapshot.warning) : null
      );
    }

    // ------------------------------------------------------------------
    // Plugin body
    // ------------------------------------------------------------------

    var inject = ['slots', 'locale', 'connection', 'layout', 'uiWorkspace'];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'quota-queue: dictionaries');

      var t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackT;
      var controller = createController(ctx, { t: t });

      ctx.effect(function () {
        return function () { controller.dispose(); };
      }, 'quota-queue: controller');

      ctx.effect(function () {
        var off = ctx.on('connection/reset', function () { controller.onConnectionReset(); });
        return function () { off(); };
      }, 'quota-queue: connection listener');

      var face = { store: controller.store, actions: controller.actions };

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: function () { return face; }
        }, QuotaQueuePanel);
      });

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          locale: NS,
          label: function () { return t('panel.title'); },
          inject: function () { return face; }
        }, QuotaQueueIcon);
      });

      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: DOCK_ID,
          order: 40,
          locale: NS,
          inject: function () { return face; }
        }, QuotaQueueDockStatus);
      });

      controller.start();
    }

    return {
      inject: inject,
      apply: apply,
      // Not a public plugin API: the offline node:test harness loads the same
      // factory and exercises projection/transport/cleanup directly.
      __internals: {
        constants: {
          NS: NS, PANEL_ID: PANEL_ID, DOCK_ID: DOCK_ID,
          CHANNEL: CHANNEL, ENDPOINT: ENDPOINT, VIEW_VERSION: VIEW_VERSION
        },
        projectView: projectView,
        projectRecoveryPlan: projectRecoveryPlan,
        mergeViews: mergeViews,
        projectTask: projectTask,
        buildRequest: buildRequest,
        dispatchCall: dispatchCall,
        createController: createController,
        normalizeErrorCode: normalizeErrorCode,
        localizedError: localizedError,
        canEditTask: canEditTask,
        stableStringify: stableStringify,
        makeRequestId: makeRequestId,
        components: {
          QuotaQueuePanel: QuotaQueuePanel,
          QuotaQueueIcon: QuotaQueueIcon,
          QuotaQueueDockStatus: QuotaQueueDockStatus,
          TaskRow: TaskRow
        },
        dictionaries: { zh: zh, en: en }
      }
    };
  }
});
