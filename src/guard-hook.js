#!/usr/bin/env node
'use strict';

/**
 * PreToolUse guard for phantom's headless recovery session. Reads the hook
 * event on stdin and its config as JSON -- from the file named in argv[2] when
 * one is given, otherwise from `PHANTOM_GUARD` in the environment:
 *   { neverTouch: string[], cwd: string, dryRun: boolean, testCommand: string|null, reportPath: string|null }
 * Exit 2 + one-line stderr reason blocks the tool call. Fails closed: any
 * unparsable input is a block.
 *
 * Scope, honestly stated: this is a lexical guard over a shell string. It
 * catches direct and lightly-obfuscated commands (quotes, `bash -c`,
 * backticks, `key=value`, symlinks, case-folding, single-segment globs). It
 * cannot see inside interpreters: `node -e`, `python -c`, or a script in the
 * repo can still read or write anything the process user can. The post-session
 * never-touch audit and the branch isolation are the backstops for writes.
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

// Word boundary at the start of a command: line start, separators, subshell
// openers, quotes and backticks (`bash -c "rm -rf x"`, `echo \`rm -rf x\``).
const B = '(?:^|[\\s;&|(`"\'])';
const GIT_OPTS = '(?:-\\w+(?:\\s+\\S+)?\\s+|--[\\w-]+(?:=\\S*)?\\s+)*';
const GIT_MUTATIONS = 'push|checkout|switch|reset|stash|rebase|merge|commit|clean|cherry-pick|am|apply|restore|worktree|remote|fetch|pull'
  + '|rm|mv|submodule|update-ref|symbolic-ref|filter-branch|filter-repo|gc|reflog|prune|replace|notes'
  + '|tag\\s+(?:-d|--delete|-f|--force)'
  + '|config\\s+(?:--(?:global|system|local|worktree|unset|unset-all|add|replace-all|edit|remove-section|rename-section)\\b|[\\w.-]+\\s+\\S)';

const DANGEROUS = [
  [new RegExp(B + 'rm\\s+(?:-\\w*\\s+|--\\w+\\s+)*(?:-\\w*[rR]|--recursive)'), 'recursive rm'],
  [new RegExp(B + 'rmdir\\b'), 'rmdir'],
  [new RegExp(B + 'find\\b.*\\s-delete\\b'), 'find -delete'],
  [new RegExp(B + 'find\\b.*-exec(?:dir)?\\s+(?:rm|rmdir|mv|chmod|chown)\\b'), 'find -exec'],
  [new RegExp(B + 'xargs\\s+(?:-\\w+\\s+)*(?:rm|rmdir|mv)\\b'), 'xargs rm'],
  [new RegExp('\\bgit\\s+' + GIT_OPTS + '(?:' + GIT_MUTATIONS + ')\\b(?!-)'), 'git mutation (phantom owns git)'],
  [/\bgit\s+branch\b.*\s(?:-D|-d|--delete|-M|-m|--move|-f|--force)\b/, 'git branch mutation'],
  [new RegExp(B + '(?:curl|wget\\w*)\\b'), 'network access'],
  [new RegExp(B + '(?:nc|ncat|netcat|ssh|scp|sftp|telnet|rsync|ftp)\\s'), 'network access'],
  [/\bnpm\s+(?:i|install|ci|add|uninstall|remove|rm|un|update|up|link|publish|exec)\b/, 'package install'],
  [/\byarn\s+(?:add|remove|install|upgrade|publish|dlx)\b/, 'package install'],
  [/\bpnpm\s+(?:i|install|add|remove|rm|update|up|publish|dlx)\b/, 'package install'],
  [/\bpip3?\s+(?:install|uninstall)\b/, 'package install'],
  [/\bmigrate\b/, 'migration'],
  [/\bprisma\s+(?:db|migrate)\b/, 'migration'],
  [/\bknex\b/, 'migration'],
  [/\bsequelize(?:-cli)?\s+db\b/, 'migration'],
  [/\bdrizzle-kit\s+(?:push|migrate|drop)\b/, 'migration'],
  [new RegExp(B + 'sudo\\b'), 'sudo'],
  [/\bchmod\b[^;&|]*\s(?:-\w*R\w*|--recursive)\b/, 'recursive chmod'],
  [new RegExp(B + 'chown\\b'), 'chown'],
  [new RegExp(B + 'mkfs\\b'), 'mkfs'],
  [new RegExp(B + 'dd\\s+(?:if|of)='), 'dd'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [/\bkill\s+(?:-(?:9|KILL|SIGKILL)\b|-s\s+(?:SIG)?KILL\b|-n\s+9\b)/, 'kill -9'],
  [new RegExp(B + '(?:pkill|killall)\\b'), 'process kill'],
  [new RegExp(B + '(?:docker|docker-compose|podman|kubectl|helm)\\b'), 'container/cluster command'],
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, 'destructive SQL'],
  [/\bTRUNCATE\b/i, 'destructive SQL'],
  [/\bnpx\s+(?:--\S+\s+)*(?:prisma|knex|sequelize|drizzle-kit|typeorm)\b/, 'migration tool'],
  [new RegExp(B + '(?:env|printenv)\\s*(?:$|[;&|>])'), 'environment dump'],
  [new RegExp(B + '(?:export|set|declare)\\s*(?:$|[;&|>])'), 'environment dump'],
];

/**
 * Deny the tool call, and make sure the user is told why.
 *
 * The exit code is what blocks; the reason is what makes the block
 * intelligible, both to Claude Code and to the permission_denials phantom logs
 * afterwards. Writes to a pipe complete asynchronously on Windows, so exiting
 * straight after the write dropped the reason and delivered a bare refusal --
 * on the win32 guard path specifically, which nothing exercises end to end.
 * Wait for the bytes, then let the process exit on its own.
 */
