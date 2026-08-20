'use strict';

/**
 * Best-effort scrubbing of secrets from captured output before it is handed to
 * the recovery session. This is defence in depth, not a guarantee: the real
 * rails are the never-touch globs and the guard hook.
 */

const KEY_NAMES = '(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|client[_-]?secret|auth|credential|session[_-]?id|cookie|dsn|database_url|connection[_-]?string)';

const PATTERNS = [
  // KEY=value / KEY: value / "KEY": "value" where KEY looks sensitive
  { re: new RegExp(`((?:^|[\\s"'{,])[A-Za-z0-9_.-]*${KEY_NAMES}[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*["']?)([^\\s"',;&]{4,})`, 'gi'), sub: '$1[REDACTED]' },
  // Authorization headers
  { re: /(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:basic|bearer)?\s*[^\s"',;]+/gi, sub: '$1[REDACTED]' },
  { re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, sub: '$1[REDACTED]' },
  // Well-known token shapes
  { re: /\b(sk|pk|rk)-(?:live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}\b/g, sub: '[REDACTED]' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, sub: '[REDACTED]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, sub: '[REDACTED]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, sub: '[REDACTED]' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sub: '[REDACTED]' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, sub: '[REDACTED-JWT]' },
  // URLs with embedded credentials: scheme://user:pass@host
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+(@)/gi, sub: '$1[REDACTED]$2' },
  // PEM blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, sub: '[REDACTED-PRIVATE-KEY]' },
];

/**
 * @param {string} text
 * @returns {{ text: string, redactions: number }}
 */
function redact(text) {
  if (!text) return { text: text || '', redactions: 0 };
  let out = String(text);
  let redactions = 0;
  for (const { re, sub } of PATTERNS) {
    out = out.replace(re, (...m) => {
      redactions += 1;
      return sub.replace(/\$(\d)/g, (_, i) => m[Number(i)] || '');
    });
  }
  return { text: out, redactions };
}

module.exports = { redact };
