# 👻 Phantom post-mortem — {{errorSummary}}

> **Status:** {{status}}
> <!-- One of: ✅ FIXED · ⚠️ PARTIAL · ❌ UNFIXED · 🔍 DRY RUN -->

| | |
|---|---|
| **Command** | `{{command}}` |
| **Exit** | {{exitSummary}} |
| **Branch** | `{{branch}}` (from `{{baseBranch}}` @ `{{baseSha}}`) |
| **Iterations** | {{iterations}} |
| **Duration** | {{duration}} |
| **Model / cost** | {{modelCost}} |
| **Generated** | {{generatedAt}} |

## TL;DR

<!-- Exactly two sentences: (1) what broke and why, (2) what you changed and whether tests are green. -->

## Crash

**Error:** `{{errorLine}}`

<!-- The stack trace as captured, trimmed to the 25 most relevant lines. Keep the error line and the first project frame. -->

```text
{{stackTrace}}
```

## Root cause

<!-- The mechanism, not the symptom. "X is undefined because Y never sets it when Z" — not "X was undefined".
     Cite every claim with `path/to/file.js:LINE`. State what you read to confirm it. If you could not confirm, say so. -->

## Blast radius

<!-- Bullets:
     - Triggering inputs / paths / conditions
     - Other callers or features that share the faulty code
     - Data at risk (none / corrupted / lost)
     - **Severity:** low | medium | high — one clause justifying it -->

## Regression test

**File:** `{{testPath}}`

<!-- The full test you added, exactly as written to disk. -->

```js
{{testCode}}
```

<details>
<summary>Failing output before the fix</summary>

```text
{{failingOutput}}
```

</details>

## The fix

<!-- 2–4 sentences: why this change is correct for the cause above, and why it is safe for all other inputs.
     Then the unified diff of every changed source file (not the test, not the report). In dry-run this diff IS the proposal. -->

```diff
{{diff}}
```

## Verification

<!-- Leave the marker below untouched. Phantom replaces it with an independent test run, a never-touch audit, and timings. -->

<!-- phantom:verification -->

## Alternatives considered / follow-ups

<!-- Bullets: other fixes you rejected and why; things a human should still check (adjacent bugs, missing validation, docs, types).
     If you stopped early (PARTIAL), the first bullet must say exactly what a human needs to do and why you could not. -->

## How to review

```bash
git diff {{baseBranch}}..{{branch}}          # inspect the change
git log --oneline {{baseBranch}}..{{branch}} # phantom's commit(s)
git merge {{branch}}                          # accept
git branch -D {{branch}}                      # reject
```

Report: `{{reportPath}}`
