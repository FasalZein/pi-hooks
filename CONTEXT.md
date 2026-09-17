# pi-hooks

A neutral Hook Host for Pi. It activates Providers, dispatches observed Pi events through fixed phases, and enforces declared grants. The Host defines mechanism; Providers decide policy and behavior.

## Language

### Host

**Hook Host**:
The neutral Pi extension runtime that activates Hook Modules and Providers, dispatches observed Pi events, composes typed effects, and reports status and audit records. It does not select tool policy, danger classifications, or approval rules.
_Avoid_: framework, core (unqualified), engine

**Pi-native contract**:
The public event and result semantics of Pi's supported ExtensionAPI. Authoritative when Pi behavior differs from Claude Code or from prior hooks packages.

**Hook Phase**:
One of the fixed internal stages a `tool_call` passes through: guard, transform, internal-final, context, observe. Order is fixed and identical for every Provider.
_Avoid_: stage, step, middleware

**Observed boundary**:
The public Pi event boundary the Host reaches. A blocked `tool_call` does not execute through Pi's normal tool path. The term claims no universal enforcement and no OS containment.
_Avoid_: sandbox, interceptor

**Structural invariant**:
A composition rule that keeps Host behavior deterministic and bounded without deciding whether a user action is acceptable: typed effects, deterministic order, isolated handler input, transactional activation, declared grants, explicit failure modes, bounded audit transport.

**Hook Module**:
A versioned in-process set of typed handlers registered for Host events and phases. A Hook Module can only return effects permitted for its event.
_Avoid_: hook (unqualified), listener, plugin

**Provider**:
An optional capability package activated by trusted Host configuration. A Provider contributes Hook Modules and may request declared Grant Families.
_Avoid_: plugin, extension (reserved for Pi extensions), module (reserved for Hook Module)

**Grant Family**:
A typed capability boundary the Host exposes to an activated Provider. A Provider receives only the Grant Families it declared and the Host authorized. Current families: events, tools, commands, process, ui, interaction.
_Avoid_: permission (reserved for old package behavior), scope, capability (unqualified)

**Required component**:
A configured Hook Module or Provider whose successful activation is required. Failure makes the complete Host inactive and rolls back staged registrations.

**Optional component**:
A configured Hook Module or Provider that may isolate on failure. Healthy components stay active; runtime health becomes degraded with attribution.

### Host states

**Bare Host**:
The default composition with no Providers. A missing configuration file produces an active Bare Host that registers status and changes no Pi event result.

**Active Host**:
A Host whose required composition activated. A Bare Host is active. Optional failures degrade health without changing activation.

**Inactive Host**:
The state when a present trusted configuration is unreadable or invalid, or a required component fails. Nothing activates; the Host reports the exact failure and passes Pi events through unchanged.
_Avoid_: safe mode, read-only mode, fallback

**Safe mode**:
Deprecated. The former hardcoded read-tool allowlist on invalid configuration. Replaced by Inactive Host.

### Composition and packaging

**Preset**:
An explicit composition of the Hook Host with selected Providers and configuration defaults. The package manifest loads the Preset; the Bare Host stays the library default export.
_Avoid_: bundle, distribution, profile

**Bundled Extension**:
A third-party Pi extension shipped inside this package as a dependency and loaded by Pi's own loader through a manifest path. Its settings adapter uses the checked dependency patch in ADR-0003. It runs outside the Host and holds no Grant Families. `pi-lsp` is a Bundled Extension.
_Avoid_: vendored extension, embedded extension, LSP Engine

**Cutover**:
The one-time switch on a machine from the previous packages to this package: install by path, convert configuration, repin agent definitions, remove the old entries.

### Policy Engine

**Policy Engine**:
The Provider that evaluates declarative tool-call rules at the observed boundary. Decisions: allow, ask, deny, hard-deny. The single owner of tool-call policy in a Preset.
_Avoid_: permission system, gate, guard (reserved for the phase)

**Policy Rule**:
One declarative rule: an id, a match (tool, provenance, input matchers), a decision, a scope, and a remedy.

**Glob matcher**:
An input matcher that matches a whole string value against an anchored, case-insensitive pattern where `*` matches any run of characters. Ports the previous package's dangerous-command patterns one-to-one.

**Approval**:
The interactive outcome of an ask rule: allow-once for this exact Host-final input, or deny. Approvals are never persisted to configuration.
_Avoid_: always-allow, whitelist

**No-UI outcome**:
The decision an ask rule resolves to when no interactive UI exists, as in background children: deny, with the rule's remedy in the reason.

**Remedy**:
The one-line instruction in a denial that tells the model or operator how to get the action allowed.

### Action Engine

**Action Engine**:
The Provider that runs Recipes in response to Host events. Global, native schema, fixed-argv commands.
_Avoid_: command hooks, Claude hooks, Compatibility Provider (this engine reads no foreign schema)

**Recipe**:
A closed declarative binding of one native event to an optional matcher, an ordered list of fixed-argv commands, a timeout, an onFailure posture, and bounded effects. Not a programming language: no variables, loops, or expressions.
_Avoid_: hook script, workflow, pipeline

**Event envelope**:
The JSON document the Action Engine writes to a Recipe command's stdin: event name, session identity, and the event payload after isolation.

**Effect**:
One declared outcome a Recipe command may return on stdout: block (tool_call only), add-context, patch-result. Effects outside the finite set are refused and audited.
_Avoid_: reducer, hook result

**onFailure**:
A Recipe's posture when a command times out or exits non-zero: ignore (proceed, degrade health, audit) or block (tool_call only).

### Presentation

**Hooks TUI**:
The rendered surfaces for the status panel, the approval prompt, and denial blocks in tool results. Controlled by a rendering toggle that never changes a decision.

**Rendering toggle**:
The configuration switch that selects rendered surfaces or plain text. Decisions are identical in both states.
_Avoid_: headless mode
