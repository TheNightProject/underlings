import { basename } from 'node:path';
import { promisify } from 'node:util';

export function fakeChildProcess(world, calls = []) {
  function execFile(cmd, args = [], options, done) {
    const callback = typeof options === 'function' ? options : done;
    calls.push([basename(cmd), ...args]);
    const answer = (err, stdout = '') => setImmediate(() => callback?.(err ? Object.assign(err, { stdout, stderr: '' }) : null, stdout, ''));
    try {
      answer(null, run(basename(cmd), args));
    } catch (err) {
      answer(err);
    }
    return idleChild();
  }

  execFile[promisify.custom] = (cmd, args, options) => new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });

  function run(cmd, args) {
    if (cmd === 'git') return '';
    if (cmd === 'acli') return acli(world.jira, args);
    throw Object.assign(new Error(`${cmd} is not run in the baseline session`), { code: 'ENOENT' });
  }

  function spawn(cmd, args = []) {
    calls.push([basename(cmd), ...args]);
    return idleChild();
  }

  const refuse = (cmd) => {
    throw new Error(`${cmd} is not run in the baseline session`);
  };

  return { execFile, spawn, execFileSync: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, fork: refuse };
}

function idleChild() {
  const child = { pid: undefined, stdout: null, stderr: null, on: () => child, once: () => child, unref() {}, kill: () => false };
  child.stdin = { on: () => child.stdin, end() {}, write() {} };
  return child;
}

function acli(jira, args) {
  const [, noun, verb] = args;
  if (noun === 'auth') return 'Authenticated';
  if (verb === 'view') return JSON.stringify(view(jira, args[3]));
  if (verb === 'transition') return 'Transitioned';
  if (verb === 'search') return JSON.stringify(search(jira, args[args.indexOf('--jql') + 1]));
  throw new Error(`acli ${args.join(' ')} is not answered in the baseline session`);
}

function search(jira, jql) {
  const all = [...jira.mine, ...jira.qa];
  const keys = /key in \(([^)]*)\)/.exec(jql);
  if (keys) return all.filter((t) => keys[1].split(',').includes(t.key));
  const after = /status CHANGED TO "[^"]+" AFTER startOfDay\(-(\d+)\)/.exec(jql);
  if (after) return jira.qa.filter((t) => jira.movedToQa[t.key] <= Number(after[1]) + 1).map(({ key, fields }) => ({ key, fields: { status: fields.status } }));
  const during = /status CHANGED TO "([^"]+)" DURING \("(\d{4}-\d{2}-\d{2})/.exec(jql);
  if (during) return (jira.movedOn[during[2]]?.[during[1]] ?? []).map((key) => all.find((t) => t.key === key));
  if (/status = QA/.test(jql)) return jira.qa;
  if (/statusCategory = "In Progress"/.test(jql)) return jira.mine.filter((t) => t.fields.status.name === 'In Progress');
  if (/assignee = currentUser\(\)/.test(jql)) return jira.mine;
  return [];
}

function view(jira, key) {
  const found = [...jira.mine, ...jira.qa].find((t) => t.key === key);
  return found ? { ...found, fields: { ...found.fields, description: `What ${key} asks for.` } } : { key, fields: { summary: '', status: { name: 'Unknown' } } };
}
