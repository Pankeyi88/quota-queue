import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, renderElement, collectElements, makeT, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;
const EN = internals.dictionaries.en;
const t = makeT(EN);
const components = internals.components;
const actions = { refresh() {}, checkQuota() {}, setPaused() {}, openPanel() {}, openSession() {} };
const makeStore = (snapshot) => ({ getSnapshot: () => snapshot, subscribe: () => () => {} });
const snapshotFor = (view) => ({ phase: 'ready', view, error: null, notice: null, warning: null, pending: {}, sessions: [], hasTransport: true, lastUpdatedAt: 1, closed: false });
const propsFor = (view) => ({ t, store: makeStore(snapshotFor(view)), actions, sessionId: 's1' });
function expand(element) {
  if (Array.isArray(element)) return element.flatMap(expand);
  if (!element || typeof element !== 'object') return [];
  if (typeof element.type === 'function') return expand(element.type(element.props));
  return [element, ...expand(element.props?.children)];
}

test('the main panel keeps one status line and no legacy history section', () => {
  const view = validView();
  const out = renderElement(components.QuotaQueuePanel(propsFor(view)));
  assert.ok(out.includes('Existing task scheduling'));
  // The retired queue section is gone: its heading and empty-state copy no
  // longer appear anywhere in the panel.
  assert.equal(out.includes(EN['queue.heading']), false);
  assert.equal(out.includes(EN['queue.empty']), false);
  // The panel no longer repeats the subtitle above the title row.
  assert.equal(out.includes(EN['panel.subtitle']), false);
  // The removed explanation line never reappears anywhere in the panel.
  assert.equal(out.includes('recovers it when quota returns'), false);
  assert.equal(out.includes('Quota only for the opt-in session'), false);
  assert.equal(out.includes('Reserve message'), false);
  assert.equal(out.includes('New task'), false);
});

