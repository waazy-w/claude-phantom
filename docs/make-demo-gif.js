#!/usr/bin/env node
'use strict';

/**
 * Render docs/demo.gif from the docs/demo.mp4 master that demo.tape records.
 *
 * A recording of phantom is mostly waiting: the terminal sits unchanged while
 * Claude works, and again while the tape's generous sleep runs out. Speeding
 * the whole clip up would race through the parts worth reading, so this finds
 * every visually static span with ffmpeg's freezedetect and caps each one at
 * `--hold` seconds. Everything that actually moves stays at real speed.
 *
 * Recording costs plan usage; this does not. Re-run it as often as you like.
 *
 * Usage: node docs/make-demo-gif.js [master.mp4] [out.gif] [options]
 *   --hold=2.5     max seconds any static span is allowed to last
 *   --fps=14       output frame rate
 *   --width=900    output width in pixels
 *   --colors=128   palette size
 *   --keep-under=1 static spans shorter than this are left alone (seconds)
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const flags = new Map(argv.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v = 'true'] = a.slice(2).split('=');
  return [k, v];
}));
const positional = argv.filter((a) => !a.startsWith('--'));
const num = (name, dflt) => (flags.has(name) ? Number(flags.get(name)) : dflt);

const src = positional[0] || 'docs/demo.mp4';
const out = positional[1] || 'docs/demo.gif';
const hold = num('hold', 2.5);
const fps = num('fps', 14);
const width = num('width', 900);
const colors = num('colors', 128);
const keepUnder = num('keep-under', 1);

if (!fs.existsSync(src)) {
  console.error('no master recording at ' + src);
  console.error('record one with: PHANTOM_REPO="$PWD" vhs docs/demo.tape');
  process.exit(1);
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    console.error(bin + ' not found; install it (brew install ffmpeg) and retry');
    process.exit(1);
  }
  return r;
}

const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).stdout.trim());
if (!Number.isFinite(duration)) {
  console.error('could not read the duration of ' + src);
  process.exit(1);
}

// freezedetect logs start/duration/end triples to stderr.
const detect = run('ffmpeg', ['-hide_banner', '-nostats', '-i', src, '-vf', 'freezedetect=n=-55dB:d=' + keepUnder, '-map', '0:v', '-f', 'null', '-']);
const freezes = [];
let pending = null;
for (const line of String(detect.stderr || '').split('\n')) {
  const start = /freeze_start: ([\d.]+)/.exec(line);
  if (start) { pending = { start: Number(start[1]) }; continue; }
  const end = /freeze_end: ([\d.]+)/.exec(line);
  if (end && pending) { freezes.push({ start: pending.start, end: Number(end[1]) }); pending = null; }
}
// A freeze still open at EOF runs to the end of the clip.
if (pending) freezes.push({ start: pending.start, end: duration });

/** Alternating [moving, static, moving, ...] spans covering the whole clip. */
const segments = [];
let cursor = 0;
for (const f of freezes) {
  const start = Math.max(f.start, cursor);
  const end = Math.min(f.end, duration);
  if (end - start <= 0.04) continue;
  if (start > cursor + 0.04) segments.push({ from: cursor, to: start, speed: 1 });
  const len = end - start;
  segments.push({ from: start, to: end, speed: len > hold ? len / hold : 1 });
  cursor = end;
}
if (cursor < duration - 0.04) segments.push({ from: cursor, to: duration, speed: 1 });

if (!segments.length) {
  console.error('nothing to render');
  process.exit(1);
}

const kept = segments.reduce((sum, s) => sum + (s.to - s.from) / s.speed, 0);
const trimmed = segments.filter((s) => s.speed > 1);
console.error(
  'master ' + duration.toFixed(1) + 's → ' + kept.toFixed(1) + 's  (' +
  trimmed.length + ' static span' + (trimmed.length === 1 ? '' : 's') + ' capped at ' + hold + 's, ' +
  'longest was ' + (trimmed.length ? Math.max(...trimmed.map((s) => s.to - s.from)).toFixed(0) : 0) + 's)'
);

const parts = segments.map((s, i) =>
  '[0:v]trim=' + s.from.toFixed(3) + ':' + s.to.toFixed(3) +
  ',setpts=(PTS-STARTPTS)' + (s.speed > 1 ? '/' + s.speed.toFixed(4) : '') + '[s' + i + ']');
const chain =
  parts.join(';') + ';' +
  segments.map((_, i) => '[s' + i + ']').join('') + 'concat=n=' + segments.length + ':v=1[cat];' +
  '[cat]fps=' + fps + ',scale=' + width + ':-1:flags=lanczos';

const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phantom-gif-'));
const palette = path.join(tmp, 'palette.png');

// Two passes: a palette built from the whole clip, then applied. A single pass
// bands the terminal's syntax colours badly.
const pass = (args) => {
  const r = run('ffmpeg', args);
  if (r.status !== 0) {
    console.error(String(r.stderr || '').split('\n').slice(-12).join('\n'));
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
};

pass(['-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex',
  chain + '[x];[x]palettegen=max_colors=' + colors + ':stats_mode=diff', '-y', palette]);
pass(['-hide_banner', '-loglevel', 'error', '-i', src, '-i', palette, '-filter_complex',
  chain + '[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle', '-loop', '0', '-y', out]);

fs.rmSync(tmp, { recursive: true, force: true });

const size = fs.statSync(out).size;
const secs = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).stdout.trim());
console.error('wrote ' + out + '  ' + (Number.isFinite(secs) ? secs.toFixed(1) + 's, ' : '') + (size / 1024 / 1024).toFixed(1) + ' MB');
