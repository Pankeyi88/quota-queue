/**
 * quota-queue/host — durable automatic session continuation (production wiring).
 *
 * User goal: a session stopped by a network failure or an exhausted quota
 * continues by itself once the condition recovers, without a human prod.
 *
 * ## The only evidence that authorizes anything
 *
 *  - a DURABLE `turn/end` with `reason.kind === 'error'` (the earlier
 *    `agent/error` fires while the agent is still running and is ignored);
 *  - an explicit allowlisted failure code/status (see core/continue-ticket.mjs);
 *  - a durable ticket persisted BEFORE any delivery;
 *  - fresh pre-send facts re-derived from the session log on every attempt:
 *    the exact failed turn, no newer turn, no pending inbox, no unanswered
 *    human message, no open step, the same human task root, session opt-in,
 *    global pause, Goal phase/budget, and the OS mutex verified immediately
 *    before the call.
 *
 * ## Correlation is positive, never numeric
 *
 * A delivery is proven ONLY by reading back the exact `rpcId` this driver
 * derived from durable ticket identity. A newer turn number, an idle agent, an
 * empty inbox or elapsed time never prove delivery, never clear a fence and
 * never authorize a resend. The turn that owns our message is the first
 * `turn/start` after that message's seq, and its outcome is looked up by exact
 * turn identity.
 *
 * ## Two delivery verbs
 *
 *  - Goal CAS resume when the failed turn was a Goal round and the Goal is
 *    `active + disarmed`: the same transition the UI's "continue goal" makes.
 *    The Goal service itself rejects resume when the round budget is spent.
 *  - One `继续` prompt, in `queue` mode, otherwise.
 *
 * It never approves a tool, creates a session, selects a model, reads a
 * credential or re-runs a tool.
 */
import {
  CONTINUE_TEXT,
  CONTINUE_REASONS,
  createTicket,
  decideError,
  decideTicket,
  reconcileFence,
  markClaimed,
  markDelivered,
  markUnknown,
  markCancelled,
  markAttention,
  markDone,
  ticketSummary,
  transition,
  validateTicket,
  backoffDelay,
  RETRY_AFTER_CEILING_MS,
} from '../core/continue-ticket.mjs';
/**
 * The latest HUMAN task root, ignoring this driver's own continuation messages.
 *
 * The Host records every admitted prompt as `source.kind === 'user'`, including
 * our automatic `继续` (it carries our derived `rpcId`). Treating that message
 * as a new human root would invalidate the ticket's own root and cancel the
 * second attempt. A message whose rpcId is in `ourRpcIds` is therefore never a
 * root; a real human message still is, and a different verified root cancels.
 */
export function humanRootOf(inspection, ourRpcIds = []) {
  if (inspection === null || typeof inspection !== 'object' || !Array.isArray(inspection.events)) return null;
  const ours = new Set(Array.isArray(ourRpcIds) ? ourRpcIds : []);
  let inTurn = false;
  let turnRoot = null;
  let latest = null;
  for (const event of inspection.events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/start') { inTurn = true; turnRoot = null; continue; }
    if (event.type === 'turn/end') {
      if (turnRoot !== null) latest = turnRoot;
      inTurn = false;
      turnRoot = null;
      continue;
    }
    if (event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source === null || typeof source !== 'object' || source.kind !== 'user') continue;
    if (typeof source.rpcId === 'string' && ours.has(source.rpcId)) continue;
    const id = event.data?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (inTurn && turnRoot === null) turnRoot = { rootMessageId: id, rootMessageSeq: event.seq };
  }
  return latest;
}

const REASON_SET = new Set(CONTINUE_REASONS);
const MAX_TIMEOUT_MS = 10 * 60_000;
// A ticket in one of these states has a send of OUR OWN still in flight (or a
// turn it started that is not resolved yet), so a failure arriving in that
// window belongs to the same continuation chain. Every other state — waiting
// for a first send, done, cancelled, needs_attention — means our chain is not
// what produced the failing turn.
const IN_FLIGHT_STATES = new Set(['claimed', 'unknown', 'delivered']);

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * Derive every fact one ticket needs from ONE durable session inspection.
 * Returns null when the log shape is not understood.
 */
