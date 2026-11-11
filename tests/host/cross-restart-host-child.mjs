/*
 * Real multi-process fixture for the cross-restart recovery tests.
 *
 * Every step runs in its OWN node process and boots the REAL installed DSH host
 * stack (dsh-session + dsh-agent-loop + dsh-session-persistence-jsonl +
 * dsh-storage-json) against a temp directory, driving the REAL production
 * modules (host/continue-store.js, host/storage-port.js, host/owner-lock.js,
 * host/auto-continue.js, host/task-identity.js, host/continue-failure.js,
 * core/continue-ticket.mjs). Nothing here patches a production module.
 *
 * It only OBSERVES and prints one 'XR {...}' JSON line; all assertions live in
 * cross-restart-recovery-host.test.mjs.
 *
 * Stated stand-in (the only one): the controller mirrors the shipped Remote
 * admission path - the copied hasPromptRequest guard from
 * dsh-api-session-controller/lib/index.js:1128-1139 plus the real
 * createUserMessage/agent.followup. The Remote service itself cannot be
 * registered offline, so "sessionController admission" here means that exact
 * shipped predicate evaluated over real host surfaces.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const ROOT = process.env.XR_ROOT;
const SESSIONS = process.env.XR_SESSIONS;
const STORAGE = process.env.XR_STORAGE;
const SID = process.env.XR_SESSION;
const STEP = process.env.XR_STEP;
const PORT = Number(process.env.XR_PORT || 0);
const SHIFT = Number(process.env.XR_SHIFT || 0);
const DELAY = Number(process.env.XR_DELAY === undefined ? 900000 : process.env.XR_DELAY);

register(pathToFileURL(ROOT + '/tests/host/resolver.mjs').href, pathToFileURL(process.cwd() + '/').href);
const { Context } = await import('@deepseek-ai/cordis');
const llm = await import('@deepseek-ai/dsh-llm');
const autoMod = await import(pathToFileURL(ROOT + '/host/auto-continue.js').href);
const storeMod = await import(pathToFileURL(ROOT + '/host/continue-store.js').href);
const portMod = await import(pathToFileURL(ROOT + '/host/storage-port.js').href);
const ownerMod = await import(pathToFileURL(ROOT + '/host/owner-lock.js').href);
const identMod = await import(pathToFileURL(ROOT + '/host/task-identity.js').href);
const failMod = await import(pathToFileURL(ROOT + '/host/continue-failure.js').href);
const ticketMod = await import(pathToFileURL(ROOT + '/core/continue-ticket.mjs').href);

const CORE_PLUGINS = ['dsh-storage', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-agent',
  'dsh-system-prompt', 'dsh-session-projection', 'dsh-agent-loop'];

const emit = (payload) => new Promise((resolve) => {
  process.stdout.write('XR ' + JSON.stringify(payload) + '\n', () => resolve(true));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value = false;
    try { value = predicate(); } catch { value = false; }
    if (value === true) return true;
    if (Date.now() > deadline) throw new Error('timeout: ' + label);
    await sleep(20);
  }
}

async function plug(root, name, config) {
  const mod = await import('@deepseek-ai/' + name);
  const target = typeof mod === 'function' ? mod : (typeof mod.default === 'function' ? mod.default : mod);
  await root.plugin(target, config);
}

async function boot() {
  const root = new Context();
  await plug(root, 'dsh-storage-json', { root: STORAGE });
  await plug(root, 'dsh-session-persistence-jsonl', { root: SESSIONS });
  for (const name of CORE_PLUGINS) await plug(root, name);
  return root;
}

let releaseHang = () => undefined;

function adapter(root, mode) {
  const state = { calls: 0 };
  class Scripted extends llm.LlmAdapter {
    async *stream() {
      state.calls += 1;
      if (mode === 'hang') {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        await new Promise(() => undefined);
        return;
      }
      if (mode === 'then-hang' && state.calls > 1) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        await new Promise((resolve) => { releaseHang = resolve; });
        return;
      }
      if (mode === 'recover' || (mode === 'fail-once' && state.calls > 1)) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'recovered' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      throw new llm.LlmError('synthetic network failure', 'TRANSPORT');
    }
  }
  root.llm.registerAdapter(['xr-fixture'], new Scripted());
  return state;
}

const human = (id, rpcId, text) => ({
  id, role: 'user', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
});
const inspectionOf = (agent) => ({
  meta: agent.session.header,
  inheritedEventCount: agent.session.inheritedEventCount,
  events: agent.session.snapshotEvents().map((e) => ({ seq: e.seq, type: e.type, data: e.data })),
});

/** The shipped Remote admission guard, copied verbatim from the installed build. */
function shippedAdmissionGuard(agent, requestId) {
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
}

