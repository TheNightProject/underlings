import { DEFAULT, freshModels } from '../../lib/modeltiers.mjs';
import { APP_NAME } from '../../lib/product.mjs';
import type { RepoSpec } from './config.js';
import { projectList } from './ticketkeys.js';
import { ATTRIBUTION, AUTO_FOOTER, HOLD_NOTE } from './wording.js';
import { DEFAULT_WEIGHTS, formatWeights } from './leaderboard.js';

export interface Settings {
  /**
   * Comma separated patterns matched against the repo path, `*` wildcards allowed, a
   * leading `!` excluding. Empty means every repo discovered.
   */
  repoFilter: string;
  /** Place a reviewer's change-request while a review runs, so nobody merges under it. */
  holdWhileReviewing: boolean;
  /** Remove the review agent once you have approved or requested changes. */
  closeWorkspaceWhenDone: boolean;
  /** Each MR you review from now on is re-reviewed when it changes. Its findings still wait for you. */
  reReviewOnChange: boolean;
  /** Colour the whole row by what it needs from you, not just its left edge. */
  rowTint: boolean;
  mouse: boolean;
  pollSeconds: number;
  /** Atlassian host for the ticket pane, e.g. `acme.atlassian.net`. Blank disables it. */
  jiraSite: string;
  /** The folder agents start in, beside the repos. Blank means ORCA_WORKSPACE_ROOT, then wherever the tool was started. */
  workspaceRoot: string;
  /** Days the leaderboard looks back. Longer costs more requests to build. */
  leaderboardDays: number;
  /** Board points, as `opened/reviewed/comments/approved`. */
  pointWeights: string;
  /** `username:level`, comma separated, written by the people picker. Levels are shadow, comments and verdict. */
  fullAuto: string;
  autoHoldSeconds: number;
  autoMaxComments: number;
  autoMaxDiffLines: number;
  autoSensitivePaths: string;
  autoFooter: boolean;
  /** The kill switch. Not a row: `!` flips it from anywhere. */
  autoPaused: boolean;
  agentHost: 'orca' | 'claude';
  /** auto lets Claude Code's auto mode approve what it judges safe; ask sends every action your allow list misses to you. */
  agentPermissions: 'auto' | 'ask';
  /** Blank means the built-in prompt; anything else is a slash command or prompt your own Claude Code knows. */
  agents: AgentCommands;
  /** Background Claude Code agents running at once; 0 is no limit. */
  maxAgents: number;
  /** Dollars, as Claude Code's --max-budget-usd takes them, for each review, fix or kickoff run. Blank is none. */
  agentBudgetUsd: string;
  /** Blank posts the default, as a hold with no reason is one the author cannot act on. */
  holdNote: string;
  /** Blank posts none. */
  postedFooter: string;
  autoFooterText: string;
  jira: JiraSettings;
  gitlab: GitlabSettings;
  github: GithubSettings;
  tickets: TicketSettings;
  /** The model and effort each kind of task starts on, by task. */
  models: ModelSettings;
  /** The effort every task whose own effort is `same` starts on. */
  everyEffort: string;
}

export interface ModelChoice {
  model: string;
  effort: string;
  /** Builders only: the model applies to a subagent that names its own too. */
  force?: boolean;
}

export type ModelSettings = Record<string, ModelChoice>;

/** Lists are comma separated text, as the page and the terminal both edit them as one line. */
export interface JiraSettings {
  /** Blank means your tickets from any project. */
  projects: string;
  defaultProject: string;
  /** Offered as moves beside every status seen on your tickets, while acli cannot list a ticket's transitions. */
  statuses: string;
  /** Blank means Jira's Done category. */
  doneStatuses: string;
  issueType: string;
  /** Lines starting # are the headings a drafted ticket must have; blank is free text. */
  ticketTemplate: string;
}

export interface GitlabSettings {
  host: string;
}

export interface GithubSettings {
  /** Only this turns GitHub on; a signed-in gh never does. */
  on: boolean;
  scope: 'involved' | 'orgs';
  /** Patterns as repoFilter takes them, over owner/repo. */
  repos: string;
  host: string;
}

export interface TicketSettings {
  /** Repo paths whose merged MRs move a ticket straight to finished rather than QA. */
  noQaPaths: string;
}

export const DEFAULT_GITLAB_HOST = 'https://gitlab.com';
export const DEFAULT_GITHUB_API = 'https://api.github.com';

