/**
 * dev.20 跨重启恢复链：真实宿主持久化 + 真进程重启 + 真实生产模块。
 *
 * 全部跑在临时目录里（每个用例独立的 sessions/ 与 storage/ 根）：
 *  - 会话日志由真实 @deepseek-ai/dsh-session-persistence-jsonl 落盘
 *    （session.v4.jsonl.zstd，多帧 zstd，由测试自己按帧解码）；
 *  - 票据由真实 host/continue-store.js + host/storage-port.js 写入
 *    dsh-storage-json 的 quota_continue_v1.json；
 *  - 跨进程独占由真实 host/owner-lock.js 绑定同一 loopback 端口，
 *    重启后的新进程必须重新绑定成功；
 *  - “重启”是真正的进程边界：每一步都是独立 node 进程，中断步骤用
 *    process.exit(0) 硬退出（无 cancel、无 turn/end、无 dispose）。
 * 不读个人密钥，不碰 ~/.dsh、DSH_HOME、3080 GUI 或任何真实会话。
 *
 * 被测生产模块（未修改）：host/auto-continue.js、host/continue-store.js、
 * host/storage-port.js、host/owner-lock.js、host/task-identity.js、
 * host/continue-failure.js、core/continue-ticket.mjs。
 *
 * 唯一替身（如实标注）：sessionController 是 Typert Remote 服务，离线无法注册
 * （实测 root.get("sessionController") === undefined），所以 prompt/inspect 由
 * cross-restart-host-child.mjs 里的 controller 承担：inspect 直接返回真实冷读
 * 日志，prompt 逐行执行安装构建 dsh-api-session-controller/lib/index.js:1128-1139
 * 的 hasPromptRequest 准入谓词，再用真实 llm.createUserMessage + agent.followup
 * 把消息交给真实 agent loop。Remote 服务本体（参数校验、principal、附件绑定）
 * 不在本文件的验证范围内，见 NOT_VERIFIED。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'cross-restart-host-child.mjs');
const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;
const HOST_READY = ['dsh-session-persistence-jsonl', 'dsh-storage-json', 'dsh-agent-loop', 'dsh-agent', 'dsh-session', 'dsh-llm']
  .every((n) => existsSync(MODULE_ROOT + '/@deepseek-ai/' + n + '/lib/index.js'));
const READY = existsSync(CHILD) && HOST_READY;
const SKIP = READY ? false : 'DSH persistence host packages or the child fixture are unavailable';
/**
 * 缺陷台账（复测就是重跑本文件，无需改测试）：
 *  - KD-1 自动“继续”被当成新人工根 → dev.21 已修复，本文件默认验收；
 *  - KD-2 重启后不补扫既有 durable 失败 → dev.23 已修复，本文件默认验收（恰好一张、幂等、
 *    退避未到不抢发）；
 *  - interrupted（崩溃早于 turn/end）→ 明确限制，不建票，本文件第 2 条用例固定该边界。
 * 若某项再次回归，对应验收会直接失败；若行为有意改变，请连同本文件一起更新。
 */

/**
 * Isolated temporary fixture root. Order: an explicit absolute XR_TMP_ROOT, then
 * a directory beside the repo (outside it, so nothing is ever written into the
 * checkout or a user profile), then an absolute os.tmpdir(). A relative
 * os.tmpdir() (this host reports "undefined\temp") is rejected on purpose.
 */
function tempRoot() {
  const candidates = [];
  const override = process.env.XR_TMP_ROOT;
  if (typeof override === 'string' && path.isAbsolute(override)) candidates.push(override);
  candidates.push(path.resolve(REPO, '..', '..', '.tmp-xrestart'));
  try {
    const t = os.tmpdir();
    if (typeof t === 'string' && path.isAbsolute(t)) candidates.push(path.join(t, 'dsh-xrestart-fixtures'));
  } catch { /* no tmp */ }
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      return mkdtempSync(path.join(base, 'dsh-xrestart-'));
    } catch { /* try the next candidate */ }
  }
  throw new Error('no writable temporary root for the isolated fixture');
}

