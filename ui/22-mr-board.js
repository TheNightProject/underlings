const MR_LANES = [
  ['draft', 'Draft', 's-quiet'],
  ['blocked', 'Blocked', 's-need'],
  ['changes', 'Changes requested', 's-moved'],
  ['ready', 'Ready to merge', 's-done'],
  ['approved', 'Approved', 's-info'],
  ['review', 'Needs review', 's-working'],
];

// GitLab says MERGEABLE with no approval rules too, so Ready also needs someone to have approved.
function mrLane(r) {
  const status = String(r.mergeStatus ?? '').toUpperCase();
  if (r.draft) return 'draft';
  if (r.flags.conflict || status === 'CONFLICT' || r.pipeline === 'FAILED') return 'blocked';
  if (status === 'REQUESTED_CHANGES' || Object.values(r.reviewStates ?? {}).includes('REQUESTED_CHANGES') || r.unresolved > 0) return 'changes';
  if (!r.approvedBy?.length) return 'review';
  return status === 'MERGEABLE' && (!r.pipeline || r.pipeline === 'SUCCESS') ? 'ready' : 'approved';
}

function mrBoard(rows, d) {
  const byLane = groupBy(rows, mrLane);
  const lanes = MR_LANES.map(([id, label, tone]) => ({ id, label, tone, items: byLane.get(id) ?? [] }));
  return kanban('Merge requests by status', 'mr-board', lanes, (r) => mrCard(r, d));
}

function mrCard(r, d) {
  const queued = d.pendingByMr.get(r.key) ?? [];
  return el('article', { class: 'kanban-card mr-card ' + MOOD[r.mood].tone, 'data-key': r.key },
    el('div', { class: 'card-head' }, mrRef(r.key, r.title, queued.length ? 'findings' : 'overview'), slot('mrMenu', r)),
    metaLine(r.repo + ' ' + refNumber(r), el('span', { title: 'Updated ' + ago(r.updatedAt) }, r.createdAt ? 'opened ' + ago(r.createdAt) : 'updated ' + ago(r.updatedAt))),
    el('span', { class: 'meta' }, r.author + (r.reviewers.length ? ' → ' + r.reviewers.join(', ') : '')),
    el('div', { class: 'row-head' }, slot('pipelineChip', r), slot('threadsChip', r)));
}
