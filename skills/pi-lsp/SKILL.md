---
name: pi-lsp
description: Configure or diagnose the pi-hooks Bundled Extension for language servers, routing, diagnostics, enablement, and reload behavior.
license: MIT
---

# Pi LSP in pi-hooks

1. Read the [Bundled language server guide](../../README.md#bundled-language-server). Treat `$PI_CODING_AGENT_DIR/pi-hooks.jsonc`, or `~/.pi/agent/pi-hooks.jsonc`, as the only LSP configuration owner.
2. Call `lsp` with `{ "operation": "status" }`. Report warnings and disabled Server Definitions before attempting startup.
3. Test a representative file with `capabilities`, then `diagnostics`. Supply `server_id` when needed.
4. Classify the result as configuration, routing, process, capability, or Post-edit Diagnostics behavior.
5. Use `/lsp enable <server>` or `/lsp disable <server>` for a session-only choice. Use `--global` only when the operator authorizes a durable update to `pi-hooks.jsonc`.
6. Reload Pi after changing Server Definitions, languages, commands, or timeouts. Enablement commands apply immediately.
7. Repeat status, capabilities, and diagnostics. Stop before applying a Workspace Edit Preview.

Do not add LSP configuration to Pi settings. Do not create project-level LSP configuration for this adapter. A definition-level `enabled` value is the lowest durable choice; `lsp.enablement` overrides it, and a session choice overrides both.
