/**
 * DSH 自动会话恢复宿主契约（离线真实宿主 fixture）。
 *
 * 这个文件只测三类可测事实：
 *  1. 网络错误时的信号顺序：agent/error → 持久 turn/end → agent/status idle；
 *  2. 用户取消 / blocked 结尾不能被当成网络失败（恢复资格与消息证据）；
 *  3. 同一固定 requestId 重复投递的持久消息证据（几条 occurrence、投影器如何裁决）。
 *
 * 证据分层（避免“只测自己 mock 假设的伪测试”）：
 *  - 事件、状态、消息与 inbox 拼接记录全部来自真实安装宿主
 *    （$DSH_MODULE_ROOT/@deepseek-ai/*，经 ./resolver.mjs 解析），
 *    模型侧只有一个离线脚本化 adapter；
 *  - 断言对象是生产模块本身：host/continue-failure.js、host/continue-evidence.js、
 *    host/continue-inbox.js、host/task-identity.js、host/continue-transport.js、core/failure.mjs；
 *  - 唯一的复制品是宿主准入去重谓词（见 SHIPPED GUARD），它逐行照抄安装构建
 *    dsh-api-session-controller/lib/index.js:1128-1139，读取的是真实宿主表面
 *    （agent.inbox.nextTurn/nextStep、agent.session.snapshotEvents()）；Remote 服务本体在
 *    离线 fixture 里无法启动，所以该谓词只当观察与围栏用，不作为宿主实现证据。
 *
 * 本机实测的不可测项见文件末尾 HOST-GAPS。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { correlateContinueInbox } from '../../host/continue-inbox.js';
import { correlateContinueInspection } from '../../host/continue-evidence.js';
import { inspectContinueFailure } from '../../host/continue-failure.js';
import { taskIdentityFromInspection } from '../../host/task-identity.js';
import { createContinueTransport } from '../../host/continue-transport.js';
import { classifyFailure } from '../../core/failure.mjs';
import { createFakeSessionController, inspectionFor } from './harness.mjs';
import { MODULE_ROOT } from './resolver.mjs';

const HOST_MODULES = ['dsh-agent', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-system-prompt',
  'dsh-session-projection', 'dsh-agent-loop'];
const AVAILABLE = HOST_MODULES.every((name) => existsSync(MODULE_ROOT + '/@deepseek-ai/' + name + '/lib/index.js'));
const SKIP = AVAILABLE ? false : 'required DSH host packages not installed';

register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);

/** 一条人类根消息；source.rpcId 是宿主记录 requestId 的唯一位置。 */
const human = (id, rpcId, text) => ({
  id, role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
});
/** 投影器需要的完整 v4 快照（seq 连续、无继承事件）。 */
const inspectionOf = (agent) => ({
  meta: agent.session.header,
  inheritedEventCount: agent.session.inheritedEventCount,
  events: agent.session.snapshotEvents(),
});
const eventsOfType = (inspection, type) => inspection.events.filter((event) => event.type === type);
const rpcMatches = (inspection, rpcId) => eventsOfType(inspection, 'user/message')
  .filter((event) => event.data.source && event.data.source.kind === 'user' && event.data.source.rpcId === rpcId);
/** 真实 agent/inbox/spliced 记录里该 requestId 被插入 inbox 的次数（不依赖消息 id 唯一性）。 */
const insertionCount = (inspection, rpcId, afterSeq) => eventsOfType(inspection, 'agent/inbox/spliced')
  .filter((event) => event.seq > afterSeq)
  .reduce((sum, event) => sum + event.data.inserted
    .filter((m) => m.source && m.source.kind === 'user' && m.source.rpcId === rpcId).length, 0);
const turnEnds = (inspection) => eventsOfType(inspection, 'turn/end');
const settle = async (agent, ms) => {
  await agent.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, ms === undefined ? 150 : ms));
};

