/**
 * quota-queue/host — the plugin-local `SessionInspection` port.
 *
 * DSH 0.2.2 removed `SessionController.inspect()`. That method was a thin
 * product wrapper: an attached Session returned its current live snapshot, and
 * a cold one was read through
 * `ctx.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })`.
 * The underlying public seam is still mounted, so this module re-implements
 * exactly that wrapper inside the plugin:
 *
 *  - every consumer that needs the complete validated log (plan identity, HOT
 *    recovery, automatic continuation, the cold observer) reads ONE
 *    implementation instead of probing the Host service itself;
 *  - it keeps the retired `{ meta, inheritedEventCount, events }` shape, so the
 *    identity parser and its offline evidence stay unchanged;
 *  - it passes the caller's signal (the newer `readSession(id)` API cannot)
 *    and asks for no projections, exactly like the retired wrapper;
 *  - it disposes the observation lease in `finally`: a live lease is a no-op,
 *    but a prepared lease pins the session-query cache entry until released.
 *
 * It never activates an Agent, opens a write handle, computes projections or
 * reads a prompt body.
 */
class SessionInspectionUnavailable extends Error {
  constructor() {
    super('the Host does not expose a read-only Session log observation');
    this.name = 'SessionInspectionUnavailable';
    this.code = 'session_inspection_unavailable';
  }
}

export { SessionInspectionUnavailable };

/**
 * Build the inspection port over the public `sessionQuery` service.
 *
 * The resolver is called on every read: a service that activates late, is
 * replaced, or disappears is always observed in its current state.
 *
 * @param {() => ({ observeSession?: Function } | undefined)} resolveSessionQuery
 *   current `ctx.sessionQuery` (or undefined while it is not active)
 * @returns {{ available: boolean, inspect: (sessionId: string, signal?: AbortSignal) => Promise<object> }}
 */
export function createSessionInspection(resolveSessionQuery) {
  if (typeof resolveSessionQuery !== 'function') throw new TypeError('session query resolver required');
  const currentQuery = () => {
    try { return resolveSessionQuery(); } catch { return undefined; }
  };
  return {
    /** Whether the Host currently exposes the read-only observation seam. */
    get available() {
      const query = currentQuery();
      return query !== null && query !== undefined && typeof query.observeSession === 'function';
    },
    /**
     * Read one complete live-preferred, replay-validated Session log.
     *
     * @param {string} sessionId durable Session identity
     * @param {AbortSignal} [signal] caller cancellation for cold reads
     * @returns {Promise<{meta: object, inheritedEventCount: number, events: object[]}>}
     * @throws {SessionInspectionUnavailable} when the Host seam is not mounted
     */
    async inspect(sessionId, signal) {
      const query = currentQuery();
      if (query === null || query === undefined || typeof query.observeSession !== 'function') {
        throw new SessionInspectionUnavailable();
      }
      const options = { projectionMode: 'none' };
      if (signal !== undefined) options.signal = signal;
      let observation;
      try {
        observation = await query.observeSession(sessionId, options);
        return {
          meta: observation.header,
          inheritedEventCount: observation.inheritedEventCount,
          events: [...observation.events],
        };
      } finally {
        // A live lease is a no-op; a prepared lease must be released or it pins
        // one entry of the bounded observation cache for the process lifetime.
        try { observation?.[Symbol.dispose]?.(); } catch { /* lease released */ }
      }
    },
  };
}
