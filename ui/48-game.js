const GAME_TOAST_MS = 4500;
const GAME_TOASTS_SHOWN = 3;
const GAME_LABELS_SHOWN = 2;
const GAME_LEVEL_MS = 2600;
const GAME_SPARKS = 14;
const GAME_RESET_WORDS = 'start again';
const gameUi = { epoch: null, seen: null, level: null, earned: null, waiting: false, box: {}, tab: 'profile', wearer: 'player', pick: null, preview: null, rateDraft: null };

const gameNumber = (n) => numberText(Math.round(n));
const gameShort = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : gameNumber(n));
const gameOn = () => (state?.game?.on && state.game.started ? state.game : null);

function gameReduced() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function renderGame() {
  gameRail();
  gameNotice();
}

function gameRail() {
  const pill = document.getElementById('game-pill');
  if (!pill) return;
  const link = pill.closest('.navlink');
  const bar = link.querySelector('.game-rail-xp');
  link.hidden = state?.game?.on === false || !featureOn('game');
  const game = gameOn();
  pill.hidden = bar.hidden = !game;
  if (!game) {
    pill.replaceChildren();
    bar.replaceChildren();
    return;
  }
  pill.title = 'Level ' + game.level + ' ' + game.title + ', ' + gameNumber(game.coins) + ' coins';
  pill.replaceChildren(el('b', {}, 'Lv ' + game.level), el('span', {}, icon('coins'), gameShort(game.coins)));
  bar.replaceChildren(gameXpBar(game));
}

const GAME_NONE = { xp: 0, coins: 0, rewards: 0, tokens: 0 };
const gameLess = (a, b) => ({ xp: a.xp - b.xp, coins: a.coins - b.coins, rewards: a.rewards - b.rewards, tokens: (a.tokens ?? 0) - (b.tokens ?? 0) });
const gameSum = (entries) => ({ xp: entries.reduce((n, e) => n + e.xp, 0), coins: entries.reduce((n, e) => n + e.coins, 0), rewards: entries.length, tokens: 0 });

// The first snapshot a page sees is where it starts from, so only what lands while it is open toasts.
function gameStartFrom(game) {
  if (gameUi.epoch === game.epoch) return;
  const counted = gameUi.waiting;
  Object.assign(gameUi, { epoch: game.epoch, waiting: false, seen: counted ? 0 : game.seq, level: counted ? 1 : game.level, earned: counted ? GAME_NONE : game.earned ?? GAME_NONE });
}

function gameNotice() {
  const game = state?.game;
  if (!game?.on) return;
  if (!game.started) return void (gameUi.waiting = true);
  gameStartFrom(game);
  if (game.seq <= gameUi.seen) return void (gameUi.level = game.level);
  const fresh = game.recent.filter((e) => e.seq > gameUi.seen && e.kind === 'reward');
  const gained = gameLess(game.earned ?? GAME_NONE, gameUi.earned);
  const levelled = game.level > gameUi.level;
  Object.assign(gameUi, { seen: game.seq, level: game.level, earned: game.earned ?? GAME_NONE });
  const pops = fresh.filter((e) => e.source === 'achievement' && !e.back);
  if (game.toasts) gameToast(fresh.filter((e) => !pops.includes(e)), gameLess(gained, gameSum(pops)), game);
  pops.forEach(gameAchievement);
  if (levelled) gameLevelUp(game);
}

function gameTally({ xp, coins }) {
  return '+' + gameNumber(xp) + ' XP · +' + gameNumber(coins) + ' coins';
}

// A run of millions of tokens reads as the last of them, so one toast says how far today has gone.
function gameToastWords(entries, gained, game) {
  const live = entries.filter((e) => !e.back);
  if (!live.length) return 'Counted ' + plural(gained.rewards, 'reward') + ' from earlier days: level ' + game.level + ' ' + game.title;
  const tokens = live.filter((e) => e.source === 'tokens').at(-1)?.label;
  const shown = [...new Set(live.map((e) => (e.source === 'tokens' ? tokens : e.label)))].slice(0, GAME_LABELS_SHOWN);
  const named = live.filter((e) => e.source !== 'tokens' && shown.includes(e.label)).length + (shown.includes(tokens) ? gained.tokens : 0);
  const more = gained.rewards - named;
  return shown.join(', ') + (more > 0 ? ' and ' + more + ' more' : '');
}

