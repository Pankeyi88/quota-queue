import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeCtx } from './harness.mjs';

test('the artifact is a lazy factory under the local package id', () => {
  const loaded = loadClient();
  assert.equal(loaded.record.id, '@local/quota-queue');
  assert.equal(typeof loaded.record.factory, 'function');
  assert.equal(loaded.moduleExports.inject.join(','), 'slots,locale,connection,layout,uiWorkspace');
  assert.equal(typeof loaded.moduleExports.apply, 'function');
  assert.equal(typeof loaded.moduleExports.__internals.projectView, 'function');
});

test('apply registers only locale, panel, sidebar and existing-task status dock', () => {
  const loaded = loadClient();
  const harness = makeCtx();
  loaded.moduleExports.apply(harness.ctx);

  assert.equal(harness.localeDicts.length, 1);
  assert.equal(harness.localeDicts[0].ns, 'quota-queue');
  assert.deepEqual(Object.keys(harness.localeDicts[0].dicts).sort(), ['en', 'zh']);
  assert.deepEqual(Object.keys(harness.localeDicts[0].dicts.zh).sort(), Object.keys(harness.localeDicts[0].dicts.en).sort());

  assert.equal(harness.registrations.length, 3);
  const byName = {};
  for (const entry of harness.registrations) byName[entry.options.name] = entry;

  assert.ok(byName['main']);
  assert.equal(byName['main'].options.key, 'quota-queue');
  assert.equal(byName['main'].options.locale, 'quota-queue');
  assert.equal(typeof byName['main'].component, 'function');

  assert.ok(byName['sidebar.panellist']);
  assert.equal(byName['sidebar.panellist'].options.id, 'quota-queue');
  assert.equal(typeof byName['sidebar.panellist'].options.order, 'number');
  assert.equal(typeof byName['sidebar.panellist'].options.label, 'function');
  assert.equal(typeof byName['sidebar.panellist'].component, 'function');

  assert.ok(byName['conversation.composer.dock']);
  assert.equal(byName['conversation.composer.dock'].options.id, 'quota-queue.status');
  assert.equal(typeof byName['conversation.composer.dock'].options.order, 'number');
  assert.equal(typeof byName['conversation.composer.dock'].component, 'function');

  assert.equal(byName['conversation.input.right'], undefined);
  assert.equal(byName['shell.overlay'], undefined);
});

test('slot inject factories expose store and actions to components', () => {
  const loaded = loadClient();
  const harness = makeCtx();
  loaded.moduleExports.apply(harness.ctx);
  const main = harness.registrations.find((entry) => entry.options.name === 'main');
  assert.equal(typeof main.options.inject, 'function');
  const injected = main.options.inject();
  assert.equal(typeof injected.store.getSnapshot, 'function');
  assert.equal(typeof injected.store.subscribe, 'function');
  assert.equal(typeof injected.actions.addManual, 'function');
  assert.equal(typeof injected.actions.checkQuota, 'function');
  assert.equal(typeof injected.actions.setSessionOptIn, 'function');
  assert.equal(typeof injected.actions.requestStop, 'function');
  assert.equal(typeof injected.actions.openSession, 'function');
});

test('a sidebar label thunk follows the namespace translate at read time', () => {
  const loaded = loadClient();
  const harness = makeCtx();
  loaded.moduleExports.apply(harness.ctx);
  const entry = harness.registrations.find((candidate) => candidate.options.name === 'sidebar.panellist');
  assert.equal(entry.options.label(), 'panel.title');
});

test('disposing the owning effects removes registrations and listeners', () => {
  const loaded = loadClient();
  const harness = makeCtx();
  loaded.moduleExports.apply(harness.ctx);
  assert.equal(harness.registrations.length, 3);
  assert.equal(harness.listeners.get('connection/reset').size, 1);

  harness.disposeAll();

  for (const entry of harness.registrations) assert.equal(entry.disposed, true);
  assert.equal(harness.listeners.get('connection/reset').size, 0);
});

test('the artifact carries no browser storage, credential header, DOM injection or arbitrary fetch', () => {
  const loaded = loadClient();
  const source = loaded.source;
  const lower = source.toLowerCase();
  // Literal tokens that can only come from a forbidden capability.
  const forbidden = [
    'localStorage', 'sessionStorage', 'indexedDB',
    'document.createElement', 'document.body', 'iframe',
    'fetch(', 'XMLHttpRequest', 'setRequestHeader', 'Bearer ',
    'eval(', 'new Function', 'x-api-key', 'api-key', 'cookie:', 'proxy-authorization'
  ];
  for (const token of forbidden) {
    assert.equal(source.indexOf(token), -1, 'unexpected token in bundle: ' + token);
  }
  // Credential detection is header-shaped (a header NAME followed by ':') so it
  // cannot be satisfied by deleting user-facing copy such as "Authorization
  // denied", and cannot be defeated by that copy either.
  const headerMarkers = ['authorization:', "'authorization'", '"authorization"', 'credentials:'];
  for (const marker of headerMarkers) {
    assert.equal(lower.indexOf(marker), -1, 'unexpected credential marker in bundle: ' + marker);
  }
  // No request-building surface at all: the only transport is Connection RPC.
  assert.equal(lower.indexOf('headers:'), -1);
});