function cleanupInto(base) {
  rmSync(base, { recursive: true, force: true });
  const parent = path.dirname(base);
  try { if (/^dsh-xrestart-fixtures$|\.tmp-xrestart$/.test(path.basename(parent)) && fs.readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true }); } catch { /* shared or busy */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Run one fixture step in its own OS process; returns the emitted XR payload. */
function step(dirs, options) {
  const env = {
    ...process.env,
    XR_ROOT: REPO.replace(/\\/g, '/'),
    XR_SESSIONS: dirs.sessions.replace(/\\/g, '/'),
    XR_STORAGE: dirs.storage.replace(/\\/g, '/'),
    XR_SESSION: options.sessionId,
    XR_STEP: options.step,
    XR_PORT: String(options.port),
    XR_SHIFT: String(options.shift === undefined ? 1_000_000 : options.shift),
    XR_DELAY: String(options.delayMs === undefined ? 900_000 : options.delayMs),
    XR_TIMEOUT: String(options.settleTimeoutMs === undefined ? 12_000 : options.settleTimeoutMs),
    ...(options.mode === undefined ? {} : { XR_MODE: options.mode }),
  };
  const started = Date.now();
  const result = spawnSync(process.execPath, [CHILD], { cwd: REPO, encoding: 'utf8', timeout: 60_000, env });
  const line = (result.stdout === undefined ? '' : result.stdout).split('\n').filter((l) => l.startsWith('XR ')).pop();
  const payload = line === undefined ? null : JSON.parse(line.slice(3));
  return {
    ms: Date.now() - started,
    exit: result.status,
    signal: result.signal,
    payload,
    stderr: result.stderr === undefined ? '' : result.stderr.split('\n').slice(0, 6).join(' | '),
  };
}

function fixture(sessionId) {
  const base = tempRoot();
  const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
  mkdirSync(dirs.sessions, { recursive: true });
  mkdirSync(dirs.storage, { recursive: true });
  return {
    dirs,
    cleanup() { cleanupInto(base); },
    run(options) { return step(dirs, { ...options, sessionId }); },
  };
}

test('真实落盘：会话日志是真实多帧 zstd JSONL，落盘 turn/end 就是 error', { skip: SKIP, timeout: 90000 }, async () => {
  const port = await freePort();
  const fx = fixture('xr-disk-1');
  try {
    const staged = fx.run({ step: 'stage-error', port });
    assert.equal(staged.exit, 0, staged.stderr);
    assert.equal(staged.payload.ok, true, JSON.stringify(staged.payload));
    const files = staged.payload.disk.files;
    assert.equal(files.length, 1, '一个会话必须只有一个持久日志文件');
    assert.equal(files[0].name, 'session.v4.jsonl.zstd');
    assert.equal(staged.payload.disk.format, 'jsonl+zstd');
    assert.deepEqual(staged.payload.disk.ends, ['error'], '落盘的 turn/end 必须是 error');
    assert.equal(staged.payload.summary.turnEnds[0].reason.error.code, 'TRANSPORT');
    assert.equal(staged.payload.summary.users[0].rpcId, 'xr-root-rpc');

    // 测试进程自己按 zstd 帧解码磁盘字节，独立复证落盘内容。
    const found = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(full);
      }
    };
    walk(fx.dirs.sessions);
    assert.equal(found.length, 1);
    const raw = fs.readFileSync(found[0]);
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    const starts = [];
    for (let i = 0; i + 4 <= raw.length; i += 1) {
      if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) starts.push(i);
    }
    assert.ok(starts.length >= 2, '真实日志必须是多帧 zstd，实测帧数 ' + starts.length);
    const records = [];
    for (let n = 0; n < starts.length; n += 1) {
      const end2 = n + 1 < starts.length ? starts[n + 1] : raw.length;
      const decoded = zstdDecompressSync(raw.subarray(starts[n], end2)).toString('utf8');
      for (const line of decoded.split('\n')) {
        if (line.trim() === '') continue;
        try { records.push(JSON.parse(line)); } catch { /* partial frame */ }
      }
    }
    const ends = records.filter((r) => r.type === 'turn/end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].data.reason.kind, 'error');
    assert.equal(ends[0].data.reason.error.code, 'TRANSPORT');
    assert.equal(records.filter((r) => r.type === 'user/message' && r.data.source.rpcId === 'xr-root-rpc').length, 1);
    assert.equal(records[0].type, 'session', '日志首帧必须是会话头记录');
  } finally { fx.cleanup(); }
});

