/**
 * B02/B05/B07/B08 — restart reconciliation, stop semantics and ownership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeHarness, addManualTask, optIn, captureQuotaFailure, driveResumeTicketToRunning,
  driveNewTaskToRunning, reopenPort, memoryStorePort, advanceAndTick, runningCount,
  fullCapabilities, WORKSPACE_ID, WORKSPACE_PATH, PROVIDER, MODEL, SESSION_ID,
} from './helpers.mjs';

test('B02: restart preserves draft/queued/waiting/paused and reconciles a leftover running task', { timeout: 10_000 }, async () => {
  const storePort = memoryStorePort();
  const h1 = await makeHarness({ storePort });
  const draftTask = await h1.service.addManual({
    title: 'draft', prompt: 'p', workspaceId: WORKSPACE_ID, workspacePath: WORKSPACE_PATH, provider: PROVIDER, model: MODEL,
  });
  const runningTask = await addManualTask(h1, { taskId: 'task-run', sessionId: 'session-run' });
  await driveNewTaskToRunning(h1);
  assert.equal(h1.task(runningTask.id).status, 'running');

  await optIn(h1, SESSION_ID);
  const waitingTicket = await captureQuotaFailure(h1);
  await optIn(h1, 'session-2');
  const pausedTicket = await captureQuotaFailure(h1, { sessionId: 'session-2', failedStepId: 'step-2', generation: '2' });
  await h1.service.setSessionOptIn({ sessionId: 'session-2', optIn: false, actor: 'user' });
  await h1.service.tick();
  assert.equal(h1.task(pausedTicket.taskId).status, 'paused');

  const h2 = await makeHarness({ storePort: reopenPort(storePort) });
  assert.equal(h2.task(draftTask.id).status, 'draft');
  assert.equal(h2.task(runningTask.id).status, 'running');
  assert.equal(h2.task(waitingTicket.taskId).status, 'waiting_quota');
  assert.equal(h2.task(pausedTicket.taskId).status, 'paused');
  assert.equal(h2.service.list().tasks.length, 4);

  const report = await h2.service.recover();
  assert.ok(report.needsAttention.includes(runningTask.id));
  assert.equal(h2.task(runningTask.id).status, 'needs_attention');
  assert.equal(h2.task(runningTask.id).needsAttentionReason, 'unreconciled_new_session_after_restart');
  assert.equal(h2.task(draftTask.id).status, 'draft');
  assert.equal(h2.task(waitingTicket.taskId).status, 'waiting_quota');
  assert.equal(h2.task(pausedTicket.taskId).status, 'paused');

  await h2.service.tick();
  assert.equal(h2.session.calls.startNew.length, 0, 'a restart never blindly restarts work');
  assert.equal(runningCount(h2), 0);
});

test('B07: a crash between create and delivery keeps the slot and is never re-created', { timeout: 10_000 }, async () => {
  const h = await makeHarness({
    session: { startNew: async () => { throw new Error('delivery blew up'); } },
  });
  const task = await addManualTask(h, { taskId: 'task-a', sessionId: 'stable-session-1' });
  await driveNewTaskToRunning(h);
  const after = h.task(task.id);
  assert.equal(after.status, 'running');
  assert.equal(after.dispatchUncertain, true);
  assert.equal(after.needsAttentionReason, 'dispatch_outcome_unknown:dispatch_failed');
  assert.equal(h.session.calls.prepareNew.length, 1);
  assert.equal(h.session.calls.startNew.length, 1);

  const blocked = await addManualTask(h, { taskId: 'task-b', sessionId: 'session-b' });
  const report = await h.service.tick();
  assert.equal(report.dispatched.filter((entry) => entry.dispatched).length, 0, 'the uncertain dispatch keeps the only execution slot');
  assert.equal(h.task(blocked.id).status, 'queued');

  await h.service.recover();
  assert.equal(h.task(task.id).status, 'needs_attention');
  assert.equal(h.task(task.id).needsAttentionReason, 'dispatch_outcome_unknown');
  assert.equal(h.task(task.id).sessionId, 'stable-session-1', 'the stable sessionId is preserved');
  await h.service.tick();
  const preparesForTaskA = h.session.calls.prepareNew.filter((request) => request.taskId === task.id);
  assert.equal(preparesForTaskA.length, 1, 'the session is never created twice');
  assert.equal(h.task(task.id).executionFence, true, 'the fence outlives the status change');
  assert.equal(h.task(blocked.id).status, 'queued', 'the fence keeps the slot until the host proves it stopped');
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 1, 'no second execution while the fence is held');
});

/** Reconcile evidence that echoes the request, with deliberate overrides. */
function reconcileEcho(overrides = {}) {
  return async (request) => ({
    outcome: 'completed',
    sessionId: request.sessionId,
    messageId: request.messageId,
    claimedTurnId: request.claimedTurnId,
    turnEndReason: 'completed',
    ...overrides,
  });
}

