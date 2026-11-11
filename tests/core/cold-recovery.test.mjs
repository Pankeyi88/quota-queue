import test from 'node:test';
import assert from 'node:assert/strict';
import { ColdRecovery } from '../../core/cold-recovery.mjs';

const id = (overrides = {}) => ({ sessionId: 's', taskId: 'task', generation: 'g', workspaceId: 'w', rootMessageId: 'root', failedTurnId: 'failed-turn', requestId: 'request', ...overrides });
const observation = (i = id(), extra = {}) => ({ identity: i, messageId: 'observed-message', turnId: 'observed-turn', proofId: 'binding-proof', ...extra });
const evidence = (i = id(), kind = 'completed', extra = {}) => ({ identity: i, kind, proofId: 'terminal-proof', messageId: kind === 'not_delivered' ? null : 'observed-message', turnId: kind === 'not_delivered' ? null : 'observed-turn', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function medium() {
  const m = { value: null, saves: 0, sends: [], mode: null, gate: null };
  m.ports = {
    load: async () => structuredClone(m.value),
    save: async v => { m.saves++; if (m.gate) await m.gate.promise; if (m.mode === 'fail') throw Error('save'); m.value = structuredClone(v); if (m.mode === 'lost_ack') throw Error('ack'); },
    send: x => { m.sends.push(structuredClone(x)); return m.send ? m.send(x) : Promise.resolve({ status: 'accepted' }); },
  };
  return m;
}
const open = async m => { const c = new ColdRecovery(m.ports); await c.open(); return c; };

test('durable claim precedes exactly one send; receipt is not terminal', async () => {
  const m = medium(), c = await open(m); let seen;
  m.send = x => { seen = structuredClone(m.value); assert.deepEqual(x, id()); return { status: 'accepted' }; };
  assert.deepEqual(await c.dispatch(id()), { kind: 'accepted' });
  assert.equal(seen.entries[0].status, 'claimed'); assert.equal(seen.entries[0].fenced, true);
  assert.equal(c.getSnapshot().entries[0].status, 'accepted'); assert.equal(c.getSnapshot().entries[0].fenced, true);
  await assert.rejects(c.dispatch(id()), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch(id({ requestId: 'new', taskId: 'other', rootMessageId: 'other' })), /duplicate_or_fenced/);
  assert.equal(m.sends.length, 1);
});

test('concurrent dispatch serializes the claim, including different intents in one session', async () => {
  const m = medium(), c = await open(m); m.gate = deferred();
  const a = c.dispatch(id()), b = c.dispatch(id({ taskId: 'other', rootMessageId: 'other', requestId: 'other' }));
  await Promise.resolve(); await Promise.resolve(); assert.equal(m.sends.length, 0);
  m.gate.resolve(); m.gate = null;
  const result = await Promise.allSettled([a, b]);
  assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected'); assert.equal(m.sends.length, 1);
});

test('unknown outcome and restart never resend or infer completion', async () => {
  const m = medium(), c = await open(m); m.send = () => { throw Error('unknown'); };
  assert.deepEqual(await c.dispatch(id()), { kind: 'unknown' });
  assert.equal(m.value.entries[0].fenced, true); await c.close();
  const reloaded = await open(m); assert.equal(reloaded.getSnapshot().entries[0].status, 'unknown');
  await assert.rejects(reloaded.dispatch(id()), /duplicate_or_fenced/); assert.equal(m.sends.length, 1);
});

test('lost claim write acknowledgment locks without sending; reload sees durable fence', async () => {
  const m = medium(), c = await open(m); m.mode = 'lost_ack';
  await assert.rejects(c.dispatch(id()), /save_failed/); assert.equal(c.locked, true); assert.equal(m.sends.length, 0);
  assert.equal(c.getSnapshot().entries.length, 0); await assert.rejects(c.dispatch(id()), /locked/);
  m.mode = null; const reloaded = await open(m); assert.equal(reloaded.getSnapshot().entries[0].status, 'claimed');
  await assert.rejects(reloaded.dispatch(id()), /duplicate_or_fenced/); assert.equal(m.sends.length, 0);
});

test('definite save failure sends nothing and locks; absent durable marker requires host quarantine', async () => {
  const m = medium(), c = await open(m); m.mode = 'fail';
  await assert.rejects(c.dispatch(id()), /save_failed/); assert.equal(m.value, null); assert.equal(m.sends.length, 0);
  await assert.rejects(c.dispatch(id()), /locked/);
  // Empty persistent state is indistinguishable from a fresh store. Host must
  // quarantine externally; no fake cross-restart promise is made here.
  m.mode = null; const reloaded = await open(m); assert.equal(reloaded.getSnapshot().entries.length, 0);
});

test('result status save failure keeps the durable claim and never resends after reload', async () => {
  for (const mode of ['fail', 'lost_ack']) {
    const m = medium(), c = await open(m); m.send = () => { m.mode = mode; return { status: 'accepted' }; };
    await assert.rejects(c.dispatch(id()), /save_failed/); assert.equal(m.sends.length, 1); assert.equal(c.locked, true);
    m.mode = null; const next = await open(m); assert.equal(next.getSnapshot().entries[0].fenced, true);
    await assert.rejects(next.dispatch(id()), /duplicate_or_fenced/); assert.equal(m.sends.length, 1);
  }
});

test('only exact terminal or positive evidence releases, never acceptance, idle or unrelated turn', async () => {
  const m = medium(), c = await open(m); await c.dispatch(id());
  for (const kind of ['accepted', 'idle', 'unknown', 'timeout']) await assert.rejects(c.reconcile(evidence(id(), kind)), /invalid_evidence/);
  for (const key of Object.keys(id())) await assert.rejects(c.reconcile(evidence(id({ [key]: 'wrong' }))), /evidence_mismatch/);
  assert.equal(c.getSnapshot().entries[0].fenced, true);
  await assert.rejects(c.reconcile(evidence()), /invalid_evidence/);
  await c.bindObservation(observation());
  for (const key of ['messageId', 'turnId']) await assert.rejects(c.reconcile(evidence(id(), 'completed', { [key]: 'wrong' })), /invalid_evidence/);
  const result = await c.reconcile(evidence()); assert.equal(result.entries[0].status, 'settled'); assert.equal(result.entries[0].fenced, false);
  await assert.rejects(c.dispatch(id({ requestId: 'new' })), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch(id({ requestId: 'new', rootMessageId: 'different' })), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch(id({ requestId: 'new', taskId: 'different' })), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch(id({ requestId: 'request', taskId: 'different', rootMessageId: 'different' })), /duplicate_or_fenced/);
  assert.deepEqual(await c.dispatch(id({ requestId: 'unique', taskId: 'other', rootMessageId: 'other' })), { kind: 'accepted' });
});

test('positive stopped and not-delivered evidence release fence but preserve tombstone', async () => {
  for (const kind of ['stopped', 'not_delivered', 'failed', 'aborted']) {
    const m = medium(), c = await open(m); await c.dispatch(id()); if (kind !== 'not_delivered') await c.bindObservation(observation()); await c.reconcile(evidence(id(), kind));
    const reopened = await open(m); assert.equal(reopened.getSnapshot().entries[0].evidence.kind, kind);
    await assert.rejects(reopened.dispatch(id({ requestId: 'another' })), /duplicate_or_fenced/);
  }
});

test('cancellation during claim save immediately suppresses send and persists across reload', async () => {
  const m = medium(), c = await open(m); m.gate = deferred();
  const p = c.dispatch(id()); await Promise.resolve(); await Promise.resolve();
  const cancelled = c.cancel('s'); m.gate.resolve(); m.gate = null;
  assert.deepEqual(await p, { kind: 'not_sent' }); await cancelled; assert.equal(m.sends.length, 0);
  assert.equal(m.value.entries[0].cancelled, true); assert.deepEqual(m.value.revokedSessions, ['s']);
  const next = await open(m); await assert.rejects(next.dispatch(id({ requestId: 'other', taskId: 'other', rootMessageId: 'other' })), /revoked/);
});

test('cancellation before any claim persists the session revocation', async () => {
  const m = medium(), c = await open(m); await c.cancel('s'); const next = await open(m);
  await assert.rejects(next.dispatch(id()), /revoked/); assert.equal(m.sends.length, 0);
});

test('late result does not overwrite cancellation or positive reconciliation', async () => {
  for (const action of ['cancel', 'reconcile']) {
    const m = medium(), c = await open(m), wait = deferred(); m.send = () => wait.promise;
    const p = c.dispatch(id()); while (m.sends.length === 0) await new Promise(resolve => setImmediate(resolve));
    if (action === 'cancel') await c.cancel('s'); else { await c.bindObservation(observation()); await c.reconcile(evidence()); }
    wait.resolve({ status: 'accepted' }); await p;
    const e = c.getSnapshot().entries[0];
    assert.equal(e.status, action === 'cancel' ? 'claimed' : 'settled'); assert.equal(e.cancelled, action === 'cancel');
  }
});

test('invalid and corrupt snapshots fail closed and inputs are detached without getters', async () => {
  const m = medium(), c = await open(m); let reads = 0;
  const bad = id(); Object.defineProperty(bad, 'taskId', { enumerable: true, get() { reads++; return 'task'; } });
  await assert.rejects(c.dispatch(bad), /invalid_input/); assert.equal(reads, 0);
  const x = id(); const p = c.dispatch(x); x.failedTurnId = 'mutated'; await p; assert.equal(m.sends[0].failedTurnId, 'failed-turn');
  const clone = c.getSnapshot(); clone.entries[0].identity.failedTurnId = 'mutated'; assert.equal(c.getSnapshot().entries[0].identity.failedTurnId, 'failed-turn');
  m.value.entries[0].fenced = false; const broken = new ColdRecovery(m.ports); await assert.rejects(broken.open(), /invalid_snapshot/); assert.equal(broken.locked, true);
});

test('send result status is explicit; non-accepted and malformed results remain unknown and fenced', async () => {
  for (const response of [{ status: 'accepted' }, ...['unknown', 'cancelled', 'unavailable', 'busy', 'invalid', 'other'].map(status => ({ status })), undefined, null, {}, { status: 'accepted', extra: true }, 'accepted']) {
    const m = medium(), c = await open(m); m.send = () => response;
    const expected = response && typeof response === 'object' && response.status === 'accepted' && Object.keys(response).length === 1 ? 'accepted' : 'unknown';
    assert.deepEqual(await c.dispatch(id()), { kind: expected });
    assert.equal(m.value.entries[0].status, expected); assert.equal(m.value.entries[0].fenced, true);
    const next = await open(m); await assert.rejects(next.dispatch(id()), /duplicate_or_fenced/); assert.equal(m.sends.length, 1);
  }
});

test('send uses original identity only; invented new message or turn is rejected', async () => {
  const m = medium(), c = await open(m);
  await assert.rejects(c.dispatch(id({ messageId: 'made-up' })), /invalid_input/);
  await assert.rejects(c.dispatch(id({ turnId: 'made-up' })), /invalid_input/);
  await c.dispatch(id()); assert.deepEqual(m.sends[0], id());
  assert.equal(m.value.entries[0].observation, null);
});

test('observed host binding must be exact, durable, non-overwritable and unique per session', async () => {
  const m = medium(), c = await open(m); await c.dispatch(id());
  for (const key of Object.keys(id())) await assert.rejects(c.bindObservation(observation(id({ [key]: 'wrong' }))), /observation_mismatch/);
  await assert.rejects(c.bindObservation(observation(id(), { proofId: '' })), /invalid_observation/);
  await c.bindObservation(observation());
  await assert.rejects(c.bindObservation(observation(id(), { turnId: 'other' })), /observation_mismatch/);
  let next = await open(m); assert.deepEqual(next.getSnapshot().entries[0].observation, { messageId: 'observed-message', turnId: 'observed-turn', proofId: 'binding-proof' });
  await assert.rejects(next.reconcile(evidence(id(), 'not_delivered')), /invalid_evidence/);
  await next.reconcile(evidence());
  const nextId = id({ taskId: 'new-task', rootMessageId: 'new-root', requestId: 'new-request' });
  await next.dispatch(nextId);
  await assert.rejects(next.bindObservation(observation(nextId)), /observation_mismatch/);
  await next.bindObservation(observation(nextId, { messageId: 'new-message' }));
  await assert.rejects(next.reconcile(evidence(nextId)), /invalid_evidence/);
  await next.reconcile(evidence(nextId, 'completed', { messageId: 'new-message' }));
  assert.equal((await open(m)).getSnapshot().entries[1].status, 'settled');
});

test('lost observation acknowledgement locks; reload keeps bound fence without re-sending', async () => {
  const m = medium(), c = await open(m); await c.dispatch(id()); m.mode = 'lost_ack';
  await assert.rejects(c.bindObservation(observation()), /save_failed/); assert.equal(c.locked, true);
  m.mode = null; const next = await open(m); assert.equal(next.getSnapshot().entries[0].observation.messageId, 'observed-message');
  assert.equal(next.getSnapshot().entries[0].fenced, true); await assert.rejects(next.dispatch(id()), /duplicate_or_fenced/);
  await next.reconcile(evidence()); assert.equal(m.sends.length, 1);
});


test('distinct failures of one original task recover sequentially while each failure stays tombstoned', async () => {
  const m = medium(), c = await open(m); const first = id(), second = id({ failedTurnId: 'failed-turn-2', requestId: 'request-2' }), third = id({ failedTurnId: 'failed-turn-3', requestId: 'request-3' });
  await c.dispatch(first);
  await assert.rejects(c.dispatch(second), /duplicate_or_fenced/);
  await c.bindObservation(observation(first)); await c.reconcile(evidence(first));
  await assert.rejects(c.dispatch({ ...first, requestId: 'replay' }), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch({ ...first, taskId: 'renamed', requestId: 'replay' }), /duplicate_or_fenced/);
  await assert.rejects(c.dispatch({ ...first, rootMessageId: 'renamed', requestId: 'replay' }), /duplicate_or_fenced/);
  await c.dispatch(second); await assert.rejects(c.dispatch(third), /duplicate_or_fenced/);
  await assert.rejects(c.bindObservation(observation(second)), /observation_mismatch/);
  await c.bindObservation(observation(second, { messageId: 'message-2', turnId: 'turn-2' }));
  await c.reconcile(evidence(second, 'completed', { messageId: 'message-2', turnId: 'turn-2' }));
  const reloaded = await open(m);
  await assert.rejects(reloaded.dispatch({ ...second, requestId: 'replay-2' }), /duplicate_or_fenced/);
  await reloaded.dispatch(third);
  assert.equal(m.sends.length, 3); assert.deepEqual(m.sends.map(x => x.failedTurnId), ['failed-turn', 'failed-turn-2', 'failed-turn-3']);
  await assert.rejects(reloaded.dispatch(id({ sessionId: 'other-session', taskId: 'other-task', rootMessageId: 'other-root', failedTurnId: 'other-turn', requestId: first.requestId })), /duplicate_or_fenced/);
});

test('cancel locks on exhausted revision or invalid candidate; missing durable revocation needs quarantine', async () => {
  for (const mode of ['revision', 'candidate']) {
    const m = medium();
    m.value = { schemaVersion: 1, revision: mode === 'revision' ? Number.MAX_SAFE_INTEGER : 1, entries: [], revokedSessions: mode === 'candidate' ? Array.from({ length: 10000 }, (_, i) => 'existing-' + i) : [] };
    const c = await open(m), prior = structuredClone(m.value);
    await assert.rejects(c.cancel('s'), mode === 'revision' ? /revision_exhausted/ : /invalid_input/);
    assert.equal(c.locked, true); assert.equal(m.saves, 0); assert.deepEqual(c.getSnapshot(), prior); assert.deepEqual(m.value, prior);
    await assert.rejects(c.dispatch(id()), /locked/); assert.equal(m.sends.length, 0);
    const reload = await open(m); assert.equal(reload.getSnapshot().revokedSessions.includes('s'), false);
    // The persisted snapshot cannot represent that failed cancel. Host must keep
    // the session quarantined across restarts rather than treating it as fresh.
  }
});


test('snapshot rejects inconsistent session revocation and entry cancellation', async () => {
  for (const corrupt of ['missing-session', 'missing-entry-flag']) {
    const m = medium(), c = await open(m); await c.dispatch(id()); await c.cancel('s');
    if (corrupt === 'missing-session') m.value.revokedSessions = [];
    else m.value.entries[0].cancelled = false;
    const next = new ColdRecovery(m.ports); await assert.rejects(next.open(), /invalid_snapshot/); assert.equal(next.locked, true);
    assert.equal(m.sends.length, 1);
  }
});

test('core accepts caller-normalized numeric turn identities as strings', async () => {
  const m = medium(), c = await open(m); const numeric = id({ failedTurnId: 7 });
  await assert.rejects(c.dispatch(numeric), /invalid_input/);
  const original = id({ failedTurnId: String(7) }); await c.dispatch(original);
  await assert.rejects(c.bindObservation(observation(original, { turnId: 8 })), /invalid_observation/);
  await c.bindObservation(observation(original, { turnId: String(8) }));
  await c.reconcile(evidence(original, 'completed', { turnId: String(8) }));
  assert.equal(c.getSnapshot().entries[0].status, 'settled');
});
