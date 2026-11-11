/**
 * Offline test harness for quota-queue/core.
 *
 * Every port here is an in-memory fake. No network, no host, no credentials:
 * host features that do not exist yet are exercised as PORT CONTRACT tests,
 * not as real integration.
 */
import { QueueStore, QueueService } from '../../core/index.mjs';

export const ISO = '2026-03-01T00:00:00.000Z';
export const WORKSPACE_ID = 'ws-1';
export const WORKSPACE_PATH = 'E:/ws/one';
export const PROVIDER = 'provider-a';
export const MODEL = 'model-a';
export const SESSION_ID = 'session-1';

export function makeClock(startIso = ISO) {
  let current = Date.parse(startIso);
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(iso) {
      current = Date.parse(iso);
      return current;
    },
    iso: () => new Date(current).toISOString(),
  };
}

export function makeIds(prefix = 't') {
  let counter = 0;
  return {
    next(kind) {
      counter += 1;
      return `${prefix}-${kind}-${counter}`;
    },
    get count() { return counter; },
  };
}

export function memoryStorePort({ initial = null } = {}) {
  const state = {
    persisted: initial === null ? null : structuredClone(initial),
    saves: [],
    loadCalls: 0,
    saveCalls: 0,
    failNext: 0,
    failWith: 'disk offline',
  };
  return {
    state,
    async load() {
      state.loadCalls += 1;
      return state.persisted === null ? null : structuredClone(state.persisted);
    },
    async save(snapshot) {
      state.saveCalls += 1;
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new Error(state.failWith);
      }
      state.persisted = structuredClone(snapshot);
      state.saves.push(structuredClone(snapshot));
    },
    failNextSaves(times = 1, message = 'disk offline') {
      state.failNext = times;
      state.failWith = message;
    },
    lastPersisted() {
      return state.persisted === null ? null : structuredClone(state.persisted);
    },
  };
}

export function fullCapabilities() {
  return {
    singleOwner: true,
    routeBound: true,
    sessionExecution: true,
    workspaceResolution: true,
    claimObservation: true,
    turnEndObservation: true,
    sessionIdempotentCreate: true,
    messageIdempotentDelivery: true,
  };
}

export function fakeSession(overrides = {}) {
  const calls = { inspect: [], prepareNew: [], startNew: [], continueOriginal: [], requestStop: [], reconcile: [] };
  const facts = (sessionId) => ({
    sessionId,
    workspaceId: WORKSPACE_ID,
    cwd: WORKSPACE_PATH,
    provider: PROVIDER,
    model: MODEL,
    revision: 'rev-1',
    running: false,
    goalOwned: false,
    alwaysRetry: false,
    ...(typeof overrides.facts === 'function' ? overrides.facts(sessionId) : overrides.facts ?? {}),
  });
  const session = {
    calls,
    async inspect(sessionId) {
      calls.inspect.push(sessionId);
      if (typeof overrides.inspect === 'function') return overrides.inspect(sessionId);
      return facts(sessionId);
    },
    async prepareNew(request) {
      calls.prepareNew.push(structuredClone(request));
      if (typeof overrides.prepareNew === 'function') return overrides.prepareNew(request);
      return { sessionId: request.sessionId, workspaceId: request.workspaceId, cwd: request.cwd, revision: 'rev-new' };
    },
    async startNew(request) {
      calls.startNew.push(structuredClone(request));
      if (typeof overrides.startNew === 'function') return overrides.startNew(request);
      return { accepted: true, sessionId: request.sessionId, messageId: request.messageId };
    },
    async continueOriginal(request) {
      calls.continueOriginal.push(structuredClone(request));
      if (typeof overrides.continueOriginal === 'function') return overrides.continueOriginal(request);
      return { accepted: true, sessionId: request.sessionId, messageId: request.messageId };
    },
    async requestStop(request) {
      calls.requestStop.push(structuredClone(request));
      if (typeof overrides.requestStop === 'function') return overrides.requestStop(request);
      return { accepted: true };
    },
  };
  if (typeof overrides.reconcile === 'function') {
    session.reconcile = async (request) => {
      calls.reconcile.push(structuredClone(request));
      return overrides.reconcile(request);
    };
  }
  return session;
}

/** A quota port whose single-flight concurrency is observable. */
export function fakeQuota(behavior = null, { now = () => ISO } = {}) {
  const calls = { check: [] };
  const stats = { inFlight: 0, maxConcurrent: 0 };
  return {
    calls,
    stats,
    async check(scope) {
      calls.check.push(structuredClone(scope));
      stats.inFlight += 1;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
      try {
        if (typeof behavior === 'function') return await behavior(scope, calls.check.length, now);
        return availableSnapshot({ scopeKey: scope.scopeKey, observedAt: now() });
      } finally {
        stats.inFlight -= 1;
      }
    },
  };
}

