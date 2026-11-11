/**
 * quota-queue/host — host capability adapters.
 *
 * The queue operations never touch a Cordis service directly; they consume
 * this narrow port face. That keeps every operation testable against fake
 * ports while the production adapter reads only the public declarations:
 * `workspaceRegistry.list()`, `workspaceRegistry.get(id)` and
 * `workspace.status()`.
 *
 * ## The registry is resolved per call, never captured
 *
 * `@deepseek-ai/dsh-workspace`'s `WorkspaceRegistry` completes a
 * `Service.init` that awaits session persistence and a one-time history
 * bootstrap before the service becomes ACTIVE, and `ctx.get(name)` returns
 * `undefined` for a provider that is not ACTIVE yet. Reading it once during
 * this plugin's activation therefore latches
 * `workspace_registry_unavailable` for the whole process lifetime, even though
 * the registry appears moments later — the P3 defect this shape fixes.
 *
 * `resolveWorkspaceRegistry` is called on every
 * `workspaceRegistryAvailable`, `listWorkspaces` and `getWorkspace`
 * evaluation, so a registry that appears late, disappears temporarily, or is
 * replaced is always observed in its current state. Nothing is cached and no
 * profile, filesystem or private Cordis access is involved.
 *
 * Everything here is read-only. The adapter never creates, renames, archives
 * or attaches a workspace.
 */
import { createQuotaBridge } from './quota.js';
import { createExistingTaskReader } from './existing-tasks.js';
import { inspectSelectedTask } from './task-identity.js';

/** Reason added to the View when the workspace registry is not mounted. */
export const WORKSPACE_REGISTRY_REASON = 'workspace_registry_unavailable';

/**
 * Narrow a resolver result to a usable registry.
 * @param {unknown} value
 * @returns {object|null} the registry, or null when it is absent or unusable
 */
function usableRegistry(value) {
  if (value === undefined || value === null || typeof value !== 'object') return null;
  if (typeof value.list !== 'function' || typeof value.get !== 'function') return null;
  return value;
}

/**
 * Read the live directory status of one workspace without mutating it.
 * @param {object} workspace registry entity
 * @returns {Promise<boolean>}
 */
async function statusOk(workspace) {
  if (typeof workspace.status !== 'function') return false;
  try {
    return (await workspace.status()) === 'ok';
  } catch {
    return false;
  }
}

/**
 * Project one registry entity.
 * @param {object} entity
 * @returns {{id: string, name: string, path: string, available: boolean}}
 */
async function projectWorkspace(entity) {
  return {
    id: entity.id,
    name: typeof entity.title === 'string' && entity.title.length > 0 ? entity.title : entity.path,
    path: entity.path,
    available: await statusOk(entity),
  };
}

/**
 * Build the operation port face.
 * @param {{
 *   resolveWorkspaceRegistry?: () => unknown,
 *   resolveSessionController?: () => unknown,
 *   resolveInspection?: () => unknown,
 *   resolveAgents?: () => unknown,
 *   quotaBridge?: object,
 * }} [input] every resolver returns the CURRENT service (or undefined while it
 *   is not active) and must not pre-capture a value. `resolveInspection`
 *   returns the plugin's read-only SessionInspection port
 *   (host/session-inspection.js), not the Host controller.
 * @returns {{
 *   workspaceRegistryAvailable: boolean,
 *   listWorkspaces: () => Promise<object[]>,
 *   getWorkspace: (id: string) => Promise<object|null>,
 *   identifyExistingTask: (sessionId: string, signal?: AbortSignal) => Promise<object>,
 *   checkQuota: () => Promise<object>,
 * }}
 */
