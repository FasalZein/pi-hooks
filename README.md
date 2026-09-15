# @tothemoon/pi-hooks

An extension-only Hook Host and capability platform for Pi 0.85.1. It runs trusted Hook Modules in deterministic internal phases:

`guard → transform → internal-final → context → observe`

and loads trusted **Capability Providers**, each declaring exactly the grants it needs (`events`, `tools`, `commands`, `process`, `ui`, `interaction`). The Host hands each provider only its declared, typed API subset.

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

`schemaVersion` may be `1` or `2`. A `schemaVersion 1` file is migrated in-memory to `2` at load — the on-disk file is never rewritten. The versioned schema is [`schema/pi-hooks.global.schema.json`](schema/pi-hooks.global.schema.json). Invalid initial configuration enters Read-Only Safe Mode: known read-only Pi tools are allowed and mutating or unknown tools are blocked.

Use `/hooks status` for configuration source and health, enabled modules and providers (with source, grants, and per-provider health), resolved phase order, mode, and enforcement boundary.

## Enforcement boundary

The Host applies blocks and argument mutations through Pi's public `tool_call` event. Its `internal-final` phase re-evaluates input after all Host-owned transforms. This is not a process-wide final interceptor: a separately loaded later Pi extension can still mutate input after this Host returns.

The Host itself registers no model-visible tool and injects no model prompt. A trusted Capability Provider granted `tools` **does** register model-visible tools, and one granted `commands` registers slash commands — both by explicit grant in trusted global configuration only.

**Process grant is not tool_call-gated.** A provider granted `process` runs child processes with the Pi process's own OS permissions; that execution is outside the observed `tool_call` boundary and is not policy-enforced. The Host owns the lifecycle — start is deferred to `session_start`, and at `session_shutdown` (and when a child's group leader exits early) it best-effort-terminates the child's process group, reaping descendants in the common case. This is best-effort, not OS containment: a child that re-parents into its own session/process group can still escape. Grant `process` only to providers you trust with your shell.

## Verification

```sh
npm run verify
```
