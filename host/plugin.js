/**
 * quota-queue/host — the Cordis plugin entry (the host half of the bundle row).
 *
 * Export form is the documented function form: `apply(ctx, config)` with
 * `inject` and `Config`.
 *
 * The Host protocol package is loaded lazily through `host/protocol.js`
 * instead of with a static import. That keeps this entry loadable — and
 * inspectable — even when the Host packages are not on the resolution path,
 * which is what a `link:` directory install produces; a static import would
 * instead fail the whole Loader row with a bare `ERR_MODULE_NOT_FOUND`. See
 * `host/protocol.js` for the full rationale, the resolution chain, and the
 * remedy the error names.
 *
 * `inject: ['storage']` is mandatory: without the storage hub the queue cannot
 * persist, and "not persisting" must never look like "queued". The workspace
 * registry is deliberately optional, so the service still mounts and reports
 * `configuration.ready === false` with `workspace_registry_unavailable`
 * instead of parking invisibly.
 */
import { EFFECT_LABEL } from './constants.js';
import { parseConfig } from './config.js';
import { createContinueRearm } from './continue-rearm.js';
import { loadProtocolBinding } from './protocol.js';
import { createQuotaQueueService } from './service.js';

/** Stable Cordis plugin / Loader row name. */
export const name = 'quota-queue';

/** Required services. Activation waits until the storage hub is active. */
export const inject = ['storage'];

export { Config } from './config.js';

/**
 * Activate the Host service.
 * @param {object} ctx the row's Cordis context
 * @param {unknown} config raw row config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const normalized = parseConfig(config);
  // Resolved here, at activation, so a missing Host package is a diagnosable
  // activation failure naming the specifier and the remedy.
  const protocol = await loadProtocolBinding();
  const QuotaQueueService = createQuotaQueueService(protocol);
  const service = new QuotaQueueService(ctx, normalized);
  // The service unregisters itself with the owning fiber; this effect closes
  // the storage unit and drains the operation chain on unload or reload.
  ctx.effect(() => () => service.dispose(), EFFECT_LABEL);
  await service.init();
  // “继续” must restore a Goal that an API/network error disarmed. This is the
  // documented intent ("when a human asks to continue, re-arm"), made
  // deterministic: it only fires after a COMPLETED human turn in a session
  // whose Goal is active+disarmed, and always through the Host CAS. Without the
  // goal service every call resolves to `not_live` and nothing happens.
  ctx.effect(() => {
    const rearm = createContinueRearm({
      // Resolved per event: the goal service and the agent registry may activate
      // after this row, be replaced, or be absent in a minimal composition.
      resolveAgents: () => ctx.get('agents'),
      resolveGoals: () => ctx.get('goals'),
    });
    return rearm.attach(ctx);
  }, `${EFFECT_LABEL}/continue-rearm`);
  // HOT recovery is registered only when the service actually mounted it
  // (verified source + autoResume.enabled + open store). Otherwise the loader
  // row stays identical to the read-only build.
  // Durable automatic continuation: a ticket is only created and delivered by
  // the process that holds the OS owner mutex. A passive process subscribes
  // nothing and stays inert.
  const autoContinue = typeof service.getAutoContinue === 'function' ? service.getAutoContinue() : null;
  if (autoContinue !== null) {
    ctx.effect(() => {
      const off = autoContinue.attach(ctx);
      return () => { try { off(); } catch { /* idempotent */ } };
    }, `${EFFECT_LABEL}/auto-continue`);
  }
  const hot = typeof service.getAutoResume === 'function' ? service.getAutoResume() : null;
  if (hot !== null) {
    ctx.effect(() => {
      const off = ctx.on('agent/request-error', hot.listener);
      return () => {
        if (typeof off === 'function') off();
      };
    }, `${EFFECT_LABEL}/hot-recovery`);
  }
}
