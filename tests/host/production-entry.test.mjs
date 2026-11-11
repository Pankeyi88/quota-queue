/**
 * Production-entry resolution.
 *
 * The P3 install defect was: `import('./quota-queue/index.js')` failed with
 * `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/dsh-typert-protocol` because the
 * production entry imported it statically while the plugin was installed as a
 * `link:` to the source directory (a tree with no `node_modules`).
 *
 * These tests cover the entry itself — not a factory with the binding injected:
 *
 *  1. the shipped entry loads with NO Host package on the resolution path, and
 *     resolves no `@deepseek-ai/*` package at module scope;
 *  2. an INSTALLED-LAYOUT copy (a real directory under `node_modules/@local/`
 *     beside `node_modules/@deepseek-ai/`) activates against the real Cordis
 *     and the real Typert protocol, and its contextual Remote dispatch returns
 *     `ok: true` — the exact path that failed in production;
 *  3. a missing Host package produces a diagnostic naming the specifier, the
 *     cause code and the remedy, instead of a bare `ERR_MODULE_NOT_FOUND`.
 *
 * The installed layout is built in the OS temp directory from a filesystem copy
 * of this package plus two re-export shims standing in for the profile's Host
 * packages. That is real Node resolution, real Cordis and real protocol code,
 * with no network and no host installation touched.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODULE_ROOT } from './resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');

const CORDIS_ENTRY = join(MODULE_ROOT, '@deepseek-ai', 'cordis', 'lib', 'index.js');
const PROTOCOL_ENTRY = join(MODULE_ROOT, '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js');
const HOST_AVAILABLE = existsSync(CORDIS_ENTRY) && existsSync(PROTOCOL_ENTRY);

const ROUTE = Object.freeze({
  id: 'codex-common',
  label: 'Common Codex',
  provider: 'westlake-hpc',
  model: 'deepseek-flash',
  credentialRef: 'common-codex-ref',
});

/** One Host package as an installed profile provides it, re-exported by URL. */
function writeHostPackage(dir, name, targetEntry) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }, null, 2));
  writeFileSync(join(dir, 'index.js'), `export * from ${JSON.stringify(pathToFileURL(targetEntry).href)};\n`);
}

/** A fake storage medium: one durable global slot, one open at a time. */
function createMedium() {
  const state = { global: null, opens: 0, closes: 0, activeOpens: 0 };
  const kv = {
    async open(descriptor) {
      assert.equal(descriptor.name, 'quota_queue_v1');
      state.opens += 1;
      state.activeOpens += 1;
      let closed = false;
      return {
        async loadAll() { return { tables: {}, global: structuredClone(state.global) }; },
        async setGlobal(value) { state.global = structuredClone(value); },
        async close() { if (closed) return; closed = true; state.activeOpens -= 1; state.closes += 1; },
      };
    },
  };
  return { state, storage: { backend: { get: (name) => (name === 'json' ? { kv } : undefined) } } };
}

