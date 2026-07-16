# Execution Plan: SLICE-0011 Policy Engine core + lint verification gate

## Source Inputs

Distilled from wiki vault artifacts (read during planning; not required at runtime):

- /Users/tothemoon/Knowledge/projects/pi-hooks/slices/SLICE-0011-policy-engine-core-declarative-rules-fail-closed-unattended-safety-and-host-fina.md (acceptance contract)
- /Users/tothemoon/Knowledge/projects/pi-hooks/handoffs/HANDOFF-0006-implement-the-prd-0003-1-0-platform-starting-at-slice-0011.md (guardrails, roadmap position)
- ADR-0001 (extension-only), ADR-0005 (typed grant families), ADR-0006 (closed declarative config) in the same vault
- Three pre-launch bundle reviews (Opus/GLM/GPT) whose accepted findings are folded into this revision

Additional owner requirement: add a lint gate so the loop's `npm run verify` covers typecheck + lint + tests.

## Objective

Ship the Policy Engine core in `/Users/tothemoon/Dev/AI/pi/extensions/pi-hooks`: a bundled config-driven capability provider on the public grant lane (events grant, observed `tool_call` boundary) with declarative deny/ask/allow/hard-deny rules, fail-closed unattended behavior, exact one-use expiring approval fingerprints over Host-final input, unapprovable hard-denies, identical gating for provider-registered tools, and agent-first denial messages. Also add ESLint so `npm run verify` self-verifies style and correctness.

## Scope In

- New `src/policy-engine.ts` (rule algebra, matching, decisions), bundled as a provider in `src/index.ts`'s default export (`createPiHooksExtension({ providers: [policyEngineProvider] })`).
- Minimal `interaction` grant kind (confirm only) in `src/grants.ts`/`src/providers.ts` per ADR-0005, with a live-bound broker created in `createHookHost`: Host updates the broker's current DispatchContext at each dispatch; `confirm(request, { noUiOutcome })` returns the fallback immediately when `hasUI` is false. This is a deliberate early subset of the full interaction grant family that a later slice (SLICE-0020) extends.
- Two-phase approvals: ask + confirm at `tool_call.guard` storing a SHA256 fingerprint over canonical JSON of tool name + full input with a TTL; validate and consume the single-use fingerprint at `tool_call.internalFinal` over the Host-final input; any Host-owned input change invalidates without re-asking. Intra-dispatch invalidation (transform between guard and internalFinal) and cross-dispatch single-use/expiry are two distinct mechanisms sharing one Host-lived store.
- Tests at both required seams (see Test seams below), reusing helpers in `test/providers.test.ts` (temp `PI_CODING_AGENT_DIR`, `withProviderSession`, `toolProviderSource`). Tests inject `uiContext` via `session.bindExtensions({ uiContext })` to control `hasUI` and stub `ctx.ui.confirm`.
- ESLint flat config with typescript-eslint recommended, `npm run lint`, and `verify` extended to `typecheck && lint && test`.

## Scope Out

- Baseline Ruleset and shell command corpus (SLICE-0012).
- Project-level config file loading and trust integration (`.pi/pi-hooks.jsonc` is SLICE-0010). Layered-rule tests in this bundle exercise rule sources inside the provider's own config only.
- Other grant families beyond confirm (select/input/notify/editor/metrics are SLICE-0020), provider sources/lock (SLICE-0018), recipes/importer (SLICE-0021/0022).
- New audit schema fields. The audit record's provider attribution keeps its current meaning (the provider that produced the record); do not assert or add target-tool provenance in audit records.
- Wiki bookkeeping (slice checkboxes, NOTE evidence, `wiki sync`): the supervising session does this after the loop completes, from `.ralph/progress.md` evidence.
- Any edits to Pi core, `/Users/tothemoon/.pi/agent/git/github.com/prateekmedia/pi-hooks`, `/Users/tothemoon/.pi/agent/npm/node_modules/@hsingjui/pi-hooks`, or shared Pi configuration.

## Rule contract (bundle decision, minimum schema)

