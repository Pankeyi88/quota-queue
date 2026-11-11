/**
 * Remote-invocation guards: the Host must refuse anything that is not a sound,
 * admitted Remote call, and must not treat a model-supplied field as authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvocation, createSession, createFakeStorage, seededSnapshot, seedTask } from './harness.mjs';

const REQUEST = { version: 1, op: 'bootstrap', requestId: 'guard-1', payload: {} };

test('a call without a Remote invocation is refused', async () => {
  const session = await createSession();
  const result = await session.dispatchRaw(REQUEST, { invocation: null });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not_remote');
});

test('the invocation must name this service, namespace and method', async () => {
  const session = await createSession();
  const cases = [
    createInvocation({ service: 'otherService', args: { request: REQUEST } }),
    createInvocation({ namespace: 'otherNamespace', args: { request: REQUEST } }),
    createInvocation({ method: 'list', args: { request: REQUEST } }),
  ];
  for (const invocation of cases) {
    const result = await session.dispatchRaw(REQUEST, { invocation });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_invocation');
  }
});

test('the invocation args must be exactly {request}', async () => {
  const session = await createSession();
  for (const args of [{}, { request: REQUEST, extra: 1 }, { request: REQUEST, other: REQUEST }]) {
    const result = await session.dispatchRaw(REQUEST, { invocation: createInvocation({ args }) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_invocation');
  }
});

test('the invocation peer and signal must both be sound', async () => {
  const session = await createSession();
  const badPeer = createInvocation({ args: { request: REQUEST } });
  badPeer.peer = null;
  assert.equal((await session.dispatchRaw(REQUEST, { invocation: badPeer })).error.code, 'invalid_invocation');

  const emptyId = createInvocation({ args: { request: REQUEST } });
  emptyId.peer = { id: '' };
  assert.equal((await session.dispatchRaw(REQUEST, { invocation: emptyId })).error.code, 'invalid_invocation');

  const noSignal = createInvocation({ args: { request: REQUEST } });
  delete noSignal.signal;
  assert.equal((await session.dispatchRaw(REQUEST, { invocation: noSignal })).error.code, 'invalid_invocation');
});

test('an already-aborted carrier is refused as cancelled', async () => {
  const session = await createSession();
  const controller = new AbortController();
  controller.abort();
  const invocation = createInvocation({ args: { request: REQUEST }, signal: controller.signal });
  const result = await session.dispatchRaw(REQUEST, { invocation });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cancelled');
});

test('cancellation through the injected signal parameter is refused', async () => {
  const session = await createSession();
  const controller = new AbortController();
  // The operator gate runs first, so this carrier must belong to the operator
  // peer to reach the signal check at all.
  const invocation = createInvocation({ args: { request: REQUEST }, peer: session.operatorPeer });
  controller.abort();
  const result = await session.dispatchRaw(REQUEST, {
    invocation,
    signal: new AbortController().signal,
    signalParameter: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cancelled');
});

test('every operation is operator-gated, including reads and resume', async () => {
  const id = 'legacy-task';
  const session = await createSession({ storage: createFakeStorage({
    initialGlobal: seededSnapshot([seedTask({ id })]),
  }) });
  const other = { id: 'someone-else' };

  // A stored historical reservation is a real target, but cannot be edited or
  // activated. The operator gate must still run before the retirement guard.

  const gatedCalls = [
    ['bootstrap', {}],
    ['addManual', { prompt: 'p', workspaceId: 'ws-1', routeId: 'codex-common' }],
    ['editPending', { id, prompt: 'changed' }],
    ['cancelQueued', { id }],
    ['pauseDispatch', { paused: true }],
    ['pauseDispatch', { paused: false }],
    ['setSessionOptIn', { sessionId: 's-1', enabled: false }],
    ['checkQuota', {}],
    ['requestStop', { id }],
    // Every plan mutation is operator-gated before identity or storage work.
    ['planAdd', { sessionId: 's-a', batch: 0, expectedRevision: 0 }],
    ['planConfigure', { maxConcurrent: 2, expectedRevision: 0 }],
    ['planPause', { paused: true, expectedRevision: 0 }],
    ['planItemPause', { id: 'plan-x', paused: true, expectedRevision: 0 }],
    ['planRemove', { id: 'plan-x', expectedRevision: 0 }],
    ['planSkip', { id: 'plan-x', confirmed: true, expectedRevision: 0 }],
    ['planMove', { id: 'plan-x', batch: 0, position: 0, expectedRevision: 0 }],
  ];
  for (const [op, payload] of gatedCalls) {
    const result = await session.call(op, payload, { peer: other });
    assert.equal(result.ok, false, `${op} must be refused for a non-operator peer`);
    assert.equal(result.error.code, 'operator_required', `${op} wrong code`);
  }

  // The refusals changed nothing.
  const view = (await session.call('bootstrap', {})).data;
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].status, 'queued');
  assert.equal(view.paused, false);

  // Authority comes from the Peer principal fixed by the connection layer.
  // A non-owner principal is refused even with a well-formed invocation.
  const notOwner = await createSession();
  const refused = await notOwner.call('bootstrap', {}, { peer: { id: 'guest-peer', principal: { kind: 'guest' } } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'operator_required');
});

test('a model-supplied actor or role field is never consulted as authority', async () => {
  const session = await createSession();
  // Even from the real operator peer, a forged authority field is a payload
  // violation, not something the Host honours.
  const forged = await session.call('setSessionOptIn', {
    sessionId: 's-1',
    enabled: true,
    actor: 'user',
    role: 'operator',
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, 'invalid_request');

  // From any other peer the same forged claim grants nothing.
  const other = { id: 'someone-else' };
  const refused = await session.call(
    'setSessionOptIn',
    { sessionId: 's-1', enabled: true, actor: 'user', role: 'operator' },
    { peer: other },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'operator_required');
});

test('the service exposes exactly one Remote-marked method', async () => {
  const session = await createSession();
  const marks = session.protocol.marks;
  assert.equal(marks.length, 1);
  assert.equal(marks[0].context.name, 'dispatch');
  assert.equal(marks[0].context.static, false);
  assert.equal(marks[0].context.private, false);
  assert.equal(marks[0].context.kind, 'method');
  // The initializer ran against the class prototype, exactly as the public
  // protocol expects.
  assert.equal(session.protocol.initializers.length, 1);
  // Source-mode discovery parses the signature: request and signal only.
  const source = Function.prototype.toString.call(Object.getPrototypeOf(session.service).dispatch);
  const open = source.indexOf('(');
  const close = source.indexOf(')', open + 1);
  const params = source.slice(open + 1, close).split(',').map((part) => part.trim());
  assert.deepEqual(params, ['request', 'signal']);
});

test('the service has no private class members, which Cordis contextual proxies cannot reach', async () => {
  const session = await createSession();
  const prototype = Object.getPrototypeOf(session.service);
  const own = Reflect.ownKeys(session.service).map(String);
  // State is one non-enumerable own property; the instance surface stays tidy.
  assert.ok(own.includes('_state'));
  assert.equal(Object.keys(session.service).includes('_state'), false);
  assert.equal(typeof Object.getOwnPropertyDescriptor(session.service, '_state').value, 'object');
  for (const name of ['init', 'dispatch', 'dispose', '_doInit', '_doDispose']) {
    assert.equal(typeof prototype[name], 'function');
  }
  const source = Function.prototype.toString.call(prototype.dispatch)
    + Function.prototype.toString.call(prototype.init)
    + Function.prototype.toString.call(prototype.dispose)
    + Function.prototype.toString.call(prototype._doInit)
    + Function.prototype.toString.call(prototype._doDispose);
  // A real private member is an access (this.#x) or a declaration (#x =).
  const privateMember = /(^|[^A-Za-z0-9_])this\.#[A-Za-z_]|^\s*#[A-Za-z_]\w*\s*[=;(]/m;
  assert.equal(privateMember.test(source), false, 'a private member would break under the Gateway proxy');
});
