/**
 * quota-queue/core — public entry point (P1, no host dependencies).
 *
 * Exports:
 *  - normalizeQuota({ outerStatus, envelope, scopeKey, now, modelMappingVerified, model? })
 *  - classifyFailure({ code, status })
 *  - QueueStore({ load, save })
 *  - QueueService({ store, quota, session, clock, ids, capabilities, config })
 *
 * All external I/O is injected through ports; nothing here opens a socket,
 * reads a credential or touches the host.
 */
export {
  QuotaQueueError,
  InputValidationError,
  PersistenceError,
  SnapshotValidationError,
  StoreLockedError,
  RevisionConflictError,
  ClosedError,
  PortContractError,
  StateTransitionError,
  NotFoundError,
  AuthorizationError,
  CapabilityError,
} from './errors.mjs';

export {
  normalizeQuota,
  validateQuotaSnapshot,
  makeInferenceErrorSnapshot,
  isSafeReasonCode,
  findNonJsonValue,
  QUOTA_STATES,
  QUOTA_SOURCES,
  QUOTA_REASON_CODES,
  RESET_CONFIDENCE,
  SNAPSHOT_TTL_MS,
  RESET_TOLERANCE_MS,
  ALLOWED_SNAPSHOT_KEYS,
} from './quota.mjs';

export {
  classifyFailure,
  KNOWN_CODES,
  QUOTA_CODES,
  RATE_LIMIT_CODES,
  AUTH_CODES,
  USER_CANCEL_CODES,
  TRANSIENT_CODES,
  REQUEST_ERROR_CODES,
  CONFIGURATION_CODES,
  FAILURE_CONFLICTS,
} from './failure.mjs';

export {
  QueueStore,
  createEmptySnapshot,
  validateSnapshot,
  SNAPSHOT_KEYS,
} from './store.mjs';

export {
  QueueService,
  REQUIRED_CAPABILITIES,
  CAPABILITY_EVIDENCE,
  OPTIONAL_CAPABILITIES,
  DEFAULT_CONFIG,
  DENIED_INPUT_FIELDS,
  PREPARE_NEW_KEYS,
  START_NEW_KEYS,
  CONTINUE_ORIGINAL_KEYS,
  REQUEST_STOP_KEYS,
  SESSION_POLICY,
  RECOVERY_BACKOFF_MS,
  REQUIRED_SESSION_FACTS,
  RECONCILE_KEYS,
  claimBlockedBy,
  reconcileIdentityProblem,
  systemClock,
  systemIds,
} from './service.mjs';

export {
  createTask,
  validateTask,
  deriveTitle,
  quotaScopeKey,
  resumeDedupeKey,
  backoffDelayMs,
  BACKOFF_MS,
  SCHEMA_VERSION,
  TASK_KEYS,
  TASK_STATUSES,
  TASK_KINDS,
  TERMINAL_STATUSES,
  DISPATCHABLE_STATUSES,
  EDITABLE_STATUSES,
  CANCELLABLE_STATUSES,
  TURN_END_SUCCESS,
  ACCEPTED_TURN_END_REASONS,
  REJECTED_SETTLE_REASONS,
  FAILURE_CLASSES,
  LIMIT_TYPES,
  ACTORS,
} from './tasks.mjs';

import { QueueStore } from './store.mjs';
import { QueueService } from './service.mjs';

/**
 * Convenience factory mirroring the brief's constructor shape.
 * @param {{load?: Function, save?: Function, store?: object, quota: object, session: object,
 *          clock?: object, ids?: object, capabilities?: object, config?: object}} ports
 * @returns {Promise<QueueService>} an opened service
 */
export async function createQueueService(ports = {}) {
  const store = ports.store ?? new QueueStore({ load: ports.load, save: ports.save });
  if (typeof store.open === 'function' && store.opened !== true) await store.open();
  return new QueueService({ ...ports, store });
}
