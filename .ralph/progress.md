# Progress log — SLICE-0011 Policy Engine loop

## Iteration 1 — Item 1: Lint gate (tooling)

**Decision rationale:** First unfinished item per plan prioritization (lint gate strengthens every later gate run).

**What was done:**
- Added devDependencies (exact-pinned): `eslint@10.7.0`, `typescript-eslint@8.64.0`.
- Added `eslint.config.js` flat config: `tseslint.config` with typescript-eslint recommended over `src/**/*.ts` and `test/**/*.ts` only.
- Added script `"lint": "eslint src test"`; changed `"verify"` to `npm run typecheck && npm run lint && npm test`.

**Linter-bites evidence (tooling item's honesty step; no red test):**
- Appended `const piHooksLintCanary = 42;` to `src/policy.ts`, ran `npx eslint src test`: flagged `src/policy.ts 55:7 error 'piHooksLintCanary' is assigned a value but never used @typescript-eslint/no-unused-vars`.
- JSON formatter reported **16 files linted** (12 src + 4 test, nonzero), 5 files with errors, 12 errors total including the canary.
- Reverted the canary via `git checkout -- src/policy.ts`; confirmed clean.

**Baseline findings fixed (11 errors, no runtime behavior or assertion weakened, no disables needed):**
- `src/grants.ts:122` no-unused-vars: dropped the unused `..._args` rest param in the refusal proxy's thrown-call function (plain JS functions accept any args; refusal behavior identical, covered by existing refusal tests).
- `test/host.test.ts` no-unsafe-function-type (4): replaced `Function` in the `fakePi` maps/params with `type TestHandler = (...args: unknown[]) => unknown`. Safe because handler results only flow into `expect(...)` matchers and `pi.api` is passed via `as never`.
- `test/providers.test.ts` no-unused-vars (2): removed the unused top-level `Type` import (usages at lines 50/77 are inside template-string extension sources, not real references) and the unused `auditPath` parameter of `ungrantedToolSource` (never interpolated into the template; call site updated).
- `test/types.test.ts` no-unused-expressions (4): prefixed the four intentional type-level access expressions with `void`; each `// @ts-expect-error` still fires (typecheck stays green), so the compile-time contract assertions are unweakened.

**Assumptions:** eslint 10 / typescript-eslint 8 latest at install time is acceptable (item said "recommended ruleset", no version pinning was specified beyond --save-exact). Lint scope limited to `src` and `test` via CLI args + `files` in flat config; configs like `eslint.config.js` itself are out of scope per the item description.

**Verification:** `npm run verify` → tsc clean, eslint clean, vitest 78/78 passed (4 files). Full gate green.

**Changed files:** `eslint.config.js` (new), `package.json`, `package-lock.json`, `src/grants.ts`, `test/host.test.ts`, `test/providers.test.ts`, `test/types.test.ts`.

**Next-iteration notes:** Item 2 (rule matching + allow/deny composition) is next per plan order. Direct dispatch seam helpers live in `test/providers.test.ts` (`withProviderSession`, temp `PI_CODING_AGENT_DIR`). New test files must satisfy lint (no `Function`, no unused vars, `void` for intentional bare expressions).

## Iteration 2 — Item 2: Rule matching and allow/deny composition (functional)

**Decision rationale:** First unfinished item per plan prioritization (rule algebra after the lint gate).

**Red evidence (direct dispatch seam):** New `test/policy-engine.test.ts` (8 tests) written first; run before implementation: 7/8 failed, every deny expectation received `undefined` from `emitToolCall` ("expected undefined to match object { block: true }") because no policy engine existed. The one pass was the trivially-negative sourceId-narrowing case. Log: vitest run, 7 failed / 1 passed.

**What was done:**
- New `src/policy-engine.ts`: `policyEngineProvider` (id `policy-engine`, events grant, TypeBox `configSchema` with `additionalProperties: false` throughout). Rules: `id`/`match`/`decision`/`scope`/`remedy` per the plan's rule contract. Matching: exact tool name or array; provenance `kind` (`builtin` = source === "builtin", `extension` = provenance present and not builtin) with optional `sourceId` exact narrowing; dot-path input matchers with `equals` (canonical-JSON deep equality via recursive key sort) and `contains` (string substring). Composition: severity lattice allow<ask<deny<hard-deny, highest severity wins, same-severity tie → lexicographically smallest rule id; winner `allow` → no opinion (undefined); any non-allow winner → guard deny with rule id + severity in the reason. Duplicate rule ids throw at activate (provider isolates/degrades per substrate semantics).
- `src/index.ts`: bundles the provider in the default export (`createPiHooksExtension({ providers: [policyEngineProvider] })`); exports `policyEngineProvider`, `PolicyEngineConfigSchema`, and the config types.
- Tests cover: exact-name deny with id+severity in reason, tool-name array, provenance kind (extension tool denied, builtin passes) and sourceId narrowing (mismatch → no match), input `contains` + key-order-insensitive `equals` on a dot path, deny-beats-allow with winner attribution, allow-only → no block, aa/zz tie-break, and full-outcome determinism across two sessions with the rules array reversed and every object's keys reordered (results deep-equal).

**Assumptions (conservative, reversible):**
- Non-allow winners (`ask`, `hard-deny`) currently block with their severity named in the reason — fail-closed placeholder; items 4/5 own their real semantics (confirm flow, unapprovable short-circuit) and their red tests at the scripted seam remain red.
- `match.provenance` is `{ kind, sourceId? }`; `kind: "extension"` means observed provenance exists and is not "builtin". Untrusted/absent provenance matches neither kind.
- Input matcher paths are dot-separated; segments containing dots are unsupported. Reason string carries id + severity only; scope/remedy surfacing is item 8.

**Changed files:** `src/policy-engine.ts` (new), `src/index.ts`, `test/policy-engine.test.ts` (new).

**Verification:** `npm run verify` → exit 0: tsc clean, eslint clean, vitest 86/86 (5 files, all prior 78 still green).

**Next-iteration notes:** Item 3 (confirm-only interaction grant) is next per plan order. `withPolicySession`/`emitToolCall` helpers live in `test/policy-engine.test.ts`; the bundled default export is exercised via `export { default } from <src/index.ts> }` source. DispatchContext.ui extension is additive-permitted per plan.

## Iteration 3 — Item 3: Confirm-only interaction grant (functional)

**Decision rationale:** First unfinished item per plan prioritization (items 4–6 depend on the interaction grant).

**Red evidence (direct dispatch seam):** New `test/interaction.test.ts` (4 tests) written first; run before implementation: 4/4 failed. The three fixture-provider tests received `undefined` from `emitToolCall` because the manifest declaring `grants: ["events", "interaction"]` failed validation (`unknown grant: interaction`) and the provider was isolated, so its guard module never registered. The refusal test found only a `module-failure` audit record (TypeError on the missing facade key), not `grant-refused`.

**What was done:**
- `src/grants.ts`: added `"interaction"` to `GRANT_KINDS`; new `ConfirmRequest`/`ConfirmOutcome` (`"approved" | "denied"`)/`InteractionGrant` (`confirm(request, { noUiOutcome })`); wired into `GrantApiMap` and `buildFacade` so undeclared access hits the existing refusal proxy.
- `src/host.ts`: `createInteractionBroker()` — live-bound broker holding the current `DispatchContext`; `Host.dispatch` rebinds it at the top of every dispatch. `confirm` resolves through `context.ui.confirm(title, message)` (boolean → approved/denied) only when `hasUI` is true and confirm exists; otherwise it returns `noUiOutcome` immediately (also when no dispatch has occurred yet, e.g. confirm called during activate). Broker is created in `createHookHost` and handed to both `activateProviders` and the `Host`.
- `src/providers.ts`: `activateProviders`/`collectingWiring` take the `InteractionGrant`; interaction is a live call surface handed through directly (confirm has no persistent effect to stage/roll back — transactional activation semantics unchanged).
- `src/types.ts`: `DispatchContext.ui` extended additively with optional `confirm?(title, message): Promise<boolean>` (Pi's `ExtensionUIContext.confirm` shape). No cast/wider type needed since `DispatchContext` is our own declared type; the nine-event `HookModule` contract is untouched.
- `src/index.ts`: exports the three new grant types.
- Tests: no-UI → `noUiOutcome` returned immediately (runner reports `hasUI=false` when no uiContext is bound); stubbed `ctx.ui.confirm` via `session.bindExtensions({ uiContext })` receives the exact request and its accepting (true→approved) and rejecting (false→denied) answers round-trip; undeclared interaction access → `grant-refused` audit record with provider attribution plus the rollback `module-failure` record.

**Assumptions (conservative, reversible):**
- Item text says “uiContext … reporting hasUI=false”, but Pi's runner computes `hasUI` as `uiContext !== noOpUIContext` — binding any uiContext makes it true. The hasUI=false case therefore binds no uiContext (the runner's own false state). Recorded as the only faithful way to get `hasUI=false` at this seam.
- Initially asserted the refusal reason contained `interaction.confirm`; the audit substrate always privacy-redacts persisted `reason` fields (`src/audit.ts` `minimize()`), so the test follows the existing GRANT_KINDS refusal pattern (decision + provider attribution) and additionally pins the activation rollback record. Not a weakening: reason redaction is pre-existing pinned substrate behavior.
- `ConfirmOutcome` is the two-value set `approved`/`denied`; item 4 maps `denied` to a guard deny.

**Changed files:** `src/grants.ts`, `src/host.ts`, `src/providers.ts`, `src/types.ts`, `src/index.ts`, `test/interaction.test.ts` (new).

**Verification:** `npm run verify` → exit 0: tsc clean, eslint clean, vitest 90/90 (6 files; all prior 86 still green).

**Next-iteration notes:** Item 4 (ask severity + fail-closed) is next. Use `facade.interaction.confirm(…, { noUiOutcome: "denied" })` from the policy engine's guard — the policy engine manifest must add the `interaction` grant. The scripted agent turn seam (deterministic `session.agent.streamFn` + marker tool) has no helper yet; build it in item 4's test file. `confirmingUiContext` stub lives in `test/interaction.test.ts`.

## Iteration 4 — Item 4: Ask severity with fail-closed unattended safety (functional)

**Decision rationale:** First unfinished item per plan prioritization; it is the first consumer of item 3's confirm-only interaction grant.

**Red evidence:** Added four item-specific tests and ran `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item4.json` before implementation → exit 1, 10/12 passed and 2/12 failed. Both attended scripted-turn cases expected one confirmation call but observed zero (`expected [] to have a length of 1 but got +0`), proving the placeholder ask path blocked without consulting the interaction broker. The direct no-UI and unattended scripted-turn cases already passed against the prior fail-closed placeholder.

**What was done:**
- `src/policy-engine.ts`: policy-engine now declares the `interaction` grant. The async `tool_call.guard` composes the winning rule as before; an `ask` winner calls `facade.interaction.confirm` exactly once with the rule id and exact tool name, passing `{ noUiOutcome: "denied" }`. Approval allows the observed tool call; rejection or absent UI returns a deny reason containing the winning rule id and `ask` severity. Other non-allow severities remain fail-closed.
- `test/policy-engine.test.ts`: added direct-dispatch coverage proving ask outranks allow and blocks with rule id + severity when no UI is bound. Added the required scripted agent-turn seam: deterministic `session.agent.streamFn`, extension-registered marker tool, model-visible `toolResult` assertions, and marker-file execution count. It proves unattended ask-deny never executes; attended confirmation fires once; accept executes exactly once; reject never executes.

**Assumptions (conservative, reversible):**
- As in item 3, hasUI=false is represented by not binding a uiContext because Pi computes `hasUI` from whether a non-no-op context is bound.
- The exact elevated action is the observed public `tool_call` tool name. The confirmation message includes both tool name and winning rule id; no claim is made beyond that boundary.
- Direct dispatch proves decision shape and reason only; execution claims use the scripted agent turn plus marker side effect/transcript, per the plan's seam contract.

**Changed files:** `src/policy-engine.ts`, `test/policy-engine.test.ts`.

**Verification:** Focused post-implementation run `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item4-green.json` → exit 0, 12/12 passed. `npm run verify` → exit 0: tsc clean, eslint clean, vitest 94/94 (6 files, all prior 90 still green).

**Next-iteration notes:** Follow `.ralph/plan.md` prioritization and `.ralph/items.json`; the ask scripted-turn helper now lives in `test/policy-engine.test.ts`.

## Iteration 5 — Item 5: Hard-deny composition (functional)

**Decision rationale:** First unfinished item per the authoritative plan order. It completes the four-level severity lattice and pins hard-deny as unapprovable and monotonic across provider-config rule layers.

**Startup state:** Branch `main` matched the required branch. The only status entry was untracked `.ralph/loop.md`, inspected as the active harness runtime-control file and left untouched because the protocol explicitly forbids staging it; there was no crashed prior-item code or bundle diff to finish or reset.

**Red evidence (direct dispatch seam):** Added three item-specific tests, then ran `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item5-red.json` before implementation → exit 1, 14/15 passed and 1/15 failed. The second provider-config rule-source case received `undefined` instead of `{ block: true }` (`expected undefined to match object { block: true }`) because the closed provider schema did not yet accept or compose `ruleSources`. The existing severity lattice already made the single-source hard-deny and full-lattice cases pass, so the red isolated the missing layered-source contract.

**What was done:**
- `src/policy-engine.ts`: added closed declarative `ruleSources?: [{ id, rules }]` provider config, flattened with base `rules` before global duplicate-rule-id validation and composition. Source/layer order has no authority; the existing highest-severity and lexical-id rules apply across all layers.
- Added an explicit hard-deny branch before ask handling. It returns the hard-deny decision reason without touching the interaction broker, making the unapprovable behavior structural rather than incidental to the generic non-allow fallback.
- `test/policy-engine.test.ts`: added direct-dispatch coverage proving hard-deny outranks allow/ask/deny with an attached accepting UI but zero confirmation calls; an allow in a second provider-config rule source cannot relax a hard-deny; and the complete allow < ask < deny < hard-deny outcome, lexical tie-break, and reason remain identical under rules-array and object-key reordering.

**Assumptions (conservative, reversible):**
- The minimal in-provider layering shape is optional `ruleSources`, each with a required attribution `id` and closed `rules` array; base `rules` remains required for compatibility with the frozen bundle contract. Project-file loading remains out of scope.
- Rule ids are unique across base rules and every source, preserving deterministic attribution. Source ids do not participate in severity or tie-breaking.
- Direct dispatch is sufficient because this item claims decision shape and confirmation non-invocation, not tool execution or model-visible output.

**Changed files:** `src/policy-engine.ts`, `test/policy-engine.test.ts`, `.ralph/items.json`, `.ralph/progress.md`.

**Verification:** Focused post-implementation run `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item5-green.json` → exit 0, 15/15 passed. Required gate `npm run verify` → exit 0: tsc clean, eslint clean, vitest 97/97 across 6 files; all prior tests remained green.

**Next-iteration notes:** Select work only from the authoritative `.ralph/items.json` using `.ralph/plan.md` prioritization.

## Iteration 6 — Item 6: Host-final approval fingerprints (functional)

**Decision rationale:** First unfinished item per the authoritative plan order. It closes the ask path's time-of-check/time-of-use gap by binding an interactive approval to the exact observed tool name and canonical full input, then consuming that approval at `tool_call.internalFinal`.

**Startup state:** Branch `main` matched the required branch. The only status entry was untracked `.ralph/loop.md`, inspected as the active harness runtime-control file and left untouched because the protocol explicitly forbids staging it; there was no crashed prior-item code or committed-bundle diff to finish or reset.

**Red evidence:** Added three item-specific tests, then ran `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item6-red.json` before implementation → exit 1, 16/18 passed and 2/18 failed. The zero-TTL scripted turn executed the marker instead of returning an error (`expected false to be true`), and the intra-dispatch transform returned no block (`expected undefined to match object { block: true }`). The replay test already passed because the existing guard asked on every dispatch, but it now pins the required new-approval behavior with execution evidence.

**What was done:**
- `src/policy-engine.ts`: added closed `approvalTtlSeconds` provider config with a 300-second default. Approved ask calls now create a Host/session-lived pending approval keyed by `toolCallId`, carrying a SHA256 fingerprint over canonical JSON of the exact tool name and full normalized input, its expiry, and winning rule attribution.
- Added the Policy Engine's `tool_call.internalFinal` handler. It deletes the pending approval before checking it, enforcing exact one-use; rejects expired approvals; recomputes the fingerprint over Host-final input and rejects any mismatch; and never reopens the confirmation prompt. Calls whose approval cannot be safely bound to a `toolCallId` fail closed at guard.
- `test/policy-engine.test.ts`: scripted-turn coverage proves an accepted call executes once and an identical replay receives a second confirmation (rejected in the fixture, so execution remains at one); a zero-second configured TTL deterministically represents an approval already past expiry and prevents marker execution; direct-dispatch coverage uses a fixture transform between guard and internalFinal to prove changed input is blocked with one confirmation only. Scripted call ids are now unique across repeated turns in one session.

**Assumptions (conservative, reversible):**
- `toolCallId` is the Host-observed per-call correlation key. An approved ask without one is denied because safely associating a token across phases is impossible.
- TTL expiry uses `Date.now() >= expiresAt`; `approvalTtlSeconds: 0` is a deterministic local substitute for waiting or fake-timer coordination through Pi's scripted turn and fully exercises the expired-before-internalFinal branch. The omitted setting uses the required 300-second default.
- Canonical JSON preserves semantic object equality under key reordering; actual value changes invalidate the fingerprint. Approval state lives in the provider activation closure, whose lifetime is the owning Host/session.

**Changed files:** `src/policy-engine.ts`, `test/policy-engine.test.ts`, `.ralph/items.json`, `.ralph/progress.md`.

**Verification:** Focused post-implementation run `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item6-green.json` → exit 0, 18/18 passed. Required gate `npm run verify` → exit 0: tsc clean, eslint clean, vitest 100/100 across 6 files; all prior tests remained green.

**Next-iteration notes:** Select work only from the authoritative `.ralph/items.json` using `.ralph/plan.md` prioritization.

## Iteration 7 — Item 7: Provider-tool parity (functional)

**Decision rationale:** First unfinished item per the authoritative plan order. The item explicitly permits a verification-only result when provider-registered and built-in tools already share the observed public `tool_call` dispatch path.

**Startup state:** Branch `main` matched the required branch. The only launch status entry was untracked `.ralph/loop.md`; inspection confirmed it is the active harness runtime-control file. It was left untouched and unstaged as required. There was no crashed prior-item code or committed-bundle diff to finish or reset.

**Red evidence / initial test result:** Added the item-specific scripted-turn parity test first, then ran `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item7-initial.json` before any implementation change → exit 0, 19/19 passed. Per the item's explicit verification-only branch, this green first run is evidence that no gating gap exists: both tool kinds already traverse the same dispatch boundary, so no production fix was invented.

**What was done:**
- `test/policy-engine.test.ts`: added a scripted agent-turn test using the existing tools-grant marker provider. One deny rule targets both the extension-registered `marker` tool and Pi's built-in `read` tool.
- The test pins provenance setup (`marker` is non-builtin; `read` is builtin), proves the denied provider tool never executes via the marker file, asserts both model-visible tool results are errors, and extracts the denial-reason shape to prove both carry the same winning rule id (`deny-tool-parity`) and severity (`deny`).
- No audit target-provenance assertion was added, and no production code changed.

**Assumptions (conservative, reversible):** The built-in `read` tool is a safe parity counterpart because the deny blocks at the observed public `tool_call` boundary before execution. Exact full output strings include the target tool name by design, so parity is asserted on outcome plus the rule-attribution shape rather than requiring different tool names to produce byte-identical messages.

**Changed files:** `test/policy-engine.test.ts`, `.ralph/items.json`, `.ralph/progress.md`.

**Verification:** Initial focused run `npx vitest run test/policy-engine.test.ts --reporter=json --outputFile=/tmp/vitest-item7-initial.json` → exit 0, 19/19 passed. Required gate `npm run verify` → exit 0: tsc clean, eslint clean, vitest 101/101 across 6 files; all prior tests remained green.

**Next-iteration notes:** Provider-tool parity is now pinned at the scripted execution seam; no implementation divergence was found.