export const DEFAULT_JIRA: JiraSettings = { projects: '', defaultProject: '', statuses: '', doneStatuses: '', issueType: 'Task', ticketTemplate: '' };
export const DEFAULT_GITLAB: GitlabSettings = { host: DEFAULT_GITLAB_HOST };
export const DEFAULT_GITHUB: GithubSettings = { on: false, scope: 'involved', repos: '', host: DEFAULT_GITHUB_API };
export const DEFAULT_TICKETS: TicketSettings = { noQaPaths: '' };

export interface AgentCommands {
  reviewCommand: string;
  selfReviewCommand: string;
  kickoffCommand: string;
}

export const BUILT_IN_COMMANDS: AgentCommands = { reviewCommand: '', selfReviewCommand: '', kickoffCommand: '' };

export const DEFAULT_SETTINGS: Settings = {
  repoFilter: '',
  holdWhileReviewing: true,
  closeWorkspaceWhenDone: true,
  reReviewOnChange: false,
  rowTint: true,
  mouse: true,
  pollSeconds: 90,
  jiraSite: process.env['UNDERLINGS_JIRA_SITE'] ?? process.env['JIRA_SITE'] ?? '',
  workspaceRoot: process.env['ORCA_WORKSPACE_ROOT'] ?? '',
  leaderboardDays: 30,
  pointWeights: formatWeights(DEFAULT_WEIGHTS),
  fullAuto: '',
  autoHoldSeconds: 120,
  autoMaxComments: 8,
  autoMaxDiffLines: 600,
  autoSensitivePaths: '**/migrations/**, helm/**, **/auth/**, .gitlab-ci*',
  autoFooter: false,
  autoPaused: false,
  agentHost: 'claude',
  agentPermissions: 'ask',
  agents: BUILT_IN_COMMANDS,
  maxAgents: 4,
  agentBudgetUsd: '',
  holdNote: HOLD_NOTE,
  postedFooter: ATTRIBUTION,
  autoFooterText: AUTO_FOOTER,
  jira: DEFAULT_JIRA,
  gitlab: DEFAULT_GITLAB,
  github: DEFAULT_GITHUB,
  tickets: DEFAULT_TICKETS,
  models: freshModels(),
  everyEffort: DEFAULT,
};

