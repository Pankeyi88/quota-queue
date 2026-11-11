/**
 * quota-queue/host — cross-process owner mutex for the continuation driver.
 *
 * Exclusivity comes from ONE OS-owned fact, not from timestamps: the driver
 * binds a loopback TCP port for its whole lifetime. The kernel arbitrates the
 * bind, keeps it until the socket closes (process exit), and releases it
 * automatically. Consequently:
 *
 *  - there is NO expiry, NO stale-takeover and NO PID heuristic;
 *  - a suspended process KEEPS the port, so a peer cannot supersede it;
 *  - a crashed process releases the port, and the next process acquires it;
 *  - the peer learns the truth synchronously: `listen` fails with EADDRINUSE
 *    instead of two drivers believing they own the role.
 *
 * Scope, stated rather than hidden: the mutex excludes every DSH process on the
 * same machine that runs this driver. It says nothing about a process that does
 * not run the driver at all (that process cannot send continuations either), and
 * it is not a distributed lock across machines. The metadata file is diagnostic
 * only and is never consulted for authority.
 */
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import net from 'node:net';

/**
 * @param {object} input
 * @param {number} input.port loopback port reserved for the owner role
 * @param {string} input.instanceId diagnostic instance identity
 * @param {string} [input.host]
 * @param {string|null} [input.metaPath] diagnostic metadata file, never authority
 * @param {Function} [input.createServer] injectable `net.createServer`
 * @param {object} [input.fs] injectable fs promises for the metadata file
 */
export function createOwnerMutex(input) {
  const { port, instanceId, host = '127.0.0.1', metaPath = null, fs = { mkdir, writeFile, unlink } } = input ?? {};
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new TypeError('owner mutex requires a port in [1024, 65535]');
  if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(instanceId)) throw new TypeError('owner mutex requires an instance id');
  const createServer = input.createServer ?? (() => net.createServer());
  let server = null;
  let active = false;
  let reason = 'not_acquired';

  return Object.freeze({
    port,
    get owned() { return active; },
    get reason() { return reason; },

    async acquire() {
      if (active) return { active: true, reason };
      const candidate = createServer();
      const result = await new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        candidate.once('error', (error) => done({ active: false, reason: error?.code === 'EADDRINUSE' ? 'held_by_peer' : 'bind_failed' }));
        candidate.once('listening', () => done({ active: true, reason: 'acquired' }));
        try {
          candidate.listen({ port, host, exclusive: true });
        } catch {
          done({ active: false, reason: 'bind_failed' });
        }
      });
      if (result.active !== true) {
        try { candidate.close(); } catch { /* never listened */ }
        active = false;
        reason = result.reason;
        return result;
      }
      active = true;
      reason = result.reason;
      try { candidate.on('connection', (socket) => { try { socket.destroy(); } catch { /* already gone */ } }); } catch { /* best effort */ }
      server = candidate;
      try { server.unref?.(); } catch { /* optional */ }
      if (metaPath !== null) {
        try {
          await fs.mkdir(dirname(metaPath), { recursive: true });
          await fs.writeFile(metaPath, JSON.stringify({ pid: process.pid, port, instanceId, startedAt: Date.now() }), 'utf8');
        } catch { /* diagnostics only */ }
      }
      return { active: true, reason };
    },

    /** The ownership fact immediately before a send: still bound, still ours. */
    verify() {
      return active === true && server !== null && server.listening === true;
    },

    async release() {
      if (metaPath !== null) { try { await fs.unlink(metaPath); } catch { /* absent */ } }
      if (server === null) { active = false; return false; }
      const closing = server;
      server = null;
      active = false;
      reason = 'released';
      await new Promise((resolve) => { try { closing.close(() => resolve()); } catch { resolve(); } });
      return true;
    },
  });
}
