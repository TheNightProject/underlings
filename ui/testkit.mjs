// A stand-in browser for page tests: just enough DOM to run ui/*.js over dashboard.html and inspect what render() leaves.
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { branded } from '../lib/product.mjs';

const ROOT = new URL('../', import.meta.url);
const VOID = new Set(['meta', 'link', 'br', 'img', 'input', 'hr']);
// What the worker sends for a machine in London; a test of another place sends its own.
export const LONDON_LOCALE = { timeZone: 'Europe/London', zoneSet: '', machineZone: 'Europe/London', region: 'en-GB', clock: '24', hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] }, days: 'weekdays' };

class Target {
  listeners = [];

  addEventListener(type, fn, options) {
    this.listeners.push({ type, fn, capture: options === true || Boolean(options?.capture) });
  }

  removeEventListener(type, fn, options) {
    const capture = options === true || Boolean(options?.capture);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }

  fire(event, capture) {
    for (const l of this.listeners.filter((x) => x.type === event.type && x.capture === capture)) {
      event.currentTarget = this;
      l.fn.call(this, event);
    }
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });
    this.defaultPrevented = false;
    this.stopped = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.stopped = true;
  }
}

class Node extends Target {
  parentNode = null;
  childNodes = [];

  constructor(doc) {
    super();
    this.ownerDocument = doc;
  }

  // A failed assertion prints this rather than the whole page the node hangs from.
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.nodeType === 1 ? `<${this.tagName.toLowerCase()}${this.id ? '#' + this.id : ''}>` : JSON.stringify(this.textContent.slice(0, 40));
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  // Like the real thing, anything that is not a node becomes text, null included.
  append(...kids) {
    for (const kid of kids) {
      const node = kid instanceof Node ? kid : new Text(this.ownerDocument, String(kid));
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  after(...kids) {
    const nodes = kids.map((kid) => (kid instanceof Node ? kid : new Text(this.ownerDocument, String(kid))));
    for (const node of nodes) node.remove();
    for (const node of nodes) node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this) + 1, 0, ...nodes);
  }

  prepend(...kids) {
    const rest = this.childNodes;
    this.childNodes = [];
    this.append(...kids);
    this.childNodes.push(...rest);
  }

  replaceChildren(...kids) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...kids);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }

  replaceWith(...kids) {
    const parent = this.parentNode;
    const nodes = kids.map((kid) => (kid instanceof Node ? kid : new Text(this.ownerDocument, String(kid))));
    for (const node of nodes) node.remove();
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, ...nodes);
    for (const node of nodes) node.parentNode = parent;
    this.parentNode = null;
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType === 1 && matches(c, selector)) found.push(c); walk(c); });
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  dispatchEvent(event) {
    event.target ??= this;
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    if (path.at(-1) === this.ownerDocument) path.push(this.ownerDocument.defaultView);
    for (const n of [...path].reverse()) if (!event.stopped) n.fire(event, true);
    for (const n of event.bubbles ? path : [this]) if (!event.stopped) n.fire(event, false);
    return !event.defaultPrevented;
  }
}

class Text extends Node {
  nodeType = 3;

  constructor(doc, data) {
    super(doc);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }
}

class Comment extends Node {
  nodeType = 8;

  get textContent() {
    return '';
  }
}

class Element extends Node {
  nodeType = 1;
  attributes = new Map();
  style = {};
  scrollTop = 0;

  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.dataset = new Proxy({}, {
      get: (_, k) => this.getAttribute('data-' + kebab(k)) ?? undefined,
      set: (_, k, v) => { this.setAttribute('data-' + kebab(k), v); return true; },
    });
  }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { this.toggleAttribute('hidden', v); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { this.toggleAttribute('disabled', v); }
  get open() { return this.hasAttribute('open'); }
  set open(v) { this.toggleAttribute('open', v); }
  get content() { return this.getAttribute('content'); }
  get href() { return this.getAttribute('href'); }
  get isContentEditable() { return this.closest('[contenteditable]')?.getAttribute('contenteditable') === 'true'; }
  set innerHTML(markup) { this.markup = markup; }

  set textContent(text) {
    this.replaceChildren(String(text));
  }

  get textContent() {
    return super.textContent;
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(' '); };
    return {
      get length() { return names().length; },
      contains: (n) => names().includes(n),
      add: (n) => set([...new Set([...names(), n])]),
      remove: (n) => set(names().filter((x) => x !== n)),
      toggle: (n, on = !names().includes(n)) => { set(on ? [...new Set([...names(), n])] : names().filter((x) => x !== n)); return on; },
    };
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  toggleAttribute(name, on) {
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
  }

  matches(selector) {
    return matches(this, selector);
  }

  closest(selector) {
    for (let n = this; n?.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }

  // A disabled control, or anything inside an inert part of the page, refuses focus as it does in a browser.
  focus() {
    for (let n = this; n?.nodeType === 1; n = n.parentNode) if (n.inert) return;
    if (!this.disabled && this.isConnected) this.ownerDocument.focused = this;
  }

  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true }));
  }

  scrollIntoView() {}
  setSelectionRange() {}
  select() {}

  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
}