function makeController(agent, notes) {
  const calls = { inspect: 0, prompt: 0 };
  return {
    calls,
    async inspect(sessionId) {
      calls.inspect += 1;
      if (sessionId !== agent.session.id) throw new Error('not found');
      return inspectionOf(agent);
    },
    async prompt(request) {
      calls.prompt += 1;
      notes.push({ requestId: request.requestId, mode: request.mode, text: request.content[0].text });
      if (shippedAdmissionGuard(agent, request.requestId)) {
        notes.push({ dedupedByShippedGuard: request.requestId });
        return { accepted: true };
      }
      const message = typeof llm.createUserMessage === 'function'
        ? llm.createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } })
        : human('xr-generated-' + calls.prompt, request.requestId, request.content[0].text);
      agent.followup(message);
      return { accepted: true };
    },
  };
}

async function openStore(root) {
  const unit = await portMod.openContinueUnit(root.get('storage'), {});
  return { unit, store: storeMod.createContinueStore(portMod.createKvUnitPorts(unit)) };
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A persisted session log is MANY zstd frames; Node's one-shot decoder stops
 * at the first, so split on the frame magic and decode each slice. */
function decodeLogBuffer(buffer) {
  if (buffer.length > 0 && buffer[0] === 0x7b) return { format: 'jsonl', text: buffer.toString('utf8') };
  const magic = [0x28, 0xb5, 0x2f, 0xfd];
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) starts.push(i);
  }
  if (starts.length === 0) return { format: 'unknown', text: '' };
  const parts = [];
  for (let n = 0; n < starts.length; n += 1) {
    const end = n + 1 < starts.length ? starts[n + 1] : buffer.length;
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[n], end)).toString('utf8')); } catch { /* a trailing partial frame is not durable evidence */ }
  }
  return { format: 'jsonl+zstd', text: parts.join('\n') };
}

/** Parse whatever the JSONL backend persisted: one JSON record per line. */
function readPersistedEvents(dir) {
  const report = { files: [], events: [], parsed: 0, unparsedBytes: 0, format: 'unknown', frames: 0 };
  for (const file of filesUnder(dir)) {
    const buffer = fs.readFileSync(file);
    report.files.push({ name: path.basename(file), bytes: buffer.length });
    const decoded = decodeLogBuffer(buffer);
    if (decoded.format === 'unknown') { report.unparsedBytes += buffer.length; continue; }
    report.format = decoded.format;
    for (const line of decoded.text.split('\n')) {
      if (line.trim() === '') continue;
      try { report.events.push(JSON.parse(line)); report.parsed += 1; } catch { report.unparsedBytes += Buffer.byteLength(line); }
    }
  }
  return report;
}

