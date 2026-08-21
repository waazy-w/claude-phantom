'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const ui = require('../src/ui');

const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

test('colors are no-ops under NO_COLOR and on non-TTY streams', () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  try {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    ui.setStream(capture());
    assert.strictEqual(ui.colors.red('x'), 'x');
    delete process.env.NO_COLOR;
    assert.strictEqual(ui.colors.bold('x'), 'x');
    process.env.FORCE_COLOR = '1';
    assert.strictEqual(ui.colors.green('x'), '\u001b[32mx\u001b[39m');
    assert.strictEqual(ui.visibleLength(ui.colors.green('abc')), 3);
  } finally {
    ui.setStream(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('banner draws a box and log lines carry the prefix; verbose is gated', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    ui.banner(['one', 'longer line']);
    const lines = out.text().split('\n');
    assert.strictEqual(lines[0], '╭─────────────╮');
    assert.strictEqual(lines[1], '│ one         │');
    assert.strictEqual(lines[2], '│ longer line │');
    assert.strictEqual(lines[3], '╰─────────────╯');
    ui.log.info('hello');
    ui.log.warn('careful');
    ui.log.error('bad');
    ui.log.verbose('hidden');
    assert.ok(out.text().includes('phantom › hello\n'));
    assert.ok(out.text().includes('phantom › careful\n'));
    assert.ok(out.text().includes('phantom › bad\n'));
    assert.ok(!out.text().includes('hidden'));
    ui.log.setVerbose(true);
    ui.log.verbose('shown');
    assert.ok(out.text().includes('phantom › shown\n'));
  } finally {
    ui.log.setVerbose(false);
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

// What the spinner writes to wipe its own line before repainting: CR + erase-line.
const CLEAR = '\r\u001b[2K';

test('spinner paints a frame with elapsed time and clears the line when stopped', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  let clock = 1000;
  try {
    const spin = ui.spinner('thinking', { enabled: true, now: () => clock });
    assert.ok(out.text().endsWith('phantom › ⠋ thinking 0s'), out.text());
    clock = 1000 + 95 * 1000;
    spin.tick();
    assert.ok(out.text().endsWith('phantom › ⠙ thinking 1m 35s'), out.text());
    spin.update('still thinking');
    assert.ok(out.text().endsWith('phantom › ⠙ still thinking 1m 35s'), out.text());
    // A session can outlive an hour if maxMinutes is raised; "62m 05s" is wrong.
    clock = 1000 + 3725 * 1000;
    spin.tick();
    assert.ok(out.text().endsWith('phantom › ⠹ still thinking 1h 02m'), out.text());
    spin.stop();
    assert.ok(out.text().endsWith(CLEAR), 'stopping wipes the line');
    const before = out.text();
    spin.tick();
    spin.update('ignored');
    spin.stop();
    assert.strictEqual(out.text(), before, 'a stopped spinner writes nothing further');
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('a disabled spinner is silent, and log lines never collide with a live one', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    const quiet = ui.spinner('invisible', { enabled: false, now: () => 0 });
    quiet.tick();
    quiet.update('still invisible');
    quiet.stop();
    assert.strictEqual(out.text(), '', 'nothing is drawn when disabled');

    const spin = ui.spinner('working', { enabled: true, now: () => 0 });
    const started = out.text();
    ui.log.warn('heads up');
    // The line is wiped, the message is printed, then the spinner repaints
    // underneath it -- so the message survives intact on its own line.
    assert.strictEqual(out.text().slice(started.length),
      CLEAR + 'phantom › heads up\n' + CLEAR + 'phantom › ⠋ working 0s');
    spin.stop();
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('spinner follows the stream TTY flag when not told otherwise', () => {
  const tty = capture();
  tty.isTTY = true;
  ui.setStream(tty);
  try {
    const spin = ui.spinner('auto', { now: () => 0 });
    assert.ok(tty.text().includes('auto'), 'a TTY stream animates by default');
    spin.stop();
  } finally { ui.setStream(null); }

  const pipe = capture();
  ui.setStream(pipe);
  try {
    const spin = ui.spinner('auto', { now: () => 0 });
    spin.tick();
    spin.stop();
    assert.strictEqual(pipe.text(), '', 'a non-TTY stream stays silent');
  } finally { ui.setStream(null); }
});

const { Readable } = require('node:stream');

// A stdin stand-in that readline will treat as a real, non-TTY pipe.
const keystrokes = (...lines) => Readable.from([lines.join('\n') + '\n']);

test('ask resolves the chosen key, case-insensitively and trimmed', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    const answer = await ui.ask('merge, delete, or keep? [m/d/k]', {
      keys: ['m', 'd', 'k'], input: keystrokes('  M  '), enabled: true, timeoutMs: 0,
    });
    assert.strictEqual(answer, 'm');
    assert.ok(out.text().includes('merge, delete, or keep? [m/d/k]'));
  } finally { ui.setStream(null); }
});

test('ask re-asks on an unrecognised answer, then gives up rather than looping', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    assert.strictEqual(await ui.ask('pick', {
      keys: ['m', 'k'], input: keystrokes('yes', 'k'), enabled: true, timeoutMs: 0,
    }), 'k', 'a good answer after a bad one still counts');
    assert.ok(out.text().includes('please answer with one of: m, k'));

    // More bad input than attempts, so giving up has to come from the attempt
    // cap rather than from end-of-input -- otherwise this passes even with no
    // cap at all, and a user who keeps fat-fingering never gets their shell back.
    const noisy = capture();
    ui.setStream(noisy);
    assert.strictEqual(await ui.ask('pick', {
      keys: ['m', 'k'], input: keystrokes('no', 'nope', 'never', 'still no', 'and again'),
      enabled: true, timeoutMs: 0, attempts: 3,
    }), null, 'bad answers give up instead of asking forever');
    assert.strictEqual((noisy.text().match(/please answer with one of/g) || []).length, 2,
      'asks 3 times total: two retries after the first bad answer');
    assert.strictEqual((noisy.text().match(/pick/g) || []).length, 3, noisy.text());
  } finally { ui.setStream(null); }
});

test('ask returns null -- change nothing -- whenever no answer can be had', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    // Non-interactive: the whole point, so scripts and CI never block.
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m'), enabled: false }), null);
    assert.strictEqual(out.text(), '', 'a disabled prompt is never even printed');

    // End of input, e.g. stdin closed or redirected from /dev/null.
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: Readable.from([]), enabled: true, timeoutMs: 0 }), null);

    // A walked-away user must not hold the terminal forever.
    const never = new Readable({ read() { /* silence */ } });
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: never, enabled: true, timeoutMs: 20 }), null);
    never.push(null);
  } finally { ui.setStream(null); }
});

