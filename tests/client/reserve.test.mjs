import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeCtx, makeT, renderElement, collectElements, validView } from './harness.mjs';

const loaded = loadClient();
const internals = loaded.moduleExports.__internals;
const t = makeT(internals.dictionaries.en);

function controllerWith(call = async () => ({ ok: true, value: { ok: true, data: validView() } }), services = {}) {
  const calls = [];
  const harness = makeCtx({ services, connection: { rpc: { call: (...args) => { calls.push(args); return call(...args); } } } });
  const controller = internals.createController(harness.ctx, { t, now: () => 1000 });
  return { controller, calls, harness };
}

// These replace reservation behavior tests with explicit retirement guarantees.
test('reservation components, facts, focus trap and constants are no longer exposed', () => {
  for (const key of ['ReserveMessageButton', 'ReserveMessageDialog', 'ReserveForm', 'EditForm']) assert.equal(internals.components[key], undefined, key);
  for (const key of ['reserveFacts', 'reserveVisibility', 'reserveBlockReason', 'reserveBlockText', 'reserveErrorText', 'createFocusTrap', 'nextFocusIndex', 'firstLineOf', 'autoExecuteState', 'workspaceChoices', 'routeChoices']) assert.equal(internals[key], undefined, key);
  for (const key of ['RESERVE_BUTTON_ID', 'RESERVE_DIALOG_ID']) assert.equal(internals.constants[key], undefined);
});

test('no reservation action or reservation state survives controller creation, start or disposal', async () => {
  const { controller } = controllerWith();
  for (const name of ['openReserve', 'closeReserve', 'updateReserveForm', 'submitReserve']) assert.equal(controller.actions[name], undefined, name);
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'reserve'), false);
  controller.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'reserve'), false);
  controller.dispose();
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'reserve'), false);
});

test('retired addManual and editPending return capability_missing and send zero requests', async () => {
  const { controller, calls } = controllerWith();
  const before = controller.getSnapshot();
  for (const op of ['addManual', 'editPending']) {
    const result = await controller.actions[op]({ id: 'old', title: 'x', prompt: 'do not send', workspaceId: 'w', routeId: 'r', autoExecute: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capability_missing');
  }
  assert.equal(calls.length, 0);
  assert.equal(controller.getSnapshot(), before);
});

test('retired actions do not even inspect an old caller payload', async () => {
  const built = controllerWith();
  const poisoned = new Proxy({}, { get() { throw new Error('retired payload read'); }, ownKeys() { throw new Error('retired payload enumerated'); } });
  for (const op of ['addManual', 'editPending']) assert.equal((await built.controller.actions[op](poisoned)).error.code, 'capability_missing');
  assert.equal(built.calls.length, 0);
});

test('buildRequest refuses retired operations for valid, malformed and poison payloads', () => {
  const poisoned = new Proxy({}, { get() { throw new Error('must not inspect'); }, ownKeys() { throw new Error('must not enumerate'); } });
  for (const op of ['addManual', 'editPending']) {
    for (const payload of [{ title: 'T', prompt: 'P', workspaceId: 'w', routeId: 'r', autoExecute: false }, {}, null, poisoned]) {
      const result = internals.buildRequest(op, payload, 'id');
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'capability_missing');
      assert.equal(Object.hasOwn(result, 'request'), false);
    }
  }
});

test('session opt-in is a plain boolean; authority stays on the Host', async () => {
  const built = controllerWith();
  await built.controller.actions.refresh();
  built.calls.length = 0;
  for (const enabled of ['yes', undefined, null]) {
    assert.equal(internals.buildRequest('setSessionOptIn', { sessionId: 's1', enabled }, 'id').error.code, 'invalid_input');
  }
  assert.equal(built.calls.length, 0);
  await built.controller.actions.setSessionOptIn('s1', true);
  assert.equal(built.calls.length, 1, 'enabling must reach the transport');
  assert.equal(built.calls[0][2].args.request.payload.enabled, true);
  const request = internals.buildRequest('setSessionOptIn', { sessionId: 's1', enabled: true }, 'id');
  assert.equal(request.ok, true);
  assert.equal(request.request.payload.enabled, true);
});

test('explicit revocation still uses the supported old API and never enables authorization', async () => {
  const built = controllerWith();
  assert.equal((await built.controller.actions.setSessionOptIn('s1', false)).ok, true);
  assert.equal(built.calls.length, 1);
  const request = built.calls[0][2].args.request;
  assert.equal(request.op, 'setSessionOptIn');
  assert.equal(request.payload.enabled, false);
});

test('apply never registers composer input or overlay seats', () => {
  const harness = makeCtx();
  loaded.moduleExports.apply(harness.ctx);
  assert.deepEqual(harness.registrations.map((x) => x.options.name), ['main', 'sidebar.panellist', 'conversation.composer.dock']);
  harness.disposeAll();
});

test('draft, attachment and reference data are never read, written or submitted', async () => {
  let reads = 0;
  let writes = 0;
  let scopes = 0;
  const draft = 'line one\nline two\tend  ';
  const input = new Proxy({ draft }, {
    get() { reads += 1; throw new Error('composer read'); },
    set() { writes += 1; throw new Error('composer write'); }
  });
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { displayTitle: 'Existing', running: false } } }), subscribe: () => () => {} },
      scope() { scopes += 1; throw new Error('session scope requested'); }
    },
    get conversation() { reads += 1; return { input }; }
  };
  const built = controllerWith(undefined, services);
  built.controller.start();
  await built.controller.actions.refresh();
  for (const op of ['addManual', 'editPending']) await built.controller.actions[op]({ prompt: draft });
  const snapshot = built.controller.getSnapshot();
  const props = { t, store: built.controller.store, actions: built.controller.actions, sessionId: 's1', useInput() { reads += 1; throw new Error('input hook'); } };
  renderElement(internals.components.QuotaQueuePanel(props));
  renderElement(internals.components.QuotaQueueDockStatus(props));
  built.controller.dispose();
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(scopes, 0);
  assert.equal(JSON.stringify(snapshot).includes(draft), false);
  assert.ok(built.calls.every((args) => args[2].args.request.op === 'bootstrap'));
});