function fail(reason) {
  return new Promise((resolve) => {
    process.exitCode = 2;
    process.stderr.write('phantom guard: ' + reason + '\n', () => resolve());
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function loadMatcher() {
  try {
    return require('./never-touch').isNeverTouch;
  } catch {
    return fallbackIsNeverTouch;
  }
}

/**
 * The fallback matcher must stay a faithful copy of never-touch.js.
 *
 * It exists so the guard still blocks when never-touch.js cannot be loaded, but
 * it used to be a looser reimplementation, and every gap between the two was a
 * silent hole: it had no `{a,b}` alternation (so a neverTouch of `*.{pem,key}`
 * was ENTIRELY unenforced whenever the fallback was live), it did not trim the
 * glob, and it stripped neither a leading `/` nor a repeated `./`. The parity
 * test in test/guard-hook.test.js compares the two across the shipped defaults
 * and fails on any new divergence.
 */
function fallbackNormalizePath(p) {
  let out = String(p).replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/^\/+/, '');
}

function fallbackGlobToRegExp(glob) {
  const pattern = fallbackNormalizePath(String(glob).trim());
  const anyDir = !pattern.includes('/');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i++; }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) { re += '\\{'; i++; } else {
        const alts = pattern.slice(i + 1, close).split(',').map((a) => fallbackGlobToRegExp(a).source.slice(1, -1));
        re += '(?:' + alts.join('|') + ')';
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  if (anyDir) re = '(?:.*/)?' + re;
  return new RegExp('^' + re + '$', 'i');
}

function fallbackIsNeverTouch(rel, globs) {
  const p = fallbackNormalizePath(rel);
  if (!p) return false;
  for (const g of globs || []) {
    if (!g) continue;
    if (fallbackGlobToRegExp(g).test(p)) return true;
    if (g.endsWith('/**') && fallbackGlobToRegExp(g.slice(0, -3)).test(p)) return true;
  }
  return false;
}

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** realpath that also works for files that do not exist yet (resolves the nearest existing ancestor). */
function realpathDeep(p) {
  try { return fs.realpathSync(p); } catch { /* fall through */ }
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(realpathDeep(parent), path.basename(p));
}

/**
 * Every view of `target` relative to the repo: the lexical path and, when it
 * differs, the symlink-resolved one. A path that escapes the repo in any view
 * is reported as escaping.
 * @returns {{ abs: string, rel: string, escapes: boolean }[]}
 */
function pathViews(cwd, target) {
  const abs = path.resolve(cwd, String(target));
  const views = [[cwd, abs]];
  const real = realpathDeep(abs);
  const cwdReal = realpathOr(cwd);
  if (real !== abs || cwdReal !== cwd) views.push([cwdReal, real]);
  return views.map(([base, p]) => {
    const rel = path.relative(base, p);
    const escapes = rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel);
    return { abs: p, rel: rel.replace(/\\/g, '/'), escapes };
  });
}

function samePath(a, b) {
  return Boolean(a && b) && realpathOr(path.resolve(a)) === realpathOr(path.resolve(b));
}

/** Does `rel` (or, for paths outside the repo, the absolute path) hit a never-touch glob? */
function hitsNeverTouch(view, globs, isNeverTouch) {
  if (view.escapes) return isNeverTouch(view.abs.replace(/^[/\\]+/, ''), globs);
  return Boolean(view.rel) && isNeverTouch(view.rel, globs);
}

/**
 * Split a command line into candidate path tokens.
 *
 * Backslashes are stripped because a shell uses them to escape (`.\env`, `r\m`)
 * -- but on Windows a backslash is the path separator, and stripping it turned
 * `C:\Users\me\.env` into `C:Usersme.env`: no separator left, so the `.env`
 * glob missed, the path no longer looked like it escaped the repo, and the
 * guard allowed a write to a never-touch file. A guard that fails open is worse
 * than no guard, so on win32 each token is kept in both spellings and every
 * caller tests all of them.
 */
