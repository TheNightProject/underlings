const $ = (id) => document.getElementById(id);
const LOCK = '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const UNLOCK = '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
const COPIED_MS = 1500;
let where = '';
let copiedTimer;

for (const button of document.querySelectorAll('button[data-run]')) {
  button.addEventListener('click', () => {
    window.ccViewer.run(button.dataset.run);
    if (button.id === 'copy') sayCopied();
  });
}

function sayCopied() {
  clearTimeout(copiedTimer);
  $('where').textContent = 'Link copied';
  copiedTimer = setTimeout(() => { $('where').textContent = where; }, COPIED_MS);
}

function label(button, text) {
  button.title = text;
  button.setAttribute('aria-label', text);
}

window.ccViewer.onState((s) => {
  const root = document.documentElement.style;
  root.setProperty('--bar', s.bar + 'px');
  root.setProperty('--hint', s.hintHeight + 'px');
  document.title = s.title;
  where = s.where;
  $('title').textContent = s.title;
  $('where').textContent = where;
  $('back').disabled = !s.canGoBack;
  $('forward').disabled = !s.canGoForward;
  $('top').setAttribute('aria-pressed', String(s.onTop));
  $('top').querySelector('svg').innerHTML = s.onTop ? LOCK : UNLOCK;
  label($('top'), s.onTop ? 'Stop keeping this window on top' : 'Keep on top of every window');
  $('hint').hidden = !s.hint;
});
