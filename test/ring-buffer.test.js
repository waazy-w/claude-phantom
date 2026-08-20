'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { RingBuffer } = require('../src/ring-buffer');

test('keeps everything while under the limit and preserves order', () => {
  const rb = new RingBuffer(64);
  rb.push('hello ');
  rb.push(Buffer.from('world'));
  assert.strictEqual(rb.toString(), 'hello world');
  assert.strictEqual(rb.size, 11);
});

test('drops oldest bytes first, including partial chunks', () => {
  const rb = new RingBuffer(10);
  rb.push('abcdef');
  rb.push('ghij');
  rb.push('kl');
  assert.strictEqual(rb.size, 10);
  assert.strictEqual(rb.toString(), 'cdefghijkl');
});

test('a single chunk larger than the limit keeps its tail', () => {
  const rb = new RingBuffer(5);
  rb.push('0123456789');
  assert.strictEqual(rb.toString(), '56789');
  rb.push('ab');
  assert.strictEqual(rb.toString(), '789ab');
});

test('ignores empty chunks and rejects bad sizes', () => {
  const rb = new RingBuffer(8);
  rb.push('');
  rb.push(Buffer.alloc(0));
  assert.strictEqual(rb.size, 0);
  assert.throws(() => new RingBuffer(0), RangeError);
});

test('stays bounded over 50 MB of input', () => {
  const max = 256 * 1024;
  const chunk = 64 * 1024;
  const rb = new RingBuffer(max);
  const total = 50 * 1024 * 1024;
  for (let i = 0; i < total / chunk; i++) {
    rb.push(Buffer.alloc(chunk, i & 0xff));
    assert.ok(rb.size <= max + chunk, 'size ' + rb.size + ' exceeded bound at chunk ' + i);
  }
  assert.strictEqual(rb.size, max);
  const buf = rb.toBuffer();
  assert.strictEqual(buf.length, max);
  assert.strictEqual(buf[buf.length - 1], (total / chunk - 1) & 0xff);
  assert.strictEqual(buf[0], (total / chunk - 4) & 0xff);
});

test('does not retain memory: RSS and live ArrayBuffers stay flat across 50 MB', () => {
  // Runs in a child with --expose-gc and collects every 4 MB so the measurement
  // reflects what the ring retains, not how lazily V8 frees dead backing stores.
  const script = `
    const { RingBuffer } = require(${JSON.stringify(require.resolve('../src/ring-buffer'))});
    const max = 256 * 1024, chunk = 64 * 1024, total = 50 * 1024 * 1024;
    const rb = new RingBuffer(max);
    const pass = () => {
      for (let i = 0; i < total / chunk; i++) {
        rb.push(Buffer.alloc(chunk, i & 0xff));
        if (i % 64 === 63) global.gc();
      }
    };
    // Collect immediately before each sample: chunks pushed since the loop's
    // last gc() are dead but not yet freed, and counting them measures V8's
    // collection timing rather than what the ring retains.
    const measure = () => { global.gc(); return process.memoryUsage(); };
    pass();
    const before = measure();
    pass();
    const after = measure();
    process.stdout.write(JSON.stringify({ size: rb.size, rss: after.rss - before.rss, ab: after.arrayBuffers - before.arrayBuffers }));
  `;
  const out = execFileSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' });
  const m = JSON.parse(out);
  assert.strictEqual(m.size, 256 * 1024);
  assert.ok(m.rss < 50 * 1024 * 1024, 'rss grew by ' + m.rss + ' bytes');
  assert.ok(m.ab < 2 * 1024 * 1024, 'live ArrayBuffers grew by ' + m.ab + ' bytes');
});
