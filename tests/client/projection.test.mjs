import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, validView } from './harness.mjs';

const internals = loadClient().moduleExports.__internals;

test('a valid Host view is projected to the whitelisted UI shape', () => {
  const result = internals.projectView(validView());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.view).sort(), ['autoContinue', 'capabilities', 'configuration', 'existingTasks', 'paused', 'quota', 'quotaScopeId', 'recoveryPlan', 'revision', 'routes', 'runtimeVersion', 'sessionOptIns', 'tasks', 'version', 'workspaces']);
  // No verified scope on this Host: reported as null, never invented.
  assert.equal(result.view.quotaScopeId, null);
  assert.equal(result.view.runtimeVersion, null);
  assert.equal(JSON.stringify(result.view.quota), JSON.stringify({
    configured: false, state: null, remaining: null, weeklyRemaining: null,
    fiveHourRemaining: null, resetAt: null, observedAt: null, reasons: []
  }));
  // A Host that predates the plan surface projects a fixed, unavailable shape.
  // (JSON comparison avoids cross-realm prototype identity in the vm harness.)
  assert.equal(JSON.stringify(result.view.recoveryPlan), JSON.stringify({
    available: false, editable: false, reason: 'recovery_plan_unavailable',
    revision: 0, maxConcurrent: 1, paused: true, batches: [], items: []
  }));
  assert.equal(result.view.tasks[0].provider, 'westlake-hpc');
  assert.equal(result.view.workspaces[0].path, 'E:/ws');
});

test('the compiled runtime version is projected read-only and bounded', () => {
  const good = internals.projectView(validView({ runtimeVersion: '0.2.0-dev.1' }));
  assert.equal(good.ok, true);
  assert.equal(good.view.runtimeVersion, '0.2.0-dev.1');
  for (const bad of [123, {}, 'x'.repeat(65), 'v\n1', ' 0.2.0', '0.2.0 ']) {
    assert.equal(internals.projectView(validView({ runtimeVersion: bad })).ok, false, JSON.stringify(bad));
  }
});

test('unknown Host members, including credentialRef and raw errors, are dropped', () => {
  const raw = validView();
  raw.credentialRef = 'secret-ref';
  raw.rawError = 'upstream said http://internal/token';
  raw.requestHeaders = { authorization: 'Bearer xyz' };
  raw.tasks[0].credentialRef = 'task-secret';
  raw.tasks[0].rawError = 'boom';
  const result = internals.projectView(raw);
  assert.equal(result.ok, true);
  const serialized = JSON.stringify(result.view);
  assert.equal(serialized.indexOf('secret-ref'), -1);
  assert.equal(serialized.indexOf('task-secret'), -1);
  assert.equal(serialized.indexOf('Bearer'), -1);
  assert.equal(serialized.indexOf('internal/token'), -1);
  assert.equal(serialized.indexOf('boom'), -1);
});

test('structural violations reject the whole payload instead of fabricating state', () => {
  assert.equal(internals.projectView(null).ok, false);
  assert.equal(internals.projectView(validView({ version: 2 })).ok, false);
  assert.equal(internals.projectView(validView({ revision: -1 })).ok, false);
  assert.equal(internals.projectView(validView({ revision: 1.5 })).ok, false);
  assert.equal(internals.projectView(validView({ paused: 'yes' })).ok, false);
  assert.equal(internals.projectView(validView({ configuration: null })).ok, false);
  assert.equal(internals.projectView(validView({ tasks: 'nope' })).ok, false);
  assert.equal(internals.projectView(validView({ workspaces: 'nope' })).ok, false);
  assert.equal(internals.projectView(validView({ routes: 'nope' })).ok, false);
});

