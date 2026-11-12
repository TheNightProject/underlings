const CONTEXT = 3;
const SHOWN = 160;
const MAX_CELLS = 4_000_000;

export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const ops = [
    ...a.slice(0, head).map((line) => [' ', line]),
    ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((line) => [' ', line]),
  ];
  return hunks(ops);
}

function middle(a, b) {
  if (a.length * b.length > MAX_CELLS) return [...a.map((line) => ['-', line]), ...b.map((line) => ['+', line])];
  const longest = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) longest[i][j] = a[i] === b[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push([' ', a[i++], j++]);
    else if (i < a.length && (j === b.length || longest[i + 1][j] >= longest[i][j + 1])) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  return ops;
}

function hunks(ops) {
  const near = ops.map((_, n) => ops.slice(Math.max(0, n - CONTEXT), n + CONTEXT + 1).some(([kind]) => kind !== ' '));
  const out = [];
  let gap = false;
  ops.forEach(([kind, line], n) => {
    if (!near[n]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push('@@');
    gap = false;
    out.push(`${kind} ${line}`);
  });
  return out.length > SHOWN ? [...out.slice(0, SHOWN), `... and ${out.length - SHOWN} more lines`].join('\n') : out.join('\n');
}
