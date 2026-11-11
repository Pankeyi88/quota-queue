/**
 * quota-queue/host — dependency-free constants shared by the Host half.
 *
 * Every value here is a *fixed* Host decision. Nothing in this module reads
 * configuration, the network, credentials or the client request.
 */

/** Cordis service key. The Typert wire namespace is deliberately the same key. */
export const SERVICE_KEY = 'quotaQueue';

/** The single Remote endpoint this Host exports: `quotaQueue/dispatch`. */
export const DISPATCH_ENDPOINT = `${SERVICE_KEY}/dispatch`;

/** Request envelope version accepted on the wire. */
export const WIRE_VERSION = 1;

/** View projection version emitted to the Client. */
export const VIEW_VERSION = 1;

/**
 * The Host module generation's own version, compiled into this module.
 *
 * It is a source constant on purpose. Reading `package.json` from disk would
 * report whatever the installed manifest says, which is exactly the value that
 * does NOT prove the running process loaded a new JavaScript module
 * generation — the P3 install showed a stale generation can outlive a package
 * replacement until the process restarts. Because this string is baked into
 * the module itself, a View that reports `0.1.1` proves the Host is executing
 * the 0.1.1 module.
 *
 * It is never taken from a request or the plugin config, and
 * `scripts/build.mjs` fails the build unless it equals `package.json.version`.
 */
export const PLUGIN_VERSION = '0.2.0-dev.38';

/**
 * Storage unit holding the one versioned queue snapshot.
 * Matches the storage hub's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`).
 */
export const STORAGE_UNIT_NAME = 'quota_queue_v1';

/** Storage unit format version stamped on first materialization. */
export const STORAGE_UNIT_VERSION = 1;

/**
 * The ONE loopback port whose exclusive bind is the continuation-owner role.
 *
 * Fixed on purpose: every DSH instance on this machine must contend for the
 * same key. A configurable port would let two instances pick different ports
 * and both believe they own the role.
 */
export const OWNER_LOCK_PORT = 43_187;

/** Durable automatic-continuation tickets live in their own unit. */
export const CONTINUE_UNIT_NAME = 'quota_continue_v1';
export const CONTINUE_UNIT_VERSION = 1;

/** Existing-task plans never share or rewrite the legacy queue global. */
export const RECOVERY_PLAN_UNIT_NAME = 'quota_recovery_plan_v1';
export const RECOVERY_PLAN_UNIT_VERSION = 1;

/** Backend name registered by `@deepseek-ai/dsh-storage-json`. */
export const DEFAULT_STORAGE_BACKEND = 'json';

/** Every Host operation accepted by `dispatch`, in contract order. */
export const OPS = Object.freeze([
  'bootstrap',
  'addManual',
  'editPending',
  'cancelQueued',
  'pauseDispatch',
  'setSessionOptIn',
  'checkQuota',
  'requestStop',
  'planAdd',
  'planConfigure',
  'planPause',
  'planItemPause',
  'planRemove',
  'planSkip',
  'planMove',
  'planAuthorize',
]);

/**
 * Full operation -> payload field specification.
 *
 * Only primitives are allowed: a payload value can never be an object, so a
 * nested `headers`, `body` or `authIndex` structure cannot be smuggled in.
 * `required` fields must be present; a present field must match `type`.
 */
export const PAYLOAD_SPECS = Object.freeze({
  bootstrap: Object.freeze({
    sessionId: { type: 'string', required: false, maxLength: 200 },
  }),
  addManual: Object.freeze({
    title: { type: 'string', required: false, maxLength: 200 },
    prompt: { type: 'string', required: true, maxLength: 200000 },
    workspaceId: { type: 'string', required: true, maxLength: 200 },
    routeId: { type: 'string', required: true, maxLength: 120 },
    autoExecute: { type: 'boolean', required: false },
  }),
  editPending: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200 },
    title: { type: 'string', required: false, maxLength: 200 },
    prompt: { type: 'string', required: false, maxLength: 200000 },
    workspaceId: { type: 'string', required: false, maxLength: 200 },
    routeId: { type: 'string', required: false, maxLength: 120 },
  }),
  cancelQueued: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200 },
  }),
  pauseDispatch: Object.freeze({
    paused: { type: 'boolean', required: true },
  }),
  setSessionOptIn: Object.freeze({
    sessionId: { type: 'string', required: true, maxLength: 200 },
    enabled: { type: 'boolean', required: true },
  }),
  checkQuota: Object.freeze({}),
  requestStop: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200 },
  }),
  planAdd: Object.freeze({
    sessionId: { type: 'string', required: true, maxLength: 256, nonEmpty: true },
    batch: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planConfigure: Object.freeze({
    maxConcurrent: { type: 'integer', required: true, min: 1, max: 8 },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planPause: Object.freeze({
    paused: { type: 'boolean', required: true },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planItemPause: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200, nonEmpty: true },
    paused: { type: 'boolean', required: true },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planRemove: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200, nonEmpty: true },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planSkip: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200, nonEmpty: true },
    confirmed: { type: 'boolean', required: true, literal: true },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  planMove: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200, nonEmpty: true },
    batch: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    position: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
  // The ONE authorization entry point shared by both surfaces: the plan item's
  // authorization and the session opt-in are two faces of the same fact, so a
  // plan item can never disagree with the composer switch.
  planAuthorize: Object.freeze({
    id: { type: 'string', required: true, maxLength: 200, nonEmpty: true },
    enabled: { type: 'boolean', required: true },
    expectedRevision: { type: 'integer', required: true, min: 0, max: Number.MAX_SAFE_INTEGER },
  }),
});

/**
 * Field names refused anywhere in a payload, before type checking. Deny by
 * name is blunt on purpose: the Host has no legitimate use for any of these,
 * so a request carrying one is a caller bug or an injection attempt.
 */
export const DENIED_PAYLOAD_FIELDS = Object.freeze([
  'url',
  'uri',
  'endpoint',
  'baseurl',
  'base_url',
  'headers',
  'header',
  'authorization',
  'auth',
  'authindex',
  'auth_index',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'credential',
  'credentialref',
  'credential_ref',
  'secret',
  'password',
  'cookie',
  'body',
  'raw',
  'rawbody',
  'actor',
  'role',
  'operator',
  'admin',
  'proxy',
  'target',
]);

/**
 * Every operation requires the call to be an operator call admitted by the Host
 * Connection (`invocation.peer === ctx.get('connection').operator`).
 *
 * The gate is deliberately uniform rather than tiered: `bootstrap` returns
 * task prompts, `editPending`/`cancelQueued` mutate the queue, and
 * `pauseDispatch(false)` resumes dispatch, so every one of them is sensitive.
 * One gate is simpler to audit than a per-op list.
 *
 * This is an *authorization tier*, not a physical-user-click proof: an
 * in-process carrier also speaks for the operator. The real containment is
 * that no authorization setter is exposed as an agent tool.
 */
export const OPERATOR_GATED_OPS = Object.freeze([...OPS]);

/** Capability flags this build reports. All false until real evidence exists. */
export const CAPABILITIES = Object.freeze({
  quotaCheck: false,
  execution: false,
  autoResume: false,
});

/** Fixed configuration reasons reported while the capabilities stay disabled. */
export const CAPABILITY_REASONS = Object.freeze([
  'stable_credential_reference_unconfirmed',
  'quota_query_auth_contract_unverified',
  'exclusive_execution_ownership_unproven',
  'auto_resume_ownership_unverified',
]);

/** Chain of custody label used for every `ctx.effect` this plugin owns. */
export const EFFECT_LABEL = 'quota-queue:dispose';