test('真实崩溃 + 真重启：宿主补 interrupted closer，且自动续跑链不为它建票',
  { skip: SKIP, timeout: 90000 }, async (t) => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-crash-1', port });
    try {
      const crash = run({ step: 'crash-mid-turn' });
      assert.equal(crash.exit, 0, crash.stderr);
      assert.equal(crash.payload, null, '硬退出（process.exit）不产生 XR 输出');

      // 真正的第二次进程：先按帧解码磁盘日志，再 resume。
      const resumed = run({ step: 'resume-after-crash' });
      assert.equal(resumed.exit, 0, resumed.stderr);
      assert.equal(resumed.payload.ok, true, JSON.stringify(resumed.payload));
      const before = resumed.payload.diskBefore;
      assert.equal(before.files.length, 1);
      assert.ok(before.parsed > 0, '磁盘日志必须可解码');
      assert.deepEqual(before.ends, [], '崩溃时磁盘上没有任何 turn/end');
      assert.ok(before.types.includes('step/start'), '崩溃前一步已经持久化');
      assert.equal(before.types.filter((x) => x === 'turn/start').length, 1, '崩溃时 turn 仍是打开的');

      const after = resumed.payload.afterResume;
      assert.deepEqual(after.turnEnds.map((e) => e.reason), [{ kind: 'interrupted' }],
        '真实 agent-loop resume 必须为孤儿 turn 补 interrupted closer');
      assert.equal(after.turnEnds[0].turn, 1);
      assert.equal(after.status, 'idle');

      assert.equal(resumed.payload.identity.verified, true);
      assert.equal(resumed.payload.identity.turnEndKind, 'interrupted');
      assert.deepEqual(resumed.payload.continueFailure, { eligible: false, reason: 'not_failed_turn' });
      assert.deepEqual(resumed.payload.decideLastEnd, { kind: 'interrupted', decision: { action: 'stop', reason: 'error_missing' } });

      // 驱动看到这条 interrupted turn/end 也不建票，并且一次都不发 prompt。
      assert.deepEqual(resumed.payload.ticketsInMemory, []);
      assert.equal(resumed.payload.ticketsOnDisk, null, '没有票据就没有 quota_continue_v1 写入');
      assert.equal(resumed.payload.promptCalls, 0);
      t.diagnostic('crash+resume took ' + (crash.ms + resumed.ms) + 'ms across 2 processes');
    } finally { cleanupInto(base); }
  });

test('KD-2 验收（dev.23）：真重启必须补扫既有 durable 失败，恰好一张票据且幂等',
  { skip: SKIP, timeout: 120000 }, async (t2) => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-kd2-1', port });
    try {
      // Process 1: a real durable TRANSPORT turn/end, no ticket written at all.
      const staged = run({ step: 'stage-error' });
      assert.equal(staged.exit, 0, staged.stderr);
      const failed = staged.payload.summary.turnEnds[0];
      assert.equal(failed.reason.kind, 'error');
      assert.equal(failed.reason.error.code, 'TRANSPORT');
      assert.equal(staged.payload.disk.ends[0], 'error');

      // Process 2: a brand-new owner with an EMPTY ticket unit must discover it.
      const cold = run({ step: 'cold-driver-no-ticket' });
      assert.equal(cold.exit, 0, cold.stderr);
      assert.equal(cold.payload.acquired.active, true, '新进程必须拿到 owner 端口');
      assert.equal(cold.payload.durableErrorPresent, true);
      assert.equal(cold.payload.ticketsInMemory, 1, '补扫必须恰好建 1 张票据，实测 ' + cold.payload.ticketsInMemory);
      assert.ok(cold.payload.inspectCalls > 0, '补扫必然读一次冷日志，实测 inspect=' + cold.payload.inspectCalls);
      assert.equal(cold.payload.promptCalls, 0, '退避窗口未到不得抢发，实测 prompt=' + cold.payload.promptCalls);
      const stored = cold.payload.ticketsOnDisk;
      assert.notEqual(stored, null, '补建的票据必须真实落盘');
      assert.deepEqual(Object.keys(stored), ['xr-kd2-1'], '每个会话最多一张票据');
      const ticket = stored['xr-kd2-1'];
      assert.equal(ticket.turn, failed.turn, '票据必须绑定那次遗留失败');
      assert.equal(ticket.endSeq, cold.payload.continueFailure.originalEndSeq, 'endSeq 必须等于持久 turn/end 的真实序号');
      assert.equal(ticket.failureClass, 'network');
      assert.equal(ticket.code, 'TRANSPORT');
      assert.equal(ticket.state, 'waiting');
      // Idempotence: the scan ran 4 ticks and never stacked duplicates.
      assert.equal(new Set(cold.payload.coldTrace.map((x) => x.requestId)).size, 1,
        '重复 tick 不得叠加票据：' + JSON.stringify(cold.payload.coldTrace));
      assert.deepEqual(cold.payload.coldTrace.map((x) => x.turn), [failed.turn]);
      t2.diagnostic('KD-2 scan result: ' + JSON.stringify(cold.payload.coldTrace));
    } finally { cleanupInto(base); }
  });

