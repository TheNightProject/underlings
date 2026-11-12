// The real worker as the app runs it, with the main process's windows and pty faked and every other process stubbed.
import { execFile as realExecFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

export async function terminalWorld(config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'control-centre-terminal-'));
  const bin = join(home, 'bin');
  mock.module('node:child_process', {
    namedExports: {
      spawn,
      execFile(cmd, args, options, done) {
        if (cmd.startsWith(bin + '/')) return realExecFile(cmd, args, options, done);
        setImmediate(() => done(Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), '', ''));
      },
    },
  });
  process.env.HOME = home;
  process.env.GITLAB_TOKEN = 'stub';
  process.env.ORCA_TERMINAL_HANDLE = 'left-by-orca';
  process.env.TERM_PROGRAM = 'iTerm.app';
  await mkdir(bin, { recursive: true });
  process.env.UNDERLINGS_CLAUDE_BIN = join(bin, 'claude');
  await writeFile(process.env.UNDERLINGS_CLAUDE_BIN, '#!/bin/sh\necho "fake claude $*"\n');
  await chmod(process.env.UNDERLINGS_CLAUDE_BIN, 0o755);
  const panelEngine = new URL('./panel-engine.mjs', import.meta.url).href;
  const matrixEngine = join(home, 'engine.mjs');
  await writeFile(matrixEngine, `export * from '${panelEngine}';
export const childEnv = (bin, env = process.env) => ({ ...Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('ORCA_'))), CHILD_ENV_MARK: 'agents' });
`);
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, orcaUserDataPath: '/orca-profile', matrixEngine, ...config }));
  const { world } = await import('./panel-engine.mjs');
  world.settings = { workspaceRoot: '/ws-root' };

  const app = { opened: [], restarted: [], pasted: [], typed: new Set(), banners: [] };
  const assetFile = join(home, 'xterm.js');
  await writeFile(assetFile, 'globalThis.Terminal = class {};\n');
  const desktop = {
    port: 0,
    showPage: () => ({ reused: false }),
    focus() {},
    quit() {},
    notify: (banner) => {
      app.banners.push(banner);
      return { delivered: true };
    },
    openExternal: async () => ({ ok: true }),
    popOut() {},
    dockClaude() {},
    claudeOnTop() {},
    claudeWindow: () => ({ shown: false, onTop: true }),
    openTerminal: (spec) => {
      app.opened.push(spec);
      return { shown: true };
    },
    pasteTerminal: async (text) => {
      app.pasted.push(text);
      return true;
    },
    restartTerminal: (spec) => {
      app.restarted.push(spec);
      return { shown: true };
    },
    onTerminalTyped: (fn) => {
      app.typed.add(fn);
      return () => app.typed.delete(fn);
    },
    terminalAssets: { 'xterm.js': assetFile },
  };
  const worker = await import('../../worker.mjs');
  const logged = [];
  await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, host: { call: async () => undefined }, desktop });
  const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
  const origin = pageUrl.origin;
  const token = pageUrl.searchParams.get('t');
  const STATE = join(home, '.local/state/underlings/claude');
  const post = (path, body, headers = { 'x-cc-token': token, origin }) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`${origin}/api/state?t=${token}`)).json();
  const readJson = async (name) => JSON.parse(await readFile(join(STATE, name), 'utf8'));
  await until(async () => (await state()).claudeCode?.available, 'the worker\'s modules to start');
  const close = async () => {
    await worker.deactivate();
    await rm(home, { recursive: true });
  };
  return { home, bin, world, app, origin, token, STATE, post, state, readJson, close, hookScript: fileURLToPath(new URL('../claudehook.mjs', import.meta.url)), signScript: fileURLToPath(new URL('../slacksignhook.mjs', import.meta.url)) };
}

export async function until(check, what) {
  for (let i = 0; i < 150; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`gave up waiting for ${what}`);
}