function gameHolder(id, cls) {
  let node = document.getElementById(id);
  if (!node) {
    node = el('div', { id, class: cls, role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  return node;
}

function gameToast(entries, gained, game) {
  if (!entries.length || gained.rewards <= 0) return;
  const holder = gameHolder('game-toasts', 'game-toasts');
  const node = el('div', { class: 'game-toast' + (gameReduced() ? ' still' : '') },
    el('span', { class: 'game-toast-icon' }, icon('coins')),
    el('div', {}, el('b', {}, gameTally(gained)), el('span', {}, gameToastWords(entries, gained, game))));
  holder.append(node);
  while (holder.childNodes.length > GAME_TOASTS_SHOWN) holder.childNodes[0].remove();
  setTimeout(() => node.remove(), GAME_TOAST_MS);
}

function gameAchievement(entry) {
  const holder = gameHolder('game-pops', 'game-pops');
  const pays = entry.xp || entry.coins ? gameTally(entry) : 'A badge, for fun';
  const node = el('div', { class: 'game-pop' + (gameReduced() ? ' still' : '') },
    el('span', { class: 'game-pop-icon' }, icon('award')),
    el('div', {}, el('small', {}, 'Achievement unlocked'), el('b', {}, entry.label.replace(/^Achievement: /, '')), el('span', {}, pays)));
  holder.append(node);
  setTimeout(() => node.remove(), GAME_TOAST_MS + 1000);
}

function gameLevelUp(game) {
  document.querySelector('.game-levelup')?.remove();
  const still = gameReduced();
  const sparks = still ? [] : Array.from({ length: GAME_SPARKS }, (_, i) => el('i', { style: '--a:' + Math.round((360 / GAME_SPARKS) * i) + 'deg;--d:' + (90 + (i % 3) * 40) + 'px' }));
  const node = el('div', { class: 'game-levelup' + (still ? ' still' : ''), role: 'status', 'aria-live': 'assertive' },
    el('div', { class: 'game-burst', 'aria-hidden': 'true' }, sparks),
    el('div', { class: 'game-banner' }, el('small', {}, 'Level up'), el('b', {}, 'Level ' + game.level), el('span', {}, game.title)));
  document.body.append(node);
  slot('officeLevelUp');
  setTimeout(() => node.remove(), GAME_LEVEL_MS);
}

function gameXpBar(game) {
  const span = Math.max(1, game.nextAt - game.levelAt);
  const into = Math.max(0, game.xp - game.levelAt);
  const pct = Math.min(100, (into / span) * 100);
  return el('span', { class: 'game-xp', role: 'progressbar', 'aria-label': 'XP towards level ' + (game.level + 1), 'aria-valuemin': '0', 'aria-valuemax': String(span), 'aria-valuenow': String(into), title: gameNumber(span - into) + ' XP to level ' + (game.level + 1) },
    el('span', { class: 'game-xp-fill', style: 'width:' + pct.toFixed(1) + '%' }));
}

function gameLevelWords(game) {
  const into = Math.max(0, game.xp - game.levelAt);
  return el('span', { class: 'game-level-words' }, el('strong', {}, game.title), el('small', {}, gameNumber(into) + ' / ' + gameNumber(game.nextAt - game.levelAt) + ' XP'));
}

function gameQuest(q) {
  return el('li', { class: q.done ? 'done' : null }, icon(q.done ? 'check-circle' : 'circle'), el('span', {}, q.label), el('small', {}, Math.min(q.have, q.target) + '/' + q.target));
}

function gameGo(label, iconName, tab, id) {
  return el('a', { class: 'game-go', id, ...inPage('#game', () => { gameUi.tab = tab; }) }, icon(iconName), label);
}

function gameHud() {
  const game = state.game;
  if (!game?.on) return null;
  if (!game.started) return el('div', { class: 'game-hud waiting' }, icon('gamepad'), 'Counting your last 30 days of work for the game…');
  return el('div', { class: 'game-hud', role: 'group', 'aria-label': 'Your progress' },
    el('div', { class: 'game-hud-level' }, el('b', { class: 'game-badge', title: 'Level ' + game.level }, game.level), el('div', {}, gameLevelWords(game), gameXpBar(game))),
    el('span', { class: 'game-stat', title: 'Coins' }, icon('coins'), gameNumber(game.coins)),
    el('span', { class: 'game-stat', title: 'Days worked in a row; days off never break it' }, icon('flame'), plural(game.streak, 'day')),
    el('ul', { class: 'game-quests', 'aria-label': 'Today\'s quests' }, game.quests.map(gameQuest)),
    el('div', { class: 'game-hud-tools' }, gameGo('Shop', 'bag', 'shop', 'game-hud-shop'), gameGo('Wardrobe', 'shirt', 'wardrobe', 'game-hud-wardrobe')));
}

function gameFull() {
  return readOnce(gameUi.box, '/api/game');
}

async function gameWrite(path, payload, busyId) {
  const answer = await busyAct(path, payload, busyId);
  gameUi.box.at = null;
  return answer;
}

function gameSwitch(id, label, on, onclick, hint) {
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' }, el('button', { id, class: 'switch', role: 'switch', 'aria-checked': String(Boolean(on)), 'aria-disabled': ui.busy.has('game-settings') ? 'true' : null, onclick },
      el('span', { class: 'knob' }), on ? 'On' : 'Off')),
    el('p', { class: 'hint' }, hint));
}

