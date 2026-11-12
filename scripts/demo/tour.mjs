import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HANDLE } from './world-agents.mjs';

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (2 * (1 - t)) ** 2 / 2);
const HEAD_ROOM_XP = 15;
const MEETING_LEAD_MS = 55_000;

function stagehand({ page, url, root, now }) {
  const at = { x: 600, y: 380 };
  let booted = false;
  let rallies = 0;
  const skips = [];
  const wait = (ms) => page.waitForTimeout(ms);

  async function travel(to, ms) {
    const from = { ...at };
    const began = performance.now();
    for (let t = 0; t < 1; ) {
      t = Math.min(1, (performance.now() - began) / ms);
      await page.mouse.move(from.x + (to.x - from.x) * ease(t), from.y + (to.y - from.y) * ease(t));
    }
    Object.assign(at, to);
  }

  async function centreOf(target, nudge = {}) {
    const locator = typeof target === 'string' ? page.locator(target).first() : target.first();
    await locator.waitFor({ state: 'visible', timeout: 15_000 });
    let box = await locator.boundingBox();
    if (box.y < 0 || box.y + box.height > 750) {
      await locator.scrollIntoViewIfNeeded();
      box = await locator.boundingBox();
    }
    return { x: box.x + box.width * (nudge.x ?? 0.5), y: box.y + box.height * (nudge.y ?? 0.5) };
  }

  async function point(target, { ms = 380, nudge } = {}) {
    await travel(await centreOf(target, nudge), ms);
  }

  // A moving target, such as an agent's tag in the office, is aimed at again until the pointer is on it.
  async function click(target, { ms = 380, pause = 260, nudge } = {}) {
    await point(target, { ms, nudge });
    for (let tries = 0; tries < 4; tries += 1) {
      const aimed = await centreOf(target, nudge);
      if (Math.hypot(aimed.x - at.x, aimed.y - at.y) < 3) break;
      await travel(aimed, 120);
    }
    await wait(90);
    await page.mouse.down();
    await wait(50);
    await page.mouse.up();
    await wait(pause);
  }

  async function drag(dx, dy = 0, ms = 1800) {
    await page.mouse.down();
    await travel({ x: at.x + dx, y: at.y + dy }, ms);
    await page.mouse.up();
  }

  async function dragBetween(from, to, ms = 700) {
    await point(from, { ms: 360 });
    await page.mouse.down();
    await wait(80);
    await travel({ x: at.x + 14, y: at.y + 10 }, 120);
    await point(to, { ms });
    await wait(120);
    await page.mouse.up();
    await wait(300);
  }

  function glideScroll(selector, { left = 0, top = 0 }, ms = 650) {
    return page.evaluate(([sel, dx, dy, over]) => new Promise((done) => {
      const box = sel ? document.querySelector(sel) : null;
      const read = () => (box ? [box.scrollLeft, box.scrollTop] : [scrollX, scrollY]);
      const [x0, y0] = read();
      const began = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - began) / over);
        const e = t < 0.5 ? 2 * t * t : 1 - (2 * (1 - t)) ** 2 / 2;
        (box ?? window).scrollTo(x0 + dx * e, y0 + dy * e);
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    }), [selector, left, top, ms]);
  }

  async function scrollOver(target, selector, delta, ms = 650) {
    await point(target, { ms: 280, nudge: { x: 0.5, y: 0.3 } });
    await glideScroll(selector, delta, ms);
  }

  async function typeSlowly(text, each = 70) {
    for (const ch of text) {
      await page.keyboard.type(ch);
      await wait(each);
    }
  }

  async function boot(hash, { intro = false } = {}) {
    await page.addInitScript(() => { try { localStorage.setItem('cc.agentLayout', 'office'); } catch {} });
    if (!intro) await page.addInitScript(() => { try { sessionStorage.setItem('cc-intro-at', String(Date.now())); } catch {} });
    await page.goto(`${url}#${hash}`);
    await page.waitForSelector('#intro', { state: 'detached', timeout: 30_000 }).catch(() => {});
    booted = true;
    await wait(300);
  }

  async function ready(hash = 'overview') {
    if (!booted) await boot(hash);
  }

  const clearToasts = () => page.evaluate(() => document.querySelectorAll('#toast, .game-toast, .game-toasts > *').forEach((n) => { n.hidden = true; n.remove?.(); }));
  const skipBegin = () => skips.push([now(), null]);
  const skipEnd = () => { skips.at(-1)[1] = now(); };
  const nav = (name, options) => click(`.rail a[href="#${name}"]`, { pause: 500, ...options });
  const api = (path, body = {}) => page.evaluate(([p, b]) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': TOKEN }, body: JSON.stringify(b) }).then((r) => r.json()), [path, body]);
  const read = (path) => page.evaluate((p) => fetch(`${p}${p.includes('?') ? '&' : '?'}t=${TOKEN}`).then((r) => r.json()), path);
  const byText = (text, scope = page) => scope.getByText(text, { exact: true });
  const button = (name, scope = page) => scope.getByRole('button', { name });

  // Writes a reward into the game's ledger, then asks for a rally to be recorded, which makes the game read the ledger at once.
  async function reward(xp, label) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(Date.now());
    appendFileSync(join(root, 'home/.local/state/underlings/game.jsonl'), `${JSON.stringify({ kind: 'reward', source: 'approval', key: `demo:${label}:${Date.now()}`, at: new Date().toISOString(), day, xp, coins: 0, label })}\n`);
    rallies += 1;
    await api('/api/game/rally', { hits: rallies });
  }

  async function nearLevelUp() {
    const game = await read('/api/game');
    await reward(game.nextAt - game.xp - HEAD_ROOM_XP, 'A long run of work');
  }

  const levelUp = () => reward(HEAD_ROOM_XP + 25, 'An agent finished a run');

  function armMeeting() {
    writeFileSync(join(root, 'next-meeting.json'), JSON.stringify({ startsAt: Date.now() + MEETING_LEAD_MS }));
    return api('/api/calendar/refresh');
  }

  return { page, url, root, skips, skipBegin, skipEnd, clearToasts, at, wait, hold: wait, travel, point, click, drag, dragBetween, glideScroll, scrollOver, typeSlowly, boot, ready, nav, api, read, byText, button, nearLevelUp, levelUp, armMeeting };
}