test('legacy row has only a navigation action even when status and capabilities suggest execution', () => {
  const view = validView();
  for (const status of ['draft', 'queued', 'ready', 'running', 'needs_attention']) {
    const task = { ...view.tasks[0], status, editable: true };
    const tree = internals.components.TaskRow({ t, task, view, actions: { openSession() {} }, pending: {} });
    const controls = collectElements(tree).filter((node) => node.props && typeof node.props.onClick === 'function');
    assert.equal(controls.length, 1);
    assert.equal(controls[0].props.label, internals.dictionaries.en['action.openSession']);
    assert.ok(renderElement(tree).includes(internals.dictionaries.en['history.newSession']));
  }
});

test('retired form and composer APIs are absent from the actual artifact', () => {
  for (const token of ['openReserve', 'submitReserve', 'updateReserveForm', 'ReserveForm', 'EditForm', 'conversation.input.right', 'shell.overlay', 'conversation.input', 'draftRev', 'attachmentIds', 'occurrences', 'document.activeElement']) assert.equal(loaded.source.includes(token), false, token);
  for (const dict of Object.values(internals.dictionaries)) {
    assert.equal(Object.keys(dict).some((key) => key.startsWith('reserve.') || key.startsWith('form.')), false);
    assert.equal(dict['panel.reserveGuide'], undefined);
  }
});

test('a late successful response after disposal cannot publish a newer view', async () => {
  let release;
  const built = controllerWith(() => new Promise((resolve) => { release = resolve; }));
  const pending = built.controller.actions.refresh();
  built.controller.dispose();
  const snapshot = built.controller.getSnapshot();
  release({ ok: true, value: { ok: true, data: validView({ revision: 99 }) } });
  assert.equal((await pending).error.code, 'closed');
  assert.equal(built.controller.getSnapshot(), snapshot);
  assert.equal(snapshot.view, null);
  assert.equal(Object.keys(snapshot.pending).length, 0);
});

test('late failed responses after disposal do not publish errors or warnings', async () => {
  let release;
  const built = controllerWith(() => new Promise((resolve) => { release = resolve; }));
  const pending = built.controller.actions.refresh();
  built.controller.dispose();
  const snapshot = built.controller.getSnapshot();
  release({ ok: true, value: { ok: false, error: { code: 'internal', message: 'secret' } } });
  assert.equal((await pending).error.code, 'closed');
  assert.equal(built.controller.getSnapshot(), snapshot);
});
