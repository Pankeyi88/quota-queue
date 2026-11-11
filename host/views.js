/**
 * quota-queue/host — the fixed, safe View projection.
 *
 * The View is a plain JSON value with exactly the fields of the wire contract.
 * It never contains a credential reference, a raw upstream body, request
 * headers, an error `cause`, a filesystem path of the plugin, or a capability
 * that the Host did not truthfully earn.
 */
import { CAPABILITIES, CAPABILITY_REASONS, PLUGIN_VERSION, VIEW_VERSION } from './constants.js';

/**
 * Project one stored task.
 *
 * `prompt` is emitted only for a `new-session` (manual) task, where the edit
 * form needs it. A `resume-session` task never stores the original prompt at
 * all (the core enforces this), so no original text can leak through recovery.
 *
 * @param {object} task core task record
 * @param {Map<string, object>} routes configured fixed routes by id
 * @param {{dispatchPaused?: boolean}} [context] observable queue state a row needs
 * @returns {object} TaskView
 */
export function taskView(task, routes, context = {}) {
  const view = {
    id: task.id,
    kind: task.kind,
    title: task.title,
    workspaceId: task.workspaceId,
    workspacePathSnapshot: task.workspacePathSnapshot,
    provider: task.provider,
    model: task.model,
    status: task.status,
    attempts: task.attempts,
  };
  // Old reservations are read-only history. Do not expose their original
  // prompt to a now-retired edit form or treat them as existing user tasks.
  const route = routeForTask(task, routes);
  if (route !== null) view.routeId = route.id;
  if (typeof task.sessionId === 'string') view.sessionId = task.sessionId;
  if (typeof task.nextCheckAt === 'string') view.nextCheckAt = task.nextCheckAt;
  const reason = taskReason(task, context);
  if (reason !== null) view.reason = reason;
  return view;
}

/** Row statuses that are queued for a dispatch this build never performs. */
const AWAITING_DISPATCH_STATUSES = Object.freeze(['draft', 'queued', 'ready']);

/**
 * A stable, non-sensitive waiting/failure reason for a task row.
 *
 * A row that is saved but will not run must never look like it is merely
 * waiting its turn: an awaiting-dispatch row always reports why it is not
 * running, and the paused variants stay distinguishable from it.
 *
 * @param {object} task core task record
 * @param {{dispatchPaused?: boolean}} [context]
 * @returns {string|null}
 */
export function taskReason(task, context = {}) {
  if (typeof task.needsAttentionReason === 'string' && task.needsAttentionReason.length > 0) return task.needsAttentionReason;
  if (task.lastFailure !== null && task.lastFailure !== undefined && typeof task.lastFailure.safeSummary === 'string') {
    return task.lastFailure.safeSummary;
  }
  if (task.stopRequested === true) return 'stop_requested';
  if (task.pendingQuotaWait === true || task.status === 'waiting_quota') return 'waiting_for_quota_recheck';
  if (task.status === 'paused') return 'task_paused_by_operator';
  if (AWAITING_DISPATCH_STATUSES.includes(task.status)) {
    // Global pause is a distinct, reversible hold; otherwise execution itself is
    // the missing capability.
    return context.dispatchPaused === true ? 'dispatch_paused' : 'execution_capability_missing';
  }
  if (task.status === 'needs_attention') return 'needs_attention';
  return null;
}

/**
 * Match a stored task back to the configured fixed route it was created from.
 * @param {object} task
 * @param {Map<string, object>} routes
 * @returns {object|null}
 */
export function routeForTask(task, routes) {
  for (const route of routes.values()) {
    if (route.provider === task.provider && route.model === task.model && route.credentialRef === task.credentialRef) {
      return route;
    }
  }
  return null;
}

/**
 * Project a configured route.
 *
 * `available` means "verified executable" and stays false while execution is
 * disabled. `selectable` is the separate save-only axis: a fixed, user-declared
 * route may be chosen so a manual task can be persisted in an unexecuted state.
 * It never means quota is available or that the task will run.
 * @param {object} route
 * @returns {object} RouteView
 */
export function routeView(route) {
  const executable = CAPABILITIES.execution === true;
  return {
    id: route.id,
    label: route.label,
    provider: route.provider,
    model: route.model,
    available: executable,
    selectable: true,
    ...(executable ? {} : { reason: 'execution_capability_missing' }),
  };
}

/**
 * Project a workspace from the real registry projection.
 * @param {{id:string,name:string,path:string,available:boolean}} workspace
 * @returns {object} WorkspaceView
 */
export function workspaceView(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    available: workspace.available === true,
  };
}

/**
 * Build the complete View.
 *
 * `configuration.ready` is derived, never asserted: it requires every
 * capability to be true and no outstanding reason. In this build readiness is
 * therefore always false.
 *
 * @param {object} input
 * @param {object} input.snapshot the published core snapshot
 * @param {object[]} input.tasks projected TaskViews
 * @param {object[]} input.workspaces projected WorkspaceViews
 * @param {object[]} input.routes projected RouteViews
 * @param {string[]} input.reasons configuration reasons
 * @returns {object} View
 */
export function buildView({
  snapshot, tasks, workspaces, routes, reasons,
  capabilities = CAPABILITIES,
  capabilityReasons = CAPABILITY_REASONS,
  autoContinue = null,
}) {
  const allReasons = new Set(capabilityReasons);
  for (const reason of reasons) allReasons.add(reason);
  const reasonsList = [...allReasons];
  const ready = capabilities.execution === true
    && capabilities.quotaCheck === true
    && capabilities.autoResume === true
    && reasonsList.length === 0;
  return {
    version: VIEW_VERSION,
    // Read-only diagnostic: the Host module generation actually executing. It
    // comes from a compiled constant, never from the request, the config or a
    // disk manifest, so it proves a new module generation is live.
    runtimeVersion: PLUGIN_VERSION,
    revision: snapshot.revision,
    paused: snapshot.dispatchPaused,
    configuration: { ready, reasons: reasonsList },
    capabilities: { ...capabilities },
    tasks,
    workspaces,
    routes,
    sessionOptIns: { ...snapshot.sessionOptIns },
    // Automatic-continuation state. Never contains a prompt, an error body or
    // a credential; the Client ignores members it does not know.
    autoContinue: autoContinue === null ? { enabled: false, owner: 'disabled', ownerReason: null, store: 'closed', tickets: [] } : autoContinue,
  };
}
