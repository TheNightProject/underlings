import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const CHUNK = 4 * 1024 * 1024;
const MARK = Buffer.from('"type":"assistant"');
const TOP = new Set(['type', 'timestamp', 'message']);
const MESSAGE = new Set(['id', 'usage']);
const WS = new Set([32, 9, 10, 13]);

export function freshCache() {
  return { v: 1, files: {}, days: {} };
}

const space = (s, i) => {
  while (WS.has(s.charCodeAt(i))) i += 1;
  return i;
};

// Strings are stepped over by their closing quote and never decoded, so what a message says is never read.
function skipString(s, i) {
  for (let j = i + 1; ;) {
    const q = s.indexOf('"', j);
    if (q < 0) return -1;
    let slashes = 0;
    while (s.charCodeAt(q - 1 - slashes) === 92) slashes += 1;
    if (slashes % 2 === 0) return q + 1;
    j = q + 1;
  }
}

function skipNested(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const c = s.charCodeAt(j);
    if (c === 34) {
      j = skipString(s, j) - 1;
      if (j < 0) return -1;
    } else if (c === 123 || c === 91) depth += 1;
    else if (c === 125 || c === 93) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

function skipValue(s, i) {
  const c = s.charCodeAt(i);
  if (c === 34) return skipString(s, i);
  if (c === 123 || c === 91) return skipNested(s, i);
  let j = i;
  while (j < s.length && !',}]'.includes(s[j]) && !WS.has(s.charCodeAt(j))) j += 1;
  return j > i ? j : -1;
}

function spansOf(s, i, wanted) {
  i = space(s, i);
  if (s[i] !== '{') return null;
  const out = {};
  for (i = space(s, i + 1); s[i] !== '}';) {
    if (s[i] !== '"') return null;
    const keyEnd = skipString(s, i);
    if (keyEnd < 0) return null;
    const key = s.slice(i + 1, keyEnd - 1);
    i = space(s, keyEnd);
    if (s[i] !== ':') return null;
    const from = space(s, i + 1);
    const to = skipValue(s, from);
    if (to < 0) return null;
    if (wanted.has(key)) out[key] = [from, to];
    i = space(s, to);
    if (s[i] === ',') i = space(s, i + 1);
    else if (s[i] !== '}') return null;
  }
  return out;
}

const text = (s, span) => (span && s[span[0]] === '"' ? JSON.parse(s.slice(span[0], span[1])) : null);
const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

// Input counts what was written to the cache as well, since that is fresh input; reading the cache back is not counted.
export function usageLine(line) {
  const top = spansOf(line, 0, TOP);
  if (!top || text(line, top.type) !== 'assistant' || !top.message) return null;
  const message = spansOf(line, top.message[0], MESSAGE);
  if (!message?.usage || line[message.usage[0]] !== '{') return null;
  const id = text(line, message.id);
  const at = Date.parse(text(line, top.timestamp) ?? '');
  if (!id || Number.isNaN(at)) return null;
  const usage = JSON.parse(line.slice(...message.usage));
  return { id, at, tokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens) };
}

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, found);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

// Only whole lines are taken, so a line half written when it is read is read again whole next time.
function wholeLines(chunk, parts, onLine) {
  let start = 0;
  for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
    const piece = chunk.subarray(start, nl);
    onLine(parts.length ? Buffer.concat([...parts.splice(0), piece]) : piece);
    start = nl + 1;
  }
  return start;
}

async function readLines(path, from, size, onLine) {
  const handle = await open(path, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  const parts = [];
  let done = from;
  try {
    for (let pos = from; pos < size;) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      const start = wholeLines(chunk, parts, onLine);
      if (start) done = pos + start;
      if (start < bytesRead) parts.push(Buffer.from(chunk.subarray(start)));
      pos += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return done;
}

// Two 32-bit hashes keep the cache small; a clash could only ever leave a message out, never count one twice.
export function idKey(id) {
  let a = 2166136261;
  let b = 0x9747b28c;
  for (let i = 0; i < id.length; i += 1) {
    const c = id.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(36) + '.' + (b >>> 0).toString(36);
}

function seenIds(cache) {
  return new Set(Object.values(cache.days).flatMap((d) => d.ids));
}

async function readOn(path, cache, since, dayOf, take) {
  const s = await stat(path).catch(() => null);
  if (!s || dayOf(s.mtimeMs) < since) return false;
  const was = cache.files[path];
  const from = was && was.ino === s.ino && was.offset <= s.size ? was.offset : 0;
  if (from === s.size) return false;
  const offset = await readLines(path, from, s.size, take).catch(() => from);
  cache.files[path] = { ino: s.ino, size: s.size, offset };
  return true;
}

export async function countTokens({ roots, cache = freshCache(), since, dayOf }) {
  const seen = seenIds(cache);
  const paths = (await Promise.all(roots.map((root) => walk(root)))).flat();
  let changed = false;
  const take = (buf) => {
    if (buf.indexOf(MARK) < 0) return;
    const found = usageLine(buf.toString('utf8'));
    const key = found && idKey(found.id);
    if (!found || seen.has(key)) return;
    seen.add(key);
    const into = (cache.days[dayOf(found.at)] ??= { tokens: 0, ids: [] });
    into.tokens += found.tokens;
    into.ids.push(key);
    changed = true;
  };
  for (const path of paths) if (await readOn(path, cache, since, dayOf, take)) changed = true;
  for (const day of Object.keys(cache.days)) if (day < since) delete cache.days[day];
  const walked = new Set(paths);
  for (const path of Object.keys(cache.files)) if (!walked.has(path)) delete cache.files[path];
  return { cache, sessions: new Set(paths.map((path) => basename(path, '.jsonl'))), changed };
}

export function tokenDays(cache) {
  return Object.fromEntries(Object.entries(cache.days).map(([day, d]) => [day, d.tokens]));
}
