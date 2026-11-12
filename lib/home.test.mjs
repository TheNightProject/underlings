import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT, oldHome, oldPlaces, snapshot } from './fixtures/oldhome.mjs';
import { checkCopy, configDir, engineStateDir, LEFT_NOTE, logsDir, MARKER, migrateHome, stateDir } from './home.mjs';

const homes = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

function scratch() {
  const home = mkdtempSync(join(tmpdir(), 'underlings-home-'));
  homes.push(home);
  return home;
}

const newPlaces = (home) => ({
  config: join(home, '.config/underlings'),
  state: join(home, '.local/state/underlings'),
  engine: join(home, '.local/state/underlings/engine'),
  logs: join(home, 'Library/Logs/Underlings'),
  appData: join(home, 'Library/Application Support/Underlings'),
});
const ALL = ['config', 'state', 'logs', 'appData'];
const userData = (home) => newPlaces(home).appData;
const move = (home, parts = ALL) => migrateHome({ home, parts, userData: userData(home) });
const outcomes = (moved) => Object.fromEntries(Object.entries(moved).map(([part, m]) => [part, m.outcome]));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const withoutNote = (shot) => Object.fromEntries(Object.entries(shot).filter(([key]) => key !== LEFT_NOTE));

test('a fresh home moves nothing, makes nothing, and every reader is pointed at the new folders', () => {
  const home = scratch();
  assert.deepEqual(outcomes(move(home)), { config: 'fresh', state: 'fresh', logs: 'fresh', appData: 'fresh' });
  assert.deepEqual(readdirSync(home), []);
  const now = newPlaces(home);
  assert.deepEqual([configDir(home), stateDir(home), engineStateDir(home), logsDir(home)], [now.config, now.state, now.engine, now.logs]);
});

test('an old home is copied across whole, checked, marked, and left as it was with a note saying it can go', () => {
  const home = scratch();
  const old = oldHome(home);
  const before = Object.fromEntries(Object.entries(old).map(([part, dir]) => [part, snapshot(dir)]));
  assert.deepEqual(outcomes(move(home)), { config: 'moved', state: 'moved', logs: 'moved', appData: 'moved' });
  const now = newPlaces(home);
  for (const [part, dir] of Object.entries(old)) {
    assert.deepEqual(withoutNote(snapshot(dir)), before[part], `${part}: the old folder is untouched`);
    assert.match(readFileSync(join(dir, LEFT_NOTE), 'utf8'), /copied this folder to .*Underlings|copied this folder to .*underlings/);
    assert.match(readFileSync(join(dir, LEFT_NOTE), 'utf8'), /you can delete it/);
  }
  const copied = (part, under = '') => Object.fromEntries(Object.entries(snapshot(join(now[part], under))).filter(([key]) => key !== MARKER && !key.startsWith('engine/') && key !== 'engine/'));
  const same = (shot, changed) => Object.fromEntries(Object.entries(shot).filter(([key]) => !changed.includes(key)));
  assert.deepEqual(same(copied('config'), ['config.json', 'slack.json']), same(before.config, ['config.json', 'slack.json']), 'every config file, mode and all');
  assert.deepEqual(same(copied('state'), []), before.state, 'the token, the game ledger, the Claude panel session and the rest');
  assert.deepEqual(same(snapshot(now.engine), [`agents/${AGENT}/agent.json`]), same(before.engine, [`agents/${AGENT}/agent.json`]), 'the queue, runs, archive and state');
  assert.equal(statSync(join(now.config, 'gitlab-token')).mode & 0o777, 0o600);
  assert.equal(statSync(join(now.state, 'claude')).mode & 0o777, 0o700);
  assert.deepEqual(json(join(now.state, 'claude/terminal.json')), { id: '9b7a922c-f855-4be9-bae2-eb2b0bcf6c07', resumable: true, account: '2' });
  assert.equal(json(join(now.engine, 'state.json')).settings.fullAuto, 'ivan:comments');
  const marker = json(join(now.state, MARKER));
  assert.deepEqual(marker.from, [old.state, old.engine]);
  assert.deepEqual(marker.rewritten, [`engine/agents/${AGENT}/agent.json`]);
  assert.deepEqual([configDir(home), stateDir(home), engineStateDir(home)], [now.config, now.state, now.engine]);
});

