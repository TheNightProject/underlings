import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, TOOLS } from './mcptools.mjs';
import { person, profileOf } from './profile.mjs';
import { systemPrompt as emailPrompt } from './email.mjs';
import { systemPrompt as slackPrompt } from './slack.mjs';
import { messageSystemPrompt, systemPrompt as ticketPrompt } from './ticketdraft.mjs';

test('with no profile every prompt and tool description speaks of "you", and asks for no language or rules of its own', () => {
  const blank = profileOf({});
  const prompts = [slackPrompt(blank), emailPrompt(blank), ticketPrompt(blank), messageSystemPrompt('email thread', 'email', blank), ...TOOLS.map((t) => describe(t, person(blank)))];
  for (const prompt of prompts) assert.doesNotMatch(prompt, /British|em dash|undefined/, prompt.slice(0, 80));
  assert.match(slackPrompt(blank), /need you\./);
  assert.match(emailPrompt(blank), /need you\./);
});