async function loadHost() {
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const root = new Context();
  for (const name of HOST_MODULES) {
    const mod = await import('@deepseek-ai/' + name);
    await root.plugin(mod.default);
  }
  return { Context, llm, root };
}

/** 起一个真实宿主 Context，模型侧只有一个抛错的离线 adapter。 */
async function offlineHost(code, message) {
  const failureCode = code === undefined ? 'TRANSPORT' : code;
  const failureMessage = message === undefined ? 'synthetic network failure' : message;
  const { llm, root } = await loadHost();
  const provider = 'quota-host-' + failureCode.toLowerCase();
  class ThrowingAdapter extends llm.LlmAdapter {
    async *stream() { throw new llm.LlmError(failureMessage, failureCode); }
  }
  root.llm.registerAdapter([provider], new ThrowingAdapter());
  return {
    root,
    async open(sessionId) {
      const handle = await root.agents.create({
        sessionId, meta: { cwd: process.cwd() }, agentOptions: { provider, model: 'fixture' },
      });
      return { agent: handle.agent, async dispose() { await handle.dispose(); await root.fiber.dispose(); } };
    },
  };
}

/** 挂起的 adapter：用于在 step 活跃期间取消或注入重复投递。 */
async function gatedHost() {
  const { llm, root } = await loadHost();
  let release = () => undefined;
  const gate = new Promise((resolve) => { release = resolve; });
  class GatedAdapter extends llm.LlmAdapter {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'partial' };
      await gate;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  root.llm.registerAdapter(['quota-host-gated'], new GatedAdapter());
  const handle = await root.agents.create({
    sessionId: 'quota-host-gated', meta: { cwd: process.cwd() },
    agentOptions: { provider: 'quota-host-gated', model: 'fixture' },
  });
  const waitFor = async (predicate, rounds) => {
    for (let n = 0; n < (rounds === undefined ? 600 : rounds); n += 1) {
      if (predicate(handle.agent.session.snapshotEvents())) return true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for a live host event');
  };
  return {
    root, agent: handle.agent, release, waitFor,
    async dispose() { release(); await handle.dispose(); await root.fiber.dispose(); },
  };
}

test('宿主顺序：网络错误先 agent/error，再持久 turn/end，最后才 idle',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost();
    const { agent, dispose } = await host.open('quota-order-transport');
    try {
      const trace = [];
      host.root.on('agent/error', (payload) => {
        trace.push({
          signal: 'agent/error',
          turn: payload.turn,
          statusAtSignal: agent.status,
          turnEndedAtSignal: agent.session.snapshotEvents()
            .some((event) => event.type === 'turn/end' && event.data.turn === payload.turn),
        });
      });
      host.root.on('agent/status', (payload) => {
        trace.push({
          signal: 'agent/status:' + payload.status,
          turnEndedAtSignal: agent.session.snapshotEvents().some((event) => event.type === 'turn/end'),
        });
      });
      const requestError = [];
      host.root.on('agent/request-error', (payload, next) => {
        requestError.push({
          turn: payload.turn, step: payload.step, provider: payload.provider,
          failure: payload.failure, signalAborted: payload.signal.aborted,
          retryableCodes: payload.retryPolicy === undefined ? undefined : payload.retryPolicy.retryableCodes,
          turnEndedAtSignal: agent.session.snapshotEvents()
            .some((event) => event.type === 'turn/end' && event.data.turn === payload.turn),
        });
        return next();
      });

      assert.equal(agent.status, 'idle');
      agent.followup(human('root-order', 'root-rpc-order', 'synthetic task'));
      await agent.whenIdle();

      const names = trace.map((entry) => entry.signal);
      const errorAt = names.indexOf('agent/error');
      const idleAt = names.indexOf('agent/status:idle');
      assert.ok(errorAt >= 0, '真实宿主必须发出 agent/error，实际信号：' + JSON.stringify(names));
      assert.ok(idleAt > errorAt, 'agent/error 必须早于进入 idle 的 agent/status');
      assert.equal(trace[idleAt].turnEndedAtSignal, true, '进入 idle 时 turn/end 必须已经持久存在');
      assert.equal(trace[errorAt].statusAtSignal, 'running', 'agent/error 时 agent 仍在 running');
      assert.equal(trace[errorAt].turnEndedAtSignal, false, 'agent/error 时原 turn 仍未结束');

      assert.equal(requestError.length, 1);
      assert.deepEqual(requestError[0].failure, { message: 'synthetic network failure', code: 'TRANSPORT' });
      assert.equal(requestError[0].signalAborted, false);
      assert.equal(requestError[0].turnEndedAtSignal, false);
      assert.ok(Array.isArray(requestError[0].retryableCodes)
        && requestError[0].retryableCodes.includes('TRANSPORT'), '原生重试策略必须自己认领 TRANSPORT');

      const inspection = inspectionOf(agent);
      const end = turnEnds(inspection).at(-1);
      assert.deepEqual(end.data.reason, {
        kind: 'error', error: { message: 'synthetic network failure', code: 'TRANSPORT' },
      });
      assert.equal(agent.status, 'idle');

      const identity = taskIdentityFromInspection(agent.session.id, inspection);
      assert.equal(identity.verified, true);
      assert.equal(identity.turnEnded, true);
      assert.equal(identity.turnEndKind, 'error');
      const failed = inspectContinueFailure(agent.session.id, inspection);
      assert.equal(failed.eligible, true);
      assert.equal(failed.failureClass, 'transient');
      assert.equal(failed.code, 'TRANSPORT');
      assert.equal(failed.originalEndSeq, end.seq, '恢复证据必须绑定到真实的 turn/end 序号');
    } finally { await dispose(); }
  });