class Document extends Node {
  nodeType = 9;
  focused = null;

  get documentElement() { return this.childNodes.find((c) => c.nodeType === 1); }
  get head() { return this.querySelector('head'); }
  get body() { return this.querySelector('body'); }
  get activeElement() { return this.focused?.isConnected ? this.focused : this.body; }

  createElement(tag) { return new Element(this, tag); }
  createElementNS(ns, tag) { return new Element(this, tag); }
  createTextNode(data) { return new Text(this, data); }
  createComment() { return new Comment(this); }
  getElementById(id) { return this.querySelectorAll('[id]').find((n) => n.id === id) ?? null; }
  execCommand() { return false; }
}

function kebab(name) {
  return String(name).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function matchesOne(node, part) {
  if (node.nodeType !== 1) return false;
  const [, tag, rest] = /^([a-zA-Z][\w-]*|\*)?(.*)$/.exec(part);
  if (tag && tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
  for (const [, kind, name, attr, value] of rest.matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
    if (kind === '#' && node.id !== name) return false;
    if (kind === '.' && !node.classList.contains(name)) return false;
    if (attr && (value === undefined ? !node.hasAttribute(attr) : node.getAttribute(attr) !== value)) return false;
  }
  return true;
}

// Compound selectors joined by spaces, and lists of them joined by commas, which is all the page uses.
function matches(node, selector) {
  if (selector.includes(',')) return selector.split(',').some((one) => matches(node, one));
  const parts = selector.trim().split(/\s+/);
  if (!matchesOne(node, parts.pop())) return false;
  let at = node.parentNode;
  for (const part of parts.reverse()) {
    while (at && !matchesOne(at, part)) at = at.parentNode;
    if (!at) return false;
    at = at.parentNode;
  }
  return true;
}

function parseInto(doc, html) {
  const open = [doc];
  for (const [, closing, tag, attrs, text] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|<![^>]*>/g)) {
    const top = open.at(-1);
    if (text) top.append(text);
    if (!tag) continue;
    if (closing) {
      while (open.length > 1 && open.pop().tagName !== tag.toUpperCase());
      continue;
    }
    const node = doc.createElement(tag);
    for (const [, name, value = ''] of attrs.matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) node.setAttribute(name, value);
    top.append(node);
    if (!VOID.has(tag.toLowerCase())) open.push(node);
  }
}

function timers() {
  const unref = (t) => { t?.unref?.(); return t; };
  return { setTimeout: (fn, ms) => unref(setTimeout(fn, ms)), clearTimeout, setInterval: () => 0, clearInterval() {} };
}

// Each file runs on its own, like the page's one tag per file, so one that throws leaves the others loaded.
export async function openPage({ respond = () => null, search = '?t=test', storage, globals = {} } = {}) {
  const doc = new Document(null);
  doc.ownerDocument = doc;
  parseInto(doc, branded(await readFile(new URL('dashboard.html', ROOT), 'utf8')));
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'cc-ui');
  meta.setAttribute('content', '1');
  doc.head.append(meta);
  const errors = [];
  let snapshot = null;
  const requested = [];
  const answer = (path, init) => {
    requested.push(path);
    const value = path.split('?')[0] === '/api/state' ? snapshot : respond(path, init);
    const body = JSON.stringify(value ?? null);
    return { ok: value != null, status: value != null ? 200 : 404, json: async () => JSON.parse(body), text: async () => 'not stubbed: ' + path };
  };
  const win = new Target();
  const context = Object.assign(win, {
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    document: doc,
    location: { search, hash: '', href: 'http://127.0.0.1/' + search, reload() {} },
    ...(storage ? { localStorage: storage } : {}),
    navigator: {},
    console: { error: (...a) => errors.push(a.map(String).join(' ')), warn() {}, log() {} },
    URLSearchParams,
    EventSource: class { onmessage = null; },
    fetch: async (path, init) => answer(path, init),
    Event: FakeEvent,
    ...timers(),
    ...globals,
  });
  context.window = context;
  vm.createContext(context);
  doc.defaultView = context;
  const names = (await readdir(new URL('ui/', ROOT))).filter((n) => n.endsWith('.js')).sort();
  for (const name of names) {
    try {
      vm.runInContext(await readFile(new URL('ui/' + name, ROOT), 'utf8'), context, { filename: 'ui/' + name });
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
  }
  const run = (code) => vm.runInContext(code, context);
  return {
    window: context,
    document: doc,
    errors,
    requested,
    run,
    $: (selector) => doc.querySelector(selector),
    $$: (selector) => doc.querySelectorAll(selector),
    show(shown, hash = 'overview') {
      const next = shown.locale ? shown : { ...shown, locale: LONDON_LOCALE };
      snapshot = next;
      context.location.hash = '#' + hash;
      run('state = ' + JSON.stringify(next) + '; render();');
    },
    fire(node, type, init = {}) {
      return node.dispatchEvent(new FakeEvent(type, { bubbles: true, ...init }));
    },
    settle: (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
