/**
 * Offline harness for the Quota Queue client bundle.
 *
 * The bundle is a plain script that calls window.__ModuleLoader__.load. These
 * tests execute the real artifact inside node:vm with a stubbed React module
 * table, a recording slot registry and a fake Connection RPC. They are mock UI
 * tests: they prove registration, projection, transport decoding and cleanup,
 * NOT a GUI acceptance run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIENT_PATH = join(HERE, '..', '..', 'client', 'index.js');

export function createReactStub() {
  const React = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      const merged = Object.assign({}, props || {});
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged, children };
    },
    Fragment: 'Fragment',
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}]; },
    useEffect() {},
    useMemo(factory) { return factory(); },
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; },
    useReducer(state) { return [state, function () {}]; }
  };
  return React;
}

export function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  let record = null;
  const react = createReactStub();
  const sandbox = {
    window: { __ModuleLoader__: { load(candidate) { record = candidate; } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    AbortSignal,
    // A real UUID so request-id shape and uniqueness are exercised honestly.
    crypto: { randomUUID: () => randomUUID() }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: CLIENT_PATH });
  if (record === null) throw new Error('client did not call window.__ModuleLoader__.load');
  const requireStub = function (name) {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  };
  const moduleExports = record.factory(requireStub);
  return { record, moduleExports, sandbox, react, source };
}

export function makeCtx(overrides) {
  const options = overrides || {};
  const registrations = [];
  const disposers = [];
  const listeners = new Map();
  const localeDicts = [];
  const services = options.services || {};
  const ctx = {
    effect(fn) {
      const cleanup = fn();
      disposers.push(typeof cleanup === 'function' ? cleanup : function () {});
      return function () {};
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return function () {
        const set = listeners.get(event);
        if (set) set.delete(listener);
      };
    },
    get(name) { return services[name]; },
    locale: {
      register(ns, dicts) { localeDicts.push({ ns: ns, dicts: dicts }); return function () {}; },
      bind() { return function (key) { return key; }; }
    },
    slots: {
      inject(key, callback) {
        const disposer = callback();
        disposers.push(typeof disposer === 'function' ? disposer : function () {});
        return function () {};
      },
      register(slotOptions, component) {
        const entry = { options: slotOptions, component: component, disposed: false };
        registrations.push(entry);
        return function () { entry.disposed = true; };
      }
    },
    connection: options.connection
  };
  return {
    ctx: ctx,
    registrations: registrations,
    disposers: disposers,
    listeners: listeners,
    localeDicts: localeDicts,
    disposeAll() {
      const pending = disposers.splice(0);
      for (const disposer of pending) {
        try { disposer(); } catch (error) { void error; }
      }
    }
  };
}

export function validView(overrides) {
  const base = {
    version: 1,
    revision: 3,
    paused: false,
    configuration: { ready: true, reasons: [] },
    capabilities: { quotaCheck: true, execution: true, autoResume: true },
    tasks: [{
      id: 't1', kind: 'new-session', title: 'Build the thing', prompt: 'do it',
      workspaceId: 'w1', workspacePathSnapshot: 'E:/ws', routeId: 'r1',
      provider: 'westlake-hpc', model: 'deepseek-flash', status: 'queued',
      reason: 'waiting for quota', sessionId: 's1', nextCheckAt: null, attempts: 0
    }],
    workspaces: [{ id: 'w1', name: 'ws', path: 'E:/ws', available: true }],
    routes: [{ id: 'r1', label: 'flash', provider: 'westlake-hpc', model: 'deepseek-flash', available: true }],
    sessionOptIns: {}
  };
  return Object.assign(base, overrides || {});
}

/**
 * Render an element tree without a DOM. This is a smoke renderer, not React:
 * hooks are stateless, effects never run, and only text output is collected.
 * It exists so a component crash or a null dereference fails a test.
 */
export function renderElement(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return '';
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(renderElement).join('');
  if (element && typeof element.type === 'function') return renderElement(element.type(element.props));
  if (element && typeof element.type === 'string') {
    const children = element.props ? element.props.children : undefined;
    if (children === undefined) return '';
    return Array.isArray(children) ? children.map(renderElement).join('') : renderElement(children);
  }
  return '';
}

/** Flatten a returned element tree (component elements are not expanded) for prop assertions. */
export function collectElements(element, out) {
  const list = out || [];
  if (element === null || element === undefined || typeof element === 'boolean') return list;
  if (typeof element === 'string' || typeof element === 'number') return list;
  if (Array.isArray(element)) {
    for (const child of element) collectElements(child, list);
    return list;
  }
  if (typeof element === 'object') {
    list.push(element);
    const children = element.props ? element.props.children : undefined;
    if (children !== undefined) collectElements(children, list);
  }
  return list;
}

/** Build a translate function over one dictionary, mirroring locale interpolation. */
export function makeT(dict) {
  return function (key, params) {
    let text = dict[key];
    if (typeof text !== 'string') text = key;
    if (params) {
      for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
    }
    return text;
  };
}

export function makeScheduler() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers: timers,
    setTimeout(fn, delay) { const id = nextId; nextId += 1; timers.set(id, { fn: fn, delay: delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
}
