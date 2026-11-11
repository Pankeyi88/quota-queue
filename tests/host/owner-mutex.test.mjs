/** Owner mutex: the OS binds the role; no expiry, no takeover heuristics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOwnerMutex } from '../../host/owner-lock.js';

const taken = new Set();
function fakeServer() {
  const server = new EventEmitter();
  server.listening = false;
  server.listen = ({ port }) => {
    if (taken.has(port)) { queueMicrotask(() => server.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))); return; }
    taken.add(port);
    server.port = port;
    server.listening = true;
    queueMicrotask(() => server.emit('listening'));
  };
  server.close = (cb) => { taken.delete(server.port); server.listening = false; cb?.(); };
  return server;
}
const fsStub = { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} };

test('a second owner cannot bind the same port and stays passive', async () => {
  const first = createOwnerMutex({ port: 43_900, instanceId: 'one', createServer: fakeServer, fs: fsStub });
  const second = createOwnerMutex({ port: 43_900, instanceId: 'two', createServer: fakeServer, fs: fsStub });
  assert.deepEqual(await first.acquire(), { active: true, reason: 'acquired' });
  assert.deepEqual(await second.acquire(), { active: false, reason: 'held_by_peer' });
  assert.equal(first.verify(), true);
  assert.equal(second.verify(), false);
  await first.release();
  assert.equal(first.verify(), false);
  const third = createOwnerMutex({ port: 43_900, instanceId: 'three', createServer: fakeServer, fs: fsStub });
  assert.deepEqual(await third.acquire(), { active: true, reason: 'acquired' });
  await third.release();
});

test('verify is false before acquisition and after release', async () => {
  const mutex = createOwnerMutex({ port: 43_901, instanceId: 'x', createServer: fakeServer, fs: fsStub });
  assert.equal(mutex.verify(), false);
  await mutex.acquire();
  assert.equal(mutex.verify(), true);
  await mutex.release();
  assert.equal(mutex.verify(), false);
});
