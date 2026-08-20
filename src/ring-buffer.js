'use strict';

/**
 * Byte-bounded FIFO of output chunks. Oldest data is dropped first. Holds at
 * most `maxBytes` plus the most recent chunk; compaction is lazy so push is
 * O(1) amortized and never re-concatenates the whole buffer.
 */
class RingBuffer {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError('RingBuffer maxBytes must be a positive number');
    }
    this.maxBytes = Math.floor(maxBytes);
    /** @type {Buffer[]} */
    this._chunks = [];
    this._size = 0;
    this._head = 0; // index of the first live chunk in _chunks
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (buf.length === 0) return;
    if (buf.length >= this.maxBytes) {
      // A single oversized chunk: keep only its tail and drop everything else.
      buf = buf.subarray(buf.length - this.maxBytes);
      this._chunks = [buf];
      this._head = 0;
      this._size = buf.length;
      return;
    }
    this._chunks.push(buf);
    this._size += buf.length;
    while (this._size > this.maxBytes) {
      const oldest = this._chunks[this._head];
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
    if (this._head > 0) this._compact();
    return Buffer.concat(this._chunks, this._size);
  }

  /** @returns {string} retained output decoded as UTF-8 */
  toString() {
    return this.toBuffer().toString('utf8');
  }
}

module.exports = { RingBuffer };
