import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_HANDLE, demoAgents } from './world-agents.mjs';
import { CALENDAR_ADDRESS } from './world-calendar.mjs';
import { demoLedger } from './world-game.mjs';
import { jiraWorld } from './world-jira.mjs';
import { WORKSPACE_REPOS } from './world-gitlab.mjs';
import { demoQueue } from './world-queue.mjs';

const WORKFLOW = 'To Do, Triaged, Ready for Dev, In Design, In Progress, Blocked, Peer Review, Design QA, QA, Release Ready, Ready to Ship - Staging, Ready to Ship - Live, Done, Not Required';

const write = (dir, name, value) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};

function runsFor(at) {
  const run = (key, iid, status, minutesAgo, path, n, extra = {}) => ({
    key, webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`, startedAt: new Date(at - minutesAgo * 60_000).toISOString(), status, tail: [], terminal: AGENT_HANDLE(n), ...extra,
  });
  return Object.fromEntries([
    run('acme/engine!7', 7, 'working', 9, 'acme/engine', 1),
    run('acme/api!41', 41, 'working', 18, 'acme/api', 5),
    run('acme/mobile!15', 15, 'working', 16, 'acme/mobile', 6),
    run('acme/web!30', 30, 'done', 45, 'acme/web', 10),
    run('fix:acme/web!22', 22, 'running', 14, 'acme/web', 2),
    run('fix:acme/tools/cli!3', 3, 'running', 70, 'acme/tools/cli', 8),
  ].map((r) => [r.key, r]));
}

export function seedWorld({ root, home, stateDir, runnerPid, now = Date.now() }) {
  const config = join(home, '.config/underlings');
  const state = join(home, '.local/state/underlings');
  const ws = join(root, 'ws');
  for (const [dir, origin] of WORKSPACE_REPOS) write(join(ws, dir, '.git'), 'config', `[remote "origin"]\n\turl = git@gitlab.com:${origin}.git\n`);

  write(config, 'config.json', { port: 0 });
  write(config, 'setup.json', { doneAt: new Date(now).toISOString() });
  write(config, 'locale.json', { locale: { timeZone: 'Europe/London', region: 'en-GB', clock: '24' }, hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] } });
  write(config, 'features.json', { tickets: true, standup: true, qa: true, calendar: true, leaderboard: true, artifacts: true });
  write(config, 'qa.json', { jql: 'project = ABC AND status = QA', group: 'acme' });
  write(config, 'game.json', { on: true, toasts: true });
  write(config, 'email.json', { enabled: true });
  write(config, 'slack.json', { enabled: true });
  write(config, 'standup.json', { calendarAddress: CALENDAR_ADDRESS });
  write(config, 'profile.json', { user: { name: 'Frank', askedAt: new Date(now).toISOString() }, style: { language: 'British English', rules: 'No em dashes.' } });

  write(stateDir, 'state.json', {
    watches: {}, seen: {}, verdicts: {},
    settings: { workspaceRoot: ws, jiraSite: 'acme.atlassian.net', pollSeconds: 600, agentPermissions: 'ask', maxAgents: 20, reReviewOnChange: true, jira: { projects: 'ABC', defaultProject: 'ABC', statuses: WORKFLOW, doneStatuses: 'Done', issueType: 'Task' } },
  });
  write(stateDir, 'queue.json', demoQueue(now));
  write(stateDir, 'runs.json', runsFor(now));
  write(state, 'game.jsonl', demoLedger(now).map((e) => JSON.stringify(e)).join('\n') + '\n');

  for (const agent of demoAgents(now)) {
    const dir = join(stateDir, 'agents', agent.id);
    write(dir, 'agent.json', agent.file);
    write(dir, 'events.jsonl', agent.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (agent.alive) write(dir, 'runner.lock', String(runnerPid));
  }

  const jira = join(root, 'jira.json');
  write(root, 'jira.json', jiraWorld());
  return { jira, workspace: ws };
}
