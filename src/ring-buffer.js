'use strict';

/**
 * Byte-bounded FIFO of output chunks. Oldest data is dropped first.
 *
 * Small writes are coalesced into blocks before they are retained. Without
 * that, cost was driven by the NUMBER of chunks rather than their size: every
 * write became its own Buffer object, the index array grew to twice the live
 * chunk count before compacting, and a child doing unbuffered one-byte writes
 * (a spinner, a progress bar, anything calling write() per character) cost
 * ~130 bytes of heap per retained byte -- 30 MB of heap and 255 MB of RSS for a
 * 256 KB tail, measured. The shipped memory test only pushed 64 KB chunks, so
 * it never saw it.
 */

/**
 * Coalescing block size. Large enough that per-chunk overhead disappears,
 * small enough that eviction granularity stays reasonable.
 */
const BLOCK_BYTES = 64 * 1024;

class RingBuffer {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError('RingBuffer maxBytes must be a positive number');
    }
    this.maxBytes = Math.floor(maxBytes);
    this._blockBytes = Math.min(BLOCK_BYTES, this.maxBytes);
    /** @type {Buffer[]} retained blocks, oldest first from _head */
    this._chunks = [];
    /** @type {Buffer|null} partially filled newest block */
    this._pending = null;
    this._pendingLen = 0;
    this._size = 0;
    this._head = 0; // index of the first live chunk in _chunks
  }

  /** Move the partially filled block into the retained list. */
  _flushPending() {
    if (!this._pendingLen) { this._pending = null; return; }
    // subarray would keep the whole _blockBytes allocation alive for a few
    // retained bytes; a copy is cheaper to hold and lets the block be reused.
    this._chunks.push(Buffer.from(this._pending.subarray(0, this._pendingLen)));
    this._pending = null;
    this._pendingLen = 0;
  }

  _evict() {
    while (this._size > this.maxBytes) {
      const oldest = this._chunks[this._head];
      if (oldest === undefined) break; // everything live is in _pending
      const excess = this._size - this.maxBytes;
      if (oldest.length <= excess) {
        this._chunks[this._head] = null;
        this._head++;
        this._size -= oldest.length;
      } else {
        this._chunks[this._head] = oldest.subarray(excess);
        this._size -= excess;
      }
    }
    if (this._head > 64 && this._head > this._chunks.length / 2) this._compact();
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (buf.length === 0) return;

    if (buf.length >= this.maxBytes) {
      // A single oversized chunk: keep only its tail and drop everything else.
      // Buffer.from copies -- subarray is a VIEW, so retaining one would pin the
      // entire original allocation (a 64 MB read holding 64 MB alive to keep
      // 256 KB) for as long as the run lasts.
      this._chunks = [Buffer.from(buf.subarray(buf.length - this.maxBytes))];
      this._pending = null;
      this._pendingLen = 0;
      this._head = 0;
      this._size = this._chunks[0].length;
      return;
    }

    if (buf.length >= this._blockBytes) {
      // Already block-sized: retain it directly rather than copying through the
      // accumulator. Copy anyway when it is a small view of a big allocation.
      this._flushPending();
      this._chunks.push(buf.byteOffset === 0 && buf.length === buf.buffer.byteLength ? buf : Buffer.from(buf));
      this._size += buf.length;
      this._evict();
      return;
    }

    let offset = 0;
    while (offset < buf.length) {
      if (!this._pending) this._pending = Buffer.allocUnsafe(this._blockBytes);
      const room = this._blockBytes - this._pendingLen;
      const take = Math.min(room, buf.length - offset);
      buf.copy(this._pending, this._pendingLen, offset, offset + take);
      this._pendingLen += take;
      this._size += take;
      offset += take;
      if (this._pendingLen === this._blockBytes) this._flushPending();
    }
    this._evict();
  }

  _compact() {
    this._chunks = this._chunks.slice(this._head);
    this._head = 0;
  }

  /** @returns {number} bytes currently retained */
  get size() {
    return this._size;
  }

  /** @returns {Buffer} */
  toBuffer() {
    this._flushPending();
    if (this._head > 0) this._compact();
    return Buffer.concat(this._chunks, this._size);
  }

  /**
   * @returns {string} retained output decoded as UTF-8
   *
   * Eviction cuts on a byte boundary, so the retained head can begin partway
   * through a multi-byte character; decoding that yielded U+FFFD replacement
   * characters at the start of the tail, which then flowed into the crash JSON,
   * the prompt and the report code block for any non-ASCII output. report.js
   * already walks continuation bytes for exactly this reason (`trimBytes`); the
   * ring did not.
   */
  toString() {
    const buf = this.toBuffer();
    let start = 0;
    // 10xxxxxx is a continuation byte: skip until a character actually starts.
    while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start++;
    return buf.toString('utf8', start);
  }
}

module.exports = { RingBuffer, BLOCK_BYTES };
