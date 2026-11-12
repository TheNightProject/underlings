const previews = new Map();
const artifactWindows = () => state?.shell === 'app';

function viewArtifacts() {
  const q = ui.artifactSearch.toLowerCase();
  const list = state.artifacts.filter((a) => (ui.showHidden || !a.hidden) && (!q || (a.title + ' ' + (a.description || '')).toLowerCase().includes(q)));
  return [
    header('Artifacts', 'Everything you have published from Claude Code. Preview shows the copy kept when it was published.',
      el('label', { class: 'meta' }, el('input', { type: 'checkbox', id: 'show-hidden', checked: ui.showHidden, onchange: (e) => { ui.showHidden = e.target.checked; render(); } }), ' Show hidden'),
      searchBox('artifact-q', 'Search by title or description', ui.artifactSearch, (v) => { ui.artifactSearch = v; render(true); })),
    list.length ? el('div', { class: 'list' }, list.map(artifactRow)) : empty(q ? 'No artifact matches that search.' : 'No artifacts recorded yet.'),
  ];
}

function artifactRow(a) {
  const open = Boolean(a.previewToken) && ui.open.has('artifact:' + a.url);
  return el('div', { class: 'row', 'data-url': a.url },
    el('div', { class: 'row-head' }, icon('sparkles'), el('span', { class: 'title' }, a.title), a.hidden ? el('span', { class: 'pill s-quiet' }, 'hidden') : null),
    a.description ? el('div', { class: 'text clamp' }, a.description) : null,
    el('div', { class: 'foot' },
      metaLine(String(a.at).slice(0, 10), a.cwd ? a.cwd.replace(/^\/Users\/[^/]+/, '~') : null, a.dir && !a.previewToken ? 'restart ' + APP_NAME + ' to preview it here' : null),
      el('div', { class: 'actions' },
        openButtons(a, open),
        button('Copy link', 'copy', () => copyLink(a.url)),
        button(a.hidden ? 'Unhide' : 'Hide', a.hidden ? 'eye' : 'eyeoff', () => act('/api/hide', { url: a.url, hidden: !a.hidden })))),
    open ? artifactPreview(a) : null);
}

function openButtons(a, open) {
  if (!artifactWindows()) return a.previewToken ? previewButton(a, open) : outside(a.url, 'Open in your browser');
  return [
    button('Open', 'open', () => openArtifactWindow(a.url), true),
    a.previewToken ? previewButton(a, open) : null,
    a.previewToken ? button('Open copy in a window', 'file', () => openArtifactWindow(a.url, true)) : null,
  ];
}

async function openArtifactWindow(url, copy = false) {
  try {
    await api('/api/artifacts/window', { url, copy });
  } catch (e) {
    toast(e.message, true);
  }
}

function previewButton(a, open) {
  return el('button', {
    class: open || artifactWindows() ? null : 'primary',
    'aria-expanded': String(open),
    onclick: () => {
      previews.delete(a.url);
      toggle(ui.open, 'artifact:' + a.url);
    },
  }, icon(open ? 'eyeoff' : 'eye'), open ? 'Close preview' : 'Preview');
}

// The publish time in the address is what makes a republished copy load in a new frame rather than the kept one.
function artifactPreview(a) {
  const src = '/preview/' + /\/artifact\/([A-Za-z0-9-]+)/.exec(a.url)[1] + '/' + a.previewToken + '/index.html?v=' + encodeURIComponent(a.at);
  const kept = previews.get(a.url);
  const frame = kept?.frame.getAttribute('src') === src ? kept.frame : el('iframe', { src, sandbox: 'allow-scripts', title: 'Preview of ' + a.title, referrerpolicy: 'no-referrer' });
  if (kept && kept.frame !== frame) kept.frame.remove();
  const holder = el('div', { class: 'preview' });
  holder.style.height = kept?.holder.style.height ?? '';
  previews.set(a.url, { frame, holder });
  if (frame.isConnected && typeof holder.moveBefore === 'function') {
    document.body.moveBefore(frame, null);
    queueMicrotask(() => settlePreview(a.url));
  } else {
    holder.append(frame);
  }
  return holder;
}

// Every render rebuilds the row, and a frame taken out of the page reloads, so a loaded one is moved across instead.
function settlePreview(url) {
  const kept = previews.get(url);
  if (kept?.frame.parentNode !== document.body) return;
  if (kept.holder.isConnected) kept.holder.moveBefore(kept.frame, null);
  else kept.frame.remove();
}

async function copyLink(url) {
  if (await copyText(url)) toast('Link copied');
  else toast('Could not copy the link', true);
}
