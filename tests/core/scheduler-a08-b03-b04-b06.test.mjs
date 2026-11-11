/**
 * A08 / B03 / B04 / B06 — scheduling, concurrency, settlement and cold resume.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, claimBlockedBy, CONTINUE_ORIGINAL_KEYS } from '../../core/index.mjs';
import {
  makeHarness, addManualTask, optIn, captureQuotaFailure, advanceAndTick,
  driveNewTaskToRunning, driveResumeTicketToRunning, runningCount, deferred,
  availableSnapshot, WORKSPACE_ID, WORKSPACE_PATH, PROVIDER, MODEL, SESSION_ID, ISO,
} from './helpers.mjs';

const SCOPE = 'qs:["provider-a","model-a","default","global"]';

test('A08: simultaneous expiry of one scope performs exactly one query', { timeout: 10_000 }, async () => {
  const gate = deferred();
  const h = await makeHarness({
    quota: async (scope) => {
      await gate.promise;
      return availableSnapshot({ scopeKey: scope.scopeKey, observedAt: h.clock.iso() });
    },
  });
  const first = h.service.checkQuota({ scopeKey: SCOPE });
  const second = h.service.checkQuota({ scopeKey: SCOPE });
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.quota.calls.check.length, 1);
  assert.equal(h.quota.stats.maxConcurrent, 1);
  assert.deepEqual(a, b);
});

test('A08/A10: the quota port receives only the scope key', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await h.service.checkQuota({ scopeKey: SCOPE });
  assert.deepEqual(Object.keys(h.quota.calls.check[0]), ['scopeKey']);
  assert.equal(h.quota.calls.check[0].scopeKey, SCOPE);
  assert.equal(typeof h.service.resetQuota, 'undefined');
  assert.equal(typeof h.service.queryUpstream, 'undefined');
});

test('A08: concurrent ticks cannot double-start tasks in different workspaces', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await addManualTask(h, { taskId: 'task-a', sessionId: 'sess-a', workspaceId: 'ws-a', workspacePath: 'E:/ws/a' });
  await addManualTask(h, { taskId: 'task-b', sessionId: 'sess-b', workspaceId: 'ws-b', workspacePath: 'E:/ws/b' });
  await h.service.tick();
  const [first, second] = await Promise.all([h.service.tick(), h.service.tick()]);
  const started = [...first.dispatched, ...second.dispatched].filter((entry) => entry.dispatched);
  assert.equal(started.length, 1);
  assert.equal(runningCount(h), 1);
  assert.equal(h.session.calls.startNew.length, 1);
});

test('A08: the global/workspace/session claim predicate is explicit', () => {
  const base = { id: 'candidate', status: 'queued', workspaceId: 'ws-a', sessionId: 'sess-a' };
  assert.equal(claimBlockedBy([], base, 1), null);
  const runningOther = { id: 'other', status: 'running', workspaceId: 'ws-b', sessionId: 'sess-b' };
  assert.equal(claimBlockedBy([runningOther], base, 1), 'global_concurrency');
  assert.equal(claimBlockedBy([runningOther], { ...base, workspaceId: 'ws-b' }, 2), 'workspace_or_session_lock');
  assert.equal(claimBlockedBy([runningOther], { ...base, workspaceId: 'ws-b', sessionId: 'sess-b' }, 2), 'workspace_or_session_lock');
  assert.equal(claimBlockedBy([runningOther], { ...base, workspaceId: 'ws-a', sessionId: 'sess-a' }, 2), null);
  // A held execution fence occupies its slot even when the task is no longer running.
  const fencedOther = { id: 'other', status: 'needs_attention', executionFence: true, workspaceId: 'ws-b', sessionId: 'sess-b' };
  assert.equal(claimBlockedBy([fencedOther], base, 1), 'global_concurrency');
  assert.equal(claimBlockedBy([fencedOther], { ...base, workspaceId: 'ws-b' }, 2), 'workspace_or_session_lock');
  assert.equal(claimBlockedBy([fencedOther], { ...base, workspaceId: 'ws-c', sessionId: 'sess-c' }, 2), null);
  assert.equal(claimBlockedBy([{ ...fencedOther, executionFence: false }], base, 1), null);
});

test('B03: an expired lease never starts a second executor', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await driveNewTaskToRunning(h);
  assert.equal(h.task(task.id).status, 'running');
  const starts = h.session.calls.startNew.length;
  h.clock.advance(6 * 60 * 60 * 1000);
  const report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);
  assert.equal(h.session.calls.startNew.length, starts);
  await h.service.recover();
  assert.equal(h.task(task.id).status, 'needs_attention');
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, starts);
  assert.equal(runningCount(h), 0);
});

test('B04: only messageId -> claimed.turn -> turn/end decides completion', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await driveNewTaskToRunning(h);
  const running = h.task(task.id);
  assert.equal(running.status, 'running');
  assert.equal(running.claimedTurnId, null);
  assert.ok(running.dispatchedMessageId.startsWith('t-message-'));

  const noClaim = await h.service.observeTurnEnd({ sessionId: task.sessionId, turnId: 'turn-9', reason: 'completed' });
  assert.deepEqual(noClaim, { matched: false });

  for (const reason of ['idle', 'whenIdle', 'receipt', 'schedule', 'session/disposed']) {
    await assert.rejects(
      h.service.observeTurnEnd({ sessionId: task.sessionId, turnId: 'turn-1', reason }),
      (error) => error.code === 'INVALID_INPUT',
      reason,
    );
  }
  await assert.rejects(
    h.service.observeTurnEnd({ turnId: 'turn-1', reason: 'completed' }),
    (error) => error.code === 'INVALID_INPUT' && error.details.includes('sessionId'),
  );

  await h.service.observeClaim({ messageId: running.dispatchedMessageId, turnId: 'turn-1' });
  assert.equal(h.task(task.id).status, 'running');
  const settled = await h.service.observeTurnEnd({ sessionId: task.sessionId, turnId: 'turn-1', reason: 'completed' });
  assert.equal(settled.matched, true);
  assert.equal(h.task(task.id).status, 'completed');
  assert.equal(h.task(task.id).executionFence, false, 'a persistent turn end releases the execution fence');
});

test('B04: a session-local turn number cannot settle another session', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const now = h.clock.iso();
  await h.store.update((draft) => {
    for (const id of ['a', 'b']) {
      draft.tasks.push(createTask({
        id: `task-${id}`,
        kind: 'new-session',
        prompt: 'p',
        workspaceId: `ws-${id}`,
        provider: PROVIDER,
        model: MODEL,
        quotaScopeKey: SCOPE,
        sessionId: `sess-${id}`,
        dedupeKey: `manual:task-${id}`,
        status: 'running',
        dispatchedMessageId: `msg-${id}`,
        claimedTurnId: '1',
        createdAt: now,
        updatedAt: now,
      }));
      draft.dedupeIndex[`manual:task-${id}`] = `task-${id}`;
    }
  });
  const settled = await h.service.observeTurnEnd({ sessionId: 'sess-a', turnId: '1', reason: 'completed' });
  assert.equal(settled.taskId, 'task-a');
  assert.equal(h.task('task-a').status, 'completed');
  assert.equal(h.task('task-b').status, 'running');
});

test('B04: a repeated claim never overwrites a different recorded turn', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await driveNewTaskToRunning(h);
  const messageId = h.task(task.id).dispatchedMessageId;
  await h.service.observeClaim({ messageId, turnId: 'turn-1' });
  const conflict = await h.service.observeClaim({ messageId, turnId: 'turn-2' });
  assert.equal(conflict.matched, true);
  assert.equal(conflict.conflict, 'turn_already_claimed');
  assert.equal(h.task(task.id).claimedTurnId, 'turn-1');
});

test('B06: resume dispatch uses the original cwd/route and inherits policy', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await driveResumeTicketToRunning(h);
  const request = h.session.calls.continueOriginal.at(-1);
  assert.deepEqual(Object.keys(request).sort(), [...CONTINUE_ORIGINAL_KEYS].sort());
  assert.equal(request.cwd, WORKSPACE_PATH);
  assert.equal(request.workspaceId, WORKSPACE_ID);
  assert.equal(request.provider, PROVIDER);
  assert.equal(request.model, MODEL);
  assert.equal(request.policy, 'inherit');
  assert.equal(request.sessionRevision, 'rev-1');
  assert.ok(!Object.prototype.hasOwnProperty.call(request, 'prompt'));
  void ticket;
});

test('B06: a changed workspace, route, revision or running session blocks resume', { timeout: 10_000 }, async () => {
  for (const [label, facts, expected] of [
    ['cwd moved', { cwd: 'E:/ws/moved' }, 'workspace_path_changed'],
    ['route changed', { model: 'other-model' }, 'route_changed'],
    ['session already running', { running: true }, 'session_already_running'],
    ['ownership conflict', { alwaysRetry: true }, 'ownership_conflict'],
    ['facts incomplete', { cwd: undefined }, 'session_facts_incomplete:cwd'],
  ]) {
    const h = await makeHarness({ session: { facts } });
    await optIn(h);
    const ticket = await captureQuotaFailure(h);
    await driveResumeTicketToRunning(h);
    assert.equal(h.session.calls.continueOriginal.length, 0, label);
    assert.equal(h.task(ticket.taskId).status, 'needs_attention', label);
    const reason = h.task(ticket.taskId).needsAttentionReason;
    assert.ok(reason.includes(expected), `${label}: ${reason}`);
  }
});

test('B06: a session revision change between capture and dispatch blocks resume', { timeout: 10_000 }, async () => {
  let inspections = 0;
  const h = await makeHarness({
    session: {
      inspect: (sessionId) => {
        inspections += 1;
        return {
          sessionId,
          workspaceId: WORKSPACE_ID,
          cwd: WORKSPACE_PATH,
          provider: PROVIDER,
          model: MODEL,
          revision: inspections === 1 ? 'rev-1' : 'rev-2',
          running: false,
          goalOwned: false,
          alwaysRetry: false,
        };
      },
    },
  });
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await driveResumeTicketToRunning(h);
  assert.equal(h.session.calls.continueOriginal.length, 0);
  assert.equal(h.task(ticket.taskId).needsAttentionReason, 'session_revision_changed');
});

test('B06: runnable manual work requires explicit authorization', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const unauthorized = await h.service.addManual({
    prompt: 'p', workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH, provider: PROVIDER, model: MODEL,
  });
  assert.equal(unauthorized.status, 'draft');
  assert.equal(unauthorized.autoResume, false);
  let report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);
  assert.equal(h.session.calls.startNew.length, 0);

  const authorized = await h.service.editPending({ taskId: unauthorized.id, patch: { autoResume: true } });
  assert.equal(authorized.status, 'queued');
  await h.service.tick();
  report = await h.service.tick();
  assert.equal(report.dispatched.length, 1);
  assert.equal(h.session.calls.startNew.length, 1);
  assert.equal(h.task(unauthorized.id).status, 'running');
});

test('resume tickets are paused when the session opt-in is revoked', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await h.service.setSessionOptIn({ sessionId: SESSION_ID, optIn: false, actor: 'user' });
  await h.service.tick();
  assert.equal(h.task(ticket.taskId).status, 'paused');
  assert.equal(h.task(ticket.taskId).resolution, 'session_opt_in_revoked');
  const scopeKey = h.task(ticket.taskId).quotaScopeKey;
  await h.clock.advance(10 * 60 * 1000);
  await h.service.checkQuota({ scopeKey });
  const report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);
  assert.equal(h.session.calls.continueOriginal.length, 0);
});

test('dispatch uses the claimed record, not the stale candidate', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await h.service.tick();
  // The bound session/route are read back from the atomic claim.
  await h.service.tick();
  const request = h.session.calls.startNew.at(-1);
  assert.equal(request.sessionId, task.sessionId);
  assert.equal(request.taskId, task.id);
  assert.equal(h.task(task.id).dispatchedMessageId, request.messageId);
  void ISO;
  void advanceAndTick;
});