test('跨重启投递成功：磁盘票据 hydrate → 恰好一次 prompt → 真实第二轮 completed → done',
  { skip: SKIP, timeout: 120000 }, async () => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-done-1', port });
    try {
      const staged = run({ step: 'stage-ticket' });
      assert.equal(staged.exit, 0, staged.stderr);
      const ticket = staged.payload.ticket;
      assert.equal(ticket.state, 'waiting');
      assert.equal(ticket.turn, 1);
      assert.equal(ticket.failureClass, 'network');
      assert.equal(ticket.code, 'TRANSPORT');
      assert.match(ticket.requestId, /^qqc-[0-9a-f]{40}$/);
      assert.equal(staged.payload.promptCalls, 0, '等待窗口内不得发送');
      assert.equal(staged.payload.storeFiles.includes('quota_continue_v1.json'), true);
      assert.equal(staged.payload.ticketsOnDisk['xr-done-1'].state, 'waiting', '票据必须先真实落盘');
      assert.equal(staged.payload.releaseSafeBefore, true);

      const delivered = run({ step: 'deliver-after-restart', mode: 'recover' });
      assert.equal(delivered.exit, 0, delivered.stderr);
      const p = delivered.payload;
      assert.equal(p.acquired.active, true, '新进程必须重新拿到同一 OS 端口（旧进程已退出）');
      assert.deepEqual(p.hydratedStates.map((s) => s.state), ['waiting'], '重启后必须从磁盘 hydrate 原票据');
      assert.equal(p.hydratedStates[0].requestId, ticket.requestId);
      assert.equal(p.promptCalls, 1, '跨重启只允许一次投递');
      assert.deepEqual(p.notes, [{ requestId: ticket.requestId, mode: 'queue', text: '继续' }]);
      assert.equal(p.settled.state, 'done');
      assert.equal(p.settled.deliveredTurn, 2);
      assert.equal(p.settled.lastReason, 'delivered');
      assert.deepEqual(p.settled.rpcIds, [ticket.requestId]);
      assert.deepEqual(p.diskTicket, [{ state: 'done', turn: 1, rootMessageId: 'xr-root', deliveredTurn: 2, attempt: 0, requestId: ticket.requestId, lastReason: 'delivered', rpcIds: [ticket.requestId] }],
        '终态必须也落在磁盘 unit 上');
      assert.deepEqual(p.summary.turnEnds.map((e) => e.reason.kind), ['error', 'completed']);
      const continued = p.summary.users[1];
      assert.equal(continued.kind, 'user');
      assert.equal(continued.rpcId, ticket.requestId, '正向证据只能靠 rpcId 回读');
      assert.match(continued.id, /^[0-9a-f-]{36}$/, '消息 id 由真实 createUserMessage 生成');
      assert.equal(p.summary.status, 'idle');
    } finally { cleanupInto(base); }
  });

test('KD-1 验收（dev.21）：跨重启连续失败两次后第三次成功，票据身份与证据不丢',
  { skip: SKIP, timeout: 120000 }, async () => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-kd1-done-1', port });
    try {
      const staged = run({ step: 'stage-ticket' });
      assert.equal(staged.exit, 0, staged.stderr);
      const first = staged.payload.ticket;
      assert.equal(first.state, 'waiting');
      assert.equal(staged.payload.ticketsOnDisk['xr-kd1-done-1'].rootMessageId, 'xr-root');

      const again = run({ step: 'deliver-after-restart', mode: 'fail-once', settleTimeoutMs: 20000 });
      assert.equal(again.exit, 0, again.stderr);
      const p = again.payload;
      assert.deepEqual(p.hydratedStates.map((s) => s.state), ['waiting'], '重启后必须 hydrate 原票据');
      assert.equal(p.promptCalls, 2, '第一次自动尝试仍失败时必须按退避再试一次，实测 ' + p.promptCalls);
      const ids = p.notes.map((n) => n.requestId);
      assert.equal(ids[0], first.requestId, '首次投递必须用重启前落盘的 requestId');
      assert.equal(new Set(ids).size, ids.length, '每个 requestId 最多投递一次：' + JSON.stringify(ids));
      assert.deepEqual(p.notes.map((n) => [n.mode, n.text]), [['queue', '继续'], ['queue', '继续']]);
      assert.deepEqual(p.summary.turnEnds.map((e) => e.reason.kind), ['error', 'error', 'completed'],
        '两次真实失败后第三轮必须真实完成');
      for (const rpc of ids) {
        assert.equal(p.summary.users.filter((u) => u.rpcId === rpc).length, 1,
          '每条自动“继续”都以自己的 rpcId 恰落盘一次：' + rpc);
      }
      assert.equal(p.settled.state, 'done');
      assert.equal(p.settled.deliveredTurn, 3);
      assert.equal(p.settled.attempt, 1);
      assert.equal(p.settled.lastReason, 'delivered');
      // dev.21 核心：自动“继续”不再是新的人工根，episode 身份与累计证据都保住。
      assert.equal(p.settled.rootMessageId, 'xr-root', '任务根必须仍绑定原始人工消息');
      assert.deepEqual(p.settled.rpcIds, ids, '累计 rpcIds 必须覆盖本 episode 的每次投递');
      assert.ok(!p.trace.some((x) => x.lastReason === 'optin_task_changed'),
        '不得再出现自我取消：' + JSON.stringify(p.trace));
      assert.deepEqual(p.diskTicket.map((x) => x.state), ['done'], 'done 必须落盘');
      assert.deepEqual(p.diskTicket[0].rpcIds, ids, '落盘票据同样保留全部 episode 投递证据');
    } finally { cleanupInto(base); }
  });