test('legacy rows never offer edit, cancel, stop or execution controls for any status', () => {
  const view = validView();
  for (const status of ['draft', 'queued', 'ready', 'running', 'needs_attention', 'completed']) {
    const tree = components.TaskRow({ t, task: { ...view.tasks[0], status, editable: true }, view, actions, pending: {} });
    const buttons = expand(tree).filter((node) => node.type === 'button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props['aria-label'], EN['action.openSession']);
    assert.ok(renderElement(tree).includes(EN['history.newSession']));
  }
});

test('the panel contains no task body entry, new-task form or edit form', () => {
  const elements = expand(components.QuotaQueuePanel(propsFor(validView())));
  // No free-text entry, form or dialog survives the reservation retirement.
  assert.equal(elements.filter((node) => ['input', 'textarea', 'form'].includes(node.type)).length, 0);
  assert.equal(elements.filter((node) => node.props.role === 'dialog').length, 0);
  // With no plan surface there is no free entry at all; the bounded
  // concurrency select appears only when the Host exposes a usable plan.
  assert.equal(elements.filter((node) => node.type === 'select').length, 0);
});

test('the panel shows the compiled runtime version for module-generation checks', () => {
  const view = internals.projectView(validView({ runtimeVersion: '0.2.0-dev.1' })).view;
  assert.ok(renderElement(components.QuotaQueuePanel(propsFor(view))).includes('Runtime 0.2.0-dev.1'));
  const old = internals.projectView(validView()).view;
  assert.ok(renderElement(components.QuotaQueuePanel(propsFor(old))).includes('Runtime unknown'));
});

test('an available plan exposes only the bounded concurrency select', () => {
  const view = validView({
    recoveryPlan: {
      available: true, editable: true, reason: null, revision: 4,
      maxConcurrent: 2, paused: false, batches: [], items: []
    }
  });
  const elements = expand(components.QuotaQueuePanel(propsFor(internals.projectView(view).view)));
  assert.equal(elements.filter((node) => ['input', 'textarea', 'form'].includes(node.type)).length, 0);
  const selects = elements.filter((node) => node.type === 'select');
  assert.equal(selects.length, 1);
  assert.equal(selects[0].props['aria-label'], EN['plan.concurrency']);
  assert.equal(selects[0].props.disabled, false);
  assert.equal(selects[0].props.value, '2');
  const options = selects[0].props.children;
  assert.equal(JSON.stringify(options.map((option) => option.props.value)), JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8']));
});

test('the composer switch is disabled without a mounted recovery consumer and never renders the removed copy', () => {
  const view = internals.projectView(validView({
    sessionOptIns: { s1: true },
    capabilities: { quotaCheck: false, execution: false, autoResume: false },
  })).view;
  const tree = components.QuotaQueueDockStatus(propsFor(view));
  const switches = expand(tree).filter((node) => node.props.role === 'switch');
  assert.equal(switches.length, 1);
  // Locked, but never lying about the persisted state.
  assert.equal(switches[0].props.disabled, true);
  assert.equal(switches[0].props['aria-checked'], 'true');
  assert.equal(switches[0].props.title, EN['recovery.unavailable']);
  const rendered = renderElement(tree);
  // The removed explanation (zh and en) never reaches the dock again.
  for (const dict of [internals.dictionaries.zh, internals.dictionaries.en]) {
    assert.equal(Object.hasOwn(dict, 'recovery.ready'), false);
    assert.equal(Object.hasOwn(dict, 'resume.hint'), false);
  }
  assert.equal(rendered.includes('quota on its current failed step'), false);
});

test('the composer switch and the plan item report one authorization state', () => {
  const on = internals.projectView(validView({ sessionOptIns: { s1: true } })).view;
  const off = internals.projectView(validView({ sessionOptIns: { s1: false } })).view;
  const dockSwitch = (view) => expand(components.QuotaQueueDockStatus(propsFor(view)))
    .find((node) => node.props.role === 'switch');
  assert.equal(dockSwitch(on).props['aria-checked'], 'true');
  assert.equal(dockSwitch(off).props['aria-checked'], 'false');

  // A planned session renders from the plan item, not from the legacy opt-in
  // map: the plan is the record both surfaces write.
  const planned = (authorizationEnabled, sessionOptIns) => internals.projectView(validView({
    sessionOptIns,
    recoveryPlan: {
      available: true, editable: true, reason: null, revision: 2, maxConcurrent: 1, paused: false,
      batches: [['plan-s1']],
      items: [{
        id: 'plan-s1', sessionId: 's1', title: 'Session one', workspacePath: 'E:/ws', batchIndex: 0,
        status: 'ready', paused: false, removed: false, skipped: false,
        authorizationEnabled, quotaScopeBound: authorizationEnabled, executionHeld: false,
        attempts: 0, reason: 'execution_capability_missing', blockers: [],
      }],
    },
  })).view;
  assert.equal(dockSwitch(planned(true, { s1: false })).props['aria-checked'], 'true');
  assert.equal(dockSwitch(planned(false, { s1: true })).props['aria-checked'], 'false');
  // An unbound scope cannot be switched on from either surface.
  const unbound = internals.projectView(validView({
    capabilities: { quotaCheck: true, execution: false, autoResume: true },
    quota: { configured: true, state: 'available', remaining: 90, weeklyRemaining: 90, fiveHourRemaining: 90, resetAt: null, observedAt: null, reasons: [] },
    sessionOptIns: { s1: false },
    recoveryPlan: {
      available: true, editable: true, reason: null, revision: 3, maxConcurrent: 1, paused: false,
      batches: [['plan-s1']],
      items: [{
        id: 'plan-s1', sessionId: 's1', title: 'Session one', workspacePath: 'E:/ws', batchIndex: 0,
        status: 'ready', paused: false, removed: false, skipped: false,
        authorizationEnabled: false, quotaScopeBound: false, executionHeld: false,
        attempts: 0, reason: 'execution_capability_missing', blockers: [],
      }],
    },
  })).view;
  const unboundSwitch = dockSwitch(unbound);
  // No scope in the View at all: the switch says exactly that, not a generic
  // "no scope is bound" claim about one item.
  assert.equal(unboundSwitch.props.title, EN['plan.scope.unavailable']);
  // There is no second switch on the plan surface any more: the same gate is
  // expressed by the plan's scope line, and the panel exposes no switch at all.
  const panel = components.QuotaQueuePanel(propsFor(unbound));
  assert.equal(expand(panel).filter((node) => node.props && node.props.role === 'switch').length, 0);
  assert.ok(renderElement(panel).includes(EN['plan.scope.unavailable']));
});

test('the composer dock reports the continuation state of THIS session only', () => {
  const at = new Date(2026, 10, 2, 21, 46, 0).getTime();
  const view = internals.projectView(validView({
    quotaScopeId: 'scope',
    quota: { configured: true, state: 'exhausted', remaining: 0, weeklyRemaining: 84, fiveHourRemaining: 0, resetAt: null, observedAt: null, reasons: [] },
    sessionOptIns: { s1: true },
    autoContinue: { enabled: true, owner: 'active', tickets: [
      { sessionId: 's1', state: 'waiting', reason: 'quota_waiting', failureClass: 'quota', attempt: 0, nextAt: at },
      { sessionId: 's2', state: 'waiting', reason: 'quota_waiting', failureClass: 'quota', attempt: 0, nextAt: at },
    ] },
  })).view;
  const snapshot = snapshotFor(view);
  const out = renderElement(components.QuotaQueueDockStatus({ t, store: makeStore(snapshot), actions, sessionId: 's1' }));
  assert.ok(out.includes(EN['continue.quotaWaiting'].replace('{time}', '21:46')), out);
  assert.equal(out.split('21:46').length - 1, 1, 'only this session line is rendered');
  // Another session's ticket is not shown for s1, and s3 has none at all.
  const other = renderElement(components.QuotaQueueDockStatus({ t, store: makeStore(snapshot), actions, sessionId: 's3' }));
  assert.equal(other.includes('21:46'), false);
  // A finished ticket is silent.
  const doneView = internals.projectView(validView({
    quotaScopeId: 'scope',
    sessionOptIns: { s1: true },
    autoContinue: { enabled: true, owner: 'active', tickets: [{ sessionId: 's1', state: 'done', reason: 'delivered', failureClass: 'quota', attempt: 0, nextAt: at }] },
  })).view;
  const doneOut = renderElement(components.QuotaQueueDockStatus({ t, store: makeStore(snapshotFor(doneView)), actions, sessionId: 's1' }));
  assert.equal(doneOut.includes('21:46'), false);
});

test('dispatch controls remain disabled pending the new Host scheduling contract', () => {
  const tree = components.QuotaQueuePanel(propsFor(validView()));
  const control = collectElements(tree).find((node) => node.props.label === EN['action.pauseDispatch']);
  assert.ok(control);
  assert.equal(control.props.disabled, true);
  assert.equal(control.props.title, EN['recovery.unavailable']);
});

test('quota check retains explicit capability gating while refresh remains usable', () => {
  const tree = components.QuotaQueuePanel(propsFor(validView({ capabilities: { quotaCheck: false, execution: true, autoResume: true } })));
  const elements = collectElements(tree);
  assert.equal(elements.find((node) => node.props.label === EN['action.checkQuota']).props.disabled, true);
  assert.notEqual(elements.find((node) => node.props.label === EN['action.refresh']).props.disabled, true);
});

test('the existing-task list is gone: the session switch is the only entry', () => {
  const view = validView({
    existingTasks: {
      available: true, reason: null,
      items: [{ sessionId: 'existing-1', title: 'Original task', workspacePath: 'E:/original', running: false, source: 'cached', asOfSeq: 8, selectable: false, reason: 'task_execution_identity_unverified' }],
    },
  });
  const out = renderElement(components.QuotaQueuePanel(propsFor(view)));
  // No list, no per-row add control, no read-only hint copy.
  assert.equal(out.includes('Original task'), false);
  assert.equal(out.includes('E:/original'), false);
  assert.equal(out.includes('existing-1'), false);
  assert.equal(out.split('Build the thing').length - 1, 0, 'legacy queue rows stay hidden');
});

test('the panel and dock retain warnings for an ambiguous transport outcome', () => {
  const snapshot = snapshotFor(validView());
  snapshot.warning = EN['notice.ambiguous'];
  for (const component of [components.QuotaQueuePanel, components.QuotaQueueDockStatus]) {
    const out = renderElement(component({ t, store: makeStore(snapshot), actions, sessionId: 's1' }));
    assert.ok(out.includes(EN['notice.ambiguous']));
  }
});

test('the no-view panel renders loading/errors and missing recovery contract reason', () => {
  const snapshot = snapshotFor(null);
  snapshot.phase = 'error';
  snapshot.error = { code: 'transport_error', message: 'transport_error' };
  const out = renderElement(components.QuotaQueuePanel({ t, store: makeStore(snapshot), actions }));
  assert.ok(out.includes(EN['panel.title']));
  assert.ok(out.includes(EN['error.transport_error']));
  assert.equal(out.includes('recovers it when quota returns'), false);
});

test('the sidebar icon renders an svg for the requested size', () => {
  const element = components.QuotaQueueIcon({ size: 18, active: true });
  assert.equal(element.type, 'svg');
  assert.equal(element.props.width, 18);
  assert.equal(element.props['aria-hidden'], true);
});
