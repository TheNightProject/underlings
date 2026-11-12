const SMALLEST = 200;
const LARGEST = 32_768;
const size = (n) => Number.isInteger(n) && n >= SMALLEST && n <= LARGEST;
const place = (n) => Number.isInteger(n) && Math.abs(n) <= LARGEST * 4;
const overlaps = (b, a) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;

// A saved window is kept only whole and of a sane size, and keeps its place only while a connected display still shows part of it.
export function keptBounds(saved, areas) {
  const { x, y, width, height } = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  if (!size(width) || !size(height)) return {};
  if (!place(x) || !place(y)) return { width, height };
  return areas().some((area) => overlaps({ x, y, width, height }, area)) ? { x, y, width, height } : { width, height };
}
