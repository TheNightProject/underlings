import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { configDir } from '../../../lib/home.mjs';
import { githubApiOf, githubOf, type GithubSettings } from '../settings.js';
import { loadSettings } from './store.js';

const run = promisify(execFile);

export const GITHUB_TIMEOUT_MS = 30_000;
const AT_ONCE = 4;
const GH_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];
const LONGEST_WAIT_MS = 60_000;
const ETAGS_KEPT = 200;
const PUBLIC_API = 'https://api.github.com';

export type TokenSource = 'saved' | 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh';

export interface Token {
  token: string;
  source: TokenSource;
}

export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

export const githubTokenFile = (): string => join(configDir(), 'github-token');
export const githubSettings = (): GithubSettings => githubOf(loadSettings());
export const githubOn = (): boolean => githubSettings().on === true;
export const githubApi = (): string => githubApiOf(loadSettings());

// Enterprise Server answers REST under /api/v3 and GraphQL beside it, where github.com has both at the root.
export function githubGraphqlUrl(): string {
  const api = githubApi();
  return `${api.endsWith('/v3') ? api.slice(0, -3) : api}/graphql`;
}

export function githubWeb(): string {
  const api = githubApi();
  if (api === PUBLIC_API) return 'https://github.com';
  return api.endsWith('/api/v3') ? api.slice(0, -7) : new URL(api).origin;
}

let fromGh: string | null = null;

function savedToken(): string | null {
  try {
    return readFileSync(githubTokenFile(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const ghBin = (): string => process.env['UNDERLINGS_GH_BIN'] || 'gh';

async function ghToken(): Promise<string | null> {
  if (fromGh) return fromGh;
  try {
    const { stdout } = await run(ghBin(), ['auth', 'token', '--hostname', new URL(githubWeb()).host], { timeout: GH_MS });
    fromGh = String(stdout).trim() || null;
  } catch {
    fromGh = null;
  }
  return fromGh;
}

/** A pasted token first, then the shell's, then gh's; gh's is only ever held in memory. */
export async function githubToken(): Promise<Token | null> {
  const saved = savedToken();
  if (saved) return { token: saved, source: 'saved' };
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, source: name };
  }
  const token = await ghToken();
  return token ? { token, source: 'gh' } : null;
}

export function forgetGithubToken(): void {
  fromGh = null;
  me = null;
}

let me: { token: string; login: string } | null = null;

export async function viewerLogin(): Promise<string> {
  const token = await githubToken();
  if (me && token?.token === me.token) return me.login;
  const data = await graphql<{ viewer: { login: string } }>('query Viewer { viewer { login } }');
  me = token ? { token: token.token, login: data.viewer.login } : null;
  return data.viewer.login;
}

const limits = { blockedUntil: 0, remaining: null as number | null, resetAt: null as string | null, lastCost: 0 };

export function githubLimits(): { remaining: number | null; resetAt: string | null; lastCost: number; blockedUntil: string | null } {
  return { remaining: limits.remaining, resetAt: limits.resetAt, lastCost: limits.lastCost, blockedUntil: limits.blockedUntil > Date.now() ? new Date(limits.blockedUntil).toISOString() : null };
}

export function resetGithubLimits(): void {
  Object.assign(limits, { blockedUntil: 0, remaining: null, resetAt: null, lastCost: 0 });
  etags.clear();
}

let active = 0;
const queued: (() => void)[] = [];

async function oneOfFour<T>(send: () => Promise<T>): Promise<T> {
  if (active >= AT_ONCE) await new Promise<void>((go) => queued.push(go));
  active += 1;
  try {
    return await send();
  } finally {
    active -= 1;
    queued.shift()?.();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function headersFor(token: string, init: RequestInit): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Underlings',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    Authorization: `Bearer ${token}`,
  };
}

async function attempt(url: string, init: RequestInit): Promise<Response> {
  const token = await githubToken();
  if (!token) throw new Error('there is no GitHub token. Paste one in Setup, set GITHUB_TOKEN, or sign in with gh auth login');
  const res = await oneOfFour(() => fetch(url, { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS), ...init, headers: headersFor(token.token, init) }));
  if (res.status !== 401 || token.source !== 'gh') return res;
  forgetGithubToken();
  const again = await githubToken();
  return again && again.token !== token.token ? oneOfFour(() => fetch(url, { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS), ...init, headers: headersFor(again.token, init) })) : res;
}

/** How long GitHub asked to be left alone, or null when the answer is not a request to wait. */
export function waitAsked(res: Response, fallback: number, now = Date.now()): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0 ? Math.max(reset * 1000 - now, 0) : fallback;
  }
  return res.status === 429 ? fallback : null;
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

