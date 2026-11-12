import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const HOMES = new Set(['lib/refs.mjs', 'engine/src/refs.ts', 'ui/00-refs.js']);
const NOT_SHIPPED = /\.test\.|(?:^|\/)testkit\.|^lib\/workerproc\.mjs$|^engine\/src\/fixtures\//;
const HAND_BUILT = [
  [/!\$\{/, 'a key or an MR number joined by hand, as in `${path}!${iid}`'],
  [/!['"`]\s*\+/, "a key or an MR number joined by hand, as in path + '!' + iid"],
  [/#\$\{[\w.?]*\b(?:iid|number)\b|#['"`]\s*\+\s*[\w.?]*\b(?:iid|number)\b/, 'a GitHub number joined by hand'],
  [/\.(?:split|lastIndexOf|indexOf|includes)\(\s*['"`]!['"`]\s*\)/, 'a key split by hand'],
  [/!\(?\\{1,2}d|!\[1-9\]/, 'a pattern for !12 written by hand'],
  [/-\\?\/merge_requests\\?\/|\/pull\\?\//, 'an MR web address built or read by hand'],
];

async function shipped() {
  const dirs = [['engine/src/', true, /\.tsx?$/], ['lib/', false, /\.mjs$/], ['ui/', false, /\.js$/], ['desktop/', false, /\.(?:mjs|cjs|js)$/]];
  const lists = await Promise.all(dirs.map(async ([dir, recursive, ext]) => (await readdir(new URL(dir, ROOT), { recursive })).filter((n) => ext.test(n)).map((n) => dir + n)));
  return ['worker.mjs', ...lists.flat()].filter((path) => !HOMES.has(path) && !NOT_SHIPPED.test(path) && !path.includes('node_modules'));
}

function handBuilt(text) {
  return text.split('\n').flatMap((line, i) => HAND_BUILT.filter(([pattern]) => pattern.test(line)).map(([, what]) => `${i + 1}: ${what}: ${line.trim()}`));
}

test('no shipped code builds, splits or parses an MR key by hand: keys go through the refs module', async () => {
  const files = await shipped();
  assert.ok(files.includes('engine/src/data/gitlab.ts') && files.includes('lib/matrix.mjs') && files.includes('ui/46-claudecode-links.js'), 'the scan reaches every side');
  const found = (await Promise.all(files.map(async (path) => handBuilt(await readFile(new URL(path, ROOT), 'utf8')).map((hit) => `${path}:${hit}`)))).flat();
  assert.deepEqual(found, [], 'build, split or parse it with lib/refs.mjs, engine/src/refs.ts or ui/00-refs.js instead');
});

test('the check catches every way a key was built by hand before the refs module', () => {
  const before = [
    "return `${mr.projectPath}!${mr.iid}`;", "title: `review !${mr.iid}`", "metaLine(r.repo + ' !' + r.iid)", "const key = m && m[1] + '!' + m[2];",
    "key: `${m[1]}#${m[2]}`.replace('', '') && `${o}#${pr.number}`", "'#' + r.iid", "const at = key.lastIndexOf('!');", "mr.references.full.split('!')[0]",
    "a.raisedMr.includes('!')", "/![1-9]\\d*$/.test(mr)", "const MR_LINE = /^See merge request (\\S+)!(\\d+)\\s*$/m;", "new RegExp('!(\\\\d+)')",
    "`${host}/${path}/-/merge_requests/${iid}`", "/\\/-\\/merge_requests\\/(\\d+)/", "`${web}/${path}/pull/${iid}`", "/github\\.com\\/(\\S+)\\/pull\\/(\\d+)/",
  ];
  for (const line of before) assert.notDeepEqual(handBuilt(line), [], line);
  const fine = [
    "raw.startsWith('!')", "{ glyph: '!', colour: 'red' }", "rest(`/projects/${projectId}/merge_requests/${iid}/notes`)", "`${key}#${discussionId}`",
    "const link = `${url}#${inHash(target)}`;", "'Done!'", "if (!${flag}) {}".replace('!${', '! ${'), "key + '#' + t.id",
  ];
  for (const line of fine) assert.deepEqual(handBuilt(line), [], line);
});
