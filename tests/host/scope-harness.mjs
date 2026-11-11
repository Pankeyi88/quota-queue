/**
 * The real host harness, plus the deployment's ONE fixed quota scope.
 *
 * `createFakeStorage` returns a backend whose single `kv` object is shared by
 * every unit it opens. The real Host opens the queue and the recovery plan in
 * two SEPARATE units, so opening a second one must hand back an independent
 * unit (same persisted map, own save counter). This wrapper only fixes that
 * fidelity gap; everything else is the shared harness.
 */
export * from './harness.mjs';
import { createSession as realSession, createFakeStorage as realStorage, ROUTE as REAL_ROUTE } from './harness.mjs';

export const ROUTE = REAL_ROUTE;
export const FIXED_SCOPE = 'cpamc:codex:test-auth-index';

export function createFakeStorage(options = {}) {
  const state = realStorage(options);
  const kv = state.kv;
  const openers = new Map();
  const open = kv.open;
  kv.open = async function openUnit(descriptor) {
    const previous = openers.get(descriptor.name);
    if (previous === undefined) {
      const first = await open(descriptor);
      openers.set(descriptor.name, first);
      return first;
    }
    // A second open of the same unit name while it is held is a real conflict.
    if (state.state.active.get(descriptor.name) > 0) return open(descriptor);
    const first = openers.get(descriptor.name);
    return first;
  };
  return state;
}

/** A Host whose quota source is bound to the deployment's fixed scope. */
export function withFixedScope(config = {}) {
  return {
    ...config,
    quotaSource: {
      kind: 'cpamc',
      baseUrl: 'https://cpa.example.com',
      managementKeyEnv: 'CPAMC_MANAGEMENT_KEY',
      authIndex: 'test-auth-index',
      weeklyMinRemaining: 10,
      fiveHourMinRemaining: 0,
      ...(config.quotaSource === undefined ? {} : config.quotaSource),
    },
  };
}