Rules are closed declarative data living in the Policy Engine's provider entry: `providers: [{ id: "policy-engine", enabled: true, config: { rules: [...] } }]`. The top-level global config schema has `additionalProperties: false`; never add a top-level key. The provider's own TypeBox `configSchema` validates rules; invalid rules isolate/degrade the provider per existing substrate semantics.

Each rule:

- `id` (required, unique string) — used for attribution in reasons/messages.
- `match` — selectors over the observed call: `tool` (exact name or array of names), `provenance` (`builtin` | `extension`, optional provider source id), `input` (matchers evaluated against the normalized, canonical-JSON form of the tool input).
- `decision` — `allow` | `ask` | `deny` | `hard-deny`.
- `scope` (required string) and `remedy` (required string) — consumed by agent-first messages.

Composition: the highest severity among all matching rules wins, ordered `allow < ask < deny < hard-deny`. Same-severity ties resolve to the lexicographically smallest rule `id` for attribution. Determinism means the full outcome — decision, winning rule id, and message metadata — is identical under any reordering of the rules array and of object keys. The deny reason string always carries the winning rule id and its severity so composition is observable at the boundary. Approval TTL defaults to 300 seconds, overridable in the provider config.

## Test seams

Two seams, used for different claims:

1. Direct dispatch (`DefaultResourceLoader` + `createAgentSession` + `session.extensionRunner.emitToolCall`): proves normalized dispatch, decision shape (`{ block, reason }`), and reason content. It does NOT execute the tool and cannot prove execution or model-visible output.
2. Scripted agent turn: drive a real agent turn with a deterministic `session.agent.streamFn` that requests a marker tool call, then assert on the transcript/tool-result — the marker tool's side effect proves "executed once"; its absence proves "never executed"; the blocked tool result proves model-visible output. Use this seam for every "never executes", "executes once", and message-visibility claim (items 4-8).

## Frozen contract clarification

The frozen surface is the nine-event `HookModule` typed-effect contract (event names, handler groups, effect types). `DispatchContext` is not part of that contract: extending `DispatchContext.ui` additively with `confirm(...)` is permitted and expected for the interaction grant. If a cast is needed to reach Pi's runtime `ExtensionUIContext.confirm`, define one internal wider type (e.g. `PiUiSurface`) in the new code rather than scattering casts.

## Constraints

- ADR-0001: extension-only; enforcement happens at the observed public `tool_call` boundary. Never claim universal enforcement, process-final interception, or OS containment in code, messages, or docs.
- Policy Engine is a provider on the public grant lane with no private Host access.
- Red first per functional item: write the failing test at the correct seam, run it, record the red output summary in `.ralph/progress.md`, then implement. The tooling item (lint) has no red test; its honesty step is proving the linter bites.
- No `.skip`, `.only`, test weakening, or test deletion. All 78 existing tests stay green (test/adapter.test.ts, test/host.test.ts, test/providers.test.ts, test/types.test.ts), including the packed managed-install tests inside the suite.
- `npm run verify` must pass before every commit. One item, one commit.
- Config remains closed declarative data (ADR-0006): rules are JSON config, never executable code.

## Prioritization Strategy

`.ralph/items.json` is the source of truth for item status. Items have a natural dependency order — 1 (lint) first because it strengthens every later gate run, then 2 (matching + allow/deny), 3 (interaction grant infrastructure), 4 (ask + fail-closed, needs 3), 5 (hard-deny + full lattice, needs 4 for the ask case), 6 (fingerprints, needs 4), 7 (provider parity, needs 2), 8 (messages, needs 2; asserts ask messaging only if 4 landed). Follow this order unless an item is hard-blocked; later items assume earlier behaviors exist and their red tests are written against that assumption.

## Completion Definition

All items in `.ralph/items.json` have `passes: true`, `npm run verify` (typecheck + lint + full vitest suite) exits green in a clean tree on branch `main`, and `.ralph/progress.md` carries per-item red/green evidence. Slice closure in the wiki vault happens outside this loop.
