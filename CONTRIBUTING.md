# Contributing to claude-phantom

Thanks for helping. This is a small tool with a large blast radius if it misbehaves, so the
bar for changes is "boring and verifiable".

## Dev setup

```sh
git clone https://github.com/waazy-w/claude-phantom.git
cd claude-phantom
npm link          # makes the `phantom` binary on your PATH point at this checkout
npm test          # node:test, no test framework to install
npm run lint      # syntax check + require() smoke test
```

`npm run test:watch` re-runs tests on change.

## The zero-dependency rule

`claude-phantom` has no runtime dependencies and no devDependencies, and pull requests that
add one will be declined. This is deliberate: phantom runs an AI agent with write access to
your repository. Anyone deciding whether to trust it should be able to read the entire
codebase in an afternoon and know that `npm install -g claude-phantom` installs exactly that
code and nothing else. Every transitive dependency is a package nobody here reviewed, a
supply-chain surface, and an excuse to stop reading.

Node >= 18 gives us `fetch`, `node:test`, `child_process`, and `fs` — that is everything
phantom needs. If you think you need a library, open an issue first.

## Running the example

```sh
npm run demo
```

This copies `examples/crash-demo` into a temporary git repository and runs
`phantom npm start` inside it. The app crashes on purpose; phantom recovers it. Recovery
spawns a real `claude -p` session and uses your Claude billing. Run `npm run demo -- --dry-run` to get
the diagnosis without the patch.

## Pull requests

- Behaviour changes come with tests. Unit tests live in `test/*.test.js` and run with
  `node --test`; integration tests spawn real child processes and temp git repos, so keep
  them hermetic (no network, no writes outside `os.tmpdir()`).
- Keep the safety rails intact. In particular, any change to the allowed-tools list in
  `src/prompt.js`, the `neverTouch` / `alwaysNeverTouch` defaults in `src/config.js`, the
  post-run never-touch audit, or the Ctrl+C cleanup path in `src/recovery.js` needs a written
  justification in the PR description: what it enables, what it newly exposes, and why the
  trade is worth it. "Claude kept asking for it" is not a justification on its own.
- The operating procedure in `plugin/skills/crash-recovery/SKILL.md` is the single source of
  truth for what the agent is asked to do. If you change the prompt, change the skill, and
  vice versa.
- The event log format (`src/events.js`, `v: 1`) is read by an independent copy of the reader
  in `plugin/hooks/phantom-events.js` so the plugin works without `src/` on disk. Change both
  together; `test/plugin-events-hook.test.js` writes with one and reads with the other.
- Add a line to `CHANGELOG.md` under `[Unreleased]`.
- Small, focused PRs review faster.

## Reporting issues

Include the post-mortem report from `.phantom/reports/` and the crash capture from
`.phantom/crashes/` when relevant; scrub anything sensitive first. Phantom never reads your
never-touch files, but your application's own log output may contain secrets.
