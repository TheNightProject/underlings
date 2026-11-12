import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./record-artifact.mjs', import.meta.url));
const ID = 'AbC123-def';
const URL_ = `https://claude.ai/artifact/${ID}`;
const home = await mkdtemp(join(tmpdir(), 'control-centre-hook-'));
const cwd = join(home, 'work');
const state = join(home, '.local/state/underlings');
const copy = join(state, 'artifacts', ID);

after(() => rm(home, { recursive: true }));

beforeEach(async () => {
  await rm(state, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  await put('page.html', '<html><head><title>Sprint review</title></head><body>v1</body></html>');
  await put('site/css/site.css', 'body { color: red }');
  await put('site/data.json', '{"n":1}');
  await put('logo.svg', '<svg/>');
});

async function put(path, text) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), text);
}

function runHook(stdin) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [HOOK], { cwd: home, env: { ...process.env, HOME: home } }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stderr }));
    child.stdin.end(stdin);
  });
}

function publish(input, response = `Published ${URL_}`) {
  return runHook(JSON.stringify({ tool_name: 'Artifact', tool_input: input, tool_response: response, cwd, session_id: 's1' }));
}

const rows = async () => (await readFile(join(state, 'artifacts.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const copied = (path) => readFile(join(copy, path), 'utf8');
const listed = async (dir = copy, prefix = '') => (await Promise.all((await readdir(dir, { withFileTypes: true }).catch(() => [])).map((e) => (e.isDirectory() ? listed(join(dir, e.name), prefix + e.name + '/') : [prefix + e.name])))).flat().sort();

test('a page publish copies the page to index.html and each file to its published path, and records the folder', async () => {
  const files = { 'css/site.css': 'css/site.css', 'data/numbers.json': { from: 'data.json' }, 'img/logo.svg': join(cwd, 'logo.svg') };
  assert.equal((await publish({ file_path: join(cwd, 'page.html'), root: 'site', files })).code, 0);
  assert.deepEqual(await listed(), ['css/site.css', 'data/numbers.json', 'img/logo.svg', 'index.html']);
  assert.match(await copied('index.html'), /v1/);
  assert.equal(await copied('data/numbers.json'), '{"n":1}');
  const [row] = await rows();
  assert.equal(row.url, URL_);
  assert.equal(row.title, 'Sprint review');
  assert.equal(row.dir, copy);
});

test('a plain list publishes each file at its own spelling, relative to the working directory', async () => {
  await publish({ file_path: 'page.html', files: [{ path: 'site/css/site.css' }, { path: 'logo.svg', contentType: 'image/svg+xml' }] });
  assert.deepEqual(await listed(), ['index.html', 'logo.svg', 'site/css/site.css']);
});

test('an update replaces the page and the files it names, removes a null one and keeps the rest', async () => {
  await publish({ file_path: join(cwd, 'page.html'), files: { 'a.css': 'site/css/site.css', 'b.json': 'site/data.json' } });
  await put('page.html', '<title>Sprint review</title>v2');
  await publish({ file_path: join(cwd, 'page.html'), url: URL_, files: { 'b.json': null, 'c.svg': 'logo.svg' } }, 'Updated in place');
  assert.deepEqual(await listed(), ['a.css', 'c.svg', 'index.html']);
  assert.match(await copied('index.html'), /v2/);
  assert.deepEqual((await rows()).map((r) => r.dir), [copy, copy]);
});

test('an update that names no page applies its files to the copy already kept, and leaves the title alone', async () => {
  await publish({ file_path: join(cwd, 'page.html'), files: { 'a.css': 'site/css/site.css' } });
  await publish({ url: URL_, files: { 'a.css': null, 'b.json': 'site/data.json' } }, 'Updated in place');
  assert.deepEqual(await listed(), ['b.json', 'index.html']);
  const [, update] = await rows();
  assert.equal(update.dir, copy);
  assert.equal('title' in update, false);
});

test('an update that names no page, of an artifact with no copy, makes none', async () => {
  await publish({ url: URL_, files: { 'b.json': 'site/data.json' } }, 'Updated in place');
  assert.deepEqual(await listed(join(state, 'artifacts')), []);
  assert.equal('dir' in (await rows())[0], false);
});

test('an artifact made from a type is recorded without a copy, even when its data file is HTML', async () => {
  await publish({ type_url: 'https://claude.ai/artifact/Type9', title: 'Deck', file_path: join(cwd, 'page.html') }, `Created ${URL_}`);
  assert.deepEqual(await listed(join(state, 'artifacts')), []);
  const [row] = await rows();
  assert.equal(row.title, 'Deck');
  assert.equal('dir' in row, false);
});

test('an update by url of an artifact made from a type is not copied and keeps the title it was made with', async () => {
  await publish({ type_url: 'https://claude.ai/artifact/Type9', title: 'Deck' }, `Created ${URL_}`);
  await publish({ url: URL_, file_path: join(cwd, 'page.html'), files: { 'a.css': 'site/css/site.css' } }, 'Updated in place');
  assert.deepEqual(await listed(join(state, 'artifacts')), []);
  assert.deepEqual((await rows()).map((r) => [r.title, r.typed, 'dir' in r]), [['Deck', true, false], [undefined, true, false]]);
});

test('a type recorded for another artifact does not stop a page being copied', async () => {
  await publish({ type_url: 'https://claude.ai/artifact/Type9', title: 'Deck' }, 'Created https://claude.ai/artifact/Deck7');
  await publish({ file_path: join(cwd, 'page.html') });
  assert.deepEqual(await listed(), ['index.html']);
  assert.equal('typed' in (await rows())[1], false);
});

test('a missing source is skipped and the rest are still copied', async () => {
  await publish({ file_path: join(cwd, 'page.html'), files: { 'gone.css': 'nowhere.css', 'a.css': 'site/css/site.css', 'b.css': { artifact: 'https://claude.ai/artifact/Other1', path: 'x.css' } } });
  assert.deepEqual(await listed(), ['a.css', 'index.html']);
  assert.equal((await rows())[0].dir, copy);
});

test('a file over 16 MB is skipped', async () => {
  await put('big.bin', '');
  await truncate(join(cwd, 'big.bin'), 16 * 1024 * 1024 + 1);
  await put('ok.bin', 'small');
  await publish({ file_path: join(cwd, 'page.html'), files: { 'big.bin': 'big.bin', 'ok.bin': 'ok.bin' } });
  assert.deepEqual(await listed(), ['index.html', 'ok.bin']);
});

test('a published path that climbs out of the copy, or is absolute, is not written', async () => {
  await publish({ file_path: join(cwd, 'page.html'), files: { '../../escape.css': 'site/css/site.css', [join(home, 'abs.css')]: 'site/css/site.css', [join(copy, 'abs.css')]: 'site/css/site.css', 'b.json': { artifact: URL_, path: '../../token' } } });
  assert.deepEqual(await listed(), ['index.html']);
  assert.deepEqual(await listed(join(state, 'artifacts')), [`${ID}/index.html`]);
  await assert.rejects(readFile(join(home, 'abs.css')));
  await assert.rejects(readFile(join(state, 'escape.css')));
});

test('a page that is not HTML, such as a typed artifact\'s data file, is recorded without a copy', async () => {
  await publish({ file_path: join(cwd, 'site/data.json'), root: 'site' });
  assert.deepEqual(await listed(), []);
  const [row] = await rows();
  assert.equal(row.url, URL_);
  assert.equal('dir' in row, false);
});

test('the hook exits 0 and writes nothing on bad input', async () => {
  const odd = { tool_name: 'Artifact', tool_input: { file_path: 7, files: 5 }, tool_response: URL_, cwd };
  for (const stdin of ['not json', '', JSON.stringify(odd), JSON.stringify({ ...odd, cwd: 9 }), JSON.stringify({ tool_name: 'Artifact', tool_input: { asset: true, file_path: join(cwd, 'logo.svg') }, tool_response: URL_ })]) {
    const { code, stderr } = await runHook(stdin);
    assert.equal(code, 0, stdin);
    assert.equal(stderr, '', stdin);
  }
  assert.deepEqual(await rows(), []);
  assert.deepEqual(await listed(join(state, 'artifacts')), []);
});

test('a page whose copy fails is still recorded, and exits 0', async () => {
  await mkdir(join(state, 'artifacts'), { recursive: true });
  await writeFile(copy, 'a file where the folder should be');
  assert.equal((await publish({ file_path: join(cwd, 'page.html') })).code, 0);
  assert.equal((await publish({ file_path: join(cwd, 'page.html'), root: 7 })).code, 0);
  const found = await rows();
  assert.deepEqual(found.map((r) => [r.url, r.title, 'dir' in r]), [[URL_, 'Sprint review', false], [URL_, 'Sprint review', false]]);
});
