import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const page = await openPage();
const css = await readFile(new URL('./00-base.css', import.meta.url), 'utf8');
const render = (text) => page.run('markdown(' + JSON.stringify(text) + ')');
// Written out as tag.class(children) with text as JSON, so each test reads as the tree it expects.
const shape = (node) => (node.nodeType === 3 ? JSON.stringify(node.data) : node.tagName.toLowerCase() + (node.className ? '.' + node.className : '') + '(' + node.childNodes.map(shape).join(' ') + ')');
const md = (text) => shape(render(text)).replace(/^div\.md\((.*)\)$/s, '$1');

const TAGS = new Set(['DIV', 'P', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SMALL', 'BUTTON']);
const ATTRIBUTES = new Set(['class', 'type', 'title', 'start']);

function assertInert(node) {
  for (const e of [node, ...node.querySelectorAll('*')]) {
    assert.ok(TAGS.has(e.tagName), e.tagName + ' is not an element the renderer makes');
    assert.deepEqual([...e.attributes.keys()].filter((name) => !ATTRIBUTES.has(name)), [], e.tagName);
    assert.equal(e.markup, undefined, 'nothing is set as markup');
  }
}

test('a blank line starts a new paragraph and a single line break stays a break', () => {
  assert.equal(md('one\ntwo\n\nthree'), 'p("one\\ntwo") p("three")');
  assert.match(css, /\.md \{[^}]*white-space: pre-line/);
});

test('**bold**, *italic*, _italic_ and `inline code`', () => {
  assert.equal(md('**bold**, *italic*, _italic_ and `code`'), 'p(strong("bold") ", " em("italic") ", " em("italic") " and " code("code"))');
  assert.equal(md('**Use `cache_get` here**'), 'p(strong("Use " code("cache_get") " here"))');
});

test('underscores and stars inside words or code are left alone', () => {
  assert.equal(md('snake_case_name, 2*3*4 and `**kwargs`'), 'p("snake_case_name, 2*3*4 and " code("**kwargs"))');
});

test('a fenced code block keeps its whitespace, ignores its language and reads nothing inside as markdown', () => {
  const fenced = 'Try:\n```python\ndef f(**kw):\n    return [k for k in kw]  # *not* italic\n\n```\nDone.';
  assert.equal(md(fenced), 'p("Try:") pre(code("def f(**kw):\\n    return [k for k in kw]  # *not* italic\\n")) p("Done.")');
  assert.equal(md('~~~\nunclosed runs to the end\n# still code'), 'pre(code("unclosed runs to the end\\n# still code"))');
});

test('#, ## and ### headings are bold lines, and #123 is not a heading', () => {
  assert.equal(md('# One\n## Two `x`\n### Three\n#123 is an issue'), 'p(strong("One")) p(strong("Two " code("x"))) p(strong("Three")) p("#123 is an issue")');
});

test('bulleted and numbered lists, with one level of nesting and a numbered list starting where it says', () => {
  assert.equal(md('- first\n- second\n  - inner **one**\n  - inner two\n- third'),
    'ul(li(p("first")) li(p("second") ul(li(p("inner " strong("one"))) li(p("inner two")))) li(p("third")))');
  const numbered = render('Steps:\n3. three\n4. four\n   still four');
  assert.equal(shape(numbered), 'div.md(p("Steps:") ol(li(p("three")) li(p("four\\nstill four"))))');
  assert.equal(numbered.querySelector('ol').getAttribute('start'), '3');
});

test('a blockquote holds its own markdown and ends at a blank line', () => {
  assert.equal(md('> **Quoted** reply\n> second line\n\nMy answer.'), 'blockquote(p(strong("Quoted") " reply\\nsecond line")) p("My answer.")');
});

test('--- is a rule', () => {
  assert.equal(md('Above\n\n---\n\nBelow'), 'p("Above") hr() p("Below")');
});

test('a GitLab pipe table, like the Wiz summary, is a table that scrolls in its own box', () => {
  const wiz = [
    '### Wiz Scan Summary',
    '| Scanner | <img src="https://assets.vendor.example/critical.svg" width="11"/> Critical | High |',
    '|:--|:--:|--:|',
    '| **Vulnerabilities** | 0 | 2 |',
    '| Secrets | `a \\| b` |',
    '| **Total** | 0 | 3 | extra |',
    '',
    'See the scan in Wiz.',
  ].join('\n');
  const node = render(wiz);
  const box = node.querySelector('.md-table');
  assert.ok(box, 'the table sits in its own box');
  const rows = box.querySelectorAll('tr').map((tr) => tr.childNodes.map(shape).join(' '));
  assert.deepEqual(rows, [
    'th("Scanner") th("<img src=\\"https://assets.vendor.example/critical.svg\\" width=\\"11\\"/> Critical") th("High")',
    'td(strong("Vulnerabilities")) td("0") td("2")',
    'td("Secrets") td(code("a | b")) td()',
    'td(strong("Total")) td("0") td("3")',
  ]);
  assert.equal(shape(node.childNodes.at(-1)), 'p("See the scan in Wiz.")');
  assert.match(css, /\.md pre, \.md-table \{ overflow-x: auto; contain: inline-size; \}/);
  assertInert(node);
});

test('the <sub> footer review agents append is small muted text', () => {
  assert.equal(md('Body.\n\n<sub>Found by the review agent on `a1b2c3d`</sub>'), 'p("Body.") p(small.md-sub("Found by the review agent on " code("a1b2c3d")))');
  assert.match(css, /\.md-sub \{[^}]*color: var\(--muted\)/);
});

test('[text](url) and bare https URLs are links that name where they go, leaving sentence punctuation as text', () => {
  const node = render('See [the docs](https://gitlab.com/acme/engine/-/blob/main/README.md), or http://example.com/a. (Also https://gitlab.com/acme/engine/-/issues/4)');
  assert.equal(shape(node), 'div.md(p("See " button.md-link("the docs") ", or " button.md-link("http://example.com/a") ". (Also " button.md-link("https://gitlab.com/acme/engine/-/issues/4") ")"))');
  assert.deepEqual(node.querySelectorAll('button').map((b) => b.getAttribute('title')), [
    'https://gitlab.com/acme/engine/-/blob/main/README.md', 'http://example.com/a', 'https://gitlab.com/acme/engine/-/issues/4',
  ]);
});

test('a link to a file under a route group keeps its parentheses, and javascript: in parentheses stays text', () => {
  const url = 'https://gitlab.com/acme/frontend/-/blob/main/apps/slate/app/(authenticated)/reports/page.tsx#L490';
  const node = render(`See [page.tsx](${url}) for it.`);
  assert.equal(shape(node), 'div.md(p("See " button.md-link("page.tsx") " for it."))');
  assert.equal(node.querySelector('.md-link').getAttribute('title'), url);
  assert.equal(shape(render('[x](javascript:alert(1))')), 'div.md(p("[x](javascript:alert(1))"))');
});

test('a link is offered for your browser the way any link off the page is, and nothing opens until you say so', async () => {
  const linked = await openPage();
  linked.run('markdown("[the docs](https://gitlab.com/acme/engine/-/blob/main/README.md)")').querySelector('.md-link').click();
  const toast = linked.$('#toast');
  assert.match(toast.textContent, /That link leads out of Underlings\./);
  assert.ok(!linked.requested.includes('/api/open'), 'nothing opened on the first click');
  toast.querySelectorAll('button').find((b) => b.textContent === 'Open in your browser').click();
  await linked.settle(20);
  assert.ok(linked.requested.includes('/api/open'));
});

test('HTML in review text is shown as written, never made into elements', () => {
  for (const text of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<b onclick="alert(1)">bold</b>', '<a href="https://evil.example">x</a>', '<sub onclick=alert(1)>x</sub>']) {
    const node = render(text);
    assert.equal(shape(node), 'div.md(p(' + JSON.stringify(text) + '))');
    assertInert(node);
  }
});

test('javascript: and data: links stay text, written as links or bare', () => {
  const links = [
    '[click](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[img](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    'javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>',
  ];
  for (const text of links) {
    const node = render(text);
    assert.equal(shape(node), 'div.md(p(' + JSON.stringify(text) + '))');
    assertInert(node);
  }
});

test('an unclosed backtick or bold shows its markers as written', () => {
  assert.equal(md('Use `cache_get and **not this'), 'p("Use `cache_get and **not this")');
  assert.equal(md('*half open and _this too'), 'p("*half open and _this too")');
});

test('quotes and lists nested past a few levels are read as text rather than overflowing', () => {
  const node = render('>'.repeat(20000) + ' deep');
  assert.equal(node.querySelectorAll('blockquote').length, 4);
  assert.match(node.textContent, /> deep$/);
});

test('a long body full of unmatched markers still renders at once', () => {
  const started = performance.now();
  render(' **a'.repeat(20000));
  assert.ok(performance.now() - started < 1000, 'took ' + Math.round(performance.now() - started) + ' ms');
});

const NOTE = [
  '**MAJOR**: `cache_get` returns the stale entry when the TTL is `0`, so every caller in `engine/api.py` gets data that should have expired.',
  '',
  'Two things to change:',
  '1. Treat `ttl <= 0` as *no cache* in `cache_get`.',
  '2. Add a test that sets `ttl=0` and expects a miss:',
  '',
  '```python',
  'def test_zero_ttl_misses(cache):',
  '    cache.put("k", 1, ttl=0)',
  '    assert cache.get("k") is None',
  '```',
  '',
  '> **Note**',
  '> The same check is in `warm_cache`, see https://gitlab.com/acme/engine/-/blob/main/engine/warm.py#L40.',
  '',
  '---',
  '<sub>Found by the review agent · [run log](https://gitlab.com/acme/engine/-/jobs/42)</sub>',
].join('\n');

test('a real review note reads as formatted text with none of its markers left showing', () => {
  const node = render(NOTE);
  assertInert(node);
  assert.deepEqual(node.childNodes.map((n) => n.tagName), ['P', 'P', 'OL', 'PRE', 'BLOCKQUOTE', 'HR', 'P']);
  assert.equal(node.querySelector('strong').textContent, 'MAJOR');
  assert.deepEqual(node.querySelectorAll('ol li').map((li) => li.textContent), ['Treat ttl <= 0 as no cache in cache_get.', 'Add a test that sets ttl=0 and expects a miss:']);
  assert.equal(node.querySelector('ol em').textContent, 'no cache');
  assert.equal(node.querySelector('pre').textContent, 'def test_zero_ttl_misses(cache):\n    cache.put("k", 1, ttl=0)\n    assert cache.get("k") is None');
  assert.equal(node.querySelector('blockquote strong').textContent, 'Note');
  assert.equal(node.querySelector('blockquote .md-link').getAttribute('title'), 'https://gitlab.com/acme/engine/-/blob/main/engine/warm.py#L40');
  assert.equal(node.querySelector('.md-sub .md-link').textContent, 'run log');
  const prose = [node, ...node.querySelectorAll('*')].filter((e) => e.tagName !== 'CODE' && e.tagName !== 'PRE').flatMap((e) => e.childNodes.filter((c) => c.nodeType === 3).map((c) => c.data)).join(' ');
  assert.doesNotMatch(prose, /\*\*|`|<\/?sub>|\]\(|^---$|^> |^1\. /m);
});
