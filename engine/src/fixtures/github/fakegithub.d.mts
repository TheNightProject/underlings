export type World = Record<string, any>;

export interface Call {
  method: string;
  path: string;
  search: string;
  op: string | null;
  headers: Record<string, string>;
  bearer: string | null;
  timed: boolean;
  body: any;
}

export interface Failure {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function emptyWorld(viewer?: string): World;

export function fakeGithub(world?: World, options?: { api?: string; web?: string }): {
  fetch: typeof fetch;
  requests: Call[];
  world: World;
  web: string;
  count(): number;
  inject(match: { op?: string; path?: string; method?: string }, ...failures: Failure[]): void;
  asked(op: string): Call[];
};
