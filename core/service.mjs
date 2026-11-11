/**
 * quota-queue/core — deterministic queue service (state machine + scheduler).
 *
 * Every external effect goes through an injected port. The core performs no
 * network I/O, reads no credentials, and never touches the host directly.
 *
 * ---------------------------------------------------------------------------
 * PORT CONTRACTS (the Host adapter must implement exactly these) — JSON in/out
 * ---------------------------------------------------------------------------
 * store: QueueStore                     (see ./store.mjs)
 *   load(): Promise<snapshot|null>
 *   save(snapshot): Promise<void>       resolves only after a durable write
 *
 * quota: { check(scope): Promise<QuotaSnapshot> }
 *   scope:      { scopeKey: string }    frozen; the ONLY field passed
 *   returns:    a snapshot that passes validateQuotaSnapshot, whose scopeKey
 *               equals the requested one (normalizeQuota output qualifies).
 *   Contract:   one concurrent call per scopeKey is guaranteed by this service.
 *               The port must not accept target/URL/header parameters from the
 *               core (there are none) and must fail closed when the route or
 *               credential binding is unverified.
 *
 * session:
 *   inspect(sessionId): Promise<facts>   read-only, no side effects.
 *     ALL of these must be present and explicit, otherwise dispatch is refused:
 *       sessionId: string   == the task session
 *       workspaceId: string == the task workspace
 *       cwd: string         == the task cwd snapshot
 *       provider: string    == the task route
 *       model: string       == the task route
 *       revision: string    == the task session revision
 *       running: boolean    must be false
 *       goalOwned: boolean  must be false (Goal owns auto-continuation)
 *       alwaysRetry: boolean must be false (native always-retry owns recovery)
 *   prepareNew({taskId, sessionId, workspaceId, cwd, provider, model, policy}):
 *     Promise<{ sessionId, workspaceId, cwd, revision }>
 *     Idempotent create-or-adopt BY sessionId: calling it twice with the same
 *     sessionId must never create a second session.
 *   startNew({taskId, sessionId, messageId, prompt, workspaceId, cwd,
 *             provider, model, policy}): Promise<{accepted, sessionId, messageId}>
 *   continueOriginal({taskId, sessionId, messageId, workspaceId, cwd, provider,
 *                     model, sessionRevision, policy}):
 *     Promise<{accepted, sessionId, messageId}>
 *     Delivers a minimal continue message to the ORIGINAL session: its own cwd,
 *     preset and permissions. It must not replay the original prompt, must not
 *     switch workspace, and must not bypass approvals. `policy` is always
 *     `"inherit"`.
 *   requestStop({taskId, sessionId, policy}): Promise<{accepted}>
 *     Requests cancellation only; the execution slot is retained until the host
 *     confirms or a restart reconciles.
 *   reconcile?({taskId, sessionId, messageId, claimedTurnId, policy}):
 *     Promise<{ outcome: 'completed'|'failed'|'aborted'|'not-dispatched'|'unknown',
 *                sessionId?, messageId?, claimedTurnId?, turnEndReason?,
 *                hostStopped?: boolean, sessionCreated?: boolean }>
 *     Optional. Used only after a restart to avoid blind replay, and only
 *     trusted when the evidence names the same sessionId AND messageId.
 *       'completed'      additionally requires claimedTurnId equal to the
 *                        recorded one and turnEndReason === 'completed'.
 *       'not-dispatched' additionally requires hostStopped === true; a
 *                        new-session task then needs sessionCreated === false
 *                        plus BOTH sessionIdempotentCreate and
 *                        messageIdempotentDelivery capabilities (idempotent
 *                        create is NOT message idempotency), and a resume task
 *                        needs messageIdempotentDelivery === true. An unknown
 *                        delivery state is never re-sent.
 *     Anything less becomes needs_attention instead of a silent replay.
 *
 * clock: { now(): number }               epoch milliseconds
 * ids:   { next(kind: string): string }  stable, collision-free identifiers
 * capabilities: see REQUIRED_CAPABILITIES — any value other than exactly
 *   `true` counts as false, and missing prerequisites park candidates in
 *   needs_attention instead of executing them.
 *
 * EXECUTION FENCE: from the moment a task is claimed until a matching persistent
 * terminal turn end (or `hostStopped === true`) says otherwise, the task holds
 * an execution fence. The fence is persisted, survives any status change
 * (needs_attention / paused / cancelled), occupies the global/workspace/session
 * slot in every atomic claim, and is never released by lease expiry or by
 * `pauseDispatch(false)`. `resolveExecutionFence({taskId, hostStopped|turnEnd,
 * actor})` is the explicit, evidence-only release path for a human or host.
 *
 * Turn correlation: `claimed.turn` is only meaningful inside one session, so
 * `observeTurnEnd` requires the (sessionId, turnId) PAIR. A repeated claim that
 * names a different turn never overwrites the recorded one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CORE DOES NOT PROVIDE
 * ---------------------------------------------------------------------------
 *  - real cross-process locking/fencing: `singleOwner` is an assertion the Host
 *    must back with evidence; passing `true` is not itself evidence, and the
 *    core cannot verify it. Without that evidence no task is ever executed.
 *  - exactly-once external side effects: when an external call's outcome is
 *    unknown the task keeps its execution slot (dispatchUncertain) and the next
 *    `recover()` reconciles it.
 *  - any active quota reset, credential switching or upstream URL selection.
 */
import {
  AuthorizationError,
  ClosedError,
  InputValidationError,
  NotFoundError,
  PortContractError,
  StateTransitionError,
  StoreLockedError,
} from './errors.mjs';
import {
  isPlainObject,
  isNonEmptyString,
  isInteger,
  deepCopy,
  resolveNow,
  toEpochMs,
  toIso,
  assertNonEmptyString,
  rejectDeniedFields,
} from './util.mjs';
import {
  ACTORS,
  BACKOFF_MS,
  CANCELLABLE_STATUSES,
  DISPATCHABLE_STATUSES,
  EDITABLE_STATUSES,
  TERMINAL_STATUSES,
  ACCEPTED_TURN_END_REASONS,
  REJECTED_SETTLE_REASONS,
  TURN_END_SUCCESS,
  backoffDelayMs,
  createTask,
  quotaScopeKey,
  resumeDedupeKey,
  validateTask,
} from './tasks.mjs';
import { classifyFailure } from './failure.mjs';
import { makeInferenceErrorSnapshot, validateQuotaSnapshot, SNAPSHOT_TTL_MS } from './quota.mjs';

/** Capabilities that must ALL be evidenced before any automatic execution. */
export const REQUIRED_CAPABILITIES = Object.freeze([
  'singleOwner',
  'routeBound',
  'sessionExecution',
  'workspaceResolution',
  'claimObservation',
  'turnEndObservation',
]);

/** What each capability must be backed by (documentation for the Host adapter). */
export const CAPABILITY_EVIDENCE = Object.freeze({
  singleOwner: 'proof that exactly one active plugin owner can write this snapshot',
  routeBound: 'the task route (provider+model) is bound to a verified credential reference',
  sessionExecution: 'a verified session entry point exists (prepareNew/startNew/continueOriginal)',
  workspaceResolution: 'a verified workspace registry lookup that can re-resolve the recorded workspace',
  claimObservation: 'messageId -> claimed.turn correlation is observable',
  turnEndObservation: 'persistent turn/end events with a classified reason are observable',
});

/** Optional capabilities that gate crash re-queue instead of execution. */
export const OPTIONAL_CAPABILITIES = Object.freeze(['sessionIdempotentCreate', 'messageIdempotentDelivery']);

/** Fields the core refuses to accept: raw error text, headers, URLs, secrets. */
export const DENIED_INPUT_FIELDS = Object.freeze([
  'message',
  'errorText',
  'raw',
  'rawBody',
  'body',
  'header',
  'headers',
  'requestHeaders',
  'url',
  'target',
  'endpoint',
  'authorization',
  'token',
  'accessToken',
  'apiKey',
  'apikey',
  'secret',
  'password',
  'resetQuota',
]);

/** Exact request shapes handed to the session port. */
export const PREPARE_NEW_KEYS = Object.freeze(['taskId', 'sessionId', 'workspaceId', 'cwd', 'provider', 'model', 'policy']);
export const START_NEW_KEYS = Object.freeze(['taskId', 'sessionId', 'messageId', 'prompt', 'workspaceId', 'cwd', 'provider', 'model', 'policy']);
export const CONTINUE_ORIGINAL_KEYS = Object.freeze(['taskId', 'sessionId', 'messageId', 'workspaceId', 'cwd', 'provider', 'model', 'sessionRevision', 'policy']);
export const REQUEST_STOP_KEYS = Object.freeze(['taskId', 'sessionId', 'policy']);
export const RECONCILE_KEYS = Object.freeze(['taskId', 'sessionId', 'messageId', 'claimedTurnId', 'policy']);

/** Session facts that must be explicitly present before any resume dispatch. */
export const REQUIRED_SESSION_FACTS = Object.freeze([
  ['sessionId', 'string'],
  ['workspaceId', 'string'],
  ['cwd', 'string'],
  ['provider', 'string'],
  ['model', 'string'],
  ['revision', 'string'],
  ['running', 'boolean'],
  ['goalOwned', 'boolean'],
  ['alwaysRetry', 'boolean'],
]);

/** The only policy this core ever requests: inherit the session's own rules. */
export const SESSION_POLICY = 'inherit';

