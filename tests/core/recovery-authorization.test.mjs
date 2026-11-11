import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryAuthorizationStore } from '../../core/recovery-authorization.mjs';

const cap = {};
const facts = { session: 's', root: 'r', generation: 'g1', workspace: 'w', provider: 'p', model: 'm', planRevision: 4 };
const grant = () => ({ ...facts, expiresAt: 200 });
function medium(initial = null) {
  const state = { value: structuredClone(initial), fail: false, saves: 0 };
  const ports = { load: async () => structuredClone(state.value), save: async value => {
    state.saves++; if (state.fail) throw new Error('private'); state.value = structuredClone(value);
  } };
  return { state, ports };
}
const store = (m, clock = () => 100) => new RecoveryAuthorizationStore(m.ports, { humanCapability: cap, now: clock });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('default closed, exact binding, expiry, and explicit replacement', async () => {
  let now = 100; const m = medium(); const s = store(m, () => now); await s.open();
  assert.equal(s.isAuthorized(facts), false);
  await s.grant(cap, 0, grant()); assert.equal(s.isAuthorized(facts), true);
  for (const k of ['session','root','generation','workspace','provider','model']) assert.equal(s.isAuthorized({ ...facts, [k]: facts[k] + 'x' }), false, k);
  assert.equal(s.isAuthorized({ ...facts, planRevision: 5 }), false);
  assert.equal(s.isAuthorized({ ...facts, actor: 'human' }), false);
  now = 200; assert.equal(s.isAuthorized(facts), false); now = 100;
  assert.equal(s.isAuthorized(facts), false);
  await assert.rejects(s.grant(cap, 1, grant()), /clock/);
  now = 200;
  await s.grant(cap, 1, { ...grant(), expiresAt: 300, generation: 'g2' });
  assert.equal(s.isAuthorized(facts), false); assert.equal(s.isAuthorized({ ...facts, generation: 'g2' }), true);
  await assert.rejects(s.grant(cap, 2, { ...grant(), expiresAt: 100 }), /expired/);
});

test('capability is host-held, actor commands and legacy booleans never authorize', async () => {
  const m = medium(); const s = store(m); await s.open();
  for (const fake of [null, true, { actor: 'human' }, { type: 'grant', actor: 'human' }]) {
    await assert.rejects(s.grant(fake, 0, grant()), /human_confirmation_required/);
    await assert.rejects(s.revoke(fake), /human_confirmation_required/);
  }
  assert.equal(m.state.saves, 0); assert.equal(s.isAuthorized(facts), false);
  for (const old of [true, { sessionOptIns: { s: true } }, { schemaVersion: 1, revision: 0, grant: true }]) {
    const x = store(medium(old)); await assert.rejects(x.open(), /invalid_snapshot/); assert.equal(x.locked, true); assert.equal(x.isAuthorized(facts), false);
  }
});

test('durability precedes publication, snapshots detached, restart and tombstone persist', async () => {
  const entered = deferred(), release = deferred(); const m = medium(); const save = m.ports.save;
  m.ports.save = async v => { entered.resolve(); await release.promise; await save(v); };
  const s = store(m); await s.open(); const input = grant(); const pending = s.grant(cap, 0, input); input.model = 'tampered';
  await entered.promise; assert.equal(s.isAuthorized(facts), false); release.resolve();
  const out = await pending; out.grant.model = 'tampered'; assert.equal(s.isAuthorized(facts), true);
  const copy = s.getSnapshot(); copy.grant.model = 'tampered'; assert.equal(s.isAuthorized(facts), true);
  await s.close(); const reload = store(m); await reload.open(); assert.equal(reload.isAuthorized(facts), false);
  await reload.grant(cap, 1, grant()); assert.equal(reload.isAuthorized(facts), true);
  await reload.revoke(cap); await reload.close(); const last = store(m); await last.open();
  assert.equal(last.isAuthorized(facts), false); assert.equal(last.getSnapshot().grant, null);
});

