'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ANSI_RE, stripAnsi } = require('../src/ansi');

test('strips SGR colour sequences, including the reset', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.strictEqual(stripAnsi('\x1b[1;38;5;204mbold pink\x1b[39m'), 'bold pink');
});

test('strips non-colour CSI sequences: cursor moves, erases, private modes', () => {
  assert.strictEqual(stripAnsi('a\x1b[2Kb\x1b[1Ac'), 'abc');
  assert.strictEqual(stripAnsi('\x1b[?25lhidden\x1b[?25h'), 'hidden');
  assert.strictEqual(stripAnsi('\x1b[Hhome'), 'home');
});

test('strips OSC sequences terminated by BEL or by ST', () => {
  // Terminal title / hyperlink escapes carry arbitrary text and must not survive
  // into the crash JSON, and their two terminators are handled by one alternation.
  assert.strictEqual(stripAnsi('\x1b]0;window title\x07after'), 'after');
  assert.strictEqual(stripAnsi('\x1b]8;;https://example.com\x1b\\link'), 'link');
});

test('a path split by an escape is rejoined so stack traces stay parseable', () => {
  // The motivating case: colourised traces break a path in the middle.
  assert.strictEqual(stripAnsi('at \x1b[39mfoo.js\x1b[22m:12:5'), 'at foo.js:12:5');
});

test('a token split by an escape is rejoined so the redactor can match it', () => {
  // Escapes inside a secret would otherwise hide it from a pattern-based redactor.
  const split = 'sk-ant-\x1b[0mapi03-SECRET';
  assert.strictEqual(stripAnsi(split), 'sk-ant-api03-SECRET');
  assert.ok(!/\x1b/.test(stripAnsi(split)));
});

test('null and undefined become the empty string, other values are coerced', () => {
  assert.strictEqual(stripAnsi(null), '');
  assert.strictEqual(stripAnsi(undefined), '');
  assert.strictEqual(stripAnsi(''), '');
  assert.strictEqual(stripAnsi(0), '0');
  assert.strictEqual(stripAnsi(false), 'false');
  assert.strictEqual(stripAnsi(Buffer.from('\x1b[31mbuf\x1b[0m')), 'buf');
});

test('leaves plain text, lone ESC and stray brackets alone', () => {
  assert.strictEqual(stripAnsi('no escapes here'), 'no escapes here');
  assert.strictEqual(stripAnsi('a[31mb'), 'a[31mb');
  assert.strictEqual(stripAnsi('100% [====] done'), '100% [====] done');
});

test('ANSI_RE is global, so repeated use does not skip matches', () => {
  // Guards the shared exported regex against lastIndex leaking between calls,
  // which would make every other invocation miss the first escape.
  const s = '\x1b[31ma\x1b[0m';
  assert.strictEqual(stripAnsi(s), 'a');
  assert.strictEqual(stripAnsi(s), 'a');
  assert.strictEqual(ANSI_RE.lastIndex, 0);
});
