/**
 * Host adapter for the public `agent/request-error` waterfall.
 *
 * The shipped retry policy may run OUTSIDE this listener (always mode awaits
 * `next()` and falls back to its own retry when a downstream listener returns
 * nothing). This adapter therefore NEVER claims exclusive recovery ownership:
 *
 *  - it only asks the injected coordinator when the Host's trusted
 *    `resolveTask` maps the exact failing request to an authorized recovery
 *    scope; unknown/ambiguous failures are delegated unchanged;
 *  - a `retry` verdict is proposed only after the coordinator has re-verified
 *    identity, binding, ownership and fresh quota evidence around a real query;
 *  - every other verdict, error, cancellation or disposal delegates to the
 *    remaining policy chain, so existing retry/Goal behavior is not vetoed.
 *
 * It performs no I/O itself, reads no credentials, and is NOT mounted by the
 * production plugin: capability flags stay false until a verified account
 * binding and host recovery-ownership protocol exist. `resolveTask` is a
 * trusted Host function, never a Client-supplied boolean.
 */
const ID = Object.freeze(['sessionId', 'rootMessageId', 'generation', 'turn', 'step', 'scopeId', 'bindingRevision']);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function validIdentity(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ID.length || !ID.every((key) => Object.hasOwn(value, key))) return null;
  for (const key of ID) {
    if (key === 'turn' || key === 'step') {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    } else if (!text(value[key])) return null;
  }
  return Object.freeze(Object.fromEntries(ID.map((key) => [key, value[key]])));
}

/**
 * @param {object} input
 * @param {{waitForRetry: Function}} input.coordinator core/hot-recovery instance
 * @param {(payload: object) => object|null} input.resolveTask trusted mapping to
 *   the exact authorized recovery identity, or null to delegate
 * @param {{warn?: Function}} [input.logger]
 */
export function createHotRequestErrorAdapter(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('hot request-error adapter expects an input object');
  const { coordinator, resolveTask } = input;
  if (!coordinator || typeof coordinator.waitForRetry !== 'function') throw new TypeError('a hot recovery coordinator is required');
  if (typeof resolveTask !== 'function') throw new TypeError('a trusted resolveTask mapping is required');
  const logger = input.logger ?? null;
  const lifetime = new AbortController();
  const active = new Set();
  let closed = false;

  /** The single delegation point: `next` is called at most once per callback. */
  const delegate = async (next) => (typeof next === 'function' ? next() : undefined);

  /** @returns {Promise<{kind:'retry'}|{kind:'delegate'}>} */
  async function decide(payload) {
    if (closed || lifetime.signal.aborted) return { kind: 'delegate' };
    let identity;
    try {
      // The trusted mapping may inspect the live session; it is awaited so an
      // async identity check can never be mistaken for a synchronous `retry`.
      identity = validIdentity(await resolveTask(payload));
    } catch {
      identity = null;
    }
    // An unmapped failure belongs to whatever policy chain would have seen it.
    if (identity === null) return { kind: 'delegate' };
    const payloadSignal = payload !== null && typeof payload === 'object' ? payload.signal : undefined;
    if (!(payloadSignal instanceof AbortSignal)) return { kind: 'delegate' };
    if (payloadSignal.aborted || lifetime.signal.aborted || closed) return { kind: 'delegate' };
    const signal = AbortSignal.any([payloadSignal, lifetime.signal]);
    let decision;
    try {
      decision = await coordinator.waitForRetry({ ...identity, signal });
    } catch {
      decision = null;
    }
    if (closed || lifetime.signal.aborted || signal.aborted) return { kind: 'delegate' };
    if (decision !== null && typeof decision === 'object' && decision.kind === 'retry') return { kind: 'retry' };
    return { kind: 'delegate' };
  }

  /** Waterfall listener: same payload/next contract as ctx.on. */
  function listener(payload, next) {
    let tracked;
    const run = (async () => {
      let outcome;
      try {
        outcome = await decide(payload);
      } catch {
        try { logger?.warn?.('quota-queue: hot recovery delegated after an adapter failure'); } catch { /* logging is best effort */ }
        outcome = { kind: 'delegate' };
      }
      if (outcome.kind === 'retry') return { kind: 'retry' };
      return delegate(next);
    })();
    tracked = run.finally(() => { active.delete(tracked); });
    active.add(tracked);
    return tracked;
  }

  /** Stop deciding and drain in-flight callbacks; late results never retry. */
  function dispose() {
    if (closed) return Promise.resolve([]);
    closed = true;
    lifetime.abort();
    return Promise.allSettled([...active]);
  }

  return Object.freeze({
    listener,
    dispose,
    isClosed: () => closed,
    activeCount: () => active.size,
  });
}
