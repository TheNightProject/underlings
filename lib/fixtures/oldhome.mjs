// A home as the app left it under its old names: every kind of file the config, the state and the engine keep, with the modes they are written with.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const AGENT = '0c35fbbf-2dd4-42de-9183-051fb7c1ad5d';
export const SESSION = '9b7a922c-f855-4be9-bae2-eb2b0bcf6c07';
export const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

export const oldPlaces = (home) => ({
  config: join(home, '.config/control-centre'),
  state: join(home, '.local/state/control-centre'),
  engine: join(home, '.local/state/thematrix'),
  logs: join(home, 'Library/Logs/Control Centre'),
  appData: join(home, 'Library/Application Support/Control Centre'),
});

function put(path, value, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(path, mode);
}

export function oldHome(home, { config = true, state = true, engine = true, desktop = true, port = 47321, extra = {} } = {}) {
  const at = oldPlaces(home);
  const dead = deadPid();
  if (config) {
    put(join(at.config, 'config.json'), { orcaUserDataPath: '/orca-profile', port, stateDir: at.state, appPath: '/Applications/Control Centre.app', ...extra });
    put(join(at.config, 'gitlab-token'), 'gl-fake-not-a-real-token\n', 0o600);
    put(join(at.config, 'slack.json'), { enabled: true, needsYou: true, keywords: [], skip: [], signature: 'Sent with Control Centre' }, 0o600);
    put(join(at.config, 'email.json'), { enabled: true, needsYou: true, from: 'me@example.com', to: [], skip: [] }, 0o600);
    put(join(at.config, 'standup.json'), { calendarAddress: 'https://calendar.example/private.ics', excludedRepos: ['acme/old'] }, 0o600);
    put(join(at.config, 'updates.json'), { channel: 'releases' }, 0o600);
    put(join(at.config, 'profile.json'), { user: { name: 'Ivan', askedAt: '2026-11-01T09:00:00Z' }, style: { language: 'British English', rules: 'No em dashes.' } });
    put(join(at.config, 'locale.json'), { locale: { timeZone: '', region: 'en-GB', clock: '24' } });
    put(join(at.config, 'setup.json'), { doneAt: '2026-11-01T09:05:00Z' }, 0o600);
  }
  if (state) {
    mkdirSync(at.state, { recursive: true });
    put(join(at.state, 'token'), 'kept-page-token\n', 0o600);
    put(join(at.state, 'url'), 'http://127.0.0.1:47321/?t=kept-page-token\n', 0o600);
    put(join(at.state, 'game.jsonl'), ['{"at":"2026-11-10T09:00:00Z","kind":"review","coins":5}', '{"at":"2026-11-10T10:00:00Z","kind":"post","coins":2}', ''].join('\n'), 0o600);
    put(join(at.state, 'game-cache.json'), { seen: { 'acme/engine!1': true } }, 0o600);
    put(join(at.state, 'artifacts.jsonl'), '{"at":"2026-11-09T12:00:00Z","url":"https://claude.ai/artifact/abc123","title":"A plan","dir":"' + join(at.state, 'artifacts/abc123') + '"}\n');
    put(join(at.state, 'artifacts/abc123/index.html'), '<title>A plan</title>');
    put(join(at.state, 'attention.json'), { cards: [], seenAt: 1 }, 0o600);
    put(join(at.state, 'update.json'), { v: 1, from: 'a'.repeat(40), to: 'b'.repeat(40), lines: {}, phase: 'installing', at: '2026-11-11T12:15:00Z' }, 0o600);
    put(join(at.state, 'update-install.log'), 'installed /x/Control Centre.app at /Applications/Control Centre.app\n');
    put(join(at.state, 'release-seen.json'), { version: '1.2.0' }, 0o600);
    put(join(at.state, 'claude/terminal.json'), { id: SESSION, resumable: true, account: '2' }, 0o600);
    put(join(at.state, 'claude/panel.json'), { current: 'claude:' + AGENT }, 0o600);
    put(join(at.state, 'claude/mcp.json'), { mcpServers: { 'control-centre': { type: 'stdio', command: '/Applications/Control Centre.app/Contents/MacOS/Control Centre', args: [], env: {} } } }, 0o600);
    chmodSync(join(at.state, 'claude'), 0o700);
  }
  if (engine) {
    put(join(at.engine, 'queue.json'), [{ id: 'q1', projectPath: 'acme/engine', iid: 621, status: 'pending', severity: 'MINOR', body: 'A finding to keep' }]);
    put(join(at.engine, 'queue.json.bak'), []);
    put(join(at.engine, 'queue-archive.jsonl'), '{"id":"q0","status":"posted","archivedAt":"2026-11-01T00:00:00Z","why":"posted"}\n');
    put(join(at.engine, 'runs.json'), { 'acme/engine!621': { key: 'acme/engine!621', status: 'done', startedAt: '2026-11-10T09:00:00Z', tail: ['Reviewed it'] } });
    put(join(at.engine, 'state.json'), { watches: {}, seen: {}, settings: { fullAuto: 'ivan:comments', agents: { reviewCommand: '/team:review' } } });
    put(join(at.engine, 'auto.json'), { 'acme/engine!621': { key: 'acme/engine!621' } });
    put(join(at.engine, 'repos.json'), [{ path: 'acme/engine', label: 'Engine' }]);
    put(join(at.engine, 'auto.lock'), { v: 1, owner: 'control-centre', pid: dead, token: 'old', startedAt: 1, beatAt: 1 });
    put(join(at.engine, `frontends/control-centre-${dead}.json`), { v: 1, owner: 'control-centre', pid: dead, ppid: 1, wants: true, why: '', startedAt: 1, beatAt: 1 });
    const args = ['--mcp-config', join(at.state, 'claude/mcp.json'), '--settings', join(at.state, 'claude/settings.json')];
    put(join(at.engine, `agents/${AGENT}/agent.json`), { id: AGENT, name: 'chat', kind: 'master', cwd: '/work', createdAt: '2026-11-10T09:00:00Z', args });
    put(join(at.engine, `agents/${AGENT}/events.jsonl`), '{"event":{"type":"system","subtype":"init","session_id":"' + AGENT + '"}}\n');
    put(join(at.engine, `agents/${AGENT}/input.jsonl`), '');
    put(join(at.engine, `agents/${AGENT}/runner.lock`), String(dead));
  }
  if (desktop) {
    put(join(at.logs, 'control-centre.log'), '2026-11-11T12:15:47Z Control Centre at http://127.0.0.1:47321/?t=x\n');
    put(join(at.appData, 'window.json'), { x: 120, y: 80, width: 1400, height: 900 });
    put(join(at.appData, 'claude-window.json'), { onTop: false, x: 400, y: 200, width: 920, height: 640 });
    put(join(at.appData, 'artifact-window.json'), { x: 300, y: 120, width: 1200, height: 800 });
    put(join(at.appData, 'Local Storage/leveldb/000003.log'), 'prefs');
    put(join(at.appData, 'Partitions/claude-ai/Cookies'), 'cookies');
    put(join(at.appData, 'Partitions/claude-ai/Cache/data_0'), 'cache');
    put(join(at.appData, 'GPUCache/index'), 'cache');
    put(join(at.appData, 'Code Cache/js/index'), 'cache');
    symlinkSync('host-1234', join(at.appData, 'SingletonLock'));
    symlinkSync('window.json', join(at.appData, 'linked.json'));
  }
  return at;
}

// Every file under a folder, with its mode and a hash of what it holds, so a test can say nothing changed.
export function snapshot(dir) {
  const out = {};
  const walk = (at) => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, d.name);
      const key = relative(dir, path);
      if (d.isDirectory()) {
        out[key + '/'] = statSync(path).mode & 0o777;
        walk(path);
      } else if (d.isSymbolicLink()) out[key] = 'link';
      else out[key] = `${statSync(path).mode & 0o777}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}