test('ask defaults to interactive only when both stdin and stderr are TTYs', async () => {
  const out = capture();
  const tty = () => { const r = new Readable({ read() { this.push(null); } }); r.isTTY = true; return r; };
  ui.setStream(out);
  try {
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m') }), null,
      'a non-TTY stderr suppresses the prompt even with a TTY stdin');
  } finally { ui.setStream(null); }

  const ttyOut = capture();
  ttyOut.isTTY = true;
  ui.setStream(ttyOut);
  try {
    const piped = keystrokes('m');
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: piped, timeoutMs: 0 }), null,
      'a piped stdin suppresses the prompt even with a TTY stderr');
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: tty(), timeoutMs: 20 }), null,
      'both TTY: the prompt runs (this one ends at EOF)');
    assert.ok(ttyOut.text().includes('q'), 'the question reached the terminal');
  } finally { ui.setStream(null); }
});

test('setStream stops a live spinner so it cannot repaint over the next stream', () => {
  const first = capture();
  first.isTTY = true;
  ui.setStream(first);
  ui.spinner('orphan', { now: () => 0 });
  const second = capture();
  ui.setStream(second);
  try {
    ui.log.info('after');
    assert.strictEqual(second.text(), 'phantom › after\n', 'no leftover clear/redraw from the old spinner');
  } finally { ui.setStream(null); }
});
