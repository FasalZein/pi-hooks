# Spec: parity repairs and cutover readiness

## Problem Statement

The consolidated pi-hooks package passes 157 tests, but independent source comparisons found gaps in the behavior it must retain. Some previously protected command forms avoid Approval. A denied Recipe can still add text to model context. The LSP settings adapter can disable healthy servers when one entry is invalid. Bundled guidance and command choices contradict the dedicated configuration contract.

The tests also lack direct evidence for integrated LSP workspace edits and session transitions, and for Recipe cancellation during an active Pi turn. Replacing the installed packages now risks silent loss of protection or functionality.

This specification repairs those gaps. It supplements #1 and preserves the decisions in ADR-0001 through ADR-0004. It does not restore intentionally removed features.

## Solution

Make the consolidated package preserve the agreed behavior, prove it at the real Pi boundary, and keep Cutover blocked until the evidence is complete. Retain one dedicated JSONC configuration, named configurable defaults, a neutral Bare Host, and the upstream LSP tool.

## User Stories

1. As an operator, I want protected commands with leading whitespace to require Approval, so that formatting cannot remove protection.
2. As an operator, I want escaped command names to retain their protections, so that equivalent shell spelling cannot remove Approval.
3. As an operator, I want protected deletion through alternative executable paths to require Approval, so that path selection cannot remove protection.
4. As an operator, I want ordinary commands and harmless literal mentions to remain usable, so that parity repairs do not create unnecessary prompts.
5. As an operator, I want Approval to show and bind the exact executed input, so that matching normalization never changes what I approve.
6. As an operator, I want named Policy Rules to remain individually overridable and disableable, so that the Preset does not become hardcoded policy.
7. As a background helper, I want an ask rule to deny with a Remedy when no dialog is available, so that unattended execution never silently approves it.
8. As an operator, I want a denied tool call to commit no Recipe context, so that blocking the action also blocks its staged model effects.
9. As an operator, I want an earlier Recipe's context discarded when a later guard denies the same call, so that ordering cannot bypass that guarantee.
10. As an operator, I want successful calls to retain their own context exactly once, so that the repair neither loses nor duplicates valid effects.
11. As an operator, I want invalid optional Recipe configuration to isolate the Action Engine, so that healthy policy remains active.
12. As an operator, I want one clearly documented Recipe configuration path and explicit override behavior, so that examples do not silently discard my entries.
13. As an operator, I want malformed configuration documents distinguished from invalid optional entries, so that Inactive Host behavior remains predictable.
14. As an operator, I want one invalid LSP Server Definition to leave valid siblings usable, so that one typo does not disable every language.
15. As an operator, I want the LSP warning to identify the excluded server, so that I can correct its configuration.
16. As an operator, I want bundled skills to teach the actual configuration owner, so that agents edit the right file.
17. As an operator, I want LSP controls to offer only supported persistence scopes, so that the interface does not lead me into a guaranteed error.
18. As an operator, I want global LSP toggles to preserve comments and unrelated configuration, so that a command cannot erase my explanations or settings.
19. As an operator, I want LSP workspace changes to remain previews until approved application, so that inspection never edits files.
20. As an operator, I want modified mutation descriptions to be rejected before application, so that tool-call changes cannot bypass workspace-edit checks.
21. As an operator, I want failed or cancelled workspace edits to preserve the documented rollback behavior, so that partial writes do not remain unnoticed.
22. As an operator, I want LSP configuration changes to take effect on Pi reload, so that the new configuration owner follows the documented lifecycle.
23. As an operator, I want resume, fork and tree navigation to preserve their branch-specific LSP state, so that session state does not leak or disappear.
24. As an operator, I want a fresh session or helper process to load one LSP tool with the intended settings, so that one install works beyond a single test process.
25. As an operator, I want aborting an active Pi turn to stop its Recipe command, so that cancellation reaches the live execution path.
26. As an operator, I want idle-event limitations stated accurately, so that timeout and cancellation guarantees do not exceed the available signal.
27. As a maintainer, I want dependency-patch and packed-install checks, so that the published package contains the same verified LSP adapter.
28. As a maintainer, I want parity evidence separated from ordinary suite results, so that passing self-authored tests does not imply complete compatibility.
29. As an operator, I want Cutover to preserve all existing server definitions and actual helper bindings, so that migration does not narrow my working setup.
30. As an operator, I want intentional removals stated separately, so that missing legacy features do not become accidental rebuild requirements.

## Implementation Decisions

