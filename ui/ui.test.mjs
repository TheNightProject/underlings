import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), 'utf8');
const list = async (dir, pattern) => (await readdir(new URL(dir, ROOT)).catch(() => [])).filter((n) => pattern.test(n) && !n.includes('.test.')).sort();
const scripts = await Promise.all((await list('ui/', /\.js$/)).map(async (name) => ({ name, text: await read('ui/' + name) })));
const styles = await Promise.all((await list('ui/', /\.css$/)).map(async (name) => ({ name, text: await read('ui/' + name) })));
const page = { name: 'dashboard.html', text: await read('dashboard.html') };
const workerCode = await Promise.all(['worker.mjs', ...(await list('lib/', /\.mjs$/)).map((n) => 'lib/' + n)].map(async (name) => ({ name, text: await read(name) })));

const SLOTS = [
  'ticketChip', 'pipelineChip', 'stateChips', 'threadsChip', 'agentButton', 'reviewButton', 'ownMrActions', 'mrMenu', 'decideCard',
  'drawerOverview', 'drawerFindings', 'drawerFiles', 'drawerThreads', 'drawerPipeline', 'drawerAgent',
  'needsNow', 'onAttention', 'onAttentionEvent', 'goTo', 'presenceStart', 'notificationsGroup', 'onRequestRow', 'postAllButton', 'queueItem', 'handedBackThreads', 'agentRow',
  'agentConsole', 'threadActions', 'itemThread', 'engineBanner', 'matrixHealth', 'headerExtras',
];

