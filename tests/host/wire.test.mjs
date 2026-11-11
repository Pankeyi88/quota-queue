/**
 * Envelope, payload and configuration validation.
 *
 * These tests exercise the real `host/wire.js` and `host/config.js` against
 * fake inputs. No host is involved.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, parseConfig } from '../../host/config.js';
import { HostError } from '../../host/errors.js';
import { parsePayload, parseRequest } from '../../host/wire.js';
import { CREDENTIAL_REF, ROUTE, ROUTE_B } from './harness.mjs';

const envelope = (over = {}) => ({ version: 1, op: 'bootstrap', requestId: 'r1', payload: {}, ...over });

function expectHostCode(fn, code) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HostError, `expected a HostError, got ${String(caught)}`);
  assert.equal(caught.code, code);
}

test('parseRequest accepts a well-formed envelope', () => {
  const parsed = parseRequest(envelope({ op: 'addManual', payload: { prompt: 'p' } }));
  assert.deepEqual(Object.keys(parsed).sort(), ['op', 'payload', 'requestId', 'version']);
  assert.equal(parsed.op, 'addManual');
  assert.equal(parsed.requestId, 'r1');
});

test('parseRequest refuses malformed envelopes', () => {
  expectHostCode(() => parseRequest(null), 'invalid_request');
  expectHostCode(() => parseRequest([]), 'invalid_request');
  expectHostCode(() => parseRequest('bootstrap'), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ version: 2 })), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ version: '1' })), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ requestId: '' })), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ requestId: 'has space' })), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ requestId: 'x'.repeat(129) })), 'invalid_request');
  expectHostCode(() => parseRequest(envelope({ payload: null })), 'invalid_request');
  expectHostCode(() => parseRequest({ ...envelope(), extra: true }), 'invalid_request');
  const missing = envelope();
  delete missing.payload;
  expectHostCode(() => parseRequest(missing), 'invalid_request');
});

test('parseRequest refuses an unsupported operation', () => {
  expectHostCode(() => parseRequest(envelope({ op: 'setCapability' })), 'unknown_op');
  expectHostCode(() => parseRequest(envelope({ op: 'dispatch' })), 'unknown_op');
  expectHostCode(() => parseRequest(envelope({ op: '' })), 'unknown_op');
});

test('parsePayload enforces the per-op whitelist', () => {
  const good = parsePayload('addManual', {
    title: 'T',
    prompt: 'p',
    workspaceId: 'ws-1',
    routeId: ROUTE.id,
    autoExecute: false,
  });
  assert.deepEqual(Object.keys(good).sort(), ['autoExecute', 'prompt', 'routeId', 'title', 'workspaceId']);

  expectHostCode(() => parsePayload('addManual', { prompt: 'p', workspaceId: 'w', routeId: 'r', nope: 1 }), 'invalid_request');
  expectHostCode(() => parsePayload('bootstrap', { sessionId: 7 }), 'invalid_request');
  expectHostCode(() => parsePayload('bootstrap', { sessionId: 'x'.repeat(201) }), 'invalid_request');
  expectHostCode(() => parsePayload('pauseDispatch', {}), 'invalid_request');
  expectHostCode(() => parsePayload('pauseDispatch', { paused: 'yes' }), 'invalid_request');
  expectHostCode(() => parsePayload('addManual', { prompt: 'p' }), 'invalid_request');
  expectHostCode(() => parsePayload('notAnOp', {}), 'unknown_op');
  // The Host runtime version is a compiled constant, never a request field.
  expectHostCode(() => parsePayload('bootstrap', { runtimeVersion: '9.9.9' }), 'invalid_request');
  expectHostCode(() => parsePayload('checkQuota', { runtimeVersion: '9.9.9' }), 'invalid_request');
});

test('parsePayload refuses authorization, credential and transport fields by name', () => {
  for (const field of ['url', 'uri', 'headers', 'authorization', 'authIndex', 'token', 'apiKey', 'credentialRef', 'secret', 'body', 'raw', 'actor', 'role', 'operator', 'admin', 'target', 'endpoint']) {
    expectHostCode(() => parsePayload('bootstrap', { [field]: 'x' }), 'invalid_request');
    expectHostCode(() => parsePayload('addManual', { prompt: 'p', workspaceId: 'w', routeId: 'r', [field]: 'x' }), 'invalid_request');
  }
  // Mixed case is normalized before the deny check.
  expectHostCode(() => parsePayload('bootstrap', { AuthIndex: 0 }), 'invalid_request');
  expectHostCode(() => parsePayload('bootstrap', { Headers: {} }), 'invalid_request');
});

test('parsePayload refuses nested objects, so nothing structured can be smuggled', () => {
  expectHostCode(() => parsePayload('bootstrap', { sessionId: { nested: true } }), 'invalid_request');
  expectHostCode(() => parsePayload('addManual', { prompt: { text: 'p' }, workspaceId: 'w', routeId: 'r' }), 'invalid_request');
});

test('parseConfig applies defaults and accepts one shared credential across routes', () => {
  assert.deepEqual(parseConfig(undefined), {
    storageBackend: 'json', routes: [], quotaSource: null,
    autoResume: { enabled: false, maxWaitMs: 3600000, maxChecks: 30 },
    autoContinue: { enabled: false, maxAttempts: 5, pollMs: 5000, fenceGraceMs: 120_000, quotaGateRetryMs: 600_000 },
  });
  assert.deepEqual(parseConfig(null), {
    storageBackend: 'json', routes: [], quotaSource: null,
    autoResume: { enabled: false, maxWaitMs: 3600000, maxChecks: 30 },
    autoContinue: { enabled: false, maxAttempts: 5, pollMs: 5000, fenceGraceMs: 120_000, quotaGateRetryMs: 600_000 },
  });
  assert.deepEqual(parseConfig({ storageBackend: 'json' }).routes, []);
  const twoRoutes = parseConfig({ routes: [ROUTE, ROUTE_B] });
  assert.equal(twoRoutes.routes.length, 2);
  assert.ok(twoRoutes.routes.every((route) => route.credentialRef === CREDENTIAL_REF));
  assert.equal(parseConfig({ routes: [{ ...ROUTE, label: undefined }] }).routes[0].label, ROUTE.id);
});

test('parseConfig refuses unknown keys, malformed routes and multi-account routes', () => {
  assert.throws(() => parseConfig({ nope: 1 }), /unknown config key/);
  assert.throws(() => parseConfig({ route: [ROUTE] }), /unknown config key/);
  assert.throws(() => parseConfig({ routes: [ROUTE, ROUTE] }), /duplicates an earlier route id/);
  assert.throws(() => parseConfig({ routes: [{ id: 'a', provider: 'p', model: 'm' }] }), /credentialRef/);
  assert.throws(() => parseConfig({ routes: [{ ...ROUTE, extra: 1 }] }), /unknown key/);
  assert.throws(() => parseConfig({ autoContinue: { enabled: true, quotaGateRetryMs: 1 } }), /quotaGateRetryMs/);
  assert.throws(() => parseConfig({ autoContinue: { nope: 1 } }), /unknown key/);
  assert.throws(() => parseConfig({ routes: [{ ...ROUTE, id: 'bad id' }] }), /only \[A-Za-z0-9_\.:-\]/);
  assert.throws(
    () => parseConfig({ routes: [ROUTE, { ...ROUTE_B, id: 'other-cred', credentialRef: 'another-ref' }] }),
    /must share the same credentialRef/,
  );
});

test('Config exposes a synchronous standard-schema face', () => {
  assert.equal(Config['~standard'].version, 1);
  const ok = Config['~standard'].validate({ routes: [ROUTE] });
  assert.equal(ok.issues, undefined);
  assert.equal(ok.value.routes.length, 1);
  const bad = Config['~standard'].validate({ routes: [ROUTE, { ...ROUTE_B, credentialRef: 'x' }] });
  assert.equal(bad.value, undefined);
  assert.ok(Array.isArray(bad.issues) && bad.issues.length >= 1);
  assert.ok(typeof bad.issues[0].message === 'string');
});