async function recoverWith(reconcile, { claim = true, capabilities = undefined, taskId = 'task-a' } = {}) {
  const h = await makeHarness({
    ...(capabilities === undefined ? {} : { capabilities }),
    session: { reconcile },
  });
  const task = await addManualTask(h, { taskId, sessionId: 'session-a' });
  await driveNewTaskToRunning(h);
  if (claim) await h.service.observeClaim({ messageId: h.task(task.id).dispatchedMessageId, turnId: 'turn-1' });
  await h.service.recover();
  return { h, task };
}

test('B03: an unproven execution fence blocks every later claim', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ session: { startNew: async () => { throw new Error('delivery blew up'); } } });
  const first = await addManualTask(h, { taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-a', workspacePath: 'E:/ws/a' });
  await driveNewTaskToRunning(h);
  await h.service.recover();
  assert.equal(h.task(first.id).status, 'needs_attention');
  assert.equal(h.task(first.id).executionFence, true);
  assert.equal(h.task(first.id).fenceReason, 'dispatch_outcome_unknown:dispatch_failed');
  assert.equal(h.service.list().executionFences.length, 1);

  const second = await addManualTask(h, { taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-b', workspacePath: 'E:/ws/b' });
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 1, 'a different workspace cannot start either');
  assert.equal(h.task(second.id).status, 'queued');

  await h.service.pauseDispatch({ paused: true });
  await h.service.pauseDispatch({ paused: false });
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 1, 'pauseDispatch(false) does not bypass the fence');

  // Past the 5-minute lease, well inside the 24-hour max-wait guard.
  h.clock.advance(10 * 60 * 1000);
  await h.service.recover();
  assert.equal(h.task(first.id).executionFence, true, 'lease expiry never releases a fence');
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 1);

  await assert.rejects(
    h.service.resolveExecutionFence({ taskId: first.id, actor: 'user' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    h.service.resolveExecutionFence({ taskId: first.id, hostStopped: true, actor: 'model' }),
    (error) => error.code === 'AUTHORIZATION_DENIED',
  );
  assert.equal(h.task(first.id).executionFence, true);

  const released = await h.service.resolveExecutionFence({ taskId: first.id, hostStopped: true, actor: 'user' });
  assert.equal(released.released, true);
  assert.equal(released.releasedBy, 'fence_released_host_stopped');
  assert.equal(h.task(first.id).executionFence, false);
  await h.service.tick();
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 2, 'the queue resumes only after positive stop evidence');
  assert.equal(h.task(second.id).status, 'running');
});

