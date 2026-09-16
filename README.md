# @tothemoon/pi-hooks

An extension-only Hook Host and capability platform for Pi 0.85.1. It runs trusted Hook Modules in deterministic internal phases:

`guard → transform → internal-final → context → observe`

and loads trusted **Capability Providers**, each declaring exactly the grants it needs (`events`, `tools`, `commands`, `process`, `ui`, `interaction`). The Host hands each provider only its declared, typed API subset.

## Install

```sh
pi install /absolute/path/to/pi-hooks
```

The package manifest loads the named `piHooksPreset`, which composes the Host and Policy Engine. The Preset supplies an empty rules list. Configuration entries override Preset defaults by Provider id. Use `/hooks status` to inspect the composition.

Code imports of the package root receive the Bare Host default instead. The Preset is also available as a named export or through `@tothemoon/pi-hooks/preset`.

### Bundled language server

The manifest also loads `@ian-pascoe/pi-lsp` 0.4.4 and its skill from this package's dependencies. The LSP extension keeps its own lifecycle outside Host grants. Do not also load a standalone `pi-lsp` extension: both register the same `lsp` tool and command.

LSP configuration stays under `lsp` in Pi settings. A language server executable must be available for each configured language. Verification currently requires `tsgo` on PATH for the real TypeScript diagnostics test.

## Configuration

Create trusted global JSONC configuration at `~/.pi/agent/pi-hooks.jsonc` (or `$PI_CODING_AGENT_DIR/pi-hooks.jsonc`):

```jsonc
{
  "schemaVersion": 2,
  "providers": [
    { "id": "my-provider", "enabled": true }
  ],
  "modules": []
}
```

`schemaVersion` can be `1` or `2`. The Host converts version `1` to `2` in memory without rewriting the file. The editor schema is [`schema/pi-hooks.global.schema.json`](schema/pi-hooks.global.schema.json).

The default export is a Bare Host with no Providers. Missing configuration is a valid empty configuration. Invalid configuration creates an Inactive Host. Both pass Pi events through unchanged. A required component activation failure makes the complete Host inactive before any staged registrations reach Pi. An optional component failure isolates that component and degrades runtime health.

Policy requires an explicit composition with the named `policyEngineProvider` export and authorization in the configuration. Configuration does not load Provider implementations from disk.

Use `/hooks status` for activation, configuration health, runtime health, audit health, Providers and their grants, phase order, and the observed boundary.

### Dangerous-command rules

[`examples/dangerous-commands.json`](examples/dangerous-commands.json) contains the 28 migrated ask rules. Copy its Provider entry into trusted global configuration. It does not import old settings automatically.

`glob` matches the complete command, ignores case, and treats only `*` as a wildcard. It is not a shell parser or a sandbox. Approval applies once to the exact input. A Host transform requires fresh approval if that input changes. Without a UI, ask rules deny with a remedy.

### Recipes

The Preset includes an optional Action Engine. Configure its `recipes` array in the `action-engine` Provider entry:

```jsonc
{
  "id": "action-engine",
  "required": false,
  "config": {
    "recipes": [{
      "id": "check-command",
      "event": "tool_call",
      "tool": "bash",
      "commands": [{ "command": "node", "args": ["/trusted/check-command.js"] }],
      "timeoutMs": 3000,
      "onFailure": "ignore",
      "effects": ["block", "add-context"]
    }]
  }
}
```

Each command receives `{ "event", "sessionId", "payload", "input" }` as JSON on stdin. Commands run in order without a shell. Each Recipe must supply a positive `timeoutMs`; the example selects three seconds. Timeout and cancellation terminate the child's process group where supported. Child programs are trusted and have the same OS permissions as Pi.

Empty stdout means no effect. Otherwise stdout is one effect or an array of effects:

- `{ "type": "block", "reason": "..." }` denies a `tool_call`.
- `{ "type": "add-context", "text": "..." }` queues text for the next model context.
- `{ "type": "patch-result", "content": [{ "type": "text", "text": "..." }] }` replaces `tool_result` content.

Recipes must declare permitted effects. Unsupported, undeclared, wrong-event, and malformed effects are refused and audited. `onFailure` defaults to `ignore`; `block` is valid only for `tool_call`. Runtime failures degrade Action Engine health. Invalid Recipe configuration disables the optional Action Engine but leaves policy active. Audit records redact free-form failure reasons; `/hooks status` carries the local diagnostic.

## Native events

Hook Modules accept `input`, `tool_call`, `tool_result`, `context`, `agent_end`, `session_start`, `session_shutdown`, `session_before_compact`, and `session_compact`. Former Claude-style names are rejected with a native-name remedy. For example, replace `PreToolUse` with `tool_call`.

## Enforcement boundary

The Host applies blocks and argument mutations through Pi's public `tool_call` event. Its `internal-final` phase re-evaluates input after all Host-owned transforms. This is not a process-wide final interceptor: a separately loaded later Pi extension can still mutate input after this Host returns.

The Host itself registers no model-visible tool and injects no model prompt. A trusted Capability Provider granted `tools` **does** register model-visible tools, and one granted `commands` registers slash commands — both by explicit grant in trusted global configuration only.

**Process grant is not tool_call-gated.** A provider granted `process` runs child processes with the Pi process's own OS permissions; that execution is outside the observed `tool_call` boundary and is not policy-enforced. The Host owns the lifecycle — start is deferred to `session_start`, and at `session_shutdown` (and when a child's group leader exits early) it best-effort-terminates the child's process group, reaping descendants in the common case. This is best-effort, not OS containment: a child that re-parents into its own session/process group can still escape. Grant `process` only to providers you trust with your shell.

## Verification

```sh
npm run verify
```
