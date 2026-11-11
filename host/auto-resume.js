/**
 * quota-queue/host — production wiring for HOT quota recovery.
 *
 * This module is constructed only when BOTH a verified read-only quota source
 * and `autoResume.enabled` are present. It maps the public
 * `agent/request-error` waterfall to the already-tested coordinator:
 *
 *  - only a structured `QUOTA`/`ACCOUNT_QUOTA` failure is considered;
 *  - only a session whose user enabled the per-session switch is considered;
 *  - the exact live task identity is re-inspected before and after each query;
 *  - the quota source is the fixed CPAMC endpoint with one fixed auth index;
 *  - the listener delegates to the remaining policy chain on every doubt.
 *
 * It never creates a task/session, never selects another account and never
 * resets quota. Returning `{kind:'retry'}` only asks the existing agent loop to
 * retry the SAME step.
 */
import { createHash } from 'node:crypto';
import { validateQuotaSnapshot } from '../core/quota.mjs';
import { classifyFailure } from '../core/failure.mjs';
import { createHotRecoveryCoordinator } from '../core/hot-recovery.mjs';
import { createHotRequestErrorAdapter } from './hot-request-error.js';
import { inspectSelectedTask } from './task-identity.js';

const ID = ['sessionId', 'rootMessageId', 'generation', 'turn', 'step', 'scopeId', 'bindingRevision'];
const FLAGS = ['authorized', 'bindingConfirmed', 'ownershipConfirmed', 'requestSettled', 'noOtherRequest', 'quotaFailureConfirmed', 'configurationUnchanged'];
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

/** Stable, non-secret binding revision for this deployment's fixed source. */
export function bindingRevisionOf(config) {
  return createHash('sha256').update(JSON.stringify([
    config.baseUrl, config.authIndex, config.weeklyMinRemaining, config.fiveHourMinRemaining,
  ])).digest('hex');
}

/**
 * @param {object} input
 * @param {() => object|undefined} input.resolveInspection read-only SessionInspection port accessor
 * @param {() => object|undefined} input.resolveAgents agent registry accessor
 * @param {(sessionId: string) => boolean} input.getOptIn current durable opt-in
 * @param {object} input.quotaSource createCpamcQuotaSource result
 * @param {string} input.bindingRevision
 * @param {object} [input.clock]
 * @param {object} [input.logger]
 */
export function createAutoResume(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('auto resume expects an input object');
  const { resolveInspection, resolveAgents, getOptIn, quotaSource, bindingRevision } = input;
  for (const [name, fn] of [['resolveInspection', resolveInspection], ['resolveAgents', resolveAgents], ['getOptIn', getOptIn]]) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (!quotaSource || typeof quotaSource.check !== 'function' || quotaSource.configured !== true) {
    throw new TypeError('a configured quota source is required');
  }
  if (!text(bindingRevision)) throw new TypeError('bindingRevision is required');
  const clock = input.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) };
  const logger = input.logger ?? null;
  const authorizations = new Map();
  const keyOf = (r) => JSON.stringify([r.sessionId, r.rootMessageId, r.generation, r.turn, r.step]);

  async function inspect(r) {
    const facts = Object.fromEntries(ID.map((key) => [key, r[key]]));
    for (const flag of FLAGS) facts[flag] = false;
    facts.authorized = getOptIn(r.sessionId) === true;
    facts.quotaFailureConfirmed = authorizations.get(keyOf(r)) === true;
    facts.requestSettled = true;
    let live = false;
    let identical = false;
    try {
      const agents = resolveAgents();
      const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(r.sessionId) : undefined;
      live = agent !== null && agent !== undefined && agent.status === 'running';
    } catch { live = false; }
    try {
      const identity = await inspectSelectedTask(resolveInspection, r.sessionId, r.signal);
      identical = identity.verified === true
        && identity.sessionId === r.sessionId
        && identity.rootMessageId === r.rootMessageId
        && identity.generation === r.generation
        && identity.turn === r.turn
        && identity.turnEnded === false;
    } catch { identical = false; }
    facts.bindingConfirmed = identical && facts.quotaFailureConfirmed && quotaSource.scopeKey === r.scopeId;
    facts.ownershipConfirmed = live && identical;
    facts.noOtherRequest = live && identical;
    facts.configurationUnchanged = facts.bindingConfirmed;
    return facts;
  }

  async function query(r) {
    if (r.scopeId !== quotaSource.scopeKey || r.bindingRevision !== bindingRevision) {
      throw new Error('quota_binding_changed');
    }
    const snapshot = await quotaSource.check(r.signal);
    if (snapshot.scopeKey !== r.scopeId || validateQuotaSnapshot(snapshot).length > 0) {
      throw new Error('quota_snapshot_invalid');
    }
    return { bindingRevision, snapshot };
  }

  const coordinator = createHotRecoveryCoordinator({
    inspect,
    query,
    clock,
  }, {
    maxWaitMs: input.maxWaitMs ?? 3_600_000,
    maxChecks: input.maxChecks ?? 30,
  });

  async function resolveTask(payload) {
    if (payload === null || typeof payload !== 'object') return null;
    const agent = payload.agent;
    const sessionId = agent !== null && agent !== undefined && agent.session !== null && agent.session !== undefined
      ? agent.session.id
      : undefined;
    if (!text(sessionId) || !integer(payload.turn) || !integer(payload.step)) return null;
    if (payload.signal === undefined || !(payload.signal instanceof AbortSignal) || payload.signal.aborted) return null;
    if (getOptIn(sessionId) !== true) return null;
    let classification;
    try {
      classification = classifyFailure({
        code: payload.failure !== null && typeof payload.failure === 'object' ? payload.failure.code : undefined,
        status: payload.failure !== null && typeof payload.failure === 'object' ? payload.failure.status : undefined,
      });
    } catch { return null; }
    if (classification.class !== 'quota' || classification.createsQuotaTicket !== true) return null;
    const identity = await inspectSelectedTask(resolveInspection, sessionId, payload.signal);
    if (payload.signal.aborted) return null;
    if (identity.verified !== true || identity.turn !== payload.turn || identity.turnEnded === true) return null;
    const mapped = {
      sessionId,
      rootMessageId: identity.rootMessageId,
      generation: identity.generation,
      turn: identity.turn,
      step: payload.step,
      scopeId: quotaSource.scopeKey,
      bindingRevision,
    };
    authorizations.set(keyOf(mapped), true);
    return mapped;
  }

  const adapter = createHotRequestErrorAdapter({ coordinator, resolveTask, logger });
  return Object.freeze({
    listener: adapter.listener,
    coordinator,
    dispose: async () => {
      await adapter.dispose();
      await coordinator.close();
      authorizations.clear();
    },
    activeCount: () => adapter.activeCount(),
  });
}