export function factsFromInspection(inspection, ticket, scopeStartSeq = 0) {
  if (inspection === null || typeof inspection !== 'object' || !Array.isArray(inspection.events)) return null;
  const events = inspection.events;
  const turnStarts = [];
  const turnEnds = [];
  const rpcSeqs = [];
  const userAfter = [];
  let openTurn = null;
  let openStep = null;
  let goalSource = null;
  let rpcTurn = null;
  // Positive tool-outcome evidence: every dispatched call needs its result.
  // A turn/end does NOT prove a tool finished, so this set is derived from the
  // recorded tool events, not from step boundaries.
  const toolCalls = new Set();
  const toolResults = new Set();
  // The Host synthesises closers for unfinished tools on crash recovery
  // (dsh-session: ToolOutcomeUnknownError / ToolNotStartedError). A closer is
  // NOT proof of completion and must never clear the unknown-outcome flag.
  let toolOutcomeUnknown = false;
  let toolNotStarted = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event === null || typeof event !== 'object' || event.seq !== index) return null;
    const data = event.data;
    if (event.type === 'turn/start') {
      if (openTurn !== null) return null;
      if (!Number.isSafeInteger(data?.turn)) return null;
      openTurn = data.turn;
      openStep = null;
      turnStarts.push({ turn: data.turn, seq: index });
    } else if (event.type === 'turn/end') {
      if (openTurn === null || data?.turn !== openTurn) return null;
      turnEnds.push({
        turn: openTurn,
        seq: index,
        // The durable event time is the only trustworthy instant for an age
        // cap; a log without one yields null and callers must not invent it.
        at: Number.isSafeInteger(event.time) && event.time > 0 ? event.time : null,
        kind: typeof data?.reason?.kind === 'string' ? data.reason.kind : null,
        error: data?.reason?.error ?? null,
      });
      openTurn = null;
      openStep = null;
    } else if (event.type === 'step/start') {
      openStep = Number.isSafeInteger(data?.step) ? data.step : null;
    } else if (event.type === 'step/end') {
      openStep = null;
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch' || event.type === 'tool/ptc-dispatch-start') {
      // Only the CURRENT task's tools matter. A stale unresolved call from an
      // earlier task root must not block unrelated later work.
      if (index >= scopeStartSeq && typeof data?.callId === 'string' && data.callId.length > 0) toolCalls.add(data.callId);
    } else if (event.type === 'tool/result') {
      if (index < scopeStartSeq) continue;
      const callId = data?.message?.source?.callId;
      const errorCode = data?.error?.code;
      if (errorCode === 'TOOL_OUTCOME_UNKNOWN') {
        // The tool STARTED and its side effect may exist: permanent block.
        toolOutcomeUnknown = true;
      } else if (errorCode === 'TOOL_NOT_STARTED') {
        // Provably never started: no side effect. Distinguished from success
        // and from unknown, and it does not block a continuation.
        toolNotStarted += 1;
        if (typeof callId === 'string' && callId.length > 0) toolResults.add(callId);
      } else if (typeof callId === 'string' && callId.length > 0) {
        // A real tool result: the tool ran and produced a known outcome.
        toolResults.add(callId);
      }
    } else if (event.type === 'user/message') {
      const source = data?.source;
      if (source === null || typeof source !== 'object') continue;
      const currentId = typeof ticket?.requestId === 'string' ? ticket.requestId : null;
      const isOurs = typeof source.rpcId === 'string'
        && (source.rpcId === currentId
          || (Array.isArray(ticket?.rpcIds) && ticket.rpcIds.includes(source.rpcId)));
      if (isOurs) {
        // Delivery evidence is bound to THIS attempt's request id only; an
        // earlier attempt's message must never prove this one was delivered.
        if (currentId !== null && source.rpcId === currentId && source.kind === 'user') {
          rpcSeqs.push(index);
        }
        if (currentId !== null && source.rpcId === currentId && source.kind === 'user' && rpcTurn === null) {
          // The message may be admitted before its turn starts (queue mode) or
          // inside an already running turn. Both are positive turn identities.
          rpcTurn = openTurn;
          if (rpcTurn === null) {
            for (const start of turnStarts) if (start.seq > index) { rpcTurn = start.turn; break; }
          }
        }
        continue;
      }
      if (source.kind === 'user' && index > ticket.endSeq) userAfter.push(index);
      if (source.kind === 'goal' && typeof source.goalId === 'string' && source.goalId.length > 0) goalSource = source.goalId;
    }
  }
  const lastEnd = turnEnds.length === 0 ? null : turnEnds[turnEnds.length - 1];
  // A result only resolves a call from the same task scope; ids are compared
  // inside that scope because the Host may reuse nothing but does synthesise
  // closers with the same callId.
  const pendingCalls = [...toolCalls].filter((callId) => !toolResults.has(callId));
  return {
    turnStarts,
    turnEnds,
    lastEnd,
    openTurn: openTurn !== null,
    pendingStep: openStep !== null,
    pendingToolCalls: pendingCalls.length,
    toolNotStarted,
    // A dispatched call with no recorded result, or a synthetic
    // TOOL_OUTCOME_UNKNOWN closer (even with a matching callId), means the
    // side effect may exist: nothing may be auto-continued from such a turn.
    toolOutcomeUnknown: toolOutcomeUnknown || pendingCalls.length > 0,
    userAfter: userAfter.length > 0,
    rpcSeen: rpcSeqs.length > 0,
    rpcTurn,
    goalSource,
    asOfSeq: events.length - 1,
  };
}

/** First `turn/start` seq of one exact turn, or 0 when absent. */
function turnStartSeqOf(inspection, turn) {
  if (!Number.isSafeInteger(turn) || inspection === null || !Array.isArray(inspection.events)) return 0;
  for (const event of inspection.events) {
    if (event?.type === 'turn/start' && event.data?.turn === turn && Number.isSafeInteger(event.seq)) return event.seq;
  }
  return 0;
}

/** Map a prompt rejection to a safe hold reason; nothing was inserted. */
function promptFailureReason(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 'session/agent-busy' || message.includes('session/agent-busy')) return 'agent_busy';
  if (code === 'session/writer-held' || message.includes('session/writer-held')) return 'agent_busy';
  if (code === 'session/not-found') return 'session_missing';
  if (code === 'gateway/cancelled') return 'agent_busy';
  return null;
}

/**
 * @param {object} input
 * @param {object} input.store continue store (`host/continue-store.js`)
 * @param {() => object|undefined} input.resolveController sessionController (prompt delivery only)
 * @param {() => object|undefined} input.resolveInspection read-only SessionInspection port
 * @param {() => object|undefined} input.resolveAgents agents registry
 * @param {(sessionId: string) => boolean} input.getOptIn durable per-session opt-in
 * @param {() => boolean} input.isPaused durable global pause
 * @param {{owned: boolean, verify: Function}|null} [input.owner] OS mutex
 */
