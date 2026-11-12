#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.DEMO_JIRA_FILE;
const args = process.argv.slice(2);
const said = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const jira = () => JSON.parse(readFileSync(file, 'utf8'));
const issue = (t) => ({ key: t.key, fields: { summary: t.summary, status: { name: t.status }, labels: t.labels ?? [], assignee: t.assignee ? { displayName: t.assignee } : null, issuetype: { name: t.type ?? 'Task', hierarchyLevel: 0 } } });

function search(world, jql) {
  const keys = /key in \(([^)]*)\)/.exec(jql);
  if (keys) return world.tickets.filter((t) => keys[1].split(',').map((k) => k.trim()).includes(t.key));
  const after = /status CHANGED TO "[^"]+" AFTER startOfDay\(-(\d+)\)/.exec(jql);
  if (after) return world.tickets.filter((t) => t.status === 'QA' && t.daysInQa <= Number(after[1]) + 1);
  if (/status CHANGED/.test(jql)) return [];
  const parent = /parent = (\S+)/.exec(jql);
  if (parent) return world.tickets.filter((t) => t.epic === parent[1]);
  if (/status = "?QA"?/.test(jql)) return world.tickets.filter((t) => t.status === 'QA');
  if (/assignee = currentUser\(\)/.test(jql)) return world.tickets.filter((t) => t.assignee === world.me && !world.done.includes(t.status));
  return [];
}

function view(world, key) {
  const t = world.tickets.find((x) => x.key === key);
  if (!t) return { key, fields: { summary: '', status: { name: 'Unknown' } } };
  const epic = world.epics.find((e) => e.key === t.epic);
  return {
    ...issue(t),
    fields: { ...issue(t).fields, description: t.description ?? `What ${key} asks for.`, parent: epic ? { key: epic.key, fields: { summary: epic.summary, issuetype: { name: 'Epic', hierarchyLevel: 1 } } } : undefined },
  };
}

const [, noun, verb] = args;
if (noun === 'auth') said('Authenticated');
else if (verb === 'search') said(search(jira(), args[args.indexOf('--jql') + 1]).map(issue));
else if (verb === 'view') said(view(jira(), args[3]));
else if (verb === 'transition') {
  const world = jira();
  const t = world.tickets.find((x) => x.key === args[args.indexOf('--key') + 1]);
  if (t) Object.assign(t, { status: args[args.indexOf('--status') + 1], daysInQa: 0 });
  writeFileSync(file, JSON.stringify(world));
  said('Transitioned');
} else {
  process.stderr.write(`acli ${args.join(' ')} is not answered by the demo\n`);
  process.exit(1);
}
