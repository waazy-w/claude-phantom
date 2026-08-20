'use strict';

/**
 * Terminal escape sequences in captured output.
 *
 * Colour is display-only: the child's live output goes to the terminal
 * untouched, but the captured tail is analysed, not shown. Left in, escapes
 * split file paths in stack traces (`\x1b[39mfoo.js`), land in the crash JSON,
 * the prompt, the branch slug and the post-mortem, and can hide a secret from
 * the redactor by breaking the middle of a token.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * @param {unknown} text
 * @returns {string}
 */
function stripAnsi(text) {
  return String(text === null || text === undefined ? '' : text).replace(ANSI_RE, '');
}

module.exports = { ANSI_RE, stripAnsi };
