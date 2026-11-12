const SETTINGS_FIND_KEPT = 'cc.settings.find';
const SETTINGS_FIND_UNMARKED = new Set(['TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MARK']);
const SETTINGS_FIND_SAY_MS = 400;
const settingsFind = { query: settingsFindRecalled(), pin: null, sayTimer: null };

// Kept for the tab, so a reload keeps it and a restart starts with every setting.
function settingsFindRecalled() {
  try {
    return sessionStorage.getItem(SETTINGS_FIND_KEPT) ?? '';
  } catch {
    return '';
  }
}

function settingsFindSet(query, pin = null) {
  Object.assign(settingsFind, { query, pin });
  try {
    if (query) sessionStorage.setItem(SETTINGS_FIND_KEPT, query);
    else sessionStorage.removeItem(SETTINGS_FIND_KEPT);
  } catch {}
}

function settingsFindFolded(text) {
  let folded = '';
  const spans = [];
  let at = 0;
  for (const ch of String(text)) {
    const plain = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let i = 0; i < plain.length; i += 1) spans.push([at, at + ch.length]);
    folded += plain;
    at += ch.length;
  }
  return { folded, spans };
}

const settingsFindFold = (text) => settingsFindFolded(text).folded;
const settingsFindTokens = (query) => [...new Set(settingsFindFold(query).split(/\s+/).filter(Boolean))];
const settingsFindHas = (nodes, token) => nodes.some((n) => settingsFindFold(n.textContent).includes(token));

function settingsFindLabel(row) {
  return [...row.childNodes].find((n) => n.tagName === 'LABEL') ?? null;
}

const settingsFindKey = (title, label) => title + '\n' + label;

function settingsFindRows(root) {
  return [...root.querySelectorAll('section.settings-group')].flatMap((section) => {
    const title = section.querySelector('h2')?.textContent ?? '';
    return [...section.querySelectorAll('.setting')].map((row) => {
      const label = settingsFindLabel(row)?.textContent ?? '';
      return { row, section, title, label, key: settingsFindKey(title, label) };
    });
  });
}

function settingsFindFields(item) {
  if (!item.classList.contains('setting')) return [item];
  return [...item.querySelectorAll('label'), ...item.querySelectorAll('.hint'), ...item.querySelectorAll('.chip'), ...item.querySelectorAll('option')];
}

function settingsFindItems(section) {
  const rows = [...section.querySelectorAll('.setting')];
  const loose = [...section.childNodes].filter((n) => n.nodeType === 1 && n.tagName !== 'H2' && !n.classList.contains('setting') && !n.querySelector('.setting'));
  return [...loose, ...rows];
}

function settingsFindHits(text, token) {
  const { folded, spans } = settingsFindFolded(text);
  const hits = [];
  for (let at = folded.indexOf(token); at >= 0; at = folded.indexOf(token, at + token.length)) hits.push([spans[at][0], spans[at + token.length - 1][1]]);
  return hits;
}

function settingsFindRuns(text, tokens) {
  const hits = tokens.flatMap((token) => settingsFindHits(text, token)).sort((a, b) => a[0] - b[0]);
  return hits.reduce((runs, [from, to]) => {
    const last = runs.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else runs.push([from, to]);
    return runs;
  }, []);
}

function settingsFindTexts(node) {
  const found = [];
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) found.push(child);
    else if (child.nodeType === 1 && !SETTINGS_FIND_UNMARKED.has(child.tagName.toUpperCase())) found.push(...settingsFindTexts(child));
  }
  return found;
}

function settingsFindMarked(source, runs) {
  const parts = [];
  let at = 0;
  for (const [from, to] of runs) {
    parts.push(source.slice(at, from), el('mark', { class: 'find-hit' }, source.slice(from, to)));
    at = to;
  }
  parts.push(source.slice(at));
  return parts.filter((part) => part !== '');
}

function settingsFindMark(node, tokens) {
  for (const text of settingsFindTexts(node)) {
    const runs = settingsFindRuns(text.textContent, tokens);
    if (runs.length) text.replaceWith(...settingsFindMarked(text.textContent, runs));
  }
}

function settingsFindShow(item, tokens) {
  for (const field of settingsFindFields(item)) settingsFindMark(field, tokens);
}

function settingsFindKeep(section, keeps, tokens) {
  let shown = 0;
  for (const item of settingsFindItems(section)) {
    if (!keeps(item)) {
      item.hidden = true;
      continue;
    }
    settingsFindShow(item, tokens);
    shown += 1;
  }
  return shown;
}

function settingsFindGroup(section, tokens) {
  const title = section.querySelector('h2');
  const titled = tokens.filter((token) => settingsFindFold(title?.textContent ?? '').includes(token));
  if (title) settingsFindMark(title, titled);
  const rest = tokens.filter((token) => !titled.includes(token));
  return settingsFindKeep(section, (item) => rest.every((token) => settingsFindHas(settingsFindFields(item), token)), tokens);
}

