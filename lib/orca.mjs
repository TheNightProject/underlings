// Only the plugin calls this, to show its own page in an Orca tab and to mark a banner Orca refused; the app has its own window.
import { run } from './run.mjs';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';

export async function orca(config, args) {
  const profile = config.orcaUserDataPath || process.env.ORCA_USER_DATA_PATH;
  const env = profile ? { ...process.env, ORCA_USER_DATA_PATH: profile } : process.env;
  const reply = await run(ORCA, [...args, '--json'], env).then(JSON.parse, refusal);
  if (!reply.ok) throw new Error(reply.error?.message ?? reply.error?.code ?? 'orca call failed');
  return reply.result;
}

// A refused call exits 1 and puts its reason in the JSON on stdout, leaving stderr empty.
function refusal(err) {
  const reply = parseJson(err.stdout);
  if (reply?.ok === false) return reply;
  throw err;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A tab created without a worktree lands wherever Orca resolves "current", which from a worker is nowhere useful.
export async function openInOrca(config, url, { root, focus = false } = {}) {
  const tabs = await orca(config, ['tab', 'list']).then((r) => r.tabs ?? []).catch(() => []);
  const existing = tabs.find((t) => t.url?.split('?')[0] === url.split('?')[0]);
  const created = existing ? null : await orca(config, ['tab', 'create', '--url', url, ...(root ? ['--worktree', `path:${root}`] : [])]);
  const page = existing?.browserPageId ?? created?.browserPageId;
  if (focus && page) await orca(config, ['tab', 'switch', '--page', page, '--focus']);
  return { ok: true, reused: Boolean(existing) };
}
