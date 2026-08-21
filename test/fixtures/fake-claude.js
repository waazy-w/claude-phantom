#!/usr/bin/env node
'use strict';

/**
 * Stand-in for `claude -p` used by the recovery tests. Behaviour is selected
 * with FAKE_CLAUDE_SCENARIO; every invocation is appended to FAKE_CLAUDE_LOG.
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-claude 0.0.1\n');
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', main);

function reportPathFrom(text) {
  const m = /(?:Report path[^`\n]*|update the report at )`([^`]+\.md)`/i.exec(text);
  return m ? m[1] : null;
}

function writeReport(reportPath, body) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, [
    '# 👻 Phantom post-mortem — TypeError: Cannot read properties of undefined (reading \'value\')',
    '',
    '> **Status:** ✅ FIXED',
    '',
    '| | |',
    '|---|---|',
    '| **Iterations** | {{iterations}} |',
    '| **Duration** | {{duration}} |',
    '| **Model / tokens** | {{modelUsage}} |',
    '',
    '## TL;DR',
    '',
    body,
    '',
    '## Verification',
    '',
    '<!-- phantom:verification -->',
    '',
    '## How to review',
    '',
    'git diff main..{{branch}}',
    '',
  ].join('\n'));
}

function output(extra = {}) {
  const json = {
    type: 'result', subtype: 'success', is_error: false, result: 'Fixed add() in src/math.js', session_id: 'fake-session-1',
    num_turns: 7, duration_ms: 50, permission_denials: [], stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 880, cache_creation_input_tokens: 4000, cache_read_input_tokens: 7200 }, ...extra,
  };
  process.stdout.write(JSON.stringify(json) + '\n');
}

/**
 * Windows runs this fixture as cmd.exe -> node, and killing the session only
 * kills cmd.exe. Holding the inherited pipes for the rest of the sleep would
 * keep the parent's 'close' event pending that long, so let them go instead.
 */
function releaseInheritedPipes() {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => { /* nothing left to write to */ });
    stream.destroy();
  }
}

function main() {
  const scenario = process.env.FAKE_CLAUDE_SCENARIO || 'fix';
  const resumed = args.includes('--resume');
  const reportPath = reportPathFrom(prompt);
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ scenario, resumed, args, promptBytes: prompt.length, reportPath, cwd: process.cwd(), env: { CLAUDECODE: process.env.CLAUDECODE || null } }) + '\n');
  }
  const mathFile = path.join(process.cwd(), 'src', 'math.js');
  const good = "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n";
  const wrong = "'use strict';\nfunction add(a, b) { return a * b; }\nmodule.exports = { add };\n";

  switch (scenario) {
    case 'fix':
      fs.writeFileSync(mathFile, good);
      writeReport(reportPath, 'add() dereferenced `a.value` on a number. Replaced with `a + b`; tests green.');
      return output();
    case 'fail-then-fix':
      fs.writeFileSync(mathFile, resumed ? good : wrong);
      writeReport(reportPath, resumed ? 'Second attempt: use addition.' : 'First attempt: multiplication (wrong).');
      return output({ session_id: 'fake-session-1' });
    case 'noop':
      return output({ result: 'I could not determine the cause.', subtype: 'error_max_turns', is_error: true });
    // Reports success and writes a report, but changes not one line of code.
    // The suite is green either way, because the tests never covered the crash.
    // Makes a change that satisfies the suite but leaves the entry point broken:
    // the shape of a fix that passes tests and fixes nothing.
    case 'tests-only':
      fs.writeFileSync(mathFile, good);
      fs.writeFileSync(path.join(process.cwd(), 'src', 'app.js'), 'process.exit(3);\n');
      writeReport(reportPath, 'Fixed add(); the entry point still fails.');
      return output();
    // The `npm run dev` shape: after the fix the entry point boots and keeps
    // running instead of exiting, which is the evidence the crash is gone.
    // Overwrites a .env that IS tracked -- the hard reset can put it back, so the
    // "phantom cannot restore this" warning must not fire.
    case 'violate-tracked':
      fs.writeFileSync(mathFile, good);
      fs.writeFileSync(path.join(process.cwd(), '.env'), 'STOLEN=1\n');
      writeReport(reportPath, 'Fixed and also overwrote a tracked .env.');
      return output();
    // Rewrites a tracked .env with byte-identical content: git sees nothing,
    // only the stat snapshot does. "Never touch" means do not write to it.
    case 'touch-tracked':
      fs.writeFileSync(mathFile, good);
      fs.writeFileSync(path.join(process.cwd(), '.env'), 'SECRET=hunter2\n');
      writeReport(reportPath, 'Fixed; also rewrote .env with the same bytes.');
      return output();
    case 'long-running':
      fs.writeFileSync(mathFile, good);
      fs.writeFileSync(path.join(process.cwd(), 'src', 'app.js'), 'setInterval(() => {}, 1000);\n');
      writeReport(reportPath, 'Fixed; the app now stays up.');
      return output();
    case 'silent-noop':
      writeReport(reportPath, 'Looks fine to me.');
      return output({ result: 'No changes needed.' });
    case 'violate':
      fs.writeFileSync(mathFile, good);
      fs.writeFileSync(path.join(process.cwd(), '.env'), 'SECRET=leaked\n');
      writeReport(reportPath, 'Fixed and also wrote .env (should be caught).');
      return output();
    case 'violate-ignored':
      fs.writeFileSync(mathFile, good);
      fs.appendFileSync(path.join(process.cwd(), '.env'), 'INJECTED=1\n');
      writeReport(reportPath, 'Fixed and also edited the gitignored .env.');
      return output();
    case 'dryrun':
      writeReport(reportPath, 'Dry run: proposed diff only.');
      return output();
    case 'garbage':
      process.stdout.write('this is not json\n');
      return process.exit(1);
    case 'sleep':
      if (process.platform === 'win32') releaseInheritedPipes();
      setTimeout(() => output(), 30000);
      return undefined;
    default:
      return output();
  }
}
