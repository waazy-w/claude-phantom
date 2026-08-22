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
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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
  // `<` and `>` are separators, not ordinary characters. Without them in the
  // split class a redirect written without a space -- `cat<.env`, `cat 0<.env`,
  // `echo pwned>.env` -- produced one token like `cat<.env`, which matched no
  // never-touch glob and no path, so the guard allowed it. The spaced forms
  // were caught all along, which is what made the gap easy to miss. The write
  // form is the dangerous one: it destroys a gitignored .env outright.
  for (const raw of String(command).split(/[\s;&|()`<>]+/)) {
    const unescaped = strip(raw.replace(/["'\\]/g, ''));
    if (unescaped) out.push(unescaped);
    if (platform === 'win32') {
      const keptSeparators = strip(raw.replace(/["']/g, ''));
      if (keptSeparators && keptSeparators !== unescaped) out.push(keptSeparators);
    }
  }
  return out;
}

/**
 * Shell-glob semantics, for deciding what a token could match ON DISK.
 *
 * Deliberately not the never-touch matcher: that one escapes `[` and `]`,
 * because a never-touch rule naming a literal bracket is likelier than one
 * wanting a character class. Reusing it here meant `.[e]nv` compiled to
 * /^\.\[e\]nv$/ and matched neither the file on disk nor the `.env` rule --
 * so `cat .[e]nv` was allowed, and the shell then expanded it and printed the
 * secret. Expansion has to follow the shell's rules, not the rule file's.
 */
function shellGlobToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; continue; }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = end;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Expand a single-segment shell glob (`.env*`, `conf/*.pem`, `.[e]nv`) against the filesystem. */
function expandGlob(cwd, tok) {
  const dir = path.dirname(tok);
  const base = path.basename(tok);
  if (!/[*?[]/.test(base) || /[*?[]/.test(dir)) return [];
  let matcher;
  try {
    matcher = shellGlobToRegExp(base);
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

/**
 * Shapes that write, for the dry-run check.
 *
 * `--dry-run` promises the tree is not touched, and the file tools honoured it
 * (`checkFile` refuses every WRITE_TOOL) -- but Bash had no dry-run branch at
 * all, so `echo patched > src/app.js`, `sed -i`, and `tee` all sailed through.
 * That is worse in dry run than anywhere else: no branch is created, so the
 * writes land on the user's own checked-out branch with nothing to revert them,
 * while the banner says "nothing changed".
 *
 * Prevention beats detection here, so this errs toward refusing: a false
 * positive costs the session one tool call it can route through Read/Grep.
 */
const DRY_RUN_WRITERS = [
  // A redirect that targets a file. `2>&1` and `>&2` duplicate a descriptor
  // rather than writing, so they are deliberately not matched.
  [/(?:^|[^0-9&>])>>?\s*(?![&|])\S/, 'output redirection'],
  [/(?:^|[|;&\s])tee\b/, 'tee'],
  [/(?:^|[|;&\s])sed\s+(?:[^|;&]*\s)?-[a-zA-Z]*i/, 'sed -i'],
  // Specific before generic, so the reason names the actual command.
  [/(?:^|[|;&\s])git\s+(?:apply|add|commit|checkout|restore|stash|clean|mv|rm|revert|merge|rebase|reset)\b/, 'a git command that writes'],
  [/(?:^|[|;&\s])(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|link|ci)\b/, 'a package install'],
  [/(?:^|[|;&\s])(?:pip|pip3)\s+(?:install|uninstall)\b/, 'a package install'],
  [/(?:^|[|;&\s])(?:chmod|chown)\b/, 'a permission change'],
  [/(?:^|[|;&\s])mkdir\b/, 'mkdir'],
  [/(?:^|[|;&\s])(?:rm|rmdir|mv|cp|touch|truncate|dd|ln|install|patch|shred)\b/, 'a file-mutating command'],
];

function dryRunWriteReason(command) {
  for (const [re, why] of DRY_RUN_WRITERS) if (re.test(command)) return why;
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
  if (guard.dryRun) {
    const why = dryRunWriteReason(command);
    if (why) return 'dry run: no writes (' + why + '): ' + command.slice(0, 120);
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
  if (/>{1,2}\s*['"]?\S*\.env\b/i.test(command)) return 'redirect into .env';

  const bulk = bulkReadReason(command, guard, isNeverTouch);
  if (bulk) return bulk;

  const outside = readsOutsideRepo(command, guard.cwd);
  if (outside) return 'command reads outside the repository: ' + outside;

  return null;
}

/**
 * Commands that read many files without ever naming one.
 *
 * The path checks above are lexical: they can only refuse a path that appears
 * in the command line. `grep -r . .`, `git log -p`, `git show HEAD:.env`,
 * `find . -exec cat {} +` and `tar cf - .` all read every file in the repo --
 * including a gitignored `.env` and anything under `secrets/` -- while naming
 * none of them, and `Bash(grep *)`, `Bash(git log *)` and `Bash(git show *)`
 * are all on the allowlist. Verified in a sandbox: `grep -rs . .` printed the
 * AWS key, and `git log -p` printed it out of history.
 *
 * These are refused wholesale rather than parsed for safety. A recursive
 * content sweep is not something a crash fix needs, and Read/Grep -- which the
 * guard can actually inspect, and which are already allowlisted -- do the same
 * job under supervision.
 */
const BULK_READERS = [
  [/(?:^|[|;&\s])find\b[^|;&]*-(?:exec|execdir|ok)\b/, 'find -exec runs a command over every match'],
  [/(?:^|[|;&\s])(?:tar|zip|7z|rar)\b/, 'archiving reads whole directories'],
  [/(?:^|[|;&\s])(?:base64|xxd|od|strings)\b/, 'binary dump can smuggle file contents'],
  [/(?:^|[|;&\s])xargs\b/, 'xargs runs a command over a list this guard cannot see'],
  [/(?:^|[|;&\s])git\s+cat-file\b/, 'git cat-file reads blobs directly'],
];

/**
 * A recursive content search, and the roots it would walk.
 *
 * Short flags bundle, so `-rs` is -r and -s and an `\b` after the r never
 * matches: `grep -rs . .` was the exact command that printed the AWS key out of
 * a sandbox .env.
 *
 * @returns {string[]|null} search roots (repo-relative or absolute), or null
 */
function recursiveSearchRoots(command) {
  const m = /(?:^|[|;&\s])(?:grep|rg|ag|ack)\b([^|;&]*)/.exec(command);
  if (!m) return null;
  const rest = m[1];
  if (!/\s--recursive\b|\s-[a-zA-Z]*[rR]/.test(rest)) return null;
  const args = rest.split(/\s+/).filter(Boolean).filter((a) => !a.startsWith('-'));
  // grep RECURSIVE takes PATTERN then paths; with no path it walks the cwd.
  const roots = args.slice(1).map((a) => a.replace(/^["']|["']$/g, ''));
  return roots.length ? roots : ['.'];
}

const WALK_BUDGET = 20000;
const WALK_DEPTH = 12;

/**
 * Does any never-touch file live under `dir`?
 *
 * This is what makes the recursive-search check scope-aware instead of a flat
 * ban. `grep -rn TODO src` cannot reach a root-level .env and is exactly the
 * kind of search a fix session legitimately runs, so refusing it would push the
 * session toward worse tools for no safety gain. `grep -r . .` walks the repo
 * root, where .env and secrets/ live, and is refused.
 */
function neverTouchUnder(cwd, dir, globs, isNeverTouch) {
  const base = path.resolve(cwd, dir);
  let budget = WALK_BUDGET;
  const walk = (abs, depth) => {
    if (depth > WALK_DEPTH || budget <= 0) return false;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return false; }
    for (const ent of entries) {
      if (--budget <= 0) return false;
      const full = path.join(abs, ent.name);
      const rel = path.relative(cwd, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        if (isNeverTouch(rel + '/', globs) || isNeverTouch(rel, globs)) return true;
        if (walk(full, depth + 1)) return true;
        continue;
      }
      if (isNeverTouch(rel, globs)) return true;
    }
    return false;
  };
  try {
    if (!fs.statSync(base).isDirectory()) return false;
  } catch {
    return false;
  }
  return walk(base, 0);
}

/** Tracked files that match a never-touch glob -- what `git log -p` could expose. */
function trackedNeverTouch(cwd, globs, isNeverTouch) {
  try {
    const out = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (out.status !== 0 || !out.stdout) return false;
    return out.stdout.split('\n').some((f) => f && isNeverTouch(f.trim(), globs));
  } catch {
    return false;
  }
}

function bulkReadReason(command, guard, isNeverTouch) {
  for (const [re, why] of BULK_READERS) {
    if (re.test(command)) return 'bulk read refused — ' + why + ': ' + command.slice(0, 120);
  }
  const globs = (guard && guard.neverTouch) || [];
  const cwd = (guard && guard.cwd) || process.cwd();

  const roots = recursiveSearchRoots(command);
  if (roots && roots.some((r) => neverTouchUnder(cwd, r, globs, isNeverTouch))) {
    return 'bulk read refused — a recursive search of ' + roots.join(', ')
      + ' would read never-touch files (narrow the path, or use the Grep tool): ' + command.slice(0, 120);
  }

  // `git show <rev>:<path>` names its path after a colon, where the tokenizer
  // never sees it as a path at all -- `git show HEAD:.env` read the secret
  // straight out of history.
  const showPath = /(?:^|[|;&\s])git\s+show\s+[^\s|;&]*:([^\s|;&]+)/.exec(command);
  if (showPath && isNeverTouch(showPath[1].replace(/^\.?\//, ''), globs)) {
    return 'bulk read refused — git show reads that file out of history: ' + showPath[1];
  }

  // Patch output and git grep expose file CONTENT, so they only matter when the
  // repo actually tracks something never-touch (a committed *.pem, say).
  if (/(?:^|[|;&\s])git\s+(?:log|show|diff)\b[^|;&]*\s-p\b/.test(command)
      || /(?:^|[|;&\s])git\s+grep\b/.test(command)) {
    if (trackedNeverTouch(cwd, globs, isNeverTouch)) {
      return 'bulk read refused — this repository tracks never-touch files and that command prints their contents: ' + command.slice(0, 120);
    }
  }
  return null;
}

/**
 * Any absolute or home-relative path in the command that leaves the repo.
 *
 * `checkFile` hard-denies an escaping path for every file tool, but `checkBash`
 * only glob-tested them -- so `cat ~/.ssh/id_rsa`, `cat ~/.aws/credentials` and
 * `cat /etc/passwd` were allowed through Bash while the Read tool refused the
 * same paths, and the prompt's instruction to "work only inside the repository"
 * was not enforced on the one tool that could ignore it. `~` was never expanded
 * either, so it was missed twice over.
 *
 * @returns {string|null} the offending token
 */
function readsOutsideRepo(command, cwd) {
  const home = os.homedir();
  for (const tok of tokenizeCommand(command)) {
    if (!tok || tok.startsWith('-')) continue;
    let candidate = tok;
    if (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\')) {
      if (!home) continue;
      candidate = path.join(home, candidate.slice(1));
    } else if (!path.isAbsolute(candidate)) {
      continue;
    }
    const views = pathViews(cwd, candidate);
    if (views.some((v) => v.escapes)) return tok;
  }
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

module.exports = { DANGEROUS, DRY_RUN_WRITERS, dryRunWriteReason, BULK_READERS, bulkReadReason, recursiveSearchRoots, neverTouchUnder, readsOutsideRepo, shellGlobToRegExp, tokenizeCommand, checkBash, checkFile, fallbackIsNeverTouch, pathViews, expandGlob };