/** Read the durable quota_continue_v1 unit straight off disk. */
function readPersistedTickets(dir) {
  const out = { files: [], tickets: null, shapes: [] };
  for (const file of filesUnder(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    out.files.push({ name: path.basename(file), bytes: text.length });
    out.shapes.push(text.slice(0, 120));
    if (text.indexOf('tickets') < 0) continue;
    try {
      const parsed = JSON.parse(text);
      const global = parsed && parsed.global ? parsed.global : parsed;
      if (global && global.tickets) out.tickets = global.tickets;
    } catch { /* not this file */ }
  }
  return out;
}

function summary(agent) {
  const events = agent.session.snapshotEvents();
  return {
    types: events.map((e) => e.type),
    turnStarts: events.filter((e) => e.type === 'turn/start').length,
    turnEnds: events.filter((e) => e.type === 'turn/end').map((e) => e.data),
    users: events.filter((e) => e.type === 'user/message').map((e) => ({
      id: e.data.id, kind: e.data.source && e.data.source.kind, rpcId: e.data.source && e.data.source.rpcId,
    })),
    toolResults: events.filter((e) => e.type === 'tool/result').map((e) => (e.data && e.data.error ? e.data.error.code : 'result')),
    header: agent.session.header,
    status: agent.status,
  };
}

async function makeDriver(root, agent, store, mutex, controller, options) {
  return autoMod.createAutoContinueDriver({
    store,
    resolveController: () => controller,
    resolveInspection: () => controller,
    resolveAgents: () => root.agents,
    resolveGoals: () => root.goals,
    getOptIn: () => true,
    isPaused: () => false,
    owner: { owned: mutex.owned, verify: () => mutex.verify() },
    maxAttempts: 3,
    pollMs: 1000,
    delayMsFor: () => (options === undefined ? 0 : options.delayMs),
    drainTimeoutMs: 5000,
    clock: (options !== undefined && options.shift)
      ? { now: () => Date.now() + options.shift, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) }
      : undefined,
  });
}

const teardown = [];
function bound(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { const id = setTimeout(() => resolve('teardown-timeout'), ms); if (typeof id.unref === 'function') id.unref(); }),
  ]);
}
async function runTeardown() {
  for (const fn of teardown.splice(0).reverse()) {
    try { await bound(fn(), 5000); } catch { /* a dying peer never blocks the report */ }
  }
}

