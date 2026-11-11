/**
 * Experimental transport for a minimal continuation in an existing session.
 * NOT mounted: the caller must establish durable authorization, ownership,
 * readiness and reconciliation before invoking it. This transport does not
 * infer any of those facts or retry an ambiguous delivery.
 *
 * Host prompt() records a user-source message and starts/queues a NEW turn.
 * requestId is an RPC identity, not the resulting messageId or turn identity.
 */
import { addAbortListener } from 'node:events';

const validId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

export function createContinueTransport({ resolveController, timeoutMs = 30_000 }) {
  if (typeof resolveController !== 'function') throw new TypeError('resolveController must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('invalid timeoutMs');
  const active = new Set();
  // A request identity must never trigger a second prompt in this instance.
  // Durable deduplication and reconciliation across instances belong to the caller.
  const requests = new Map();
  return Object.freeze({
    async send(input) {
      let sessionId, requestId, signal;
      try {
        ({ sessionId, requestId, signal } = input);
        if (!validId(sessionId) || !validId(requestId)) return { status: 'invalid' };
        // Check the native brand, rather than trusting instanceof or overridden methods.
        if (signalAborted.call(signal)) return { status: 'cancelled' };
      } catch { return { status: 'invalid' }; }
      const previous = requests.get(requestId);
      if (previous) {
        if (previous.sessionId === sessionId && previous.accepted) return { status: 'accepted', requestId };
        return { status: 'busy' };
      }
      // Local exclusion only. Other transports/processes require host ownership.
      if (active.has(sessionId)) return { status: 'busy' };
      active.add(sessionId);
      const request = { sessionId, accepted: false };
      requests.set(requestId, request);
      let uncertain = false;
      try {
        let controller, prompt;
        try {
          controller = resolveController();
          prompt = controller?.prompt;
          if (typeof prompt !== 'function') return { status: 'unavailable' };
        } catch { return { status: 'unavailable' }; }
        if (signalAborted.call(signal)) return { status: 'cancelled' };

        let timer, onAbort, abortSubscription;
        let interrupted = false;
        let interrupt;
        const interruption = new Promise((resolve) => { interrupt = resolve; });
        onAbort = () => { interrupted = true; interrupt(); };
        try {
          abortSubscription = addAbortListener(signal, onAbort);
          timer = setTimeout(onAbort, timeoutMs);
          if (signalAborted.call(signal)) return { status: 'cancelled' };
          const deadline = performance.now() + timeoutMs;
          // From this point even a synchronous throw may follow admission.
          uncertain = true;
          const pending = Promise.resolve(Reflect.apply(prompt, controller, [{
            requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: '继续' }],
          }, signal]));
          const receipt = await Promise.race([pending, interruption]);
          // Timers cannot preempt synchronous host code or a blocked event loop.
          // Check the deadline and abort state even if a late receipt wins the race.
          if (!interrupted && !signalAborted.call(signal) && performance.now() < deadline
              && receipt?.accepted === true && !interrupted && !signalAborted.call(signal)
              && performance.now() < deadline) {
            request.accepted = true;
            uncertain = false;
            return { status: 'accepted', requestId };
          }
          return { status: 'unknown', requestId };
        } catch {
          return uncertain ? { status: 'unknown', requestId } : { status: 'unavailable' };
        } finally {
          clearTimeout(timer);
          abortSubscription?.[Symbol.dispose]();
        }
      } finally {
        // An ambiguous admission stays fenced for this instance's lifetime.
        if (!uncertain) {
          active.delete(sessionId);
          if (!request.accepted) requests.delete(requestId);
        }
      }
    },
  });
}
