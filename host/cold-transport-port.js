/** Unmounted bridge between ColdRecovery and the continue-message transport.
 * It supplies a lifetime signal and translates the transport receipt into the
 * deliberately narrower core contract. It grants no authority and performs no
 * session inspection, locking or recovery scheduling.
 */
export function createColdTransportPort({ transport, signal }) {
  if (!transport || typeof transport.send !== 'function') throw new TypeError('transport.send is required');
  if (!(signal instanceof AbortSignal)) throw new TypeError('signal is required');
  return async (identity) => {
    try {
      const result = await transport.send({ sessionId: identity.sessionId, requestId: identity.requestId, signal });
      // The matching request identity prevents an unrelated receipt being
      // mistaken for admission of this intent. All other results are ambiguous.
      if (result?.status === 'accepted' && result.requestId === identity.requestId) return { status: 'accepted' };
    } catch { /* potentially admitted: retain the durable fence */ }
    return { status: 'unknown' };
  };
}
