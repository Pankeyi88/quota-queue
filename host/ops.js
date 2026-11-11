/**
 * Existing-task management over two isolated persistence units:
 *  - `quota_queue_v1` is legacy read-only history (reservations are retired);
 *  - `quota_recovery_plan_v1` is the editable ordering plan.
 *
 * All operations run on one in-process chain, and a plan write publishes only
 * after the plan store confirmed a durable save. Nothing here executes a task:
 * execution/quota/auto-resume capabilities stay false, and every plan item is
 * persisted with `authorization.enabled === false` and an unbound
 * `quotaScopeId` (null) unless a future Host adapter binds a verified scope.
 */
import { createHash } from 'node:crypto';
import { validateQuotaSnapshot } from '../core/quota.mjs';
import { applyRecoveryPlan } from '../core/recovery-plan.mjs';
import { buildView, routeView, taskView, workspaceView } from './views.js';
import { CAPABILITIES, CAPABILITY_REASONS } from './constants.js';
import { HostError } from './errors.js';
import { WORKSPACE_REGISTRY_REASON } from './ports.js';

const PLAN_UNAVAILABLE = 'recovery_plan_unavailable';
const PLAN_PERSISTENCE_FAILED = 'recovery_plan_persistence_failed';

/** Compare workspace paths conservatively for the current platform. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const norm = (value) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(left) === norm(right);
}

function stablePlanId(sessionId, generation) {
  return `plan-${createHash('sha256').update(JSON.stringify([sessionId, generation])).digest('hex').slice(0, 32)}`;
}

const TERMINAL_PLAN_STATUSES = new Set(['succeeded', 'failed', 'stopped']);

/**
 * Fixed, ordered reasons why a plan item would not start right now. This is a
 * read-only diagnostic: none of these conditions is bypassable from the Client.
 * @param {object} plan validated plan snapshot
 * @param {object} item plan item
 * @param {number} batchIndex its current batch
 * @returns {string[]}
 */
export function planBlockers(plan, item, batchIndex, runningSessions = null) {
  if (item.fence !== null) return ['execution_outcome_unknown'];
  if (item.removed) return ['removed'];
  if (item.skip !== null) return ['skipped'];
  if (TERMINAL_PLAN_STATUSES.has(item.status)) return [];
  const blockers = [];
  // A task the user (or another driver) resumed after planning is no longer an
  // idle-ready scope. Positive running evidence only; unknown stays unknown.
  if (runningSessions !== null && runningSessions.has(item.ref.sessionId)) blockers.push('task_running');
  if (plan.paused) blockers.push('plan_paused');
  if (item.paused) blockers.push('item_paused');
  if (item.authorization.enabled !== true) blockers.push('authorization_disabled');
  if (item.ref.quotaScopeId === null) blockers.push('quota_scope_unbound');
  if (CAPABILITIES.execution !== true) blockers.push('execution_capability_missing');
  const byId = new Map(plan.items.map((entry) => [entry.id, entry]));
  const blockedByEarlier = plan.batches.slice(0, batchIndex).some((batch) => batch.some((id) => {
    const previous = byId.get(id);
    if (previous === undefined) return true;
    if (previous.fence !== null) return true;
    return previous.status !== 'succeeded' && previous.skip === null;
  }));
  if (blockedByEarlier) blockers.push('earlier_batch_incomplete');
  return blockers;
}

/** Map a core/store failure onto a fixed Host code without echoing text. */
function planFailure(error, fallback = 'internal') {
  const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const message = error !== null && typeof error === 'object' ? Reflect.get(error, 'message') : undefined;
  if (code === 'REVISION_CONFLICT') return new HostError('revision_conflict');
  if (message === 'recovery_plan_save_failed' || message === 'recovery_plan_locked') {
    return new HostError('persistence_failed');
  }
  if (message === 'recovery_plan_not_open') return new HostError('configuration_incomplete');
  if (message === 'recovery_plan_closed') return new HostError('unavailable');
  if (message === 'recovery_plan_invalid_intent' || code === 'INVALID_INPUT' || code === 'SNAPSHOT_INVALID') {
    return new HostError('invalid_request');
  }
  if (code === 'INVALID_TRANSITION') return new HostError('invalid_request');
  return new HostError(fallback);
}