test('autoContinue tickets are projected read-only, bounded and never fabricated', () => {
  const ticket = {
    sessionId: 's1', state: 'waiting', reason: 'quota_waiting', failureClass: 'quota',
    attempt: 0, nextAt: 1793600000000, deliveredTurn: null, code: 'QUOTA', turn: 3,
    status: null, prompt: 'must not cross the wire',
  };
  const good = internals.projectView(validView({ autoContinue: { enabled: true, owner: 'active', tickets: [ticket] } }));
  assert.equal(good.ok, true);
  assert.equal(good.view.autoContinue.enabled, true);
  assert.equal(good.view.autoContinue.owner, 'active');
  // JSON comparison avoids cross-realm prototype identity in the vm harness.
  assert.equal(JSON.stringify(Object.keys(good.view.autoContinue.tickets[0]).sort()),
    JSON.stringify(['attempt', 'failureClass', 'nextAt', 'reason', 'sessionId', 'state']));
  assert.equal(JSON.stringify(good.view).includes('must not cross'), false);

  // An older Host that omits the member is reported as disabled, not invented.
  const missing = internals.projectView(validView());
  assert.equal(missing.ok, true);
  assert.equal(missing.view.autoContinue.enabled, false);
  assert.equal(missing.view.autoContinue.owner, 'disabled');
  assert.equal(JSON.stringify(missing.view.autoContinue.tickets), '[]');

  // Structural violations reject the whole View instead of showing a fake queue.
  for (const bad of [null, [], { enabled: 'yes' }, { enabled: true, tickets: {} },
    { enabled: true, tickets: [{ sessionId: 's1', state: 'made_up' }] },
    { enabled: true, tickets: [{ sessionId: '', state: 'waiting' }] },
    { enabled: true, tickets: Array.from({ length: 21 }, () => ({ sessionId: 's1', state: 'waiting' })) }]) {
    assert.equal(internals.projectView(validView({ autoContinue: bad })).ok, false, JSON.stringify(bad));
  }
});

test('an unknown task status or kind rejects the view', () => {
  const badStatus = validView();
  badStatus.tasks[0].status = 'invented';
  assert.equal(internals.projectView(badStatus).ok, false);
  const badKind = validView();
  badKind.tasks[0].kind = 'invented';
  assert.equal(internals.projectView(badKind).ok, false);
});

test('capabilities can never become true from missing or non-boolean values', () => {
  const result = internals.projectView(validView({ capabilities: undefined }));
  assert.equal(result.ok, true);
  assert.equal(result.view.capabilities.quotaCheck, false);
  assert.equal(result.view.capabilities.execution, false);
  assert.equal(result.view.capabilities.autoResume, false);
  const result2 = internals.projectView(validView({ capabilities: { quotaCheck: 'yes', execution: 1, autoResume: {} } }));
  assert.equal(result2.view.capabilities.quotaCheck, false);
  assert.equal(result2.view.capabilities.execution, false);
  assert.equal(result2.view.capabilities.autoResume, false);
});

test('resume tasks never expose a prompt and long reasons are bounded', () => {
  const raw = validView();
  raw.tasks[0].kind = 'resume-session';
  raw.tasks[0].sessionId = 's1';
  raw.tasks[0].prompt = 'the original full task text';
  raw.tasks[0].reason = 'x'.repeat(5000);
  const result = internals.projectView(raw);
  assert.equal(result.ok, true);
  assert.equal(result.view.tasks[0].prompt, null);
  assert.ok(result.view.tasks[0].reason.length <= 160);
});

