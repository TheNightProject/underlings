import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { BAD_KEY, MR_KEY } from './engine.mjs';
import * as refs from './refs.mjs';

const HOST = 'https://gitlab.example.com:8443';
const GITLAB = [{ projectPath: 'acme/engine', iid: 7 }, { projectPath: 'acme/platform/tools/cli', iid: 1203 }, { projectPath: 'a.b/c-d_e', iid: 1 }];
const GITHUB = [{ provider: 'github', projectPath: 'TheNightProject/underlings', iid: 12 }, { provider: 'github', projectPath: 'o.x/r-y_z', iid: 9 }];
const MALFORMED = ['', 'acme/engine', 'acme/engine!', 'acme/engine!0', 'acme/engine!012', 'acme/engine!12x', '!12', 'acme engine!1', 'acme/engine#7!3', 'acme/engine!7#3',
  'acme/sub/repo#12', 'repo#12', 'owner/repo#0', 'ABC-123', 'fix:acme/engine!7', 'acme//engine!7', null, undefined, 12, { projectPath: 'acme/engine', iid: 7 }];

const page = await pageRefs();

async function pageRefs() {
  const context = vm.createContext({ gitlabHost: () => HOST, regExpText: (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') });
  vm.runInContext(await readFile(new URL('../ui/00-refs.js', import.meta.url), 'utf8'), context);
  return (code, args) => JSON.parse(JSON.stringify(vm.runInContext(`(${code})(...${JSON.stringify(args)})`, context) ?? null));
}

test('a key round-trips through its parts on both providers, nested GitLab groups included', () => {
  for (const ref of [...GITLAB, ...GITHUB]) {
    assert.deepEqual(refs.keyParts(refs.keyOf(ref)), ref, refs.keyOf(ref));
    assert.equal(refs.keyPath(refs.keyOf(ref)), ref.projectPath);
    assert.ok(refs.isKey(refs.keyOf(ref)));
  }
  assert.deepEqual(GITLAB.map(refs.keyOf), ['acme/engine!7', 'acme/platform/tools/cli!1203', 'a.b/c-d_e!1']);
  assert.deepEqual(GITHUB.map(refs.keyOf), ['TheNightProject/underlings#12', 'o.x/r-y_z#9']);
});

test('a GitLab key parses with no provider, so a record built from one is written exactly as before', () => {
  assert.deepEqual(Object.keys(refs.keyParts('acme/platform/cli!42')), ['projectPath', 'iid']);
  assert.equal(refs.keyOf({ projectPath: 'acme/engine', iid: 7, provider: undefined }), 'acme/engine!7');
});

test('a malformed key is refused rather than split', () => {
  for (const key of MALFORMED) {
    assert.equal(refs.keyParts(key), null, String(key));
    assert.equal(refs.keyPath(key), null, String(key));
    assert.equal(refs.isKey(key), false, String(key));
  }
});

test('only the GitLab form passes the GitLab pattern, and only the GitHub form the GitHub one', () => {
  assert.ok(GITLAB.map(refs.keyOf).every((key) => refs.GITLAB_KEY.test(key)));
  assert.ok(GITHUB.map(refs.keyOf).every((key) => !refs.GITLAB_KEY.test(key) && refs.GITHUB_KEY.test(key)));
});

test('the worker takes a key in either form and refuses everything malformed, with one message that names both forms', () => {
  assert.equal(MR_KEY, refs.ANY_KEY);
  for (const key of [...GITLAB, ...GITHUB].map(refs.keyOf)) assert.ok(MR_KEY.test(key), key);
  for (const key of MALFORMED.filter((k) => typeof k === 'string')) assert.equal(MR_KEY.test(key), false, key);
  assert.equal(MR_KEY.test('a/b/c#4'), false, 'a GitHub key has exactly two segments');
  assert.equal(BAD_KEY, 'key must look like group/repo!123 or owner/repo#123');
});

test('the number and the short form come out as each provider writes them', () => {
  assert.deepEqual([refs.refNumber(GITLAB[1]), refs.refNumber(GITHUB[0]), refs.refNumber('acme/engine!7'), refs.refNumber('o/r#3')], ['!1203', '#12', '!7', '#3']);
  assert.deepEqual([refs.shortKey('acme/platform/tools/cli!1203'), refs.shortKey('TheNightProject/underlings#12')], ['cli!1203', 'underlings#12']);
  assert.deepEqual([refs.idKey({ projectId: 1001, iid: 7 }), refs.idKey({ provider: 'github', projectId: 1001, iid: 7 })], ['1001!7', '1001#7']);
});

test('a web address leads to its key and back, on any GitLab host and on GitHub, whatever follows the number', () => {
  for (const ref of GITLAB) assert.deepEqual(refs.keysInText(`see ${refs.mrUrl(ref, HOST)}.`), [refs.keyOf(ref)]);
  for (const ref of GITHUB) assert.deepEqual(refs.keysInText(refs.mrUrl(ref, 'https://github.com')), [refs.keyOf(ref)]);
  assert.equal(refs.mrUrl(GITLAB[0], HOST), `${HOST}/acme/engine/-/merge_requests/7`);
  assert.equal(refs.mrUrl(GITHUB[0], 'https://github.com'), 'https://github.com/TheNightProject/underlings/pull/12');
  const text = `${HOST}/acme/platform/tools/cli/-/merge_requests/1203/diffs then https://github.com/o/r/pull/4/files and https://gitlab.com/acme/engine/-/merge_requests/7#note_12`;
  assert.deepEqual(refs.keysInText(text), ['acme/platform/tools/cli!1203', 'o/r#4', 'acme/engine!7']);
  assert.deepEqual(refs.keysInText('https://gitlab.com/acme/-/merge_requests/7 https://gitlab.com/acme/engine/-/issues/7 https://example.com/o/r/pull/4'), []);
});

test('only the # a GitHub key holds is escaped for a page address, so a GitLab target is unchanged', () => {
  assert.equal(refs.inHash('mr:acme/platform/cli!42:threads'), 'mr:acme/platform/cli!42:threads');
  assert.equal(refs.inHash('mr:o/r#12:threads'), 'mr:o/r%2312:threads');
  assert.equal(decodeURIComponent(refs.inHash('mr:o/r#12:threads')), 'mr:o/r#12:threads');
});

test('the page builds and reads keys exactly as the worker and the engine do', () => {
  for (const ref of [...GITLAB, ...GITHUB]) {
    const key = refs.keyOf(ref);
    assert.equal(page('keyOf', [ref]), key);
    assert.deepEqual(page('keyParts', [key]), refs.keyParts(key));
    assert.equal(page('keyPath', [key]), refs.keyPath(key));
    assert.equal(page('refNumber', [key]), refs.refNumber(key));
    assert.equal(page('refNumber', [ref]), refs.refNumber(ref));
    assert.equal(page('short', [key]), refs.shortKey(key));
    assert.equal(page('mrUrl', [ref, HOST]), refs.mrUrl(ref, HOST));
  }
  for (const key of MALFORMED) {
    assert.equal(page('keyParts', [key]), null, String(key));
    assert.equal(page('isKey', [key]), false, String(key));
  }
  assert.deepEqual([page('forgeName', ['acme/engine!7']), page('forgeName', ['o/r#7'])], ['GitLab', 'GitHub']);
});

test('the page reads an MR address on its GitLab host into a key, whatever follows the number', () => {
  for (const ref of GITLAB) {
    for (const tail of ['', '/diffs', '#note_12', '?tab=1']) assert.equal(page('keyFromUrl', [refs.mrUrl(ref, HOST) + tail]), refs.keyOf(ref), tail);
    assert.equal(page('keyInUrl', [`see ${refs.mrUrl(ref, HOST)}/diffs.`]), refs.keyOf(ref));
  }
  assert.equal(page('keyFromUrl', ['https://gitlab.com/acme/engine/-/merge_requests/7']), null, 'another host');
  assert.equal(page('keyFromUrl', ['https://gitlab.com/acme/engine/-/merge_requests/7', 'https://gitlab.com']), 'acme/engine!7');
  assert.equal(page('keyFromUrl', [`${HOST}/acme/engine/-/merge_requests/7x`]), null);
  assert.equal(page('keyFromUrl', [`${HOST}/acme/-/merge_requests/7`]), null, 'a project needs its group');
  assert.equal(page('keyFromUrl', [`x ${HOST}/acme/engine/-/merge_requests/7`]), null, 'only a whole address');
});
