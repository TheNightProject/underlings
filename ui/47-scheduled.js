function scheduledBox() {
  ui.scheduled ??= { data: null, error: null, loading: false, at: null };
  return ui.scheduled;
}

// The worker says when a read has finished, so the page reads again on every state it holds.
function scheduledData(box) {
  if (box.at !== state.generatedAt && !box.loading) loadScheduled(box);
  return box.data;
}

async function loadScheduled(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/routines');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

async function refreshScheduled(box) {
  ui.busy.add('scheduled-refresh');
  render(true);
  try {
    box.data = await api('/api/routines/refresh', {});
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  ui.busy.delete('scheduled-refresh');
  render(true);
}

function viewScheduled() {
  const box = scheduledBox();
  const data = scheduledData(box);
  const busy = Boolean(data?.loading) || ui.busy.has('scheduled-refresh');
  const routines = data?.routines ?? [];
  return [
    header('Scheduled', 'The routines on your Claude account, soonest first. Read only: nothing here runs, edits or pauses a routine.',
      el('button', { id: 'scheduled-refresh', disabled: busy, onclick: () => refreshScheduled(box) }, icon('refresh'), busy ? 'Reading…' : 'Refresh')),
    box.error ? banner('Could not read the routines: ' + box.error, true) : null,
    data?.error ? banner((data.fetchedAt ? 'The last read failed, so this is from ' + ago(data.fetchedAt) + ': ' : 'Could not read the routines: ') + data.error + '.', true) : null,
    !data && !box.error ? el('p', { class: 'empty' }, icon('clock'), 'Reading your routines…') : null,
    data?.routines ? [
      el('p', { class: 'scheduled-about' }, plural(routines.length, 'routine') + ', read ' + ago(data.fetchedAt) + (busy ? ', reading again now' : '') + '.'),
      routines.length ? el('div', { class: 'list' }, routines.map(scheduledRow)) : empty('No routines on this account.'),
    ] : null,
  ];
}

function scheduledRow(r) {
  const [label, tone] = scheduledStatus(r);
  return el('div', { class: 'row scheduled-row', 'data-id': r.id },
    el('div', { class: 'row-head' }, icon('clock'), el('span', { class: 'title' }, r.name), el('span', { class: 'pill ' + tone }, label)),
    r.about ? el('div', { class: 'text clamp' }, r.about) : null,
    el('div', { class: 'foot' }, metaLine(r.schedule, r.enabled ? scheduledNext(r) : 'paused', scheduledLast(r))));
}

function scheduledStatus(r) {
  if (!r.enabled) return ['paused', 's-quiet'];
  if (r.lastStatus === 'failed') return ['last run failed', 's-need'];
  if (r.lastStatus === 'running') return ['running', 's-working'];
  return r.lastStatus === 'succeeded' ? ['on', 's-done'] : ['on', 's-quiet'];
}

function scheduledNext(r) {
  if (!r.nextRunAt) return 'no run scheduled';
  const minutes = Math.round((Date.parse(r.nextRunAt) - Date.now()) / 6e4);
  if (minutes < 1) return 'next run due now';
  return 'next run in ' + (minutes < 60 ? minutes + ' min' : minutes < 1440 ? Math.round(minutes / 60) + ' h' : Math.round(minutes / 1440) + ' d');
}

function scheduledLast(r) {
  if (!r.lastRunAt) return 'never run';
  return 'last run ' + ago(r.lastRunAt) + (r.lastStatus ? ', ' + r.lastStatus : '');
}