test('paths into the old folders are rewritten where a later read would follow them, and nowhere else', () => {
  const home = scratch();
  const old = oldHome(home);
  move(home);
  const now = newPlaces(home);
  const config = json(join(now.config, 'config.json'));
  assert.deepEqual([config.stateDir, config.appPath, config.orcaUserDataPath, config.port], [now.state, '/Applications/Underlings.app', '/orca-profile', 47321]);
  assert.equal('signature' in json(join(now.config, 'slack.json')), false, 'a signature saved as the old default follows the new one');
  assert.deepEqual(json(join(now.engine, `agents/${AGENT}/agent.json`)).args, ['--mcp-config', join(now.state, 'claude/mcp.json'), '--settings', join(now.state, 'claude/settings.json')]);
  assert.match(readFileSync(join(now.state, 'artifacts.jsonl'), 'utf8'), new RegExp(old.state.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'a record of the past is copied as it was');
});

test('the app folder leaves its caches and lock behind, and keeps its links as links', () => {
  const home = scratch();
  oldHome(home);
  move(home, ['appData']);
  const kept = Object.keys(snapshot(userData(home))).sort();
  assert.deepEqual(kept, ['Local Storage/', 'Local Storage/leveldb/', 'Local Storage/leveldb/000003.log', MARKER, 'Partitions/', 'Partitions/claude-ai/', 'Partitions/claude-ai/Cookies', 'artifact-window.json', 'claude-window.json', 'linked.json', 'window.json'].sort());
  for (const name of ['window.json', 'claude-window.json', 'artifact-window.json']) {
    assert.deepEqual(json(join(userData(home), name)), json(join(oldPlaces(home).appData, name)), `${name} comes across in the shape the app reads, x, y, width and height`);
  }
});

test('with the new folders there already, nothing is copied over them and the old ones get no note', () => {
  const home = scratch();
  const old = oldHome(home);
  const now = newPlaces(home);
  for (const dir of [now.config, now.state, now.logs, now.appData]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'token'), 'newer\n');
  }
  assert.deepEqual(outcomes(move(home)), { config: 'present', state: 'present', logs: 'present', appData: 'present' });
  assert.equal(readFileSync(join(now.state, 'token'), 'utf8'), 'newer\n');
  for (const dir of Object.values(old)) assert.equal(existsSync(join(dir, LEFT_NOTE)), false);
});

test('an empty new folder, as Electron makes the app\'s own before any of its code runs, is filled all the same', () => {
  const home = scratch();
  oldHome(home);
  const now = newPlaces(home);
  for (const dir of [now.config, now.state, now.logs, now.appData]) mkdirSync(dir, { recursive: true });
  assert.deepEqual(outcomes(move(home)), { config: 'moved', state: 'moved', logs: 'moved', appData: 'moved' });
  assert.equal(json(join(userData(home), 'window.json')).width, 1400);
  assert.equal(json(join(newPlaces(home).engine, 'queue.json'))[0].body, 'A finding to keep');
});

test('it never runs twice: a second start finds it done, and a new folder deleted later is not filled again', () => {
  const home = scratch();
  oldHome(home);
  assert.equal(move(home).state.outcome, 'moved');
  assert.deepEqual(outcomes(move(home)), { config: 'present', state: 'present', logs: 'present', appData: 'present' });
  rmSync(newPlaces(home).state, { recursive: true });
  assert.equal(move(home).state.outcome, 'moved before');
  assert.equal(existsSync(newPlaces(home).state), false);
  assert.equal(stateDir(home), newPlaces(home).state, 'an old folder with the note is never read again');
});

