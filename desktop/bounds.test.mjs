import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keptBounds } from './bounds.mjs';

const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 };
const MONITOR = { x: 1512, y: 0, width: 2560, height: 1415 };
const both = () => [LAPTOP, MONITOR];

test('a window saved whole on a connected display opens where it was, as the app has always saved it', () => {
  assert.deepEqual(keptBounds({ x: 100, y: 80, width: 1400, height: 900, onTop: true }, both), { x: 100, y: 80, width: 1400, height: 900 });
  assert.deepEqual(keptBounds({ x: 1600, y: 40, width: 1400, height: 900 }, both), { x: 1600, y: 40, width: 1400, height: 900 });
});

test('a window last on a display that is not connected keeps only its size', () => {
  assert.deepEqual(keptBounds({ x: 1600, y: 40, width: 1400, height: 900 }, () => [LAPTOP]), { width: 1400, height: 900 });
  assert.deepEqual(keptBounds({ x: -5000, y: -5000, width: 800, height: 600 }, both), { width: 800, height: 600 });
});

test('a size with no place, as a hand-made or half-written file has, keeps the size and lets macOS place it', () => {
  assert.deepEqual(keptBounds({ width: 1400, height: 900 }, both), { width: 1400, height: 900 });
  assert.deepEqual(keptBounds({ x: '100', y: 80, width: 1400, height: 900 }, both), { width: 1400, height: 900 });
  assert.deepEqual(keptBounds({ x: 10.5, y: 80, width: 1400, height: 900 }, both), { width: 1400, height: 900 });
});

test('anything else falls back to the default size, never reaching the window as it is', () => {
  for (const bad of [null, 'x', 7, [], {}, { width: '1400', height: 900 }, { width: 1400 }, { width: NaN, height: 900 }, { width: Infinity, height: 900 },
    { width: 1400.5, height: 900 }, { width: 0, height: 900 }, { width: -800, height: 600 }, { width: 50, height: 40 }, { width: 1e9, height: 900 }]) {
    assert.deepEqual(keptBounds(bad, both), {}, JSON.stringify(bad));
  }
});
