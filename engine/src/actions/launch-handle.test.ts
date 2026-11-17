import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Mr } from '../types.js';

const root = mkdtempSync(join(tmpdir(), 'launch-handle-'));
const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
chmodSync(join(fixtures, 'fake-claude.mjs'), 0o755);
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['UNDERLINGS_CODE_FOLDER'] = root;
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_FIRST'] = join(fixtures, 'question.jsonl');
process.env['FAKE_CLAUDE_RESUME'] = join(fixtures, 'resume.jsonl');

const { launchReview } = await import('./launch.js');
const { claudeAgents, claudeHost } = await import('../agents/claude.js');

const MR = { projectPath: 'acme/engine', repoLabel: 'Engine', iid: 7, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7' } as Mr;
const handles = (): string[] => claudeAgents().map((a) => a.handle);

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  for (const agent of await claudeHost.agents()) await claudeHost.removeWorkspace(agent.handle);
});

test('a finished review of the same MR is removed before the next one starts', async () => {
  const first = await launchReview(MR, 'review it');
  await claudeHost.stop(first.handle ?? '');
  const second = await launchReview(MR, 'review it');
  assert.deepEqual(handles(), [second.handle]);
});

test('a previous review with its agent still going is kept', async () => {
  const first = await launchReview(MR, 'review it');
  const second = await launchReview(MR, 'review it');
  assert.deepEqual(handles().sort(), [first.handle, second.handle].sort());
});
