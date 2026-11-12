const GAME_TABS = [['profile', 'Profile'], ['shop', 'Shop'], ['wardrobe', 'Wardrobe']];
const GAME_SHELVES = [['skin', 'Skins'], ['hat', 'Hats'], ['held', 'To hold'], ['pet', 'Pets'], ['office', 'For the office'], ['room', 'Rooms']];
const GAME_STATS = [
  ['merged', 'MRs merged'], ['review', 'Reviews'], ['comment', 'Review comments'], ['approval', 'Approvals'], ['finding', 'Findings posted'],
  ['tickets', 'Tickets moved'], ['agent', 'Agents finished'], ['tokens', 'Millions of tokens'], ['bestStreak', 'Best streak'], ['rallyBest', 'Longest rally'],
];
const GAME_SOURCE_WORDS = {
  merged: 'MR merged', review: 'Review', comment: 'Review comment', approval: 'Approval', finding: 'Finding posted', qa: 'Ticket to QA', done: 'Ticket to Done',
  agent: 'Agent finished', quest: 'Daily quest', achievement: 'Achievement', tokens: 'Million tokens',
};

function viewGame() {
  const game = state.game;
  if (!game?.on) {
    return [header('Game', 'Points, levels and coins for the work you do.'),
      banner('The game is off. Turn it on in Settings, under Game.', false, ' ', el('a', { class: 'game-go', ...inPage('#settings') }, icon('settings'), 'Settings'))];
  }
  if (!game.started) return [header('Game', 'Points, levels and coins for the work you do.'), empty('Counting your last 30 days of work. The first count takes a minute or so.')];
  const data = gameFull();
  const sub = 'Level ' + game.level + ' ' + game.title + ' · ' + gameNumber(game.coins) + ' coins · ' + plural(game.streak, 'day') + ' in a row';
  const tabs = chips(GAME_TABS, gameUi.tab, (tab) => { gameUi.tab = tab; render(); }, 'game-tab-');
  tabs.setAttribute('aria-label', 'Game');
  const body = { profile: gameProfile, shop: gameShop, wardrobe: gameWardrobe }[gameUi.tab] ?? gameProfile;
  return [header('Game', sub, tabs), gameUi.box.error ? banner('Could not read the game: ' + gameUi.box.error, true) : null, data?.on ? body(data, game) : empty('Reading the game…')];
}

function gameLevelCard(game, data) {
  const stats = data?.stats;
  return el('div', { class: 'game-card game-level' },
    el('b', { class: 'game-badge big' }, game.level),
    el('div', {}, el('h2', {}, game.me), gameLevelWords(game), gameXpBar(game),
      metaLine(gameNumber(game.xp) + ' XP in all', gameNumber(game.coins) + ' coins', plural(game.streak, 'day') + ' in a row', stats ? 'best ' + plural(stats.bestStreak, 'day') : null)));
}

function gameQuestCard(game) {
  return el('div', { class: 'game-card' }, el('h3', {}, 'Today\'s quests'),
    game.quests.length ? el('ul', { class: 'game-quests big' }, game.quests.map(gameQuest)) : el('p', { class: 'empty' }, 'Today\'s quests are drawn with the next read.'),
    el('p', { class: 'hint' }, 'Three a day, drawn from what you usually do, new at midnight UK time.'));
}

function gameStatValue(stats, key) {
  if (key === 'tickets') return stats.qa + stats.done;
  if (key === 'bestStreak') return plural(stats.bestStreak, 'day');
  if (key === 'rallyBest') return plural(stats.rallyBest, 'hit');
  return gameNumber(stats[key] ?? 0);
}

function gameStats(stats) {
  const exact = stats.exactTokens;
  return el('div', { class: 'game-card' }, el('h3', {}, 'What you have done'),
    el('dl', { class: 'game-stats' }, GAME_STATS.map(([key, label]) => el('div', {}, el('dt', {}, label), el('dd', {}, gameStatValue(stats, key))))),
    exact ? el('p', { class: 'hint' }, gameNumber(exact.today) + ' tokens today, ' + gameNumber(exact.window) + ' over the last 30 days.') : null);
}

