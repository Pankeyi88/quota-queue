#!/usr/bin/env node
/**
 * quota-queue build and consistency check.
 *
 * This script is the packager's gate, not a bundler. The package ships hand-
 * written native ESM (the browser half is the classic-script lazy factory the
 * Client module system requires), so there is nothing to compile: the build
 * verifies that what the manifest PROMISES actually exists, parses, and matches
 * the Host contract, then emits a content-addressed artifact inventory.
 *
 * It deliberately does not call a package manager, a watcher, or a source
 * checkout: `pnpm run dev:web` and friends live in the DSH source tree, not in
 * an installed package, so invoking them here would fail. `npm pack
 * --ignore-scripts` is the supported packaging path.
 *
 * Checks
 *   A. package.json shape: exports, dsh.bundle.patch, dsh.client, files
 *   B. required artifacts exist (host, core, client, tests, patch)
 *   C. every JavaScript file parses (`node --check`)
 *   D. Host contract facts: service key, endpoint, storage unit, disabled
 *      capabilities, the uniform operator gate, the SRC dispatch signature,
 *      and the absence of `#private` members (which Cordis contextual proxies
 *      cannot reach)
 *   E. the bundle patch inserts this package, and the browser half registers
 *      under the declared id and endpoint
 *
 * Usage
 *   node scripts/build.mjs [--host-only] [--no-emit] [--quiet]
 *
 *   --host-only  skip every check that needs the Client half to be present
 *   --no-emit    do not write build/manifest.json
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const args = new Set(process.argv.slice(2));
const HOST_ONLY = args.has('--host-only');
const EMIT = !args.has('--no-emit');
const QUIET = args.has('--quiet');

const failures = [];
const notes = [];
const pass = (message) => { if (!QUIET) console.log(`  ok   ${message}`); };
const fail = (message) => { failures.push(message); console.log(`  FAIL ${message}`); };
const note = (message) => { notes.push(message); if (!QUIET) console.log(`  note ${message}`); };

const abs = (...parts) => join(ROOT, ...parts);
const rel = (path) => relative(ROOT, path).split('\\').join('/');

/**
 * The *required* subset. Presence is checked for exactly these; the checksum
 * inventory below is a complete disk scan, so core/client files this task does
 * not own still appear in the artifact instead of being quietly omitted.
 */
const REQUIRED_FILES = [
  'index.js',
  'cordis.patch.yml',
  'package.json',
  'host/constants.js',
  'host/errors.js',
  'host/wire.js',
  'host/config.js',
  'host/views.js',
  'host/ports.js',
  'host/quota.js',
  'host/storage-port.js',
  'host/ops.js',
  'host/service.js',
  'host/protocol.js',
  'host/plugin.js',
  'host/existing-tasks.js',
  'host/session-inspection.js',
  'host/task-identity.js',
  'host/hot-request-error.js',
  'host/cpamc-quota.js',
  'host/auto-resume.js',
  'core/store.mjs',
  'core/recovery-plan.mjs',
  'core/recovery-plan-store.mjs',
  'core/hot-recovery.mjs',
  'core/tasks.mjs',
  'core/quota.mjs',
  'core/failure.mjs',
  'core/errors.mjs',
  'core/util.mjs',
  'scripts/build.mjs',
  'README.md',
  'docs/EXISTING-TASK-RECOVERY-PLAN.md',
];

const CLIENT_FILES = ['client/index.js'];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`package.json is not valid JSON: ${error.message}`);
    return null;
  }
}

function exportTarget(exportsField, key) {
  if (exportsField === null || typeof exportsField !== 'object') return undefined;
  const entry = exportsField[key];
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object' && typeof entry.default === 'string') return entry.default;
  return undefined;
}

function checkSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.error) {
    fail(`node --check ${rel(path)} could not run: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    fail(`syntax error in ${rel(path)}:\n${(result.stderr || '').trim()}`);
    return false;
  }
  return true;
}

function inventory(paths) {
  const entries = [];
  for (const path of paths) {
    const bytes = readFileSync(path);
    entries.push({ path: rel(path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return entries;
}

function collectFiles(dir, accept, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) collectFiles(path, accept, out);
    else if (accept(name)) out.push(path);
  }
  return out;
}

const isJs = (name) => name.endsWith('.js') || name.endsWith('.mjs');
const isMarkdown = (name) => name.endsWith('.md');
const isJson = (name) => name.endsWith('.json');
const isYaml = (name) => name.endsWith('.yml') || name.endsWith('.yaml');
const collectJsFiles = (dir, out) => collectFiles(dir, isJs, out);

/**
 * Every source artifact this package owns, scanned from disk rather than
 * hardcoded, so source files under host/, core/, client/, tests/ and scripts/
 * are inventoried alongside an explicit allowlist of reviewed public docs.
 */
function collectSourceFiles() {
  const files = [];
  const add = (path) => { if (existsSync(path)) files.push(path); };
  for (const name of ['index.js', 'package.json', 'cordis.patch.yml', 'README.md']) add(abs(name));
  for (const dir of ['host', 'core', 'client', 'scripts', 'tests']) {
    collectFiles(abs(dir), (name) => isJs(name) || isMarkdown(name) || isJson(name) || isYaml(name), files);
  }
  // Only reviewed documentation is shipped; local deployment records stay private.
  for (const name of [
    'docs/EXISTING-TASK-RECOVERY-PLAN.md',
    'docs/ACCEPTANCE-MATRIX-0.2.md',
    'docs/SECURITY-REVIEW-0.2.md',
    'docs/RECOVERY-PLAN-WIRE.md',
  ]) add(abs(name));
  return [...new Set(files)];
}

// ── A. manifest ────────────────────────────────────────────────────────────
console.log('A. package manifest');
const pkg = readJson(abs('package.json'));
let packageName = '';

if (pkg !== null) {
  packageName = typeof pkg.name === 'string' ? pkg.name : '';
  if (packageName !== '@local/quota-queue') fail(`package name must be @local/quota-queue, found ${JSON.stringify(packageName)}`);
  else pass('package name is @local/quota-queue');
  if (pkg.type !== 'module') fail('package.json must declare "type": "module"');
  else pass('package is ESM');
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) fail('package.json needs a semver version');
  else pass(`version ${pkg.version}`);

  const dot = exportTarget(pkg.exports, '.');
  if (dot !== './index.js') fail(`exports["."] must resolve to ./index.js, found ${JSON.stringify(dot)}`);
  else pass('exports["."] -> ./index.js');
  const client = exportTarget(pkg.exports, './client');
  if (client !== './client/index.js') fail(`exports["./client"] must resolve to ./client/index.js, found ${JSON.stringify(client)}`);
  else pass('exports["./client"] -> ./client/index.js');

  const bundlePatch = pkg.dsh !== null && typeof pkg.dsh === 'object' && pkg.dsh.bundle !== null && typeof pkg.dsh.bundle === 'object'
    ? pkg.dsh.bundle.patch
    : undefined;
  if (bundlePatch !== './cordis.patch.yml') fail('dsh.bundle.patch must be ./cordis.patch.yml');
  else pass('dsh.bundle.patch declared');

  const clientDecl = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh.client : undefined;
  if (clientDecl === null || typeof clientDecl !== 'object') {
    fail('dsh.client is missing; the browser half would never be composed');
  } else {
    if (clientDecl.platform !== 'web') fail(`dsh.client.platform must be "web", found ${JSON.stringify(clientDecl.platform)}`);
    else pass('dsh.client.platform is web');
    if (clientDecl.immediately !== true) fail('dsh.client.immediately must be true (stage-one prefetch for the session status strip)');
    else pass('dsh.client.immediately is true');
    if (!Array.isArray(clientDecl.inject) || clientDecl.inject.length === 0 || clientDecl.inject.some((entry) => typeof entry !== 'string')) {
      fail('dsh.client.inject must be a non-empty array of package names');
    } else {
      pass(`dsh.client.inject: ${clientDecl.inject.join(', ')}`);
    }
  }

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('package.json "files" must list the shipped artifacts');
  } else {
    for (const required of ['index.js', 'client/index.js', 'cordis.patch.yml']) {
      if (!pkg.files.includes(required)) fail(`"files" must include ${required}`);
    }
    if (failures.length === 0) pass('"files" covers the entry points');
  }
}

// ── B. presence ────────────────────────────────────────────────────────────
console.log('B. required artifacts');
const requiredFiles = HOST_ONLY ? REQUIRED_FILES : [...REQUIRED_FILES, ...CLIENT_FILES];
const missing = [];
for (const file of requiredFiles) {
  const path = abs(file);
  if (!existsSync(path)) {
    const owner = CLIENT_FILES.includes(file) ? ' (owned by the Client module task)' : '';
    missing.push(`${file}${owner}`);
  }
}
if (missing.length > 0) {
  for (const file of missing) fail(`missing ${file}`);
} else {
  pass(`${requiredFiles.length} required artifacts present`);
}

const hostTests = existsSync(abs('tests/host'))
  ? collectJsFiles(abs('tests/host'), []).filter((path) => path.endsWith('.test.mjs'))
  : [];
if (hostTests.length === 0) fail('tests/host has no *.test.mjs files');
else pass(`${hostTests.length} host test files`);

// ── C. syntax ──────────────────────────────────────────────────────────────
console.log('C. syntax');
const syntaxTargets = [
  abs('index.js'),
  abs('scripts/build.mjs'),
  ...collectJsFiles(abs('host'), []),
  ...collectJsFiles(abs('core'), []),
  ...collectJsFiles(abs('tests/host'), []),
];
if (!HOST_ONLY) syntaxTargets.push(abs('client/index.js'));
let syntaxChecked = 0;
let syntaxFailed = false;
for (const path of syntaxTargets) {
  if (!existsSync(path)) continue;
  syntaxChecked += 1;
  if (!checkSyntax(path)) syntaxFailed = true;
}
if (!syntaxFailed) pass(`${syntaxChecked} JavaScript files parse`);

// ── D. host contract ───────────────────────────────────────────────────────
console.log('D. host contract');
try {
  const constants = await import(pathToFileURL(abs('host/constants.js')).href);
  const expect = [
    ['SERVICE_KEY', 'quotaQueue'],
    ['DISPATCH_ENDPOINT', 'quotaQueue/dispatch'],
    ['WIRE_VERSION', 1],
    ['VIEW_VERSION', 1],
    ['STORAGE_UNIT_NAME', 'quota_queue_v1'],
    ['STORAGE_UNIT_VERSION', 1],
  ];
  let constantsOk = true;
  for (const [key, value] of expect) {
    if (constants[key] !== value) {
      fail(`host/constants.js ${key} must be ${JSON.stringify(value)}, found ${JSON.stringify(constants[key])}`);
      constantsOk = false;
    }
  }
  if (constantsOk) pass('service key, endpoint, wire/view versions and storage unit are fixed');

  for (const [key, value] of Object.entries(constants.CAPABILITIES)) {
    if (value !== false) fail(`capability ${key} must be false in this build`);
  }
  pass('every capability flag is false');

  if (constants.OPERATOR_GATED_OPS.length !== constants.OPS.length
    || constants.OPS.some((op) => !constants.OPERATOR_GATED_OPS.includes(op))) {
    fail('every Host operation must stay operator-gated');
  } else {
    pass(`all ${constants.OPS.length} operations are operator-gated`);
  }

  // The View's runtimeVersion is compiled from this constant, so it can only be
  // trusted while the constant and the published version agree. A mismatch
  // would make the diagnostic prove nothing about the live module generation.
  const manifestVersion = pkg !== null && typeof pkg.version === 'string' ? pkg.version : null;
  if (typeof constants.PLUGIN_VERSION !== 'string' || constants.PLUGIN_VERSION.trim() === '') {
    fail('host/constants.js PLUGIN_VERSION must be a non-empty string');
  } else if (manifestVersion === null) {
    fail('package.json version is unreadable, so PLUGIN_VERSION cannot be checked');
  } else if (constants.PLUGIN_VERSION !== manifestVersion) {
    fail(`host/constants.js PLUGIN_VERSION (${constants.PLUGIN_VERSION}) must equal package.json version (${manifestVersion})`);
  } else {
    pass(`PLUGIN_VERSION matches package.json version ${manifestVersion}`);
  }
} catch (error) {
  fail(`host/constants.js could not be loaded: ${error.message}`);
}

try {
  const config = await import(pathToFileURL(abs('host/config.js')).href);
  const good = config.Config['~standard'].validate({ routes: [{ id: 'a', provider: 'p', model: 'm', credentialRef: 'ref' }] });
  if (good.issues !== undefined) fail('a well-formed single route must validate');
  else pass('single-credential route config validates');
  const bad = config.Config['~standard'].validate({
    routes: [
      { id: 'a', provider: 'p', model: 'm', credentialRef: 'ref-1' },
      { id: 'b', provider: 'p', model: 'm2', credentialRef: 'ref-2' },
    ],
  });
  if (bad.value !== undefined) fail('multi-account routes must be refused');
  else pass('multi-account routes are refused');
} catch (error) {
  fail(`host/config.js could not be loaded: ${error.message}`);
}

try {
  const service = await import(pathToFileURL(abs('host/service.js')).href);
  if (typeof service.createQuotaQueueService !== 'function') fail('host/service.js must export createQuotaQueueService');
  else pass('host/service.js exports createQuotaQueueService');
} catch (error) {
  fail(`host/service.js could not be loaded: ${error.message}`);
}

const serviceSource = existsSync(abs('host/service.js')) ? readFileSync(abs('host/service.js'), 'utf8') : '';
/** A real private member: an access (`this.#x`) or a declaration (`#x =`). */
const PRIVATE_MEMBER = /(^|[^A-Za-z0-9_])this\.#[A-Za-z_]|^\s*#[A-Za-z_]\w*\s*[=;(]/m;
if (PRIVATE_MEMBER.test(serviceSource)) {
  fail('host/service.js uses a #private member, which Cordis contextual proxies cannot reach');
} else {
  pass('host/service.js has no #private members (contextual-proxy safe)');
}
if (!/Remote\(QuotaQueueService\.prototype\.dispatch/.test(serviceSource)) {
  fail('host/service.js must mark dispatch with the public Remote decorator protocol');
} else {
  pass('dispatch is marked with the public Remote protocol');
}
if (!/async dispatch\(request, signal\)/.test(serviceSource)) {
  fail('dispatch must be spelled "async dispatch(request, signal)" for SRC discovery');
} else {
  pass('dispatch signature is SRC-parseable');
}

// ── D2. production-entry resolution ────────────────────────────────────────
// A `link:` directory install resolves the plugin from its real source path,
// which has no node_modules. A static Host import in the entry would then fail
// the whole Loader row with a bare ERR_MODULE_NOT_FOUND before activation could
// explain it, which is exactly the P3 defect. The entry must stay loadable.
const entryFiles = ['index.js', 'host/plugin.js'].filter((rel) => existsSync(abs(rel)));
let staticHostImport = false;
for (const rel of entryFiles) {
  const source = readFileSync(abs(rel), 'utf8');
  if (/from\s+['"]@deepseek-ai\//.test(source) || /^\s*import\s+['"]@deepseek-ai\//m.test(source)) {
    fail(`${rel} statically imports a Host package; load it through host/protocol.js instead`);
    staticHostImport = true;
  }
}
if (!staticHostImport && entryFiles.length > 0) {
  pass('the shipped entry resolves no Host package at module scope');
}

// Hot request-error recovery changes retry behaviour even when it delegates, so
// it may only mount behind the runtime gate: verified CPAMC source, management
// key present, autoResume.enabled and a writable store. Static capability flags
// stay false; effective capabilities are computed per activation.
{
  const pluginSource = existsSync(abs('host/plugin.js')) ? readFileSync(abs('host/plugin.js'), 'utf8') : '';
  const serviceSource = existsSync(abs('host/service.js')) ? readFileSync(abs('host/service.js'), 'utf8') : '';
  const gated = pluginSource.includes('getAutoResume()')
    && pluginSource.includes("agent/request-error")
    && serviceSource.includes('autoResumeEnabled')
    && serviceSource.includes('createAutoResume')
    && serviceSource.includes('cpamcSource !== null');
  if (!gated) fail('hot recovery is not mounted behind the verified source + autoResume.enabled gate');
  else pass('hot recovery mounts only behind the verified source + autoResume.enabled gate');
}

const protocolSource = existsSync(abs('host/protocol.js')) ? readFileSync(abs('host/protocol.js'), 'utf8') : '';
const specifierMatch = /PROTOCOL_SPECIFIER = '([^']+)'/.exec(protocolSource);
if (specifierMatch === null) {
  fail('host/protocol.js must declare PROTOCOL_SPECIFIER');
} else {
  const specifier = specifierMatch[1];
  const peers = pkg !== null && typeof pkg.peerDependencies === 'object' && pkg.peerDependencies !== null ? pkg.peerDependencies : {};
  const deps = pkg !== null && typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? pkg.dependencies : {};
  if (typeof peers[specifier] !== 'string') {
    fail(`package.json peerDependencies must declare ${specifier} so the DSH compatibility gate can check it`);
  } else {
    pass(`peerDependencies declares ${specifier} for the DSH compatibility check`);
  }
  if (deps[specifier] !== undefined) {
    fail(`package.json must not list ${specifier} as a dependency; the profile's Host copy is reused through the peer`);
  } else {
    pass('the Host package stays a peer, so no duplicate Host copy is installed');
  }
}
if (!/RESOLUTION_REMEDY/.test(protocolSource)) {
  fail('host/protocol.js must keep an actionable RESOLUTION_REMEDY for an unresolvable Host package');
} else {
  pass('an unresolvable Host package reports the specifier, cause and remedy');
}

// ── E. bundle patch and browser half ───────────────────────────────────────
console.log('E. bundle patch and browser half');
const patchPath = abs('cordis.patch.yml');
if (!existsSync(patchPath)) {
  fail('cordis.patch.yml is missing');
} else {
  const patch = readFileSync(patchPath, 'utf8');
  if (!/(^|\n)\s*-\s*insert:/.test(patch)) fail('cordis.patch.yml must contain an "insert:" step');
  else pass('patch contains an insert step');
  if (packageName !== '' && !patch.includes(`name: '${packageName}'`) && !patch.includes(`name: "${packageName}"`)) {
    fail(`cordis.patch.yml must insert a row for ${packageName}`);
  } else if (packageName !== '') {
    pass(`patch inserts ${packageName}`);
  }
}

if (!HOST_ONLY && existsSync(abs('client/index.js'))) {
  const clientSource = readFileSync(abs('client/index.js'), 'utf8');
  if (!clientSource.includes('window.__ModuleLoader__.load(')) fail('client/index.js must register through window.__ModuleLoader__.load');
  else pass('browser half registers through the module loader');
  if (packageName !== '' && !clientSource.includes(`id: '${packageName}'`) && !clientSource.includes(`id: "${packageName}"`)) {
    fail(`client/index.js must register under id ${packageName}`);
  } else if (packageName !== '') {
    pass('browser half id matches the package name');
  }
  if (!clientSource.includes('quotaQueue/dispatch')) fail('client/index.js must call the quotaQueue/dispatch endpoint');
  else pass('browser half calls the declared endpoint');
  // Theming and accessibility gates that are checkable without a browser.
  if (/#[0-9a-fA-F]{3,8}\b/.test(clientSource) || /\b(?:rgb|rgba|hsl|hsla)\(/.test(clientSource)) {
    fail('client/index.js must use host theme tokens, not literal color values');
  } else {
    pass('browser half uses theme tokens only');
  }
  if (!clientSource.includes("'aria-label'")) fail('client/index.js must expose accessible control labels');
  else pass('browser half exposes accessible labels');
}

// ── artifact inventory ─────────────────────────────────────────────────────
const shipped = collectSourceFiles();

const artifact = {
  package: packageName,
  version: pkg === null ? null : pkg.version,
  generatedBy: 'scripts/build.mjs',
  hostOnly: HOST_ONLY,
  inventory: 'on-disk scan of public source artifacts: index.js, package.json, cordis.patch.yml, README.md, host/, core/, client/, scripts/, tests/, and reviewed docs allowlist',
  generated: ['build/manifest.json'],
  requiredFiles,
  checks: { failures: failures.length, notes: notes.length, syntaxChecked },
  contract: {
    serviceKey: 'quotaQueue',
    endpoint: 'quotaQueue/dispatch',
    storageUnit: 'quota_queue_v1',
    operatorGate: 'every operation requires invocation.peer === ctx.get(connection).operator',
    capabilities: { quotaCheck: false, execution: false, autoResume: false },
  },
  fileCount: shipped.length,
  files: inventory(shipped),
};

if (EMIT && failures.length === 0) {
  const outDir = abs('build');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  pass('wrote build/manifest.json');
}

// ── summary ────────────────────────────────────────────────────────────────
console.log('');
if (failures.length > 0) {
  console.log(`build FAILED with ${failures.length} problem(s):`);
  for (const message of failures) console.log(`  - ${message}`);
  process.exit(1);
}
console.log(`build ok: ${artifact.fileCount} files inventoried (public source inventory)${EMIT ? ', build/manifest.json written' : ''}`);
console.log('run the tests with: node --test "tests/host/*.test.mjs"');