test('用户取消：aborted + user cause，不产生 agent/error，也不构成失败 turn',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await gatedHost();
    try {
      const errors = [];
      host.root.on('agent/error', (payload) => errors.push({ turn: payload.turn, step: payload.step }));
      host.agent.followup(human('root-cancel', 'root-rpc-cancel', 'synthetic task'));
      await host.waitFor((events) => events.some((event) => event.type === 'step/start'));
      assert.equal(host.agent.status, 'running');
      host.agent.cancel({ kind: 'user' });
      host.release();
      await settle(host.agent);

      const inspection = inspectionOf(host.agent);
      const end = turnEnds(inspection).at(-1);
      assert.deepEqual(end.data.reason, { kind: 'aborted', reason: { kind: 'user' } });
      assert.equal(Object.hasOwn(end.data.reason, 'error'), false,
        '取消结尾没有结构化 error：把非 completed 当成网络失败的实现必然误判');
      assert.deepEqual(errors, [], '用户取消不得走 agent/error 通道');
      assert.equal(host.agent.status, 'idle', '取消后同样进入 idle，idle 本身不区分失败原因');

      const identity = taskIdentityFromInspection(host.agent.session.id, inspection);
      assert.equal(identity.verified, true);
      assert.equal(identity.turnEndKind, 'aborted');
      const failed = inspectContinueFailure(host.agent.session.id, inspection);
      assert.equal(failed.eligible, false);
      assert.equal(failed.reason, 'not_failed_turn');
    } finally { await host.dispose(); }
  });

