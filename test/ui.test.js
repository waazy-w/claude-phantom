'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Writable } = require('node:stream');
const ui = require('../src/ui');

const capture = () => {
  let text = '';
  const s = new Writable({ write(c, e, cb) { text += c; cb(); } });
  s.text = () => text;
  return s;
};

test('colors are no-ops under NO_COLOR and on non-TTY streams', () => {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  try {
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    ui.setStream(capture());
    assert.strictEqual(ui.colors.red('x'), 'x');
    delete process.env.NO_COLOR;
    assert.strictEqual(ui.colors.bold('x'), 'x');
    process.env.FORCE_COLOR = '1';
    assert.strictEqual(ui.colors.green('x'), '\u001b[32mx\u001b[39m');
    assert.strictEqual(ui.visibleLength(ui.colors.green('abc')), 3);
  } finally {
    ui.setStream(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('banner draws a box and log lines carry the prefix; verbose is gated', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    ui.banner(['one', 'longer line']);
    const lines = out.text().split('\n');
    assert.strictEqual(lines[0], '╭─────────────╮');
    assert.strictEqual(lines[1], '│ one         │');
    assert.strictEqual(lines[2], '│ longer line │');
    assert.strictEqual(lines[3], '╰─────────────╯');
    ui.log.info('hello');
    ui.log.warn('careful');
    ui.log.error('bad');
    ui.log.verbose('hidden');
    assert.ok(out.text().includes('phantom › hello\n'));
    assert.ok(out.text().includes('phantom › careful\n'));
    assert.ok(out.text().includes('phantom › bad\n'));
    assert.ok(!out.text().includes('hidden'));
    ui.log.setVerbose(true);
    ui.log.verbose('shown');
    assert.ok(out.text().includes('phantom › shown\n'));
  } finally {
    ui.log.setVerbose(false);
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

// What the spinner writes to wipe its own line before repainting: CR + erase-line.
const CLEAR = '\r\u001b[2K';

test('spinner paints a frame with elapsed time and clears the line when stopped', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  let clock = 1000;
  try {
    const spin = ui.spinner('thinking', { enabled: true, now: () => clock });
    assert.ok(out.text().endsWith('phantom › ⠋ thinking 0s'), out.text());
    clock = 1000 + 95 * 1000;
    spin.tick();
    assert.ok(out.text().endsWith('phantom › ⠙ thinking 1m 35s'), out.text());
    spin.update('still thinking');
    assert.ok(out.text().endsWith('phantom › ⠙ still thinking 1m 35s'), out.text());
    // A session can outlive an hour if maxMinutes is raised; "62m 05s" is wrong.
    clock = 1000 + 3725 * 1000;
    spin.tick();
    assert.ok(out.text().endsWith('phantom › ⠹ still thinking 1h 02m'), out.text());
    spin.stop();
    assert.ok(out.text().endsWith(CLEAR), 'stopping wipes the line');
    const before = out.text();
    spin.tick();
    spin.update('ignored');
    spin.stop();
    assert.strictEqual(out.text(), before, 'a stopped spinner writes nothing further');
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

// A timer seam: hands back the scheduled callback so a two-minute heartbeat can
// be fired on demand instead of waited for.
const fakeTimers = () => {
  const t = { scheduled: [], cleared: [] };
  t.setInterval = (fn, ms) => { const handle = { fn, ms }; t.scheduled.push(handle); return handle; };
  t.clearInterval = (handle) => { t.cleared.push(handle); };
  t.fire = () => { for (const h of t.scheduled) if (!t.cleared.includes(h)) h.fn(); };
  t.opts = { setInterval: t.setInterval, clearInterval: t.clearInterval };
  return t;
};

test('spinner clips its line to the terminal width rather than wrapping', () => {
  // CLEAR_LINE erases one physical row, so a wrapped frame leaves its first row
  // on screen and every repaint smears another copy down the terminal.
  const out = capture();
  out.columns = 48;
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    const spin = ui.spinner('replaying ' + 'very/long/path/'.repeat(8), { enabled: true, now: () => 0 });
    const first = out.text().slice(CLEAR.length);
    assert.strictEqual(ui.visibleLength(first), 47, 'one column short of the width: ' + first);
    assert.ok(first.startsWith('phantom › ⠋ replaying very/'), first);
    assert.ok(first.endsWith('… 0s'), 'the head and the clock survive; the middle is elided: ' + first);

    // Re-read per frame, so a resize mid-run needs no resize handler.
    out.columns = 30;
    spin.tick();
    const resized = out.text().split(CLEAR).pop();
    assert.strictEqual(ui.visibleLength(resized), 29, resized);
    assert.ok(resized.endsWith('… 0s'), resized);

    // A line that already fits is passed through untouched -- no stray ellipsis.
    out.columns = 200;
    spin.update('short');
    assert.strictEqual(out.text().split(CLEAR).pop(), 'phantom › ⠙ short 0s');
    spin.stop();
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('a stream that reports no width is never clipped', () => {
  // A capture stream, a pipe: guessing 80 here would truncate real output.
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    const spin = ui.spinner('x'.repeat(300), { enabled: true, now: () => 0 });
    assert.strictEqual(ui.visibleLength(out.text().slice(CLEAR.length)), 12 + 300 + 3);
    spin.stop();
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('bell rings only on a TTY, only past 30s, and never with PHANTOM_BELL=0', () => {
  const savedEnv = process.env.PHANTOM_BELL;
  const tty = capture();
  tty.isTTY = true;
  ui.setStream(tty);
  try {
    delete process.env.PHANTOM_BELL;
    assert.strictEqual(ui.bell(30000), false, '30s is not "over 30s"');
    assert.strictEqual(ui.bell(29999), false);
    assert.strictEqual(tty.text(), '', 'a short run makes no sound');
    assert.strictEqual(ui.bell(30001), true);
    assert.strictEqual(tty.text(), '\u0007', 'exactly one BEL, nothing else');

    process.env.PHANTOM_BELL = '0';
    assert.strictEqual(ui.bell(10 * 60 * 1000), false, 'PHANTOM_BELL=0 opts out');
    assert.strictEqual(tty.text(), '\u0007', 'and adds no further bell');
  } finally {
    ui.setStream(null);
    if (savedEnv === undefined) delete process.env.PHANTOM_BELL; else process.env.PHANTOM_BELL = savedEnv;
  }

  // A BEL byte in a piped log or a CI transcript is corruption, not a nudge.
  const pipe = capture();
  ui.setStream(pipe);
  try {
    assert.strictEqual(ui.bell(60 * 60 * 1000), false, 'no TTY, no bell');
    assert.strictEqual(pipe.text(), '');
  } finally { ui.setStream(null); }
});

test('a disabled spinner stays silent until the heartbeat fires', () => {
  // Was "nothing is drawn when disabled" outright. A non-TTY run that prints
  // nothing for fifteen minutes is indistinguishable from a hang to a human
  // tailing the log and fatal to a CI runner with a no-output timeout.
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  const timers = fakeTimers();
  let clock = 0;
  try {
    const quiet = ui.spinner('replaying the crash', { enabled: false, now: () => clock, ...timers.opts });
    quiet.tick();
    quiet.update('still replaying the crash');
    assert.strictEqual(out.text(), '', 'nothing is drawn, and nothing animates, when disabled');
    assert.strictEqual(timers.scheduled.length, 1, 'exactly one timer: the heartbeat');
    assert.strictEqual(timers.scheduled[0].ms, 120000, 'every two minutes by default');

    clock = 4 * 60 * 1000;
    timers.fire();
    assert.strictEqual(out.text(), 'phantom › still working — 4m elapsed, still replaying the crash\n',
      'a plain line, the injected clock, and the current label');

    const before = out.text();
    quiet.stop();
    timers.fire();
    assert.strictEqual(out.text(), before, 'stop() clears the heartbeat');
    // Cleared, not merely guarded: an uncleared interval goes on waking the
    // event loop every two minutes for the rest of the process.
    assert.deepStrictEqual(timers.cleared, [timers.scheduled[0]]);
    // And separately: a callback already in flight when stop() lands must not
    // print either. Called directly, past the "was it cleared" bookkeeping, so
    // this proves the guard inside the heartbeat rather than the clear.
    timers.scheduled[0].fn();
    assert.strictEqual(out.text(), before, 'a fired-anyway heartbeat still prints nothing after stop()');
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('the heartbeat never fires while the spinner is animating', () => {
  // On a TTY the ticking clock already says "alive"; a heartbeat line would
  // punch a permanent row through the middle of the animation.
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  const timers = fakeTimers();
  try {
    const spin = ui.spinner('working', { enabled: true, now: () => 9 * 60 * 1000, ...timers.opts });
    assert.strictEqual(timers.scheduled[0].ms, 120, 'the animation interval, not the heartbeat one');
    timers.fire();
    timers.fire();
    assert.ok(!out.text().includes('still working —'), out.text());
    assert.ok(out.text().endsWith('phantom › ⠹ working 0s'), 'the scheduled timer is the repaint');
    spin.stop();
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('log lines never collide with a live spinner', () => {
  const out = capture();
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  ui.setStream(out);
  try {
    const spin = ui.spinner('working', { enabled: true, now: () => 0 });
    const started = out.text();
    ui.log.warn('heads up');
    // The line is wiped, the message is printed, then the spinner repaints
    // underneath it -- so the message survives intact on its own line.
    assert.strictEqual(out.text().slice(started.length),
      CLEAR + 'phantom › heads up\n' + CLEAR + 'phantom › ⠋ working 0s');
    spin.stop();
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('spinner follows the stream TTY flag when not told otherwise', () => {
  const tty = capture();
  tty.isTTY = true;
  ui.setStream(tty);
  try {
    const spin = ui.spinner('auto', { now: () => 0 });
    assert.ok(tty.text().includes('auto'), 'a TTY stream animates by default');
    spin.stop();
  } finally { ui.setStream(null); }

  const pipe = capture();
  ui.setStream(pipe);
  try {
    const spin = ui.spinner('auto', { now: () => 0 });
    spin.tick();
    spin.stop();
    assert.strictEqual(pipe.text(), '', 'a non-TTY stream stays silent');
  } finally { ui.setStream(null); }
});

const { Readable } = require('node:stream');

// A stdin stand-in that readline will treat as a real, non-TTY pipe.
const keystrokes = (...lines) => Readable.from([lines.join('\n') + '\n']);

test('ask resolves the chosen key, case-insensitively and trimmed', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    const answer = await ui.ask('merge, delete, or keep? [m/d/k]', {
      keys: ['m', 'd', 'k'], input: keystrokes('  M  '), enabled: true, timeoutMs: 0,
    });
    assert.strictEqual(answer, 'm');
    assert.ok(out.text().includes('merge, delete, or keep? [m/d/k]'));
  } finally { ui.setStream(null); }
});

test('ask re-asks on an unrecognised answer, then gives up rather than looping', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    assert.strictEqual(await ui.ask('pick', {
      keys: ['m', 'k'], input: keystrokes('yes', 'k'), enabled: true, timeoutMs: 0,
    }), 'k', 'a good answer after a bad one still counts');
    assert.ok(out.text().includes('please answer with one of: m, k'));

    // More bad input than attempts, so giving up has to come from the attempt
    // cap rather than from end-of-input -- otherwise this passes even with no
    // cap at all, and a user who keeps fat-fingering never gets their shell back.
    const noisy = capture();
    ui.setStream(noisy);
    assert.strictEqual(await ui.ask('pick', {
      keys: ['m', 'k'], input: keystrokes('no', 'nope', 'never', 'still no', 'and again'),
      enabled: true, timeoutMs: 0, attempts: 3,
    }), null, 'bad answers give up instead of asking forever');
    assert.strictEqual((noisy.text().match(/please answer with one of/g) || []).length, 2,
      'asks 3 times total: two retries after the first bad answer');
    assert.strictEqual((noisy.text().match(/pick/g) || []).length, 3, noisy.text());
  } finally { ui.setStream(null); }
});

test('ask returns null -- change nothing -- whenever no answer can be had', async () => {
  const out = capture();
  ui.setStream(out);
  try {
    // Non-interactive: the whole point, so scripts and CI never block.
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m'), enabled: false }), null);
    assert.strictEqual(out.text(), '', 'a disabled prompt is never even printed');

    // End of input, e.g. stdin closed or redirected from /dev/null.
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: Readable.from([]), enabled: true, timeoutMs: 0 }), null);

    // A walked-away user must not hold the terminal forever.
    const never = new Readable({ read() { /* silence */ } });
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: never, enabled: true, timeoutMs: 20 }), null);
    never.push(null);
  } finally { ui.setStream(null); }
});

test('ask decides interactivity from the real descriptors, not the stream it reads', async () => {
  // The two are deliberately separate. Whether to prompt at all is answered by
  // process.stdin/stderr -- a piped stdin means a script or CI and must never
  // see a prompt. WHERE the answer is read from is a different question, and in
  // production it is /dev/tty, because the recovery session leaves the inherited
  // stdin unable to deliver a line.
  const realStdinIsTty = process.stdin.isTTY;
  const out = capture();
  ui.setStream(out);
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m') }), null,
      'a non-TTY stderr suppresses the prompt even with a TTY stdin');
    assert.strictEqual(out.text(), '', 'and prints nothing at all');
  } finally { ui.setStream(null); }

  const ttyOut = capture();
  ttyOut.isTTY = true;
  ui.setStream(ttyOut);
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m'), timeoutMs: 0 }), null,
      'a piped stdin suppresses the prompt even with a TTY stderr');
    assert.strictEqual(ttyOut.text(), '', 'and prints nothing at all');

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    assert.strictEqual(await ui.ask('q', { keys: ['m'], input: keystrokes('m'), timeoutMs: 0 }), 'm',
      'both TTY: the prompt runs and reads from the stream it was given');
    assert.ok(ttyOut.text().includes('q'), 'the question reached the terminal');
  } finally {
    ui.setStream(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: realStdinIsTty, configurable: true });
  }
});

test('setStream stops a live spinner so it cannot repaint over the next stream', () => {
  // NO_COLOR pins the exact bytes: npm exports FORCE_COLOR=1 to lifecycle
  // scripts when stdout is a terminal, so without this the assertion passes in
  // CI and under a piped `npm test`, and fails only in a real terminal.
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const first = capture();
  first.isTTY = true;
  ui.setStream(first);
  ui.spinner('orphan', { now: () => 0 });
  const second = capture();
  ui.setStream(second);
  try {
    ui.log.info('after');
    assert.strictEqual(second.text(), 'phantom › after\n', 'no leftover clear/redraw from the old spinner');
  } finally {
    ui.setStream(null);
    if (saved === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = saved;
  }
});

test('openTerminal yields a readable handle, or falls back to stdin without throwing', () => {
  // In production this is /dev/tty, because the recovery session leaves the
  // inherited stdin unable to deliver a line. Under a test runner or in CI there
  // may be no controlling terminal at all, and the fallback is what runs -- so
  // this asserts the contract both branches must satisfy rather than which one
  // was taken. The /dev/tty branch itself is only observable from a real
  // terminal; a real recovery is what verifies it.
  const { input, close } = ui.openTerminal();
  try {
    assert.ok(input && typeof input.on === 'function', 'a readable stream either way');
    if (input !== process.stdin) {
      assert.strictEqual(input.isTTY, true, '/dev/tty is marked as a terminal so callers can trust it');
    }
  } finally {
    assert.doesNotThrow(close, 'closing is safe even when nothing was opened');
    assert.doesNotThrow(close, 'and is idempotent');
  }
  assert.notStrictEqual(process.stdin.destroyed, true, 'the fallback must never destroy the real stdin');
});
