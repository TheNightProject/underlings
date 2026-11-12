const CLEANUP_ACTIONS = {
  remove: (c) => ['s-done', c.worktree ? 'remove worktree' : 'remove agent'],
  'close-agents': (c) => ['s-info', 'close ' + plural(c.agents.length, 'finished agent')],
  keep: () => ['s-quiet', 'kept'],
};

async function scanCleanup() {
  const scan = { loading: true };
  ui.cleanup = scan;
  render();
  try {
    const plan = await api('/api/agents/cleanup');
    if (ui.cleanup !== scan) return;
    ui.cleanup = { ...plan, picked: new Set(plan.candidates.filter((c) => c.suggested).map((c) => c.id)) };
  } catch (e) {
    if (ui.cleanup !== scan) return;
    ui.cleanup = null;
    toast(e.message, true);
  }
  render();
}

function cleanupSection(c) {
  const cancel = button('Cancel', 'x', () => { ui.cleanup = null; render(); });
  if (c.loading) return section('Clean up', banner('Checking every agent, every git worktree beside the repos, and their git state…'), el('div', { class: 'actions' }, cancel));
  const payload = cleanupPayload(c.candidates.filter((x) => c.picked.has(x.id)));
  const label = cleanupLabel(payload);
  return section('Clean up',
    banner(`Removes finished agents, and git worktrees with nothing left in them: every agent finished, no activity for ${c.staleHours} h, or a finished review with nothing left to post. A worktree with uncommitted or unpushed work stays. Only safe ones start ticked, and each is checked again before it goes.`),
    c.candidates.length ? el('div', { class: 'list' }, c.candidates.map(cleanupRow)) : empty('Nothing to clean up.'),
    el('div', { class: 'actions' },
      label ? guarded('cleanup', label, 'eraser', label + '?', () => applyCleanup(payload), true) : null,
      cancel));
}

function cleanupRow(c) {
  const [tone, label] = CLEANUP_ACTIONS[c.action](c);
  const kept = c.action === 'keep';
  return el('label', { class: 'row' + (kept ? ' kept' : '') },
    el('div', { class: 'row-head' },
      el('input', { type: 'checkbox', checked: ui.cleanup.picked.has(c.id), disabled: kept, onchange: (e) => pickCleanup(c.id, e.target.checked) }),
      el('span', { class: 'title' }, c.name),
      el('span', { class: 'pill ' + tone }, label),
      el('span', { class: 'meta' }, [c.repo, c.branch, c.lastActivityAt ? ago(c.lastActivityAt) : ''].filter(Boolean).join(' · '))),
    el('div', { class: 'text' }, c.reasons.join(', ')),
    c.blocker ? el('div', { class: 'meta' }, 'It stays: ' + c.blocker) : null);
}

function pickCleanup(id, on) {
  if (on) ui.cleanup.picked.add(id);
  else ui.cleanup.picked.delete(id);
  render();
}

function cleanupPayload(picked) {
  return {
    remove: picked.filter((c) => c.action === 'remove').map((c) => c.id),
    close: picked.filter((c) => c.action === 'close-agents').flatMap((c) => c.agents.map((a) => a.handle)),
  };
}

function cleanupLabel({ remove, close }) {
  const text = [remove.length && 'remove ' + plural(remove.length, 'workspace'), close.length && 'close ' + plural(close.length, 'finished agent')].filter(Boolean).join(', ');
  return text && text[0].toUpperCase() + text.slice(1);
}

async function applyCleanup(payload) {
  const shown = ui.cleanup;
  if (await busyAct('/api/agents/cleanup', payload, 'cleanup') && ui.cleanup === shown) ui.cleanup = null;
  render();
}