test('blocked：pre-step 拒绝关闭 turn，不留持久消息，也不算失败 turn',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost();
    const { agent, dispose } = await host.open('quota-blocked');
    try {
      const errors = [];
      host.root.on('agent/error', (payload) => errors.push(payload.turn));
      let rejectNext = false;
      const stop = host.root.on('agent/pre-step', (payload, next) => (rejectNext ? { kind: 'reject' } : next()));
      try {
        agent.followup(human('root-blocked', 'root-rpc-blocked', 'synthetic task'));
        await settle(agent);
        const before = inspectionOf(agent);
        const firstEnd = turnEnds(before).at(-1);
        const identity = taskIdentityFromInspection(agent.session.id,
          { ...before, events: before.events.slice(0, firstEnd.seq + 1) });
        assert.equal(identity.verified, true);

        rejectNext = true;
        agent.followup(human('cont-blocked', 'rpc-blocked-continue', '继续'));
        await settle(agent);

        const all = inspectionOf(agent);
        const ends = turnEnds(all);
        assert.equal(ends.length, 2);
        assert.deepEqual(ends[1].data.reason, { kind: 'blocked' });
        assert.deepEqual(errors, [1], 'blocked 结尾不得新增 agent/error');
        assert.deepEqual(rpcMatches(all, 'rpc-blocked-continue'), [],
          '被声明后拒绝的续跑消息不会成为持久 user/message（缺席不等于未投递）');

        const fold = correlateContinueInbox({
          sessionId: agent.session.id, requestId: 'rpc-blocked-continue',
          afterSeq: firstEnd.seq, snapshotSeq: all.events.length - 1, inspection: all,
        });
        assert.equal(fold.status, 'observed');
        assert.equal(fold.messageId, 'cont-blocked');
        assert.equal(fold.removedWithoutOutcome, true);
        assert.equal(fold.discarded, false);

        assert.deepEqual(correlateContinueInspection({
          sessionId: agent.session.id, rootMessageId: identity.rootMessageId, generation: identity.generation,
          originalEndSeq: firstEnd.seq, failureTurn: firstEnd.data.turn,
          requestId: 'rpc-blocked-continue', inspection: all,
        }), { status: 'not_observed' });

        const failed = inspectContinueFailure(agent.session.id, all);
        assert.equal(failed.eligible, false);
        assert.notEqual(failed.failureClass, 'transient', 'blocked 绝不能带出可重试类别');
      } finally { if (typeof stop === 'function') stop(); }
    } finally { await dispose(); }
  });

test('结构化取消码不是网络失败：ABORTED 结尾分类为 user_cancelled 且不放行',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost('ABORTED', 'stopped by user');
    const { agent, dispose } = await host.open('quota-abort-code');
    try {
      const seen = [];
      host.root.on('agent/request-error', (payload, next) => {
        seen.push({ code: payload.failure.code, retryableCodes: payload.retryPolicy === undefined ? undefined : payload.retryPolicy.retryableCodes });
        return next();
      });
      agent.followup(human('root-abort', 'root-rpc-abort', 'synthetic task'));
      await settle(agent);

      const inspection = inspectionOf(agent);
      const end = turnEnds(inspection).at(-1);
      assert.equal(end.data.reason.kind, 'error');
      assert.deepEqual(end.data.reason.error, { message: 'stopped by user', code: 'ABORTED' });
      assert.equal(seen.length, 1);
      assert.ok(!seen[0].retryableCodes.includes('ABORTED'),
        '宿主重试策略不认领 ABORTED：它既不是网络失败也不是可重试事实');

      const classified = classifyFailure({ code: end.data.reason.error.code, status: end.data.reason.error.status });
      assert.equal(classified.class, 'user_cancelled');
      assert.equal(classified.createsQuotaTicket, false);
      assert.equal(classified.retryableNatively, false);

      const failed = inspectContinueFailure(agent.session.id, inspection);
      assert.equal(failed.eligible, false);
      assert.equal(failed.reason, 'failure_not_recoverable');
    } finally { await dispose(); }
  });

