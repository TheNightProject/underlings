import * as artifacts from './artifacts.mjs';
import * as autoloop from './autoloop.mjs';
import * as board from './board.mjs';
import * as calendar from './calendar.mjs';
import * as claudeagents from './claudeagents.mjs';
import * as claudepanel from './claudepanel.mjs';
import * as claudeterm from './claudeterm.mjs';
import * as cleanup from './cleanup.mjs';
import * as decide from './decide.mjs';
import * as email from './email.mjs';
import * as features from './features.mjs';
import * as game from './game.mjs';
import { engine, engineError, failure, forgeCan, forgeFor, inbox, refreshInbox } from './engine.mjs';
import * as locale from './locale.mjs';
import * as matrix from './matrix.mjs';
import * as messageagent from './messageagent.mjs';
import * as models from './models.mjs';
import * as mrdetail from './mrdetail.mjs';
import * as notifier from './notifier.mjs';
import * as ownmr from './ownmr.mjs';
import * as pipeline from './pipeline.mjs';
import * as profile from './profile.mjs';
import * as qa from './qa.mjs';
import { keyParts } from './refs.mjs';
import * as selfheal from './selfheal.mjs';
import * as selfupdate from './selfupdate.mjs';
import * as setup from './setup.mjs';
import * as slack from './slack.mjs';
import * as stats from './stats.mjs';
import * as standup from './standup.mjs';
import * as threads from './threads.mjs';
import * as threadticket from './threadticket.mjs';
import * as tickets from './tickets.mjs';
import * as tidy from './tidy.mjs';
import * as watching from './watching.mjs';
import * as whatsnew from './whatsnew.mjs';
import * as workspaces from './workspaces.mjs';

export const MODULES = { artifacts, autoloop, board, calendar, claudeagents, claudepanel, claudeterm, cleanup, decide, email, features, game, locale, matrix, messageagent, models, mrdetail, notifier, ownmr, pipeline, profile, qa, selfheal, selfupdate, setup, slack, standup, stats, threads, threadticket, tickets, tidy, watching, whatsnew, workspaces };
export const READS_INBOX = new Set(['review', 'approve', 'hold']);

const AGENT = ['agents', 'launch an agent on it from here yet'];
const POST = ['post', 'send anything to it from here yet'];
const OWN = ['ownMr', 'change your own pull request from here yet'];
// What each action asks of the MR's forge, so one a forge cannot do yet is refused before anything is read or written.
const ASKS = {
  review: AGENT, 'review-own': AGENT, fix: AGENT, auto: AGENT, schedule: AGENT,
  'queue-finding': POST, approve: POST, decide: POST, reply: POST, resolve: POST, 'post-all': POST, 'thread-ticket': POST, 'thread-ticket-finish': POST,
  merge: OWN, 'cancel-merge': OWN, ready: OWN, reviewers: OWN, rerequest: OWN,
  hold: ['hold', 'hold a merge'], rebase: ['rebase', 'update a branch from here yet'], 'retry-job': ['retry', 'retry a job from here yet'], 'retry-pipeline': ['retry', 'retry checks from here yet'],
};

export function mergeTables(tables, what) {
  const merged = {};
  const owners = {};
  for (const [owner, table] of Object.entries(tables)) {
    for (const [name, entry] of Object.entries(table ?? {})) {
      if (name in merged) throw new Error(`${what} ${name} is defined by both ${owners[name]} and ${owner}`);
      merged[name] = entry;
      owners[name] = owner;
    }
  }
  return merged;
}

export const ACTIONS = mergeTables(Object.fromEntries(Object.entries(MODULES).map(([name, mod]) => [name, mod.ACTIONS])), 'action');

export async function act(name, payload) {
  if (name === 'refresh') return refreshInbox().then(() => ({ ok: true }));
  const action = ACTIONS[name];
  if (!action) throw failure(404, `unknown action ${name}`);
  if (!engine) throw failure(503, engineError);
  if (READS_INBOX.has(name) && !inbox) throw failure(503, 'the MR list has not loaded yet');
  forgeAllows(name, payload ?? {});
  return perform(action, payload ?? {});
}

// GitLab's actions are never asked about, so an engine built before forges had flags acts as it always did.
function forgeAllows(name, { key }) {
  const ref = keyParts(key);
  if (!ASKS[name] || ref?.provider !== 'github') return;
  forgeCan(forgeFor(ref), ...ASKS[name]);
}

// An action is a function, or { verify, run }: verify re-reads live state and calls still(), and run writes only if it passed.
export async function perform(action, payload) {
  const { verify, run } = typeof action === 'function' ? { run: action } : action;
  const live = verify ? await verify(payload) : undefined;
  const text = await run(payload, live);
  mrdetail.invalidate(payload.key);
  refreshInbox();
  return { ok: true, text };
}