function gameAchievements(list) {
  const got = list.filter((a) => a.at).length;
  return el('div', { class: 'game-card' }, el('h3', {}, 'Achievements ', el('small', {}, got + ' of ' + list.length)),
    el('ul', { class: 'game-badges' }, list.map((a) => el('li', { class: a.at ? 'got' : 'locked', title: a.at ? 'Unlocked ' + ago(a.at) : a.blurb },
      el('span', { class: 'game-badge-icon' }, icon(a.at ? 'award' : a.secret ? 'help' : 'lock')),
      el('b', {}, a.name), el('span', {}, a.blurb), a.badge ? el('small', {}, 'Badge only') : null))));
}

function gameEarnTable(rewards) {
  return el('div', { class: 'game-card' }, el('h3', {}, 'How you earn'),
    el('table', { class: 'game-earn' }, el('thead', {}, el('tr', {}, el('th', {}, 'For'), el('th', {}, 'XP'), el('th', {}, 'Coins'))),
      el('tbody', {}, rewards.map((r) => el('tr', {}, el('td', {}, el('b', {}, GAME_SOURCE_WORDS[r.source] ?? r.source), el('span', {}, r.what)), el('td', {}, r.xp), el('td', {}, r.coins))))),
    el('p', { class: 'hint' }, 'Only what ' + APP_NAME + ' reads itself pays: GitLab, Jira, the review queue, your agents and Claude Code\'s transcripts. Coins buy looks, nothing else.'));
}

function gameStatus(status) {
  const off = [['GitLab', status?.gitlab], ['Jira', status?.jira]].filter(([, why]) => why);
  return off.length ? banner(off.map(([name, why]) => name + ' could not be read for the game: ' + why).join('. '), true) : null;
}

function gameProfile(data, game) {
  return el('div', { class: 'game-profile' }, gameStatus(data.status),
    el('div', { class: 'game-column' }, gameLevelCard(game, data), gameQuestCard(game), gameAchievements(data.achievements)),
    el('div', { class: 'game-column' }, gameStats(data.stats), gameEarnTable(data.rewards)));
}

function gameProfileCard() {
  const game = gameOn();
  if (!game) return null;
  const data = gameFull();
  const got = data?.achievements?.filter((a) => a.at).length;
  return el('div', { class: 'game-mini' },
    el('div', { class: 'game-hud-level' }, el('b', { class: 'game-badge' }, game.level), el('div', {}, gameLevelWords(game), gameXpBar(game))),
    metaLine(gameNumber(game.coins) + ' coins', plural(game.streak, 'day') + ' in a row', got != null ? got + ' of ' + data.achievements.length + ' achievements' : null),
    el('ul', { class: 'game-quests big' }, game.quests.map(gameQuest)),
    data?.stats ? el('dl', { class: 'game-stats small' }, GAME_STATS.slice(0, 6).map(([key, label]) => el('div', {}, el('dt', {}, label), el('dd', {}, gameStatValue(data.stats, key))))) : null,
    el('div', { class: 'actions' }, gameGo('Profile', 'user', 'profile', 'game-card-profile'), gameGo('Shop', 'bag', 'shop', 'game-card-shop'), gameGo('Wardrobe', 'shirt', 'wardrobe', 'game-card-wardrobe')));
}

const gamePlaced = (game) => Object.keys(game.equipped?.office ?? {}).filter((id) => game.equipped.office[id]).sort();

function gameTryOn(item, game) {
  if (item.slot === 'room') return { room: item.id, rooms: game.rooms ?? [], addons: gamePlaced(game) };
  if (item.slot === 'office') return { addon: item.id };
  return { wearer: 'player', outfit: { ...(game.equipped.player ?? {}), [item.slot]: item.id } };
}

function gameItemState(item) {
  if (item.owned) return ['owned', item.slot === 'room' ? 'Built' : 'Yours'];
  if (item.locked) return ['locked', 'Level ' + item.level];
  return [item.short ? 'short' : 'buy', gameNumber(item.price) + ' coins'];
}

function gameItemTile(item, picked) {
  const [tone, words] = gameItemState(item);
  return el('button', { type: 'button', class: 'game-item ' + tone, id: 'game-item-' + item.id, 'data-slot': item.slot, 'aria-pressed': String(item.id === picked.id), onclick: () => gamePick(item.id) },
    el('span', { class: 'game-swatch', 'data-item': item.id }), el('b', {}, item.name), el('small', {}, icon(tone === 'owned' ? 'check' : tone === 'locked' ? 'lock' : 'coins'), words));
}

