import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'underlings';
export const MARKETPLACE_NAME = 'underlings';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

// Two folders up from engine/src in a checkout and from engine/dist in the app, which packs the plugin beside the engine.
export const pluginMarketplace = (): string => fileURLToPath(new URL('../../plugin', import.meta.url));

export const pluginDir = (): string => join(pluginMarketplace(), PLUGIN_NAME);

export const pluginArgs = (): string[] => ['--plugin-dir', pluginDir()];

export const skillCommand = (skill: string): string => `/${PLUGIN_NAME}:${skill}`;

export interface SkillsPlugin {
  id: string;
  marketplaceName: string;
  marketplace: string;
  dir: string;
}

export const skillsPlugin = (): SkillsPlugin => ({ id: PLUGIN_ID, marketplaceName: MARKETPLACE_NAME, marketplace: pluginMarketplace(), dir: pluginDir() });