test('KD-1 边界（dev.21）：真实新用户指令仍然取消票据，且不冒充自动投递',
  { skip: SKIP, timeout: 120000 }, async () => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-kd1-human-1', port, shift: 0 });
    try {
      const p = run({ step: 'human-interrupt' });
      assert.equal(p.exit, 0, p.stderr);
      assert.equal(p.payload.ok, true, JSON.stringify(p.payload));
      const d = p.payload;
      assert.equal(d.held.state, 'waiting', '退避窗口内票据必须持住、不抢跑');
      assert.equal(d.promptCallsBeforeHuman, 0, '人工指令到达前一次都不发');
      assert.equal(d.cancelled.state, 'cancelled');
      assert.equal(d.cancelled.lastReason, 'new_user_instruction',
        '真实新用户指令必须仍然取消票据（dev.21 只豁免自己的 rpcId）');
      assert.equal(d.cancelled.requestId, d.held.requestId);
      assert.deepEqual(d.diskTicket, [{ state: 'cancelled', lastReason: 'new_user_instruction', requestId: d.held.requestId, rootMessageId: 'xr-root' }],
        '取消终态必须落盘');
      assert.equal(d.summary.users[1].rpcId, 'xr-human-rpc', '那条真实人工消息本身是持久证据');
      assert.deepEqual(d.trace.map((x) => x.state), ['waiting', 'cancelled']);
    } finally { cleanupInto(base); }
  });

test('KD-1 边界（dev.21）：持续故障受 maxAttempts 约束，终态 needs_attention 而非无限重试',
  { skip: SKIP, timeout: 120000 }, async () => {
    const port = await freePort();
    const base = tempRoot();
    const dirs = { base, sessions: path.join(base, 'sessions'), storage: path.join(base, 'storage') };
    mkdirSync(dirs.sessions, { recursive: true });
    mkdirSync(dirs.storage, { recursive: true });
    const run = (options) => step(dirs, { ...options, sessionId: 'xr-kd1-cap-1', port });
    try {
      const staged = run({ step: 'stage-ticket' });
      assert.equal(staged.exit, 0, staged.stderr);
      const again = run({ step: 'deliver-after-restart', mode: 'error', settleTimeoutMs: 25000 });
      assert.equal(again.exit, 0, again.stderr);
      const p = again.payload;
      assert.equal(p.settled.state, 'needs_attention');
      assert.equal(p.settled.lastReason, 'max_attempts');
      assert.ok(p.promptCalls <= 3, '子进程 maxAttempts=3，投递必须封顶，实测 ' + p.promptCalls);
      const ids = p.notes.map((n) => n.requestId);
      assert.equal(new Set(ids).size, ids.length, '每个 requestId 最多投递一次');
      assert.equal(p.settled.rootMessageId, 'xr-root', '封顶路径同样不得把自动消息当新人工根');
      assert.ok(p.settled.rpcIds.length >= 2 && p.settled.rpcIds[0] === staged.payload.ticket.requestId,
        'episode 的累计投递证据必须从重启前那张票据开始');
      assert.ok(p.summary.turnEnds.every((e) => e.reason.kind === 'error'), 'error 模式下不应出现 completed');
    } finally { cleanupInto(base); }
  });

