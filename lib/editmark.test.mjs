import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const ROOT = mkdtempSync(join(tmpdir(), 'cc-editmark-'));
const STATE = join(ROOT, 'state');
mkdirSync(STATE, { recursive: true });
process.env.UNDERLINGS_STATE_DIR = STATE;
process.env.HOME = join(ROOT, 'home');
process.env.GITLAB_TOKEN = '';
globalThis.fetch = async () => { throw new Error('nothing in this test reaches the network'); };

const core = await import('./engine.mjs');
const ENGINE = core.engineFile({ matrixEngine: process.env.UNDERLINGS_TEST_ENGINE });
const { ROUTES } = await import('./autoloop.mjs');
const { tidyAfterFetch } = await import('./tidy.mjs');
await core.loadEngine({ matrixEngine: ENGINE }, () => {});
while (core.loading()) await new Promise((resolve) => setTimeout(resolve, 5));
const skip = core.engine ? false : `needs the review engine built at ${ENGINE}: run npm run build, or set UNDERLINGS_SKIP_REAL_ENGINE=1 to skip these on purpose`;
if (skip && !process.env.UNDERLINGS_SKIP_REAL_ENGINE) test('the review engine is built for the edit mark to run on', () => assert.fail(skip));

after(() => rmSync(ROOT, { recursive: true, force: true }));

// Test data by its path, so the engine expires it without asking GitLab.
const item = (id) => ({
  id, projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/621',
  severity: 'MINOR', body: id, createdBy: 'review', createdAt: new Date().toISOString(), status: 'pending',
});
const statuses = () => Object.fromEntries(JSON.parse(readFileSync(join(STATE, 'queue.json'), 'utf8')).map((c) => [c.id, c.status]));
const mark = (id, editing) => ROUTES['POST /api/matrix/editing']({ body: async () => ({ id, editing }) });

describe('an edit mark on the real engine', { skip }, () => {
  test('an item open for editing on the page is not expired by the tidy after a fetch, and is once the edit closes', async () => {
    writeFileSync(join(STATE, 'queue.json'), JSON.stringify([item('editing'), item('idle')]));
    await mark('editing', true);
    await tidyAfterFetch({ mrs: [] });
    assert.deepEqual(statuses(), { editing: 'pending', idle: 'expired' });
    await mark('editing', false);
    await tidyAfterFetch({ mrs: [] });
    assert.deepEqual(statuses(), { editing: 'expired', idle: 'expired' });
  });
});
