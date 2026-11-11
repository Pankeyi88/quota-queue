/**
 * Installed-DSH module root plus a minimal ESM resolution hook.
 *
 * Two tests need the real Host packages:
 *  - the real-Cordis smoke, which imports the production entry with the hook
 *    registered so the lazy Host protocol import resolves;
 *  - the production-entry resolution test, which builds an installed-like
 *    `node_modules` layout in a temp directory and re-exports these packages.
 *
 * `MODULE_ROOT` is exported for the latter. It reads nothing but module paths:
 * no credential, profile or session data. Override the root with
 * `DSH_MODULE_ROOT` when the installation moves.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const MODULE_ROOT = process.env.DSH_MODULE_ROOT === undefined || process.env.DSH_MODULE_ROOT === ''
  ? `${process.cwd()}/node_modules`
  : process.env.DSH_MODULE_ROOT;
const requireFromRoot = createRequire(`${MODULE_ROOT}/_dsh_resolver_.js`);

export async function resolve(specifier, context, nextResolve) {
  const isBare = !specifier.startsWith('node:')
    && !specifier.startsWith('file:')
    && !specifier.startsWith('data:')
    && !specifier.startsWith('.')
    && !specifier.startsWith('/')
    && !specifier.startsWith('http:')
    && !specifier.startsWith('https:');
  if (isBare) {
    try {
      return { url: pathToFileURL(requireFromRoot.resolve(specifier)).href, shortCircuit: true };
    } catch {
      // Fall through to the default resolver so a genuinely missing module
      // still fails with Node's own error.
    }
  }
  return nextResolve(specifier, context);
}
