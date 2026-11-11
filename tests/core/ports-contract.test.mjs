/**
 * PORT CONTRACT tests.
 *
 * The host features these cases exercise (single-owner proof, session
 * execution, claim/turn observation, workspace re-resolution) do NOT exist as
 * verified host integrations in this repository. They are therefore tested
 * here as explicit PORT CONTRACTS against in-memory fakes: the core must fail
 * closed when a port is missing, malformed or merely asserted. Nothing in this
 * file contacts a real host, model or network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QueueStore, QueueService, REQUIRED_CAPABILITIES, CAPABILITY_EVIDENCE, validateQuotaSnapshot,
} from '../../core/index.mjs';
import {
  makeHarness, addManualTask, memoryStorePort, fakeQuota, fakeSession, deferred,
  availableSnapshot, WORKSPACE_ID, PROVIDER, MODEL,
} from './helpers.mjs';

const SCOPE = 'qs:["provider-a","model-a","default","global"]';

async function until(predicate, label) {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openStore(port = memoryStorePort()) {
  const store = new QueueStore({ load: port.load, save: port.save });
  await store.open();
  return store;
}

/** Store port that can suspend one specific save to expose a write race. */
function hangingPort() {
  const inner = memoryStorePort();
  let target = null;
  let counter = 0;
  let release = null;
  let startedResolve = null;
  return {
    state: inner.state,
    load: () => inner.load(),
    async save(snapshot) {
      counter += 1;
      if (counter === target) {
        startedResolve?.();
        await new Promise((resolve) => { release = resolve; });
      }
      return inner.save(snapshot);
    },
    hangNextSave() {
      target = counter + 1;
      const started = new Promise((resolve) => { startedResolve = resolve; });
      return { started, release: () => release?.() };
    },
  };
}

test('PORT CONTRACT: capabilities are default-deny and gate every execution', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ capabilities: {} });
  assert.deepEqual(h.service.capabilities().missing, [...REQUIRED_CAPABILITIES]);
  assert.equal(h.service.capabilities().evidence.singleOwner, CAPABILITY_EVIDENCE.singleOwner);
  const task = await addManualTask(h, { taskId: 'task-a' });
  const report = await h.service.tick();
  assert.equal(report.capabilityBlocked, true);
  assert.deepEqual(report.missingCapabilities, [...REQUIRED_CAPABILITIES]);
  assert.equal(h.task(task.id).status, 'needs_attention');
  assert.equal(h.task(task.id).needsAttentionReason, 'missing_capability:singleOwner');
  assert.equal(h.session.calls.prepareNew.length, 0);
  assert.equal(h.session.calls.startNew.length, 0);
  const again = await h.service.tick();
  assert.equal(again.dispatched.filter((entry) => entry.dispatched).length, 0);
  assert.equal(h.session.calls.startNew.length, 0);
  assert.equal(h.task(task.id).status, 'needs_attention', 'the park is sticky until the user acts');
});

test('PORT CONTRACT: a partially asserted capability set still refuses execution', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ capabilities: { singleOwner: true, routeBound: true, sessionExecution: true } });
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  assert.equal(h.task(task.id).status, 'needs_attention');
  assert.ok(h.task(task.id).needsAttentionReason.startsWith('missing_capability:'));
  assert.equal(h.service.capabilities().missing.includes('claimObservation'), true);
});

test('PORT CONTRACT: the constructor rejects missing ports and raised concurrency', { timeout: 10_000 }, async () => {
  const store = await openStore();
  assert.throws(
    () => new QueueService({ store, quota: fakeQuota(), session: fakeSession(), config: { maxConcurrent: 2 } }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => new QueueService({ store, quota: fakeQuota(), session: { inspect() {}, prepareNew() {} } }),
    (error) => error.code === 'PORT_CONTRACT' && error.details.includes('session.startNew'),
  );
  assert.throws(
    () => new QueueService({ store, quota: {}, session: fakeSession() }),
    (error) => error.code === 'PORT_CONTRACT' && error.details.includes('quota.check'),
  );
});

test('PORT CONTRACT: an invalid quota snapshot is rejected and never stored', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ quota: async (scope) => ({ scopeKey: scope.scopeKey, state: 'available' }) });
  await assert.rejects(h.service.checkQuota({ scopeKey: SCOPE }), (error) => error.code === 'PORT_CONTRACT');
  assert.deepEqual(h.snapshot().quotaScopes, {});
  const task = await addManualTask(h, { taskId: 'task-a' });
  const report = await h.service.tick();
  assert.equal(report.checkErrors.length, 1);
  assert.equal(h.task(task.id).status, 'queued', 'invalid quota evidence never releases work');
});

test('PORT CONTRACT: a snapshot for another scope is rejected', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ quota: async () => availableSnapshot({ scopeKey: 'some-other-scope' }) });
  await assert.rejects(h.service.checkQuota({ scopeKey: SCOPE }), (error) => error.code === 'PORT_CONTRACT');
});

