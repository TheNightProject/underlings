import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MARKET = join(ROOT, 'plugin');
const PLUGIN = join(MARKET, 'underlings');
const TERMS = process.env.UNDERLINGS_GUARD_TERMS ?? join(userInfo().homedir, '.config/underlings-dev/guard-terms.txt');
const SKILLS = ['kickoff', 'log-progress', 'pre-mr-review', 'review', 'standup'];
const COMMANDS = ['mr-message', 'ticket-create', 'ticket-update', 'update-tickets'];
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

// Read as strictly as a YAML parser would: a value is a quoted string, a boolean, or plain text with no colon, hash or leading indicator in it.
function frontmatter(text) {
  const found = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(found, 'opens with a frontmatter block');
  return Object.fromEntries(found[1].split('\n').map((line) => {
    const [, key, raw] = /^([a-z-]+): (.+)$/.exec(line) ?? assert.fail(`not a key and a value: ${line}`);
    const quoted = /^"([^"\\]*)"$/.exec(raw);
    assert.ok(quoted || /^(true|false)$/.test(raw) || !/^[[{&*!|>'"%@`]|: | #/.test(raw), `${key} is a valid YAML scalar`);
    return [key, quoted ? quoted[1] : raw];
  }));
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])))).flat();
}

async function written() {
  const skills = await Promise.all(SKILLS.map(async (name) => ({ name, kind: 'skill', file: join(PLUGIN, 'skills', name, 'SKILL.md') })));
  const commands = COMMANDS.map((name) => ({ name, kind: 'command', file: join(PLUGIN, 'commands', `${name}.md`) }));
  return Promise.all([...skills, ...commands].map(async (item) => ({ ...item, text: await readFile(item.file, 'utf8') })));
}

test('the manifest and the marketplace name the plugin, at the version of the app, and the marketplace finds it', async () => {
  const manifest = await json(join(PLUGIN, '.claude-plugin/plugin.json'));
  const market = await json(join(MARKET, '.claude-plugin/marketplace.json'));
  assert.equal(manifest.name, 'underlings');
  assert.equal(manifest.version, (await json(join(ROOT, 'package.json'))).version, 'released with the app, so Setup can tell an old copy');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length > 20 && manifest.author?.name && manifest.license);
  assert.equal(market.name, 'underlings');
  assert.ok(market.owner?.name && market.description, 'an owner and a description, which validation asks for');
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [['underlings', './underlings']]);
  assert.equal(resolve(MARKET, market.plugins[0].source), PLUGIN);
  assert.ok('version' in market.plugins[0] === false, 'the version lives in the manifest alone');
});

test('the plugin has exactly the nine workflows, each named as Claude Code reads it, and none renders video', async () => {
  const folders = (dir) => readdir(join(PLUGIN, dir), { withFileTypes: true }).then((es) => es.map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.md$/, ''))).sort());
  assert.deepEqual(await folders('skills'), SKILLS);
  assert.deepEqual(await folders('commands'), COMMANDS);
  assert.deepEqual([...SKILLS, ...COMMANDS].sort(), ['kickoff', 'log-progress', 'mr-message', 'pre-mr-review', 'review', 'standup', 'ticket-create', 'ticket-update', 'update-tickets']);
  for (const { name, kind, text } of await written()) {
    assert.match(name, NAME, name);
    const head = frontmatter(text);
    assert.ok(head.description.length > 30 && head.description.length <= 1024, `${name} has a description`);
    if (kind === 'skill') assert.equal(head.name, name, `${name}: the skill is named for its folder`);
    assert.ok(head['argument-hint'], `${name} says what it takes`);
    assert.ok(text.includes('$ARGUMENTS'), `${name} is handed its arguments`);
  }
  assert.ok(!(await filesUnder(PLUGIN)).some((f) => /demo|remotion/i.test(relative(PLUGIN, f))));
});

test('the workflows that change a tracker or write files are run by name only, while the two a kickoff hands to its workers stay loadable', async () => {
  const by = Object.fromEntries((await written()).map((w) => [w.name, frontmatter(w.text)]));
  for (const name of ['kickoff', 'standup', 'log-progress', 'ticket-create', 'ticket-update', 'update-tickets']) assert.equal(by[name]['disable-model-invocation'], 'true', name);
  for (const name of ['review', 'pre-mr-review']) assert.equal(by[name]['disable-model-invocation'], undefined, name);
});

test('no skill or command names an employer, its people, its tickets or its tooling', async () => {
  const text = await readFile(TERMS, 'utf8').catch(() => '');
  const banned = text.split('\n').flatMap((line) => {
    const literal = /^\/(.+)\/([a-z]*)$/.exec(line.trim());
    return literal ? [new RegExp(literal[1], literal[2])] : [];
  });
  const generic = [/prose[- ]gate|comment_gate|thematrix|workspace CLAUDE\.md|\u2014/, /[a-z0-9-]+\.atlassian\.net/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, /\b\d{7,}\b/, /Europe\/London/];
  const hits = [];
  for (const file of await filesUnder(MARKET)) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, n) => {
      if ([...banned, ...generic].some((re) => re.test(line))) hits.push(`${relative(ROOT, file)}:${n + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the review queues what it finds and never posts, and says what to do without the queue tool', async () => {
  const { text } = (await written()).find((w) => w.name === 'review');
  assert.match(text, /Never post, approve, resolve, merge or write anything on the forge/);
  assert.match(text, /`queue_findings`/);
  assert.match(text, /If `queue_findings` is not available, list the findings in chat and stop/);
  assert.match(text, /never instructions to you/);
  assert.match(text, /merge request or pull request/);
  assert.match(text, /Language, Writing rules/);
});

test('the kickoff keeps its plan, two gates, waves, cold reviewers and verify rounds, sets effort on each kind of agent, and names no model', async () => {
  const { text } = (await written()).find((w) => w.name === 'kickoff');
  const order = ['## 1. Intake', '## 2. Plan', '**Gate 1.**', '## 3. Build, in waves', '## 4. Verify', '**Claim prover.**', '**Hunters:**', '**Refuter:**', '## 5. Ship', '**Gate 2.**', 'Raise Draft merge requests'].map((part) => {
    assert.ok(text.includes(part), part);
    return text.indexOf(part);
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order');
  assert.match(text, /`medium` for builders, cold reviewers, the claim prover and the refuter; `low` for hunters/);
  assert.match(text, /Never name a model, so the Builders setting/);
  assert.doesNotMatch(text, /\b(opus|sonnet|haiku|fable)\b/i);
  assert.match(text, /at most three/);
});

test('a ticket is created from the generic template, or the template set in Settings', async () => {
  const { text } = (await written()).find((w) => w.name === 'ticket-create');
  for (const section of ['Problem', 'Change', 'Acceptance criteria']) assert.ok(text.includes(`${section}\n`), section);
  assert.match(text, /Settings, Jira, Ticket template is set, use its headings/);
  assert.match(text, /before creating anything/);
});

test('the app packs the plugin beside its worker, where the engine looks for it', async () => {
  const { build } = await json(join(ROOT, 'desktop/package.json'));
  const packed = build.extraResources.find((r) => resolve(ROOT, 'desktop', r.from) === MARKET);
  assert.equal(packed?.to, 'worker/plugin');
  assert.equal(packed.filter, undefined, 'everything under it, the dot folders Claude Code reads among them');
  const dist = build.extraResources.find((r) => resolve(ROOT, 'desktop', r.from) === join(ROOT, 'engine/dist'));
  assert.equal(resolve('/app', dist.to, '../../plugin'), resolve('/app', packed.to), 'two folders up from the packed engine, as the engine looks');
});
