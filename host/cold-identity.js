/** Derive a cold recovery identity from already checked Host evidence.
 * Does not establish task authorization, quota binding or exclusive ownership.
 */
const id = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
export function createColdIdentity({ failure, workspaceId, requestId } = {}) {
  if (!failure || typeof failure !== 'object' || failure.eligible !== true
      || !id(failure.sessionId, 256) || !id(failure.rootMessageId)
      || typeof failure.generation !== 'string' || !/^[a-f0-9]{64}$/.test(failure.generation)
      || !Number.isSafeInteger(failure.turn) || failure.turn < 0
      || !id(workspaceId) || !id(requestId, 256)) throw new TypeError('invalid recovery identity');
  return Object.freeze({
    sessionId: failure.sessionId, taskId: failure.rootMessageId,
    generation: failure.generation, workspaceId, rootMessageId: failure.rootMessageId,
    failedTurnId: String(failure.turn), requestId,
  });
}