function settingsFindPinned(section, key, tokens) {
  const title = section.querySelector('h2')?.textContent ?? '';
  return settingsFindKeep(section, (item) => item.classList.contains('setting') && settingsFindKey(title, settingsFindLabel(item)?.textContent ?? '') === key, tokens);
}

function settingsFindGroups(body, tokens) {
  const pin = settingsFind.pin?.query === settingsFind.query ? settingsFind.pin.key : null;
  let matches = 0;
  let groups = 0;
  for (const section of body.querySelectorAll('section.settings-group')) {
    const shown = pin ? settingsFindPinned(section, pin, tokens) : settingsFindGroup(section, tokens);
    section.hidden = !shown;
    matches += shown;
    groups += shown ? 1 : 0;
  }
  return { matches, groups };
}

function settingsFilter(body) {
  const tokens = settingsFindTokens(settingsFind.query);
  if (!tokens.length) {
    settingsFindSay('');
    return null;
  }
  const found = { query: settingsFind.query.trim(), ...settingsFindGroups(body, tokens) };
  if (!found.groups) body.prepend(settingsFindNone(found.query));
  settingsFindSay(settingsFindWords(found));
  return found;
}

function settingsFindWords({ query, matches, groups }) {
  if (!groups) return 'No setting matches ' + query + '.';
  return (matches === 1 ? '1 match' : matches + ' matches') + ' in ' + plural(groups, 'group') + '.';
}

function settingsFindNone(query) {
  return el('div', { class: 'settings-find-none', id: 'settings-find-none' },
    el('p', { class: 'empty' }, icon('search'), 'No setting matches “' + query + '”. Try a word from its name, its hint or one of its choices.'),
    button('Clear', 'x', settingsFindClear));
}

function settingsFindBar(found) {
  return el('div', { class: 'filters settings-find' },
    el('label', { class: 'search' }, icon('search'), el('span', { class: 'settings-find-hidden' }, 'Filter settings'),
      el('input', {
        type: 'search', id: 'settings-q', value: settingsFind.query, placeholder: 'Filter by name, hint or choice', autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => { settingsFindSet(e.target.value); render(true); },
      })),
    found?.groups ? el('span', { class: 'meta settings-find-count' }, settingsFindWords(found)) : null);
}

// The page is drawn afresh on each key, so the count is said from a region that stays put, once typing pauses.
function settingsFindSay(text) {
  let region = document.getElementById('settings-find-said');
  if (!region) {
    region = el('div', { id: 'settings-find-said', class: 'settings-find-hidden', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  clearTimeout(settingsFind.sayTimer);
  settingsFind.sayTimer = setTimeout(() => {
    if (region.textContent !== text) region.textContent = text;
  }, SETTINGS_FIND_SAY_MS);
}

function settingsFindClear() {
  settingsFindSet('');
  render(true);
  document.getElementById('settings-q')?.focus({ preventScroll: true });
}

function settingsFindClears() {
  return view() === 'settings' && Boolean(settingsFind.query);
}

function settingsFindControl(key) {
  const found = settingsFindRows(document.getElementById('main')).find((r) => r.key === key && !r.row.closest('[hidden]'));
  if (!found) return null;
  const target = settingsFindLabel(found.row)?.getAttribute('for');
  return (target && [...found.row.querySelectorAll('[id]')].find((n) => n.id === target)) || found.row.querySelector('input, select, textarea, button');
}

function settingsFindReveal(key, label) {
  settingsFindSet(label, { key, query: label });
  if (view() === 'settings') render(true);
  reach({ find: () => settingsFindControl(key), reveal: () => goView('settings'), missing: label + ' is not in Settings right now' }, focusControl);
}

// Built off the page from any other view; on Settings the page is read, as a second build would move the shared time zone list out of it.
function settingsFindEntries(d) {
  const root = view() === 'settings' ? document.getElementById('main') : slot('settingsBody', d);
  if (!root) return [];
  const all = settingsFindRows(root);
  const rows = all.filter((r) => r.label && settingsFindFold(r.label) !== settingsFindFold(r.title));
  const named = groupBy(rows, (r) => settingsFindFold(r.label));
  const titles = new Set([...root.querySelectorAll('section.settings-group h2')].map((h) => settingsFindFold(h.textContent)));
  const shared = (r) => named.get(settingsFindFold(r.label)).length > 1 || titles.has(settingsFindFold(r.label));
  return rows.map((r) => ({
    id: 'setting:' + r.title + '/' + r.label, group: 'Settings', icon: 'settings', detail: r.title,
    label: 'Settings: ' + r.label + (shared(r) ? ' in ' + r.title : ''),
    run: () => settingsFindReveal(r.key, r.label),
  }));
}