test('configuration reasons are capped and control characters removed', () => {
  const raw = validView({ configuration: { ready: false, reasons: ['a\u0000b', 'c\nd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] } });
  const result = internals.projectView(raw);
  assert.equal(result.ok, true);
  assert.ok(result.view.configuration.reasons.length <= 8);
  for (const reason of result.view.configuration.reasons) {
    assert.equal(reason.indexOf('\u0000'), -1);
    assert.equal(reason.indexOf('\n'), -1);
  }
  assert.equal(internals.projectView(validView({ configuration: { ready: true, reasons: [1] } })).ok, false);
});

test('session opt-ins keep only literal true entries', () => {
  const raw = validView({ sessionOptIns: { s1: true, s2: false, s3: 'yes', s4: 1 } });
  const result = internals.projectView(raw);
  assert.equal(result.view.sessionOptIns.s1, true);
  assert.equal(Object.keys(result.view.sessionOptIns).length, 1);
});

test('buildRequest rejects non-whitelisted fields and missing required fields', () => {
  assert.equal(internals.buildRequest('cancelQueued', { id: 't1' }, 'id1').ok, true);
  assert.equal(internals.buildRequest('cancelQueued', { id: 't1', url: 'http://x' }, 'id1').ok, false);
  assert.equal(internals.buildRequest('cancelQueued', {}, 'id1').ok, false);
  assert.equal(internals.buildRequest('pauseDispatch', { paused: 'yes' }, 'id1').ok, false);
  assert.equal(internals.buildRequest('checkQuota', {}, 'id1').ok, true);
  assert.equal(internals.buildRequest('checkQuota', { extra: 1 }, 'id1').ok, false);
  for (const op of ['invented', 'constructor', '__proto__', 'toString']) assert.equal(internals.buildRequest(op, {}, 'id1').ok, false);
  const built = internals.buildRequest('bootstrap', {}, 'id1');
  assert.equal(built.request.version, 1);
  assert.equal(built.request.op, 'bootstrap');
  assert.equal(built.request.requestId, 'id1');
  assert.equal(Object.keys(built.request.payload).length, 0);
});

test('manual title and prompt survive verbatim, never sanitized or truncated', () => {
  const raw = validView();
  raw.tasks[0].title = 'Line one\nLine two';
  raw.tasks[0].prompt = 'first\nsecond\tthird  ';
  const result = internals.projectView(raw);
  assert.equal(result.ok, true);
  assert.equal(result.view.tasks[0].title, 'Line one\nLine two');
  assert.equal(result.view.tasks[0].prompt, 'first\nsecond\tthird  ');
  assert.equal(result.view.tasks[0].promptOverflow, false);
});

test('an over-long manual prompt is kept and flagged read-only, not silently sliced', () => {
  const raw = validView();
  raw.tasks[0].prompt = 'x'.repeat(20001);
  const result = internals.projectView(raw);
  assert.equal(result.ok, true);
  assert.equal(result.view.tasks[0].prompt.length, 20001);
  assert.equal(result.view.tasks[0].promptOverflow, true);
  assert.equal(internals.canEditTask(result.view.tasks[0]), false);
});

test('buildRequest refuses an over-long field instead of truncating it', () => {
  const built = internals.buildRequest('bootstrap', { sessionId: 'x'.repeat(20001) }, 'id1');
  assert.equal(built.ok, false);
  assert.equal(built.error.code, 'invalid_input');
  const ok = internals.buildRequest('bootstrap', { sessionId: 'x'.repeat(20000) }, 'id1');
  assert.equal(ok.ok, true);
  assert.equal(ok.request.payload.sessionId.length, 20000);
});

test('editability is retired for every legacy task, including a fresh unstarted row', () => {
  const base = { kind: 'new-session', status: 'queued', attempts: 0, editable: null, promptOverflow: false };
  assert.equal(internals.canEditTask(base), false);
  assert.equal(internals.canEditTask(Object.assign({}, base, { attempts: 1 })), false);
  assert.equal(internals.canEditTask(Object.assign({}, base, { editable: false })), false);
  assert.equal(internals.canEditTask(Object.assign({}, base, { status: 'running' })), false);
  assert.equal(internals.canEditTask(Object.assign({}, base, { kind: 'resume-session' })), false);
  assert.equal(internals.canEditTask(Object.assign({}, base, { promptOverflow: true })), false);
});

test('error codes outside the whitelist collapse to request_failed', () => {
  assert.equal(internals.normalizeErrorCode('CONFIGURATION_INCOMPLETE'), 'configuration_incomplete');
  assert.equal(internals.normalizeErrorCode('token_revoked'), 'request_failed');
  assert.equal(internals.normalizeErrorCode(undefined), 'request_failed');
});
