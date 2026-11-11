/**
 * A07/A09/A10 — failure capture, dedupe and update-in-place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeHarness, optIn, captureQuotaFailure, driveResumeTicketToRunning,
  runningCount, SESSION_ID, PROVIDER, MODEL, WORKSPACE_ID, WORKSPACE_PATH,
} from './helpers.mjs';

test('A07: the same sessionId+failedStepId+generation produces exactly one ticket', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const first = await captureQuotaFailure(h);
  assert.equal(first.created, true);
  assert.equal(first.task.status, 'waiting_quota');
  const second = await captureQuotaFailure(h);
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.equal(second.taskId, first.taskId);
  assert.equal(h.service.list().tasks.length, 1);
  assert.equal(h.task(first.taskId).attempts, 2);
});

test('A07: a different failedStepId or generation is a different ticket', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const first = await captureQuotaFailure(h);
  const other = await captureQuotaFailure(h, { failedStepId: 'step-2' });
  const third = await captureQuotaFailure(h, { generation: '2' });
  assert.notEqual(other.taskId, first.taskId);
  assert.notEqual(third.taskId, first.taskId);
  assert.equal(h.service.list().tasks.length, 3);
});

test('A09: a second quota failure on a RUNNING task updates that task, never adds one', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await driveResumeTicketToRunning(h);
  assert.equal(h.task(ticket.taskId).status, 'running');
  assert.equal(runningCount(h), 1);

  const sameKey = await captureQuotaFailure(h);
  assert.equal(sameKey.created, false);
  assert.equal(sameKey.updated, true);
  assert.equal(sameKey.taskId, ticket.taskId);
  assert.equal(h.task(ticket.taskId).pendingQuotaWait, true);
  assert.equal(h.service.list().tasks.length, 1);

  const newKey = await captureQuotaFailure(h, { failedStepId: 'step-9', generation: '9' });
  assert.equal(newKey.created, false);
  assert.equal(newKey.taskId, ticket.taskId);
  assert.equal(h.service.list().tasks.length, 1);

  // The quota failure is honoured when the turn ends with an error.
  await h.service.observeClaim({ messageId: h.task(ticket.taskId).dispatchedMessageId, turnId: 'turn-1' });
  const settled = await h.service.observeTurnEnd({ sessionId: SESSION_ID, turnId: 'turn-1', reason: 'error' });
  assert.equal(settled.matched, true);
  assert.equal(h.task(ticket.taskId).status, 'waiting_quota');
});

test('A07: a settled (terminal) ticket key is never silently recreated', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  await h.service.cancelQueued({ taskId: ticket.taskId });
  assert.equal(h.task(ticket.taskId).status, 'cancelled');
  const again = await captureQuotaFailure(h);
  assert.equal(again.created, false);
  assert.equal(again.updated, false);
  assert.equal(again.settled, true);
  assert.equal(again.reason, 'already_settled');
  assert.equal(h.service.list().tasks.length, 1);
  assert.equal(h.task(ticket.taskId).status, 'cancelled');
});

test('captureFailure requires opt-in, a user task and complete failure identity', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  const notOptedIn = await captureQuotaFailure(h);
  assert.equal(notOptedIn.created, false);
  assert.equal(notOptedIn.reason, 'session_not_opted_in');
  await optIn(h);
  const background = await captureQuotaFailure(h, { background: true });
  assert.equal(background.created, false);
  assert.equal(background.reason, 'background_task');
  // Without POSITIVE user-task evidence nothing may be ticketed: a title or
  // summary model call is not the user's task.
  const missingProvenance = await h.service.captureFailure({
    sessionId: SESSION_ID, failedStepId: 'step-1', generation: '1', code: 'QUOTA',
    provider: PROVIDER, model: MODEL, workspaceId: WORKSPACE_ID,
  });
  assert.equal(missingProvenance.created, false);
  assert.equal(missingProvenance.reason, 'user_task_evidence_missing');
  const explicitFalse = await captureQuotaFailure(h, { userTask: false });
  assert.equal(explicitFalse.created, false);
  assert.equal(explicitFalse.reason, 'user_task_evidence_missing');
  assert.equal(h.service.list().tasks.length, 0);
  const rateLimited = await captureQuotaFailure(h, { code: 'RATE_LIMIT', status: 429 });
  assert.equal(rateLimited.created, false);
  assert.equal(rateLimited.reason, 'failure_class:rate_limit');
  await assert.rejects(
    captureQuotaFailure(h, { generation: 7 }),
    (error) => error.code === 'INVALID_INPUT' && error.details.includes('generation'),
  );
  await assert.rejects(
    captureQuotaFailure(h, { failedStepId: '' }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('A10: captureFailure rejects raw error text, URLs, headers and tokens', { timeout: 10_000 }, async () => {
  const h = await makeHarness();
  await optIn(h);
  for (const field of ['message', 'url', 'headers', 'token', 'rawBody']) {
    await assert.rejects(
      captureQuotaFailure(h, { [field]: 'https://evil.example/secret' }),
      (error) => error.code === 'INVALID_INPUT' && error.details.includes(field),
      field,
    );
  }
  assert.equal(h.service.list().tasks.length, 0);
});

test('captureFailure refuses to invent workspace or route', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ session: { facts: { workspaceId: undefined } } });
  await optIn(h);
  const created = await captureQuotaFailure(h, { workspaceId: undefined });
  assert.equal(created.created, false);
  assert.equal(created.reason, 'workspace_unresolved');
  const h2 = await makeHarness({ session: { facts: { provider: undefined, model: undefined } } });
  await optIn(h2);
  const noRoute = await captureQuotaFailure(h2, { provider: undefined, model: undefined });
  assert.equal(noRoute.created, false);
  assert.equal(noRoute.reason, 'route_unresolved');
});

test('B08: Goal / always-retry ownership conflicts are captured as needs_attention', { timeout: 10_000 }, async () => {
  const h = await makeHarness({ session: { facts: { goalOwned: true } } });
  await optIn(h);
  const ticket = await captureQuotaFailure(h);
  assert.equal(ticket.created, true);
  assert.equal(ticket.task.status, 'needs_attention');
  assert.equal(ticket.task.needsAttentionReason, 'ownership_conflict:goal');
  const report = await h.service.tick();
  assert.equal(report.dispatched.length, 0);

  const h2 = await makeHarness({ session: { facts: { alwaysRetry: true } } });
  await optIn(h2);
  const ticket2 = await captureQuotaFailure(h2);
  assert.equal(ticket2.task.needsAttentionReason, 'ownership_conflict:always_retry');
});