test('PORT CONTRACT: a failing query records unknown and never releases work', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ quota: async () => { throw new Error('proxy down'); } });
  const task = await addManualTask(h, { taskId: 'task-a' });
  const report = await h.service.tick();
  assert.equal(report.checkErrors.length, 1);
  assert.equal(h.task(task.id).status, 'queued');
  const recorded = h.snapshot().quotaScopes[SCOPE];
  assert.equal(recorded.state, 'unknown');
  assert.equal(recorded.releaseRecommended, false);
  assert.ok(recorded.reasons[0].startsWith('query_failed:'));
  const second = await h.service.tick();
  assert.equal(second.dispatched.filter((entry) => entry.dispatched).length, 0);
});

test('PORT CONTRACT: ids must be non-empty strings', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ ids: { next: () => 42 } });
  await assert.rejects(
    h.service.addManual({ prompt: 'p', workspaceId: WORKSPACE_ID, provider: PROVIDER, model: MODEL }),
    (error) => error.code === 'PORT_CONTRACT',
  );
});

test('PORT CONTRACT: validateQuotaSnapshot is deep, not just a top-level check', () => {
  const good = availableSnapshot({ scopeKey: 'scope' });
  assert.deepEqual(validateQuotaSnapshot(good), []);
  assert.ok(validateQuotaSnapshot({ ...good, headers: {} }).includes('unknownField:headers'));
  assert.ok(validateQuotaSnapshot({ ...good, rawBody: 'x' }).includes('forbiddenField:rawBody'));
  assert.ok(validateQuotaSnapshot({ ...good, observedWindows: [{ ...good.observedWindows[0], token: 'secret' }] }).some((issue) => issue.includes('token')));
  assert.ok(validateQuotaSnapshot({ ...good, blockingWindows: [{ id: 'w', blocked: true, saturation: true }] }).some((issue) => issue.includes('saturation')));
  assert.ok(validateQuotaSnapshot({ ...good, reasons: [() => {}] }).some((issue) => issue.startsWith('nonJson')));
  assert.ok(validateQuotaSnapshot({ ...good, reasons: ['free text with spaces'] }).includes('reasons[0]'));
  assert.ok(validateQuotaSnapshot({ ...good, observedAt: 'not-a-date' }).includes('observedAt'));
  assert.ok(validateQuotaSnapshot({ ...good, observedAt: '+275760-09-14T00:00:00.000Z' }).includes('observedAt'));
});

test('PORT CONTRACT: time helpers reject out-of-range instants without throwing', { timeout: 10_000 }, async () => {
  const { toEpochMs, isValidIsoInstant, toIso } = await import('../../core/util.mjs');
  assert.equal(toEpochMs(1e300), undefined);
  assert.equal(toEpochMs('+275760-09-14T00:00:00.000Z'), undefined);
  assert.equal(isValidIsoInstant('+275760-09-14T00:00:00.000Z'), false);
  assert.throws(() => toIso(1e300), RangeError);
});

test('A10: authorization is user-only and defaults to off', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  for (const actor of ['model', 'tool', 'system', undefined, null]) {
    await assert.rejects(
      h.service.setSessionOptIn({ sessionId: 'session-1', optIn: true, actor }),
      (error) => error.code === 'AUTHORIZATION_DENIED',
      String(actor),
    );
  }
  assert.equal(h.service.isSessionOptedIn('session-1'), false);
  await h.service.setSessionOptIn({ sessionId: 'session-1', optIn: true, actor: 'user' });
  assert.equal(h.service.isSessionOptedIn('session-1'), true);
});