const EXITS = [
  [/_blank/, 'target=_blank'],
  [/\b(?:window|globalThis|self|top|parent)\s*\.\s*open\s*\(|(?:^|[^.\w])open\s*\(|\[\s*['"`]open['"`]\s*\]/, 'a call to open a window'],
  [/location\.(?:assign|replace)\b/, 'location.assign or location.replace'],
  [/\blocation(?:\.href)?\s*=(?!=)/, 'a write to location'],
  [/\.href\s*=(?!=)|setAttribute\(\s*['"`]href/, 'an href set on an element'],
  [/href\s*[=:]\s*['"`]?\s*https?:/i, 'an http(s) href'],
  [/where\s*:\s*['"`]external['"`]/, "a where: 'external' call"],
  [/<form\b|\bel\(\s*['"`]form['"`]/i, 'a form, which navigates when submitted'],
  [/http-equiv/i, 'a meta refresh'],
];
const HREF_KEY = /[{,]\s*(['"`]?)href\1\s*(?::\s*([^,}\n]+))?\s*[,}]/g;

function exitsIn(text) {
  const found = EXITS.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
  for (const [, , value = 'href'] of text.matchAll(HREF_KEY)) if (!/^(?:'#[^']*'|hash|faviconData\(count\))$/.test(value.trim())) found.push(`an href of ${value}`);
  return found;
}

test('nothing on the page navigates the tab away or opens a window', () => {
  for (const { name, text } of [page, ...scripts]) assert.deepEqual(exitsIn(text), [], name);
  for (const [tag, value] of page.text.matchAll(/<[^>]*\bhref="([^"]*)"[^>]*>/g)) {
    if (/\brel="icon"/.test(tag)) assert.match(value, /^data:image\/svg\+xml,/, 'the favicon is drawn in place');
    else assert.match(value, /^#/, `dashboard.html links to ${value}`);
  }
});

test('the favicon is only ever an inline drawing, never a link anywhere', () => {
  const context = vm.createContext({});
  vm.runInContext(scripts.find((s) => s.name === '15-needs.js').text.match(/function faviconData[\s\S]*?\n}\n/)[0], context);
  for (const n of [0, 3]) assert.match(vm.runInContext(`faviconData(${n})`, context), /^data:image\/svg\+xml,<svg /);
});

test('none of the old Needs you slots is left, so the list comes only from the worker', () => {
  for (const { name, text } of scripts) assert.doesNotMatch(text, /\b(?:needsAgents|needsQueue|needsThreads|needsUnread|needsEntry|NEEDS_SOURCES)\b/, name);
});

test('the check above catches every way off the page it claims to', () => {
  const exits = [
    "el('a', { target: '_blank' })", 'window.open(u)', 'open(u)', 'globalThis.open(u)', "window['open'](u)", 'location.assign(u)', 'location.replace(u)',
    'location.href = u', 'location = u', 'document.location.href = u', 'a.href = u', "a.setAttribute('href', u)", "el('a', { href: 'https://gitlab.com/' })",
    "el('a', { href: u })", "el('a', { href })", "el('a', { class: 'x', 'href': r.webUrl })", "{ where: 'external' }", '{ where: `external` }',
    '<form action="https://gitlab.com/">', '<meta http-equiv="refresh" content="0;url=https://gitlab.com/">', "el('form', {})",
  ];
  for (const exit of exits) assert.notDeepEqual(exitsIn(exit), [], `${exit} is not caught`);
  for (const stay of ['offerLink(a.href)', "location.hash === hash", 'location.reload()', "inPage('#agents')", "{ href: hash, onclick }", "{ href: '#needs-you' }", 'openMr(key)', "el('details', { open: true })"]) {
    assert.deepEqual(exitsIn(stay), [], stay);
  }
});

test('remote text is never parsed as markup: innerHTML appears once, for the fixed icon shapes', () => {
  const uses = scripts.flatMap(({ name, text }) => [...text.matchAll(/\.(?:inner|outer)HTML\s*=|insertAdjacentHTML|document\.write/g)].map(() => name));
  assert.deepEqual(uses, ['00-core.js']);
  assert.match(scripts.find((s) => s.name === '00-core.js').text, /function icon\(name\) \{[^}]*svg\.innerHTML = ICONS\[name\]/);
});

test('an agent is labelled from the states its host reports, with no branch for a permission state it never has', () => {
  const context = vm.createContext({ isNeed: (a) => a.waits === true });
  vm.runInContext(scripts.find((s) => s.name === '31-agents.js').text, context);
  const label = (state, waits = false) => vm.runInContext(`agentLabel(${JSON.stringify({ state, waits })})`, context);
  assert.deepEqual(['working', 'done', 'blocked', 'waiting', 'idle'].map((state) => label(state)), ['working', 'done', 'needs approval', 'needs an answer', 'needs you']);
  assert.equal(label('done', true), 'asks you', 'a finished turn the page knows is a question');
  assert.doesNotMatch(vm.runInContext('agentLabel.toString() + JSON.stringify(AGENT_LABELS)', context), /permission/);
});

test('the worker runs the system open in one place, and only once the link is known to be http, https or Slack\'s own app link', () => {
  for (const { name, text } of workerCode) {
    assert.doesNotMatch(text, /\b(?:run|execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`](?:\/usr\/bin\/)?open['"`]/, `${name} runs open by a name of its own`);
  }
  const opens = workerCode.filter(({ text }) => text.includes("'/usr/bin/open'"));
  assert.deepEqual(opens.map((c) => c.name), ['lib/app.mjs', 'lib/selfupdate.mjs']);
  const relaunch = opens[1].text.match(/.*'\/usr\/bin\/open'.*/g);
  assert.deepEqual(relaunch.map((line) => /relaunch: \['\/usr\/bin\/open', bundle\]/.test(line)), [true], 'the updater opens only the app bundle it installed');
  const opener = opens[0].text.slice(opens[0].text.indexOf('async function open('));
  assert.equal((opens[0].text.match(/run\(OPEN\b/g) ?? []).length, 1);
  assert.ok(opener.indexOf('isWebLink(url)') > 0 && opener.indexOf('isWebLink(url)') < opener.indexOf('run(OPEN'), 'the check comes first');
});

// An Orca banner cannot open anything, so its own command is the one way to its item; approving a permission happens only in Orca.
test("no copy sends you to the command palette or Orca's settings, except from a banner, for a permission or a changed worker.mjs", async () => {
  const copy = [page, { name: 'panel.html', text: await read('panel.html') }, ...scripts, ...workerCode];
  const palette = /\bCmd\s*\+?\s*J\b|⌘\s*J|command palette|\brun\s+Open Underlings\b/i;
  for (const { name, text } of copy) {
    for (const line of text.split('\n').map((l) => l.replace(/<\/?[a-z][^<>]*>/gi, ' '))) {
      if (!/Open what needs me/.test(line)) assert.doesNotMatch(line, palette, name);
      if (/Settings,\s*Plugins/i.test(line)) assert.match(line, /worker\b.*\b(?:has changed|is out of date)|desktop notifications/i, `${name}: ${line.trim()}`);
    }
  }
});

test('no refusal from a stale build sends you to a terminal to rebuild it, since the page offers Rebuild', () => {
  for (const { name, text } of [...scripts, ...workerCode]) assert.doesNotMatch(text, /needs rebuilding[^\n]*npm run build|npm run build in engine\b/i, name);
});

const strayName = (text) => text.match(/.{0,30}thematrix.{0,30}/gi);
// A sentence the worker can say has a space in it; a process name, an owner id or a path does not.
const sentences = (text) => [...text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]).filter((s) => / /.test(s)).join('\n');

test('the page never names the engine\'s old name', () => {
  for (const { name, text } of [page, ...scripts, ...styles]) assert.equal(strayName(text), null, name);
});

test('nothing the worker says names it either', () => {
  for (const { name, text } of workerCode) assert.equal(strayName(sentences(text)), null, name);
});

test('the check above finds the old name however it is written, and not the matrix routes', () => {
  for (const said of ["'Rebuild TheMatrix'", '<h2>TheMatrix</h2>', "'Start thematrix in Orca?'", "`THEMATRIX closed`", "'the thematrix TUI'", "'The thematrix terminal app is open as well'"]) assert.notEqual(strayName(said), null, said);
  for (const said of ["'matrixAct', state.matrix, rebuildMatrix", "'/api/matrix/pause'"]) assert.equal(strayName(said), null, said);
  assert.notEqual(strayName(sentences("say('TheMatrix needs rebuilding')")), null, 'a sentence the worker says');
  assert.equal(strayName(sentences("f.owner === 'thematrix' && run('(bin/thematrix|cli)$')")), null, 'an owner id and a process pattern');
});

test('nothing on the page or in the worker can start the terminal app any more', () => {
  for (const { name, text } of [page, ...scripts, ...workerCode]) assert.doesNotMatch(text, /start-matrix|startMatrix|Start TheMatrix/i, name);
});

test('every ui file compiles on its own', () => {
  assert.ok(scripts.length > 0, 'there are no ui scripts');
  for (const { name, text } of scripts) assert.doesNotThrow(() => new vm.Script(text, { filename: name }), name);
});

test('no top-level name is declared in two files', () => {
  const owner = new Map();
  for (const { name, text } of scripts) {
    for (const [, fn, binding] of text.matchAll(/^(?:async\s+)?function\s*\*?\s*(\w+)|^(?:const|let|var|class)\s+(\w+)/gm)) {
      const declared = fn ?? binding;
      assert.ok(!owner.has(declared), `${declared} is declared in both ${owner.get(declared)} and ${name}`);
      owner.set(declared, name);
    }
  }
});

test('every slot that core or a shared row calls is defined exactly once', () => {
  const all = scripts.map((s) => s.text).join('\n');
  const tables = (all.match(/^const (?:VIEWS|NEEDS_SOURCES) = [\s\S]*?;$/gm) ?? []).join('\n');
  const called = new Set([
    ...SLOTS,
    ...[...all.matchAll(/\bslot\('(\w+)'/g)].map((m) => m[1]),
    ...[...tables.matchAll(/'(\w+)'/g)].map((m) => m[1]),
    ...[...all.matchAll(/'(drawer[A-Z]\w*)'\]/g)].map((m) => m[1]),
  ]);
  const defined = scripts.flatMap(({ text }) => [...text.matchAll(/^(?:async\s+)?function (\w+)\(/gm)].map((m) => m[1]));
  for (const name of called) assert.equal(defined.filter((d) => d === name).length, 1, `${name} is defined ${defined.filter((d) => d === name).length} times`);
});
