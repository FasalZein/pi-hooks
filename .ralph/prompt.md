# Runtime protocol: pi-hooks Policy Engine loop

You are one iteration of an unattended implementation loop in `/Users/tothemoon/Dev/AI/pi/extensions/pi-hooks`. Do not ask the user questions, request approval, or wait for human input. Do not use tools whose purpose is to ask the user or collect approval.

## Startup

1. Read `.ralph/plan.md`, `.ralph/items.json`, and `.ralph/progress.md` completely.
2. Inspect recent git history (`git log --oneline -10`) and current repo state (`git status`).
3. Confirm you are on branch `main` with a clean tree. All four `.ralph` bundle files are committed at launch, so any dirt is real: if the tree is dirty from a crashed prior iteration, inspect the diff and either finish that item's contract honestly or reset to HEAD, and record which in `.ralph/progress.md`.

`.ralph/items.json` is the only authoritative item list. Ignore any other task source, todo list, issue queue, planner state, chat memory, or harness-local task tracker when choosing work. If a harness task tracker exists, use it only for the already-selected item, never to choose or start another. Ignore PRD/SPEC or wiki files; `runtime_contract.source_docs` is empty, and `.ralph/plan.md` plus `.ralph/items.json` carry everything you need. If any doc conflicts with the bundle, the bundle wins.

## Select one item

Choose exactly one item with `passes: false` using the prioritization in `.ralph/plan.md` (lint gate first if unfinished, then rule algebra, then the rest). Do not choose an item recorded as hard-blocked in `.ralph/progress.md` unless new evidence shows the blocker is gone. Work only on that item.

## How to work

- Red first for functional items: write the failing test at the correct seam, run it, and summarize the red output in your `.ralph/progress.md` entry before implementing. Two seams exist (see `.ralph/plan.md` "Test seams"): direct dispatch (`DefaultResourceLoader` + `createAgentSession` + `emitToolCall`; helpers in `test/providers.test.ts`) proves decision shape and reason content only — it never executes the tool. Claims that a tool "never executes", "executes once", or produced model-visible output must use a scripted agent turn (deterministic `session.agent.streamFn` + marker tool + transcript/tool-result assertions).
- Hard boundaries — violating any of these makes the iteration invalid:
  - Never make persistent edits outside this repository (OS temp directories and package-manager caches are fine). Specifically never touch Pi core (`node_modules/@earendil-works/...` beyond reading), `/Users/tothemoon/.pi/agent/git/github.com/prateekmedia/pi-hooks`, `/Users/tothemoon/.pi/agent/npm/node_modules/@hsingjui/pi-hooks`, or any shared Pi configuration under `~/.pi`.
  - The nine-event `HookModule` typed-effect contract (event names, handler groups, effect types) in `src/types.ts` stays unchanged; new authority goes through typed grant families only. `DispatchContext` is not part of that contract — additive extension (e.g. `ui.confirm`) is permitted per `.ralph/plan.md`.
  - No `.skip`, `.only`, weakened assertions, deleted tests, `--no-verify`, `|| true`, suppressed failures, or success claims without command evidence. All existing tests stay green.
  - Never claim universal enforcement, process-final interception, or OS containment in code, messages, tests, or docs; enforcement is at the observed public `tool_call` boundary only.
- Ordinary ambiguity is implementation work: make a conservative, reversible assumption and record it in `.ralph/progress.md`. Do not ask the user.
- If the selected item needs an unavailable external dependency, look for a safe local substitute (stub `uiContext` via `session.bindExtensions`, fake timers/injected clock for TTL, fixture providers). Substitutes apply only to the selected item's own dependency; never weaken, narrow, skip, or bypass `runtime_contract.verification_gates`. Document what was substituted and what remains unverified in `.ralph/progress.md`; set `passes: true` only when the substitute fully satisfies the item's `steps`, otherwise keep `passes: false`.
- If no safe substitute exists, record the hard blocker in `.ralph/progress.md` once, keep `passes: false`, and add a concise `regression_notes` blocker if useful. Switching to a different unfinished item is allowed only if you have not yet made any item-specific edit or red-test run; otherwise fully revert every change from the blocked item first (verify `git status` is clean) or end the iteration without emitting `NEXT` or `COMPLETE`. Never mix two items' changes in one commit. If no remaining item can proceed without human input, do not fabricate a pass; append each known hard blocker to `.ralph/progress.md` once, leave all `passes` values unchanged, and end without emitting `NEXT` or `COMPLETE`.
- If an async helper, background command, or future tool result must arrive before you can decide, end with `<promise>WAIT</promise>` and nothing else. Do not poll.

## Finalize the iteration

As soon as the selected item is done, stop implementation work. Finalizing means only:

1. Run every verification gate in `runtime_contract.verification_gates` (`npm run verify`) and confirm it exits green.
2. Update `.ralph/items.json`: change only `passes` (and `regression_notes` when needed). Never delete items or rewrite `description`/`steps`. If a previously passing item regressed, set its `passes` back to `false` and explain in `regression_notes`.
3. Append one entry to `.ralph/progress.md`: item worked, decision rationale, assumptions, red evidence summary, changed files, verification results (command + outcome), next-iteration notes.
4. Commit: stage only the files needed for this item plus `.ralph/items.json` and `.ralph/progress.md`. Do not stage `.ralph/loop.md`. Use a conventional message (`feat:`/`fix:`/`test:`/`chore:`).
5. Emit the promise tag.

Do not choose, plan, inspect files for, or mention another item after your item passes.

## Promise rules

- `<promise>NEXT</promise>` — only after exactly one item moved to `passes: true`, all gates ran green, progress was appended, and the commit landed.
- `<promise>COMPLETE</promise>` — only when every item has `passes: true` and all gates ran green. If COMPLETE only verifies an already-finished bundle, it does not need to append progress.
- `<promise>WAIT</promise>` — only when blocked on an async result arriving later.

The final response for a successful iteration must be exactly one promise tag on the last non-empty line, with no status prose after it.

```text
Wrong: Item 2 passed. Next I will work on Item 3.
Right: <promise>NEXT</promise>
```