test('B03: a crash leftover with unknown reconcile keeps the fence until evidence arrives', { timeout: 10_000 }, async () => {
  let evidenceFactory = null;
  const h = await makeHarness({
    session: { reconcile: async (request) => (evidenceFactory === null ? null : evidenceFactory(request)) },
  });
  const first = await addManualTask(h, { taskId: 'task-a', sessionId: 'session-a', workspaceId: 'ws-a', workspacePath: 'E:/ws/a' });
  await driveNewTaskToRunning(h);
  await h.service.observeClaim({ messageId: h.task(first.id).dispatchedMessageId, turnId: 'turn-1' });

  await h.service.recover();
  assert.equal(h.task(first.id).status, 'needs_attention');
  assert.equal(h.task(first.id).executionFence, true);
  assert.equal(h.task(first.id).needsAttentionReason, 'unreconciled_new_session_after_restart');

  const second = await addManualTask(h, { taskId: 'task-b', sessionId: 'session-b', workspaceId: 'ws-b', workspacePath: 'E:/ws/b' });
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 1, 'the fence blocks the next task');

  // Completed evidence with the wrong turn still proves nothing.
  evidenceFactory = (request) => ({
    outcome: 'completed', sessionId: request.sessionId, messageId: request.messageId,
    claimedTurnId: 'turn-other', turnEndReason: 'completed',
  });
  await h.service.recover();
  assert.equal(h.task(first.id).status, 'needs_attention');
  assert.equal(h.task(first.id).needsAttentionReason, 'reconcile_turn_evidence_missing');
  assert.equal(h.task(first.id).executionFence, true);

  // Fully matching evidence settles it and releases the fence.
  evidenceFactory = (request) => ({
    outcome: 'completed', sessionId: request.sessionId, messageId: request.messageId,
    claimedTurnId: request.claimedTurnId, turnEndReason: 'completed',
  });
  await h.service.recover();
  assert.equal(h.task(first.id).status, 'completed');
  assert.equal(h.task(first.id).executionFence, false);
  assert.equal(h.service.list().executionFences.length, 0);
  await h.service.tick();
  assert.equal(h.session.calls.startNew.length, 2, 'the released slot is usable again');
  assert.equal(h.task(second.id).status, 'running');
});