// On a phone the preview sits far above the shelves, so picking something brings it back into view.
function gamePick(id) {
  gameUi.pick = id;
  render(true);
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 780px)').matches;
  if (narrow) document.querySelector('#main .game-stage')?.scrollIntoView?.({ behavior: gameReduced() ? 'auto' : 'smooth', block: 'start' });
}

function gameBuildButton(item, game) {
  if (item.owned) return el('button', { type: 'button', disabled: true }, icon('check'), 'Built');
  if (item.buildFirst) return el('button', { type: 'button', disabled: true }, icon('lock'), 'Build the ' + item.buildFirst.map((n) => n.toLowerCase()).join(' or the ') + ' first');
  if (item.locked) return el('button', { type: 'button', disabled: true }, icon('lock'), 'Unlocks at level ' + item.level);
  if (item.short) return el('button', { type: 'button', disabled: true }, icon('coins'), gameNumber(item.price - game.coins) + ' more coins to go');
  return guarded('game-buy:' + item.id, 'Build it for ' + gameNumber(item.price) + ' coins', 'bag', 'Spend ' + gameNumber(item.price) + ' of your ' + gameNumber(game.coins) + '?', () => gameWrite('/api/game/buy', { item: item.id }, 'game-buy:' + item.id), true);
}

const GAME_PREVIEW_HINTS = { room: 'Shown ghosted into your office, where it will go.', office: 'Shown where it will stand in the office.' };

function gameBuyButton(item, game) {
  if (item.slot === 'room') return gameBuildButton(item, game);
  if (item.owned) return el('a', { class: 'game-go', ...inPage('#game', () => { gameUi.tab = 'wardrobe'; }) }, icon('shirt'), item.slot === 'office' ? 'Place it in the wardrobe' : 'Wear it in the wardrobe');
  if (item.locked) return el('button', { type: 'button', disabled: true }, icon('lock'), 'Unlocks at level ' + item.level);
  if (item.short) return el('button', { type: 'button', disabled: true }, icon('coins'), gameNumber(item.price - game.coins) + ' more coins to go');
  return guarded('game-buy:' + item.id, 'Buy for ' + gameNumber(item.price) + ' coins', 'bag', 'Spend ' + gameNumber(item.price) + ' of your ' + gameNumber(game.coins) + '?', () => gameWrite('/api/game/buy', { item: item.id }, 'game-buy:' + item.id), true);
}

function gameShop(data, game) {
  const picked = data.catalogue.find((i) => i.id === gameUi.pick) ?? data.catalogue.find((i) => !i.owned && !i.locked) ?? data.catalogue[0];
  return el('div', { class: 'game-shop' },
    el('div', { class: 'game-stage' }, gamePreviewNode(gameTryOn(picked, game)),
      el('div', { class: 'game-detail' }, el('h2', {}, picked.name), el('p', {}, picked.blurb),
        metaLine(gameNumber(picked.price) + ' coins', 'from level ' + picked.level, 'you have ' + gameNumber(game.coins)), gameBuyButton(picked, game),
        el('p', { class: 'hint' }, GAME_PREVIEW_HINTS[picked.slot] ?? 'Shown on you, with what you already wear.'))),
    GAME_SHELVES.map(([slotName, title]) => el('section', { class: 'game-shelf' }, el('h3', {}, title),
      el('div', { class: 'game-items' }, data.catalogue.filter((i) => i.slot === slotName).map((i) => gameItemTile(i, picked))))));
}

function gameWearChoice(wearer, slotName, item, worn, label) {
  const on = (worn ?? null) === item;
  return el('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), disabled: ui.busy.has('game-wear'),
    onclick: () => (on ? null : gameWrite('/api/game/equip', { wearer, slot: slotName, item }, 'game-wear')) }, label);
}

function gameSlotRow(wearer, slotName, worn, owned) {
  const title = GAME_SHELVES.find(([s]) => s === slotName)[1];
  return el('div', { class: 'game-slot' }, el('h3', {}, title),
    el('div', { class: 'game-choices' }, gameWearChoice(wearer, slotName, null, worn[slotName], 'None'),
      owned.filter((i) => i.slot === slotName).map((i) => gameWearChoice(wearer, slotName, i.id, worn[slotName], i.name))));
}