export class QueueOperations {
  #store;
  #planStore;
  #ports;
  #routes;
  #now;
  #chain = Promise.resolve();
  #closed = false;
  #lastQuota = null;
  #autoResume = false;
  #autoContinue = () => false;

  constructor(input) {
    if (input === null || typeof input !== 'object') throw new TypeError('QueueOperations expects an input object');
    const { store, ports } = input;
    if (!store || typeof store.getSnapshot !== 'function' || typeof store.update !== 'function'
      || typeof store.close !== 'function') throw new TypeError('QueueOperations requires an opened core QueueStore');
    if (!ports || typeof ports.listWorkspaces !== 'function') throw new TypeError('QueueOperations requires the host port face');
    const planStore = input.planStore === undefined ? null : input.planStore;
    if (planStore !== null && (typeof planStore.commit !== 'function' || typeof planStore.getSnapshot !== 'function')) {
      throw new TypeError('QueueOperations planStore must be a RecoveryPlanStore or null');
    }
    this.#store = store;
    this.#planStore = planStore;
    this.#ports = ports;
    this.#routes = input.routes instanceof Map ? input.routes : new Map();
    this.#autoResume = input.autoResume === true;
    // The continuation consumer may be mounted after this object exists, so it
    // is resolved per operation instead of being latched at construction.
    this.#autoContinue = typeof input.autoContinue === 'function'
      ? () => input.autoContinue() === true
      : () => input.autoContinue === true;
    this.#now = typeof input.now === 'function' ? input.now : () => new Date();
  }