function tokenizeCommand(command, platform = process.platform) {
  const strip = (t) => t.replace(/^>+|^<+/, '').replace(/^\d*>+/, '');
  const out = [];
  for (const raw of String(command).split(/[\s;&|()`]+/)) {
    const unescaped = strip(raw.replace(/["'\\]/g, ''));
    if (unescaped) out.push(unescaped);
    if (platform === 'win32') {
      const keptSeparators = strip(raw.replace(/["']/g, ''));
      if (keptSeparators && keptSeparators !== unescaped) out.push(keptSeparators);
    }
  }
  return out;
}

/** Expand a single-segment shell glob (`.env*`, `conf/*.pem`) against the filesystem. */
function expandGlob(cwd, tok) {
  const dir = path.dirname(tok);
  const base = path.basename(tok);
  if (!/[*?[]/.test(base) || /[*?[]/.test(dir)) return [];
  let matcher;
  try {
    matcher = (loadMatcher() === fallbackIsNeverTouch ? fallbackGlobToRegExp : require('./never-touch').globToRegExp)(base);
  } catch {
    return [];
  }
  try {
    return fs.readdirSync(path.resolve(cwd, dir)).filter((e) => matcher.test(e)).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

function checkFile(tool, input, guard, isNeverTouch) {
  const target = input.file_path || input.notebook_path || input.path;
  if (!target) return tool === 'Read' || SEARCH_TOOLS.has(tool) ? null : 'missing file path';
  const views = pathViews(guard.cwd, target);
  const isReport = samePath(views[0].abs, guard.reportPath);
  if (isReport && tool === 'Write') return null;
  for (const v of views) {
    if (v.escapes) return 'path escapes the repository: ' + target;
    if (v.rel && isNeverTouch(v.rel, guard.neverTouch)) return 'never-touch path: ' + v.rel;
  }
  if (guard.dryRun && WRITE_TOOLS.has(tool)) return 'dry run: no writes except the report (' + tool + ' ' + views[0].rel + ')';
  return null;
}

function checkBash(input, guard, isNeverTouch) {
  const command = String(input.command || '');
  // Match against the raw string and a quote-stripped one so `git 'push'`,
  // `bash -c "rm -rf x"` and `r\m -rf x` read the same.
  const variants = [command, command.replace(/["'`\\]/g, '')];
  for (const [re, why] of DANGEROUS) {
    if (variants.some((v) => re.test(v))) return why + ': ' + command.slice(0, 120);
  }
  const pathGlobs = (guard.neverTouch || []).filter((g) => g !== 'node_modules/**');
  for (const tok of tokenizeCommand(command)) {
    const candidates = tok.includes('=') ? [tok, ...tok.split('=').slice(1)] : [tok];
    for (const cand of candidates) {
      if (!cand || cand.startsWith('-')) continue;
      const targets = [cand, ...expandGlob(guard.cwd, cand)];
      for (const t of targets) {
        for (const view of pathViews(guard.cwd, t)) {
          if (hitsNeverTouch(view, pathGlobs, isNeverTouch)) return 'command references never-touch path: ' + tok;
        }
      }
    }
  }
  if (/(?:^|\s)>{1,2}\s*\S*\.env\b/i.test(command)) return 'redirect into .env';
  return null;
}

async function main() {
  let event;
  let guard;
  try {
    event = JSON.parse(await readStdin());
    if (!event || typeof event !== 'object') throw new Error('not an object');
  } catch {
    return fail('could not parse hook input');
  }
  try {
    // argv[1] is this script; argv[2], when present, is a JSON file holding the
    // same payload. cmd.exe has no `VAR=value cmd` prefix, so a file is the only
    // way to hand the guard its config on Windows -- which is why the hook used
    // to be skipped there entirely, leaving `cat .env` to the permission rules
    // that do not cover Bash.
    const fromFile = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : '';
    guard = JSON.parse(fromFile || process.env.PHANTOM_GUARD || '');
    if (!guard || typeof guard !== 'object') throw new Error('not an object');
  } catch {
    return await fail('guard config is missing or malformed (argv file or PHANTOM_GUARD)');
  }
  guard.cwd = path.resolve(guard.cwd || event.cwd || process.cwd());
  guard.neverTouch = Array.isArray(guard.neverTouch) ? guard.neverTouch : [];
  const isNeverTouch = loadMatcher();
  const tool = String(event.tool_name || '');
  const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
  let reason = null;
  if (FILE_TOOLS.has(tool) || SEARCH_TOOLS.has(tool)) reason = checkFile(tool, input, guard, isNeverTouch);
  else if (tool === 'Bash') reason = checkBash(input, guard, isNeverTouch);
  if (reason) return fail(reason);
  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((err) => fail('internal error: ' + (err && err.message)));
}

module.exports = { DANGEROUS, tokenizeCommand, checkBash, checkFile, fallbackIsNeverTouch, pathViews, expandGlob };