export function createHostPorts(input = {}) {
  const resolve = typeof input.resolveWorkspaceRegistry === 'function'
    ? input.resolveWorkspaceRegistry
    : () => undefined;
  const quotaBridge = input.quotaBridge === undefined ? createQuotaBridge() : input.quotaBridge;
  const quotaSourceConfigured = input.quotaSourceConfigured === true;
  const managementKeyPresent = input.managementKeyPresent === true;
  const existingTasks = createExistingTaskReader(
    typeof input.resolveSessionController === 'function' ? input.resolveSessionController : () => undefined,
  );
  // Identity reads the plugin's own inspection port; the Host controller is only
  // needed for the header-only list. DSH 0.2.2 retired SessionController.inspect.
  const resolveInspection = typeof input.resolveInspection === 'function'
    ? input.resolveInspection
    : () => undefined;
  const resolveAgents = typeof input.resolveAgents === 'function' ? input.resolveAgents : () => undefined;
  const autoContinueView = typeof input.autoContinueView === 'function' ? input.autoContinueView : () => null;

  /** The registry as of this instant, or null. */
  const currentRegistry = () => {
    try {
      return usableRegistry(resolve());
    } catch {
      return null;
    }
  };

  return {
    /** Live availability: an accessor, so it is never a stale snapshot. */
    get workspaceRegistryAvailable() {
      return currentRegistry() !== null;
    },
    /** True only when a Host-verified read-only quota source is configured. */
    get quotaConfigured() {
      return quotaBridge !== null && typeof quotaBridge === 'object' && quotaBridge.configured === true;
    },
    /** Whether the row declared a quota source at all (even without its key). */
    get quotaSourceConfigured() { return quotaSourceConfigured; },
    /** Whether the named environment variable had a non-empty value at activation. */
    get managementKeyPresent() { return managementKeyPresent; },
    /**
     * The deployment's ONE fixed quota scope, when a verified read-only source
     * is bound. This is the only account scope this build may ever bind to a
     * plan item: it comes from Host configuration, never from a request.
     */
    get quotaScopeId() {
      const configured = typeof input.quotaScopeId === 'string' ? input.quotaScopeId : null;
      const key = configured !== null
        ? configured
        : (quotaBridge !== null && typeof quotaBridge === 'object' ? quotaBridge.scopeKey : undefined);
      return typeof key === 'string' && key.length > 0 ? key.slice(0, 200) : null;
    },
    /** Safe projection of the automatic-continuation driver, or null. */
    get autoContinueView() {
      try { return autoContinueView(); } catch { return null; }
    },
    async listWorkspaces() {
      const registry = currentRegistry();
      if (registry === null) return [];
      let entities;
      try {
        entities = registry.list();
      } catch {
        return [];
      }
      if (!Array.isArray(entities)) return [];
      const out = [];
      for (const entity of entities) {
        if (entity === null || typeof entity !== 'object') continue;
        if (typeof entity.id !== 'string' || typeof entity.path !== 'string') continue;
        out.push(await projectWorkspace(entity));
      }
      return out;
    },
    async getWorkspace(id) {
      const registry = currentRegistry();
      if (registry === null || typeof id !== 'string' || id.length === 0) return null;
      let entity;
      try {
        entity = registry.get(id);
      } catch {
        return null;
      }
      if (entity === null || entity === undefined || typeof entity !== 'object') return null;
      if (typeof entity.id !== 'string' || typeof entity.path !== 'string') return null;
      return projectWorkspace(entity);
    },
    async listExistingTasks(signal) {
      return existingTasks.list(signal);
    },
    /**
     * Point inspection of ONE user-selected session. This is deliberately not
     * used to populate the list: it reads the selected log read-only.
     */
    /**
     * Best-effort POSITIVE running evidence from the public agent registry.
     * Returns true only when a live agent reports `status === 'running'`.
     * Missing readiness, unknown services or malformed entities return null:
     * absence of evidence is not evidence of a stopped execution, and the
     * caller must not treat null as "safe to execute" (execution is disabled
     * independently). It is used to REPORT a running plan item (`task_running`
     * blocker) and to hold automatic continuation; it never authorizes work.
     */
    isSessionRunning(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      let agents;
      try { agents = resolveAgents(); } catch { return null; }
      if (agents === null || agents === undefined || typeof agents.get !== 'function') return null;
      let agent;
      try { agent = agents.get(sessionId); } catch { return null; }
      if (agent === null || typeof agent !== 'object') return null;
      const status = Reflect.get(agent, 'status');
      return status === 'running' ? true : (typeof status === 'string' ? false : null);
    },
    async identifyExistingTask(sessionId, signal) {
      return inspectSelectedTask(resolveInspection, sessionId, signal);
    },
    async checkQuota() {
      return quotaBridge.check();
    },
  };
}