// A wait longer than a minute is not slept through: nothing is sent until it ends, and the refresh says so.
async function send(url: string, init: RequestInit = {}): Promise<Response> {
  if (limits.blockedUntil > Date.now()) throw new Error(`GitHub's rate limit is spent until ${clock(limits.blockedUntil)} UTC, so nothing is asked until then`);
  let res = await attempt(url, init);
  for (const fallback of RETRY_DELAYS_MS) {
    const wait = waitAsked(res, fallback);
    if (wait === null) break;
    if (wait > LONGEST_WAIT_MS) {
      limits.blockedUntil = Date.now() + wait;
      break;
    }
    await sleep(wait);
    res = await attempt(url, init);
  }
  noteHeaders(res);
  return res;
}

function noteHeaders(res: Response): void {
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining !== null && Number.isFinite(Number(remaining))) limits.remaining = Number(remaining);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (reset > 0) limits.resetAt = new Date(reset * 1000).toISOString();
}

function ssoWords(header: string): string | null {
  const url = /url=(\S+)/.exec(header)?.[1];
  if (!url) return null;
  const org = /\/orgs\/([^/]+)\/sso/.exec(url)?.[1];
  return `authorise this token for ${org ?? 'the organisation'}'s single sign-on: ${url}`;
}

async function refusal(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  const sso = res.status === 403 ? ssoWords(res.headers.get('x-github-sso') ?? '') : null;
  if (sso) return new Error(`GitHub: ${sso}`);
  if (res.status === 401) return new Error('GitHub refused the token (401): it is wrong, revoked or expired');
  const limited = limits.blockedUntil > Date.now() ? ` until ${clock(limits.blockedUntil)} UTC` : '';
  if (waitAsked(res, 0) !== null) return new Error(`GitHub is rate limiting (${res.status})${limited}: poll less often or narrow GitHub repos`);
  const message = (() => {
    try {
      return String(JSON.parse(text).message ?? '');
    } catch {
      return text.slice(0, 300);
    }
  })();
  return new Error(`GitHub ${res.status} ${res.statusText} on ${what}${message ? `: ${message}` : ''}`.replace(/ {2,}/g, ' '));
}

const etags = new Map<string, { etag: string; body: unknown }>();

function keepEtag(url: string, etag: string | null, body: unknown): void {
  if (!etag) return;
  etags.delete(url);
  etags.set(url, { etag, body });
  if (etags.size > ETAGS_KEPT) etags.delete(etags.keys().next().value as string);
}

/** A read tied to a head is asked with its last ETag, as GitHub does not count an unchanged answer against the limit. */
export async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${githubApi()}${path}`;
  const cached = (init.method ?? 'GET') === 'GET' ? etags.get(url) : undefined;
  const res = await send(url, cached ? { ...init, headers: { ...(init.headers as Record<string, string>), 'If-None-Match': cached.etag } } : init);
  if (res.status === 304 && cached) return cached.body as T;
  if (!res.ok) throw await refusal(res, path);
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as T;
  keepEtag(url, res.headers.get('etag'), body);
  return body;
}

/** For bodies too big to hold whole, such as a job log or a file. Null when GitHub has nothing there. */
export async function restStream(path: string, accept: string): Promise<Response | null> {
  const res = await send(`${githubApi()}${path}`, { headers: { Accept: accept } });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw await refusal(res, path);
  return res;
}

interface GraphqlBody<T> {
  data?: (T & { rateLimit?: RateLimit }) | null;
  errors?: { message: string; type?: string }[];
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await send(githubGraphqlUrl(), { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw await refusal(res, 'GraphQL');
  const body = (await res.json()) as GraphqlBody<T>;
  if (body.data?.rateLimit) noteCost(body.data.rateLimit);
  if (body.errors?.some((e) => e.type === 'RATE_LIMITED')) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    limits.blockedUntil = reset > 0 ? reset * 1000 : Date.now() + LONGEST_WAIT_MS;
    throw new Error(`GitHub's GraphQL rate limit is spent until ${clock(limits.blockedUntil)} UTC`);
  }
  if (!body.data) throw new Error(`GitHub GraphQL: ${(body.errors ?? []).map((e) => e.message).join('; ') || 'no data'}`);
  return body.data;
}

function noteCost(rate: RateLimit): void {
  limits.lastCost = rate.cost;
  limits.remaining = rate.remaining;
  limits.resetAt = rate.resetAt;
}

export interface TokenCheck {
  source: TokenSource;
  login: string | null;
  scopes: string[] | null;
  status: number;
  sso: string | null;
}

/** Who the token is and what it may do, read from the user call's headers; a fine-grained token names no scopes. */
export async function checkToken(): Promise<TokenCheck | null> {
  forgetGithubToken();
  const token = await githubToken();
  if (!token) return null;
  const res = await fetch(`${githubApi()}/user`, { signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS), headers: headersFor(token.token, {}) });
  const body = res.ok ? ((await res.json()) as { login?: string }) : null;
  const scopes = res.headers.get('x-oauth-scopes');
  return {
    source: token.source,
    login: body?.login ?? null,
    scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean),
    status: res.status,
    sso: ssoWords(res.headers.get('x-github-sso') ?? ''),
  };
}
