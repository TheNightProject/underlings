import { GITLAB_KEY_TEXT, keyOf, keyParts, keysInText, mrUrl } from './refs.mjs';

export const GROUPS = ['New', 'Fixed', 'Changed', 'Look and feel'];
export const HEADLINE = ['New', 'Fixed'];
export const LOG_FORMAT = '%H%x1f%cs%x1f%B%x1e';
const GITLAB = 'https://gitlab.com';
const SHOWN = {
  '✨': 'New', '🎉': 'New',
  '🐛': 'Fixed', '🚑': 'Fixed', '🩹': 'Fixed', '🔒': 'Fixed',
  '♻': 'Changed', '🔓': 'Changed', '🚚': 'Changed', '⚡': 'Changed', '🔧': 'Changed', '📦': 'Changed', '⬆': 'Changed', '⬇': 'Changed', '➕': 'Changed', '➖': 'Changed', '🗑': 'Changed',
  '💄': 'Look and feel', '🍱': 'Look and feel', '🚸': 'Look and feel', '💫': 'Look and feel', '♿': 'Look and feel',
};
const LEFT_OUT = new Set(['✅', '🧪', '📝', '💡', '🎨', '🔥', '🧹', '🚨', '✏', '🔀', '🔖', '👷', '💚', '🙈', '🏷', '🤡', '🌱', '🧱']);
const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u;
const MR_LINE = new RegExp(`^See merge request (${GITLAB_KEY_TEXT})\\s*$`, 'm');
const PULL_MERGE = /^Merge pull request #(\d+) from \S+/;
const PULL_SQUASH = /^(.*\S)\s+\(#(\d+)\)\s*$/;
const TICKET = /\s*[([]\s*[A-Z][A-Z0-9]+-\d+\s*[)\]]\s*/g;
const BARE_TICKET = /^[A-Z][A-Z0-9]+-\d+:?\s+/;
const SECTION = /^## (\d+\.\d+\.\d+)(?: \((\d{4}-\d{2}-\d{2})\))?\s*$/;
const GROUP = /^### (.+?)\s*$/;
const URL_REMOTE = /^(https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(:\d+)?\/(\S+?)(?:\.git)?\/?$/;
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(\S+?)(?:\.git)?\/?$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseLog(text) {
  return String(text ?? '').split('\x1e').map((record) => record.replace(/^\n/, '')).filter((record) => record.trim()).map((record) => {
    const [sha, date, message = ''] = record.split('\x1f');
    return { sha, date, message: message.trimEnd() };
  });
}

export function entryOf({ sha = null, date = null, message = '' }, remote = null) {
  const lines = message.split('\n');
  const { raw, mr } = (remote?.github ? pullRequest(lines, remote) : null) ?? mergeRequest(message, lines, remote);
  const emoji = LEADING_EMOJI.exec(raw)?.[1] ?? null;
  const known = emoji ? emoji.replace(/\uFE0F/g, '') : null;
  const group = LEFT_OUT.has(known) ? null : SHOWN[known] ?? 'Changed';
  return { sha, date, emoji, title: cleanTitle(raw), group, guessed: group === 'Changed' && !(known in SHOWN), mr };
}

// A GitLab merge commit says "Merge branch 'x' into 'main'" first and the MR's own title on its third line.
function mergeRequest(message, lines, remote) {
  const ref = MR_LINE.exec(message);
  const merged = Boolean(ref) && /^Merge branch /.test(lines[0]);
  const raw = (merged ? lines.slice(1).find((line) => line.trim() && !MR_LINE.test(line)) : null) ?? lines[0] ?? '';
  if (!ref) return { raw, mr: null };
  const web = remote && !remote.github ? remote.web : GITLAB;
  const { projectPath, iid } = keyParts(ref[1]);
  return { raw, mr: { project: projectPath, iid, ref: ref[1], url: mrUrl({ projectPath, iid }, web) } };
}

function pullRequest(lines, remote) {
  const merge = PULL_MERGE.exec(lines[0]);
  const squash = merge ? null : PULL_SQUASH.exec(lines[0]);
  if (!merge && !squash) return null;
  const iid = Number(merge ? merge[1] : squash[2]);
  const raw = merge ? lines.slice(1).find((line) => line.trim()) ?? lines[0] : squash[1];
  const pull = { provider: 'github', projectPath: remote.path, iid };
  return { raw, mr: { project: remote.path, iid, ref: keyOf(pull), url: mrUrl(pull, remote.web) } };
}

// ssh and scp-style remotes are taken to be served over https on the same host.
export function parseRemote(url) {
  const text = String(url ?? '').trim();
  const full = URL_REMOTE.exec(text);
  const scp = full ? null : SCP_REMOTE.exec(text);
  if (!full && !scp) return null;
  const [host, path] = full ? [full[2], full[4]] : [scp[1], scp[2]];
  const web = full && full[1].startsWith('http') ? `${full[1]}://${host}${full[3] ?? ''}` : `https://${host}`;
  return { web, host, path, github: host === 'github.com' };
}

function cleanTitle(raw) {
  return raw.replace(LEADING_EMOJI, '').replace(TICKET, ' ').replace(BARE_TICKET, '').replaceAll('[', '(').replaceAll(']', ')').replace(/\s+/g, ' ').trim();
}

export function draft(commits, remote = null) {
  const groups = Object.fromEntries(GROUPS.map((name) => [name, []]));
  const leftOut = [];
  for (const entry of commits.map((commit) => entryOf(commit, remote))) (entry.group ? groups[entry.group] : leftOut).push(entry);
  return { groups, leftOut, guessed: GROUPS.flatMap((name) => groups[name]).filter((entry) => entry.guessed) };
}

export function lineOf(entry) {
  return entry.mr ? `[${entry.title}](${entry.mr.url})` : entry.title;
}

export function groupLines({ groups }) {
  return Object.fromEntries(GROUPS.map((name) => [name, groups[name].map(lineOf)]));
}

export function renderSection({ version, date, groups }) {
  const parts = GROUPS.filter((name) => groups[name].length).map((name) => `### ${name}\n\n${groups[name].map((entry) => `- ${lineOf(entry)}`).join('\n')}`);
  return [`## ${version} (${date})`, ...(parts.length ? parts : ['Nothing you would notice: tests, docs and tidying only.'])].join('\n\n') + '\n';
}

export function insertSection(changelog, section) {
  const text = String(changelog ?? '');
  const at = text.search(/^## /m);
  if (at < 0) return text.trimEnd() + '\n\n' + section;
  return text.slice(0, at) + section + '\n' + text.slice(at);
}

export function parseChangelog(text) {
  const sections = [];
  const intro = [];
  let group = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const heading = SECTION.exec(line);
    if (heading) {
      sections.push({ version: heading[1], date: heading[2] ?? null, body: [], groups: {} });
      group = null;
      continue;
    }
    const section = sections.at(-1);
    if (!section) {
      intro.push(line);
      continue;
    }
    section.body.push(line);
    const named = GROUP.exec(line);
    if (named) group = section.groups[named[1]] = [];
    else if (group && /^- /.test(line)) group.push(line.slice(2).trim());
  }
  return { intro: intro.join('\n').trim(), sections: sections.map((s) => ({ ...s, body: s.body.join('\n').trim() })) };
}

export function listedMrs(changelog) {
  return new Set(keysInText(String(changelog ?? '')));
}

export function isVersion(value) {
  return typeof value === 'string' && VERSION.test(value);
}

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => (VERSION.exec(v ?? '') ?? [null, 0, 0, 0]).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function bump(version, part = 'patch') {
  const m = VERSION.exec(version ?? '');
  if (!m) throw new Error(`${version} is not a version such as 1.2.3`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  if (part === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`${part} is not patch, minor or major`);
}

export function linesSince(sections, seen, current) {
  const newer = sections.filter((s) => compareVersions(s.version, seen ?? '0.0.0') > 0 && compareVersions(s.version, current) <= 0);
  const names = [...new Set([...GROUPS, ...newer.flatMap((s) => Object.keys(s.groups))])];
  return Object.fromEntries(names.map((name) => [name, newer.flatMap((s) => s.groups[name] ?? [])]));
}
