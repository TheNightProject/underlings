import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const seconds = (n) => n.toFixed(2);

function paced(length, speed = [], drops = []) {
  const cuts = [...new Set([0, length, ...speed.flatMap(([a, b]) => [a, b]), ...drops.flat()])].filter((t) => t >= 0 && t <= length).sort((a, b) => a - b);
  const spans = cuts.slice(0, -1).map((a, i) => [a, cuts[i + 1]]).filter(([a, b]) => !drops.some(([x, y]) => a >= x && b <= y));
  const factor = ([a, b]) => speed.find(([x, y]) => a >= x && b <= y)?.[2] ?? 1;
  const pieces = spans.map(([a, b], i) => `[0:v]trim=start=${seconds(a)}:end=${seconds(b)},setpts=(PTS-STARTPTS)/${factor([a, b])}[p${i}]`);
  return `${pieces.join(';')};${spans.map((_, i) => `[p${i}]`).join('')}concat=n=${spans.length}:v=1:a=0[v]`;
}

export function toGif(raw, { from, to, width = 960, fps = 12, colors = 128, lossy = 80, dither = 'bayer:bayer_scale=5', speed, drops, out }) {
  const shape = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`;
  ffmpeg('-ss', seconds(from), '-t', seconds(to - from), '-i', raw, '-filter_complex', `${paced(to - from, speed, drops)};[v]${shape}`, '-loop', '0', out);
  execFileSync('gifsicle', ['-O3', `--lossy=${lossy}`, '--no-comments', '--no-names', out, '-o', out]);
  return statSync(out).size;
}

export function duration(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
}

export function contactSheet(video, { out, frames = 6, width = 480, columns = 3 }) {
  const rate = frames / Math.max(0.5, duration(video));
  const filter = `fps=${rate.toFixed(4)},scale=${width}:-2,tile=${columns}x${Math.ceil(frames / columns)}`;
  ffmpeg('-i', video, '-vf', filter, '-frames:v', '1', out);
}

export function toMp4(raw, { from = 0, to, out }) {
  ffmpeg('-ss', seconds(from), ...(to ? ['-t', seconds(to - from)] : []), '-i', raw, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-movflags', '+faststart', '-an', out);
  return statSync(out).size;
}