function gameRateRow(rate) {
  const draft = gameUi.rateDraft ?? (rate == null ? '' : String(rate.value));
  const save = () => gameWrite('/api/game/settings', { tokenRate: Number(draft) }, 'game-settings').then(() => { gameUi.rateDraft = null; });
  return el('div', { class: 'setting' }, el('label', { for: 'game-rate' }, 'XP for each million tokens'),
    el('div', { class: 'control' },
      el('input', { id: 'game-rate', type: 'text', inputmode: 'numeric', class: 'number', value: draft, spellcheck: 'false', autocomplete: 'off',
        oninput: (e) => { gameUi.rateDraft = e.target.value; render(true); }, onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
      el('span', { class: 'unit' }, rate ? '(' + rate.min + ' to ' + rate.max + ')' : ''),
      gameUi.rateDraft != null && gameUi.rateDraft !== String(rate?.value) ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, 'Claude Code\'s input and output tokens, cache reads left out, pay this much XP and a tenth as many coins for each million in a day. A change pays from the next million on.'));
}

function gameResetRow() {
  return el('div', { class: 'setting' }, el('label', { for: 'g-game-reset' }, 'Start again'),
    el('div', { class: 'control' }, guarded('game-reset', 'Start again', 'rotate-ccw', 'Click again to clear it all', () => gameWrite('/api/game/reset', { confirm: GAME_RESET_WORDS }, 'game-reset'))),
    el('p', { class: 'hint' }, 'Clears your level, XP, coins, streak, quests, achievements and everything bought and worn, then counts your last 30 days of work again. Your work itself is not touched.'));
}

function gameSettingsGroup() {
  const data = state?.game?.on === false ? null : gameFull();
  const saved = data?.settings ?? { on: state?.game?.on !== false, toasts: state?.game?.toasts !== false };
  const save = (patch) => gameWrite('/api/game/settings', patch, 'game-settings');
  const playing = [
    gameSwitch('game-toasts', 'Reward toasts', saved.toasts, () => save({ toasts: !saved.toasts }), 'A note at the foot of the page as each reward lands. Level ups and achievements show either way.'),
    gameRateRow(data?.tokenRate),
    gameResetRow(),
  ];
  return el('section', { class: 'section settings-group', id: 'game-settings' }, el('h2', {}, 'Game'),
    gameSwitch('game-on', 'Play the game', saved.on, () => save({ on: !saved.on }), 'Points, levels and coins for the work you do, read from GitLab, Jira, the review queue, your agents and Claude Code\'s token use. Off reads none of them and hides the game.'),
    saved.on ? playing : null);
}
