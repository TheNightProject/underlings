// A whole worker in a process of its own, for tests that need two drivers or a real engine: Orca and GitLab are faked, everything else is real.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mock } from 'node:test';
import { promisify } from 'node:util';
import { mrUrl } from './refs.mjs';

const FAKE = process.env.UNDERLINGS_FAKE;
const WRITES = process.env.UNDERLINGS_WRITES;
const PROJECT = { id: 'gid://gitlab/Project/1001', fullPath: 'acme/engine', name: 'engine' };
const ORCA_READS = new Set(['worktree ps', 'worktree list', 'terminal list', 'terminal read', 'tab list']);
const created = [];

const fake = () => JSON.parse(readFileSync(FAKE, 'utf8'));
const wrote = (what) => appendFileSync(WRITES, `${process.pid} ${what}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function execFile(cmd, args, options, done) {
  const callback = typeof options === 'function' ? options : done;
  const answer = (err, stdout = '') => setImmediate(() => callback(err ? Object.assign(err, { stdout }) : null, stdout, ''));
  if (cmd === 'orca' || cmd.endsWith('/orca')) return orca(args, answer);
  return answer(Object.assign(new Error(`${cmd} is not run in this test`), { code: 127 }));
}

execFile[promisify.custom] = (cmd, args, options) => new Promise((resolve, reject) => {
  execFile(cmd, args, options, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
});

function orca(args, answer) {
  const verb = args.slice(0, 2).join(' ');
  wrote(`${ORCA_READS.has(verb) ? 'orca-read' : 'orca'} ${verb}`);
  if (verb === 'terminal list' && fake().orcaListFails) return answer(Object.assign(new Error('orca terminal list failed: Orca is not running'), { code: 1 }));
  return answer(null, JSON.stringify({ id: 'x', ok: true, result: orcaResult(verb) }));
}

function orcaResult(verb) {
  if (verb === 'worktree list') return { worktrees: [{ id: 'repo-1::/ws-root', displayName: 'ws-root', path: '/ws-root', branch: '', isMainWorktree: true }] };
  if (verb === 'worktree ps') return { worktrees: [] };
  // What it launched stays listed, titled with the spinner Orca shows while an agent works, as a real launch would be.
  if (verb === 'terminal list') return { terminals: created.map((handle) => ({ handle, title: '⠋ Claude Code', agentIdentity: 'claude', connected: true })) };
  if (verb === 'terminal read') return { terminal: { status: 'running', tail: [] } };
  if (verb === 'tab list') return { tabs: [] };
  if (verb === 'worktree create') {
    created.push(`term-${process.pid}-${created.length + 1}`);
    return { agentTerminalHandle: created.at(-1), worktree: { path: `/ws-root/review-${created.length}` } };
  }
  return { browserPageId: 'page-1' };
}

mock.module('node:child_process', { namedExports: { execFile, spawn } });

function mrNode(mr) {
  return {
    iid: String(mr.iid), title: mr.title ?? `MR ${mr.iid}`, webUrl: mrUrl({ projectPath: PROJECT.fullPath, iid: mr.iid }, fake().gitlabHost ?? 'https://gitlab.com'), draft: false, conflicts: false,
    userNotesCount: 0, state: mr.state ?? 'opened', resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z', diffHeadSha: mr.sha ?? 'head-1', sourceBranch: 'fix/thing', detailedMergeStatus: 'NOT_APPROVED',
    author: { username: mr.author ?? 'heidi' }, reviewers: { nodes: [{ username: 'frank' }] }, approvedBy: { nodes: [] }, headPipeline: { status: 'SUCCESS' },
  };
}

function project(paths, iid) {
  const mrs = (fake().mrs ?? []).filter((mr) => iid === undefined || String(mr.iid) === String(iid));
  return Object.fromEntries(paths.map((path, n) => [`p${n}`, path === PROJECT.fullPath ? { ...PROJECT, mergeRequests: { count: mrs.length, nodes: mrs.map(mrNode) } } : null]));
}

function graphql({ query, variables }) {
  if (/^\s*mutation\b/.test(query)) {
    wrote(`gitlab mutation ${query.slice(0, 40)}`);
    return { errors: [{ message: 'mutations are not answered in this test' }] };
  }
  if (/query One\b/.test(query)) return { data: project([variables.f], variables.iid) };
  if (/query Mrs\b/.test(query)) return { data: project(Object.keys(variables).sort().map((k) => variables[k])) };
  return { data: {} };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.pathname === '/api/graphql') return Response.json(graphql(JSON.parse(init.body)));
  const path = url.pathname.replace(/^\/api\/v4/, '');
  if (method !== 'GET') {
    const said = JSON.parse(init.body ?? '{}').body?.split('\n')[0] ?? '';
    wrote(`gitlab ${method} ${path} ${said}`.trim());
    await sleep(fake().postDelayMs ?? 0);
    while (fake().holdPosts?.some((held) => said.includes(held))) await sleep(50);
    return Response.json({ id: `d-${Math.random().toString(36).slice(2)}` });
  }
  if (path === '/user') return Response.json({ username: 'frank' });
  return Response.json([]);
};

const worker = await import('../worker.mjs');
await worker.default({
  log: (text) => console.log(`[log] ${text}`),
  commands: { register() {} },
  host: { call: async () => [] },
});
console.log(`[pid] ${process.pid}`);

for await (const line of createInterface({ input: process.stdin })) {
  if (line !== 'deactivate') continue;
  await worker.deactivate();
  console.log('[deactivated]');
  process.exit(0);
}