test('同一固定 requestId 的两次持久 occurrence 判为冲突，而不是已投递一次',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost();
    const { agent, dispose } = await host.open('quota-dup-rpc');
    try {
      agent.followup(human('root-dup', 'root-rpc-dup', 'synthetic task'));
      await settle(agent);
      const before = inspectionOf(agent);
      const firstEnd = turnEnds(before).at(-1);
      const identity = taskIdentityFromInspection(agent.session.id,
        { ...before, events: before.events.slice(0, firstEnd.seq + 1) });
      assert.equal(identity.verified, true);

      agent.followup(human('cont-dup-1', 'fixed-req', '继续'));
      await settle(agent);
      agent.followup(human('cont-dup-2', 'fixed-req', '继续'));
      await settle(agent);

      const all = inspectionOf(agent);
      const matches = rpcMatches(all, 'fixed-req');
      assert.equal(matches.length, 2, '宿主按 requestId 去重只覆盖 Remote 准入，两次投递都会落盘');
      assert.deepEqual(matches.map((event) => event.data.id), ['cont-dup-1', 'cont-dup-2']);

      assert.deepEqual(correlateContinueInspection({
        sessionId: agent.session.id, rootMessageId: identity.rootMessageId, generation: identity.generation,
        originalEndSeq: firstEnd.seq, failureTurn: firstEnd.data.turn, requestId: 'fixed-req', inspection: all,
      }), { status: 'conflict', reason: 'duplicate_request_message' });

      assert.deepEqual(correlateContinueInbox({
        sessionId: agent.session.id, requestId: 'fixed-req',
        afterSeq: firstEnd.seq, snapshotSeq: all.events.length - 1, inspection: all,
      }), { status: 'invalid', reason: 'inbox_history_invalid' });

      // 重复投递会把任务身份重新锚到最后一条人类根消息上，generation 随之改变。
      const rebased = taskIdentityFromInspection(agent.session.id, all);
      assert.equal(rebased.rootMessageId, 'cont-dup-2');
      assert.notEqual(rebased.generation, identity.generation);
    } finally { await dispose(); }
  });

test('turn 在飞时重复投递：一条被认领、另一条滞留 pending，turn 级证据看不见重复',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await gatedHost();
    try {
      host.agent.followup(human('root-inflight', 'root-rpc-inflight', 'synthetic task'));
      await host.waitFor((events) => events.some((event) => event.type === 'step/start'));

      host.agent.followup(human('cont-inflight-1', 'fixed-req', '继续'));
      host.agent.followup(human('cont-inflight-2', 'fixed-req', '继续'));
      const pending = host.agent.inbox.nextTurn.map((message) => message.id);
      assert.ok(pending.includes('cont-inflight-1') && pending.includes('cont-inflight-2'),
        '两次投递都进入真实 pending inbox');
      host.release();
      await settle(host.agent);

      const all = inspectionOf(host.agent);
      const pendingAfter = host.agent.inbox.nextTurn.map((message) => message.id)
        .filter((id) => id.indexOf('cont-inflight-') === 0);
      const claimed = rpcMatches(all, 'fixed-req').map((event) => event.data.id);
      assert.equal(claimed.length + pendingAfter.length, 2,
        '两条 occurrence 必须各有所在（持久认领或仍在 pending），不能被静默吞掉');

      const fold = correlateContinueInbox({
        sessionId: host.agent.session.id, requestId: 'fixed-req',
        afterSeq: 0, snapshotSeq: all.events.length - 1, inspection: all,
      });
      assert.equal(fold.status, 'invalid', '同一 requestId 命中两条消息时投影器拒绝裁决');
      assert.equal(fold.reason, 'inbox_history_invalid');
      assert.equal(host.agent.status, 'idle', '滞留 pending 与 idle 可以同时成立');
    } finally { await host.dispose(); }
  });

