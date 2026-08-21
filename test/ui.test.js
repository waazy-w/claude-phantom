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