export function createAutoContinueDriver(input) {
  const { store, resolveController, resolveInspection, resolveAgents, getOptIn, isPaused, owner = null } = input ?? {};
  if (store === null || typeof store !== 'object' || typeof store.mutate !== 'function') throw new TypeError('auto continue requires a store');
  for (const [name, fn] of [['resolveController', resolveController], ['resolveInspection', resolveInspection], ['resolveAgents', resolveAgents], ['getOptIn', getOptIn], ['isPaused', isPaused]]) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  const clock = input.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const maxAttempts = Number.isSafeInteger(input.maxAttempts) ? input.maxAttempts : 5;
  // Quota windows can be hours to a week long. A quota ticket therefore has its
  // own low-frequency pace and its own attempt cap, so a 5h or weekly window is
  // still retried after a late recovery instead of dying early. There is no age
  // cap: waiting for quota is not a spent turn and may legitimately take days.
  const quotaAttempts = Number.isSafeInteger(input.quotaAttempts) ? input.quotaAttempts : 200;
  const quotaRetryMs = Number.isSafeInteger(input.quotaRetryMs) ? input.quotaRetryMs : 3_600_000;
  const quotaFirstRetryMs = Number.isSafeInteger(input.quotaFirstRetryMs) ? input.quotaFirstRetryMs : 300_000;
  // Bounded startup cold scan (KD-2): ONLY sessions the user opted in, read
  // once, sequentially, with a hard session cap and a per-session deadline.
  const listOptIns = typeof input.listOptIns === 'function' ? input.listOptIns : null;
  const maxColdScanSessions = Number.isSafeInteger(input.maxColdScanSessions) ? input.maxColdScanSessions : 5;
  // One bounded batch per tick, with a cursor so every finite candidate is
  // eventually scanned instead of only the first batch at startup.
  const coldScanBatchDelayMs = Number.isSafeInteger(input.coldScanBatchDelayMs)
    ? Math.max(250, input.coldScanBatchDelayMs)
    : 2_000;
  const coldScanSessionTimeoutMs = Number.isSafeInteger(input.coldScanSessionTimeoutMs)
    ? input.coldScanSessionTimeoutMs
    : 3_000;
  const pollMs = Number.isSafeInteger(input.pollMs) ? Math.max(1000, input.pollMs) : 5000;
  // Mandatory read-only quota observation before ANY automatic turn. The Host
  // mounts this only when a verified quota source exists; without one the
  // driver falls back to its time-only policy (no gate, documented).
  const readQuota = typeof input.readQuota === 'function' ? input.readQuota : null;
  // Re-ask interval while the account cannot pay for a turn. A quota wait is
  // not an attempt: nothing is sent, so the ticket keeps its attempt count.
  const quotaGateRetryMs = Number.isSafeInteger(input.quotaGateRetryMs)
    ? Math.max(60_000, input.quotaGateRetryMs)
    : 600_000;
  // Upper bound for "wake up right after the window resets".
  const QUOTA_GATE_MAX_WAIT_MS = 6 * 3_600_000;
  // One observation serves every ticket for this long, so a 5s tick can never
  // hammer the provider endpoint.
  const quotaCheckMs = Number.isSafeInteger(input.quotaCheckMs) ? Math.max(1_000, input.quotaCheckMs) : 60_000;
  // A settled session held only because its inbox still owns work must not be
  // held forever: after this long with no live run it becomes a visible
  // needs_attention instead of a silent wait.
  const busyEscalateMs = Number.isSafeInteger(input.busyEscalateMs)
    ? Math.max(60_000, input.busyEscalateMs)
    : 300_000;
  const sendTimeoutMs = Number.isSafeInteger(input.sendTimeoutMs) ? Math.min(input.sendTimeoutMs, MAX_TIMEOUT_MS) : 30_000;
  const fenceGraceMs = Number.isSafeInteger(input.fenceGraceMs) ? input.fenceGraceMs : 120_000;
  const drainTimeoutMs = Number.isSafeInteger(input.drainTimeoutMs) ? input.drainTimeoutMs : 30_000;
  // Test seam: production always uses the class ladder in core/continue-ticket.
  const delayMsFor = typeof input.delayMsFor === 'function' ? input.delayMsFor : null;
  const attemptsFor = (failureClass) => (failureClass === 'quota' ? quotaAttempts : maxAttempts);
  const delayFor = (failureClass, attempt, retryAfterMs) => {
    if (delayMsFor !== null) return delayMsFor(failureClass, attempt, retryAfterMs);
    const base = failureClass === 'quota'
      ? (attempt === 0 ? quotaFirstRetryMs : quotaRetryMs)
      : backoffDelay(failureClass, attempt, retryAfterMs);
    // A provider delay is a floor, never shortened.
    const floor = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, RETRY_AFTER_CEILING_MS)
      : 0;
    return Math.max(base, floor);
  };

  const tickets = new Map();
  const inFlight = new Set();
  // {at, value}: the last narrowed quota observation and when it was taken.
  let quotaCache = { at: -Infinity, value: null };
  // sessionId -> first instant of the current agent_busy hold (no live run).
  const busySince = new Map();
  // Everything asynchronous that could still touch the Host or the store after
  // `stop()` begins. The kernel mutex may only be released once all of it has
  // settled, otherwise a late prompt from the old owner could reach the Host
  // while a new process already holds the role.
  const pending = new Set();
  const aborters = new Set();
  const disposers = new Set();
  let started = false;
  let disposed = false;
  let tickTimer = null;
  let tickBusy = false;
  let storeOpened = false;
  let releaseSafe = true;
  let coldScanDone = false;
  let coldScanSummary = null;
  let coldScanCursor = 0;
  let coldScanCandidates = [];
  let coldScanTimer = null;
  let driverRef = null;
  // Sessions whose log has been read once for a BACKFILL decision. A switch
  // turned on after a failure must be picked up exactly once; unlimited
  // rescans would read the same large log every tick.
  const scannedSessions = new Set();
  const scanAttempts = new Map();
  // Safe diagnostics: no prompt text, no error bodies, no paths.
  const diagnostics = {
    tickCount: 0,
    lastTickAt: null,
    inspectFailures: 0,
    lastStep: null,
    lastStepAt: null,
  };
  let lastError = null;

  function track(promise) {
    const settled = Promise.resolve(promise).catch(() => {});
    pending.add(settled);
    settled.finally(() => pending.delete(settled));
    return settled;
  }

  async function drain() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  /**
   * Bounded drain used by `stop()`. If a call never settles, ownership is NOT
   * released: the caller keeps the OS mutex (and the process keeps the port)
   * rather than letting a new instance take over while an old call may still
   * reach the Host.
   */
  async function drainWithin(ms) {
    if (pending.size === 0) return true;
    // Shutdown deadline uses REAL time: an injected fake clock must not be able
    // to postpone (or hang) release safety.
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const outcome = await Promise.race([drain().then(() => 'drained'), timeout]);
    if (timer !== null) clearTimeout(timer);
    return outcome === 'drained';
  }

  const now = () => clock.now();
  // Ownership gate for EVERY durable write. A passive instance writes nothing:
  // the storage medium is last-write-wins across processes, so a passive write
  // could overwrite the active instance's fence.
  const owns = () => owner !== null && owner.owned === true;

  function normalize(ticket) {
    if (validateTicket(ticket).length > 0) throw new TypeError('invalid continuation ticket');
    return Object.freeze({ ...ticket, rpcIds: Object.freeze([...ticket.rpcIds]) });
  }

  async function persist(ticket) {
    if (!owns()) throw new Error('owner_not_held');
    const normalized = normalize(ticket);
    await store.mutate((draft) => { draft.tickets[normalized.sessionId] = normalized; });
    tickets.set(normalized.sessionId, normalized);
    return normalized;
  }

  async function hydrate() {
    tickets.clear();
    for (const [sessionId, ticket] of Object.entries(store.getSnapshot().tickets ?? {})) {
      if (validateTicket(ticket).length > 0) continue;
      tickets.set(sessionId, Object.freeze({ ...ticket, rpcIds: Object.freeze([...ticket.rpcIds]) }));
    }
  }

  async function inspectSession(sessionId) {
    let port;
    try { port = resolveInspection(); } catch { return null; }
    if (port === null || port === undefined || typeof port.inspect !== 'function') return null;
    try { return await port.inspect(sessionId); } catch { return null; }
  }

  function agentOf(sessionId) {
    let agents;
    try { agents = resolveAgents(); } catch { return null; }
    if (agents === null || agents === undefined || typeof agents.get !== 'function') return null;
    try { return agents.get(sessionId) ?? null; } catch { return null; }
  }


  async function observe(ticket) {
    const inspection = await inspectSession(ticket.sessionId);
    if (inspection === null) return null;
    // Our own automatic `继续` is a user-source message but NOT a human root.
    // Both the current attempt id and the episode ids are ours, never roots.
    const root = humanRootOf(inspection, [...ticket.rpcIds, ticket.requestId]);
    // With a verified task root, tool evidence is scoped to that task. Without
    // one the driver fails closed and treats the whole log as in scope: no
    // attribution is available, so no unknown outcome may be ignored.
    const scopeStartSeq = root !== null ? root.rootMessageSeq : 0;
    const derived = factsFromInspection(inspection, ticket, scopeStartSeq);
    if (derived === null) return null;
    const agent = agentOf(ticket.sessionId);
    let status = null;
    let inboxPending = null;
    let inboxHuman = null;
    if (agent !== null && typeof agent === 'object') {
      status = typeof agent.status === 'string' ? agent.status : null;
      const inbox = agent.inbox;
      if (inbox !== null && typeof inbox === 'object' && Array.isArray(inbox.nextTurn) && Array.isArray(inbox.nextStep)) {
        const queued = [...inbox.nextTurn, ...inbox.nextStep];
        inboxPending = queued.length;
        // Only a queued HUMAN instruction replaces the continuation: synthetic
        // notices (subagent relays, settled notices, Goal/context injections)
        // are input for the very turn we are about to start, and counting them
        // as busy deadlocked a settled quota failure against its own inbox.
        // An unreadable item is counted as human: fail closed.
        let human = 0;
        for (const entry of queued) {
          const kind = entry !== null && typeof entry === 'object'
            && entry.source !== null && typeof entry.source === 'object'
            ? entry.source.kind
            : undefined;
          if (kind === 'user' || kind === undefined) human += 1;
        }
        inboxHuman = human;
      }
    }
    return {
      ...derived,
      rootMessageId: root !== null ? root.rootMessageId : null,
      optIn: getOptIn(ticket.sessionId) === true,
      paused: isPaused() === true,
      // No mutex configured means exclusivity is UNPROVEN: fail closed.
      owner: owner !== null && owner.owned === true,
      agentStatus: status,
      inboxPending,
      inboxHuman,
      inspection,
    };
  }

  function withTimeout(promise, ms, onTimeout) {
    let timer = null;
    let settled = false;
    const timeout = new Promise((resolve) => {
      timer = clock.setTimeout(() => { if (!settled) { settled = true; onTimeout?.(); resolve({ timedOut: true }); } }, ms);
    });
    return Promise.race([
      Promise.resolve(promise).then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; }),
      timeout,
    ]).finally(() => { if (timer !== null) clock.clearTimeout(timer); });
  }

  async function sendContinue(ticket) {
    let controller;
    try { controller = resolveController(); } catch { controller = null; }
    if (controller === null || controller === undefined || typeof controller.prompt !== 'function') {
      return { kind: 'hold', reason: 'agent_busy' };
    }
    const abortController = new AbortController();
    aborters.add(abortController);
    const request = {
      requestId: ticket.requestId,
      sessionId: ticket.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: CONTINUE_TEXT }],
    };
    let outcome;
    let raw;
    try {
      // The ORIGINAL call is tracked to its REAL settlement, not to the race
      // result. A Host call that ignores abort and resolves minutes later must
      // keep blocking ownership release until it actually returns.
      raw = Promise.resolve(controller.prompt(request, abortController.signal));
      track(raw);
      outcome = await withTimeout(
        raw,
        sendTimeoutMs,
        () => { try { abortController.abort(); } catch { /* already aborted */ } },
      );
    } finally {
      aborters.delete(abortController);
    }
    if (outcome.timedOut === true) return { kind: 'unknown' };
    if (outcome.error !== undefined && outcome.error !== null) {
      const reason = promptFailureReason(outcome.error);
      return reason === null ? { kind: 'unknown' } : { kind: 'hold', reason };
    }
    const receipt = outcome.value;
    // Acceptance is NOT proof. The rpcId must be read back from the log.
    if (receipt !== null && typeof receipt === 'object' && receipt.accepted === true) return { kind: 'accepted' };
    return { kind: 'unknown' };
  }


  function waiting(ticket, reason, waitMs = null) {
    const at = now();
    // A gated quota wait is paced by its own interval; everything else keeps
    // the poll cadence. Never SHORTEN an existing schedule.
    const gap = Number.isSafeInteger(waitMs) && waitMs > 0 ? Math.max(pollMs, waitMs) : pollMs;
    return transition(ticket, {
      state: 'waiting',
      lastReason: REASON_SET.has(reason) ? reason : 'turn_not_settled',
      updatedAt: at,
      nextAt: Math.max(ticket.nextAt, at + gap),
    });
  }

  /**
   * ONE fresh read-only observation, cached briefly. The shape is narrowed here
   * and nowhere else: an unreadable or unexpected answer becomes unknown, which
   * the policy treats as do-not-send, never as available.
   */
  async function quotaObservation() {
    if (readQuota === null) return null;
    const at = now();
    if (quotaCache.value !== null && at - quotaCache.at < quotaCheckMs) return quotaCache.value;
    let snapshot = null;
    try { snapshot = await readQuota(); } catch { snapshot = null; }
    const raw = snapshot !== null && typeof snapshot === 'object' && typeof snapshot.state === 'string'
      ? snapshot.state
      : 'unknown';
    const known = raw === 'available' || raw === 'exhausted' || raw === 'rate_limited'
      || raw === 'auth_required' || raw === 'unknown';
    const value = Object.freeze({
      state: known ? raw : 'unknown',
      remaining: snapshot !== null && typeof snapshot === 'object' && typeof snapshot.remaining === 'number'
        ? snapshot.remaining : null,
      resetAt: snapshot !== null && typeof snapshot === 'object' && typeof snapshot.resetAt === 'string'
        ? snapshot.resetAt : null,
    });
    quotaCache = { at, value };
    return value;
  }

  /** How long to wait before asking the account again. */
  function quotaGateWaitMs(quota) {
    if (quota !== null && typeof quota === 'object' && typeof quota.resetAt === 'string') {
      const resetMs = Date.parse(quota.resetAt);
      if (Number.isFinite(resetMs) && resetMs > now()) {
        // Wake just after the blocked window resets instead of polling blindly,
        // bounded so a bogus far-future date cannot park the ticket forever.
        return Math.min(Math.max(quotaGateRetryMs, resetMs - now() + 5_000), QUOTA_GATE_MAX_WAIT_MS);
      }
    }
    return quotaGateRetryMs;
  }

  async function hashChange(ticket, next) {
    if (next.state === ticket.state && next.lastReason === ticket.lastReason
      && next.nextAt === ticket.nextAt && next.deliveredTurn === ticket.deliveredTurn) return;
    await persist(next);
  }

  /** Handle the outcome of our OWN delivered turn, by exact turn identity. */
  async function settleDelivered(ticket, facts) {
    if (facts.userAfter === true) return hashChange(ticket, markCancelled(ticket, { now: now(), reason: 'new_user_instruction' }));
    let deliveredTurn = ticket.deliveredTurn;
    if (deliveredTurn === null) {
      if (!(facts.rpcSeen === true && Number.isSafeInteger(facts.rpcTurn))) {
        if (now() - ticket.updatedAt >= fenceGraceMs) {
          return hashChange(ticket, markAttention(ticket, { now: now(), reason: 'delivery_unconfirmed' }));
        }
        return;
      }
      deliveredTurn = facts.rpcTurn;
    }
    const withTurn = (next) => (next.state === ticket.state && next.deliveredTurn === deliveredTurn && next.lastReason === ticket.lastReason
      ? next
      : transition(next, { state: next.state, deliveredTurn, updatedAt: now() }));
    const end = facts.turnEnds.find((entry) => entry.turn === deliveredTurn) ?? null;
    if (end === null) {
      // Record the positive turn identity as soon as it is known.
      return hashChange(ticket, withTurn(ticket));
    }
    if (end.kind === 'completed') return hashChange(ticket, withTurn(markDone(ticket, { now: now(), reason: 'delivered' })));
    if (end.kind !== 'error') {
      return hashChange(ticket, withTurn(markCancelled(ticket, { now: now(), reason: end.kind === 'aborted' ? 'user_stopped' : 'not_recoverable' })));
    }
    if (facts.toolOutcomeUnknown === true) {
      return hashChange(ticket, markAttention(ticket, { now: now(), reason: 'tool_outcome_unknown' }));
    }
    const decision = decideError(end.error);
    if (decision.action !== 'ticket') {
      return hashChange(ticket, markCancelled(ticket, { now: now(), reason: decision.reason }));
    }
    if (ticket.attempt + 1 > attemptsFor(ticket.failureClass)) {
      return hashChange(ticket, markAttention(ticket, { now: now(), reason: 'max_attempts' }));
    }
    const next = createTicket({
      sessionId: ticket.sessionId,
      turn: end.turn,
      endSeq: end.seq,
      decision,
      attempt: ticket.attempt + 1,
      goalId: ticket.goalId,
      rootMessageId: ticket.rootMessageId,
      // The chain keeps every earlier rpc id so the driver still recognises its
      // own messages as NOT human roots on later attempts.
      rpcIds: ticket.rpcIds,
      now: now(),
      delayMs: delayFor(decision.failureClass, ticket.attempt + 1, decision.retryAfterMs ?? null),
    });
    return hashChange(ticket, next);
  }

  async function applyWaiting(ticket, facts) {
    const limits = { now: now(), maxAttempts: attemptsFor(ticket.failureClass) };
    let decision = decideTicket(ticket, facts, limits);
    // The order is the contract: decideTicket already proved the session is
    // interrupted and settled; only a WOULD-BE send/resume consults the account,
    // and an unusable answer holds the ticket instead of spending a turn.
    if (decision.action === 'send' && readQuota !== null) {
      const quota = await quotaObservation();
      decision = decideTicket(ticket, { ...facts, quota }, {
        ...limits,
        quotaRequired: true,
        quotaRetryMs: quotaGateWaitMs(quota),
      });
    }
    // A sustained `agent_busy` with NO live run means the queued work will never
    // drain by itself: hold for a bounded time, then surface it to the user.
    const busyWithNoRun = (decision.action === 'wait' || decision.action === 'hold')
      && decision.reason === 'agent_busy' && facts.agentStatus !== 'running';
    if (!busyWithNoRun) busySince.delete(ticket.sessionId);
    switch (decision.action) {
      case 'wait':
      case 'hold': {
        if (busyWithNoRun) {
          const since = busySince.get(ticket.sessionId) ?? now();
          busySince.set(ticket.sessionId, since);
          if (now() - since >= busyEscalateMs) {
            busySince.delete(ticket.sessionId);
            return hashChange(ticket, markAttention(ticket, { now: now(), reason: 'agent_busy' }));
          }
        }
        // A plain "not due yet" tick must not erase WHY the ticket is waiting:
        // otherwise quota_waiting decays to backoff one tick after the gate ran
        // and the user loses the only visible explanation.
        const keepGateReason = decision.reason === 'backoff'
          && (ticket.lastReason === 'quota_waiting' || ticket.lastReason === 'quota_unknown');
        return hashChange(ticket, waiting(ticket, keepGateReason ? ticket.lastReason : decision.reason, decision.waitMs));
      }
      case 'cancel':
        return hashChange(ticket, markCancelled(ticket, { now: now(), reason: decision.reason }));
      case 'attention':
        return hashChange(ticket, markAttention(ticket, { now: now(), reason: decision.reason }));
      case 'done':
        return hashChange(ticket, markDone(ticket, { now: now(), reason: 'delivered' }));

      case 'send': {
        if (owner !== null && typeof owner.verify === 'function' && !(await owner.verify())) return;
        // Durable claim BEFORE the call into the Host.
        const claimed = markClaimed(ticket, { now: now(), requestId: ticket.requestId });
        await persist(claimed);
        const fresh = await observe(claimed);
        if (fresh === null || fresh.lastEnd === null || fresh.lastEnd.turn !== claimed.turn
          || fresh.lastEnd.kind !== 'error' || fresh.openTurn === true || fresh.pendingStep === true
          || fresh.toolOutcomeUnknown === true
          || fresh.userAfter === true || (Number.isSafeInteger(fresh.inboxHuman) && fresh.inboxHuman > 0)
          || fresh.agentStatus === 'running') {
          return hashChange(claimed, waiting(claimed, 'turn_not_settled'));
        }
        const result = await sendContinue(claimed);
        if (result.kind === 'accepted') {
          await hashChange(claimed, transition(claimed, { state: 'claimed', updatedAt: now(), lastReason: 'delivered' }));
          return;
        }
        if (result.kind === 'hold') return hashChange(claimed, waiting(claimed, result.reason));
        // Ambiguous. Reconcile once; otherwise fence. Never resend here.
        const after = await observe(claimed);
        if (after !== null && after.rpcSeen === true) {
          return hashChange(claimed, markDelivered(claimed, { now: now(), reason: 'reconciled', deliveredTurn: after.rpcTurn }));
        }
        return hashChange(claimed, markUnknown(claimed, { now: now(), reason: 'delivery_unknown' }));
      }
      default:
        return hashChange(ticket, markAttention(ticket, { now: now(), reason: 'not_recoverable' }));
    }
  }

  async function step(ticket) {
    if (disposed || inFlight.has(ticket.sessionId)) return;
    inFlight.add(ticket.sessionId);
    try {
      // Fail closed and write NOTHING: without a held OS mutex this instance has
      // no authority over the shared ticket file.
      if (!owns()) return;
      if (typeof owner.verify === 'function' && owner.verify() !== true) return;
      const facts = await observe(ticket);
      if (facts === null) {
        // A cold session whose log cannot be read is NOT silently ignored: the
        // reason is persisted once per ticket and counted for diagnosis.
        diagnostics.inspectFailures += 1;
        diagnostics.lastStep = { sessionId: ticket.sessionId, stage: 'observe', reason: 'inspection_unavailable' };
        diagnostics.lastStepAt = now();
        if (ticket.state === 'waiting') {
          // Keep the schedule: only the reason changes, so this writes once.
          await hashChange(ticket, transition(ticket, {
            state: 'waiting',
            lastReason: 'inspection_unavailable',
            updatedAt: now(),
          })).catch(() => {});
        }
        return;
      }
      if (ticket.state === 'waiting') return applyWaiting(ticket, facts);
      if (ticket.state === 'claimed' || ticket.state === 'unknown') {
        const decision = reconcileFence(ticket, facts, { now: now(), fenceGraceMs });
        if (decision.action === 'delivered') {
          return hashChange(ticket, markDelivered(ticket, { now: now(), reason: 'reconciled', deliveredTurn: facts.rpcTurn }));
        }
        if (decision.action === 'cancel') {
          return hashChange(ticket, markCancelled(ticket, { now: now(), reason: decision.reason }));
        }
        if (decision.action === 'attention') {
          return hashChange(ticket, markAttention(ticket, { now: now(), reason: decision.reason }));
        }
      }
      if (ticket.state === 'delivered') return settleDelivered(ticket, facts);
    } catch (error) {
      lastError = typeof error?.message === 'string' ? error.message : 'continue_driver_error';
    } finally {
      inFlight.delete(ticket.sessionId);
    }
  }

  /** A durable failed turn: create a ticket only when eligible and new. */
  async function recordTurnEnd(sessionId, turn, kind) {
    if (disposed || started !== true || !owns()) return null;
    if (!Number.isSafeInteger(turn) || turn < 1) return null;
    const existing = tickets.get(sessionId) ?? null;
    if (existing !== null && existing.turn === turn) return existing;
    // Do NOT read an unselected session's full log. The opt-in is checked
    // first; only a session the user enabled is ever inspected.
    if (getOptIn(sessionId) !== true) {
      if (existing !== null && ['waiting', 'claimed', 'unknown', 'delivered'].includes(existing.state)) {
        await hashChange(existing, markCancelled(existing, { now: now(), reason: 'session_opt_out' })).catch(() => {});
      }
      return null;
    }
    const inspection = await inspectSession(sessionId);
    if (inspection === null) return null;
    // Inherit the original HUMAN root across our own auto continuations.
    const root = humanRootOf(inspection,
      existing !== null ? [...existing.rpcIds, existing.requestId] : []);
    // Tool evidence is scoped to THIS task: a stale unresolved call from an
    // earlier task root must not block later work, while an unknown outcome in
    // the current task must. Without a verified root the scope is the whole log
    // (fail closed).
    const scopeStartSeq = root !== null ? root.rootMessageSeq : 0;
    const probe = factsFromInspection(inspection, { endSeq: -1, rpcIds: [] }, scopeStartSeq);
    if (probe === null) return null;
    const end = probe.turnEnds.find((entry) => entry.turn === turn) ?? null;
    if (end === null) return null;
    if (kind !== 'error') {
      if (existing !== null && (existing.state === 'waiting' || existing.state === 'claimed' || existing.state === 'unknown')) {
        if (end.turn === existing.turn && kind === 'aborted') {
          await hashChange(existing, markCancelled(existing, { now: now(), reason: 'user_stopped' })).catch(() => {});
        }
      }
      return null;
    }
    const decision = decideError(end.error);
    if (decision.action !== 'ticket') {
      if (existing !== null && (existing.state === 'waiting' || existing.state === 'claimed' || existing.state === 'unknown')) {
        await hashChange(existing, markCancelled(existing, { now: now(), reason: decision.reason })).catch(() => {});
      }
      return null;
    }
    // The attempt count is the consecutive-failure counter. It continues only
    // when THIS ticket's own send produced the failing turn; any other failure
    // (human message, another driver) starts a fresh chain at 0.
    const continuing = existing !== null
      && (existing.deliveredTurn === end.turn || IN_FLIGHT_STATES.has(existing.state));
    const attempt = continuing ? existing.attempt + 1 : 0;
    if (attempt > attemptsFor(decision.failureClass)) return null;
    const next = createTicket({
      sessionId,
      turn: end.turn,
      endSeq: end.seq,
      decision,
      attempt,
      goalId: probe.goalSource,
      rootMessageId: root !== null ? root.rootMessageId : null,
      rpcIds: existing !== null ? existing.rpcIds : [],
      now: now(),
      delayMs: delayFor(decision.failureClass, attempt, decision.retryAfterMs ?? null),
    });
    // An unknown side effect in THIS task is never auto-continued, and the
    // refusal is a durable, visible ticket rather than a silent drop.
    const persisted = await persist(probe.toolOutcomeUnknown === true
      ? markAttention(next, { now: now(), reason: 'tool_outcome_unknown' })
      : next);
    if (probe.toolOutcomeUnknown !== true) scheduleTick(0);
    return persisted;
  }

  /** Any human message that is not ours is a new instruction: tickets die. */
  async function recordUserMessage(sessionId, rpcId) {
    if (disposed || started !== true || !owns()) return;
    const ticket = tickets.get(sessionId);
    if (ticket === undefined) return;
    if (typeof rpcId === 'string' && ticket.rpcIds.includes(rpcId)) return;
    if (['waiting', 'claimed', 'unknown', 'delivered'].includes(ticket.state)) {
      await hashChange(ticket, markCancelled(ticket, { now: now(), reason: 'new_user_instruction' })).catch(() => {});
    }
  }

  function listener(session, event) {
    try {
      if (disposed || event === null || typeof event !== 'object') return;
      const sessionId = session?.id;
      if (!isId(sessionId)) return;
      const data = event.data;
      if (data === null || typeof data !== 'object') return;
      if (event.type === 'user/message') {
        const source = data.source;
        if (source?.kind === 'user') queueMicrotask(() => { track(recordUserMessage(sessionId, source.rpcId)); });
        return;
      }
      if (event.type === 'turn/end') {
        if (typeof data.reason?.kind !== 'string') return;
        queueMicrotask(() => { track(recordTurnEnd(sessionId, data.turn, data.reason.kind)); });
      }
    } catch { /* observation only */ }
  }

  function attach(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') throw new TypeError('attach requires a Cordis context');
    const offs = [];
    const bind = (agent) => {
      try {
        const agentCtx = agent?.ctx;
        if (agentCtx === null || agentCtx === undefined || typeof agentCtx.on !== 'function') return;
        const off = agentCtx.on('session/event', (session, event) => listener(session, event));
        if (typeof off === 'function') { offs.push(off); disposers.add(off); }
      } catch { /* a racing disposal only loses its subscription */ }
    };
    try {
      const offCreated = ctx.on('agent/created', ({ agent }) => bind(agent));
      if (typeof offCreated === 'function') { offs.push(offCreated); disposers.add(offCreated); }
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      if (agents && typeof agents.list === 'function') for (const agent of agents.list()) bind(agent);
    } catch { /* degraded: no subscription, no authority */ }
    const disposeSubscriptions = () => {
      for (const off of offs.splice(0)) { disposers.delete(off); try { off(); } catch { /* idempotent */ } }
    };
    disposers.add(disposeSubscriptions);
    return disposeSubscriptions;
  }

  function scheduleTick(delayMs) {
    if (!started || disposed) return;
    if (tickTimer !== null) return;
    tickTimer = clock.setTimeout(() => { tickTimer = null; tick().catch(() => {}); }, delayMs);
  }

  /** Opt-in sessions + sessions the user currently has open (still gated). */
  function coldCandidates() {
    const ids = new Set();
    if (listOptIns !== null) {
      try {
        const list = listOptIns();
        if (Array.isArray(list)) for (const id of list) if (isId(id)) ids.add(id);
      } catch { /* no candidate list */ }
    }
    try {
      const agents = resolveAgents();
      if (agents !== null && agents !== undefined && typeof agents.list === 'function') {
        for (const agent of agents.list()) {
          const id = agent?.session?.id;
          if (isId(id)) ids.add(id);
        }
      }
    } catch { /* no live agents */ }
    return [...ids];
  }

  /**
   * The ONE shared backfill decision, used by the startup scan and the opt-in
   * watcher: from an already-read inspection, persist a NORMAL ticket when —
   * and only when — the evidence is exactly what the live path would require.
   * It never sends; returns true when a ticket was written.
   */
  async function backfillFromInspection(sessionId, inspection) {
    const existing = tickets.get(sessionId) ?? null;
    const ourIds = existing !== null ? [...existing.rpcIds, existing.requestId] : [];
    const root = humanRootOf(inspection, ourIds);
    const probe = factsFromInspection(inspection, { endSeq: -1, rpcIds: ourIds },
      root !== null ? root.rootMessageSeq : 0);
    if (probe === null || probe.openTurn === true || probe.pendingStep === true
      || probe.toolOutcomeUnknown === true) return false;
    const end = probe.lastEnd;
    if (end === null || end.kind !== 'error') return false;
    // A fenced or delivered ticket still owns evidence for its turn; only the
    // normal tick may reconcile it.
    if (existing !== null && (existing.state === 'claimed' || existing.state === 'unknown')) return false;
    // Same failed turn: reopen ONLY a ticket that never delivered anything.
    const sameTurn = existing !== null && existing.turn === end.turn;
    if (sameTurn && !(existing.state === 'cancelled' && existing.deliveredTurn === null)) return false;
    const decision = decideError(end.error);
    if (decision.action !== 'ticket') return false;
    const agent = agentOf(sessionId);
    if (agent !== null && typeof agent === 'object' && agent.status === 'running') return false;
    // Same rule as the live path: only our own in-flight send continues the
    // chain; a different failure starts a fresh attempt budget. There is no age
    // cap — the failure's own turn is the anchor, never the switch click.
    const continuing = existing !== null
      && (existing.deliveredTurn === end.turn || IN_FLIGHT_STATES.has(existing.state));
    const attempt = sameTurn
      ? existing.attempt
      : (continuing && end.turn > existing.turn ? existing.attempt + 1 : 0);
    if (attempt > attemptsFor(decision.failureClass)) return false;
    const next = createTicket({
      sessionId,
      turn: end.turn,
      endSeq: end.seq,
      decision,
      attempt,
      goalId: probe.goalSource,
      rootMessageId: root !== null ? root.rootMessageId : null,
      rpcIds: existing !== null ? existing.rpcIds : [],
      now: now(),
      delayMs: delayFor(decision.failureClass, attempt, decision.retryAfterMs ?? null),
    });
    await persist(next);
    diagnostics.lastStep = { sessionId, stage: 'backfill', reason: 'ticket_created' };
    diagnostics.lastStepAt = now();
    return true;
  }
  /**
   * ONE bounded BACKFILL inspection for a session that has just opt-ed in.
   *
   * The live listener only sees FUTURE turn/end events and the startup scan is
   * one-shot, so a session that failed BEFORE its switch was turned on would
   * otherwise never get a ticket. This reads that session's log once and, when
   * the evidence is exactly what the live path would require, persists a NORMAL
   * ticket: still scheduled, still gated on quota, still claimed before send.
   *
   * It never sends, never overwrites a fenced ticket and never re-drives a
   * ticket that already owns delivery evidence. There is no age cutoff: the
   * attempt chain is the only budget.
   */
  async function scanOnce(sessionId) {
    if (disposed || !owns() || storeOpened !== true) return;
    if (!isId(sessionId) || getOptIn(sessionId) !== true) return;
    const tries = (scanAttempts.get(sessionId) ?? 0) + 1;
    scanAttempts.set(sessionId, tries);
    let inspection;
    try {
      inspection = await withTimeout(Promise.resolve(inspectSession(sessionId)), coldScanSessionTimeoutMs, null)
        .then((outcome) => (outcome.timedOut === true ? null : outcome.value));
    } catch { inspection = null; }
    if (inspection === null) {
      diagnostics.inspectFailures += 1;
      if (tries >= 3) scannedSessions.add(sessionId);
      return;
    }
    scannedSessions.add(sessionId);
    if (await backfillFromInspection(sessionId, inspection)) scheduleTick(0);
  }

  /** The earliest not-yet-scanned opt-in session, at most one per tick. */
  function nextBackfillCandidate() {
    if (listOptIns === null) return null;
    let ids;
    try { ids = listOptIns(); } catch { return null; }
    if (!Array.isArray(ids)) return null;
    const current = new Set(ids.filter((id) => isId(id)));
    // A session that is no longer opted in may be enabled AGAIN later; a stale
    // "already scanned" mark would silently skip that new opt-in.
    for (const id of [...scannedSessions]) {
      if (!current.has(id)) { scannedSessions.delete(id); scanAttempts.delete(id); }
    }
    for (const id of current) {
      if (!scannedSessions.has(id)) return id;
    }
    return null;
  }
  function scheduleColdScan() {
    if (disposed || !started || coldScanDone === true) return;
    if (coldScanTimer !== null) return;
    coldScanTimer = clock.setTimeout(() => {
      coldScanTimer = null;
      coldScanBatchNext().catch(() => {});
    }, coldScanBatchDelayMs);
  }

  async function coldScanBatchNext() {
    if (disposed || !starterCtxReady()) return;
    try { await driverRef.coldScanNow(); } catch { /* a batch failure never blocks ticks */ }
  }

  function starterCtxReady() { return started === true && owns() && storeOpened === true; }

  async function tick() {
    if (!started || disposed || tickBusy) return;
    tickBusy = true;
    try {
      if (store.degraded === true || store.locked === true) return;
      diagnostics.tickCount += 1;
      diagnostics.lastTickAt = now();
      for (const ticket of [...tickets.values()]) {
        if (disposed) return;
        if (ticket.state === 'waiting' || ticket.state === 'claimed' || ticket.state === 'unknown' || ticket.state === 'delivered') {
          await track(step(ticket));
        }
      }
      // A switch turned on AFTER a failure: the live listener only sees future
      // events and the startup scan has already finished, so backfill exactly
      // one newly opted-in session per tick (bounded log reads, no polling of
      // large logs). Skipped until the startup scan is out of the way.
      if (started && !disposed && coldScanDone === true) {
        const backfill = nextBackfillCandidate();
        if (backfill !== null) await scanOnce(backfill);
      }
    } finally {
      tickBusy = false;
      if (started && !disposed) scheduleTick(pollMs);
    }
  }

  driverRef = Object.freeze({
    listener,
    attach,
    tick,
    get started() { return started; },
    get lastError() { return lastError; },
    /** False when an in-flight call outlived stop(): the owner must be kept. */
    get releaseSafe() { return releaseSafe; },
    get coldScan() { return coldScanSummary; },
    get tickets() { return [...tickets.values()]; },

    /**
     * One BOUNDED cold-scan batch. The cursor advances across calls so every
     * finite candidate is eventually scanned, without reading an unbounded
     * number of logs in one turn.
     */
    async coldScanNow() {
      if (disposed || !owns() || storeOpened !== true) {
        return { scanned: 0, created: 0, done: true, skipped: 'not_owner_or_closed' };
      }
      if (coldScanCandidates.length === 0) coldScanCandidates = coldCandidates();
      const start = coldScanCursor;
      const slice = coldScanCandidates.slice(start, start + maxColdScanSessions);
      let scanned = 0;
      let created = 0;
      for (const sessionId of slice) {
        if (disposed) break;
        if (!isId(sessionId)) continue;
        // Re-check the durable switch on EVERY batch, never a cached list.
        if (getOptIn(sessionId) !== true) continue;
        scanned += 1;
        let inspection;
        try {
          inspection = await withTimeout(Promise.resolve(inspectSession(sessionId)), coldScanSessionTimeoutMs, null)
            .then((outcome) => (outcome.timedOut === true ? null : outcome.value));
        } catch { inspection = null; }
        if (inspection === null) continue;
        // Already read once this process: the backfill watcher must not read it
        // a second time.
        scannedSessions.add(sessionId);
        // Same decision as the opt-in watcher: a settled, recoverable failure
        // becomes one normal ticket. A cancelled ticket that never delivered may
        // be reopened (the user turned the switch back on), while a fenced or
        // delivered one is never re-driven by a restart.
        try {
          if (await backfillFromInspection(sessionId, inspection)) created += 1;
        } catch { return { scanned, created, done: false, skipped: 'persist_failed' }; }
      }
      coldScanCursor = start + slice.length;
      const done = coldScanCursor >= coldScanCandidates.length;
      if (done) {
        coldScanDone = true;
        coldScanCandidates = [];
        coldScanCursor = 0;
      }
      coldScanSummary = { scanned, created, done, scannedThrough: coldScanCursor, skipped: null };
      if (created > 0) scheduleTick(0);
      if (!done) scheduleColdScan();
      return coldScanSummary;
    },

    async start() {
      // A passive instance never opens the shared unit: no load, no write. It
      // is still marked started so a later takeover only re-calls start() after
      // the OWNER port has been acquired and the previous owner drained.
      if (!owns()) { started = true; return this; }
      if (!storeOpened) {
        await store.open();
        await hydrate();
        storeOpened = true;
      }
      started = true;
      if (store.degraded === true || store.locked === true) return this;
      if (!coldScanDone) {
        await this.coldScanNow();
      }
      scheduleTick(0);
      return this;
    },

    /**
     * Stop in the only safe order: mark disposed, remove subscriptions, abort
     * in-flight Host calls, drain every tracked task and only then close the
     * store. The caller releases the kernel mutex after this resolves.
     */
    async stop() {
      disposed = true;
      started = false;
      if (tickTimer !== null) { clock.clearTimeout(tickTimer); tickTimer = null; }
      if (coldScanTimer !== null) { clock.clearTimeout(coldScanTimer); coldScanTimer = null; }
      for (const disposeSubscriptions of [...disposers]) {
        try { disposeSubscriptions(); } catch { /* idempotent */ }
      }
      disposers.clear();
      for (const aborter of [...aborters]) { try { aborter.abort(); } catch { /* already aborted */ } }
      const drained = await drainWithin(drainTimeoutMs);
      if (!drained) {
        // An in-flight Host call ignored abort. Do NOT close the store and do
        // NOT let the caller release the owner port while it can still land.
        releaseSafe = false;
        lastError = 'drain_incomplete';
        return;
      }
      await store.close().catch(() => {});
    },

    projection() {
      const items = this.tickets
        .slice()
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(-20)
        .map(ticketSummary);
      return {
        enabled: true,
        owner: owner === null ? 'unshared' : (owner.owned === true ? 'active' : 'passive'),
        ownerReason: owner === null ? null : owner.reason,
        store: store.degraded === true ? 'invalid' : (store.locked === true ? 'locked' : 'open'),
        coldScan: coldScanSummary,
        coldScanDone,
        diagnostics: {
          tickCount: diagnostics.tickCount,
          lastTickAt: diagnostics.lastTickAt,
          inspectFailures: diagnostics.inspectFailures,
          lastStep: diagnostics.lastStep,
          lastStepAt: diagnostics.lastStepAt,
        },
        tickets: items,
      };
    },
  });
  return driverRef;
}
