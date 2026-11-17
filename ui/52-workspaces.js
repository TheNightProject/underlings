const WORKSPACE_COLOURS = ['blue', 'green', 'amber', 'rose', 'violet', 'teal', 'slate'];

function workspacesBox() {
  ui.workspaces ??= { open: false, drafts: {}, create: { name: '', account: '', copyFrom: null, colour: null } };
  return ui.workspaces;
}

const workspaceList = () => state?.workspaces?.workspaces ?? null;
const hereWorkspace = () => workspaceList()?.find((w) => w.here) ?? null;
const workspaceDot = (w) => el('span', { class: 'ws-dot ws-' + w.colour, 'aria-hidden': 'true' });

// Shown once there is a second workspace, as the switch is all it is for; until then Workspaces under Settings makes one.
function renderSwitcher() {
  const node = document.getElementById('switcher');
  const list = workspaceList();
  const here = hereWorkspace();
  node.hidden = !list || list.length < 2 || !here;
  if (node.hidden) return node.replaceChildren();
  const box = workspacesBox();
  const elsewhere = list.filter((w) => !w.here).reduce((n, w) => n + w.count, 0);
  node.replaceChildren(...[
    el('button', { id: 'switcher-button', class: 'switcher-button', 'aria-expanded': String(box.open), 'aria-haspopup': 'menu', title: 'Switch workspace', onclick: () => { box.open = !box.open; render(true); } },
      workspaceDot(here), el('span', { class: 'ws-name' }, here.name),
      elsewhere ? el('span', { class: 'count hot', title: elsewhere + ' waiting on you in other workspaces' }, String(elsewhere)) : null,
      icon('down')),
    box.open ? el('div', { class: 'switcher-menu', role: 'menu' },
      list.map((w) => el('button', { role: 'menuitemradio', 'aria-checked': String(w.here), class: 'switcher-item', 'data-id': w.id, onclick: () => switchWorkspace(w) },
        workspaceDot(w), el('span', { class: 'ws-name' }, w.name), w.count ? el('span', { class: 'count hot' }, String(w.count)) : null, w.state === 'running' ? null : el('span', { class: 'meta' }, w.state))),
      el('a', { class: 'switcher-item manage', ...inPage('#workspaces', () => { box.open = false; }) }, icon('settings'), 'Manage workspaces')) : null,
  ].filter(Boolean));
}

async function switchWorkspace(w) {
  workspacesBox().open = false;
  if (w.here) return render(true);
  await busyAct('/api/workspaces/switch', { id: w.id }, 'ws-switch:' + w.id);
}

function viewWorkspaces() {
  const list = workspaceList();
  if (!list) return [header('Workspaces', 'Several setups side by side, each with its own accounts, settings and agents.'), empty('Workspaces run in the ' + APP_NAME + ' app.')];
  return [
    header('Workspaces', 'Each one is a separate ' + APP_NAME + ': its own Claude account, tokens, settings, agents and queue, all running at once. Your profile, time and region, the game and updates are shared.'),
    el('div', { class: 'list' }, list.map(workspaceRow)),
    section('New workspace', workspaceCreate(list)),
  ];
}

function workspaceRow(w) {
  const box = workspacesBox();
  const draft = box.drafts[w.id] ?? { name: w.name, account: w.account };
  const keep = (key) => (e) => { box.drafts[w.id] = { ...draft, [key]: e.target.value }; };
  const save = (patch) => busyAct('/api/workspaces/update', { id: w.id, ...patch }, 'ws-update:' + w.id).then((ok) => { if (ok) delete box.drafts[w.id]; });
  return el('div', { class: 'row workspace-row', 'data-id': w.id },
    el('div', { class: 'row-head' }, workspaceDot(w), el('span', { class: 'title' }, w.name),
      w.here ? el('span', { class: 'pill info' }, 'This one') : null,
      w.state === 'running' ? null : el('span', { class: 'pill warn' }, w.state),
      w.count ? el('span', { class: 'count hot' }, String(w.count)) : null),
    el('div', { class: 'foot' }, metaLine(w.account ? 'cswap account ' + w.account : 'default Claude login', 'port ' + w.port, w.id === 'default' ? 'the folders it always used' : 'workspaces/' + w.id)),
    el('div', { class: 'workspace-edit' },
      el('label', {}, 'Name ', el('input', { id: 'ws-name-' + w.id, value: draft.name, maxlength: 40, oninput: keep('name') })),
      el('label', {}, 'cswap account ', el('input', { id: 'ws-account-' + w.id, value: draft.account, placeholder: 'default', inputmode: 'numeric', size: 8, oninput: keep('account') })),
      el('button', { id: 'ws-save-' + w.id, disabled: ui.busy.has('ws-update:' + w.id), onclick: () => save({ name: box.drafts[w.id]?.name ?? w.name, account: box.drafts[w.id]?.account ?? w.account }) }, icon('check'), 'Save'),
      chips(WORKSPACE_COLOURS.map((c) => [c, el('span', { class: 'ws-dot ws-' + c, title: c })]), w.colour, (colour) => save({ colour }), 'ws-colour-' + w.id + '-')),
    el('div', { class: 'actions' },
      w.here ? null : button('Switch to it', 'open', () => switchWorkspace(w), true),
      w.id === 'default' ? null : guarded('ws-remove:' + w.id, 'Remove', 'trash', 'Remove ' + w.name + '?', () => busyAct('/api/workspaces/remove', { id: w.id }, 'ws-remove:' + w.id))));
}

function workspaceCreate(list) {
  const draft = workspacesBox().create;
  const keep = (key) => (e) => { draft[key] = e.target.value; };
  const create = async () => {
    const answer = await busyAct('/api/workspaces/create', { name: draft.name, account: draft.account, copyFrom: draft.copyFrom, colour: draft.colour ?? undefined }, 'ws-create');
    if (answer) Object.assign(draft, { name: '', account: '', copyFrom: null, colour: null });
  };
  return el('div', { class: 'workspace-create' },
    el('label', {}, 'Name ', el('input', { id: 'ws-new-name', value: draft.name, maxlength: 40, placeholder: 'Side project', oninput: keep('name') })),
    el('label', {}, 'cswap account ', el('input', { id: 'ws-new-account', value: draft.account, placeholder: 'default', inputmode: 'numeric', size: 8, oninput: keep('account') })),
    el('div', { class: 'workspace-copy' }, el('span', { class: 'meta' }, 'Settings '),
      chips([[null, 'Start fresh'], ...list.map((w) => [w.id, 'Copy ' + w.name])], draft.copyFrom, (id) => { draft.copyFrom = id; render(true); }, 'ws-copy-')),
    el('p', { class: 'hint' }, 'A copy takes how the workspace reads and shows things, never its tokens, its history or its Setup.'),
    el('button', { id: 'ws-create', class: 'primary', disabled: ui.busy.has('ws-create'), onclick: create }, icon('plus'), ui.busy.has('ws-create') ? 'Making…' : 'Make it'));
}

function workspaceEntries() {
  return (workspaceList() ?? []).filter((w) => !w.here).map((w) => ({
    id: 'workspace:' + w.id, group: 'Workspaces', icon: 'layers', label: 'Switch to ' + w.name,
    detail: [w.count ? w.count + ' waiting on you' : null, w.account ? 'cswap account ' + w.account : null].filter(Boolean).join(' · '),
    terms: ['workspace', w.name, w.id],
    run: () => switchWorkspace(w),
  }));
}