/** Service defaults. `maxConcurrent` is fixed at 1 for this version. */
export const DEFAULT_CONFIG = Object.freeze({
  maxConcurrent: 1,
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  resetBufferMs: 30_000,
  maxAttempts: 20,
  maxWaitMs: 24 * 60 * 60 * 1000,
  leaseMs: 5 * 60 * 1000,
  clockSkewToleranceMs: 60_000,
});

/** Default clock port. */
export const systemClock = Object.freeze({ now: () => Date.now() });

/** Default id port: random when available, otherwise a process-local counter. */
export function systemIds() {
  let counter = 0;
  return {
    next(kind) {
      counter += 1;
      const random = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2);
      return `${kind}-${random}-${counter}`;
    },
  };
}

function requirePort(value, methods, name) {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new PortContractError(`QueueService requires the ${name} port`, [name]);
  }
  const missing = methods.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    throw new PortContractError(`${name} port is missing required methods: ${missing.join(', ')}`, missing.map((m) => `${name}.${m}`));
  }
  return value;
}

function findTask(snapshot, taskId) {
  return snapshot.tasks.find((task) => task.id === taskId) ?? null;
}

/**
 * Pure claim predicate shared by the scheduler and its unit tests.
 * Returns null when `candidate` may start, or the blocking reason.
 * @param {object[]} tasks full task list of the candidate snapshot
 * @param {object} candidate task that wants to run
 * @param {number} maxConcurrent global concurrency cap (fixed at 1 here)
 * @returns {'global_concurrency'|'workspace_or_session_lock'|null}
 */
export function claimBlockedBy(tasks, candidate, maxConcurrent = 1) {
  // Occupation is `running` OR a held execution fence: a task whose host
  // execution may still be alive keeps its global/workspace/session slot even
  // after it moved to needs_attention or paused.
  const others = tasks.filter((task) => task.id !== candidate.id
    && (task.status === 'running' || task.executionFence === true));
  if (others.length >= maxConcurrent) return 'global_concurrency';
  const conflict = others.find((task) => task.workspaceId === candidate.workspaceId
    || (task.sessionId !== null && candidate.sessionId !== null && task.sessionId === candidate.sessionId));
  return conflict ? 'workspace_or_session_lock' : null;
}

function sanitizeReasonCode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 48);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Deterministic queue service. See the module JSDoc for port contracts.
 */
export class QueueService {
  #store;
  #quota;
  #session;
  #clock;
  #ids;
  #capabilities;
  #config;
  #closed = false;
  #ownerId = null;
  #singleflight = new Map();
  #operations = new Set();
  #lastTickAt = null;
  #lastRecoverAt = null;

  constructor(ports = {}) {
    if (!isPlainObject(ports) && typeof ports !== 'object') {
      throw new InputValidationError('QueueService expects a ports object', ['ports']);
    }
    this.#store = requirePort(ports.store, ['update', 'getSnapshot', 'open', 'close'], 'store');
    this.#quota = requirePort(ports.quota, ['check'], 'quota');
    this.#session = requirePort(ports.session, ['inspect', 'prepareNew', 'startNew', 'continueOriginal', 'requestStop'], 'session');
    this.#clock = ports.clock === undefined ? systemClock : requirePort(ports.clock, ['now'], 'clock');
    this.#ids = ports.ids === undefined ? systemIds() : requirePort(ports.ids, ['next'], 'ids');
    const rawCapabilities = isPlainObject(ports.capabilities) ? ports.capabilities : {};
    const projected = {};
    for (const key of REQUIRED_CAPABILITIES) projected[key] = rawCapabilities[key] === true;
    for (const key of OPTIONAL_CAPABILITIES) projected[key] = rawCapabilities[key] === true;
    this.#capabilities = Object.freeze(projected);
    const config = { ...DEFAULT_CONFIG, ...(isPlainObject(ports.config) ? ports.config : {}) };
    if (config.maxConcurrent !== 1) {
      throw new InputValidationError('this version fixes global concurrency at 1; maxConcurrent cannot be changed', ['config.maxConcurrent']);
    }
    this.#config = Object.freeze(config);
  }

