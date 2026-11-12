import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'control-centre-profile-'));
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';

const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `export * from '${testkit}';
export const fake = { name: 'Ada Lovelace', asked: 0 };
export async function fetchMyName() { fake.asked += 1; if (fake.name instanceof Error) throw fake.name; return fake.name; }
`);

const { route } = await import('./app.mjs');
const { loadEngine } = await import('./engine.mjs');
const profile = await import('./profile.mjs');
const { fake } = await import(pathToFileURL(enginePath).href);
after(() => rm(home, { recursive: true }));

const file = join(home, '.config/underlings/profile.json');
const call = (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config: {} });
const view = () => call('GET', '/api/profile');
const save = (patch) => call('POST', '/api/profile', patch);
const saved = async () => JSON.parse(await readFile(file, 'utf8'));
const plant = async (value) => {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(file, JSON.stringify(value));
};

beforeEach(async () => {
  await rm(join(home, '.config'), { recursive: true, force: true });
  await rm(process.env.GIT_CONFIG_GLOBAL, { force: true });
  Object.assign(fake, { name: 'Ada Lovelace', asked: 0 });
  await loadEngine({ matrixEngine: enginePath }, () => {});
  profile.start({}, {});
});

test('a first run with no name asks for one, offering the first name GitLab has for you', async () => {
  assert.deepEqual(await view(), { name: '', ask: true, suggested: 'Ada', style: { language: '', rules: '' } });
  await view();
  assert.equal(fake.asked, 1, 'GitLab is asked once');
});

test('with GitLab unreachable the offer is the first name git has for you, and with neither it is blank', async () => {
  fake.name = new Error('GitLab said 401');
  await writeFile(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Grace Hopper\n');
  assert.equal((await view()).suggested, 'Grace');
  profile.start({}, {});
  await rm(process.env.GIT_CONFIG_GLOBAL);
  assert.equal((await view()).suggested, '');
});

test('a saved name stops the asking, and it is kept only for you to read', async () => {
  const answer = await save({ name: '  Ada\nLovelace ' });
  assert.deepEqual([answer.name, answer.ask, answer.text], ['Ada Lovelace', false, 'Prompts call you Ada Lovelace']);
  assert.equal((await saved()).user.name, 'Ada Lovelace');
  assert.ok(Date.parse((await saved()).user.askedAt));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await view()).ask, false);
});

test('a skip leaves the name blank, so prompts say "you", and never asks again', async () => {
  const answer = await save({ skip: true });
  assert.deepEqual([answer.name, answer.ask], ['', false]);
  assert.match(answer.text, /Prompts say "you"/);
  assert.deepEqual(profile.person(await profile.loadProfile()), { who: 'you', whose: 'your' });
  assert.equal((await view()).ask, false);
});

test('the language and writing rules are saved as given, and a patch with nothing in it is refused', async () => {
  const answer = await save({ language: 'Canadian French', rules: 'No em dashes.\nNever promise a date.' });
  assert.deepEqual(answer.style, { language: 'Canadian French', rules: 'No em dashes.\nNever promise a date.' });
  assert.equal(answer.text, 'Prompts ask for Canadian French. Your writing rules go into every prompt');
  assert.equal(profile.wantsNoEmDash(await profile.loadProfile()), true);
  await save({ rules: 'Be brief.' });
  assert.equal(profile.wantsNoEmDash(await profile.loadProfile()), false);
  await assert.rejects(save({ colour: 'blue' }), { status: 400 });
});