test('A10: manual entry rejects raw error text, URLs, headers and tokens', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  for (const field of ['url', 'headers', 'token', 'body', 'raw']) {
    await assert.rejects(
      h.service.addManual({ prompt: 'p', workspaceId: WORKSPACE_ID, provider: PROVIDER, model: MODEL, [field]: 'x' }),
      (error) => error.code === 'INVALID_INPUT' && error.details.includes(field),
      field,
    );
  }
  const task = await addManualTask(h, { taskId: 'task-a' });
  await assert.rejects(
    h.service.editPending({ taskId: task.id, patch: { token: 'x' } }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('close: new work is rejected, reads still work and close is idempotent', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.close();
  assert.equal(h.service.list().tasks.length, 1);
  assert.equal(h.service.getTask(task.id).id, task.id);
  await assert.rejects(h.service.tick(), (error) => error.code === 'CLOSED');
  await assert.rejects(h.service.checkQuota({ scopeKey: SCOPE }), (error) => error.code === 'CLOSED');
  await assert.rejects(h.service.captureFailure({ sessionId: 's', failedStepId: 'f', generation: '1', code: 'QUOTA' }), (error) => error.code === 'CLOSED');
  await assert.rejects(h.service.addManual({ prompt: 'p', workspaceId: WORKSPACE_ID, provider: PROVIDER, model: MODEL }), (error) => error.code === 'CLOSED');
  const second = await h.service.close();
  assert.deepEqual(second, { closed: true, drained: true });
});

test('close: an accepted write is drained, not rejected', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const accepted = h.service.addManual({ prompt: 'p', workspaceId: WORKSPACE_ID, provider: PROVIDER, model: MODEL });
  const closing = h.service.close();
  const task = await accepted;
  await closing;
  assert.equal(task.status, 'draft');
  assert.equal(h.service.list().tasks.length, 1);
  assert.equal(h.storePort.state.persisted.tasks.length, 1, 'the accepted write reached durable storage');
});

test('close during dispatch performs no further external effect', { timeout: 10_000 }, async () => {
  const gate = deferred();
  const h = await makeHarness({
    session: {
      prepareNew: async (request) => {
        await gate.promise;
        return { sessionId: request.sessionId, workspaceId: request.workspaceId, cwd: request.cwd, revision: 'rev-new' };
      },
    },
  });
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  const tickPromise = h.service.tick();
  await until(() => h.session.calls.prepareNew.length === 1, 'prepareNew');
  const closing = h.service.close();
  gate.resolve();
  await tickPromise;
  await closing;
  assert.equal(h.session.calls.startNew.length, 0, 'no new side effect after close');
  assert.equal(h.task(task.id).status, 'running');
  assert.equal(h.task(task.id).dispatchUncertain, true);
  assert.ok(h.task(task.id).needsAttentionReason.startsWith('dispatch_outcome_unknown'));
});

test('RACE: cancelQueued cannot release a task that started while it was queued', { timeout: 10_000 }, async () => {
  const port = hangingPort();
  const h = await makeHarness({ storePort: port });
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  const gate = port.hangNextSave();
  const tickPromise = h.service.tick();
  await gate.started;
  const cancelPromise = h.service.cancelQueued({ taskId: task.id });
  gate.release();
  await tickPromise;
  await assert.rejects(cancelPromise, (error) => error.code === 'INVALID_TRANSITION');
  assert.equal(h.task(task.id).status, 'running');
  assert.equal(h.session.calls.startNew.length, 1);
});

test('RACE: editPending cannot rewrite a task that is starting', { timeout: 10_000 }, async () => {
  const port = hangingPort();
  const h = await makeHarness({ storePort: port });
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  const gate = port.hangNextSave();
  const tickPromise = h.service.tick();
  await gate.started;
  const editPromise = h.service.editPending({ taskId: task.id, patch: { prompt: 'rewritten prompt' } });
  gate.release();
  await tickPromise;
  await assert.rejects(editPromise, (error) => error.code === 'INVALID_TRANSITION');
  assert.equal(h.task(task.id).status, 'running');
  assert.equal(h.task(task.id).prompt, 'do the thing', 'the executed prompt is untouched');
  assert.equal(h.session.calls.startNew.at(-1).prompt, 'do the thing');
});

test('RACE: already dispatched tasks refuse edits and prompt rewrites', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  await h.service.tick();
  assert.equal(h.task(task.id).status, 'running');
  await assert.rejects(
    h.service.editPending({ taskId: task.id, patch: { prompt: 'replay me' } }),
    (error) => error.code === 'INVALID_TRANSITION',
  );
});

test('operations are tracked for draining but never serialized against each other', { timeout: 10_000 }, async () => {
  const gate = deferred();
  const h = await makeHarness({
    quota: async (scope) => {
      await gate.promise;
      return availableSnapshot({ scopeKey: scope.scopeKey, observedAt: h.clock.iso() });
    },
  });
  const task = await addManualTask(h, { taskId: 'task-a' });
  // Nested: tick awaits an internal checkQuota. If #submit serialized, the
  // inner submission would wait for the outer operation and deadlock.
  const tickPromise = h.service.tick();
  const direct = h.service.checkQuota({ scopeKey: SCOPE });
  gate.resolve();
  const [report, snapshot] = await Promise.all([tickPromise, direct]);
  assert.equal(report.checked.length, 1);
  assert.equal(snapshot.state, 'available');
  assert.equal(h.quota.calls.check.length, 1, 'the nested and direct queries share one single-flight');
  assert.equal(h.task(task.id).status, 'queued');
});

test('capacities: a task already running cannot be cancelled directly', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  await h.service.tick();
  await assert.rejects(
    h.service.cancelQueued({ taskId: task.id }),
    (error) => error.code === 'INVALID_TRANSITION',
  );
  await assert.rejects(
    h.service.requestStop({ taskId: 'missing' }),
    (error) => error.code === 'NOT_FOUND',
  );
});

test('scheduler reports check failures without releasing anything', { timeout: 10_000 }, async () => {
  let calls = 0;
  const h = await makeHarness({
    quota: async (scope) => {
      calls += 1;
      if (calls === 1) throw new Error('temporary outage');
      return availableSnapshot({ scopeKey: scope.scopeKey, observedAt: h.clock.iso() });
    },
  });
  const task = await addManualTask(h, { taskId: 'task-a' });
  const first = await h.service.tick();
  assert.equal(first.checkErrors.length, 1);
  assert.equal(h.task(task.id).status, 'queued');
  const second = await h.service.tick();
  assert.equal(second.checked.length, 1);
  assert.equal(h.task(task.id).status, 'queued', 'a successful check alone never releases work');
  const third = await h.service.tick();
  assert.equal(third.dispatched.filter((entry) => entry.dispatched).length, 1);
});
