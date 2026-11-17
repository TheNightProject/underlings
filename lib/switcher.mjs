import { failure } from './engine.mjs';

// The app keeps the workspaces and runs their workers, so every change here is asked of it, and a worker run without the app has none.
let shell = {};

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/workspaces': () => view(),
  'POST /api/workspaces/switch': async ({ body }) => ask('switchWorkspace', await body()),
  'POST /api/workspaces/create': async ({ body }) => ask('createWorkspace', await body()),
  'POST /api/workspaces/update': async ({ body }) => ask('updateWorkspace', await body()),
  'POST /api/workspaces/remove': async ({ body }) => ask('removeWorkspace', await body()),
};

export function start(cfg, sh) {
  shell = sh ?? {};
}

export const available = () => typeof shell.desktop?.workspaces === 'function';

export async function view() {
  return available() ? shell.desktop.workspaces() : null;
}

async function ask(name, body) {
  if (!available()) throw failure(501, 'only the app runs workspaces');
  try {
    return await shell.desktop[name](body ?? {});
  } catch (err) {
    throw err.status ? failure(err.status, err.message) : err;
  }
}