async function main() {
  const notes = [];

  if (STEP === 'stage-error') {
    const root = await boot();
    adapter(root, 'error');
    const handle = await root.agents.create({ sessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    agent.followup(human('xr-root', 'xr-root-rpc', 'synthetic task'));
    await until(() => agent.session.snapshotEvents().some((e) => e.type === 'turn/end'), 8000, 'durable turn/end');
    await root.sessions.flush(agent.session);
    const disk = readPersistedEvents(SESSIONS);
    const result = {
      step: STEP, ok: true,
      disk: { format: disk.format, files: disk.files, parsed: disk.parsed, ends: disk.events.filter((e) => e.type === 'turn/end').map((e) => e.data && e.data.reason && e.data.reason.kind) },
      summary: summary(agent),
    };
    await handle.dispose();
    await root.fiber.dispose();
    await emit(result);
    return;
  }

  if (STEP === 'cold-driver-no-ticket') {
    const root = await boot();
    adapter(root, 'error');
    const handle = await root.agents.resume({ resumeSessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    const { store } = await openStore(root);
    const mutex = ownerMod.createOwnerMutex({ port: PORT, instanceId: 'xr-cold' });
    const acquired = await mutex.acquire();
    const controller = makeController(agent, notes);
    const driver = await makeDriver(root, agent, store, mutex, controller, { delayMs: DELAY });
    await driver.start();
    const coldTrace = [];
    const coldSeen = new Set();
    for (let i = 0; i < 4; i += 1) {
      await driver.tick();
      for (const tk of driver.tickets) {
        const key = [tk.requestId, tk.state, tk.turn, tk.lastReason].join('|');
        if (!coldSeen.has(key)) { coldSeen.add(key); coldTrace.push({ requestId: tk.requestId, state: tk.state, turn: tk.turn, endSeq: tk.endSeq, lastReason: tk.lastReason, rootMessageId: tk.rootMessageId }); }
      }
    }
    const cold = inspectionOf(agent);
    const result = {
      step: STEP, ok: true, acquired,
      ticketsInMemory: driver.tickets.length,
      ticketsOnDisk: readPersistedTickets(STORAGE).tickets,
      storeSnapshot: store.getSnapshot(),
      lastError: driver.lastError,
      inspectCalls: controller.calls.inspect,
      promptCalls: controller.calls.prompt,
      coldTrace,
      durableErrorPresent: cold.events.some((e) => e.type === 'turn/end' && e.data.reason.kind === 'error'),
      identity: identMod.taskIdentityFromInspection(SID, cold),
      continueFailure: failMod.inspectContinueFailure(SID, cold),
      summary: summary(agent),
    };
    await driver.stop();
    await mutex.release();
    await handle.dispose();
    await root.fiber.dispose();
    await emit(result);
    return;
  }

  if (STEP === 'stage-ticket') {
    const root = await boot();
    adapter(root, 'error');
    const handle = await root.agents.create({ sessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    const { store } = await openStore(root);
    const mutex = ownerMod.createOwnerMutex({ port: PORT, instanceId: 'xr-owner-1' });
    const acquired = await mutex.acquire();
    const controller = makeController(agent, notes);
    const driver = await makeDriver(root, agent, store, mutex, controller, { delayMs: DELAY });
    await driver.start();
    agent.ctx.on('session/event', (session, event) => { driver.listener(session, event); });
    agent.followup(human('xr-root', 'xr-root-rpc', 'synthetic task'));
    await until(() => driver.tickets.length === 1, 8000, 'ticket from a live durable turn/end');
    const ticket = driver.tickets[0];
    await root.sessions.flush(agent.session);
    const onDisk = readPersistedTickets(STORAGE);
    const releaseSafeBefore = driver.releaseSafe;
    await driver.stop();
    await mutex.release();
    await handle.dispose();
    await root.fiber.dispose();
    await emit({
      step: STEP, ok: true, acquired, releaseSafeBefore,
      promptCalls: controller.calls.prompt,
      ticket: { state: ticket.state, turn: ticket.turn, endSeq: ticket.endSeq, requestId: ticket.requestId, failureClass: ticket.failureClass, code: ticket.code, nextAt: ticket.nextAt, attempt: ticket.attempt },
      ticketsOnDisk: onDisk.tickets,
      storeFiles: onDisk.files.map((f) => f.name),
      shapes: onDisk.shapes,
    });
    return;
  }

  if (STEP === 'deliver-after-restart') {
    const root = await boot();
    adapter(root, process.env.XR_MODE || 'recover');
    const handle = await root.agents.resume({ resumeSessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    const beforeTypes = agent.session.snapshotEvents().map((e) => e.type);
    const mutex = ownerMod.createOwnerMutex({ port: PORT, instanceId: 'xr-owner-2' });
    const acquired = await mutex.acquire();
    const { store } = await openStore(root);
    const controller = makeController(agent, notes);
    const driver = await makeDriver(root, agent, store, mutex, controller, { delayMs: 0, shift: SHIFT });
    await driver.start();
    const hydrated = driver.tickets.slice();
    // Record every observable ticket shape during the settle window so the
    // test can prove what happened to the ORIGINAL hydrated ticket even after a
    // replacement ticket overwrote the same sessionId key.
    const trace = [];
    const seen = new Set();
    const pollTrace = () => {
      for (const tk of driver.tickets) {
        const key = [tk.requestId, tk.state, tk.turn, tk.lastReason, tk.attempt].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        trace.push({ requestId: tk.requestId, state: tk.state, turn: tk.turn, lastReason: tk.lastReason, attempt: tk.attempt, deliveredTurn: tk.deliveredTurn === undefined ? null : tk.deliveredTurn });
      }
      return false;
    };
    let settled;
    const tracer = setInterval(pollTrace, 40);
    try {
      await until(() => {
        const t = driver.tickets[0];
        if (t === undefined) return false;
        return ['done', 'needs_attention', 'cancelled', 'failed'].includes(t.state);
      }, Number(process.env.XR_TIMEOUT || 20000), 'ticket settles after restart');
      settled = driver.tickets[0];
    } catch (error) {
      settled = { state: 'timeout', reason: String(error.message), attempt: -1, deliveredTurn: null, rpcIds: [] };
    } finally {
      clearInterval(tracer);
      pollTrace();
    }
    await root.sessions.flush(agent.session);
    const diskTickets = readPersistedTickets(STORAGE).tickets;
    const result = {
      step: STEP, ok: true, acquired,
      hydratedStates: hydrated.map((t) => ({ state: t.state, turn: t.turn, requestId: t.requestId, nextAt: t.nextAt })),
      promptCalls: controller.calls.prompt,
      notes,
      trace,
      settled: { state: settled.state, turn: settled.turn === undefined ? null : settled.turn, rootMessageId: settled.rootMessageId === undefined ? null : settled.rootMessageId, deliveredTurn: settled.deliveredTurn === undefined ? null : settled.deliveredTurn, attempt: settled.attempt, lastReason: settled.lastReason === undefined ? null : settled.lastReason, requestId: settled.requestId, rpcIds: settled.rpcIds, deliveredSeq: settled.deliveredSeq === undefined ? null : settled.deliveredSeq },
      diskTicket: diskTickets === null ? null : Object.values(diskTickets).map((t) => ({ state: t.state, turn: t.turn === undefined ? null : t.turn, rootMessageId: t.rootMessageId === undefined ? null : t.rootMessageId, deliveredTurn: t.deliveredTurn === undefined ? null : t.deliveredTurn, attempt: t.attempt, requestId: t.requestId, lastReason: t.lastReason === undefined ? null : t.lastReason, rpcIds: t.rpcIds })),
      beforeTypes,
      summary: summary(agent),
      logFiles: readPersistedEvents(SESSIONS).files,
    };
    await driver.stop();
    await mutex.release();
    await handle.dispose();
    await root.fiber.dispose();
    await emit(result);
    return;
  }

  if (STEP === 'human-interrupt') {
    // eslint-disable-next-line no-var
    // A ticket is created for a durable error and held (XR_DELAY keeps nextAt
    // in the future), then a REAL human message with a foreign rpcId arrives.
    // dev.21 must keep cancelling the ticket for a genuine new instruction.
    const root = await boot();
    adapter(root, 'then-hang');
    const handle = await root.agents.create({ sessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    const { store } = await openStore(root);
    const mutex = ownerMod.createOwnerMutex({ port: PORT, instanceId: 'xr-human' });
    const acquired = await mutex.acquire();
    const controller = makeController(agent, notes);
    const driver = await makeDriver(root, agent, store, mutex, controller, { delayMs: DELAY });
    await driver.start();
    agent.ctx.on('session/event', (session, event) => { driver.listener(session, event); });
    agent.followup(human('xr-root', 'xr-root-rpc', 'synthetic task'));
    await until(() => driver.tickets.length === 1, 8000, 'ticket created and held');
    const held = driver.tickets[0];
    const trace = [{ requestId: held.requestId, state: held.state, turn: held.turn, lastReason: held.lastReason }];
    await root.sessions.flush(agent.session);
    // A genuine human instruction: its own rpcId, never derived from a ticket.
    agent.followup(human('xr-human-1', 'xr-human-rpc', '换个思路，先只做第一步'));
    let cancelled = null;
    try {
      await until(() => {
        const tk = driver.tickets[0];
        if (tk === undefined) return false;
            const key = [tk.requestId, tk.state, tk.turn, tk.lastReason].join('|');
        if (!trace.some((x) => [x.requestId, x.state, x.turn, x.lastReason].join('|') === key)) {
          trace.push({ requestId: tk.requestId, state: tk.state, turn: tk.turn, lastReason: tk.lastReason });
        }
        if (tk.state === 'cancelled') { cancelled = tk; return true; }
        return false;
      }, 8000, 'ticket cancelled by a real human instruction');
    } catch (error) {
      cancelled = { state: 'timeout', lastReason: String(error.message) };
    }
    const disk = readPersistedTickets(STORAGE).tickets;
    releaseHang();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = {
      step: STEP, ok: true, acquired,
      held: { state: held.state, turn: held.turn, requestId: held.requestId, rootMessageId: held.rootMessageId, nextAt: held.nextAt },
      promptCallsBeforeHuman: controller.calls.prompt,
      cancelled: cancelled === null ? null : { state: cancelled.state, lastReason: cancelled.lastReason === undefined ? null : cancelled.lastReason, requestId: cancelled.requestId, turn: cancelled.turn },
      diskTicket: disk === null ? null : Object.values(disk).map((tk) => ({ state: tk.state, lastReason: tk.lastReason, requestId: tk.requestId, rootMessageId: tk.rootMessageId })),
      trace,
      summary: summary(agent),
    };
    await driver.stop();
    await mutex.release();
    await handle.dispose();
    await root.fiber.dispose();
    await emit(result);
    return;
  }

  if (STEP === 'crash-mid-turn') {
    const root = await boot();
    adapter(root, 'hang');
    const handle = await root.agents.create({ sessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    agent.followup(human('xr-root', 'xr-root-rpc', 'synthetic task'));
    await until(() => agent.session.snapshotEvents().some((e) => e.type === 'step/start'), 8000, 'step/start durable');
    await root.sessions.flush(agent.session);
    await sleep(150);
    // Hard process death: no cancel, no turn/end, no dispose.
    process.exit(0);
  }

  if (STEP === 'resume-after-crash') {
    const disk = readPersistedEvents(SESSIONS);
    const root = await boot();
    adapter(root, 'error');
        const handle = await root.agents.resume({ resumeSessionId: SID, meta: { cwd: process.cwd() }, agentOptions: { provider: 'xr-fixture', model: 'f' } });
    const agent = handle.agent;
    const afterResume = summary(agent);
    const cold = inspectionOf(agent);
    const { store } = await openStore(root);
    const mutex = ownerMod.createOwnerMutex({ port: PORT, instanceId: 'xr-crash-owner' });
    const acquired = await mutex.acquire();
    const controller = makeController(agent, notes);
    const driver = await makeDriver(root, agent, store, mutex, controller);
    await driver.start();
    const last = cold.events[cold.events.length - 1];
    if (last !== undefined && last.type === 'turn/end') driver.listener(agent.session, last);
    for (let i = 0; i < 3; i += 1) await driver.tick();
    const end = cold.events.filter((e) => e.type === 'turn/end').at(-1);
    const result = {
      step: STEP, ok: true, acquired,
      diskBefore: {
        format: disk.format, files: disk.files, parsed: disk.parsed, unparsedBytes: disk.unparsedBytes,
        types: disk.events.map((e) => e.type),
        ends: disk.events.filter((e) => e.type === 'turn/end').map((e) => e.data && e.data.reason && e.data.reason.kind),
      },
      afterResume,
      identity: identMod.taskIdentityFromInspection(SID, cold),
      continueFailure: failMod.inspectContinueFailure(SID, cold),
      decideLastEnd: end === undefined ? null : { kind: end.data.reason.kind, decision: ticketMod.decideError(end.data.reason.error) },
      ticketsInMemory: driver.tickets.map((t) => ({ state: t.state, turn: t.turn })),
      ticketsOnDisk: readPersistedTickets(STORAGE).tickets,
      promptCalls: controller.calls.prompt,
    };
    await driver.stop();
    await mutex.release();
    await handle.dispose();
    await root.fiber.dispose();
    await emit(result);
    return;
  }

  throw new Error('unknown step ' + STEP);
}

await main()
  .catch(async (error) => {
    await emit({
      step: STEP,
      ok: false,
      error: String(error && error.message ? error.message : error),
      stack: String(error && error.stack ? error.stack : '').split('\n').slice(0, 6).join(' | '),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await runTeardown();
    // Never rely on the host stack letting the loop drain: its persistence
    // worker and the loopback server can keep handles open after a failure.
    process.exit(process.exitCode === 0 || process.exitCode === undefined ? 0 : process.exitCode);
  });
