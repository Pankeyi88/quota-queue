/**
 * quota-queue/host — the persistence port injected into the core QueueStore.
 *
 * The Host reuses the raw storage hub exactly as its public declaration
 * specifies: `ctx.storage.backend.get(name).kv.open(descriptor)`, then
 * `unit.loadAll()` / `unit.setGlobal(value)` / `unit.close()`.
 *
 * One KV unit (`quota_queue_v1`) carries the *whole* versioned queue snapshot
 * in its global singleton. A single `setGlobal` is atomic on the medium and
 * durable once it resolves, and the unit does not serialize concurrent writes,
 * so the core QueueStore owns the one in-process write chain.
 *
 * What this does NOT provide, and what the Host therefore never claims:
 *  - a compare-and-swap or transaction across records;
 *  - multi-process fencing. Opening the same unit name twice without closing
 *    is rejected by the backend, which is in-process exclusion evidence only.
 * Because exclusive execution ownership is unproven, this build keeps
 * `capabilities.execution` false and never dispatches a task.
 */
import { HostError } from './errors.js';
import { DEFAULT_STORAGE_BACKEND, STORAGE_UNIT_NAME, STORAGE_UNIT_VERSION, RECOVERY_PLAN_UNIT_NAME, RECOVERY_PLAN_UNIT_VERSION, CONTINUE_UNIT_NAME, CONTINUE_UNIT_VERSION } from './constants.js';

/**
 * Descriptor for the queue unit. `tables` is empty on purpose: the snapshot
 * lives in the global singleton, so nothing splits one logical commit across
 * records and no cross-record transaction is ever needed.
 */
export function recoveryPlanUnitDescriptor() {
  return { name: RECOVERY_PLAN_UNIT_NAME, version: RECOVERY_PLAN_UNIT_VERSION, tables: [], hasGlobal: true, layout: 'single' };
}

export function openQueueUnit(storage, options = {}) {
  return openUnit(storage, options, queueUnitDescriptor());
}

export function openRecoveryPlanUnit(storage, options = {}) {
  return openUnit(storage, options, recoveryPlanUnitDescriptor());
}

export function continueUnitDescriptor() {
  return { name: CONTINUE_UNIT_NAME, version: CONTINUE_UNIT_VERSION, tables: [], hasGlobal: true, layout: 'single' };
}

export function openContinueUnit(storage, options = {}) {
  return openUnit(storage, options, continueUnitDescriptor());
}

export function queueUnitDescriptor() {
  return {
    name: STORAGE_UNIT_NAME,
    version: STORAGE_UNIT_VERSION,
    tables: [],
    hasGlobal: true,
    layout: 'single',
  };
}

/**
 * Build the `{load, save}` port pair the core QueueStore consumes.
 * @param {{loadAll: Function, setGlobal: Function}} unit opened KV unit
 * @returns {{load: () => Promise<unknown>, save: (snapshot: object) => Promise<void>}}
 */
export function createKvUnitPorts(unit) {
  return {
    async load() {
      const snapshot = await unit.loadAll();
      const global = snapshot === null || snapshot === undefined ? null : snapshot.global;
      return global === undefined ? null : global;
    },
    async save(next) {
      await unit.setGlobal(next);
    },
  };
}

/**
 * Open the queue unit through the storage hub.
 * @param {unknown} storage the `ctx.storage` service, or undefined when absent
 * @param {{backendName?: string}} [options]
 * @returns {Promise<object>} the opened unit
 * @throws {HostError} configuration_incomplete when the hub/backend/facet is missing
 */
async function openUnit(storage, options, descriptor) {
  const backendName = typeof options.backendName === 'string' && options.backendName.length > 0
    ? options.backendName
    : DEFAULT_STORAGE_BACKEND;
  if (storage === undefined || storage === null || typeof storage !== 'object') {
    throw new HostError('configuration_incomplete', { missing: 'storage' });
  }
  const registry = storage.backend;
  if (registry === undefined || registry === null || typeof registry.get !== 'function') {
    throw new HostError('configuration_incomplete', { missing: 'storage.backend' });
  }
  let backend;
  try {
    backend = registry.get(backendName);
  } catch (error) {
    throw new HostError('configuration_incomplete', { missing: `storage backend ${backendName}` });
  }
  if (backend === undefined || backend === null) {
    throw new HostError('configuration_incomplete', { missing: `storage backend ${backendName}` });
  }
  if (backend.kv === undefined || backend.kv === null || typeof backend.kv.open !== 'function') {
    throw new HostError('configuration_incomplete', { missing: `kv facet of ${backendName}` });
  }
  try {
    return await backend.kv.open(descriptor);
  } catch (error) {
    // A duplicate open of the same unit name rejects: that is the in-process
    // single-owner guard, and it must fail the plugin loudly rather than let a
    // second scheduler run on the same snapshot.
    throw new HostError('configuration_incomplete', { op: 'storage.open', reason: 'unit unavailable or already open' });
  }
}