export const TOUR = { stage: stagehand };

const TAG = (n) => `.office-tag[data-handle="${AGENT_HANDLE(n)}"]`;

export const CLIPS = [
  {
    name: 'hero', file: 'hero', boots: true, width: 1200, fps: 10, colors: 96, lossy: 100, dither: 'none', skip: 1.4, speed: [[0, 4.4, 2.4]],
    async run(s) {
      await s.boot('agents', { intro: true });
      await s.page.waitForSelector('#main canvas', { state: 'visible', timeout: 20_000 });
      await s.hold(500);
      await s.travel({ x: 720, y: 430 }, 300);
      await s.drag(-150, 0, 3000);
      await s.hold(200);
    },
  },
  {
    name: 'agents', file: 'agents',
    async setup(s) {
      await s.ready('agents');
      await s.hold(2500);
    },
    async run(s) {
      await s.click(TAG(8), { ms: 650 });
      await s.page.waitForSelector('#agent-window', { state: 'visible' });
      await s.hold(1700);
      await s.click(s.button('Allow Bash'), { ms: 450 });
      await s.hold(500);
      await s.click(s.button(/Allow Bash for/), { ms: 200, pause: 1500 });
      await s.hold(900);
    },
    async teardown(s) {
      await s.page.locator('#agent-window button[aria-label^="Close"]').first().click().catch(() => {});
    },
  },
  {
    name: 'merge-requests', file: 'merge-requests',
    async run(s) {
      await s.nav('merge-requests', { ms: 300 });
      await s.hold(450);
      await s.click(s.button('Board'), { ms: 300, pause: 450 });
      await s.scrollOver('.mr-board', '.mr-board', { left: 520 }, 650);
      await s.click(s.button('List'), { ms: 300, pause: 300 });
      await s.click(s.byText('6 to post'), { ms: 350, pause: 800 });
      await s.click(s.button(/^Post all 5/), { ms: 400, pause: 350 });
      await s.click(s.button(/^Post 5/), { ms: 150, pause: 1100 });
      await s.hold(300);
    },
  },
  {
    name: 'tickets', file: 'tickets',
    async run(s) {
      await s.nav('tickets', { ms: 300 });
      await s.click(s.button('Board'), { ms: 300, pause: 450 });
      await s.scrollOver('.ticket-board', '.ticket-board', { left: 360 }, 550);
      await s.dragBetween('#ticket-card-ABC-103', '.ticket-board .lane[data-lane="QA"]', 450);
      await s.glideScroll('.ticket-board', { left: 360 }, 250);
      await s.click(s.button(/^Move to QA/), { ms: 300, pause: 350 });
      await s.click(s.button(/^Move ABC-103/), { ms: 120, pause: 650 });
      await s.nav('qa', { ms: 300 });
      await s.hold(1000);
    },
  },
  {
    name: 'slack-email', file: 'slack-email',
    async run(s) {
      await s.nav('email', { ms: 300 });
      await s.hold(450);
      await s.nav('slack', { ms: 300 });
      await s.hold(200);
      await s.click('[id^="slack-more-D0VICTOR001"]', { ms: 400, pause: 900 });
      await s.click(s.button(/^Suggest a reply/), { ms: 350, pause: 1300 });
      await s.hold(200);
      await s.click('.modal-close, [aria-label="Close"]', { ms: 300, pause: 350 });
      await s.click('#main [id^="slack-agent-D0VICTOR001"]', { ms: 350, pause: 1100 });
    },
  },
  {
    name: 'calendar', file: 'calendar', tail: 0.05,
    async run(s) {
      await s.nav('calendar', { ms: 320 });
      await s.armMeeting();
      await s.glideScroll(null, { top: 330 }, 700);
      await s.hold(900);
      await s.api('/api/calendar/overlay', { act: 'calendar' });
      s.skipBegin();
      await s.page.goto(`${s.url}&window=meeting`);
      await s.page.waitForSelector('#meeting-overlay .mo-card', { timeout: 15_000 });
      await s.hold(250);
      s.skipEnd();
      await s.hold(2000);
      await s.click('.mo-join', { ms: 450, pause: 0 });
    },
    async teardown(s) {
      await s.page.goto(`${s.url}#overview`);
      await s.page.waitForSelector('.rail', { timeout: 15_000 });
    },
  },
  {
    name: 'claude-code', file: 'claude-code',
    async run(s) {
      await s.click('.rail button:has-text("Ask Claude"), .rail a:has-text("Ask Claude")', { ms: 400, pause: 300 });
      await s.hold(4300);
      await s.point(s.page.locator('#claude-term').getByText('ABC-113').first(), { ms: 450 }).catch(() => {});
      await s.hold(1100);
    },
    async teardown(s) {
      await s.page.locator('#claude-panel button[aria-label="Close"]').first().click().catch(() => {});
    },
  },
  {
    name: 'game', file: 'game',
    async setup(s) {
      await s.nearLevelUp();
      await s.hold(3800);
    },
    async run(s) {
      await s.nav('game', { ms: 300 });
      await s.hold(500);
      await s.levelUp();
      await s.hold(1600);
      await s.click(s.button('Shop'), { ms: 320, pause: 350 });
      await s.click(s.byText('Wizard hat'), { ms: 350, pause: 550 });
      await s.click(s.button(/^Buy for/), { ms: 300, pause: 250 });
      await s.click(s.button(/^Spend/), { ms: 120, pause: 600 });
      await s.click(s.button('Wardrobe'), { ms: 320, pause: 450 });
      await s.nav('agents', { ms: 320 });
      await s.hold(700);
    },
  },
  {
    name: 'settings', file: 'settings',
    async run(s) {
      await s.nav('settings', { ms: 350 });
      await s.hold(400);
      await s.click('input[placeholder^="Filter by name"]', { ms: 400, pause: 200 });
      await s.typeSlowly('models', 80);
      await s.hold(700);
      await s.click(s.button('Use suggested tiers'), { ms: 450, pause: 450 });
      await s.click(s.button(/Put every task/), { ms: 150, pause: 1100 });
      await s.glideScroll(null, { top: 260 }, 700);
      await s.hold(900);
    },
  },
  {
    name: 'palette', file: 'palette',
    async run(s) {
      await s.nav('overview', { ms: 350 });
      await s.hold(300);
      await s.page.keyboard.press('Meta+k');
      await s.hold(700);
      await s.typeSlowly('mobile', 120);
      await s.hold(900);
      await s.page.keyboard.press('ArrowDown');
      await s.hold(500);
      await s.page.keyboard.press('Enter');
      await s.hold(1500);
    },
    async teardown(s) {
      await s.page.locator('#agent-window button[aria-label^="Close"]').first().click().catch(() => {});
    },
  },
];