/** A promise plus its resolvers, for barrier-style concurrency tests. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function availableSnapshot({ scopeKey, observedAt = ISO, remaining = 82, resetAt = null }) {
  return {
    scopeKey,
    state: 'available',
    source: 'proxy-query',
    observedAt,
    validUntil: null,
    modelMappingVerified: true,
    remaining,
    unit: 'percent',
    resetAt,
    resetConfidence: resetAt === null ? null : 'confirmed',
    nextResetAt: resetAt,
    blockingWindows: [],
    observedWindows: [
      { id: 'primary_window', usedPercent: remaining === null ? null : 100 - remaining, windowSeconds: 18000, resetAt, resetConfidence: resetAt === null ? null : 'confirmed', blocked: false, saturation: false },
    ],
    saturated: false,
    credits: null,
    errorClass: null,
    releaseRecommended: true,
    reasons: ['outer_http_ok', 'inner_status_ok', 'inner_body_object', 'explicit_allow'],
  };
}

export function exhaustedSnapshot({ scopeKey, observedAt = ISO, resetAt = null, reason = 'quota' }) {
  return {
    scopeKey,
    state: 'exhausted',
    source: 'proxy-query',
    observedAt,
    validUntil: null,
    modelMappingVerified: true,
    remaining: 0,
    unit: 'percent',
    resetAt,
    resetConfidence: resetAt === null ? null : 'confirmed',
    nextResetAt: resetAt,
    blockingWindows: [
      { id: 'primary_window', reason, usedPercent: 100, resetAt, resetConfidence: resetAt === null ? null : 'confirmed', blocked: true },
    ],
    observedWindows: [
      { id: 'primary_window', usedPercent: 100, windowSeconds: 18000, resetAt, resetConfidence: resetAt === null ? null : 'confirmed', blocked: true, saturation: true },
    ],
    saturated: true,
    credits: null,
    errorClass: 'quota',
    releaseRecommended: false,
    reasons: ['outer_http_ok', 'inner_status_ok', 'inner_body_object', 'blocking_windows'],
  };
}

export async function makeHarness({
  initial = null,
  capabilities = fullCapabilities(),
  config = {},
  session: sessionOverrides = {},
  quota: quotaBehavior = null,
  now = ISO,
  ids: idsOverride = null,
  storePort = memoryStorePort({ initial }),
} = {}) {
  const clock = makeClock(now);
  const ids = idsOverride ?? makeIds('t');
  const session = fakeSession(sessionOverrides);
  const quota = fakeQuota(quotaBehavior, { now: () => clock.iso() });
  const store = new QueueStore({ load: storePort.load, save: storePort.save });
  await store.open();
  const service = new QueueService({ store, quota, session, clock, ids, capabilities, config });
  return {
    store,
    storePort,
    service,
    quota,
    session,
    clock,
    ids,
    snapshot: () => store.getSnapshot(),
    task: (taskId) => service.list().tasks.find((item) => item.id === taskId) ?? null,
  };
}

/** The observed two-layer success payload, with internally consistent resets. */
export function usagePayload({ nowIso = ISO, primary = {}, secondary = {}, rateLimit = {}, ...rest } = {}) {
  const nowMs = Date.parse(nowIso);
  const window = (usedPercent, seconds) => ({
    used_percent: usedPercent,
    limit_window_seconds: seconds,
    reset_after_seconds: seconds,
    reset_at: Math.floor((nowMs + seconds * 1000) / 1000),
  });
  return {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { ...window(18, 18000), ...primary },
      secondary_window: { ...window(19, 604800), ...secondary },
      ...rateLimit,
    },
    credits: { has_credits: false, balance: 0 },
    spend_control: { reached: false },
    rate_limit_reached_type: null,
    ...rest,
  };
}

export function envelope(body, statusCode = 200) {
  return { status_code: statusCode, header: {}, body };
}

/** Add a manual task WITH explicit auto-execution authorization. */
export async function addManualTask(harness, overrides = {}) {
  return harness.service.addManual({
    title: 'manual task',
    prompt: 'do the thing',
    workspaceId: WORKSPACE_ID,
    workspacePath: WORKSPACE_PATH,
    provider: PROVIDER,
    model: MODEL,
    autoResume: true,
    ...overrides,
  });
}

export async function advanceAndTick(harness, ms = 61_000, args = {}) {
  harness.clock.advance(ms);
  return harness.service.tick(args);
}

/** A second store port over the same durable state (simulates a restart). */
export function reopenPort(port) {
  return {
    state: port.state,
    async load() {
      return port.state.persisted === null ? null : structuredClone(port.state.persisted);
    },
    async save(snapshot) {
      port.state.persisted = structuredClone(snapshot);
      port.state.saveCalls += 1;
    },
  };
}

/** Drive a queued new-session task to running (tick checks, tick dispatches). */
export async function driveNewTaskToRunning(harness) {
  await harness.service.tick();
  return harness.service.tick();
}

/** Drive a captured resume ticket to running (backoff, re-check, dispatch). */
export async function driveResumeTicketToRunning(harness, ms = 61_000) {
  await harness.service.tick();
  await advanceAndTick(harness, ms);
  return harness.service.tick();
}

export function runningCount(harness) {
  return harness.snapshot().tasks.filter((task) => task.status === 'running').length;
}

/** Capture a quota failure WITH explicit user-task evidence (see the core rule). */
export function captureQuotaFailure(harness, overrides = {}) {
  return harness.service.captureFailure({
    userTask: true,
    sessionId: SESSION_ID,
    failedStepId: 'step-1',
    generation: '1',
    code: 'QUOTA',
    provider: PROVIDER,
    model: MODEL,
    workspaceId: WORKSPACE_ID,
    workspacePath: WORKSPACE_PATH,
    ...overrides,
  });
}

export async function optIn(harness, sessionId = SESSION_ID) {
  return harness.service.setSessionOptIn({ sessionId, optIn: true, actor: 'user' });
}

/** Drive a queued task whose quota snapshot is already known to running. */
export async function driveToRunning(harness) {
  await harness.service.tick();
  await harness.clock.advance(1000);
  return harness.service.tick();
}
