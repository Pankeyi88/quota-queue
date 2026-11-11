/** Real-clock regression: a prompt that NEVER settles and ignores abort must
 *  not hold stop() past its drain deadline, and must keep the owner port. */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createAutoContinueDriver } from '../../host/auto-continue.js';
import { createOwnerMutex } from '../../host/owner-lock.js';
import { createFakeStore, inspectionFor, userMessage, errorEnd } from './continue-harness.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const fsStub = { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} };

test('real clock: a hung prompt stops within the drain deadline and keeps ownership', { timeout: 10000 }, async () => {
  const keepAlive = setInterval(() => {}, 1000); // prove the event loop stays alive
  const port = await freePort();
  const owner = createOwnerMutex({ port, instanceId: 'real-owner', fs: fsStub });
  assert.equal((await owner.acquire()).active, true);

  const store = createFakeStore();
  const inspection = inspectionFor('s1', [{ turn: 1, messages: [userMessage('m1')], end: errorEnd('TRANSPORT') }]);
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  let promptStarted = false;
  const controller = {
    async inspect() { return structuredClone(inspection); },
    prompt() { promptStarted = true; return new Promise(() => {}); }, // never settles
  };
  const driver = createAutoContinueDriver({
    store,
    resolveController: () => controller,
    resolveInspection: () => controller,
    resolveAgents: () => ({ get: () => agent }),
    resolveGoals: () => ({ get: () => null, resume() {} }),
    getOptIn: () => true,
    isPaused: () => false,
    owner,
    drainTimeoutMs: 80,
    sendTimeoutMs: 30,
    delayMsFor: () => 0,
  });
  try {
    await driver.start();
    driver.listener({ id: 's1' }, { type: 'turn/end', data: { turn: 1, reason: errorEnd('TRANSPORT') } });
    for (let i = 0; i < 100 && promptStarted === false; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(promptStarted, true, 'the Host call really is in flight');

    const startedAt = Date.now();
    await driver.stop();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 70 && elapsed < 2000, 'stop resolves after the drain deadline, not never: ' + elapsed);
    assert.equal(driver.releaseSafe, false);
    assert.equal(owner.verify(), true, 'the owner port is still held');

    const rival = createOwnerMutex({ port, instanceId: 'rival', fs: fsStub });
    assert.deepEqual(await rival.acquire(), { active: false, reason: 'held_by_peer' });
  } finally {
    clearInterval(keepAlive);
    await owner.release();
  }
});