function gamePlaceSwitch(item, game) {
  const placed = Boolean(game.equipped.office?.[item.id]);
  return el('button', { type: 'button', class: 'switch', role: 'switch', id: 'game-place-' + item.id, 'aria-checked': String(placed), disabled: ui.busy.has('game-wear'),
    onclick: () => gameWrite('/api/game/equip', { wearer: 'office', slot: item.id, item: placed ? null : item.id }, 'game-wear') }, el('span', { class: 'knob' }), item.name);
}

function gameOfficeShelf(owned, game) {
  const addons = owned.filter((i) => i.slot === 'office');
  const rooms = owned.filter((i) => i.slot === 'room');
  return el('section', { class: 'game-shelf' }, el('h3', {}, 'In the office'),
    addons.length ? el('div', { class: 'game-choices' }, addons.map((i) => gamePlaceSwitch(i, game))) : el('p', { class: 'empty' }, 'Nothing for the office yet. The shop has a neon sign from level 2.'),
    rooms.length ? el('p', { class: 'hint' }, 'Rooms built: ' + rooms.map((i) => i.name).join(', ') + '. A room stays once it is built.') : null);
}

function gameWardrobe(data, game) {
  const wearer = data.wearers.some((w) => w.id === gameUi.wearer) ? gameUi.wearer : 'player';
  const worn = game.equipped[wearer] ?? {};
  const owned = data.catalogue.filter((i) => i.owned);
  const pickWearer = chips(data.wearers.map((w) => [w.id, w.label]), wearer, (id) => { gameUi.wearer = id; render(); }, 'game-wearer-');
  pickWearer.setAttribute('aria-label', 'Who to dress');
  return el('div', { class: 'game-wardrobe' }, pickWearer,
    el('div', { class: 'game-stage' }, gamePreviewNode({ wearer, outfit: worn }), el('div', { class: 'game-slots' }, data.slots.map((slotName) => gameSlotRow(wearer, slotName, worn, owned)))),
    gameOfficeShelf(owned, game),
    owned.length ? null : el('p', { class: 'hint' }, 'Buy something in the shop and it shows here, to put on you, the manager or every agent of a kind.'));
}

function gamePreviewWords(spec) {
  if (spec.room) return 'Your office, with the ' + spec.room.replace('room-', '') + ' ghosted in where it would go';
  if (spec.addon) return 'A preview of the ' + spec.addon.replace('office-', '') + ' for the office';
  const worn = Object.values(spec.outfit ?? {}).filter(Boolean).map((id) => id.split('-').slice(1).join(' '));
  return 'A preview of ' + (spec.wearer === 'player' ? 'you' : spec.wearer) + (worn.length ? ' wearing ' + worn.join(', ') : ' with nothing on');
}

// One canvas and one drawing context, kept across renders and moved into each, as the office keeps its own.
function gamePreviewNode(spec) {
  if (!gameUi.preview) {
    const canvas = el('canvas', { class: 'game-preview-canvas', 'aria-hidden': 'true' });
    let renderer = null;
    try {
      renderer = typeof canvas.getContext === 'function' ? officePreview(canvas) : null;
    } catch (e) {
      console.error('game preview', e);
    }
    gameUi.preview = { canvas, renderer, loop: null };
  }
  const p = gameUi.preview;
  if (!p.renderer) return el('div', { class: 'game-preview none' }, icon('info'), 'The preview needs WebGL.');
  p.renderer.spec = spec;
  gamePreviewWake();
  return el('div', { class: 'game-preview' + (spec.room ? ' wide' : ''), role: 'img', 'aria-label': gamePreviewWords(spec) }, p.canvas);
}

function gamePreviewWake() {
  const p = gameUi.preview;
  if (!p?.renderer || p.loop || typeof requestAnimationFrame !== 'function') return;
  p.loop = requestAnimationFrame(gamePreviewTick);
}

function gamePreviewTick(now) {
  const p = gameUi.preview;
  p.loop = null;
  if (!p.canvas.isConnected || document.hidden) return;
  try {
    officePreviewDraw(p.renderer, now);
  } catch (e) {
    console.error('game preview', e);
    p.renderer = null;
    return;
  }
  if (!gameReduced()) p.loop = requestAnimationFrame(gamePreviewTick);
}

document.addEventListener('visibilitychange', gamePreviewWake);
