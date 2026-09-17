---
status: accepted
---

# Unified JSONC configuration and configurable defaults

The owner selected these decisions after source audits of both hooks packages and pi-lsp 0.4.4.

## Decision

- `pi-hooks.jsonc` is the sole product configuration, under Pi's agent directory. JSONC comments remain intact during durable updates.
- The installable Preset supplies named dangerous-command ask rules. These include the 28 existing user patterns and the additional old classifier protections.
- Users add named Policy Rules, Recipes, and LSP Server Definitions. A matching id overrides the entry. `enabled: false` disables it.
- Bare Host remains neutral. Defaults belong to the Preset, not Host mechanism.
- LSP keeps its full upstream protocol, tools, edit checks, and lifecycle. A pinned, checked patch adds optional settings reader/writer effects. This supersedes ADR-0002's prohibition on the LSP factory adapter only.
- The adapter reads global product configuration. It never imports project commands from Pi settings. Session-scoped LSP toggles remain session-scoped. Durable global toggles update JSONC; project-scoped writes are unsupported with an explicit remedy.
- The package installs no server executables. Existing server definitions require explicit migration; machine-specific paths never become shipped defaults.
- Invalid configuration reports an error. It does not silently fall back to a second settings file.
- Approval without an interactive UI denies. Approval never grants a persistent exemption.

## Evidence corrections

The old permission extension already denies dangerous calls when no interactive UI exists. Eleven active helper definitions pin it; the earlier count included a backup file. The old package's danger classifier adds checks beyond the 28 configured patterns.

## Verification

Verify defaults without a file, named add/override/disable, invalid and duplicate entries, comment-preserving durable updates, and global versus session isolation. Use packed installs and real Pi sessions to verify LSP diagnostics, reload, and unchanged workspace-edit safety. Check the dependency patch against its exact source version before packaging.
