import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../../scripts/verify-continue.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function run(events) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-continue-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, events.map((e, i) => JSON.stringify({ seq: i, ...e })).join('\n'));
  const out = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

const human = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const goalRound = () => ({ type: 'user/message', data: { source: { kind: 'goal', goalId: 'g', revision: 1, round: 1 }, content: [] } });
const resume = (revision) => ({ type: 'goal/change', data: { operation: 'resume', goal: { revision, phase: 'active' } } });

test('no resume is reported as such', () => {
  const r = run([human('task'), goalRound()]);
  assert.equal(r.verdict, 'no_goal_resume_observed');
  assert.equal(r.humanMessages, 1);
  assert.equal(r.goalRounds, 1);
  assert.deepEqual(r.lastHumanMessage, { seq: 0, turn: null });
  assert.equal(JSON.stringify(r).includes('task'), false);
});

test('a resume after a human message with no tool call is the host path', () => {
  const r = run([human('task'), goalRound(), resume(2)]);
  assert.equal(r.resumptions.length, 1);
  assert.equal(r.resumptions[0].trigger, 'host_after_human_message');
  assert.equal(r.verdict, 'host_rearm_after_a_human_message');
});

test('a resume attributable to an update_goal call is the model path', () => {
  const r = run([human('task'), { type: 'tool/call', data: { name: 'update_goal' } }, resume(2)]);
  assert.equal(r.resumptions[0].trigger, 'model_tool');
  assert.equal(r.verdict, 'model_tool');
});

test('the script never rewrites the log and rejects a missing argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-continue-'));
  const file = join(dir, 's.jsonl');
  const body = JSON.stringify({ seq: 0, ...human('task') });
  writeFileSync(file, body);
  spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
  assert.equal(readFileSync(file, 'utf8'), body);
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
