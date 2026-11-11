/**
 * quota-queue/host — read-only QuotaPort bridge.
 *
 * The bridge describes one *fixed* read target and refuses to use it. There is
 * no verified authentication contract for the management query and no stable
 * reference for the common Codex credential, so this build performs **no
 * network request at all** and reports `configuration_incomplete`.
 *
 * Guarantees, all testable offline:
 *  - no `fetch`, no `http`/`https` import, no socket, no URL from config;
 *  - no `authIndex`, request header, token or credential value is accepted or
 *    forwarded from the Client;
 *  - a transport, when injected for tests, is stored but never invoked;
 *  - the offline normalization path delegates to the core two-layer
 *    normalizer, which is the only place proxy evidence is interpreted.
 */
import { normalizeQuota } from '../core/quota.mjs';

/**
 * The fixed target this build would use if the contract were verified. Every
 * value is Host-owned; none is caller-supplied. `enabled` is false.
 */
export const FIXED_QUOTA_TARGET = Object.freeze({
  enabled: false,
  /** A user-named reference only; no secret is stored or derived here. */
  credentialRef: null,
  /** The observed upstream read: a single GET of the usage document. */
  upstreamRead: 'GET usage',
  /** The management endpoint is unset because its auth contract is unverified. */
  managementEndpoint: null,
  reasons: Object.freeze([
    'stable_credential_reference_unconfirmed',
    'quota_query_auth_contract_unverified',
  ]),
});

/** Capability projection of this bridge. */
export function quotaCapability() {
  return {
    configured: FIXED_QUOTA_TARGET.enabled === true,
    network: false,
    reasons: [...FIXED_QUOTA_TARGET.reasons],
  };
}

/**
 * Create the bridge.
 * @param {{transport?: unknown}} [options] `transport` is accepted for tests only
 *   and is never called by {@link QuotaBridge.check}.
 * @returns {{capability: object, check: () => Promise<object>, transport: unknown}}
 */
export function createQuotaBridge(options = {}) {
  const transport = options.transport === undefined ? null : options.transport;
  return {
    transport,
    capability: quotaCapability(),
    /**
     * Answer without touching the network.
     * @returns {Promise<{status:string, configured:boolean, network:boolean, reasons:string[]}>}
     */
    async check() {
      return {
        status: 'configuration_incomplete',
        configured: FIXED_QUOTA_TARGET.enabled === true,
        network: false,
        reasons: [...FIXED_QUOTA_TARGET.reasons],
      };
    },
  };
}

/**
 * Offline normalization helper used by tests and by any future verified
 * transport. It never performs I/O.
 * @param {object} input `{outerStatus, envelope, scopeKey, now, modelMappingVerified?, model?}`
 * @returns {object} a core-normalized snapshot
 */
export function normalizeOfflineSample(input) {
  return normalizeQuota(input);
}
