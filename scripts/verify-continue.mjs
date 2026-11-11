#!/usr/bin/env node
/**
 * Diagnostic for the “继续” recovery path in ONE persisted session log.
 *
 * It answers a narrow, checkable question: after the last human message, did the
 * Goal get re-armed (goal/change resume), and was that re-arm attributable to a
 * model tool call (update_goal) or to a Host action with no tool call in between
 * (the Host-side re-arm this package adds)?
 *
 * It reads a session log and prints metadata-only JSON (no message bodies).
 * Treat diagnostic outputs as private; do not commit real session data.
 * It never writes, never contacts a
 * host, and never claims authority: a classification here is evidence for a
 * human reviewer, not a substitute for the durable event sequence.
 *
 * Usage:
 *   node scripts/verify-continue.mjs <session.v4.jsonl[.zstd]> [--json]
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-continue.mjs <session.v4.jsonl[.zstd]>');
  process.exit(2);
}

function decode(path) {
  const bytes = readFileSync(path);
  if (!path.endsWith('.zstd')) return bytes.toString('utf8');
  // Node's one-shot zstd decoder stops at the first frame; a session log is many
  // frames, so fall back to the CLI when the decoded text looks truncated.
  try {
    const once = zlib.zstdDecompressSync(bytes).toString('utf8');
    if (once.trim().split('\n').length > 1) return once;
  } catch { /* fall through */ }
  const cli = spawnSync('zstd', ['-d', '-c', path], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (cli.status !== 0) throw new Error('zstd decode failed: ' + (cli.stderr || '').slice(0, 200));
  return cli.stdout;
}

const events = decode(file)
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const humans = [];
const resumes = [];
const goalRounds = [];
const toolCalls = [];
for (const e of events) {
  const data = e.data ?? {};
  if (e.type === 'user/message' && data.source?.kind === 'user') {
    humans.push({ seq: e.seq, turn: e.turn ?? null });
  }
  if (e.type === 'user/message' && data.source?.kind === 'goal') goalRounds.push(e.seq);
  if (e.type === 'goal/change' && data.operation === 'resume') {
    const change = { seq: e.seq, turn: e.turn ?? null, revision: data.goal?.revision ?? null };
    const tool = toolCalls.filter((c) => c.seq < e.seq && e.seq - c.seq < 40 && c.name === 'update_goal');
    const human = humans.filter((h) => h.seq < e.seq).at(-1);
    change.trigger = tool.length > 0 ? 'model_tool' : human !== undefined && e.seq - human.seq < 400 ? 'host_after_human_message' : 'external_or_unknown';
    resumes.push(change);
  }
  if (e.type === 'tool/call') toolCalls.push({ seq: e.seq, name: data.name ?? '' });
  if (e.type === 'tool/ptc-dispatch' && typeof data.name === 'string') toolCalls.push({ seq: e.seq, name: data.name });
}

const lastHuman = humans.at(-1) ?? null;
const lastResume = resumes.at(-1) ?? null;
const report = {
  events: events.length,
  humanMessages: humans.length,
  lastHumanMessage: lastHuman,
  goalRounds: goalRounds.length,
  lastGoalRoundSeq: goalRounds.at(-1) ?? null,
  resumptions: resumes,
  verdict: lastResume === null
    ? 'no_goal_resume_observed'
    : lastResume.trigger === 'host_after_human_message'
      ? 'host_rearm_after_a_human_message'
      : lastResume.trigger,
};
console.log(JSON.stringify(report, null, 2));