- Preserve Bare Host neutrality, required-component rollback, optional-component isolation and Inactive Host behavior. Do not add a fallback policy for an invalid document.
- Keep policy in the Policy Engine and named Preset defaults. Close the demonstrated command-form gaps without changing unrelated input matchers or building a general shell security parser.
- Normalize only the representation used for command-policy matching. Preserve the original executed input and bind Approval to the exact Host-final input.
- Stage tool-call context effects with their dispatch. Commit only after the final allow decision. Cover same-Recipe and cross-Recipe denials without a shared queue rollback that can discard another call's effects.
- Make optional Recipe validation consistent through the Preset configuration path, including duplicate Recipe ids. Whole-document syntax/schema failure still produces an Inactive Host.
- Document top-level named Recipes as the operator path. Retain explicit whole-Provider override semantics for composers and make mixed-form replacement visible rather than inventing another merge policy.
- Keep the complete upstream LSP tool, protocol and workspace-edit implementation. Repair the adapter around it instead of replacing those components.
- Apply the ADR-0004 exception only to post-edit diagnostic matching. Equivalent path spellings must resolve to the same existing file. Keep Approval, Mutation Manifest validation, execution input, write authorization, apply, cancellation, rollback, and protocol behavior unchanged.
- Exclude and warn on an invalid per-server enablement value while preserving valid siblings. Do not relax the closed global configuration schema.
- Keep global dedicated JSONC as the configuration owner. Preserve session-scoped toggles. Exclude project scope from offered actions; manually supplied unsupported arguments still receive a Remedy.
- Publish configuration-correct skill guidance with the package. Verify the packaged skill and linked guidance, not only contributor documentation.
- Keep fixed-argv Recipes, explicit timeouts and the declared Effect set. Cancellation proof must use an active Pi run; direct runner tests and idle event emission are insufficient.
- Add a readiness gate before existing Cutover #12. Correct its obsolete server-configuration location and helper count without creating a second Cutover ticket.
- Preserve the five existing server definitions and their settings exactly at Cutover. Inventory current active helper definitions; the audit found eleven, not twelve. Do not count backup files.
- This work adds no automatic server installer, settings importer, custom Provider-code loader or new Recipe effect.

## Testing Decisions

The primary seam is the existing real Pi resource loader and session. Tests assert decisions, exact Approval input, model context, tool output, configuration persistence, health and observable process/filesystem results. Reuse packed-install and scripted-turn patterns. New test fixtures are acceptable; new production test-only APIs are not required.

- Compare safe fixture command strings with the audited legacy classifier and the new Policy Engine. Never execute destructive examples. Cover misses, ordinary commands, literal mentions, named overrides and disablement.
- At the real Host boundary, verify denied calls produce no new context, allowed calls commit once, and effects from unrelated calls remain intact.
- Drive top-level Recipe validation and mixed configuration forms through the installable Preset. Distinguish optional failure from invalid whole-document behavior.
- Load a valid and invalid LSP definition together, assert the warning, and run real diagnostics on the valid server. Verify global JSONC toggles and unsupported scope handling.
- Exercise workspace-edit preview, apply, mutation-manifest checks, denial, partial-failure rollback and cancellation through the integrated package using disposable files.
- Exercise actual Pi reload, resume, fork and tree behavior. Include a fresh OS process or helper-equivalent process; two sessions in one process do not prove process isolation.
- Abort a scripted active Pi turn while a harmless Recipe child is running. Verify process termination, health/audit outcome and documented failure posture. Keep idle-event behavior explicit.
- Inspect a packed package for correct instructions, one LSP tool, expected patch version and dependency integrity. Retain the exact-source patch rejection tests.
- Every delivery slice runs its targeted tests and `npm run verify`. The final gate repeats focused parity probes and runs `npm run verify` in a clean checkout. Record commands, versions, results and remaining limitations.
- Do not skip, weaken or delete checks to obtain green. No live-machine package replacement occurs during repair or verification tickets.

## Out of Scope

- Restoring checkpoint, repeat, token-rate, permission levels/modes/commands or persistent allow-always approvals.
- Claude event aliases, legacy hooks importers, shell command strings, input-mutation effects and Stop-triggered continuation.
- Automatic language-server installation, new server selections, custom Provider-code loading or project executable overlays.
- Reimplementing the LSP protocol, expanding the current nine-event contract, or claiming an OS sandbox or process-wide final interception.
- Fixing every shared weakness of the legacy shell classifier. The required target is the demonstrated retained-behavior gaps, not universal command detection.
- Changing machine settings, deleting restore points, rewriting published history, or replacing packages before the separate Cutover.
- Closing or modifying parent specification #1.

## Further Notes

The audited implementation baseline is commit 4151df09bede81b75ad6cce5532140fd0659b26c. Its clean-checkout suite passed 157 tests in 14 files. Independent comparisons covered prateekmedia/pi-hooks 1.0.5, hsingjui/pi-hooks 0.0.2 and pi-lsp 0.4.4.

The first package exposes matching gaps. The second was inert on this machine, but its comparison revealed a defect in the new Recipe contract. The LSP protocol/tool source is preserved; adapter, documentation and runtime-proof gaps remain.

Existing implementation issues remain historical delivery references. New issues cover audit-driven repairs and proof, not duplicate feature builds. Cutover #12 remains the sole machine-switch ticket and must wait for the new readiness gate.

Public issue content must omit personal paths, secrets, machine-specific values and runnable destructive demonstrations. Keep private audit artifacts out of public attachments.
