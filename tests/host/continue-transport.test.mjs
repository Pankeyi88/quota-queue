import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinueTransport } from '../../host/continue-transport.js';
const signal = () => new AbortController().signal;

test('validates transport configuration', () => {
  for (const timeoutMs of [0, -1, 300001, 1.5, NaN, Infinity, '10']) {
    assert.throws(() => createContinueTransport({ resolveController: () => null, timeoutMs }), TypeError);
  }
  assert.throws(() => createContinueTransport({ resolveController: null }), TypeError);
});

test('abort during host resolution does not consume identity', async () => {
  const abort = new AbortController();
  let calls = 0, first = true;
  const transport = createContinueTransport({ resolveController: () => {
    if (first) { first = false; abort.abort(); }
    return { prompt() { calls++; return { accepted: true }; } };
  } });
  assert.equal((await transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal })).status, 'cancelled');
  assert.equal((await transport.send({ sessionId: 's', requestId: 'r', signal: signal() })).status, 'accepted');
  assert.equal(calls, 1);
});

test('invalid exceptional inputs are contained before admission', async () => {
  let calls = 0;
  const transport = createContinueTransport({ resolveController: () => ({ prompt() { calls++; } }) });
  for (const input of [undefined, null, {}, { get sessionId() { throw Error('secret'); } },
    { sessionId: 's', requestId: 'r', signal: Object.create(AbortSignal.prototype) },
    { sessionId: 's', requestId: 'r', get signal() { throw Error('secret'); } }]) {
    assert.deepEqual(await transport.send(input), { status: 'invalid' });
  }
  assert.equal(calls, 0);
});

test('prompt getter is read once and method keeps its host receiver', async () => {
  let reads = 0;
  const controller = { get prompt() { reads++; return function () { assert.equal(this, controller); return { accepted: true }; }; } };
  const transport = createContinueTransport({ resolveController: () => controller });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'accepted', requestId: 'r' });
  assert.equal(reads, 1);
});

test('synchronous throw and throwing receipt getter retain admission fence', async () => {
  for (const prompt of [() => { throw Error('secret'); }, () => ({ get accepted() { throw Error('secret'); } })]) {
    const transport = createContinueTransport({ resolveController: () => ({ prompt }) });
    assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'unknown', requestId: 'r' });
    assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r2', signal: signal() }), { status: 'busy' });
  }
});

test('accepted request replay is idempotent and identity cannot cross sessions', async () => {
  let calls = 0;
  const transport = createContinueTransport({ resolveController: () => ({ prompt() { calls++; return { accepted: true }; } }) });
  const input = { sessionId: 's', requestId: 'r', signal: signal() };
  assert.deepEqual(await transport.send(input), { status: 'accepted', requestId: 'r' });
  assert.deepEqual(await transport.send(input), { status: 'accepted', requestId: 'r' });
  assert.deepEqual(await transport.send({ ...input, sessionId: 'other' }), { status: 'busy' });
  assert.deepEqual(await transport.send({ ...input, requestId: 'next' }), { status: 'accepted', requestId: 'next' });
  assert.equal(calls, 2);
});

test('reserves request identity during reentrant host resolution and releases unavailable reservations', async () => {
  let inner, calls = 0, transport;
  transport = createContinueTransport({ resolveController: () => {
    inner = transport.send({ sessionId: 'other', requestId: 'r', signal: signal() });
    return { prompt() { calls++; return { accepted: true }; } };
  } });
  assert.equal((await transport.send({ sessionId: 's', requestId: 'r', signal: signal() })).status, 'accepted');
  assert.deepEqual(await inner, { status: 'busy' });
  assert.equal(calls, 1);
  let available = false;
  const retry = createContinueTransport({ resolveController: () => available ? { prompt: () => ({ accepted: true }) } : null });
  const input = { sessionId: 's', requestId: 'r', signal: signal() };
  assert.equal((await retry.send(input)).status, 'unavailable');
  available = true;
  assert.equal((await retry.send(input)).status, 'accepted');
});

test('sends only a minimal queued continuation to the original session', async () => {
  const calls = [];
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async (...args) => { calls.push(args); return { accepted: true }; } }) });
  const s = signal();
  assert.deepEqual(await transport.send({ sessionId: 'session-1', requestId: 'request-1', signal: s }), { status: 'accepted', requestId: 'request-1' });
  assert.deepEqual(calls, [[{ sessionId: 'session-1', requestId: 'request-1', mode: 'queue', content: [{ type: 'text', text: '继续' }] }, s]]);
});

test('invalid input, missing controller and pre-aborted signal never send', async () => {
  let calls = 0;
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async () => { calls++; } }) });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal }), { status: 'cancelled' });
  assert.deepEqual(await transport.send({ sessionId: ' s', requestId: 'r', signal: signal() }), { status: 'invalid' });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r' }), { status: 'invalid' });
  assert.equal(calls, 0);
  assert.deepEqual(await createContinueTransport({ resolveController: () => null }).send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'unavailable' });
  const broken = createContinueTransport({ resolveController: () => ({ get prompt() { throw new Error('hidden'); } }) });
  assert.deepEqual(await broken.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'unavailable' });
});

test('an exception or malformed receipt is unknown, with no retry or raw error', async () => {
  let calls = 0;
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async () => { calls++; throw new Error('sensitive'); } }) });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'unknown', requestId: 'r' });
  assert.equal(calls, 1);
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'busy' });
  assert.equal(calls, 1, 'unknown admission is fenced for the instance lifetime');
  const malformed = createContinueTransport({ resolveController: () => ({ prompt: async () => ({}) }) });
  assert.deepEqual(await malformed.send({ sessionId: 's', requestId: 'r', signal: signal() }), { status: 'unknown', requestId: 'r' });
});

test('overlapping deliveries for the same session are rejected locally', async () => {
  let finish; let calls = 0;
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } }) });
  const first = transport.send({ sessionId: 's', requestId: 'r1', signal: signal() });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r2', signal: signal() }), { status: 'busy' });
  assert.equal(calls, 1);
  finish({ accepted: true });
  assert.equal((await first).status, 'accepted');
});

test('cancellation after admission begins remains an unknown outcome', async () => {
  const abort = new AbortController();
  const transport = createContinueTransport({ resolveController: () => ({ prompt: async () => { abort.abort(); throw new Error('aborted'); } }) });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal }), { status: 'unknown', requestId: 'r' });
});
