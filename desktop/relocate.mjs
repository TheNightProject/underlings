import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

export const REPLACED = '--replaced=';
export const STAY = '--stay';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const run = (cmd, args) => promisify(execFile)(cmd, args).then(({ stdout }) => stdout);

export const bundleOf = (execPath) => /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;

// An update from before the rename installs this build under the old name, so it is moved to its own, beside it.
export function moveFor({ bundle, appName, oldName, argv = [] }) {
  if (!bundle || argv.includes(STAY) || basename(bundle) !== `${oldName}.app`) return null;
  return { from: bundle, to: join(dirname(bundle), `${appName}.app`) };
}

// Started hidden, or on a folder of its own, the copy it opens is started the same way.
const KEPT = /^--(?:hidden|user-data-dir=.+)$/;
export const keptSwitches = (argv) => argv.filter((arg) => KEPT.test(arg));

// The running copy cannot replace itself, so the helper waits for it to quit, copies it across and opens the copy, or this one again if that failed.
export function moveJob({ from, to }, { pid, result, argv = [] }) {
  const kept = keptSwitches(argv);
  return { pid, built: from, bundle: to, result, relaunch: ['/usr/bin/open', to, '--args', `${REPLACED}${from}`, ...kept], fallback: ['/usr/bin/open', from, '--args', STAY, ...kept] };
}

export const replacedBy = (argv) => argv.find((arg) => arg.startsWith(REPLACED))?.slice(REPLACED.length) ?? null;

// Only the bundle this run was moved from goes, and only while it still carries the old name.
export async function tidyAfterMove({ argv, bundle, oldName, appName, appId, dock = dockTiles() }) {
  const old = replacedBy(argv);
  if (!old || old === bundle || basename(old) !== `${oldName}.app` || !existsSync(old)) return null;
  await rm(old, { recursive: true, force: true });
  const tiles = await dock.replace(old, bundle, { label: appName, id: appId }).catch(() => 0);
  return { removed: old, tiles };
}

const fileUrl = (path) => `file://${encodeURI(path)}/`;
const pathOf = (url) => decodeURI(String(url).replace(/^file:\/\//, '')).replace(/\/$/, '');

// A tile in the Dock names its app by path, so a tile for the old bundle is pointed at the new one, where it was.
export function dockTiles({ exec = run, tmp = tmpdir(), restart = () => exec('/usr/bin/killall', ['Dock']) } = {}) {
  const buddy = (file, command) => exec(PLIST_BUDDY, ['-c', command, file]);
  return {
    async replace(from, to, app) {
      const file = join(tmp, `dock-${process.pid}.plist`);
      await exec('/usr/bin/defaults', ['export', 'com.apple.dock', file]);
      try {
        const tiles = (await tileUrls(buddy, file)).flatMap((url, i) => (url !== null && pathOf(url) === from ? [i] : []));
        for (const i of tiles) await pointTile(buddy, file, `:persistent-apps:${i}:tile-data`, to, app);
        if (tiles.length) {
          await exec('/usr/bin/defaults', ['import', 'com.apple.dock', file]);
          await restart();
        }
        return tiles.length;
      } finally {
        await rm(file, { force: true });
      }
    },
  };
}

// A spacer has no file, so it reads as null and the walk goes on past it to the end of the list.
async function tileUrls(buddy, file) {
  const urls = [];
  for (let i = 0; await buddy(file, `Print :persistent-apps:${i}`).then(() => true, () => false); i += 1) {
    urls.push(await buddy(file, `Print :persistent-apps:${i}:tile-data:file-data:_CFURLString`).then((url) => url.trim(), () => null));
  }
  return urls;
}

async function pointTile(buddy, file, tile, to, { label, id }) {
  await buddy(file, `Set ${tile}:file-data:_CFURLString ${fileUrl(to)}`);
  await buddy(file, `Set ${tile}:file-label ${label}`).catch(() => buddy(file, `Add ${tile}:file-label string ${label}`));
  await buddy(file, `Set ${tile}:bundle-identifier ${id}`).catch(() => buddy(file, `Add ${tile}:bundle-identifier string ${id}`));
  await buddy(file, `Delete ${tile}:book`).catch(() => {});
}