  get routes() { return this.#routes; }
  close() { this.#closed = true; }
  async drain() { await this.#chain; }

  async run(op, payload, requestId) {
    if (this.#closed) throw new HostError('unavailable');
    // Accepted operations drain during disposal; no new ones can join.
    const result = this.#chain.then(async () => {
      switch (op) {
        case 'bootstrap': return this.#view();
        // Kept in the wire vocabulary so old Clients receive a safe explicit
        // refusal instead of accidentally creating new tasks after upgrading.
        case 'addManual':
        case 'editPending': throw new HostError('capability_missing', { reason: 'new_task_reservation_retired' });
        case 'cancelQueued': throw new HostError('not_cancellable', { reason: 'legacy_history_read_only' });
        case 'pauseDispatch': return this.#pauseDispatch(payload);
        case 'setSessionOptIn': return this.#setSessionOptIn(payload);
        case 'planAuthorize': return this.#planAuthorize(payload);
        case 'checkQuota': return this.#checkQuota();
        case 'requestStop': return this.#requestStop(payload);
        case 'planAdd': return this.#planAdd(payload);
        case 'planConfigure': {
          // Absolute target state: an identical retry is a no-op even when it
          // carries an older expectedRevision, mirroring the legacy queue.
          if (this.#requirePlanEditable().getSnapshot().maxConcurrent === payload.maxConcurrent) return this.#view();
          return this.#planCommit(payload.expectedRevision, { type: 'configure', maxConcurrent: payload.maxConcurrent });
        }
        case 'planPause': {
          if (this.#requirePlanEditable().getSnapshot().paused === payload.paused) return this.#view();
          return this.#planCommit(payload.expectedRevision, { type: 'pausePlan', paused: payload.paused });
        }
        case 'planItemPause': {
          const item = this.#planItem(payload.id);
          if (item.paused === payload.paused) return this.#view();
          return this.#planCommit(payload.expectedRevision, { type: 'pause', id: payload.id, paused: payload.paused });
        }
        case 'planRemove': {
          if (this.#planItem(payload.id).removed === true) return this.#view();
          return this.#planRemove(payload);
        }
        case 'planSkip': {
          if (this.#planItem(payload.id).skip !== null) return this.#view();
          return this.#planCommit(payload.expectedRevision, {
            type: 'skip', id: payload.id, confirmed: payload.confirmed,
          });
        }
        case 'planMove': return this.#planMove(payload);
        default: throw new HostError('unknown_op', { op });
      }
    });
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }

  #nowIso() { return this.#now().toISOString(); }
  #snapshot() {
    if (this.#store.opened !== true) throw new HostError('persistence_failed');
    return this.#store.getSnapshot();
  }

  async #view() {
    const snapshot = this.#snapshot();
    const reasons = [];
    if (this.#store.locked === true) reasons.push('persistence_locked');
    if (this.#ports.workspaceRegistryAvailable !== true) reasons.push(WORKSPACE_REGISTRY_REASON);
    if (this.#routes.size === 0) reasons.push('no_fixed_route_configured');
    const workspaces = (await this.#ports.listWorkspaces()).map(workspaceView);
    const routes = [...this.#routes.values()].map(routeView);
    const tasks = snapshot.tasks.map((task) => taskView(task, this.#routes, { dispatchPaused: snapshot.dispatchPaused }));
    const existingTasks = typeof this.#ports.listExistingTasks === 'function'
      ? await this.#ports.listExistingTasks()
      : { available: false, reason: 'session_registry_unavailable', items: [] };
    const quotaConfigured = this.#ports.quotaConfigured === true;
    if (quotaConfigured !== true && this.#ports.quotaSourceConfigured === true) {
      reasons.push(this.#ports.managementKeyPresent === true ? 'quota_source_invalid' : 'management_key_missing');
    }
    const autoResume = this.#autoResume === true && quotaConfigured;
    const capabilities = { quotaCheck: quotaConfigured, execution: false, autoResume };
    // A verified read-only quota source clears its own reason; a mounted HOT
    // adapter clears the single-session auto-resume reason. Execution/batch
    // ownership and route reasons still keep full readiness false.
    const capabilityReasons = CAPABILITY_REASONS.filter((reason) => {
      if (reason === 'quota_query_auth_contract_unverified') return quotaConfigured !== true;
      if (reason === 'auto_resume_ownership_unverified') return autoResume !== true;
      return true;
    });
    const workspacePaths = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
    const titles = new Map(existingTasks.items.map((item) => [item.sessionId, item.title]));
    // Positive live-running evidence for plan rows (best effort, read-only).
    const runningSessions = new Set();
    if (this.#planStore !== null && this.#planStore.opened === true
      && typeof this.#ports.isSessionRunning === 'function') {
      for (const item of this.#planStore.getSnapshot().items) {
        if (item.removed || item.skip !== null) continue;
        let running = null;
        try { running = this.#ports.isSessionRunning(item.ref.sessionId); } catch { running = null; }
        if (running === true) runningSessions.add(item.ref.sessionId);
      }
    }
    return {
      ...buildView({
        snapshot, tasks, workspaces, routes, reasons, capabilities, capabilityReasons,
        autoContinue: this.#ports.autoContinueView ?? null,
      }),
      // The one fixed account scope this deployment's verified quota source
      // observes, or null. Shown so an unbound item explains WHY it cannot be
      // authorized, instead of failing silently.
      quotaScopeId: this.#fixedQuotaScope(),
      existingTasks,
      recoveryPlan: this.#planView(workspacePaths, titles, runningSessions),
      quota: this.#quotaView(quotaConfigured),
    };
  }

  /** Project the plan without leaking generation, task identity or authority. */
  #planView(workspacePaths, titles, runningSessions) {
    const planStore = this.#planStore;
    if (planStore === null || planStore.opened !== true) {
      return {
        available: false, editable: false, reason: PLAN_UNAVAILABLE,
        revision: 0, maxConcurrent: 1, paused: true, batches: [], items: [],
      };
    }
    const plan = planStore.getSnapshot();
    const batchById = new Map();
    plan.batches.forEach((batch, index) => { for (const id of batch) batchById.set(id, index); });
    return {
      available: true,
      editable: planStore.locked !== true && planStore.closed !== true,
      reason: planStore.locked === true ? PLAN_PERSISTENCE_FAILED : null,
      revision: plan.revision,
      maxConcurrent: plan.maxConcurrent,
      paused: plan.paused,
      batches: plan.batches.map((batch) => [...batch]),
      items: plan.items.map((item) => {
        const held = item.fence !== null;
        const batchIndex = batchById.get(item.id) ?? 0;
        let reason = 'execution_capability_missing';
        if (item.removed) reason = 'removed';
        else if (item.skip !== null) reason = 'skipped';
        else if (held && item.status === 'needs_attention') reason = 'execution_outcome_unknown';
        else if (item.paused) reason = 'task_paused';
        else if (plan.paused) reason = 'plan_paused';
        return {
          blockers: planBlockers(plan, item, batchIndex, runningSessions),
          id: item.id,
          sessionId: item.ref.sessionId,
          title: titles.get(item.ref.sessionId) ?? item.ref.sessionId,
          workspacePath: workspacePaths.get(item.ref.workspaceId) ?? null,
          batchIndex,
          status: item.status,
          paused: item.paused,
          removed: item.removed,
          skipped: item.skip !== null,
          // Reported exactly as persisted: the Client applies the same gate as
          // the switch, and an unbound scope can never be authorized, so this
          // flag cannot widen permission on its own.
          authorizationEnabled: item.authorization.enabled === true,
          quotaScopeBound: item.ref.quotaScopeId !== null,
          executionHeld: held,
          attempts: item.attempts,
          reason,
        };
      }),
    };
  }

  /** One plan item from the published plan, or a fixed invalid_request. */
  #planItem(id) {
    const plan = this.#requirePlanEditable().getSnapshot();
    const item = plan.items.find((entry) => entry.id === id);
    if (item === undefined) throw new HostError('invalid_request', { field: 'id' });
    return item;
  }

  /** Projected last quota check; never contains the management key. */
  #quotaView(configured) {
    const quota = this.#lastQuota;
    if (configured !== true || quota === null) {
      return {
        configured: configured === true, state: null, remaining: null,
        weeklyRemaining: null, fiveHourRemaining: null,
        resetAt: null, observedAt: null, reasons: [],
      };
    }
    const windows = Array.isArray(quota.observedWindows) ? quota.observedWindows : [];
    const weekly = windows.find((window) => window.id === 'weekly');
    const fiveHour = windows.find((window) => window.id === 'five-hour');
    const remainingOf = (window) => (window !== undefined && typeof window.usedPercent === 'number'
      ? Math.max(0, Math.min(100, 100 - window.usedPercent))
      : null);
    return {
      configured: true,
      state: typeof quota.state === 'string' ? quota.state : null,
      remaining: typeof quota.remaining === 'number' ? quota.remaining : null,
      weeklyRemaining: remainingOf(weekly),
      fiveHourRemaining: remainingOf(fiveHour),
      resetAt: typeof quota.resetAt === 'string' ? quota.resetAt : null,
      observedAt: typeof quota.observedAt === 'string' ? quota.observedAt : null,
      reasons: Array.isArray(quota.reasons) ? quota.reasons.slice(0, 6) : [],
    };
  }

  #requirePlanEditable() {
    const planStore = this.#planStore;
    if (planStore === null || planStore.opened !== true) throw new HostError('configuration_incomplete', { missing: 'recovery plan storage' });
    if (planStore.locked === true) throw new HostError('persistence_failed');
    if (planStore.closed === true) throw new HostError('unavailable');
    return planStore;
  }

  async #planCommit(expectedRevision, command) {
    const planStore = this.#requirePlanEditable();
    // A persisted plan item may predate the deployment's verified account scope.
    // Every accepting commit first writes the SAME plan back with that one fixed
    // scope bound, so an existing entry stops reporting `quota_scope_unbound`
    // for a scope the Host actually holds. It is a Host fact from configuration,
    // never a request value, and it grants nothing: an authorization with no
    // scope stays false.
    //
    // The normalization never publishes anything for a REFUSED command: the
    // plan is rebuilt here and the caller's command applied to that candidate
    // FIRST, so an invalid or stale request fails before any write. Each write
    // is then addressed by the revision it starts from, which keeps every
    // intermediate save valid.
    const snapshot = planStore.getSnapshot();
    const candidates = this.#fixedScopeCommands(planStore, snapshot);
    // Validate the caller's command against the fully normalized candidate.
    let revision = snapshot.revision;
    let next = structuredClone(snapshot);
    for (const rebind of candidates) {
      next = applyRecoveryPlan(next, revision, rebind);
      revision += 1;
    }
    try {
      next = applyRecoveryPlan(next, revision, command);
    } catch (error) {
      throw planFailure(error);
    }
    // Nothing normalizing to do: one write, exactly as before.
    if (candidates.length === 0) {
      try {
        await planStore.commit(expectedRevision, command);
      } catch (error) {
        throw planFailure(error);
      }
      return this.#view();
    }
    // Write the normalization, then the caller's command, each addressed by the
    // revision it starts from. A lost race leaves the caller's request as a real
    // conflict instead of a silent half-apply.
    let at = snapshot.revision;
    try {
      for (const rebind of candidates) {
        await planStore.commit(at, rebind);
        at += 1;
      }
      await planStore.commit(at, command);
    } catch (error) {
      throw planFailure(error);
    }
    return this.#view();
  }

  /** The deployment's fixed account scope, or null when none is verified. */
  #fixedQuotaScope() {
    const scopeId = this.#ports.quotaScopeId;
    return typeof scopeId === 'string' && scopeId.length > 0 ? scopeId : null;
  }

  /**
   * Bind the deployment's fixed scope to every untried, unbound item, using the
   * plan store's own serialization. It is a durable Host fact with no authority
   * attached, so it is safe to persist before a command that may be refused.
   */
  async #normalizePlan() {
    const planStore = this.#planStore;
    if (planStore === null || planStore.opened !== true || planStore.locked === true) return;
    for (const rebind of this.#fixedScopeCommands(planStore, planStore.getSnapshot())) {
      try {
        await planStore.commit(planStore.getSnapshot().revision, rebind);
      } catch (error) {
        // A concurrent writer or a lost save leaves the item unbound; the
        // caller's own command still reports the honest state.
        return;
      }
    }
  }

  /** Normalization commands still needed to bind the fixed scope, in order. */
  #fixedScopeCommands(planStore, snapshot) {
    const scopeId = this.#fixedQuotaScope();
    if (scopeId === null || planStore.opened !== true || planStore.locked === true) return [];
    const commands = [];
    for (const item of snapshot.items) {
      if (item.ref.quotaScopeId !== null) continue;
      if (item.attempts !== 0 || item.fence !== null) continue;
      commands.push({ type: 'rebindScope', id: item.id, quotaScopeId: scopeId });
    }
    return commands;
  }

  async #planAdd(payload) {
    this.#requirePlanEditable();
    if (typeof this.#ports.identifyExistingTask !== 'function') {
      throw new HostError('capability_missing', { reason: 'task_identity_unavailable' });
    }
    // The inspected session must already be a VISIBLE existing-task candidate.
    // Without this, an authenticated caller could point the Host's read-only
    // inspector at any persisted session id, including ones the list filters
    // out. Selection is limited to what the Host itself presents.
    if (typeof this.#ports.listExistingTasks !== 'function') {
      throw new HostError('capability_missing', { reason: 'task_list_unavailable' });
    }
    const listed = await this.#ports.listExistingTasks();
    if (listed === null || typeof listed !== 'object' || listed.available !== true || !Array.isArray(listed.items)) {
      throw new HostError('capability_missing', { reason: 'task_list_unavailable' });
    }
    if (!listed.items.some((item) => item !== null && typeof item === 'object' && item.sessionId === payload.sessionId)) {
      throw new HostError('capability_missing', { reason: 'task_not_visible' });
    }
    // A demonstrably RUNNING task IS enqueueable: the user wants the session
    // ordered now, not after it happens to stop. Ordering it grants no
    // execution — this build never claims or runs a plan item — and the View
    // reports the live `task_running` blocker (and clears it once the run
    // ends) from the public agent registry. Nothing is inferred from a stale
    // list: `running` is only positive evidence, and its absence stays
    // unknown. Identity is still required, so an unreadable or unverified log
    // tail refuses exactly as before.
    const identity = await this.#ports.identifyExistingTask(payload.sessionId);
    if (identity === null || typeof identity !== 'object' || identity.verified !== true) {
      // Two different failures share this branch and must not be conflated:
      //  - the Host cannot read the Session log at all (contract/capability
      //    problem; the user cannot do anything about it);
      //  - the log was read but this task is not a recoverable scope (a
      //    task-selection problem).
      // Reporting the first as "task already completed" is what hid the DSH
      // 0.2.2 API removal behind a misleading message.
      if (identity !== null && typeof identity === 'object' && identity.capabilityUnavailable === true) {
        throw new HostError('capability_missing', {
          reason: typeof identity.reason === 'string' ? identity.reason : 'task_inspection_unavailable',
        });
      }
      throw new HostError('task_not_recoverable', {
        reason: typeof identity?.reason === 'string' ? identity.reason : 'task_identity_unverified',
      });
    }
    // A turn that already ended successfully is a finished task, not a
    // recoverable execution scope. Failed/stopped/interrupted scopes may be
    // planned (still inert), but never resumed by this build.
    //
    // Judge the SESSION's newest turn, not the turn that carried the human
    // prompt: Goal rounds and continuation deliveries append turns after it, so
    // a root turn that completed long ago says nothing about the session now.
    // A session currently sitting on a failed (e.g. quota-exhausted) turn — the
    // exact case this queue exists for — must stay addable.
    if (identity.lastTurnEnded === true && identity.lastTurnEndKind === 'completed') {
      throw new HostError('task_not_recoverable', { reason: 'task_already_completed' });
    }
    if (this.#ports.workspaceRegistryAvailable !== true) {
      throw new HostError('capability_missing', { missing: 'workspace registry' });
    }
    const workspaces = await this.#ports.listWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.available === true && samePath(candidate.path, identity.workspacePath));
    if (workspace === undefined) throw new HostError('workspace_unavailable');
    const itemId = stablePlanId(identity.sessionId, identity.generation);
    const plan = this.#planStore.getSnapshot();
    const ref = {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      generation: identity.generation,
      workspaceId: workspace.id,
      // The deployment's ONE configured account scope, when the Host holds a
      // verified read-only quota source; otherwise null (still editable, but
      // permanently ineligible for authorization or a claim).
      quotaScopeId: this.#fixedQuotaScope(),
    };
    const existing = plan.items.find((entry) => entry.id === itemId
      || (entry.ref.sessionId === identity.sessionId && entry.ref.generation === identity.generation));
    if (existing !== undefined && existing.removed !== true) {
      // A retry whose commit was applied but whose response was lost is an
      // idempotent success when it targets the same batch. A different batch
      // is a real conflict, never a silent relocation.
      const batchIndex = plan.batches.findIndex((batch) => batch.includes(existing.id));
      if (batchIndex === payload.batch) return this.#view();
      throw new HostError('plan_conflict', { reason: 'task_identity_already_planned' });
    }
    // Removal with no execution history deletes the entry, so a normal re-add
    // simply appends. Persisted LEGACY tombstones (written by an earlier build
    // that kept them) are restored in place instead of stacking a second row
    // for the same session; restoring refreshes the identity and leaves the
    // authorization disabled.
    const restorable = (entry) => entry.removed === true && entry.attempts === 0
      && entry.fence === null && entry.skip === null && entry.status === 'ready';
    const tombstone = (existing !== undefined && restorable(existing) ? existing : undefined)
      ?? plan.items.find((entry) => entry.ref.sessionId === identity.sessionId && restorable(entry));
    if (tombstone !== undefined) {
      return this.#planCommit(payload.expectedRevision, { type: 'restore', id: tombstone.id, ref });
    }
    if (existing !== undefined) throw new HostError('plan_conflict', { reason: 'task_identity_already_planned' });
    // A live entry for the same session under an older generation already owns
    // the session slot; a second one would violate the plan's one-live-entry
    // rule, so this is a selection conflict, not a new row.
    if (plan.items.some((entry) => entry.ref.sessionId === identity.sessionId && entry.removed !== true)) {
      throw new HostError('plan_conflict', { reason: 'task_identity_already_planned' });
    }
    const command = {
      type: 'add',
      id: itemId,
      ref,
      authorization: { sessionId: identity.sessionId, generation: identity.generation, enabled: false },
      hostConfirmedExisting: true,
      batch: payload.batch,
    };
    return this.#planCommit(payload.expectedRevision, command);
  }

  /**
   * The single authorization entry point. A plan item's authorization and the
   * session opt-in are the same fact, so both persistence units are read,
   * transformed and saved inside one operator-chain step and published only
   * after both durable saves. When the second (guarded) save fails, the plan
   * half is restored so the two units never disagree.
   *
   * Enabling still requires a mounted recovery consumer, exactly like
   * `setSessionOptIn`. Nothing here executes, claims or opens a session, and
   * with execution disabled an authorization can never release a batch.
   */
  async #planAuthorize(payload) {
    const enabled = payload.enabled === true;
    this.#requirePlanEditable();
    if (enabled && this.#autoResume !== true && this.#autoContinue() !== true) {
      throw new HostError('capability_missing', { reason: 'auto_resume_ownership_unverified' });
    }
    // A switch that cannot take effect must SAY so and change nothing: an
    // unbound item with no verifiable account scope is refused out loud instead
    // of returning a silent, seemingly-successful no-op.
    if (enabled && this.#fixedQuotaScope() === null) {
      throw new HostError('capability_missing', { reason: 'quota_scope_unavailable' });
    }
    // Normalize FIRST: an item persisted before the Host had a verified account
    // scope must be bound before its authorization can be judged. The
    // normalization is a separate, Host-only write that grants nothing.
    await this.#normalizePlan();
    // Re-read after the Host's own bind: its write is not part of the caller's
    // command, so the caller's revision moves with it.
    const normalized = this.#requirePlanEditable().getSnapshot();
    const revisionNow = normalized.revision === payload.expectedRevision
      ? payload.expectedRevision
      : Math.max(normalized.revision, payload.expectedRevision);
    const item = this.#planItem(payload.id);
    if (item.removed || item.skip !== null || item.status === 'succeeded') {
      throw new HostError('invalid_request', { field: 'id' });
    }
    const sessionId = item.ref.sessionId;
    // An unbound account scope can never be authorized: persist the honest
    // false instead of a permission nobody could reproduce.
    const next = enabled && item.ref.quotaScopeId !== null;
    const planCurrent = item.authorization.enabled === next;
    const optInCurrent = this.#snapshot().sessionOptIns[sessionId] === next;
    if (planCurrent && optInCurrent) return this.#view();
    let planSaved = planCurrent;
    if (!planCurrent) {
      try {
        await this.#requirePlanEditable().commit(revisionNow, {
          type: 'authorize',
          id: payload.id,
          authorization: { sessionId, generation: item.ref.generation, enabled: next },
        });
      } catch (error) {
        throw planFailure(error);
      }
      planSaved = true;
    }
    if (optInCurrent) return this.#view();
    try {
      const nowIso = this.#nowIso();
      await this.#store.update((draft) => {
        draft.sessionOptIns[sessionId] = next;
        draft.seq += 1;
        draft.updatedAt = nowIso;
      });
    } catch (error) {
      if (planSaved) await this.#revertPlanAuthorization(payload.id, sessionId, item.ref.generation, planCurrent);
      // A failed opt-in write is a persistence failure, not an internal bug:
      // the queue store locks itself when durability is unknown.
      throw planFailure(error, 'persistence_failed');
    }
    return this.#view();
  }

  /** Best-effort compensating write; a locked store stays locked on purpose. */
  async #revertPlanAuthorization(id, sessionId, generation, enabled) {
    try {
      await this.#planStore.commit(this.#planStore.getSnapshot().revision, {
        type: 'authorize',
        id,
        authorization: { sessionId, generation, enabled },
      });
    } catch (error) {
      void error;
    }
  }

  /**
   * Removing a plan entry revokes the authorization it carried, so no surface
   * can keep claiming a scope the plan no longer owns.
   */
  async #planRemove(payload) {
    const item = this.#planItem(payload.id);
    try {
      await this.#requirePlanEditable().commit(payload.expectedRevision, { type: 'remove', id: payload.id });
    } catch (error) {
      throw planFailure(error);
    }
    if (this.#snapshot().sessionOptIns[item.ref.sessionId] === true) {
      try {
        const nowIso = this.#nowIso();
        await this.#store.update((draft) => {
          draft.sessionOptIns[item.ref.sessionId] = false;
          draft.seq += 1;
          draft.updatedAt = nowIso;
        });
      } catch (error) {
        // The plan unit already reports authorization false, so a stale opt-in
        // stays visible rather than silently re-authorizing.
        void error;
      }
    }
    return this.#view();
  }

  /**
   * Translate a target batch/position into the complete permutation the core
   * expects. Target indexes the pre-compaction batch array after the item is
   * removed; an empty source batch is dropped afterwards.
   */
  async #planMove(payload) {
    const planStore = this.#requirePlanEditable();
    const snapshot = planStore.getSnapshot();
    const batches = snapshot.batches.map((batch) => [...batch]);
    const source = batches.findIndex((batch) => batch.includes(payload.id));
    if (source === -1) throw new HostError('invalid_request', { field: 'id' });
    batches[source] = batches[source].filter((id) => id !== payload.id);
    if (payload.batch > batches.length) throw new HostError('invalid_request', { field: 'batch' });
    if (payload.batch === batches.length) batches.push([]);
    const target = batches[payload.batch];
    if (payload.position > target.length) throw new HostError('invalid_request', { field: 'position' });
    target.splice(payload.position, 0, payload.id);
    const compact = batches.filter((batch) => batch.length > 0);
    // A move that produces the current order is an idempotent success, even for
    // a retry carrying the older revision. An actual change still needs the
    // current revision, so a stale client cannot overwrite a newer plan.
    if (JSON.stringify(compact) === JSON.stringify(snapshot.batches)) return this.#view();
    if (payload.expectedRevision !== snapshot.revision) throw new HostError('revision_conflict');
    return this.#planCommit(payload.expectedRevision, { type: 'reorder', batches: compact });
  }

  async #pauseDispatch(payload) {
    const snapshot = this.#snapshot();
    if (snapshot.dispatchPaused === payload.paused) return this.#view();
    const nowIso = this.#nowIso();
    await this.#store.update((draft) => {
      draft.dispatchPaused = payload.paused;
      draft.dispatchPausedReason = payload.paused ? 'paused_by_operator' : null;
      draft.seq += 1;
      draft.updatedAt = nowIso;
    });
    return this.#view();
  }

  async #setSessionOptIn(payload) {
    const sessionId = payload.sessionId.trim();
    if (sessionId.length === 0) throw new HostError('invalid_request');
    // Enabling is accepted only when SOME verified recovery consumer is
    // mounted: the HOT adapter (same-step quota retry) or the durable
    // continuation driver. The durable boolean is still session-scoped, and
    // each consumer re-inspects the exact task and turn before acting.
    if (payload.enabled === true && this.#autoResume !== true && this.#autoContinue() !== true) {
      throw new HostError('capability_missing', { reason: 'auto_resume_ownership_unverified' });
    }
    const next = payload.enabled === true;
    if (this.#snapshot().sessionOptIns[sessionId] === next) return this.#view();
    const nowIso = this.#nowIso();
    await this.#store.update((draft) => {
      draft.sessionOptIns[sessionId] = next;
      draft.seq += 1;
      draft.updatedAt = nowIso;
    });
    return this.#view();
  }

  async #checkQuota() {
    const result = await this.#ports.checkQuota();
    if (!result || result.configured !== true) throw new HostError('configuration_incomplete');
    const snapshot = result.snapshot;
    if (snapshot === null || snapshot === undefined || validateQuotaSnapshot(snapshot).length > 0) {
      // A malformed port answer is never published as quota evidence.
      throw new HostError('internal');
    }
    this.#lastQuota = snapshot;
    return this.#view();
  }

  async #requestStop(payload) {
    if (!this.#snapshot().tasks.some((task) => task.id === payload.id)) throw new HostError('not_found');
    // Old rows never grant permission to stop the corresponding Host session.
    throw new HostError('capability_missing', { reason: 'execution_not_supported' });
  }
}
