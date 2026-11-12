import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOOD_LABELS, PIPELINE_LEGEND, REVIEW_LEGEND, TICKET_LEGEND, parseWeights } from './engine.js';

test('the engine hands a front end every key the help screen draws', () => {
  assert.deepEqual(
    REVIEW_LEGEND.map((b) => b.phase),
    ['running', 'ready', 'awaiting', 'moved', 'open', 'posted', 'stalled'],
  );
  assert.ok(REVIEW_LEGEND.every((b) => b.glyph.trim() && b.label));
  assert.deepEqual(
    PIPELINE_LEGEND.map((p) => p.label),
    ['passed', 'failed', 'running', 'skipped'],
  );
  assert.ok(TICKET_LEGEND.length > 0);
  assert.ok(Object.keys(MOOD_LABELS).length > 0);
});

test('the engine reads the point weights the way the board scores them', () => {
  assert.deepEqual(parseWeights('2/4//1'), { opened: 2, reviewed: 4, comments: 0.5, approved: 1 });
});
