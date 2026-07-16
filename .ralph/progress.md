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