test('concurrent writes serialize and stale revision fails', async () => {
  const m = medium(); const s = store(m); await s.open();
  const outcomes = await Promise.allSettled([s.grant(cap, 0, grant()), s.grant(cap, 0, { ...grant(), model: 'other' })]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.match(outcomes[1].reason.message, /revision_conflict/);
  assert.equal(m.state.saves, 1); assert.equal(s.isAuthorized(facts), true);
});

test('revocation blocks immediately, beats queued grants, persists after in-flight save', async () => {
  const m = medium(); const s = store(m); await s.open(); await s.grant(cap, 0, grant());
  const entered = deferred(), release = deferred(); const save = m.ports.save;
  m.ports.save = async v => { entered.resolve(); await release.promise; await save(v); };
  const first = s.grant(cap, 1, { ...grant(), model: 'new' }); await entered.promise;
  const queued = s.grant(cap, 2, grant()); const rejected = assert.rejects(queued, /revoked/);
  const revoke = s.revoke(cap); assert.equal(s.isAuthorized(facts), false);
  await assert.rejects(s.grant(cap, 1, grant()), /revoking/);
  release.resolve(); await first; await rejected; await revoke;
  assert.equal(s.isAuthorized(facts), false); assert.equal(s.getSnapshot().grant, null);
  assert.equal(m.state.value.grant, null);
});

test('failed write locks checks and later writes; failed revoke may survive restart', async () => {
  const m = medium(); const s = store(m); await s.open(); await s.grant(cap, 0, grant()); m.state.fail = true;
  await assert.rejects(s.revoke(cap), /save_failed/); assert.equal(s.locked, true); assert.equal(s.isAuthorized(facts), false);
  await assert.rejects(s.grant(cap, 1, grant()), /locked/); await assert.rejects(s.revoke(cap), /locked/);
  assert.equal(s.getSnapshot().grant.model, 'm');
  m.state.fail = false; const restarted = store(m); await restarted.open(); assert.equal(restarted.isAuthorized(facts), false); assert.notEqual(restarted.getSnapshot().grant, null);
});

test('load failure, malformed objects, clocks and close fail closed', async () => {
  const s = new RecoveryAuthorizationStore({ load: async () => { throw Error('secret'); }, save: async () => {} }, { humanCapability: cap });
  await assert.rejects(s.open(), /load_failed/); assert.equal(s.locked, true); assert.equal(s.isAuthorized(facts), false);
  const m = medium(); const x = store(m, () => NaN); await x.open(); await assert.rejects(x.grant(cap, 0, grant()), /clock/);
  let reads = 0; const bad = { ...grant(), get model() { reads++; return 'm'; } };
  await assert.rejects(x.grant(cap, 0, bad), /invalid_input/); assert.equal(reads, 0);
  await assert.rejects(x.grant(cap, 0, Object.assign(Object.create({}), grant())), /invalid_input/);
  const closing = x.close(); assert.equal(x.close(), closing); await closing;
  await assert.rejects(x.grant(cap, 0, grant()), /closed/); assert.equal(x.isAuthorized(facts), false);
});

test('lost save acknowledgement reloads disarmed until a fresh durable grant', async () => {
  const m = medium(); const save = m.ports.save;
  m.ports.save = async v => { await save(v); throw Error('lost acknowledgement'); };
  const s = store(m); await s.open(); await assert.rejects(s.grant(cap, 0, grant()), /save_failed/);
  assert.equal(s.isAuthorized(facts), false); assert.notEqual(m.state.value.grant, null);
  m.ports.save = save; const next = store(m); await next.open();
  assert.equal(next.isAuthorized(facts), false);
  await next.grant(cap, 1, grant()); assert.equal(next.isAuthorized(facts), true);
});

test('clock high-water and observed expiry disarm until new confirmation', async () => {
  let now = 100; const m = medium(); const s = store(m, () => now); await s.open(); await s.grant(cap, 0, grant());
  now = 150; assert.equal(s.isAuthorized(facts), true);
  now = 149; assert.equal(s.isAuthorized(facts), false); now = 150;
  assert.equal(s.isAuthorized(facts), false);
  await s.grant(cap, 1, grant()); assert.equal(s.isAuthorized(facts), true);
  now = 200; assert.equal(s.isAuthorized(facts), false); now = 100;
  assert.equal(s.isAuthorized(facts), false);
  await s.close(); const next = store(m, () => now); await next.open(); assert.equal(next.isAuthorized(facts), false);
});

test('reentrant context or clock cannot authorize after revoke or close', async () => {
  for (const mode of ['proxy-revoke', 'proxy-close', 'clock-revoke', 'clock-close']) {
    const m = medium(); let action = null; let s;
    s = store(m, () => { if (action) { const run = action; action = null; run(); } return 100; });
    await s.open(); await s.grant(cap, 0, grant()); let pending;
    const run = () => { pending = mode.endsWith('revoke') ? s.revoke(cap) : s.close(); };
    let input = facts;
    if (mode.startsWith('clock')) action = run;
    else input = new Proxy(facts, { getPrototypeOf(target) { run(); return Reflect.getPrototypeOf(target); } });
    assert.equal(s.isAuthorized(input), false, mode); await pending;
  }
});

test('close during grant save leaves persisted grant disarmed on restart, not revoked', async () => {
  const m = medium(); const entered = deferred(), release = deferred(); const save = m.ports.save;
  m.ports.save = async v => { entered.resolve(); await release.promise; await save(v); };
  const s = store(m); await s.open(); const pending = s.grant(cap, 0, grant()); await entered.promise;
  const closing = s.close(); release.resolve(); await pending; await closing;
  assert.notEqual(m.state.value.grant, null); assert.equal(s.isAuthorized(facts), false);
  const restarted = store(m); await restarted.open(); assert.equal(restarted.isAuthorized(facts), false);
});
