'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isNeverTouch } = require('./never-touch');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 50000;
const MAX_DEPTH = 16;

/**
 * Records size/mtime/inode for every file matching a never-touch glob, so that
 * edits to files git cannot see (a gitignored `.env`) are still detected.
 * Contents are never read.
 *
 * @param {string} root repository root
 * @param {string[]} globs never-touch globs
 * @param {{ skipPrefixes?: string[] }} [opts] repo-relative prefixes to ignore (e.g. `.phantom`)
 * @returns {Map<string, { size: number, mtimeMs: number, ino: number }>} keyed by repo-relative path
 */
function snapshotNeverTouch(root, globs, opts = {}) {
  const snap = new Map();
  const skipPrefixes = (opts.skipPrefixes || []).map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '') + '/');
  let budget = MAX_ENTRIES;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (--budget <= 0) return;
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || skipPrefixes.some((p) => (relPath + '/').startsWith(p))) continue;
        walk(path.join(dir, ent.name), relPath, depth + 1);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (!isNeverTouch(relPath, globs)) continue;
      try {
        const st = fs.lstatSync(path.join(dir, ent.name));
        snap.set(relPath, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(root, '', 0);
  return snap;
}

/**
 * @param {Map<string, object>} before
 * @param {Map<string, object>} after
 * @returns {{ modified: string[], added: string[], removed: string[] }}
 */
function diffSnapshots(before, after) {
  const modified = [];
  const added = [];
  const removed = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (!b) added.push(p);
    else if (b.size !== a.size || b.mtimeMs !== a.mtimeMs || b.ino !== a.ino) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { modified: modified.sort(), added: added.sort(), removed: removed.sort() };
}

module.exports = { snapshotNeverTouch, diffSnapshots };
