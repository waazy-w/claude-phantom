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