test('消息 id 只在 pending 内唯一：跨 turn 复用让 occurrence 证据变成 ambiguous',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost();
    const { agent, dispose } = await host.open('quota-id-reuse');
    try {
      agent.followup(human('root-reuse', 'root-rpc-reuse', 'synthetic task'));
      await settle(agent);
      const before = inspectionOf(agent);
      const firstEnd = turnEnds(before).at(-1);

      agent.followup(human('cont-reuse', 'fixed-req', '继续'));
      await settle(agent);
      let thrown = null;
      try { agent.followup(human('cont-reuse', 'fixed-req', '继续')); } catch (error) { thrown = error; }
      assert.equal(thrown, null, '真实宿主不在 agent 边界拒绝复用已消费的消息 id');
      await settle(agent);

      const all = inspectionOf(agent);
      const matches = rpcMatches(all, 'fixed-req');
      assert.equal(matches.length, 2);
      assert.equal(new Set(matches.map((event) => event.data.id)).size, 1, '两条持久消息共享同一 id');
      assert.equal(correlateContinueInbox({
        sessionId: agent.session.id, requestId: 'fixed-req',
        afterSeq: firstEnd.seq, snapshotSeq: all.events.length - 1, inspection: all,
      }).status, 'ambiguous');
      assert.equal(insertionCount(all, 'fixed-req', firstEnd.seq), 2);
    } finally { await dispose(); }
  });

test('固定 requestId 围栏：遵守宿主准入谓词时只落一条持久消息',
  { skip: SKIP, timeout: 30000 }, async () => {
    const host = await offlineHost();
    const { agent, dispose } = await host.open('quota-fence');
    try {
      agent.followup(human('root-fence', 'root-rpc-fence', 'synthetic task'));
      await settle(agent);
      const before = inspectionOf(agent);
      const firstEnd = turnEnds(before).at(-1);
      const identity = taskIdentityFromInspection(agent.session.id,
        { ...before, events: before.events.slice(0, firstEnd.seq + 1) });

      // SHIPPED GUARD：逐行照抄安装构建 dsh-api-session-controller/lib/index.js:1128-1139，
      // 读取的是真实宿主 surface。Remote 服务本体离线不可启动（见 HOST-GAPS 1）。
      const shippedAdmissionGuard = (requestId) => {
        const matches = (message) => {
          const source = message.source;
          return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId;
        };
        if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true;
        return agent.session.snapshotEvents().some((event) => {
          if (event.type !== 'user/message') return false;
          const source = event.data.source;
          return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId;
        });
      };
      let sequence = 0;
      const controller = {
        prompt: async (request) => {
          if (shippedAdmissionGuard(request.requestId)) return { accepted: true };
          sequence += 1;
          agent.followup(human('host-generated-' + sequence, request.requestId, request.content[0].text));
          return { accepted: true };
        },
      };
      const transport = createContinueTransport({ resolveController: () => controller });
      const first = await transport.send({ sessionId: agent.session.id, requestId: 'fixed-req', signal: new AbortController().signal });
      const repeat = await transport.send({ sessionId: agent.session.id, requestId: 'fixed-req', signal: new AbortController().signal });
      assert.deepEqual(first, { status: 'accepted', requestId: 'fixed-req' });
      assert.deepEqual(repeat, { status: 'accepted', requestId: 'fixed-req' });
      await settle(agent);

      const all = inspectionOf(agent);
      assert.equal(rpcMatches(all, 'fixed-req').length, 1, '同一固定 requestId 只有一次持久认领');
      assert.equal(insertionCount(all, 'fixed-req', firstEnd.seq), 1);
      const correl = correlateContinueInspection({
        sessionId: agent.session.id, rootMessageId: identity.rootMessageId, generation: identity.generation,
        originalEndSeq: firstEnd.seq, failureTurn: firstEnd.data.turn, requestId: 'fixed-req', inspection: all,
      });
      assert.equal(correl.status, 'failed');
      assert.equal(correl.turn, 2);

      // 绕过准入谓词的调用者会真的写下第二条 occurrence，投影器随即拒绝单投递结论。
      const unguarded = createContinueTransport({
        resolveController: () => ({
          prompt: async (request) => {
            sequence += 1;
            agent.followup(human('host-generated-' + sequence, request.requestId, request.content[0].text));
            return { accepted: true };
          },
        }),
      });
      await unguarded.send({ sessionId: agent.session.id, requestId: 'fixed-req', signal: new AbortController().signal });
      await settle(agent);
      const after = inspectionOf(agent);
      assert.equal(rpcMatches(after, 'fixed-req').length, 2);
      assert.equal(correlateContinueInbox({
        sessionId: agent.session.id, requestId: 'fixed-req',
        afterSeq: firstEnd.seq, snapshotSeq: after.events.length - 1, inspection: after,
      }).reason, 'inbox_history_invalid');
    } finally { await dispose(); }
  });

