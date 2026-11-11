import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinueTransport } from '../../host/continue-transport.js';

test('synchronous abort before an accepted value remains unknown', async () => {
  const abort = new AbortController();
  const transport = createContinueTransport({ resolveController: () => ({ prompt() { abort.abort(); return { accepted: true }; } }) });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal }), { status: 'unknown', requestId: 'r' });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'next', signal: new AbortController().signal }), { status: 'busy' });
});

test('receipt getter abort or deadline overrun stays unknown', async () => {
  for (const mode of ['abort', 'deadline']) {
    const abort = new AbortController();
    const transport = createContinueTransport({ timeoutMs: 5, resolveController: () => ({ prompt() {
      return { get accepted() {
        if (mode === 'abort') abort.abort();
        else { const until = performance.now() + 20; while (performance.now() < until) {} }
        return true;
      } };
    } }) });
    assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal }), { status: 'unknown', requestId: 'r' });
  }
});

test('synchronous host work past deadline cannot report acceptance', async () => {
  const transport = createContinueTransport({ timeoutMs: 5, resolveController: () => ({ prompt() {
    const until = performance.now() + 20;
    while (performance.now() < until) {} // Simulate host blocking the event loop.
    return { accepted: true };
  } }) });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'r', signal: new AbortController().signal }), { status: 'unknown', requestId: 'r' });
  assert.deepEqual(await transport.send({ sessionId: 's', requestId: 'next', signal: new AbortController().signal }), { status: 'busy' });
});

test('late accepted value never clears the unknown fence or reuses request identity', async () => {
  let finish, calls = 0;
  const transport = createContinueTransport({ timeoutMs: 5, resolveController: () => ({ prompt() { calls++; return new Promise(resolve => { finish = resolve; }); } }) });
  const input = { sessionId: 's', requestId: 'r', signal: new AbortController().signal };
  assert.equal((await transport.send(input)).status, 'unknown');
  finish({ accepted: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await transport.send({ ...input, requestId: 'next' })).status, 'busy');
  assert.equal((await transport.send({ ...input, sessionId: 'other' })).status, 'busy');
  assert.equal(calls, 1);
});

test('a hung admission times out as unknown and retains the local fence', async () => {
  let reject;
  const transport = createContinueTransport({ timeoutMs: 5, resolveController: () => ({ prompt: () => new Promise((_, r) => { reject = r; }) }) });
  const input = { sessionId: 's', requestId: 'r', signal: new AbortController().signal };
  assert.deepEqual(await transport.send(input), { status: 'unknown', requestId: 'r' });
  assert.deepEqual(await transport.send(input), { status: 'busy' });
  reject(new Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await transport.send(input), { status: 'busy' });
});

test('abort remains observable despite stopImmediatePropagation', async () => {
  const abort = new AbortController();
  abort.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  const transport = createContinueTransport({ timeoutMs: 1000, resolveController: () => ({ prompt: () => new Promise(() => {}) }) });
  const pending = transport.send({ sessionId: 's', requestId: 'r', signal: abort.signal });
  abort.abort();
  assert.deepEqual(await pending, { status: 'unknown', requestId: 'r' });
});

test('abort after admission starts returns unknown even if host ignores abort', async () => {
  const abort = new AbortController();
  const transport = createContinueTransport({ resolveController: () => ({ prompt: () => new Promise(() => {}) }) });
  const input = { sessionId: 's', requestId: 'r', signal: abort.signal };
  const pending = transport.send(input);
  abort.abort();
  assert.deepEqual(await pending, { status: 'unknown', requestId: 'r' });
  assert.deepEqual(await transport.send({ ...input, signal: new AbortController().signal }), { status: 'busy' });
});
