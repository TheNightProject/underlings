const DECIDE_TONES = new Map([['CRITICAL', 's-need'], ['MAJOR', 's-need'], ['MINOR', 's-working'], ['NIT', 's-quiet'], ['QUESTION', 's-info'], ['reply', 's-info']]);
const decideFacts = { for: null, loading: false, tidies: null, mrs: {} };

// The counts come from the worker, as the snapshot keeps only the latest settled items; full auto's own items never ask you to decide.
function commentsUp(r) {
  const m = state?.matrix;
  if (!r || r.flags.mine || !m?.available) return null;
  const up = decideSummary().mrs?.[r.key];
  if (!up || m.queue.some((q) => q.key === r.key && q.status === 'pending' && !q.auto)) return null;
  const decidedAt = m.verdicts?.[r.key]?.at ?? '';
  return decidedAt < up.lastPost && !putAway(r, up) ? up : null;
}

// The worker keeps Later until something on the MR changes, the same mark whichever card set it.
function laterMarkFor(r, up) {
  return attention().verdictMarks?.[r.key] ?? 'up:' + up.lastPost;
}

const putAway = (r, up) => attention().later?.[r.key] === laterMarkFor(r, up);

function decideCard(r, d, where = 'row') {
  if (r && !forgeAllows(r.key, 'post')) return null;
  const up = commentsUp(r);
  if (!up) return where === 'row' ? null : verdictLine(r);
  const closes = decideSummary().tidies === true && r.agent !== 'working';
  const id = (verdict) => 'decide-' + verdict + ':' + r.key;
  const send = (verdict) => matrixAct('decide', { key: r.key, verdict, expect: { sha: r.sha } }, id(verdict));
  const tail = closes ? ' and close the review workspace?' : '?';
  return el('div', { class: 'decide', role: 'group', 'aria-label': 'Comments are up on ' + short(r.key) },
    el('div', { class: 'row-head' },
      el('span', { class: 'pill s-done' }, icon('check-circle'), 'Comments are up'),
      el('span', { class: 'meta' }, up.posted + ' posted' + (up.dropped ? ', ' + up.dropped + ' dropped' : '')),
      postedTally(up.kinds)),
    el('div', { class: 'actions' },
      guarded(id('approve'), 'Approve', 'thumbsup', 'Approve ' + refNumber(r) + tail, () => send('approve'), true),
      guarded(id('changes'), 'Request changes', 'lock', 'Request changes on ' + refNumber(r) + tail, () => send('changes')),
      button('Later', 'clock', () => attentionCall('later', { key: r.key, mark: laterMarkFor(r, up) }))),
    el('div', { class: 'meta' }, decideNote(r, closes)));
}

function postedTally(kinds) {
  return [...DECIDE_TONES].map(([kind, tone]) => {
    const n = kinds[kind] ?? 0;
    const label = kind === 'reply' ? (n === 1 ? 'reply' : 'replies') : kind.toLowerCase();
    return n ? el('span', { class: 'pill ' + tone }, n + ' ' + label) : null;
  });
}

function decideNote(r, closes) {
  const hold = r.flags.held && r.flags.heldByMe !== false ? 'Approving lifts the hold on it.' : 'Requesting changes blocks the merge until you lift it.';
  if (closes) return hold + ' Either one closes the review workspace; its run log is kept.';
  if (decideSummary().tidies && r.agent === 'working') return hold + ' Its review agent is still working, so the workspace stays open.';
  return hold;
}

function verdictLine(r) {
  const pill = verdictPill(r);
  return pill ? el('div', { class: 'row-head' }, pill) : null;
}

function verdictPill(r) {
  const v = r && state?.matrix?.verdicts?.[r.key];
  if (!v) return null;
  const approved = v.verdict === 'approved';
  if (approved && v.sha && r.sha && v.sha !== r.sha && !r.approvedBy.includes(state.matrix.me)) return el('span', { class: 'pill s-need' }, icon('rotate-ccw'), 'Your approval was reset by a push');
  return el('span', { class: 'pill ' + (approved ? 's-done' : 's-working') }, icon(approved ? 'thumbsup' : 'lock'), (approved ? 'You approved ' : 'You requested changes ') + ago(v.at));
}

// The queue lists only MRs with something pending, so one whose review has just been posted would drop out with its question.
function decideCards(d) {
  if (ui.queueFilter !== 'pending') return null;
  const cards = d.rows.map((r) => [r, decideCard(r, d)]).filter(([, card]) => card);
  if (!cards.length) return null;
  return el('div', { class: 'list' }, cards.map(([r, card]) => el('div', { class: 'row' },
    el('div', { class: 'row-head' }, mrRef(r.key, short(r.key), 'findings'), el('span', { class: 'text' }, r.title)),
    card)));
}

function decideSummary() {
  if (!decideFacts.loading && decideFacts.for !== state) loadDecideFacts(state);
  return decideFacts;
}

// Asked again for every snapshot, so a post or a verdict moves the card as soon as the queue beside it does.
async function loadDecideFacts(snapshot) {
  decideFacts.loading = true;
  try {
    const { tidies, mrs } = await api('/api/matrix/decide');
    Object.assign(decideFacts, { tidies, mrs: mrs ?? {} });
  } catch {
    Object.assign(decideFacts, { tidies: null, mrs: {} });
  }
  Object.assign(decideFacts, { for: snapshot, loading: false });
  render(true);
}