  /** Capability snapshot plus the exact list of missing execute prerequisites. */
  capabilities() {
    return Object.freeze({
      ...this.#capabilities,
      missing: Object.freeze(this.#missingCapabilities()),
      evidence: CAPABILITY_EVIDENCE,
    });
  }

  get closed() { return this.#closed; }

  // ---------------------------------------------------------------- reads ---

  /**
   * Read-only task list. Allowed after `close()` so a host can still render the
   * final state; every scheduling entry point rejects new work.
   */
  list(filter = {}) {
    const snapshot = this.#store.getSnapshot();
    const status = filter.status ?? null;
    const workspaceId = filter.workspaceId ?? null;
    const kind = filter.kind ?? null;
    const tasks = snapshot.tasks
      .filter((task) => (status === null || task.status === status)
        && (workspaceId === null || task.workspaceId === workspaceId)
        && (kind === null || task.kind === kind))
      .slice()
      .sort(compareTasks)
      .map((task) => this.#view(task, snapshot.quotaScopes[task.quotaScopeKey] ?? null, snapshot));
    return {
      revision: snapshot.revision,
      dispatchPaused: snapshot.dispatchPaused,
      dispatchPausedReason: snapshot.dispatchPausedReason,
      storeLocked: this.#store.locked === true,
      storeLockReason: this.#store.lockReason ?? null,
      capabilities: this.capabilities(),
      lastTickAt: this.#lastTickAt,
      lastRecoverAt: this.#lastRecoverAt,
      // Held fences are reported separately so a UI can explain why the queue
      // is blocked even though no task shows as running.
      executionFences: snapshot.tasks
        .filter((task) => task.executionFence === true)
        .map((task) => ({
          taskId: task.id,
          status: task.status,
          workspaceId: task.workspaceId,
          sessionId: task.sessionId,
          reason: task.fenceReason,
          since: task.fenceSince,
        })),
      tasks,
    };
  }

  getTask(taskId) {
    assertNonEmptyString(taskId, 'taskId');
    const snapshot = this.#store.getSnapshot();
    const task = findTask(snapshot, taskId);
    if (task === null) throw new NotFoundError(`unknown task: ${taskId}`);
    return this.#view(task, snapshot.quotaScopes[task.quotaScopeKey] ?? null, snapshot);
  }

  isSessionOptedIn(sessionId) {
    assertNonEmptyString(sessionId, 'sessionId');
    return this.#store.getSnapshot().sessionOptIns[sessionId] === true;
  }

  // ------------------------------------------------------------- mutations ---

  /**
   * Add a manual task. Authorization is explicit: unless `autoResume: true` is
   * supplied the task is stored as a `draft` and is NEVER dispatched.
   * The task is returned only after the snapshot commit is confirmed durable
   * (B01).
   */
  addManual(input = {}) {
    return this.#submit(() => this.#addManual(input));
  }

  async #addManual(input) {
    if (!isPlainObject(input)) throw new InputValidationError('addManual expects a plain object', ['input']);
    rejectDeniedFields(input, DENIED_INPUT_FIELDS);
    const prompt = assertNonEmptyString(input.prompt, 'prompt');
    const workspaceId = assertNonEmptyString(input.workspaceId, 'workspaceId');
    const provider = assertNonEmptyString(input.provider, 'provider');
    const model = assertNonEmptyString(input.model, 'model');
    const credentialRef = isNonEmptyString(input.credentialRef) ? input.credentialRef : null;
    const nowIso = this.#nowIso(input.now);
    const taskId = isNonEmptyString(input.taskId) ? input.taskId : this.#nextId('task');
    const sessionId = isNonEmptyString(input.sessionId) ? input.sessionId : this.#nextId('session');
    const authorized = input.autoResume === true;
    const task = createTask({
      id: taskId,
      kind: 'new-session',
      title: typeof input.title === 'string' ? input.title : undefined,
      prompt,
      workspaceId,
      workspacePathSnapshot: isNonEmptyString(input.workspacePath) ? input.workspacePath : null,
      provider,
      model,
      credentialRef,
      quotaScopeKey: isNonEmptyString(input.scopeKey) ? input.scopeKey : quotaScopeKey({ provider, model, credentialRef }),
      sessionId,
      dedupeKey: `manual:${taskId}`,
      status: authorized ? 'queued' : 'draft',
      priority: isInteger(input.priority) ? input.priority : 0,
      autoResume: authorized,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.#mutate((draft) => {
      draft.seq += 1;
      draft.tasks.push(task);
      draft.dedupeIndex[task.dedupeKey] = task.id;
      draft.updatedAt = nowIso;
    });
    return this.getTask(task.id);
  }

  /**
   * Edit a task that has not executed yet. Tasks that were already dispatched
   * (attempts > 0 or a recorded dispatch time) are rejected: rewriting their
   * prompt/route/workspace would silently replay something else.
   */
  editPending(args = {}) {
    return this.#submit(() => this.#editPending(args));
  }

  async #editPending({ taskId, patch } = {}) {
    assertNonEmptyString(taskId, 'taskId');
    if (!isPlainObject(patch)) throw new InputValidationError('patch must be a plain object', ['patch']);
    rejectDeniedFields(patch, DENIED_INPUT_FIELDS);
    const nowIso = this.#nowIso();
    const current = this.#getTaskOrThrow(taskId);
    if (!EDITABLE_STATUSES.includes(current.status)) {
      throw new StateTransitionError(`task ${taskId} is ${current.status} and cannot be edited`, { taskId, from: current.status, to: 'edited' });
    }
    if (current.attempts > 0 || current.dispatchedAt !== null) {
      throw new StateTransitionError(
        `task ${taskId} has already been dispatched; create a new task instead of rewriting this one`,
        { taskId, from: current.status, to: 'edited' },
      );
    }
    const next = deepCopy(current);
    if (patch.title !== undefined) next.title = assertNonEmptyString(patch.title, 'patch.title');
    if (patch.priority !== undefined) {
      if (!isInteger(patch.priority)) throw new InputValidationError('patch.priority must be an integer', ['patch.priority']);
      next.priority = patch.priority;
    }
    if (patch.autoResume !== undefined) {
      next.autoResume = patch.autoResume === true;
      // Explicit user authorization is what turns a draft into runnable work.
      if (next.autoResume && next.status === 'draft') next.status = 'queued';
      if (!next.autoResume && next.status === 'queued') next.status = 'draft';
    }
    if (patch.credentialRef !== undefined) next.credentialRef = isNonEmptyString(patch.credentialRef) ? patch.credentialRef : null;
    if (current.kind === 'resume-session') {
      for (const field of ['workspaceId', 'workspacePath', 'workspacePathSnapshot', 'prompt', 'sessionId']) {
        if (patch[field] !== undefined) {
          throw new StateTransitionError(`${field} is locked for a resume-session task`, { taskId, from: current.status, to: 'edited' });
        }
      }
    } else {
      if (patch.prompt !== undefined) next.prompt = assertNonEmptyString(patch.prompt, 'patch.prompt');
      if (patch.workspaceId !== undefined) next.workspaceId = assertNonEmptyString(patch.workspaceId, 'patch.workspaceId');
      if (patch.workspacePath !== undefined || patch.workspacePathSnapshot !== undefined) {
        const value = patch.workspacePath ?? patch.workspacePathSnapshot;
        next.workspacePathSnapshot = isNonEmptyString(value) ? value : null;
      }
    }
    if (patch.provider !== undefined) next.provider = assertNonEmptyString(patch.provider, 'patch.provider');
    if (patch.model !== undefined) next.model = assertNonEmptyString(patch.model, 'patch.model');
    if (patch.provider !== undefined || patch.model !== undefined || patch.credentialRef !== undefined) {
      next.quotaScopeKey = quotaScopeKey({ provider: next.provider, model: next.model, credentialRef: next.credentialRef });
    }
    next.updatedAt = nowIso;
    const issues = validateTask(next, 'task');
    if (issues.length > 0) throw new InputValidationError('edited task failed validation', issues);
    await this.#mutate((draft) => {
      // Re-validate inside the atomic transaction: the task may have started
      // running between the read above and this write.
      const live = findTask(draft, taskId);
      if (live === null) throw new NotFoundError(`unknown task: ${taskId}`);
      if (!EDITABLE_STATUSES.includes(live.status) || live.attempts > 0 || live.dispatchedAt !== null) {
        throw new StateTransitionError(`task ${taskId} changed while editing (${live.status})`, { taskId, from: live.status, to: 'edited' });
      }
      const index = draft.tasks.findIndex((task) => task.id === taskId);
      draft.tasks[index] = next;
      draft.updatedAt = nowIso;
    });
    return this.getTask(taskId);
  }

  /** Cancel a not-yet-running task. A running task must be stopped, not cancelled. */
  cancelQueued(args = {}) {
    return this.#submit(() => this.#cancelQueued(args));
  }

  async #cancelQueued({ taskId } = {}) {
    assertNonEmptyString(taskId, 'taskId');
    const nowIso = this.#nowIso();
    const current = this.#getTaskOrThrow(taskId);
    if (current.status === 'running') {
      throw new StateTransitionError(`task ${taskId} is running; request a stop and wait for confirmation`, { taskId, from: 'running', to: 'cancelled' });
    }
    if (!CANCELLABLE_STATUSES.includes(current.status)) {
      throw new StateTransitionError(`task ${taskId} is ${current.status} and cannot be cancelled`, { taskId, from: current.status, to: 'cancelled' });
    }
    await this.#mutate((draft) => {
      const live = findTask(draft, taskId);
      if (live === null) throw new NotFoundError(`unknown task: ${taskId}`);
      if (live.status === 'running') {
        throw new StateTransitionError(`task ${taskId} started running while being cancelled`, { taskId, from: 'running', to: 'cancelled' });
      }
      if (!CANCELLABLE_STATUSES.includes(live.status)) {
        throw new StateTransitionError(`task ${taskId} is ${live.status} and cannot be cancelled`, { taskId, from: live.status, to: 'cancelled' });
      }
      live.status = 'cancelled';
      live.cancelledAt = nowIso;
      live.resolution = 'cancelled_by_user';
      live.nextCheckAt = null;
      live.leaseOwner = null;
      live.leaseUntil = null;
      live.updatedAt = nowIso;
      draft.updatedAt = nowIso;
    });
    return this.getTask(taskId);
  }

  /** Pause or resume dispatch of new work. Running tasks are untouched. */
  pauseDispatch(args = {}) {
    return this.#submit(() => this.#pauseDispatch(args));
  }

  async #pauseDispatch({ paused, reason = null } = {}) {
    if (typeof paused !== 'boolean') throw new InputValidationError('paused must be a boolean', ['paused']);
    const nowIso = this.#nowIso();
    const code = paused ? (sanitizeReasonCode(reason) ?? 'user_paused') : null;
    await this.#mutate((draft) => {
      draft.dispatchPaused = paused;
      draft.dispatchPausedReason = code;
      draft.updatedAt = nowIso;
    });
    return { dispatchPaused: paused, dispatchPausedReason: code };
  }

  /**
   * Per-session auto-recovery authorization. Default is OFF, and only a `user`
   * actor may change it: a model/tool caller is rejected outright.
   */
  setSessionOptIn(args = {}) {
    return this.#submit(() => this.#setSessionOptIn(args));
  }

  async #setSessionOptIn({ sessionId, optIn, actor, by } = {}) {
    assertNonEmptyString(sessionId, 'sessionId');
    if (typeof optIn !== 'boolean') throw new InputValidationError('optIn must be a boolean', ['optIn']);
    const who = actor ?? by ?? null;
    if (!ACTORS.includes(who) || who !== 'user') {
      throw new AuthorizationError('per-session auto-recovery may only be changed by an explicit user action');
    }
    const nowIso = this.#nowIso();
    await this.#mutate((draft) => {
      draft.sessionOptIns[sessionId] = optIn;
      draft.updatedAt = nowIso;
    });
    return { sessionId, optIn };
  }

  /**
   * Capture a structured quota failure of a user task and create or update a
   * single recovery ticket. Matching order:
   *   1. a RUNNING task of the same session (a second failure updates it, A09);
   *   2. the sessionId+failedStepId+generation dedupe key (A07);
   *   3. otherwise a new ticket.
   * A key that already belongs to a terminal task is never resurrected.
   */
  captureFailure(input = {}) {
    return this.#submit(() => this.#captureFailure(input));
  }

  async #captureFailure(input) {
    if (!isPlainObject(input)) throw new InputValidationError('captureFailure expects a plain object', ['input']);
    rejectDeniedFields(input, DENIED_INPUT_FIELDS);
    const sessionId = assertNonEmptyString(input.sessionId, 'sessionId');
    const failedStepId = assertNonEmptyString(input.failedStepId, 'failedStepId');
    const generation = assertNonEmptyString(input.generation, 'generation');
    const classification = classifyFailure({ code: input.code, status: input.status });

    // Positive evidence only: without `userTask: true` a failure may belong to
    // a title/summary/helper model call, so it must never create a ticket.
    if (input.userTask !== true || input.background === true) {
      return {
        created: false,
        updated: false,
        reason: input.background === true ? 'background_task' : 'user_task_evidence_missing',
        classification,
      };
    }
    if (!classification.createsQuotaTicket) {
      return { created: false, updated: false, reason: `failure_class:${classification.class}`, classification };
    }
    if (!this.isSessionOptedIn(sessionId)) {
      return { created: false, updated: false, reason: 'session_not_opted_in', classification };
    }

    const facts = await this.#inspectSession(sessionId);
    const provider = isNonEmptyString(input.provider) ? input.provider : (facts?.provider ?? null);
    const model = isNonEmptyString(input.model) ? input.model : (facts?.model ?? null);
    const workspaceId = isNonEmptyString(input.workspaceId) ? input.workspaceId : (facts?.workspaceId ?? null);
    if (provider === null || model === null) {
      return { created: false, updated: false, reason: 'route_unresolved', classification };
    }
    if (workspaceId === null) {
      return { created: false, updated: false, reason: 'workspace_unresolved', classification };
    }
    const ownership = [];
    if (facts?.goalOwned === true) ownership.push('goal');
    if (facts?.alwaysRetry === true) ownership.push('always_retry');
    const attentionReason = ownership.length > 0 ? `ownership_conflict:${ownership.join('+')}` : null;
    const scopeKey = isNonEmptyString(input.scopeKey)
      ? input.scopeKey
      : quotaScopeKey({ provider, model, credentialRef: isNonEmptyString(input.credentialRef) ? input.credentialRef : null });
    const dedupeKey = resumeDedupeKey({ sessionId, failedStepId, generation });
    const nowMs = this.#nowMs();
    const nowIso = toIso(nowMs);

    let created = false;
    let updated = false;
    let settled = false;
    let taskId = null;
    await this.#mutate((draft) => {
      const lastFailure = {
        class: classification.class,
        code: classification.code,
        status: classification.status,
        safeSummary: classification.safeSummary,
        observedAt: nowIso,
      };
      draft.quotaScopes[scopeKey] = makeInferenceErrorSnapshot({ scopeKey, now: nowIso, classification });
      const runningMatch = draft.tasks.find((task) => task.sessionId === sessionId && task.status === 'running') ?? null;
      const indexedId = draft.dedupeIndex[dedupeKey];
      const dedupeMatch = indexedId ? findTask(draft, indexedId) : null;
      const target = runningMatch ?? dedupeMatch;
      if (target !== null && TERMINAL_STATUSES.includes(target.status)) {
        // A settled ticket is never silently recreated.
        settled = true;
        taskId = target.id;
        draft.updatedAt = nowIso;
        return;
      }
      if (target !== null) {
        updated = true;
        taskId = target.id;
        target.attempts += 1;
        target.lastFailure = lastFailure;
        target.updatedAt = nowIso;
        if (target.status === 'running') {
          target.pendingQuotaWait = true;
        } else if (attentionReason !== null) {
          target.status = 'needs_attention';
          target.needsAttentionReason = attentionReason;
          target.nextCheckAt = null;
        } else {
          target.status = 'waiting_quota';
          target.needsAttentionReason = null;
          target.nextCheckAt = toIso(nowMs + backoffDelayMs(target.attempts));
        }
        draft.updatedAt = nowIso;
        return;
      }
      created = true;
      const task = createTask({
        id: this.#nextId('task'),
        kind: 'resume-session',
        title: typeof input.title === 'string' ? input.title : undefined,
        workspaceId,
        workspacePathSnapshot: isNonEmptyString(input.workspacePath) ? input.workspacePath : (facts?.cwd ?? null),
        provider,
        model,
        credentialRef: isNonEmptyString(input.credentialRef) ? input.credentialRef : null,
        quotaScopeKey: scopeKey,
        sessionId,
        failedStepId,
        generation,
        sessionRevision: isNonEmptyString(facts?.revision) ? facts.revision : null,
        dedupeKey,
        status: attentionReason !== null ? 'needs_attention' : 'waiting_quota',
        priority: isInteger(input.priority) ? input.priority : 0,
        autoResume: input.autoResume !== false,
        attempts: 1,
        lastFailure,
        needsAttentionReason: attentionReason,
        nextCheckAt: attentionReason === null ? toIso(nowMs + backoffDelayMs(1)) : null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      taskId = task.id;
      draft.seq += 1;
      draft.tasks.push(task);
      draft.dedupeIndex[dedupeKey] = task.id;
      draft.updatedAt = nowIso;
    });
    if (settled) {
      return { created: false, updated: false, settled: true, reason: 'already_settled', taskId, dedupeKey, classification };
    }
    return { created, updated, settled: false, taskId, dedupeKey, classification, task: this.getTask(taskId) };
  }

  /**
   * Query one quota scope. Exactly one in-flight query per scopeKey (A08); a
   * refresh NEVER changes a task status — reset times and fresh snapshots only
   * schedule the next `tick`, which then decides whether to release.
   */
  checkQuota(args = {}) {
    return this.#submit(() => {
      assertNonEmptyString(args.scopeKey, 'scopeKey');
      const scopeKey = args.scopeKey;
      const existing = this.#singleflight.get(scopeKey);
      if (existing !== undefined) return existing;
      const promise = this.#runQuotaCheck(scopeKey, args.reason);
      this.#singleflight.set(scopeKey, promise);
      const cleanup = () => {
        if (this.#singleflight.get(scopeKey) === promise) this.#singleflight.delete(scopeKey);
      };
      promise.then(cleanup, cleanup);
      return promise;
    });
  }

  async #runQuotaCheck(scopeKey, reason) {
    // Only the scope key crosses the port: no URL, header, credential or model
    // text can be supplied by a caller or by error prose (A10).
    const scope = Object.freeze({ scopeKey });
    let result;
    try {
      result = await this.#quota.check(scope);
    } catch (cause) {
      await this.#recordQuota(scopeKey, failedQuerySnapshot(scopeKey, this.#nowIso(), sanitizeReasonCode(reason) ?? 'manual'));
      throw cause;
    }
    const issues = validateQuotaSnapshot(result);
    if (issues.length > 0) {
      throw new PortContractError('quota port returned a snapshot that failed validation', issues);
    }
    if (result.scopeKey !== scopeKey) {
      throw new PortContractError('quota port returned a snapshot for a different scopeKey', ['scopeKey']);
    }
    await this.#recordQuota(scopeKey, deepCopy(result));
    return deepCopy(result);
  }

  /**
   * Scheduler step:
   *  1. capability gate — missing evidence parks candidates in needs_attention;
   *  2. authorization gate — unauthorized work is paused, never executed;
   *  3. due re-checks — at most `maxChecks` per tick, and a tick that checked
   *     anything never dispatches (a reset time proves nothing by itself);
   *  4. dispatch — global serial, one task per workspace and per session,
   *     enforced INSIDE the atomic claim so concurrent ticks cannot double-start.
   */
  tick(args = {}) {
    return this.#submit(() => this.#tick(args));
  }

  async #tick({ now, maxChecks = 1 } = {}) {
    if (this.#store.locked) {
      throw new StoreLockedError(`dispatch is locked: ${this.#store.lockReason ?? 'persistence failure'}`);
    }
    const nowMs = this.#nowMs(now);
    const nowIso = toIso(nowMs);
    this.#lastTickAt = nowIso;
    const snapshot = this.#store.getSnapshot();
    const report = {
      at: nowIso,
      paused: snapshot.dispatchPaused,
      capabilityBlocked: false,
      missingCapabilities: [],
      checked: [],
      checkErrors: [],
      dispatched: [],
      needsAttention: [],
      pausedTasks: [],
      waiting: [],
    };
    if (snapshot.dispatchPaused) return report;

    // Draft tasks are deliberately NOT scheduler candidates: they exist only to
    // wait for an explicit user authorization (editPending autoResume: true).
    const candidates = snapshot.tasks
      .filter((task) => DISPATCHABLE_STATUSES.includes(task.status))
      .sort(compareTasks);
    if (candidates.length === 0) return report;

    const missing = this.#missingCapabilities();
    if (missing.length > 0) {
      const reason = `missing_capability:${missing[0]}`;
      report.capabilityBlocked = true;
      report.missingCapabilities = [...missing];
      const runnable = candidates.filter((task) => DISPATCHABLE_STATUSES.includes(task.status));
      if (runnable.length > 0) {
        await this.#mutate((draft) => {
          for (const candidate of runnable) {
            const task = findTask(draft, candidate.id);
            if (task === null || TERMINAL_STATUSES.includes(task.status)) continue;
            task.status = 'needs_attention';
            task.needsAttentionReason = reason;
            task.updatedAt = nowIso;
          }
          draft.updatedAt = nowIso;
        });
        report.needsAttention = runnable.map((task) => task.id);
      }
      return report;
    }

    const schedule = new Map();
    const attention = [];
    const pauses = [];
    const releasable = [];
    const dueScopes = [];
    let gateSnapshot = snapshot;
    for (const candidate of candidates) {
      const gate = this.#gate(candidate, gateSnapshot, nowMs);
      if (gate.nextCheckAt !== null) schedule.set(candidate.id, gate.nextCheckAt);
      switch (gate.decision) {
        case 'release':
          releasable.push(candidate);
          break;
        case 'attention':
          attention.push({ taskId: candidate.id, reason: gate.reason });
          break;
        case 'pause':
          pauses.push({ taskId: candidate.id, reason: gate.reason });
          break;
        case 'check':
          if (!dueScopes.includes(candidate.quotaScopeKey)) dueScopes.push(candidate.quotaScopeKey);
          break;
        default:
          report.waiting.push({ taskId: candidate.id, nextCheckAt: gate.nextCheckAt });
      }
    }
    if (schedule.size > 0 || attention.length > 0 || pauses.length > 0) {
      await this.#mutate((draft) => {
        for (const [taskId, iso] of schedule) {
          const task = findTask(draft, taskId);
          if (task !== null && !TERMINAL_STATUSES.includes(task.status) && task.status !== 'paused') task.nextCheckAt = iso;
        }
        for (const item of pauses) {
          const task = findTask(draft, item.taskId);
          if (task !== null && !TERMINAL_STATUSES.includes(task.status) && task.status !== 'paused') {
            task.status = 'paused';
            task.resolution = item.reason;
            task.needsAttentionReason = null;
            task.nextCheckAt = null;
          }
        }
        for (const item of attention) {
          const task = findTask(draft, item.taskId);
          if (task !== null && !TERMINAL_STATUSES.includes(task.status)) {
            task.status = 'needs_attention';
            task.needsAttentionReason = item.reason;
            task.nextCheckAt = null;
          }
        }
        draft.updatedAt = nowIso;
      });
      report.needsAttention = attention.map((item) => item.taskId);
      report.pausedTasks = pauses.map((item) => item.taskId);
    }

    const selectedChecks = dueScopes.slice(0, Math.max(0, maxChecks));
    if (selectedChecks.length > 0) {
      for (const scopeKey of selectedChecks) {
        try {
          await this.checkQuota({ scopeKey, reason: 'tick' });
          report.checked.push(scopeKey);
        } catch (error) {
          report.checkErrors.push({ scopeKey, code: error?.code ?? 'QUERY_FAILED' });
        }
      }
      return report;
    }

    if (this.#closed) return report;
    for (const candidate of releasable) {
      const outcome = await this.#dispatch(candidate, nowMs);
      report.dispatched.push(outcome);
      break;
    }
    return report;
  }

  /**
   * Bind a dispatched messageId to the turn the host actually claimed (B04).
   * A repeated claim never overwrites a different recorded turn.
   */
  observeClaim(args = {}) {
    return this.#submit(() => this.#observeClaim(args));
  }

  async #observeClaim({ messageId, turnId, sessionId } = {}) {
    assertNonEmptyString(messageId, 'messageId');
    assertNonEmptyString(turnId, 'turnId');
    const nowIso = this.#nowIso();
    let result = { matched: false };
    await this.#mutate((draft) => {
      const task = draft.tasks.find((candidate) => candidate.dispatchedMessageId === messageId && candidate.status === 'running');
      if (task === undefined) return;
      if (isNonEmptyString(sessionId) && task.sessionId !== sessionId) {
        result = { matched: false, reason: 'session_mismatch', taskId: task.id };
        return;
      }
      if (task.claimedTurnId !== null && task.claimedTurnId !== turnId) {
        result = { matched: true, conflict: 'turn_already_claimed', taskId: task.id, claimedTurnId: task.claimedTurnId };
        return;
      }
      task.claimedTurnId = turnId;
      task.updatedAt = nowIso;
      draft.updatedAt = nowIso;
      result = { matched: true, taskId: task.id, turnId, alreadyClaimed: true };
    });
    return result;
  }

  /**
   * Settle a task from a persistent turn end, qualified by BOTH session and turn
   * because `claimed.turn` is session-local. Only `completed` is success;
   * idle/receipt/whenIdle are rejected, and a user stop never re-queues.
   */
  observeTurnEnd(args = {}) {
    return this.#submit(() => this.#observeTurnEnd(args));
  }

  async #observeTurnEnd({ sessionId, turnId, reason } = {}) {
    assertNonEmptyString(sessionId, 'sessionId');
    assertNonEmptyString(turnId, 'turnId');
    assertNonEmptyString(reason, 'reason');
    const normalized = reason.trim().toLowerCase();
    if (REJECTED_SETTLE_REASONS.includes(normalized)) {
      throw new InputValidationError(`'${normalized}' is not completion evidence; a task settles only from a persistent turn end`, ['reason']);
    }
    const known = ACCEPTED_TURN_END_REASONS.includes(normalized);
    const nowMs = this.#nowMs();
    const nowIso = toIso(nowMs);
    let settled = null;
    await this.#mutate((draft) => {
      const task = draft.tasks.find((candidate) => candidate.claimedTurnId === turnId
        && candidate.sessionId === sessionId
        && candidate.status === 'running');
      if (task === undefined) return;
      task.leaseOwner = null;
      task.leaseUntil = null;
      task.dispatchUncertain = false;
      // A matching persistent turn end is positive proof that this execution
      // stopped, so the fence may be released.
      task.executionFence = false;
      task.fenceReason = null;
      task.fenceSince = null;
      task.updatedAt = nowIso;
      if (normalized === TURN_END_SUCCESS) {
        task.status = 'completed';
        task.completedAt = nowIso;
        task.resolution = 'turn_completed';
        task.pendingQuotaWait = false;
        task.needsAttentionReason = null;
      } else if (normalized === 'error') {
        if (task.pendingQuotaWait) {
          task.status = 'waiting_quota';
          task.resolution = 'quota_failure';
          task.nextCheckAt = toIso(nowMs + backoffDelayMs(task.attempts));
        } else {
          task.status = 'needs_attention';
          task.needsAttentionReason = 'turn_error';
          task.resolution = 'turn_error';
        }
      } else if (['aborted', 'canceled', 'cancelled', 'discarded'].includes(normalized)) {
        if (task.stopRequested) {
          task.status = 'paused';
          task.resolution = 'stopped_by_user';
          task.needsAttentionReason = null;
        } else {
          task.status = 'needs_attention';
          task.needsAttentionReason = `turn_${normalized}`;
          task.resolution = `turn_${normalized}`;
        }
      } else if (normalized === 'blocked') {
        task.status = 'needs_attention';
        task.needsAttentionReason = 'waiting_for_user_input_or_approval';
        task.resolution = 'turn_blocked';
      } else if (normalized === 'max-tokens') {
        task.status = 'needs_attention';
        task.needsAttentionReason = 'turn_max_tokens';
        task.resolution = 'turn_max_tokens';
      } else if (normalized === 'interrupted' || normalized === 'forked') {
        // Crash recovery / fork padding: explicitly NOT success.
        task.status = 'needs_attention';
        task.needsAttentionReason = `turn_${normalized}`;
        task.resolution = `turn_${normalized}`;
      } else {
        task.status = 'needs_attention';
        task.needsAttentionReason = 'unclassified_turn_end';
        task.resolution = 'unclassified_turn_end';
      }
      settled = { taskId: task.id, status: task.status, reason: known ? normalized : 'unclassified', resolution: task.resolution };
      draft.updatedAt = nowIso;
    });
    return settled === null ? { matched: false } : { matched: true, ...settled };
  }

  /**
   * The user continued the original session by hand: outstanding background
   * recovery tickets for that session are dissolved so nothing runs twice.
   */
  manualContinued(args = {}) {
    return this.#submit(() => this.#manualContinued(args));
  }

  async #manualContinued({ sessionId } = {}) {
    assertNonEmptyString(sessionId, 'sessionId');
    const nowIso = this.#nowIso();
    const resolved = [];
    const runningConflicts = [];
    await this.#mutate((draft) => {
      for (const task of draft.tasks) {
        if (task.kind !== 'resume-session' || task.sessionId !== sessionId) continue;
        if (TERMINAL_STATUSES.includes(task.status)) continue;
        if (task.status === 'running') {
          task.stopRequested = true;
          task.requestedStopAt = nowIso;
          task.needsAttentionReason = 'manual_continue_while_running';
          runningConflicts.push(task.id);
          continue;
        }
        task.status = 'cancelled';
        task.cancelledAt = nowIso;
        task.resolution = 'manual_continue';
        task.needsAttentionReason = null;
        task.nextCheckAt = null;
        task.leaseOwner = null;
        task.leaseUntil = null;
        resolved.push(task.id);
      }
      if (resolved.length > 0 || runningConflicts.length > 0) draft.updatedAt = nowIso;
    });
    return { sessionId, resolved, runningConflicts };
  }

  /**
   * Request a stop for a running task. The execution slot is NOT released until
   * the host confirms; the task is never automatically re-queued.
   */
  requestStop(args = {}) {
    return this.#submit(() => this.#requestStop(args));
  }

  async #requestStop({ taskId } = {}) {
    assertNonEmptyString(taskId, 'taskId');
    const current = this.#getTaskOrThrow(taskId);
    if (current.status !== 'running') {
      throw new StateTransitionError(`task ${taskId} is ${current.status}; only a running task can be stopped`, { taskId, from: current.status, to: 'stop_requested' });
    }
    const nowIso = this.#nowIso();
    await this.#mutate((draft) => {
      const task = findTask(draft, taskId);
      if (task === null || task.status !== 'running') return;
      task.stopRequested = true;
      task.requestedStopAt = nowIso;
      // A stop REQUEST is not a stop confirmation: the fence stays held.
      if (task.executionFence === true) task.fenceReason = 'stop_requested_unconfirmed';
      task.updatedAt = nowIso;
      draft.updatedAt = nowIso;
    });
    const request = Object.freeze({ taskId, sessionId: current.sessionId, policy: SESSION_POLICY });
    try {
      await this.#session.requestStop(request);
    } catch (error) {
      return { requested: false, status: 'running', awaitingConfirmation: true, code: error?.code ?? 'STOP_REQUEST_FAILED' };
    }
    return { requested: true, status: 'running', awaitingConfirmation: true };
  }

  /**
   * Release a held execution fence with POSITIVE stop evidence, supplied by a
   * user who verified the host, or by the host adapter itself. There is no
   * "force" shortcut: lease expiry, status changes and pauseDispatch never
   * release a fence.
   *
   * Accepted evidence:
   *  - `hostStopped: true`            the host states this execution has stopped
   *  - `turnEnd: { sessionId, turnId, reason }`  a persistent terminal turn end
   *    for exactly this session and claimed turn
   */
  resolveExecutionFence(args = {}) {
    return this.#submit(() => this.#resolveExecutionFence(args));
  }

  async #resolveExecutionFence({ taskId, hostStopped, turnEnd, actor } = {}) {
    assertNonEmptyString(taskId, 'taskId');
    if (actor !== 'user' && actor !== 'host') {
      throw new AuthorizationError('releasing an execution fence requires an explicit user or host actor');
    }
    const current = this.#getTaskOrThrow(taskId);
    if (current.executionFence !== true) {
      throw new StateTransitionError(`task ${taskId} does not hold an execution fence`, { taskId, from: current.status, to: current.status });
    }
    const nowIso = this.#nowIso();
    let releasedBy;
    if (isPlainObject(turnEnd)) {
      assertNonEmptyString(turnEnd.sessionId, 'turnEnd.sessionId');
      assertNonEmptyString(turnEnd.turnId, 'turnEnd.turnId');
      assertNonEmptyString(turnEnd.reason, 'turnEnd.reason');
      const reason = turnEnd.reason.trim().toLowerCase();
      if (REJECTED_SETTLE_REASONS.includes(reason) || !ACCEPTED_TURN_END_REASONS.includes(reason)) {
        throw new InputValidationError(`'${reason}' is not a terminal turn reason`, ['turnEnd.reason']);
      }
      if (turnEnd.sessionId !== current.sessionId) {
        throw new InputValidationError('turnEnd.sessionId does not match the fenced task', ['turnEnd.sessionId']);
      }
      if (!isNonEmptyString(current.claimedTurnId) || turnEnd.turnId !== current.claimedTurnId) {
        throw new InputValidationError('turnEnd.turnId does not match the claimed turn of the fenced task', ['turnEnd.turnId']);
      }
      releasedBy = `fence_released_turn_${reason}`;
    } else if (hostStopped === true) {
      releasedBy = 'fence_released_host_stopped';
    } else {
      throw new InputValidationError(
        'releasing an execution fence requires positive evidence: turnEnd evidence or hostStopped: true',
        ['hostStopped'],
      );
    }
    await this.#mutate((draft) => {
      const task = findTask(draft, taskId);
      if (task === null || task.executionFence !== true) return;
      task.executionFence = false;
      task.fenceReason = null;
      task.fenceSince = null;
      task.resolution = releasedBy;
      task.updatedAt = nowIso;
      draft.updatedAt = nowIso;
    });
    return { taskId, released: true, releasedBy, status: this.getTask(taskId).status };
  }

  /**
   * Restart reconciliation. Leftover running tasks are inspected; without
   * positive evidence they become needs_attention. An expired lease NEVER
   * authorizes a restart and a new-session task never creates a second session.
   */
  recover(args = {}) {
    return this.#submit(() => this.#recover(args));
  }

  async #recover({ now } = {}) {
    if (this.#store.locked) {
      throw new StoreLockedError(`recovery refused: ${this.#store.lockReason ?? 'persistence failure'}`);
    }
    const nowMs = this.#nowMs(now);
    const nowIso = toIso(nowMs);
    this.#lastRecoverAt = nowIso;
    const snapshot = this.#store.getSnapshot();
    const decisions = [];
    for (const task of snapshot.tasks) {
      if (task.status === 'running') {
        decisions.push(await this.#reconcileRunning(task, nowMs, nowIso));
      } else if (task.executionFence === true) {
        // A non-running task that still holds a fence is re-checked on every
        // recovery: only new positive stop evidence may release it.
        decisions.push(await this.#reconcileFenced(task, nowMs, nowIso));
      } else if (task.leaseOwner !== null || task.leaseUntil !== null) {
        decisions.push({ taskId: task.id, from: task.status, to: task.status, reason: 'stale_lease_cleared', clearLease: true });
      } else if (task.status === 'waiting_quota' && task.nextCheckAt === null) {
        decisions.push({ taskId: task.id, from: task.status, to: task.status, reason: 'next_check_scheduled', nextCheckAt: toIso(nowMs + backoffDelayMs(task.attempts)) });
      }
    }
    if (decisions.length > 0) {
      await this.#mutate((draft) => {
        for (const decision of decisions) {
          const task = findTask(draft, decision.taskId);
          if (task === null) continue;
          if (decision.to !== decision.from) {
            task.status = decision.to;
            task.resolution = decision.reason;
            task.needsAttentionReason = decision.needsAttentionReason ?? (decision.to === 'needs_attention' ? decision.reason : null);
          } else if (decision.needsAttentionReason !== undefined) {
            // Same status, but a later reconcile attempt may have produced a
            // different (or more specific) reason: keep the report current.
            task.needsAttentionReason = decision.needsAttentionReason;
          }
          if (decision.clearLease === true) {
            task.leaseOwner = null;
            task.leaseUntil = null;
          }
          // The fence is released ONLY on a decision that carries positive stop
          // evidence. Unknown outcomes keep it, whatever the status becomes.
          if (decision.clearFence === true) {
            task.executionFence = false;
            task.fenceReason = null;
            task.fenceSince = null;
          }
          if (decision.clearFence === true || decision.to === 'completed' || decision.to === 'paused' || decision.to === 'waiting_quota' || decision.to === 'queued') {
            task.dispatchUncertain = false;
          }
          if (decision.nextCheckAt !== undefined) task.nextCheckAt = decision.nextCheckAt;
          if (decision.completedAt !== undefined) task.completedAt = decision.completedAt;
          if (decision.cancelledAt !== undefined) task.cancelledAt = decision.cancelledAt;
          task.updatedAt = nowIso;
        }
        draft.updatedAt = nowIso;
      });
    }
    return {
      at: nowIso,
      reconciled: decisions,
      needsAttention: decisions.filter((decision) => decision.to === 'needs_attention').map((decision) => decision.taskId),
    };
  }

  /**
   * Stop accepting new work, wait for accepted operations to reach a safe
   * point (no NEW external side effect after close), then drain the store.
   * An in-flight dispatch may be left as running + dispatchUncertain for the
   * next `recover()`.
   */
  async close() {
    if (this.#closed) {
      await this.#drain();
      return { closed: true, drained: true };
    }
    this.#closed = true;
    await this.#drain();
    await this.#store.close();
    return { closed: true, drained: true };
  }

  async #drain() {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
  }

  // -------------------------------------------------------------- internals ---

  /** Ask the optional reconcile port. A missing/again-throwing port yields null. */
  async #reconcileEvidence(task) {
    if (typeof this.#session.reconcile !== 'function') return null;
    const request = Object.freeze({
      taskId: task.id,
      sessionId: task.sessionId,
      messageId: task.dispatchedMessageId,
      claimedTurnId: task.claimedTurnId,
      policy: SESSION_POLICY,
    });
    try {
      const evidence = await this.#session.reconcile(request);
      return isPlainObject(evidence) ? evidence : null;
    } catch {
      return null;
    }
  }

  /**
   * Decide what reconcile evidence proves. `ok:true` always means positive
   * evidence that this exact execution reached a terminal state, and therefore
   * that the execution fence may be released.
   * @returns {{ok: true, status: string, reason: string, nextCheckAt?: string}
   *          |{ok: false, problem: string}}
   */
  #classifyReconcile(task, evidence, nowMs) {
    if (!isPlainObject(evidence)) return { ok: false, problem: 'unreconciled_after_restart' };
    const identityProblem = reconcileIdentityProblem(task, evidence);
    if (identityProblem !== null) return { ok: false, problem: identityProblem };
    if (evidence.outcome === 'completed') {
      if (evidence.turnEndReason !== 'completed'
        || !isNonEmptyString(task.claimedTurnId)
        || evidence.claimedTurnId !== task.claimedTurnId) {
        return { ok: false, problem: 'reconcile_turn_evidence_missing' };
      }
      return { ok: true, status: 'completed', reason: 'reconciled_completed' };
    }
    if (evidence.outcome === 'aborted') {
      return task.stopRequested
        ? { ok: true, status: 'paused', reason: 'stopped_by_user' }
        : { ok: true, status: 'needs_attention', reason: 'turn_aborted' };
    }
    if (evidence.outcome === 'failed') {
      return task.pendingQuotaWait
        ? { ok: true, status: 'waiting_quota', reason: 'quota_failure', nextCheckAt: toIso(nowMs + backoffDelayMs(task.attempts)) }
        : { ok: true, status: 'needs_attention', reason: 'turn_error' };
    }
    if (evidence.outcome === 'not-dispatched') {
      // "Nothing was delivered" must be positively asserted by the host.
      if (evidence.hostStopped !== true) return { ok: false, problem: 'host_stop_state_unknown' };
      if (task.kind === 'new-session') {
        // Idempotent CREATE says nothing about message delivery. Re-sending is
        // only safe when the session provably does not exist yet AND the host
        // guarantees both create-adoption and delivery idempotency.
        if (evidence.sessionCreated !== false) return { ok: false, problem: 'session_may_exist_unverified' };
        if (this.#capabilities.sessionIdempotentCreate !== true || this.#capabilities.messageIdempotentDelivery !== true) {
          return { ok: false, problem: 'requeue_not_idempotent' };
        }
        return { ok: true, status: 'queued', reason: 'reconciled_not_dispatched' };
      }
      if (this.#capabilities.messageIdempotentDelivery !== true) {
        return { ok: false, problem: 'message_delivery_not_idempotent' };
      }
      return { ok: true, status: 'queued', reason: 'reconciled_not_dispatched' };
    }
    // Unknown outcome, but the host positively states the execution stopped.
    if (evidence.hostStopped === true) {
      return { ok: true, status: 'needs_attention', reason: 'host_stopped_outcome_unknown' };
    }
    return { ok: false, problem: 'unreconciled_after_restart' };
  }

  async #reconcileRunning(task, nowMs, nowIso) {
    const base = { taskId: task.id, from: 'running', clearLease: true };
    const classified = this.#classifyReconcile(task, await this.#reconcileEvidence(task), nowMs);
    if (classified.ok) {
      return {
        ...base,
        to: classified.status,
        reason: classified.reason,
        clearFence: true,
        ...(classified.nextCheckAt === undefined ? {} : { nextCheckAt: classified.nextCheckAt }),
        ...(classified.status === 'completed' ? { completedAt: nowIso } : {}),
      };
    }
    const problem = task.dispatchUncertain === true ? 'dispatch_outcome_unknown' : classified.problem;
    return {
      ...base,
      to: 'needs_attention',
      reason: problem,
      needsAttentionReason: problem === 'unreconciled_after_restart' && task.kind === 'new-session'
        ? 'unreconciled_new_session_after_restart'
        : problem,
      clearFence: false,
    };
  }

  /** Re-check a non-running task that still holds a fence. */
  async #reconcileFenced(task, nowMs, nowIso) {
    const base = { taskId: task.id, from: task.status, clearLease: task.leaseOwner !== null || task.leaseUntil !== null };
    const classified = this.#classifyReconcile(task, await this.#reconcileEvidence(task), nowMs);
    if (classified.ok) {
      return {
        ...base,
        to: classified.status,
        reason: classified.reason,
        clearFence: true,
        ...(classified.nextCheckAt === undefined ? {} : { nextCheckAt: classified.nextCheckAt }),
        ...(classified.status === 'completed' ? { completedAt: nowIso } : {}),
      };
    }
    const problem = classified.problem === 'unreconciled_after_restart' && task.kind === 'new-session'
      ? 'unreconciled_new_session_after_restart'
      : classified.problem;
    return {
      ...base,
      to: task.status,
      reason: problem,
      // Keep the operator-facing reason current on every re-check.
      needsAttentionReason: task.status === 'needs_attention' ? problem : undefined,
      clearFence: false,
    };
  }

  /**
   * Gate ordering matters: permanent conditions first, then the reset/backoff
   * schedule, then freshness, and only then a release decision.
   */
  #gate(task, snapshot, nowMs) {
    if (task.autoResume !== true) return { decision: 'pause', nextCheckAt: null, reason: 'auto_resume_disabled' };
    if (task.kind === 'resume-session' && snapshot.sessionOptIns[task.sessionId] !== true) {
      return { decision: 'pause', nextCheckAt: null, reason: 'session_opt_in_revoked' };
    }
    const quota = snapshot.quotaScopes[task.quotaScopeKey] ?? null;
    const nowIso = toIso(nowMs);
    if (quota === null) return { decision: 'check', nextCheckAt: nowIso, reason: 'no_snapshot' };
    if (quota.state === 'auth_required') return { decision: 'attention', nextCheckAt: null, reason: 'quota_auth_required' };
    if (task.attempts >= this.#config.maxAttempts) {
      return { decision: 'attention', nextCheckAt: null, reason: 'quota_recheck_budget_exhausted' };
    }
    const createdMs = toEpochMs(task.createdAt);
    if (createdMs !== undefined && nowMs - createdMs > this.#config.maxWaitMs) {
      return { decision: 'attention', nextCheckAt: null, reason: 'quota_wait_limit_exceeded' };
    }
    const dueAt = toEpochMs(task.nextCheckAt);
    const resetMs = toEpochMs(quota.resetAt);
    const waitUntil = resetMs === undefined ? undefined : resetMs + this.#config.resetBufferMs;
    if (waitUntil !== undefined && nowMs < waitUntil) {
      return { decision: 'wait', nextCheckAt: toIso(dueAt === undefined ? waitUntil : Math.max(waitUntil, dueAt)), reason: 'awaiting_reset' };
    }
    if (dueAt !== undefined && nowMs < dueAt) {
      return { decision: 'wait', nextCheckAt: toIso(dueAt), reason: 'backoff' };
    }
    const observedMs = toEpochMs(quota.observedAt);
    const future = observedMs !== undefined && observedMs > nowMs + this.#config.clockSkewToleranceMs;
    const stale = observedMs === undefined || nowMs - observedMs > this.#config.snapshotTtlMs;
    const validUntilMs = toEpochMs(quota.validUntil);
    const expired = validUntilMs !== undefined && validUntilMs < nowMs;
    if (future || stale || expired) {
      return { decision: 'check', nextCheckAt: nowIso, reason: future ? 'snapshot_from_future' : (expired ? 'snapshot_expired' : 'stale_snapshot') };
    }
    if (quota.state === 'available') {
      if (quota.releaseRecommended === true) return { decision: 'release', nextCheckAt: null, reason: 'explicit_allow' };
      return { decision: 'check', nextCheckAt: nowIso, reason: 'allow_not_recommended' };
    }
    return { decision: 'check', nextCheckAt: nowIso, reason: `quota_${quota.state}` };
  }

  async #dispatch(task, nowMs) {
    const nowIso = toIso(nowMs);
    const ownerId = this.#owner();
    const proposedMessageId = task.dispatchedMessageId ?? this.#nextId('message');

    // Atomic claim: everyone in the queue (workspace, session AND global count)
    // is checked inside the same transaction, so concurrent ticks cannot
    // double-start anything.
    let claimed = null;
    await this.#mutate((draft) => {
      const current = findTask(draft, task.id);
      if (current === null || !DISPATCHABLE_STATUSES.includes(current.status)) return;
      if (current.attempts !== task.attempts) return;
      // Defence in depth: a task that still holds an execution fence must never
      // be claimed again, whatever put it back into a dispatchable status.
      if (current.executionFence === true) return;
      if (claimBlockedBy(draft.tasks, current, this.#config.maxConcurrent) !== null) return;
      current.status = 'running';
      current.dispatchedMessageId = current.dispatchedMessageId ?? proposedMessageId;
      current.dispatchedAt = nowIso;
      current.attempts += 1;
      current.leaseOwner = ownerId;
      current.leaseUntil = toIso(nowMs + this.#config.leaseMs);
      current.pendingQuotaWait = false;
      current.dispatchUncertain = false;
      current.executionFence = true;
      current.fenceReason = 'executing';
      current.fenceSince = nowIso;
      current.needsAttentionReason = null;
      current.updatedAt = nowIso;
      draft.updatedAt = nowIso;
      claimed = deepCopy(current);
    });
    if (claimed === null) return { taskId: task.id, dispatched: false, reason: 'precondition_changed' };
    const messageId = claimed.dispatchedMessageId;

    // Everything below uses the CLAIMED record, never the stale candidate.
    if (claimed.kind === 'resume-session') {
      const facts = await this.#inspectSession(claimed.sessionId);
      const problem = this.#verifySessionFacts(claimed, facts);
      if (problem !== null) {
        await this.#setAttention(claimed.id, problem, nowIso);
        return { taskId: claimed.id, dispatched: false, reason: problem };
      }
      if (this.#closed) return this.#abandonDispatch(claimed.id, nowIso, 'closed_before_effect');
    } else if (this.#closed) {
      return this.#abandonDispatch(claimed.id, nowIso, 'closed_before_effect');
    }

    try {
      if (claimed.kind === 'new-session') {
        const prepared = await this.#session.prepareNew(Object.freeze({
          taskId: claimed.id,
          sessionId: claimed.sessionId,
          workspaceId: claimed.workspaceId,
          cwd: claimed.workspacePathSnapshot,
          provider: claimed.provider,
          model: claimed.model,
          policy: SESSION_POLICY,
        }));
        const preparedProblem = this.#verifyPrepared(claimed, prepared);
        if (preparedProblem !== null) {
          // The session may or may not exist now: keep the slot and reconcile.
          return await this.#abandonDispatch(claimed.id, nowIso, preparedProblem);
        }
        if (isNonEmptyString(prepared.revision)) {
          await this.#mutate((draft) => {
            const current = findTask(draft, claimed.id);
            if (current !== null) current.sessionRevision = prepared.revision;
          });
        }
        if (this.#closed) return await this.#abandonDispatch(claimed.id, nowIso, 'closed_before_effect');
        await this.#session.startNew(Object.freeze({
          taskId: claimed.id,
          sessionId: claimed.sessionId,
          messageId,
          prompt: claimed.prompt,
          workspaceId: claimed.workspaceId,
          cwd: claimed.workspacePathSnapshot,
          provider: claimed.provider,
          model: claimed.model,
          policy: SESSION_POLICY,
        }));
      } else {
        await this.#session.continueOriginal(Object.freeze({
          taskId: claimed.id,
          sessionId: claimed.sessionId,
          messageId,
          workspaceId: claimed.workspaceId,
          cwd: claimed.workspacePathSnapshot,
          provider: claimed.provider,
          model: claimed.model,
          sessionRevision: claimed.sessionRevision,
          policy: SESSION_POLICY,
        }));
      }
    } catch (error) {
      // The external call may have been accepted: never release the slot on an
      // unknown outcome, and never start another task in its place.
      return await this.#abandonDispatch(claimed.id, nowIso, error?.code ?? 'dispatch_failed');
    }
    // A delivery receipt is not completion: the task stays running until a
    // claimed turn ends.
    return { taskId: claimed.id, dispatched: true, messageId, sessionId: claimed.sessionId, kind: claimed.kind };
  }

  #verifyPrepared(task, prepared) {
    if (!isPlainObject(prepared)) return 'prepare_new_contract_violation';
    if (prepared.sessionId !== task.sessionId) return 'prepare_new_session_mismatch';
    if (!isNonEmptyString(prepared.workspaceId) || prepared.workspaceId !== task.workspaceId) return 'prepare_new_workspace_mismatch';
    if (!isNonEmptyString(prepared.cwd)) return 'prepare_new_cwd_missing';
    if (isNonEmptyString(task.workspacePathSnapshot) && prepared.cwd !== task.workspacePathSnapshot) return 'prepare_new_cwd_mismatch';
    if (!isNonEmptyString(prepared.revision)) return 'prepare_new_revision_missing';
    return null;
  }

  #verifySessionFacts(task, facts) {
    if (!isPlainObject(facts)) return 'session_facts_unavailable';
    for (const [key, type] of REQUIRED_SESSION_FACTS) {
      const value = facts[key];
      const ok = type === 'string' ? isNonEmptyString(value) : typeof value === 'boolean';
      if (!ok) return `session_facts_incomplete:${key}`;
    }
    if (facts.sessionId !== task.sessionId) return 'session_identity_changed';
    if (facts.running !== false) return 'session_already_running';
    if (facts.goalOwned !== false || facts.alwaysRetry !== false) return 'ownership_conflict';
    if (facts.workspaceId !== task.workspaceId) return 'workspace_binding_changed';
    if (!isNonEmptyString(task.workspacePathSnapshot)) return 'workspace_path_unknown';
    if (facts.cwd !== task.workspacePathSnapshot) return 'workspace_path_changed';
    if (facts.provider !== task.provider || facts.model !== task.model) return 'route_changed';
    if (!isNonEmptyString(task.sessionRevision)) return 'session_revision_unknown';
    if (facts.revision !== task.sessionRevision) return 'session_revision_changed';
    return null;
  }

  /** Keep the execution slot; the outcome must be reconciled, not assumed. */
  async #abandonDispatch(taskId, nowIso, reason) {
    await this.#mutate((draft) => {
      const task = findTask(draft, taskId);
      if (task === null) return;
      task.dispatchUncertain = true;
      // The external outcome is unknown: the fence stays held until the host
      // proves the execution stopped.
      task.executionFence = true;
      task.fenceReason = `dispatch_outcome_unknown:${reason}`;
      task.needsAttentionReason = `dispatch_outcome_unknown:${reason}`;
      task.updatedAt = nowIso;
      draft.updatedAt = nowIso;
    });
    return { taskId, dispatched: false, reason, outcomeUnknown: true, executionSlotRetained: true };
  }

  async #inspectSession(sessionId) {
    try {
      const facts = await this.#session.inspect(sessionId);
      return isPlainObject(facts) ? facts : null;
    } catch {
      return null;
    }
  }

  async #setAttention(taskId, reason, nowIso) {
    await this.#mutate((draft) => {
      const task = findTask(draft, taskId);
      if (task === null) return;
      task.status = 'needs_attention';
      task.needsAttentionReason = reason;
      task.leaseOwner = null;
      task.leaseUntil = null;
      task.dispatchUncertain = false;
      // Reached only before any external effect was attempted.
      task.executionFence = false;
      task.fenceReason = null;
      task.fenceSince = null;
      task.updatedAt = nowIso;
      draft.updatedAt = nowIso;
    });
  }

  async #recordQuota(scopeKey, snapshot) {
    const issues = validateQuotaSnapshot(snapshot);
    if (issues.length > 0) throw new PortContractError('refusing to store an invalid quota snapshot', issues);
    await this.#mutate((draft) => {
      draft.quotaScopes[scopeKey] = snapshot;
      draft.updatedAt = snapshot.observedAt;
    });
    return snapshot;
  }

  #view(task, quota, snapshot) {
    return {
      id: task.id,
      kind: task.kind,
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      workspacePathSnapshot: task.workspacePathSnapshot,
      provider: task.provider,
      model: task.model,
      credentialRef: task.credentialRef,
      quotaScopeKey: task.quotaScopeKey,
      status: task.status,
      priority: task.priority,
      attempts: task.attempts,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      nextCheckAt: task.nextCheckAt,
      sessionId: task.sessionId,
      failedStepId: task.failedStepId,
      generation: task.generation,
      dispatchedMessageId: task.dispatchedMessageId,
      claimedTurnId: task.claimedTurnId,
      sessionRevision: task.sessionRevision,
      stopRequested: task.stopRequested,
      pendingQuotaWait: task.pendingQuotaWait,
      dispatchUncertain: task.dispatchUncertain,
      executionFence: task.executionFence,
      fenceReason: task.fenceReason,
      fenceSince: task.fenceSince,
      needsAttentionReason: task.needsAttentionReason,
      resolution: task.resolution,
      lastFailure: task.lastFailure,
      autoResume: task.autoResume,
      sessionOptIn: task.kind === 'resume-session' ? snapshot.sessionOptIns[task.sessionId] === true : null,
      lease: { owner: task.leaseOwner, until: task.leaseUntil },
      quota: quota === null ? null : {
        state: quota.state,
        source: quota.source,
        observedAt: quota.observedAt,
        resetAt: quota.resetAt,
        resetConfidence: quota.resetConfidence,
        releaseRecommended: quota.releaseRecommended,
        saturated: quota.saturated,
        blockingWindows: quota.blockingWindows.length,
      },
      waitReason: this.#waitReason(task, quota),
    };
  }

  #waitReason(task, quota) {
    switch (task.status) {
      case 'draft': return 'draft_awaiting_user_authorization';
      case 'queued':
      case 'ready': return 'awaiting_dispatch';
      case 'waiting_quota': return quota === null ? 'awaiting_quota_check' : `quota_${quota.state}`;
      case 'running': return task.dispatchUncertain === true ? 'dispatch_outcome_unknown' : 'running';
      case 'paused': return task.executionFence === true ? `execution_fence_held:${task.fenceReason}` : (task.resolution ?? 'paused');
      case 'needs_attention': return task.executionFence === true
        ? `execution_fence_held:${task.fenceReason}`
        : (task.needsAttentionReason ?? 'needs_attention');
      default: return null;
    }
  }

  #missingCapabilities() {
    return REQUIRED_CAPABILITIES.filter((key) => this.#capabilities[key] !== true);
  }

  #owner() {
    this.#ownerId ??= this.#nextId('owner');
    return this.#ownerId;
  }

  #nextId(kind) {
    const value = this.#ids.next(kind);
    if (!isNonEmptyString(value)) throw new PortContractError(`ids.next('${kind}') must return a non-empty string`, ['ids.next']);
    return value;
  }

  #nowMs(now) {
    if (now === undefined) {
      const fromClock = this.#clock.now();
      if (!Number.isFinite(fromClock)) throw new PortContractError('clock.now() must return epoch milliseconds', ['clock.now']);
      return resolveNow(fromClock);
    }
    return resolveNow(now);
  }

  #nowIso(now) {
    return toIso(this.#nowMs(now));
  }

  #getTaskOrThrow(taskId) {
    const snapshot = this.#store.getSnapshot();
    const task = findTask(snapshot, taskId);
    if (task === null) throw new NotFoundError(`unknown task: ${taskId}`);
    return task;
  }

  async #mutate(mutator) {
    // No closed-check here on purpose: an operation that was ACCEPTED before
    // close() must be allowed to record its outcome (the store drains accepted
    // writes). Every public entry point rejects NEW work once closed.
    return this.#store.update(mutator);
  }

  /**
   * Register an operation for close()-time draining.
   *
   * This is TRACKING ONLY: it never chains onto, or awaits, another operation.
   * Nested calls such as `#tick` -> `checkQuota` are therefore plain
   * composition, not a queue, and cannot deadlock waiting on themselves.
   */
  #submit(job) {
    if (this.#closed) {
      return Promise.reject(new ClosedError('service is closed; scheduling is disabled'));
    }
    let promise;
    try {
      promise = Promise.resolve(job());
    } catch (error) {
      return Promise.reject(error);
    }
    this.#operations.add(promise);
    const cleanup = () => this.#operations.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }
}

