'use strict';

/**
 * Minimal glob matcher for never-touch rules. Supports `**`, `*`, `?`,
 * `{a,b}` alternation and a leading `./`. A pattern with no slash matches a
 * basename in any directory (`.env` matches `sub/.env`). Matching is
 * case-insensitive because the filesystems phantom mostly runs on are.
 */

function escapeRegExp(s) {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

function normalizePath(p) {
  let out = String(p).replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/^\/+/, '');
}

/**
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let pattern = normalizePath(glob.trim());
  const anyDir = !pattern.includes('/');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
        i++;
      } else {
        const alts = pattern.slice(i + 1, close).split(',').map((a) => globToRegExp(a).source.slice(1, -1));
        re += '(?:' + alts.join('|') + ')';
        i = close + 1;
      }
    } else {
      re += escapeRegExp(ch);
      i++;
    }
  }
  if (anyDir) re = '(?:.*/)?' + re;
  // Case-insensitive: macOS and Windows resolve `.ENV` to `.env`.
  return new RegExp('^' + re + '$', 'i');
}

/**
 * @param {string} relPath repo-relative path (posix or win32 separators)
 * @param {string[]} globs
 * @returns {boolean}
 */
function isNeverTouch(relPath, globs) {
  const p = normalizePath(relPath);
  if (!p) return false;
  for (const g of globs || []) {
    if (!g) continue;
    const re = globToRegExp(g);
    if (re.test(p)) return true;
    // A directory pattern like `**/secrets/**` also covers the directory itself.
    if (g.endsWith('/**') && globToRegExp(g.slice(0, -3)).test(p)) return true;
  }
  return false;
}

module.exports = { globToRegExp, isNeverTouch, normalizePath };
