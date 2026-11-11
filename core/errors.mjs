/**
 * quota-queue/core — error taxonomy.
 *
 * Every error carries a stable machine-routable `code`; callers must route on
 * `code` and never parse `message`. Messages are diagnostic only and must not
 * embed credentials, raw proxy responses, request headers or task prompts —
 * nothing in this module accepts such text.
 */

/** Base class for every quota-queue core failure. */
export class QuotaQueueError extends Error {
  /**
   * @param {string} message diagnostic message (no secrets)
   * @param {string} code stable machine-routable code
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, code, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Caller-supplied arguments are missing, malformed or forbidden. */
export class InputValidationError extends QuotaQueueError {
  constructor(message, details = []) {
    super(message, 'INVALID_INPUT');
    this.details = Object.freeze([...details]);
  }
}

/** The injected persistence port failed; the store locks itself from now on. */
export class PersistenceError extends QuotaQueueError {
  constructor(message, options) {
    super(message, 'PERSIST_FAILED', options);
  }
}

/** A persisted snapshot (or a commit candidate) failed strict validation. */
export class SnapshotValidationError extends QuotaQueueError {
  constructor(message, issues = []) {
    super(message, 'SNAPSHOT_INVALID');
    this.issues = Object.freeze([...issues]);
  }
}

/** The store is locked after a persistence failure; all scheduling must stop. */
export class StoreLockedError extends QuotaQueueError {
  constructor(message, options) {
    super(message, 'STORE_LOCKED', options);
  }
}

/**
 * A write carried a stale revision. This is an in-process single-instance guard
 * only: it is NOT a backend compare-and-swap and proves nothing across processes.
 */
export class RevisionConflictError extends QuotaQueueError {
  constructor(message, details = {}) {
    super(message, 'REVISION_CONFLICT');
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

/** The store or service was closed; no further writes or scheduling. */
export class ClosedError extends QuotaQueueError {
  constructor(message) {
    super(message, 'CLOSED');
  }
}

/** A required host capability or a required injected port method is missing. */
export class PortContractError extends QuotaQueueError {
  constructor(message, details = []) {
    super(message, 'PORT_CONTRACT');
    this.details = Object.freeze([...details]);
  }
}

/** A state transition was attempted that the state machine forbids. */
export class StateTransitionError extends QuotaQueueError {
  constructor(message, details = {}) {
    super(message, 'INVALID_TRANSITION');
    this.taskId = details.taskId;
    this.from = details.from;
    this.to = details.to;
  }
}

/** The referenced task does not exist in the queue. */
export class NotFoundError extends QuotaQueueError {
  constructor(message) {
    super(message, 'NOT_FOUND');
  }
}

/** A user-only action was requested by a non-user actor. */
export class AuthorizationError extends QuotaQueueError {
  constructor(message) {
    super(message, 'AUTHORIZATION_DENIED');
  }
}

/** A required host capability is absent, so automatic execution is refused. */
export class CapabilityError extends QuotaQueueError {
  constructor(message, missing = []) {
    super(message, 'CAPABILITY_MISSING');
    this.missing = Object.freeze([...missing]);
  }
}
