import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { MARKETPLACE_NAME, PLUGIN_ID, PLUGIN_NAME, pluginArgs, pluginDir, pluginMarketplace, skillCommand, skillsPlugin } from './plugin.js';

test('the plugin sits in the repo at the folder the engine names, as a marketplace holding one plugin of the same name', () => {
  assert.equal(basename(pluginMarketplace()), 'plugin');
  assert.ok(existsSync(join(dirname(pluginMarketplace()), 'engine', 'src', 'plugin.ts')), 'beside the engine folder, as the app packs them');
  assert.ok(existsSync(join(pluginMarketplace(), '.claude-plugin', 'marketplace.json')));
  assert.equal(pluginDir(), join(pluginMarketplace(), PLUGIN_NAME));
  assert.equal(JSON.parse(readFileSync(join(pluginDir(), '.claude-plugin', 'plugin.json'), 'utf8')).name, PLUGIN_NAME);
  assert.equal(JSON.parse(readFileSync(join(pluginMarketplace(), '.claude-plugin', 'marketplace.json'), 'utf8')).name, MARKETPLACE_NAME);
  assert.deepEqual(skillsPlugin(), { id: 'underlings@underlings', marketplaceName: 'underlings', marketplace: pluginMarketplace(), dir: pluginDir() });
  assert.equal(PLUGIN_ID, `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
});

test('an agent is told to load the plugin by its folder, and its skills are named under the plugin', () => {
  assert.deepEqual(pluginArgs(), ['--plugin-dir', pluginDir()]);
  assert.deepEqual(['review', 'pre-mr-review', 'kickoff'].map(skillCommand), ['/underlings:review', '/underlings:pre-mr-review', '/underlings:kickoff']);
});