test('the production entry loads with no Host package on the resolution path', async () => {
  const entry = await import('../../index.js');
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name']);
  assert.equal(entry.name, 'quota-queue');
  assert.deepEqual(entry.inject, ['storage']);
  assert.equal(typeof entry.apply, 'function');
  assert.equal(typeof entry.Config['~standard'].validate, 'function');

  // The entry chain must not statically import a Host package: that is the
  // exact defect this test locks down.
  const sources = ['index.js', 'host/plugin.js'].map((rel) => readFileSync(join(PACKAGE_ROOT, rel), 'utf8'));
  for (const source of sources) {
    assert.equal(/from\s+['"]@deepseek-ai\//.test(source), false, 'the entry must not statically import a Host package');
    assert.equal(/^import\s+['"]@deepseek-ai\//m.test(source), false, 'the entry must not side-effect import a Host package');
  }

  // The specifier lives in exactly one place, and it matches the declared peer.
  const protocol = await import('../../host/protocol.js');
  assert.equal(protocol.PROTOCOL_SPECIFIER, '@deepseek-ai/dsh-typert-protocol');
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.peerDependencies[protocol.PROTOCOL_SPECIFIER] !== undefined, true);
  assert.equal(manifest.dependencies === undefined || manifest.dependencies[protocol.PROTOCOL_SPECIFIER] === undefined, true,
    'a Host package must be a peer, so the profile Host copy is reused instead of duplicated');
});

test('an installed-layout copy activates against the real Cordis and protocol', { skip: HOST_AVAILABLE ? false : 'DSH module root not found' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'quota-queue-entry-'));
  try {
    const modules = join(root, 'node_modules');
    const installed = join(modules, '@local', 'quota-queue');
    mkdirSync(installed, { recursive: true });
    // A real copy, exactly as a tarball/file install places it.
    for (const rel of ['index.js', 'package.json', 'host', 'core']) {
      cpSync(join(PACKAGE_ROOT, rel), join(installed, rel), { recursive: true });
    }
    writeHostPackage(join(modules, '@deepseek-ai', 'cordis'), '@deepseek-ai/cordis', CORDIS_ENTRY);
    writeHostPackage(join(modules, '@deepseek-ai', 'dsh-typert-protocol'), '@deepseek-ai/dsh-typert-protocol', PROTOCOL_ENTRY);

    // Imported through the installed layout so the Context class is the same
    // module instance the protocol package uses.
    const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai', 'cordis', 'index.js')).href);
    const entry = await import(pathToFileURL(join(installed, 'index.js')).href);

    const medium = createMedium();
    const operator = { id: 'operator-peer', principal: { kind: 'owner' } };
    const ctx = new Context();
    await ctx.plugin({
      name: 'entry-infra',
      apply(inner) {
        inner.provide('storage', medium.storage);
        inner.provide('connection', { operator });
      },
    });
    await ctx.plugin(entry, { storageBackend: 'json', routes: [ROUTE] });

    const service = ctx.get('quotaQueue');
    assert.ok(service !== undefined && service !== null, 'the installed copy must register the service');
    assert.equal(medium.state.opens, 1);

    const request = { version: 1, op: 'bootstrap', requestId: 'prod-1', payload: {} };
    const signal = new AbortController().signal;
    const invocation = {
      service: 'quotaQueue',
      request: { namespace: 'quotaQueue', method: 'dispatch', args: { request } },
      peer: operator,
      signal,
      uplink() { throw new Error('no uplink'); },
    };
    const result = await ctx.extend({ invocation }).get('quotaQueue').dispatch(request, signal);
    assert.equal(result.ok, true, `installed-layout dispatch failed: ${JSON.stringify(result)}`);
    assert.equal(result.data.version, 1);
    assert.equal(result.data.configuration.ready, false);
    assert.equal(result.data.routes[0].selectable, true);

    await ctx.fiber.dispose();
    assert.equal(medium.state.closes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing Host package names the specifier, the cause and the remedy', async () => {
  const protocol = await import('../../host/protocol.js');
  protocol.resetProtocolBinding();
  await assert.rejects(
    protocol.loadProtocolBinding(async () => {
      const cause = new Error('simulated resolution failure');
      cause.code = 'ERR_MODULE_NOT_FOUND';
      throw cause;
    }),
    (error) => {
      assert.ok(error.message.includes(protocol.PROTOCOL_SPECIFIER));
      assert.ok(error.message.includes('ERR_MODULE_NOT_FOUND'));
      assert.ok(error.message.includes('tarball'));
      assert.equal(error.cause.code, 'ERR_MODULE_NOT_FOUND');
      return true;
    },
  );
});

test('the protocol binding is validated, not just imported', async () => {
  const protocol = await import('../../host/protocol.js');
  protocol.resetProtocolBinding();
  const binding = protocol.protocolBindingOf({
    TypertRemoteService: class {},
    Remote() {},
    bindTypertRemote() {},
  });
  assert.deepEqual(Object.keys(binding).sort(), ['Remote', 'TypertRemoteService', 'bindTypertRemote']);
  assert.equal(Object.isFrozen(binding), true);
  assert.throws(() => protocol.protocolBindingOf({ TypertRemoteService: class {} }), /callable Remote/);
  assert.throws(() => protocol.protocolBindingOf(null), /callable TypertRemoteService/);
});
