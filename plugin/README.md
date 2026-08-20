# phantom plugin

The Claude Code plugin half of [claude-phantom](../README.md). It ships:

- `skills/crash-recovery/SKILL.md` - the crash recovery procedure. This is the single source of truth: phantom's headless `claude -p` session embeds this exact file in its prompt, and the interactive command below follows it too.
- `commands/recover.md` - `/phantom:recover [crash.json | pasted error]` for interactive recovery inside a normal Claude Code session. It loads the newest `.phantom/crashes/*.json` when no argument is given, creates `phantom/fix-<slug>` itself (after checking the tree is clean), then runs the skill.
- `hooks/hooks.json` + `hooks/phantom-events.js` - a `UserPromptSubmit`/`SessionStart` hook that tells Claude about crashes phantom caught and fixes it made while you were away (see [Hooks](#hooks)).

## Load it

```bash
claude --plugin-dir ./plugin          # from the claude-phantom checkout
claude --plugin-dir node_modules/claude-phantom/plugin   # from a project that installed it
```

Then, after a crash captured by `phantom <command>`:

```
/phantom:recover
```

The headless CLI (`phantom <command>`) does not need the plugin to be loaded; it reads `SKILL.md` from disk directly.

## Hooks

Once the plugin is loaded, phantom events reach you inside Claude Code without any extra step. `phantom <command>` appends every crash and every recovery result to `.phantom/events.jsonl` in the repo. The plugin's hook runs on session start (`startup|resume`) and before each prompt you send; if there are unread events from the last 24 hours it hands Claude a short `👻 phantom:` summary as additional context, so the start of Claude's next reply mentions them briefly - for example:

```
👻 phantom fixed `npm run dev` 4m ago on phantom/fix-20260820-1432-customer; report at .phantom/reports/2026-08-20-1432-customer.md. Want me to show the diff?
```

Each event is reported once: after a report the hook advances `.phantom/events.cursor`, and events older than 24 hours are never surfaced. The hook prints nothing when there is nothing new, never blocks your prompt, and is self-contained (no dependency on `src/`).

To confirm it is loaded, run `/hooks` inside Claude Code: the `UserPromptSubmit` and `SessionStart` sections should each list `node "${CLAUDE_PLUGIN_ROOT}/hooks/phantom-events.js"` under the phantom plugin. If you edited the plugin while Claude Code was running, `/reload-plugins` picks up the change. `claude --debug` logs each hook invocation, its exit code and output.

The same events also drive the `phantom-status` status-line segment shipped with the npm package; it is independent of the plugin.
