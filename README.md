# @tothemoon/pi-hooks

An extension-only Hook Host for Pi 0.80.7. It runs trusted modules in deterministic internal phases:

`guard → transform → internal-final → context → observe`

## Configuration

Create trusted global JSONC configuration at `~/.pi/agent/pi-hooks.jsonc` (or `$PI_CODING_AGENT_DIR/pi-hooks.jsonc`):

```jsonc
{
  "schemaVersion": 1,
  "modules": []
}
```

The versioned schema is [`schema/pi-hooks.global.schema.json`](schema/pi-hooks.global.schema.json). Invalid initial configuration enters Read-Only Safe Mode: known read-only Pi tools are allowed and mutating or unknown tools are blocked.

Use `/hooks status` for configuration source and health, enabled modules, resolved phase order, mode, and enforcement boundary.

## Enforcement boundary

The Host applies blocks and argument mutations through Pi's public `tool_call` event. Its `internal-final` phase re-evaluates input after all Host-owned transforms. This is not a process-wide final interceptor: a separately loaded later Pi extension can still mutate input after this Host returns.

The extension registers no model-visible tool and injects no model prompt.

## Verification

```sh
npm run verify
```