test('B03: fence release accepts only matching terminal turn evidence', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a', sessionId: 'session-a' });
  await driveNewTaskToRunning(h);
  await h.service.observeClaim({ messageId: h.task(task.id).dispatchedMessageId, turnId: 'turn-1' });
  await h.service.recover();
  assert.equal(h.task(task.id).executionFence, true);

  await assert.rejects(
    h.service.resolveExecutionFence({ taskId: task.id, turnEnd: { sessionId: 'session-a', turnId: 'turn-9', reason: 'completed' }, actor: 'host' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    h.service.resolveExecutionFence({ taskId: task.id, turnEnd: { sessionId: 'session-other', turnId: 'turn-1', reason: 'completed' }, actor: 'host' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    h.service.resolveExecutionFence({ taskId: task.id, turnEnd: { sessionId: 'session-a', turnId: 'turn-1', reason: 'idle' }, actor: 'host' }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.equal(h.task(task.id).executionFence, true);

  const released = await h.service.resolveExecutionFence({
    taskId: task.id,
    turnEnd: { sessionId: 'session-a', turnId: 'turn-1', reason: 'completed' },
    actor: 'host',
  });
  assert.equal(released.releasedBy, 'fence_released_turn_completed');
  assert.equal(h.task(task.id).executionFence, false);
});

test('B07: outcome=completed alone is never enough to settle a task', { timeout: 10_000 }, async () => {
  const noClaim = await recoverWith(reconcileEcho(), { claim: false });
  assert.equal(noClaim.h.task(noClaim.task.id).status, 'needs_attention');
  assert.equal(noClaim.h.task(noClaim.task.id).needsAttentionReason, 'reconcile_turn_evidence_missing');

  const wrongReason = await recoverWith(reconcileEcho({ turnEndReason: 'error' }));
  assert.equal(wrongReason.h.task(wrongReason.task.id).needsAttentionReason, 'reconcile_turn_evidence_missing');

  const wrongTurn = await recoverWith(reconcileEcho({ claimedTurnId: 'turn-other' }));
  assert.equal(wrongTurn.h.task(wrongTurn.task.id).needsAttentionReason, 'reconcile_turn_evidence_missing');

  const wrongMessage = await recoverWith(reconcileEcho({ messageId: 'message-other' }));
  assert.equal(wrongMessage.h.task(wrongMessage.task.id).needsAttentionReason, 'reconcile_message_mismatch');

  const wrongSession = await recoverWith(reconcileEcho({ sessionId: 'session-other' }));
  assert.equal(wrongSession.h.task(wrongSession.task.id).needsAttentionReason, 'reconcile_session_mismatch');
});

test('B07: a fully matching persistent turn evidence settles as completed', { timeout: 10_000 }, async () => {
  const { h, task } = await recoverWith(reconcileEcho());
  assert.equal(h.task(task.id).status, 'completed');
  assert.equal(h.task(task.id).resolution, 'reconciled_completed');
});

test('B07: aborted-after-stop and failed-with-quota-wait need matching identity too', { timeout: 10_000 }, async () => {
  async function runningTask(reconcile) {
    const h = await makeHarness({ session: { reconcile } });
    const task = await addManualTask(h, { taskId: 'task-a', sessionId: 'session-a' });
    await driveNewTaskToRunning(h);
    return { h, task };
  }

  const stopped = await runningTask(reconcileEcho({ outcome: 'aborted' }));
  await stopped.h.service.requestStop({ taskId: stopped.task.id });
  await stopped.h.service.recover();
  assert.equal(stopped.h.task(stopped.task.id).status, 'paused');
  assert.equal(stopped.h.task(stopped.task.id).resolution, 'stopped_by_user');

  const mismatchedAbort = await runningTask(reconcileEcho({ outcome: 'aborted', messageId: 'message-other' }));
  await mismatchedAbort.h.service.requestStop({ taskId: mismatchedAbort.task.id });
  await mismatchedAbort.h.service.recover();
  assert.equal(mismatchedAbort.h.task(mismatchedAbort.task.id).status, 'needs_attention');
  assert.equal(mismatchedAbort.h.task(mismatchedAbort.task.id).needsAttentionReason, 'reconcile_message_mismatch');

  const quotaWait = await makeHarness({ session: { reconcile: reconcileEcho({ outcome: 'failed' }) } });
  await optIn(quotaWait, 'session-a');
  const quotaTask = await addManualTask(quotaWait, { taskId: 'task-q', sessionId: 'session-a' });
  await driveNewTaskToRunning(quotaWait);
  const captured = await captureQuotaFailure(quotaWait, { sessionId: 'session-a' });
  assert.equal(captured.updated, true);
  assert.equal(quotaWait.task(quotaTask.id).pendingQuotaWait, true);
  await quotaWait.service.recover();
  assert.equal(quotaWait.task(quotaTask.id).status, 'waiting_quota');
});

test('B07: a fully matching completed reconcile is required before any requeue', { timeout: 10_000 }, async () => {
  const { h, task } = await recoverWith(reconcileEcho());
  assert.equal(h.task(task.id).status, 'completed');
  const report = await h.service.tick();
  assert.equal(report.dispatched.filter((entry) => entry.dispatched).length, 0);
});

/** not-dispatched evidence that echoes the request plus explicit host claims. */
function notDispatchedEcho(overrides = {}) {
  return async (request) => ({
    outcome: 'not-dispatched',
    sessionId: request.sessionId,
    messageId: request.messageId,
    hostStopped: true,
    sessionCreated: false,
    ...overrides,
  });
}

async function recoverNewSession(capabilities, overrides) {
  const h = await makeHarness({
    ...(capabilities === undefined ? {} : { capabilities }),
    session: { reconcile: notDispatchedEcho(overrides) },
  });
  const task = await addManualTask(h, { taskId: 'task-a', sessionId: 'session-a' });
  await driveNewTaskToRunning(h);
  await h.service.recover();
  return { h, task };
}

test('B07: not-dispatched needs host-stop proof, proven non-creation and both idempotencies', { timeout: 10_000 }, async () => {
  const ok = await recoverNewSession(fullCapabilities(), {});
  assert.equal(ok.h.task(ok.task.id).status, 'queued');
  assert.equal(ok.h.task(ok.task.id).sessionId, 'session-a', 'the same stable sessionId is reused');

  const hostStateUnknown = await recoverNewSession(fullCapabilities(), { hostStopped: undefined });
  assert.equal(hostStateUnknown.h.task(hostStateUnknown.task.id).needsAttentionReason, 'host_stop_state_unknown');

  const maybeCreated = await recoverNewSession(fullCapabilities(), { sessionCreated: undefined });
  assert.equal(maybeCreated.h.task(maybeCreated.task.id).needsAttentionReason, 'session_may_exist_unverified');
  const createdAlready = await recoverNewSession(fullCapabilities(), { sessionCreated: true });
  assert.equal(createdAlready.h.task(createdAlready.task.id).needsAttentionReason, 'session_may_exist_unverified');

  // Idempotent CREATE alone is not message idempotency.
  const noDeliveryIdempotency = await recoverNewSession({ ...fullCapabilities(), messageIdempotentDelivery: false }, {});
  assert.equal(noDeliveryIdempotency.h.task(noDeliveryIdempotency.task.id).needsAttentionReason, 'requeue_not_idempotent');

  const noCreateIdempotency = await recoverNewSession({ ...fullCapabilities(), sessionIdempotentCreate: false }, {});
  assert.equal(noCreateIdempotency.h.task(noCreateIdempotency.task.id).needsAttentionReason, 'requeue_not_idempotent');
});

test('B07: a resume ticket requeues only with proven host stop and message idempotency', { timeout: 10_000 }, async () => {
  const capable = await makeHarness({ session: { reconcile: notDispatchedEcho({ sessionCreated: undefined }) } });
  await optIn(capable, SESSION_ID);
  const ticket = await captureQuotaFailure(capable);
  await driveResumeTicketToRunning(capable);
  await capable.service.recover();
  assert.equal(capable.task(ticket.taskId).status, 'queued');

  const uncapable = await makeHarness({
    capabilities: { ...fullCapabilities(), messageIdempotentDelivery: false },
    session: { reconcile: notDispatchedEcho({ sessionCreated: undefined }) },
  });
  await optIn(uncapable, SESSION_ID);
  const other = await captureQuotaFailure(uncapable);
  await driveResumeTicketToRunning(uncapable);
  await uncapable.service.recover();
  assert.equal(uncapable.task(other.taskId).status, 'needs_attention');
  assert.equal(uncapable.task(other.taskId).needsAttentionReason, 'message_delivery_not_idempotent');
});

test('B05: a user stop pauses the task and never re-queues it', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const task = await addManualTask(h, { taskId: 'task-a' });
  await driveNewTaskToRunning(h);
  const stop = await h.service.requestStop({ taskId: task.id });
  assert.equal(stop.requested, true);
  assert.equal(stop.awaitingConfirmation, true);
  assert.equal(h.task(task.id).status, 'running', 'the slot is held until the host confirms');
  assert.deepEqual(h.session.calls.requestStop[0], { taskId: task.id, sessionId: task.sessionId, policy: 'inherit' });

  await h.service.observeClaim({ messageId: h.task(task.id).dispatchedMessageId, turnId: 'turn-1' });
  await h.service.observeTurnEnd({ sessionId: task.sessionId, turnId: 'turn-1', reason: 'aborted' });
  assert.equal(h.task(task.id).status, 'paused');
  assert.equal(h.task(task.id).resolution, 'stopped_by_user');
  const report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);
  assert.equal(h.session.calls.startNew.length, 1);
  assert.equal(runningCount(h), 0);
});

test('B05: manual continuation dissolves outstanding recovery tickets', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const first = await captureQuotaFailure(h);
  const second = await captureQuotaFailure(h, { failedStepId: 'step-2' });
  const result = await h.service.manualContinued({ sessionId: SESSION_ID });
  assert.deepEqual([...result.resolved].sort(), [first.taskId, second.taskId].sort());
  assert.equal(h.task(first.taskId).status, 'cancelled');
  assert.equal(h.task(first.taskId).resolution, 'manual_continue');
  await h.service.tick();
  await advanceAndTick(h, 10 * 60 * 1000);
  await h.service.tick();
  assert.equal(h.session.calls.continueOriginal.length, 0, 'the background ticket never runs again');
});

test('B05: manual continuation while a task is running flags a conflict without releasing the slot', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await driveResumeTicketToRunning(h);
  assert.equal(h.task(ticket.taskId).status, 'running');
  const result = await h.service.manualContinued({ sessionId: SESSION_ID });
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.runningConflicts, [ticket.taskId]);
  assert.equal(h.task(ticket.taskId).status, 'running');
  assert.equal(h.task(ticket.taskId).stopRequested, true);
  assert.equal(runningCount(h), 1);
});

test('B08: an ownership conflict discovered at dispatch time blocks execution', { timeout: 10_000 }, async () => {
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
          revision: 'rev-1',
          running: false,
          goalOwned: inspections > 1,
          alwaysRetry: false,
        };
      },
    },
  });
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await driveResumeTicketToRunning(h);
  assert.equal(h.session.calls.continueOriginal.length, 0);
  assert.equal(h.task(ticket.taskId).status, 'needs_attention');
  assert.equal(h.task(ticket.taskId).needsAttentionReason, 'ownership_conflict');
  const report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);
});
