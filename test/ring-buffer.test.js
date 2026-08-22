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
    // Collect twice before each sample. V8 releases ArrayBuffer backing stores on
    // a background sweeper, so the first gc() returns while a variable slice of
    // the dead chunks is still counted in arrayBuffers -- sampling there measures
    // sweeper timing, not retention, and drifts by hundreds of KB between runs.
    // The second gc() observes the finished sweep, which is stable to the byte.
    const measure = () => { global.gc(); global.gc(); return process.memoryUsage(); };
    pass();
    const before = measure();
    pass();
    const after = measure();
    process.stdout.write(JSON.stringify({ size: rb.size, rss: after.rss - before.rss, ab: after.arrayBuffers - before.arrayBuffers }));
  `;
  const out = execFileSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' });
  const m = JSON.parse(out);
  assert.strictEqual(m.size, 256 * 1024);
  // RSS is an OS-level number that moves with heap growth and fragmentation, so
  // it only guards against gross leaks. The swept ArrayBuffer total is exact:
  // retaining even one 64 KB chunk past the ring's bound fails here.
  assert.ok(m.rss < 50 * 1024 * 1024, 'rss grew by ' + m.rss + ' bytes');
  assert.ok(m.ab < 64 * 1024, 'live ArrayBuffers grew by ' + m.ab + ' bytes');
});

test('memory is bounded by bytes retained, not by how many writes produced them', () => {
  // Cost used to be driven by the NUMBER of chunks: every write became its own
  // Buffer object and the index array grew to twice the live chunk count before
  // compacting. A child doing unbuffered one-byte writes -- a spinner, a
  // progress bar, anything calling write() per character -- cost ~130 bytes of
  // heap per retained byte: 30 MB of heap and 255 MB of RSS for a 256 KB tail.
  // The existing memory test only pushed 64 KB chunks, so it never saw this.
  if (typeof global.gc !== 'function') {
    // Node must be started with --expose-gc for a trustworthy reading; without
    // it, assert the structural property that causes the blow-up instead.
    const rb = new RingBuffer(262144);
    for (let i = 0; i < 400000; i++) rb.push('x');
    assert.strictEqual(rb.size, 262144);
    assert.ok(rb._chunks.length < 100,
      'small writes are coalesced into blocks, not kept one Buffer each: ' + rb._chunks.length);
    return;
  }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const rb = new RingBuffer(262144);
  for (let i = 0; i < 400000; i++) rb.push('x');
  global.gc();
  const perByte = (process.memoryUsage().heapUsed - before) / rb.size;
  assert.strictEqual(rb.size, 262144);
  assert.ok(perByte < 4, 'heap per retained byte should be near 1, was ' + perByte.toFixed(1));
});

test('a retained oversized chunk does not pin the whole allocation it came from', () => {
  // subarray returns a VIEW, so keeping one kept the entire original buffer
  // alive: a 64 MB read holding 64 MB for the life of the run to retain 256 KB.
  const rb = new RingBuffer(262144);
  const huge = Buffer.alloc(64 * 1024 * 1024, 0x61);
  rb.push(huge);
  assert.strictEqual(rb.size, 262144);
  const held = rb.toBuffer();
  assert.ok(held.buffer.byteLength < 1024 * 1024,
    'the retained tail owns a small allocation, not a view into the 64 MB one: ' + held.buffer.byteLength);
});

test('the tail decodes as valid UTF-8 even when eviction cuts a character in half', () => {
  // Eviction cuts on a byte boundary, so the retained head can begin partway
  // through a multi-byte character. Decoding that produced U+FFFD at the start
  // of the tail, which flowed into the crash JSON, the prompt and the report
  // code block for any non-ASCII output. report.js walks continuation bytes for
  // exactly this reason; the ring did not.
  const rb = new RingBuffer(8);
  rb.push('日本');
  rb.push('xyz');
  const s = rb.toString();
  assert.ok(!s.includes('�'), 'no replacement characters: ' + JSON.stringify(s));
  assert.strictEqual(Buffer.from(s, 'utf8').toString('utf8'), s, 'round-trips as valid UTF-8');
  assert.ok(s.endsWith('xyz'));

  // Emoji are 4 bytes, so the cut can land at any of three offsets.
  for (const max of [5, 6, 7, 8, 9]) {
    const r = new RingBuffer(max);
    r.push('👻👻');
    r.push('ok');
    const out = r.toString();
    assert.ok(!out.includes('�'), 'max=' + max + ' gave ' + JSON.stringify(out));
  }
});
