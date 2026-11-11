/**
 * Read-only enumeration using public SessionController.list({}, signal).
 * List projections are partial/stale hints, NOT execution or authorization facts.
 * Never resolve/activate an Agent or read prompt content while listing tasks.
 */
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createExistingTaskReader(resolveController) {
  if (typeof resolveController !== 'function') throw new TypeError('controller resolver required');
  return {
    async list(signal) {
      try {
      if (signal?.aborted) return { available: false, reason: 'cancelled', items: [] };
      let controller;
      try { controller = resolveController(); } catch { /* unavailable */ }
      if (!controller || typeof controller.list !== 'function') {
        return { available: false, reason: 'session_registry_unavailable', items: [] };
      }
      let result;
      try { result = await controller.list({}, signal ?? new AbortController().signal); }
      catch { return { available: false, reason: 'existing_task_list_failed', items: [] }; }
      if (signal?.aborted) return { available: false, reason: 'cancelled', items: [] };
      if (!record(result) || !Array.isArray(result.items)) {
        return { available: false, reason: 'existing_task_list_invalid', items: [] };
      }
      const seen = new Set();
      const items = [];
      for (const row of result.items) {
        if (!record(row) || !text(row.sessionId, 256) || seen.has(row.sessionId)) continue;
        // Subagent and fork ownership must not be silently reinterpreted.
        if (row.origin !== undefined || row.parentSessionId !== undefined) continue;
        if (row.blank !== false || typeof row.running !== 'boolean' || typeof row.agentAvailable !== 'boolean') continue;
        const hints = row.projections;
        if (!record(hints) || !['cached', 'sequenced'].includes(hints.kind)
          || !Number.isSafeInteger(hints.asOfSeq) || hints.asOfSeq < 0 || !record(hints.values)) continue;
        const metadata = hints.values.sessionListMetadata;
        // Cold cache misses default blank=false in the Host: that alone is NOT
        // positive evidence of a human task. Require the documented projection.
        if (!record(metadata) || metadata.blank !== false
          || typeof metadata.lastPromptAt !== 'number' || !Number.isFinite(metadata.lastPromptAt)
          || metadata.lastPromptAt <= 0) continue;
        seen.add(row.sessionId);
        items.push({
          sessionId: row.sessionId,
          title: text(hints.values.title, 300) ? hints.values.title : row.sessionId,
          workspacePath: text(row.cwd, 4096) ? row.cwd : null,
          running: row.running,
          source: hints.kind,
          asOfSeq: hints.asOfSeq,
          // Selection needs a root-human-message/execution identity, not a list
          // timestamp. Until a verified inspector supplies it do not authorize.
          selectable: false,
          reason: 'task_execution_identity_unverified',
        });
      }
      return { available: true, reason: null, items };
      } catch {
        return { available: false, reason: 'existing_task_list_failed', items: [] };
      }
    },
  };
}
