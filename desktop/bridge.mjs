// A workspace's worker runs in a process of its own, so what the app gives it, its windows, banners and terminal, goes back and forth as messages.

// Handed over as copies, as each changes, since the worker reads them without waiting.
const KEPT = ['port', 'hotkeys', 'terminalAssets', 'claudeWindow'];
// As the app keeps its banners: an old one nobody clicked is let go.
const KEPT_BANNERS = 50;

const wireError = (err) => ({ message: err?.message ?? String(err), status: err?.status });

// The app's side: one per worker, answering its calls with the desktop it was given.
export function serveWorker({ port, desktop, log }) {
  const commands = new Set();
  const typed = new Map();
  const post = (msg) => port.post(msg);

  async function call({ n, name, args }) {
    try {
      const fn = desktop[name];
      if (typeof fn !== 'function') throw new Error(`the app has no ${name} for this workspace`);
      post({ t: 'reply', n, value: (await fn(...withCallbacks(name, args))) ?? null });
    } catch (err) {
      post({ t: 'reply', n, error: wireError(err) });
    }
  }

  // A banner's click is the worker's to handle, so it is sent back by the id the worker gave it.
  function withCallbacks(name, args) {
    if (name !== 'notify') return args;
    const [{ openId, ...banner }] = args;
    return [{ ...banner, open: () => post({ t: 'callback', id: openId }) }];
  }

  port.on((msg) => {
    if (msg.t === 'log') log(msg.text);
    else if (msg.t === 'register') commands.add(msg.id);
    else if (msg.t === 'call') call(msg);
    else if (msg.t === 'subscribe' && !typed.has(msg.name)) typed.set(msg.name, desktop.onTerminalTyped?.(() => post({ t: 'event', name: msg.name })));
    else if (msg.t === 'unsubscribe') {
      typed.get(msg.name)?.();
      typed.delete(msg.name);
    }
  });

  return {
    has: (id) => commands.has(id),
    run: (id, ...args) => post({ t: 'command', id, args }),
    keep: (key, value) => post({ t: 'set', key, value }),
    end: () => {
      for (const off of typed.values()) off?.();
      typed.clear();
    },
  };
}

export function initOf(desktop) {
  return {
    methods: Object.keys(desktop).filter((name) => typeof desktop[name] === 'function' && name !== 'claudeWindow'),
    claudeWindow: typeof desktop.claudeWindow === 'function',
    kept: Object.fromEntries(KEPT.map((key) => [key, typeof desktop[key] === 'function' ? desktop[key]() : (desktop[key] ?? null)])),
  };
}

// The worker's side: the ctx it is activated with, as if the app were in the same process.
export function workerCtx({ port, init }) {
  const handlers = new Map();
  const callbacks = new Map();
  const pending = new Map();
  const typed = new Set();
  const kept = { ...init.kept };
  let next = 0;
  const post = (msg) => port.post(msg);

  function call(name, args) {
    const n = (next += 1);
    post({ t: 'call', n, name, args });
    return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
  }

  const methods = Object.fromEntries(init.methods.map((name) => [name, (...args) => call(name, args)]));
  methods.notify &&= ({ open, ...banner }) => {
    const openId = `b${(next += 1)}`;
    if (typeof open === 'function') callbacks.set(openId, open);
    if (callbacks.size > KEPT_BANNERS) callbacks.delete(callbacks.keys().next().value);
    return call('notify', [{ ...banner, openId }]);
  };
  methods.onTerminalTyped &&= (fn) => {
    typed.add(fn);
    if (typed.size === 1) post({ t: 'subscribe', name: 'typed' });
    return () => {
      typed.delete(fn);
      if (!typed.size) post({ t: 'unsubscribe', name: 'typed' });
    };
  };
  const desktop = Object.defineProperties(methods, Object.fromEntries(
    ['port', 'hotkeys', 'terminalAssets'].map((key) => [key, { enumerable: true, get: () => kept[key] ?? undefined, set: (value) => { kept[key] = value; } }]),
  ));
  if (init.claudeWindow) desktop.claudeWindow = () => kept.claudeWindow;

  port.on((msg) => {
    if (msg.t === 'reply') {
      const waiting = pending.get(msg.n);
      pending.delete(msg.n);
      if (msg.error) waiting?.reject(Object.assign(new Error(msg.error.message), msg.error.status ? { status: msg.error.status } : {}));
      else waiting?.resolve(msg.value);
    } else if (msg.t === 'command') {
      Promise.resolve()
        .then(() => handlers.get(msg.id)?.(...(msg.args ?? [])))
        .catch((err) => post({ t: 'log', text: `${msg.id} failed: ${err.message}` }));
    } else if (msg.t === 'callback') {
      const open = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      Promise.resolve().then(open).catch((err) => post({ t: 'log', text: `could not open what a banner named: ${err.message}` }));
    } else if (msg.t === 'event') {
      for (const fn of typed) fn();
    } else if (msg.t === 'set') {
      kept[msg.key] = msg.value;
    }
  });

  return {
    log: (text) => post({ t: 'log', text }),
    commands: { register: (id, handler) => (handlers.set(id, handler), post({ t: 'register', id })) },
    desktop,
  };
}