test('while an agent from before still runs, the state and settings wait and stay live where they are', () => {
  const home = scratch();
  const old = oldHome(home);
  writeFileSync(join(old.engine, `agents/${AGENT}/runner.lock`), String(process.pid));
  const moved = move(home);
  assert.deepEqual(outcomes(moved), { config: 'waiting', state: 'waiting', logs: 'moved', appData: 'moved' });
  assert.match(moved.state.why, new RegExp(`1 agent still running from before \\(pid ${process.pid}\\)`));
  assert.deepEqual([configDir(home), stateDir(home), engineStateDir(home)], [old.config, old.state, old.engine], 'the old folders stay the live ones');
  assert.equal(existsSync(join(old.state, LEFT_NOTE)), false);
  writeFileSync(join(old.engine, `agents/${AGENT}/runner.lock`), '');
  assert.equal(move(home).state.outcome, 'moved', 'and it moves on the next start once the agent is done');
});

test('a worker still beating on the old folders keeps them where they are too', () => {
  const home = scratch();
  const old = oldHome(home, { desktop: false });
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    writeFileSync(join(old.engine, `frontends/control-centre-${other.pid}.json`), JSON.stringify({ v: 1, owner: 'control-centre', pid: other.pid, ppid: 1, wants: true, why: '', startedAt: Date.now(), beatAt: Date.now() }));
    const moved = migrateHome({ home });
    assert.deepEqual(outcomes(moved), { config: 'waiting', state: 'waiting' });
    assert.match(moved.state.why, new RegExp(`another copy of the app still uses the old folders \\(pid ${other.pid}\\)`));
  } finally {
    other.kill();
  }
});

test('a copy that fails part way leaves no new folder, no half copy and no note, so the old ones stay live', () => {
  const home = scratch();
  const old = oldHome(home, { desktop: false });
  chmodSync(join(old.engine, 'runs.json'), 0o000);
  try {
    const moved = migrateHome({ home });
    assert.equal(moved.state.outcome, 'failed');
    assert.match(moved.state.why, /EACCES|permission/i);
    assert.deepEqual(readdirSync(join(home, '.local/state')).sort(), ['control-centre', 'thematrix']);
    assert.equal(existsSync(join(old.state, LEFT_NOTE)), false);
    assert.equal(stateDir(home), old.state);
    assert.equal(moved.config.outcome, 'moved', 'the config is a move of its own');
  } finally {
    chmodSync(join(old.engine, 'runs.json'), 0o644);
  }
});

test('two processes starting at once end with one whole copy', async () => {
  const home = scratch();
  oldHome(home, { desktop: false });
  const HOME_MODULE = fileURLToPath(new URL('./home.mjs', import.meta.url));
  const race = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { migrateHome } from ${JSON.stringify(HOME_MODULE)}; console.log(migrateHome({ home: ${JSON.stringify(home)} }).state.outcome);`]);
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  });
  const said = (await Promise.all([race(), race()])).sort();
  assert.ok(said.includes('moved'), said.join(', '));
  assert.ok(said.every((s) => s === 'moved' || s === 'present'), said.join(', '));
  assert.deepEqual(json(join(newPlaces(home).engine, 'queue.json'))[0].body, 'A finding to keep');
  assert.deepEqual(readdirSync(join(home, '.local/state')).filter((n) => n.startsWith('.')), [], 'no half copy is left behind');
});

test('a copied file is checked against its source, byte for byte, and keeps its mode', () => {
  const dir = scratch();
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  writeFileSync(a, 'the queue');
  chmodSync(a, 0o600);
  writeFileSync(b, 'the queue');
  chmodSync(b, 0o644);
  checkCopy(a, b, 'queue.json');
  assert.equal(statSync(b).mode & 0o777, 0o600);
  writeFileSync(b, 'the queuE');
  assert.throws(() => checkCopy(a, b, 'queue.json'), /queue\.json changed or did not copy whole/);
  rmSync(b);
  assert.throws(() => checkCopy(a, b, 'queue.json'), /queue\.json did not copy/);
});
