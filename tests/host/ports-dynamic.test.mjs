/**
 * The workspace-registry port resolves per call.
 *
 * The P3 defect: the Host captured `ctx.get('workspaceRegistry')` once during
 * activation. `@deepseek-ai/dsh-workspace`'s registry completes a
 * `Service.init` that awaits session persistence, so at activation it can
 * still be inactive and `ctx.get` returns `undefined`; the one-shot read then
 * latched `workspace_registry_unavailable` for the whole process lifetime.
 *
 * These are direct unit tests of `createHostPorts`: the resolver is the only
 * thing that varies, and every outcome must follow the CURRENT value.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostPorts } from '../../host/ports.js';

/** A registry whose entries are fixed. */
function registryOf(entries) {
  const map = new Map(entries.map((entry) => [entry.id, entry]));
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

/** One registry entity shaped like the real projection surface. */
function entity(id, path, title, status = 'ok') {
  return { id, path, title, status: async () => status };
}

/** A mutable resolver the test can steer. */
function holder(initial) {
  const box = { value: initial };
  return { resolve: () => box.value, set: (value) => { box.value = value; } };
}

const OFFLINE_BRIDGE = { async check() { return { status: 'configuration_incomplete', configured: false, reasons: ['stub'] }; } };

test('a registry that appears after construction is used without re-creating the ports', async () => {
  const box = holder(undefined);
  const ports = createHostPorts({ resolveWorkspaceRegistry: box.resolve, quotaBridge: OFFLINE_BRIDGE });

  assert.equal(ports.workspaceRegistryAvailable, false);
  assert.deepEqual(await ports.listWorkspaces(), []);
  assert.equal(await ports.getWorkspace('ws-1'), null);

  box.set(registryOf([entity('ws-1', 'E:/ws/one', 'one')]));

  assert.equal(ports.workspaceRegistryAvailable, true);
  const list = await ports.listWorkspaces();
  assert.deepEqual(list, [{ id: 'ws-1', name: 'one', path: 'E:/ws/one', available: true }]);
  assert.equal((await ports.getWorkspace('ws-1')).name, 'one');
});

test('a registry that is removed and restored is observed both times', async () => {
  const box = holder(registryOf([entity('ws-1', 'E:/ws/one', 'one')]));
  const ports = createHostPorts({ resolveWorkspaceRegistry: box.resolve, quotaBridge: OFFLINE_BRIDGE });
  assert.equal(ports.workspaceRegistryAvailable, true);

  box.set(undefined);
  assert.equal(ports.workspaceRegistryAvailable, false);
  assert.deepEqual(await ports.listWorkspaces(), []);
  assert.equal(await ports.getWorkspace('ws-1'), null);

  box.set(registryOf([entity('ws-1', 'E:/ws/one', 'one')]));
  assert.equal(ports.workspaceRegistryAvailable, true);
  assert.equal((await ports.listWorkspaces()).length, 1);
  assert.equal((await ports.getWorkspace('ws-1')).id, 'ws-1');
});

test('a replaced registry is read, never the previous instance', async () => {
  const box = holder(registryOf([entity('ws-old', 'E:/ws/old', 'old')]));
  const ports = createHostPorts({ resolveWorkspaceRegistry: box.resolve, quotaBridge: OFFLINE_BRIDGE });
  assert.equal((await ports.listWorkspaces())[0].id, 'ws-old');

  box.set(registryOf([entity('ws-new', 'E:/ws/new', 'new')]));

  const list = await ports.listWorkspaces();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ws-new');
  assert.equal(await ports.getWorkspace('ws-old'), null);
  assert.equal((await ports.getWorkspace('ws-new')).path, 'E:/ws/new');
});

test('an unusable resolver result is unavailable, never an error', async () => {
  const unusable = [undefined, null, 0, 'registry', true, {}, { list() {} }, { get() {} }, { list: 1, get: 2 }];
  for (const value of unusable) {
    const ports = createHostPorts({ resolveWorkspaceRegistry: () => value, quotaBridge: OFFLINE_BRIDGE });
    assert.equal(ports.workspaceRegistryAvailable, false);
    assert.deepEqual(await ports.listWorkspaces(), []);
    assert.equal(await ports.getWorkspace('ws-1'), null);
  }
  const throwing = createHostPorts({
    resolveWorkspaceRegistry: () => { throw new Error('resolver failed'); },
    quotaBridge: OFFLINE_BRIDGE,
  });
  assert.equal(throwing.workspaceRegistryAvailable, false);
  assert.deepEqual(await throwing.listWorkspaces(), []);
  assert.equal(await throwing.getWorkspace('ws-1'), null);
});

test('a registry whose own list/get throw degrades to empty and null', async () => {
  const ports = createHostPorts({
    resolveWorkspaceRegistry: () => ({
      list() { throw new Error('registry list failed'); },
      get() { throw new Error('registry get failed'); },
    }),
    quotaBridge: OFFLINE_BRIDGE,
  });
  assert.equal(ports.workspaceRegistryAvailable, true);
  assert.deepEqual(await ports.listWorkspaces(), []);
  assert.equal(await ports.getWorkspace('ws-1'), null);
});

test('malformed entities are skipped, and a failing status is not available', async () => {
  const entities = [
    entity('ws-ok', 'E:/ws/ok', 'ok'),
    entity('ws-gone', 'E:/ws/gone', 'gone', 'missing-dir'),
    entity('ws-throws', 'E:/ws/throws', 'throws', 'throw'),
    { id: 7, path: 'E:/ws/bad' },
    { id: 'ws-nopath' },
    null,
  ];
  const ports = createHostPorts({
    resolveWorkspaceRegistry: () => ({
      list: () => entities,
      get: (id) => entities.find((entry) => entry !== null && typeof entry === 'object' && entry.id === id),
    }),
    quotaBridge: OFFLINE_BRIDGE,
  });
  const list = await ports.listWorkspaces();
  assert.deepEqual(list.map((workspace) => [workspace.id, workspace.available]), [
    ['ws-ok', true],
    ['ws-gone', false],
    ['ws-throws', false],
  ]);
  assert.equal((await ports.getWorkspace('ws-gone')).available, false);
  assert.equal(await ports.getWorkspace(''), null);
});

test('checkQuota delegates to the bridge and a missing resolver stays safe', async () => {
  let calls = 0;
  const ports = createHostPorts({
    quotaBridge: { async check() { calls += 1; return { status: 'configuration_incomplete', configured: false, reasons: ['stub'] }; } },
  });
  assert.equal(ports.workspaceRegistryAvailable, false);
  const result = await ports.checkQuota();
  assert.equal(calls, 1);
  assert.equal(result.configured, false);
  assert.deepEqual(await ports.listWorkspaces(), []);
  assert.equal(await ports.getWorkspace('ws-1'), null);
});