/**
 * Reconcile evidence is only usable when it names the exact execution it is
 * about. A mismatching or missing sessionId/messageId can never settle a task.
 * @returns {string|null} problem code, or null when the evidence matches
 */
export function reconcileIdentityProblem(task, evidence) {
  if (evidence.sessionId !== task.sessionId) return 'reconcile_session_mismatch';
  if (!isNonEmptyString(task.dispatchedMessageId)) return 'reconcile_message_unbound';
  if (evidence.messageId !== task.dispatchedMessageId) return 'reconcile_message_mismatch';
  return null;
}

function compareTasks(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const aCreated = toEpochMs(a.createdAt) ?? 0;
  const bCreated = toEpochMs(b.createdAt) ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

function failedQuerySnapshot(scopeKey, observedAt, reason) {
  return {
    scopeKey,
    state: 'unknown',
    source: 'proxy-query',
    observedAt,
    validUntil: null,
    modelMappingVerified: false,
    remaining: null,
    unit: null,
    resetAt: null,
    resetConfidence: null,
    nextResetAt: null,
    blockingWindows: [],
    observedWindows: [],
    saturated: false,
    credits: null,
    errorClass: 'unknown',
    releaseRecommended: false,
    reasons: [`query_failed:${reason}`],
  };
}

/** Exported for tests and documentation; the scheduler uses the same ladder. */
export const RECOVERY_BACKOFF_MS = BACKOFF_MS;
