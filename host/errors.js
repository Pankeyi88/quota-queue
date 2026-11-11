/**
 * quota-queue/host — Host-side failure vocabulary.
 *
 * The Host never returns an exception message, a stack, a `cause`, a URL, a
 * header or a raw upstream body to the Client. Every failure crosses the wire
 * as `{code, message}` where `message` is one of the fixed summaries below
 * and `code` is one of the fixed keys below.
 */

/** Fixed, safe, caller-facing summaries. */
export const SAFE_MESSAGES = Object.freeze({
  invalid_request: 'The request envelope or payload is not accepted.',
  unknown_op: 'The requested operation is not supported.',
  not_remote: 'This operation is only available over the authenticated Connection Remote.',
  invalid_invocation: 'The Remote invocation is missing required identity.',
  operator_required: 'This operation requires an operator call admitted by the Host Connection.',
  configuration_incomplete: 'Required configuration or host evidence is missing; nothing was executed.',
  capability_missing: 'The host capability required for this operation is unavailable in this build.',
  workspace_not_found: 'The selected workspace is not registered.',
  workspace_unavailable: 'The selected workspace directory is not currently available.',
  route_unavailable: 'The selected route is not one of the fixed routes configured on the Host.',
  request_conflict: 'The same requestId was already used with different content.',
  not_found: 'The task does not exist.',
  not_editable: 'Only an unstarted manual task can be edited.',
  not_cancellable: 'Only a queued or pending task can be cancelled.',
  persistence_failed: 'The queue snapshot could not be persisted; dispatch stays stopped.',
  revision_conflict: 'The queue changed underneath this operation; reload and retry.',
  task_not_recoverable: 'The selected task is not a recoverable execution scope.',
  plan_conflict: 'The task identity is already represented in the ordering plan.',
  unavailable: 'The queue service is closed.',
  cancelled: 'The call was cancelled before it completed.',
  internal: 'The operation failed for an internal reason.',
});

/** Core error `code` -> Host failure `code`. Anything unknown becomes internal. */
const CORE_CODE_MAP = Object.freeze({
  INVALID_INPUT: 'invalid_request',
  PERSIST_FAILED: 'persistence_failed',
  SNAPSHOT_INVALID: 'persistence_failed',
  STORE_LOCKED: 'persistence_failed',
  REVISION_CONFLICT: 'revision_conflict',
  CLOSED: 'unavailable',
  PORT_CONTRACT: 'configuration_incomplete',
  CAPABILITY_MISSING: 'capability_missing',
  NOT_FOUND: 'not_found',
  AUTHORIZATION_DENIED: 'operator_required',
  INVALID_TRANSITION: 'invalid_request',
});

/** One Host failure. `code` is always a key of {@link SAFE_MESSAGES}. */
export class HostError extends Error {
  /**
   * @param {string} code one of the {@link SAFE_MESSAGES} keys
   * @param {object} [details] internal-only diagnostics; never serialized
   */
  constructor(code, details = {}) {
    const safeCode = Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, code) ? code : 'internal';
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'HostError';
    this.code = safeCode;
    this.details = details;
  }
}

/**
 * Map any thrown value onto the wire failure shape.
 * @param {unknown} error
 * @returns {{code: string, message: string}}
 */
export function toFailure(error) {
  if (error instanceof HostError) {
    return { code: error.code, message: SAFE_MESSAGES[error.code] };
  }
  const coreCode = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  if (typeof coreCode === 'string' && Object.prototype.hasOwnProperty.call(CORE_CODE_MAP, coreCode)) {
    const code = CORE_CODE_MAP[coreCode];
    return { code, message: SAFE_MESSAGES[code] };
  }
  return { code: 'internal', message: SAFE_MESSAGES.internal };
}

/**
 * Wrap a core-layer error in a Host failure with an explicit Host code.
 * @param {unknown} error
 * @param {string} fallbackCode safe Host code when the core code is unknown
 * @returns {HostError}
 */
export function fromCoreError(error, fallbackCode) {
  const failure = toFailure(error);
  const code = failure.code === 'internal' ? fallbackCode : failure.code;
  return new HostError(code, { coreCode: error && typeof error === 'object' ? Reflect.get(error, 'code') : null });
}