/* ---------------- KNOWN-DEFECT ACCEPTANCES (both active since dev.23) ---------------- */

/* DEFECT LEDGER（历史；两条都已翻为默认验收）：
 *  KD-1 本插件自己发送的“继续”取消了它自己的票据 —— dev.21 已修复，已翻为默认验收。
 *    修复前（已由轨迹复现）：票据 waiting 落盘 → 新进程 hydrate → 以该票据 requestId 投递 1 次
 *    → 该轮仍 durable error → 原票据 cancelled / lastReason=optin_task_changed，随后由
 *    新 requestId 的替换票据接管（episode 的 attempt/age 计数与已积累的 rpcIds 证据被丢弃，
 *    外部观测者无法把两次投递归到同一个恢复 episode）。
 *    根因：自动发送的“继续”是 source.kind=user 的人类根消息，taskIdentityFromInspection 会把
 *    任务根重锚到它，于是 createTicket 时绑定的 rootMessageId 与当前根不相等，
 *    host/auto-continue.js 按 dev.19 的“任务已变更”语义取消票据。
 *    修复后实测（dev.21，本文件默认验收）：humanRootOf 只承认不属于本 episode rpcIds 的 user 消息为
 *    人工根；票据跨 attempt 继承 rpcIds，因此第二、三次自动尝试仍绑定原始人工根 xr-root；
 *    连续两次失败后第三轮 completed → 票据 done / deliveredTurn=3 / attempt=1 / lastReason=delivered，
 *    落盘副本一致；每个 requestId 恰好投递一次；真实新用户指令（xr-human-rpc）仍按
 *    new_user_instruction 取消并落盘；持续故障封顶 needs_attention / max_attempts（maxAttempts=3）。
 *    修复归属：生产代码（host/auto-continue.js 的任务根比对需要按 ticket.rpcIds 豁免），
 *    本测试文件不改生产模块；该缺陷对应的验收现在默认执行。
 *  KD-2 重启后不补扫已存在的 durable 失败 —— dev.23 已实现有界冷扫，本文件默认验收。
 *    现状（已复现）：durable turn/end error 已在磁盘日志里（identity verified、
 *    continueFailure eligible/transient），新进程 hydrate 后 tickets=0、inspect 调用=0，
 *    因为 recordTurnEnd 只由 live session/event 的 turn/end 触发，hydrate 只恢复已有票据，
 *    没有任何“扫描既有失败 turn”的入口。崩溃/重启窗口里的旧失败因此永不被自动继续。
 *    期望：start（或接管 owner 后）对已 opt-in 的会话做一次有界冷扫，补建与实时路径
 *    同一形状的票据；未 opt-in 的会话仍不得读日志（保持 dev.19 第 4 条约束）。
 *    复验方式：直接重跑本文件（无环境变量开关）。
 *    届时还需一条新用例：崩溃早于 turn/end 的 interrupted 结尾按 dev.21 第 3 节属明确限制，
 *    冷扫不得为它建票（本文件的 interrupted 用例已经把该边界固定下来）。
 */

/* NOT_VERIFIED（离线隔离 fixture 无法证明，需真实宿主装配或实机窗口）：
 *  1) sessionController Remote 服务本体：无法注册（root.get("sessionController") === undefined），
 *     所以 Remote 参数校验、principalOf(ctx.invocation)、attachments.admitPromptContent、
 *     fileUploads.bindPrompt、以及 hasPromptRequest 在真服务里的调用顺序均未验证；
 *     本文件只验证“该谓词读取的真实宿主 surface 是否成立”。
 *  2) 真实 GUI/3080 上的端到端（真网络断连、真额度耗尽、真人会话）：未执行。
 *  3) 崩溃时未收口的 tool/call：本轮崩溃发生在无工具的纯模型步骤里，
 *     宿主合成 TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED closer 的真实形态未在此复现
 *     （已有离线结构回归覆盖，见 tests/host/auto-continue.test.mjs）。
 *  4) 投递窗口只能用注入 clock 前移（XR_SHIFT）代表“ outage 期间时间流逝”，
 *     不是真实等待 15 分钟。
 *  5) Goal CAS 分支（goals.resume）与 quota 类（QUOTA 码 + 小时级退避）未走真实
 *     dsh-goal 服务；本 fixture 只做非 Goal 的一次“继续”投递。
 *  6) 多进程并发写同一 unit 的 last-write-wins 竞争未测（仅顺序重启）。
 */