test('fixture 缺口自检：harness 合成快照表达不了这条契约（必须用真实宿主）',
  { timeout: 10000 }, () => {
    // 复用现有 tests/host/harness.mjs 的快照工厂，证明它给出的 error 结尾缺少宿主真实的
    // 结构化 error，也没有 agent/error 与 idle 信号，因此不能替代上面的真实 fixture。
    const inspection = inspectionFor('quota-harness-gap', { endKind: 'error' });
    const end = turnEnds(inspection).at(-1);
    assert.equal(end.data.reason.kind, 'error');
    assert.equal(Object.hasOwn(end.data.reason, 'error'), false,
      'harness 的 turn/end 只有 kind，没有宿主必定写入的 reason.error');
    const failed = inspectContinueFailure('quota-harness-gap', inspection);
    assert.equal(failed.eligible, false);
    assert.equal(failed.reason, 'not_failed_turn');
    assert.equal(inspection.events.some((event) => event.type === 'agent/inbox/spliced'), false,
      'harness 快照没有真实 inbox 拼接记录，occurrence 证据无从折叠');

    const controller = createFakeSessionController({ sessions: { 'quota-harness-gap': inspection } });
    assert.equal(typeof controller.inspect, 'function');
    assert.equal(controller.status, undefined, 'harness 控制器没有 agent/status，也没有 whenIdle');
  });

/** 本机实测的不可测项（保留导出意图，仅供文档核对；不注册测试以免变成伪断言）。 */
export const HOST_GAPS = [
  'HOST-GAP 1: sessionController Remote 服务无法离线启动 —— 实测 root.get("sessionController") === undefined（该包默认导出是 Typert 服务类，需要 api-gateway / typert-registry / attachments / fileUploads / workspaces 等 peer 插件）。因此宿主自身的 prompt 准入去重、principalOf(ctx.invocation)、附件绑定与 Remote 参数校验未被执行；本文件只观察该去重读取的真实 surface（SHIPPED GUARD 处）。',
  'HOST-GAP 2: fixture 不加载 session persistence，故 ctx.sessions.flush() 的持久性回执、进程重启后的日志回放，以及崩溃孤儿 turn 的 interrupted 结尾均不可测；这里的“持久”只到进程内事件日志为止。',
  'HOST-GAP 3: agent/request-error 返回 {kind:"retry"} 的热恢复（host/auto-resume.js + core/hot-recovery.mjs 让同一步重跑）未验证：还需要已校验的 CPAMC 额度源、每会话 opt-in 持久状态与恢复所有权协议，插件当前保持未挂载。',
  'HOST-GAP 4: Goal 轮次驱动（dsh-goal-round-driver）与自动恢复的竞争（goal_attribution_unverified / goal_user_competition）未加载，无法在真实宿主上复现 goal-source 竞争。',
  'HOST-GAP 5: dsh-scope 未加载，agent 作用域过滤分发与多 agent 并发下的错误归属未验证。',
  'HOST-GAP 6: 取消原因只覆盖 {kind:"user"}；parent / hook / disposed 三种 cause 与 max-tokens / forked 结尾未生成真实宿主样本。',
  'HOST-GAP 7: 未触碰真实 GUI 与运行中的 DSH 服务，未读取任何个人密钥；全部网络失败由离线 adapter 合成。',
];
