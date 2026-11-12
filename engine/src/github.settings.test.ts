import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'underlings-github-settings-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { updateSettings } = await import('./settingsedit.js');
const { NESTED_ROWS, nestedValue, DEFAULT_GITHUB, githubApiOf } = await import('./settings.js');
const { changeSettings, loadSettings } = await import('./data/store.js');
const { STATE_FILE } = await import('./config.js');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => changeSettings((s) => ({ ...s, github: DEFAULT_GITHUB })));

test('the GitHub settings are a switch, an inbox scope, a repos filter and an API host, saved tidied and refusing what is not one of them', () => {
  assert.deepEqual(NESTED_ROWS.filter((r) => r.key.startsWith('github.')).map((r) => [r.key, r.kind]), [['github.on', 'toggle'], ['github.scope', 'choice'], ['github.repos', 'text'], ['github.host', 'text']]);
  const saved = updateSettings({ 'github.on': 'true', 'github.scope': 'orgs', 'github.repos': ' acme-co ,  !acme-co/old ', 'github.host': 'ghe.acme.test/api/v3/' });
  assert.deepEqual(saved.applied, ['github.on', 'github.scope', 'github.repos', 'github.host']);
  assert.deepEqual(saved.settings.github, { on: true, scope: 'orgs', repos: 'acme-co, !acme-co/old', host: 'https://ghe.acme.test/api/v3' });
  assert.deepEqual([nestedValue(saved.settings, 'github.on'), nestedValue(saved.settings, 'github.scope')], [true, 'orgs']);
  const refused = updateSettings({ 'github.on': 'maybe', 'github.scope': 'everyone', 'github.host': 'ftp://nope' });
  assert.deepEqual([refused.applied, refused.dropped], [[], ['github.on', 'github.scope', 'github.host']]);
  assert.deepEqual(loadSettings().github, saved.settings.github);
  updateSettings({ 'github.on': false, 'github.host': '' });
  assert.deepEqual([loadSettings().github.on, githubApiOf(loadSettings())], [false, 'https://api.github.com']);
});

test('settings saved before GitHub existed read as GitHub off with its defaults, and reading them rewrites nothing', () => {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ watches: {}, seen: {}, settings: { pollSeconds: 600, jira: { projects: 'ABC' } } }));
  const before = readFileSync(STATE_FILE, 'utf8');
  const settings = loadSettings();
  assert.deepEqual(settings.github, { on: false, scope: 'involved', repos: '', host: 'https://api.github.com' });
  assert.equal(settings.pollSeconds, 600);
  assert.equal(readFileSync(STATE_FILE, 'utf8'), before);
});

test('a GitHub group saved with only some of its fields keeps the defaults of the rest', () => {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ watches: {}, seen: {}, settings: { github: { on: true } } }));
  assert.deepEqual(loadSettings().github, { on: true, scope: 'involved', repos: '', host: 'https://api.github.com' });
});
