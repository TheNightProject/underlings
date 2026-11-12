const PIPE_STATES = {
  success: ['check', 's-done', 'passed'], failed: ['x', 's-need', 'failed'], running: ['clock', 's-working', 'running'],
  pending: ['clock', 's-working', 'pending'], created: ['clock', 's-quiet', 'created'], preparing: ['clock', 's-working', 'preparing'],
  waiting_for_resource: ['clock', 's-working', 'waiting'], canceled: ['square', 's-quiet', 'cancelled'], canceling: ['square', 's-quiet', 'cancelling'],
  skipped: ['circle', 's-quiet', 'skipped'], manual: ['play', 's-info', 'manual'], scheduled: ['clock', 's-info', 'scheduled'],
};
const JOB_ORDER = ['failed', 'allowed', 'canceled', 'running', 'pending', 'preparing', 'waiting_for_resource', 'created', 'manual', 'scheduled', 'success', 'skipped'];
const MOVING_JOBS = new Set(['running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'canceling']);
const RETRYABLE_JOBS = new Set(['failed', 'canceled']);
const PIPELINE_POLL_MS = 5000;
const PIPELINE_STALE_MS = 30000;
const pipelineView = { drawer: null, key: null, data: null, stages: [], error: null, loading: false, at: 0, logs: new Map() };
const failedJobs = { stamp: null, counts: {} };
const stageOrders = new Map();
const logShown = new WeakMap();
let pipelineSeq = 0;
let pipelineTimer;

function pipeState(status) {
  const s = String(status ?? '').toLowerCase();
  return PIPE_STATES[s] ?? ['circle', 's-quiet', s.replace(/_/g, ' ')];
}

function pipelineChip(r) {
  if (!r.pipeline) return null;
  const [iconName, tone, label] = pipeState(r.pipeline);
  if (!r.key) return el('span', { class: 'pipe ' + tone, title: 'Pipeline ' + label }, icon(iconName), label);
  if (r.pipeline === 'FAILED') wantFailedCounts();
  const failed = failedJobs.counts[r.key];
  const title = 'Pipeline ' + label + (failed ? ', ' + plural(failed, 'job') + ' failed' : '') + '. Show its jobs here';
  return el('button', { type: 'button', class: 'pipe ' + tone, title, 'aria-label': title, onclick: () => slot('openMr', r.key, 'pipeline') }, icon(iconName), label);
}

// Counted once per GitLab refresh, and only for failed pipelines, so the list never waits on it.
function wantFailedCounts() {
  const stamp = state?.matrix?.inbox?.fetchedAt;
  if (!stamp || failedJobs.stamp === stamp) return;
  failedJobs.stamp = stamp;
  api('/api/matrix/failed-jobs').then(({ counts }) => { failedJobs.counts = counts; render(true); }, () => {});
}

function drawerPipeline(ctx) {
  const v = pipelineFor(ctx.key);
  if (!v.data) {
    if (!v.error) return el('p', { class: 'empty' }, icon('clock'), 'Reading the pipeline from ' + forgeName(ctx.key) + '…');
    return [banner('Could not read the pipeline: ' + v.error, true), button('Try again', 'refresh', readPipelineAgain)];
  }
  if (!v.data.jobs.length) return empty('No pipeline ran on the MR head.');
  const retry = Boolean(ctx.row) && forgeAllows(ctx.key, 'retry');
  return [
    pipelineHead(v, retry),
    v.error ? banner('Could not refresh the pipeline: ' + v.error, true) : null,
    jobStages(v.data.jobs, v.stages).map(([stage, jobs]) => el('section', { class: 'stage' }, el('h3', {}, stage), jobs.map((job) => jobRow(job, v, retry)))),
  ];
}

function pipelineHead(v, retry) {
  const d = v.data;
  const stopped = d.jobs.filter((j) => RETRYABLE_JOBS.has(j.status));
  const [iconName, tone, label] = pipeState(d.status ?? '');
  return el('div', { class: 'foot' },
    el('div', { class: 'row-head' },
      d.status ? el('span', { class: 'pill ' + tone }, icon(iconName), label) : null,
      metaLine(jobTally(d.jobs), d.sha ? 'at ' + d.sha.slice(0, 8) : null, pipelineMoving(v) ? 'refreshing every 5 s' : 'read ' + ago(d.fetchedAt))),
    retry && stopped.length ? guarded('retry-pipeline:' + v.key, 'Retry failed jobs', 'rotate-ccw', 'Retry ' + plural(stopped.length, 'job') + ' on ' + refNumber(v.key) + '?', () => retryPipelineNow(v)) : null);
}

function jobRow(job, v, retry) {
  const logged = job.logs !== false;
  const open = logged && ui.open.has('job:' + job.id);
  const [iconName, tone, label] = pipeState(job.status);
  const allowed = job.allowFailure && job.status === 'failed';
  return el('div', { class: 'row job' },
    el('div', { class: 'foot' },
      el('div', { class: 'row-head' },
        logged ? el('button', { type: 'button', id: 'job-' + job.id, class: 'job-toggle', 'aria-expanded': String(open), title: open ? 'Hide the log' : 'Show the end of the log', onclick: () => toggleJob(job.id) }, icon('chevron'), job.name)
          : el('span', { class: 'job-name', title: 'Not a GitHub Actions job, so its log is only where it links to' }, job.name),
        el('span', { class: 'pill ' + (allowed ? 's-working' : tone), title: allowed ? 'This job may fail without failing the pipeline' : null }, icon(iconName), allowed ? 'failed, allowed' : label),
        job.duration != null ? el('span', { class: 'meta' }, took(job.duration)) : null,
        logged ? null : outside(job.webUrl, 'Open ' + job.stage)),
      retry && RETRYABLE_JOBS.has(job.status) ? guarded('retry-job:' + job.id, 'Retry job', 'rotate-ccw', 'Retry ' + job.name + '?', () => retryJobNow(v, job)) : null),
    open ? jobLog(job, v) : null);
}

function jobLog(job, v) {
  const log = v.logs.get(job.id);
  if (!log) loadJobLog(job).then(() => render(true));
  if (!log?.lines) {
    if (log?.error) return banner('Could not read the log: ' + log.error, true);
    return el('p', { class: 'empty' }, icon('clock'), 'Reading the log…');
  }
  return [
    el('div', { class: 'meta' }, logCaption(log, job)),
    log.error ? el('div', { class: 'meta bad' }, 'Could not refresh the log: ' + log.error) : null,
    log.lines.length ? logConsole(job, log.lines) : null,
  ];
}

// The drawer is rebuilt on every redraw, so the line at the top of an open log, and any text selected in it, carry over to the new one.
function logConsole(job, lines) {
  const before = keptView(document.getElementById('log-' + job.id));
  const rows = lines.map((line, i) => el('span', { class: 'line' }, i < lines.length - 1 ? line + '\n' : line));
  const pre = el('pre', { class: 'console', id: 'log-' + job.id, tabindex: '0', 'aria-label': 'The end of the log of ' + job.name }, el('span', {}, rows));
  logShown.set(pre, { lines, rows, pending: before });
  if (before) Promise.resolve().then(() => restoreView(pre, before));
  return pre;
}

// A redraw that lands before the last one was put back passes on what that one kept.
function keptView(old) {
  const shown = old && logShown.get(old);
  if (!shown) return null;
  if (shown.pending) return shown.pending;
  const place = placeIn(old, shown.rows);
  const selection = selectionIn(shown.rows);
  return place || selection ? { lines: shown.lines, place, selection } : null;
}

// pre.console is column-reverse, so a scrollTop of 0 is the end of the log, where the view follows new lines.
function placeIn(pre, rows) {
  if (pre.scrollTop > -2) return null;
  const top = pre.getBoundingClientRect().top;
  const line = rows.findIndex((r) => r.getBoundingClientRect().bottom > top);
  return line < 0 ? null : { line, offset: rows[line].getBoundingClientRect().top - top };
}

function selectionIn(rows) {
  const s = document.getSelection();
  if (!s.rangeCount) return null;
  const anchor = linePoint(rows, s.anchorNode, s.anchorOffset);
  const focus = linePoint(rows, s.focusNode, s.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

function linePoint(rows, node, offset) {
  const line = rows.indexOf(node.parentNode);
  return line < 0 ? null : { line, offset };
}

function restoreView(pre, { lines, place, selection }) {
  const shown = logShown.get(pre);
  shown.pending = null;
  if (!pre.isConnected) return;
  const dropped = linesDropped(lines, shown.lines);
  if (place) scrollToLine(pre, shown.rows[place.line - dropped], place.offset);
  if (selection) selectLines(shown.rows, selection, dropped);
}

function scrollToLine(pre, row, offset) {
  if (!row) pre.scrollTop = -pre.scrollHeight;
  else pre.scrollTop += row.getBoundingClientRect().top - pre.getBoundingClientRect().top - offset;
}

function selectLines(rows, { anchor, focus }, dropped) {
  const at = ({ line, offset }) => {
    const text = rows[line - dropped]?.childNodes[0];
    return text ? [text, Math.min(offset, text.data.length)] : null;
  };
  const [from, to] = [at(anchor), at(focus)];
  if (from && to) document.getSelection().setBaseAndExtent(...from, ...to);
}

// Each read is the end of the log, so older lines fall off its top; the last line may since have been rewritten in place.
function linesDropped(before, after) {
  const settled = before.length - 1;
  for (let d = 0; d < settled; d += 1) {
    if (after.slice(0, settled - d).every((line, t) => line === before[d + t])) return d;
  }
  return Math.max(settled, 0);
}

function logCaption(log, job) {
  const n = log.lines.length;
  if (!n) return MOVING_JOBS.has(job.status) ? 'Nothing in the log yet.' : 'The log is empty.';
  const shown = log.total == null ? 'The last ' + plural(n, 'line') : n < log.total ? 'The last ' + n + ' of ' + numberText(log.total) + ' lines' : plural(n, 'line');
  return shown + (job.status === 'running' ? ', refreshed every 5 s while it runs.' : '.');
}

function jobRank(job) {
  const at = JOB_ORDER.indexOf(job.allowFailure && job.status === 'failed' ? 'allowed' : job.status);
  return at < 0 ? JOB_ORDER.length : at;
}

// Stages keep the pipeline's order, except that a stage with a failure comes first.
function jobStages(jobs, order) {
  const stages = [...groupBy(jobs, (j) => j.stage)].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  const ranked = stages.map(([stage, list]) => [stage, list.sort((a, b) => jobRank(a) - jobRank(b) || a.id - b.id)]);
  return ranked.sort(([, a], [, b]) => Math.min(jobRank(a[0]), 2) - Math.min(jobRank(b[0]), 2));
}

// A retried job comes back under a new id, so a pipeline's stages stay in the order they were first seen in.
function stageOrder(key, { pipelineId, jobs }) {
  const seen = stageOrders.get(key);
  const known = seen?.pipelineId === pipelineId ? seen.stages : [];
  const stages = [...new Set([...known, ...[...jobs].sort((a, b) => a.id - b.id).map((j) => j.stage)])];
  stageOrders.set(key, { pipelineId, stages });
  return stages;
}

function jobTally(jobs) {
  const counts = new Map();
  for (const j of [...jobs].sort((a, b) => jobRank(a) - jobRank(b))) {
    const label = j.allowFailure && j.status === 'failed' ? 'allowed to fail' : pipeState(j.status)[2];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => n + ' ' + label).join(', ');
}

function took(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
}

function toggleJob(id) {
  if (!ui.open.delete('job:' + id)) ui.open.add('job:' + id);
  render(true);
}

function pipelineMoving(v) {
  return Boolean(v.data?.jobs.some((j) => MOVING_JOBS.has(j.status)));
}

function pipelineFor(key) {
  const v = pipelineView;
  if (v.drawer !== ui.mr) {
    pipelineSeq += 1;
    clearTimeout(pipelineTimer);
    Object.assign(v, { drawer: ui.mr, key, data: null, stages: [], error: null, loading: false, at: 0, logs: new Map() });
  }
  const age = Date.now() - v.at;
  if (!v.loading && (age > PIPELINE_STALE_MS || (pipelineMoving(v) && age > PIPELINE_POLL_MS))) loadPipeline();
  return v;
}

// Only the latest read may land, and the open logs are read with it so the two never disagree.
async function loadPipeline() {
  const v = pipelineView;
  const seq = ++pipelineSeq;
  clearTimeout(pipelineTimer);
  v.loading = true;
  try {
    const data = await api('/api/matrix/pipeline?' + new URLSearchParams({ key: v.key }));
    if (seq !== pipelineSeq) return;
    keepRetriedOpen(v.data, data);
    Object.assign(v, { data, stages: stageOrder(v.key, data), error: null });
  } catch (e) {
    if (seq !== pipelineSeq) return;
    v.error = e.message;
  }
  await Promise.all(logsDue(v).map(loadJobLog));
  if (seq !== pipelineSeq) return;
  Object.assign(v, { loading: false, at: Date.now() });
  render(true);
  if (pipelineMoving(v)) pipelineTimer = setTimeout(pollPipeline, PIPELINE_POLL_MS);
}

function readPipelineAgain() {
  pipelineView.error = null;
  loadPipeline();
  render(true);
}

function pollPipeline() {
  if (ui.mr && ui.mr === pipelineView.drawer && ui.mr.tab === 'pipeline') loadPipeline();
}

function logsDue(v) {
  return (v.data?.jobs ?? []).filter((j) => {
    const log = v.logs.get(j.id);
    return ui.open.has('job:' + j.id) && (!log || (!log.loading && (log.status !== j.status || j.status === 'running')));
  });
}

async function loadJobLog(job) {
  const { logs, key } = pipelineView;
  const prior = logs.get(job.id);
  logs.set(job.id, { ...prior, loading: true });
  try {
    const log = await api('/api/matrix/job-log?' + new URLSearchParams({ key, job: job.id }));
    logs.set(job.id, { ...log, status: job.status, error: null, loading: false });
  } catch (e) {
    logs.set(job.id, { ...prior, status: job.status, error: e.message, loading: false });
  }
}

// A retried job comes back under a new id, so its open log follows it there.
function keepRetriedOpen(before, after) {
  if (!before) return;
  const ids = new Set(after.jobs.map((j) => j.id));
  for (const gone of before.jobs) {
    if (ids.has(gone.id) || !ui.open.delete('job:' + gone.id)) continue;
    const again = after.jobs.find((j) => j.name === gone.name && j.stage === gone.stage);
    if (again) ui.open.add('job:' + again.id);
  }
}

function retryJobNow(v, job) {
  const payload = { key: v.key, jobId: job.id, expect: { sha: v.data.sha, status: job.status } };
  matrixAct('retry-job', payload, 'retry-job:' + job.id).then(() => loadPipeline());
}

function retryPipelineNow(v) {
  const payload = { key: v.key, pipelineId: v.data.pipelineId, expect: { sha: v.data.sha } };
  matrixAct('retry-pipeline', payload, 'retry-pipeline:' + v.key).then(() => loadPipeline());
}
