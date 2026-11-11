/**
 * Host half of the @local/quota-queue bundle (the Loader row entry point).
 *
 * The Cordis plugin body lives in `host/plugin.js`; this file only re-exports
 * the documented function-plugin form. The browser half is declared by
 * `dsh.client` in package.json and resolved through `exports["./client"]`.
 */
export { Config, apply, inject, name } from './host/plugin.js';