export function listOf(text: string | null | undefined): string[] {
  return [...new Set(String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

export function gitlabHostOf(settings: Partial<Settings>): string {
  return tidyHost(settings.gitlab?.host ?? '') ?? DEFAULT_GITLAB_HOST;
}

export const githubOf = (settings: Partial<Settings>): GithubSettings => ({ ...DEFAULT_GITHUB, ...settings.github });

export function githubApiOf(settings: Partial<Settings>): string {
  return tidyHost(settings.github?.host ?? '', DEFAULT_GITHUB_API) ?? DEFAULT_GITHUB_API;
}

// A host typed without its scheme is the common slip, and a trailing slash would double up in every URL.
function tidyHost(text: string, blank = DEFAULT_GITLAB_HOST): string | null {
  const typed = text.trim().replace(/\/+$/, '');
  if (!typed) return blank;
  if (/^[a-z][\w+.-]*:\/\//i.test(typed) && !/^https?:\/\//i.test(typed)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`);
    return url.search || url.hash ? null : `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export interface Footers {
  posted: string;
  auto: string;
}

export const DEFAULT_FOOTERS: Footers = { posted: ATTRIBUTION, auto: AUTO_FOOTER };

export function footersOf(settings: Partial<Settings>): Footers {
  return { posted: (settings.postedFooter ?? ATTRIBUTION).trim(), auto: settings.autoFooterText?.trim() || AUTO_FOOTER };
}

export const holdNoteOf = (settings: Partial<Settings>): string => settings.holdNote?.trim() || HOLD_NOTE;

const BUDGET = /^(?:\d{1,4}(?:\.\d{1,2})?)?$/;

export function budgetOf(settings: Partial<Settings>): string | null {
  const typed = String(settings.agentBudgetUsd ?? '').trim();
  return BUDGET.test(typed) && Number(typed) > 0 ? typed : null;
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  // Anchored, or `logto` would match `platform-releases-logto-staging` as readily.
  return new RegExp(`^${escaped}$`, 'i');
}

export interface Pattern {
  negated: boolean;
  test: (path: string) => boolean;
}

export function parseFilter(filter: string): Pattern[] {
  return filter
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((raw) => {
      const negated = raw.startsWith('!');
      const body = negated ? raw.slice(1).trim() : raw;
      // A bare word is a substring, so `frontend` finds it wherever it sits in the tree.
      const expr = body.includes('*') || body.includes('/') ? body : `*${body}*`;
      const re = toRegExp(expr);
      return { negated, test: (path: string) => re.test(path) };
    });
}

/**
 * Excludes always win, whatever their order, so a filter that names a tree and then
 * subtracts a branch of it reads the way it looks rather than depending on which clause
 * was written last.
 */
export function matchRepo(path: string, patterns: Pattern[]): boolean {
  if (patterns.length === 0) return true;
  if (patterns.some((p) => p.negated && p.test(path))) return false;
  const includes = patterns.filter((p) => !p.negated);
  return includes.length === 0 || includes.some((p) => p.test(path));
}

export function applyFilter(repos: RepoSpec[], filter: string): RepoSpec[] {
  const patterns = parseFilter(filter);
  return repos.filter((r) => matchRepo(r.path, patterns));
}

export interface SettingRow {
  key: keyof Settings;
  label: string;
  hint: string;
  kind: 'text' | 'toggle' | 'number' | 'people' | 'choice';
  bounds?: { step: number; min: number; max: number };
  /** Value and label, for a choice. */
  choices?: [string, string][];
  /** What a text row takes; anything else is refused rather than saved. */
  pattern?: RegExp;
  /** Too long to type a key at a time, and the terminal's pane cannot scroll, so only the page edits it. */
  pageOnly?: boolean;
}

export type NestedKey = `jira.${keyof JiraSettings}` | `gitlab.${keyof GitlabSettings}` | `github.${keyof GithubSettings}` | `tickets.${keyof TicketSettings}`;
export type NestedGroup = 'jira' | 'gitlab' | 'github' | 'tickets';

/** Only the page edits these, so the terminal's pane keeps its rows. A tidy that answers null refuses the value. */
export interface NestedRow {
  key: NestedKey;
  label: string;
  hint: string;
  kind: 'text' | 'lines' | 'toggle' | 'choice';
  choices?: [string, string][];
  tidy?: (text: string) => string | null;
}

const tidyList = (text: string): string => listOf(text).join(', ');
const typedWords = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);
const tidyProjects = (text: string): string | null => (typedWords(text).every((word) => projectList(word).length === 1) ? projectList(text).join(', ') : null);
const tidyProject = (text: string): string | null => (text.trim() === '' || projectList(text).length === 1 ? (projectList(text)[0] ?? '') : null);
const tidyOneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const NESTED_ROWS: NestedRow[] = [
  {
    key: 'jira.projects',
    label: 'Your projects',
    hint: 'Jira project keys your tickets come from, comma separated, such as ABC, OPS. Blank lists your open tickets from every project.',
    kind: 'text',
    tidy: tidyProjects,
  },
  {
    key: 'jira.defaultProject',
    label: 'Default project',
    hint: 'the project a fix agent raises its follow-up tickets in, and whose keys count when a review thread names one.',
    kind: 'text',
    tidy: tidyProject,
  },
  {
    key: 'jira.statuses',
    label: 'Statuses',
    hint: 'every status a ticket can move to, comma separated. Each status seen on your tickets is offered too, and Jira refuses a move its workflow does not allow.',
    kind: 'text',
    tidy: tidyList,
  },
  {
    key: 'jira.doneStatuses',
    label: 'Finished statuses',
    hint: 'statuses that mean a ticket is finished, comma separated, the first being where finished work goes. Blank means Jira\'s Done category.',
    kind: 'text',
    tidy: tidyList,
  },
  {
    key: 'jira.issueType',
    label: 'New ticket type',
    hint: 'the issue type of a ticket raised from a review thread, an email or a Slack message, such as Task or Story.',
    kind: 'text',
    tidy: (text) => tidyOneLine(text) || DEFAULT_JIRA.issueType,
  },
  {
    key: 'jira.ticketTemplate',
    label: 'Ticket template',
    hint: 'lines starting # are the headings every drafted ticket has, in order. Anything else is said to Claude as it is written. Blank lets Claude write the description freely.',
    kind: 'lines',
  },
  {
    key: 'tickets.noQaPaths',
    label: 'No QA for',
    hint: 'repo paths, comma separated, such as acme/tooling. A ticket whose MRs all merged under one of them is suggested straight to finished rather than to QA.',
    kind: 'text',
    tidy: tidyList,
  },
  {
    key: 'gitlab.host',
    label: 'GitLab host',
    hint: 'where your GitLab lives, such as https://gitlab.example.com. Blank means gitlab.com.',
    kind: 'text',
    tidy: tidyHost,
  },
  {
    key: 'github.on',
    label: 'GitHub',
    hint: 'reads your GitHub pull requests into the same list as your merge requests. Only this switch turns it on; being signed in to gh does not.',
    kind: 'toggle',
  },
  {
    key: 'github.scope',
    label: 'Pull requests',
    hint: 'Involving me reads every open pull request you wrote, are assigned, are asked to review or are mentioned in. My organisations also reads every open one in the organisations you belong to.',
    kind: 'choice',
    choices: [['involved', 'Involving me'], ['orgs', 'My organisations']],
  },
  {
    key: 'github.repos',
    label: 'GitHub repos',
    hint: 'organisations or owner/repo patterns, comma separated, ! excludes, as Repos takes them. Blank means every one found.',
    kind: 'text',
    tidy: tidyList,
  },
  {
    key: 'github.host',
    label: 'GitHub API',
    hint: 'the API your GitHub answers on. Blank means api.github.com; GitHub Enterprise Server is usually https://github.example.com/api/v3.',
    kind: 'text',
    tidy: (text) => tidyHost(text, DEFAULT_GITHUB_API),
  },
];

export function nestedValue(settings: Settings, key: NestedKey): string | boolean {
  const [group, name] = key.split('.') as [NestedGroup, string];
  const value = (settings[group] as unknown as Record<string, unknown>)?.[name];
  return typeof value === 'boolean' ? value : String(value ?? '');
}

const DAY_BOUNDS = { step: 7, min: 1, max: 365 };

export function nudge(row: SettingRow, current: number, up: boolean): number {
  const { step, min, max } = row.bounds ?? DAY_BOUNDS;
  const from = Number.isFinite(current) ? current : min;
  return Math.max(min, Math.min(from + (up ? step : -step), max));
}

export const SETTING_ROWS: SettingRow[] = [
  {
    key: 'repoFilter',
    label: 'Repos',
    hint: 'patterns, comma separated, ! excludes. Empty means every repo found.',
    kind: 'text',
  },
  {
    key: 'holdWhileReviewing',
    label: 'Hold while reviewing',
    hint: 'requests changes on an MR while its review runs. Notifies the author.',
    kind: 'toggle',
  },
  {
    key: 'closeWorkspaceWhenDone',
    label: 'Tidy up after a review',
    hint: 'removes the review agent once you have decided.',
    kind: 'toggle',
  },
  {
    key: 'reReviewOnChange',
    label: 'Re-review MRs I reviewed when they change',
    hint: 'starts a review agent on its own, on your Claude usage, whenever an MR you reviewed changes. What it finds still waits for you.',
    kind: 'toggle',
  },
  {
    key: 'pollSeconds',
    label: 'Refresh every',
    hint: 'seconds between refreshes.',
    kind: 'number',
    bounds: { step: 15, min: 15, max: 3600 },
  },
  { key: 'rowTint', label: 'Row tint', hint: 'colours the whole row, not just its left edge.', kind: 'toggle' },
  {
    key: 'workspaceRoot',
    label: 'Workspace',
    hint: `the checkout agents run against. Full auto in ${APP_NAME} cannot launch reviews while this is blank.`,
    kind: 'text',
  },
  {
    key: 'jiraSite',
    label: 'Jira site',
    hint: 'host for the ticket pane, e.g. acme.atlassian.net. Blank turns the pane off.',
    kind: 'text',
  },
  {
    key: 'leaderboardDays',
    label: 'Leaderboard window',
    hint: 'days the board looks back. Longer is more requests, built only when you ask.',
    kind: 'number',
    bounds: DAY_BOUNDS,
  },
  {
    key: 'pointWeights',
    label: 'Point weights',
    hint: 'opened/reviewed/comments/approved. All four are counts, so volume still wins.',
    kind: 'text',
  },
  {
    key: 'mouse',
    label: 'Mouse',
    hint: 'clicking rows and the sidebar. Off restores the terminal\'s own selection.',
    kind: 'toggle',
  },
  {
    key: 'fullAuto',
    label: 'Full auto',
    hint: 'enter picks who, from everyone with an open MR. shadow posts nothing, comments posts, verdict also approves.',
    kind: 'people',
  },
  {
    key: 'autoHoldSeconds',
    label: 'Auto hold',
    hint: 'seconds an auto item waits in the review queue, where you can still discard it, before it sends.',
    kind: 'number',
    bounds: { step: 30, min: 30, max: 3600 },
  },
  {
    key: 'autoMaxComments',
    label: 'Auto comments a pass',
    hint: 'comments one auto pass may send on one merge request. The rest wait for you.',
    kind: 'number',
    bounds: { step: 1, min: 1, max: 30 },
  },
  {
    key: 'autoMaxDiffLines',
    label: 'Auto approve under',
    hint: 'changed lines. A bigger diff never gets an auto approval.',
    kind: 'number',
    bounds: { step: 100, min: 50, max: 5000 },
  },
  {
    key: 'autoSensitivePaths',
    label: 'Never auto approve',
    hint: 'globs, comma separated. A diff touching any of them waits for you.',
    kind: 'text',
  },
  {
    key: 'autoFooter',
    label: 'Auto footer',
    hint: 'says on each auto-posted comment that it went without being read first.',
    kind: 'toggle',
  },
  {
    key: 'agentHost',
    label: 'Agents run in',
    hint: 'claude runs each agent as Claude Code in the background. orca opens it in an Orca terminal instead.',
    kind: 'choice',
    choices: [['claude', 'Claude Code'], ['orca', 'Orca terminals']],
  },
  {
    key: 'agentPermissions',
    label: 'Agent permissions',
    hint: 'ask stops an agent at each action your allow list does not cover, until you answer it in Needs you. auto lets Claude Code\'s auto mode decide: the agent edits files, runs commands and uses its tools without asking you, and stops only for what auto mode judges risky.',
    kind: 'choice',
    choices: [['ask', 'Ask me'], ['auto', 'Auto']],
  },
  {
    key: 'maxAgents',
    label: 'Agents at once',
    hint: 'the most Claude Code agents running together, the Claude panel\'s chat aside. One more is refused until another finishes. 0 means no limit.',
    kind: 'number',
    bounds: { step: 1, min: 0, max: 20 },
  },
  {
    key: 'agentBudgetUsd',
    label: 'Spend cap a run',
    hint: 'US dollars a review, fix or kickoff agent may spend in one run, such as 2.50. Blank means no cap.',
    kind: 'text',
    pattern: BUDGET,
  },
  {
    key: 'holdNote',
    label: 'Hold note',
    hint: 'posted on an MR, as you, when a review puts a hold on it. Blank posts the default.',
    kind: 'text',
    pageOnly: true,
  },
  {
    key: 'postedFooter',
    label: 'Comment footer',
    hint: 'ends each comment you post from the review queue. Blank posts none.',
    kind: 'text',
    pageOnly: true,
  },
  {
    key: 'autoFooterText',
    label: 'Auto footer words',
    hint: 'end each comment full auto posts while Auto footer is on. Blank posts the default.',
    kind: 'text',
    pageOnly: true,
  },
];

/**
 * Lines the settings pane spends before the repo list: the title, the discovery line, the
 * rows, the hint, the match count and the blanks between them. The pane cannot scroll, so
 * listing one repo too many pushes the title off the top of the terminal.
 */
export const TERMINAL_ROWS = SETTING_ROWS.filter((row) => !row.pageOnly);

export const SETTINGS_CHROME_ROWS = 8 + TERMINAL_ROWS.length;

/**
 * How many repos the list can show, leaving room for the "and N more" line. On a terminal
 * too short for the chrome this is nought: the count still gets said, and the settings
 * themselves matter more than the listing.
 */
export function repoListRows(height: number, total: number): number {
  const room = Math.max(height - SETTINGS_CHROME_ROWS, 0);
  return total > room ? Math.max(room - 1, 0) : total;
}

/**
 * Roughly what a refresh costs GitLab. Worth showing, because the rate limit is the one
 * setting here you can trip from the panel without being told why: a short interval over
 * many repos is a 429, and the error arrives nowhere near the dial that caused it.
 */
export const BUSY_PER_MINUTE = 60;

export function requestRate(
  queriesPerRefresh: number,
  pollSeconds: number,
): { perRefresh: number; perMinute: number; heavy: boolean } {
  const perMinute = Math.round((queriesPerRefresh * 60) / Math.max(pollSeconds, 1));
  return { perRefresh: queriesPerRefresh, perMinute, heavy: perMinute > BUSY_PER_MINUTE };
}
