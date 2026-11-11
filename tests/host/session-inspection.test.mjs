/**
 * The plugin-local SessionInspection port.
 *
 * DSH 0.2.2 retired SessionController.inspect. The port re-implements the same
 * read over the public sessionQuery observation seam; these tests pin the shape,
 * the cancellation and projection options, and the lease release that keeps the
 * bounded observation cache from being pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionInspection, SessionInspectionUnavailable } from '../../host/session-inspection.js';

function inspectionFor(id = 's1') {
  return {
    meta: { id, version: 4, isSeeded: false, cwd: 'E:/ws' },
    inheritedEventCount: 0,
    events: [{ seq: 0, type: 'turn/start', data: { turn: 1 } }],
  };
}

test('maps the observation to the retired SessionInspection shape and releases the lease', async () => {
  const inspection = inspectionFor();
  const seen = [];
  let disposed = 0;
  const query = {
    async observeSession(sessionId, options) {
      seen.push({ sessionId, options });
      return {
        source: 'live',
        header: inspection.meta,
        inheritedEventCount: inspection.inheritedEventCount,
        get events() { return inspection.events; },
        [Symbol.dispose]() { disposed += 1; },
      };
    },
  };
  const port = createSessionInspection(() => query);
  assert.equal(port.available, true);
  const signal = new AbortController().signal;
  assert.deepEqual(await port.inspect('s1', signal), inspection);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 's1');
  assert.equal(seen[0].options.projectionMode, 'none');
  assert.equal(seen[0].options.signal, signal);
  assert.equal(disposed, 1);
});

test('a missing seam is unavailable per call and never latched', async () => {
  let query;
  const port = createSessionInspection(() => query);
  assert.equal(port.available, false);
  await assert.rejects(port.inspect('s1'), (error) => {
    assert.equal(error instanceof SessionInspectionUnavailable, true);
    assert.equal(error.code, 'session_inspection_unavailable');
    return true;
  });
  query = {
    async observeSession() {
      return { header: inspectionFor().meta, inheritedEventCount: 0, events: [], [Symbol.dispose]() {} };
    },
  };
  assert.equal(port.available, true);
  assert.equal((await port.inspect('s1')).meta.id, 's1');
});

test('a throwing resolver is unavailable, a read failure propagates, and the lease still releases', async () => {
  const throwing = createSessionInspection(() => { throw new Error('private'); });
  assert.equal(throwing.available, false);
  await assert.rejects(throwing.inspect('s1'), (error) => error.code === 'session_inspection_unavailable');

  let disposed = 0;
  const failing = createSessionInspection(() => ({
    async observeSession() {
      return {
        header: inspectionFor().meta,
        inheritedEventCount: 0,
        get events() { throw new Error('private'); },
        [Symbol.dispose]() { disposed += 1; },
      };
    },
  }));
  await assert.rejects(failing.inspect('s1'));
  assert.equal(disposed, 1);
});
