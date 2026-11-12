#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contactSheet, duration, toGif, toMp4 } from './encode.mjs';
import { CLIPS, TOUR } from './tour.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const REPO = resolve(HERE, '../..');
const VIEWPORT = { width: 1200, height: 750 };
const GPU_FLAGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const TAIL_S = 0.4;
const THEMES = ['dark', 'light'];

function options() {
  const argv = process.argv.slice(2);
  const value = (flag, fallback) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : fallback);
  const only = value('--clip', '').split(',').filter(Boolean);
  const theme = value('--theme', 'dark');
  if (!THEMES.includes(theme)) throw new Error(`--theme is ${THEMES.join(' or ')}, not ${theme}`);
  return {
    only, theme, out: resolve(value('--out', join(REPO, 'docs/media'))), work: resolve(value('--work', join(process.env.TMPDIR || tmpdir(), 'underlings-capture'))),
    encodeOnly: argv.includes('--encode-only'), tour: only.length === 0 || argv.includes('--tour'),
  };
}

async function loadPlaywright() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    throw new Error('playwright-core is missing: run npm --prefix scripts/demo install, then npx --prefix scripts/demo playwright-core install chromium');
  }
}

function startServer(root) {
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', join(HERE, 'serve.mjs')], { env: { ...process.env, DEMO_ROOT: root }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolveUrl, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const url = /DEMO_URL (\S+)/.exec(text)?.[1];
      if (url) resolveUrl({ url, child });
    });
    child.once('exit', (code) => reject(new Error(`the demo server stopped with code ${code}`)));
  });
}

async function assertScheme(page, theme) {
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  if (scheme !== theme) throw new Error(`the page rendered ${scheme}, not ${theme}`);
}

async function record(chromium, { url, root, only, work, theme }) {
  const video = join(work, 'video');
  rmSync(video, { recursive: true, force: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: GPU_FLAGS });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: theme, recordVideo: { dir: video, size: VIEWPORT } });
  await context.addInitScript({ path: join(HERE, 'inject.js') });
  const page = await context.newPage();
  const started = Date.now();
  const marks = [];
  const now = () => (Date.now() - started) / 1000;
  const stage = TOUR.stage({ page, url, root, now });
  const mark = async (clip, run) => {
    const from = now();
    stage.skips.length = 0;
    await run();
    marks.push({ name: clip.name, from, to: now() + (clip.tail ?? TAIL_S), drops: stage.skips.map(([a, b]) => [a - from, b - from]) });
  };
  try {
    for (const clip of CLIPS.filter((c) => only.length === 0 || only.includes(c.name))) {
      process.stdout.write(`recording ${clip.name}\n`);
      if (!clip.boots) await stage.ready();
      await clip.setup?.(stage);
      if (!clip.boots) await stage.clearToasts();
      await mark(clip, () => clip.run(stage));
      await clip.teardown?.(stage);
      await assertScheme(page, theme);
    }
  } catch (err) {
    await page.screenshot({ path: join(work, 'failure.png') }).catch(() => {});
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
  const raw = join(work, 'tour.webm');
  renameSync(join(video, readdirSync(video).find((n) => n.endsWith('.webm'))), raw);
  writeFileSync(join(work, 'marks.json'), JSON.stringify(marks, null, 2));
  return marks;
}

function encode({ marks, work, out, tour }) {
  const raw = join(work, 'tour.webm');
  const contact = join(work, 'contact');
  mkdirSync(out, { recursive: true });
  mkdirSync(contact, { recursive: true });
  const made = [];
  for (const m of marks) {
    const clip = CLIPS.find((c) => c.name === m.name);
    const gif = join(out, `${clip.file}.gif`);
    const size = toGif(raw, { from: m.from + (clip.skip ?? 0), to: m.to, width: clip.width ?? 960, fps: clip.fps ?? 12, lossy: clip.lossy, colors: clip.colors, speed: clip.speed, drops: m.drops, dither: clip.dither, out: gif });
    contactSheet(gif, { out: join(contact, `${clip.file}.png`) });
    made.push({ file: `${clip.file}.gif`, bytes: size, seconds: +duration(gif).toFixed(1), sheet: join(contact, `${clip.file}.png`) });
  }
  if (tour) made.push({ file: 'tour.mp4', bytes: toMp4(raw, { from: marks[0].from, to: marks.at(-1).to, out: join(out, 'tour.mp4') }) });
  return made;
}

async function main() {
  const opts = options();
  mkdirSync(opts.work, { recursive: true });
  let marks;
  if (opts.encodeOnly) marks = JSON.parse(readFileSync(join(opts.work, 'marks.json'), 'utf8'));
  else {
    const chromium = await loadPlaywright();
    const root = mkdtempSync(join(opts.work, 'world-'));
    const { url, child } = await startServer(root);
    try {
      marks = await record(chromium, { url, root, only: opts.only, work: opts.work, theme: opts.theme });
    } finally {
      child.kill('SIGTERM');
    }
  }
  for (const m of encode({ marks, work: opts.work, out: opts.out, tour: opts.tour })) process.stdout.write(`${m.file}\t${(m.bytes / 1e6).toFixed(2)} MB\t${m.seconds ?? ''}s\t${m.sheet ?? ''}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
