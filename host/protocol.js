/**
 * quota-queue/host — lazy resolution of the Host protocol binding.
 *
 * The plugin needs exactly three things from the Host's own installation:
 * `TypertRemoteService`, the `Remote` decorator, and `bindTypertRemote`. They
 * live in `@deepseek-ai/dsh-typert-protocol`, a package the Host already has.
 *
 * ## Why this is a lazy import rather than a static one
 *
 * The supported way to install a plugin is a package the profile's pnpm
 * resolves — `pnpm add <absolute .tgz>` according to
 * `@deepseek-ai/dsh-plugin-manager/lib/index.js:72-87` (`kind: "tarball"`) —
 * which places a real copy under the profile's `node_modules`. Node then
 * resolves the Host packages by walking up the profile tree (the shipped Web
 * profile keeps them at `<home>/profiles/node_modules`).
 *
 * Installing the SOURCE DIRECTORY instead records a `link:` dependency
 * (`pnpm-workspace.yaml` in this deployment also sets `nodeLinker: hoisted`
 * and `autoInstallPeers: false`), so the profile entry is a symlink and Node
 * resolves the plugin from its real source path — a tree with no
 * `node_modules`, where the Host packages cannot be found. A static import
 * then fails the whole Loader row with a bare `ERR_MODULE_NOT_FOUND`, which is
 * what the first P3 attempt reported as "failed to import".
 *
 * Loading it lazily keeps that failure inside activation, where it can name the
 * specifier, the cause code and the remedy. The plugin still refuses to run:
 * without the protocol there is no Remote surface and no execution.
 */
import { isNonEmptyString } from '../core/util.mjs';

/** The Host package this plugin depends on. Must match package.json peers. */
export const PROTOCOL_SPECIFIER = '@deepseek-ai/dsh-typert-protocol';

/** Why a failed resolution happened, and what to do about it. */
export const RESOLUTION_REMEDY = 'Install the packed tarball (an absolute .tgz path) instead of the source directory: '
  + 'a directory install records a "link:" dependency, and Node resolves a linked plugin from its real source path, '
  + 'which has no node_modules. A tarball or file install places a real copy under the profile node_modules, '
  + 'where the Host packages resolve.';

let cached = null;

/**
 * Build the protocol binding from an already-imported module namespace.
 * @param {object} module `@deepseek-ai/dsh-typert-protocol` namespace
 * @returns {{TypertRemoteService: Function, Remote: Function, bindTypertRemote: Function}}
 */
export function protocolBindingOf(module) {
  const binding = {
    TypertRemoteService: module === null || module === undefined ? undefined : module.TypertRemoteService,
    Remote: module === null || module === undefined ? undefined : module.Remote,
    bindTypertRemote: module === null || module === undefined ? undefined : module.bindTypertRemote,
  };
  for (const [name, value] of Object.entries(binding)) {
    if (typeof value !== 'function') {
      throw new Error(`quota-queue: ${PROTOCOL_SPECIFIER} does not export a callable ${name}`);
    }
  }
  return Object.freeze(binding);
}

/**
 * Load (and cache) the Host protocol binding.
 *
 * @param {(specifier: string) => Promise<object>} [importer] test seam; defaults to
 *   the real dynamic import, which resolves from THIS module's location exactly
 *   as a static import would.
 * @returns {Promise<{TypertRemoteService: Function, Remote: Function, bindTypertRemote: Function}>}
 * @throws {Error} naming the specifier, the cause code and the remedy
 */
export async function loadProtocolBinding(importer) {
  if (cached !== null) return cached;
  const load = typeof importer === 'function' ? importer : (specifier) => import(specifier);
  let module;
  try {
    module = await load(PROTOCOL_SPECIFIER);
  } catch (cause) {
    const code = cause !== null && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
    const detail = isNonEmptyString(code) ? code : 'resolution failed';
    throw new Error(
      `quota-queue: cannot resolve ${PROTOCOL_SPECIFIER} from this plugin (${detail}). ${RESOLUTION_REMEDY}`,
      { cause },
    );
  }
  cached = protocolBindingOf(module);
  return cached;
}

/** Drop the cached binding. Test-only. */
export function resetProtocolBinding() {
  cached = null;
}
