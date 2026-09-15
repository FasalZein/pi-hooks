---
status: accepted
---

# Consolidate the installed hooks and LSP packages into one Preset

Three packages were installed: `prateekmedia/pi-hooks` (four live extensions: permission, checkpoint, repeat, token-rate), `@hsingjui/pi-hooks` (loaded, inert), and `@ian-pascoe/pi-lsp` (fully live). We replace all three with this package, installed once by local path. Decided 2026-09-15.

## Decision

1. **ADR-001 lands first.** The Bare Host default, Inactive Host, and native-only event names are built before the Preset, so the Preset is built once on its final base.
2. **The manifest loads the Preset.** Installing the package loads Host + Policy Engine + Action Engine, plus the Bundled Extension. The Bare Host stays the library default export for composers.
3. **LSP is carried, not hosted.** `@ian-pascoe/pi-lsp` is declared as a dependency and referenced by manifest path so Pi's loader runs it. It runs outside the Host with no Grant Families. Gated on a spike proving its transitive dependencies resolve. The archive's planned first-party "LSP Engine" is superseded.
4. **Permission folds into the Policy Engine.** The 28 dangerous-command patterns become `ask` rules through a new glob matcher. Levels, modes, `/permission`, `/permission-mode`, and the heuristic command classifier are not ported. One owner of tool-call policy.
5. **Checkpoint, repeat, and token-rate are dropped.** Git history covers restore; nothing reads the powerline status key; `pi-tps.ts` already shows tokens per second. Old `refs/pi-checkpoints` stay inert in repositories.
6. **Action Engine with a native Recipe schema.** Fixed-argv commands, JSON envelope on stdin, bounded effects (block, add-context, patch-result), per-Recipe `onFailure` defaulting to ignore. No Claude `hooks` key, no importer.
7. **Approvals are allow-once or deny.** No configuration writes from a prompt.
8. **No-UI outcome is deny with remedy.** Background children fail closed.
9. **Rendering toggle never changes decisions.**
10. **Install by local path.** Not published to npm. Cutover happens only after every ticket lands.

## Considered options

- **Keep pi-lsp as a separate install.** Rejected: the single-install goal is the point.
- **Deep-import or vendor pi-lsp.** Rejected: unversioned internal path, or owning a protocol client.
- **Reimplement LSP on the Host.** Rejected: the process grant has no stdio transport; a 35-operation tool already works upstream.
- **Compatibility Provider reproducing permission levels.** Rejected: two gates on the same tool calls.
- **Port the old permission source.** Rejected: unlocked whole-file settings rewrite, second policy owner.
- **Claude-compatible hooks key.** Rejected: semantics differ on Pi; a native schema is honest.
- **Always-allow persisted from the prompt.** Rejected: needs a locked partial-file write and reintroduces the settings-clobber hazard.
- **Consolidate before ADR-001.** Rejected: re-plumbing the Preset later.

## Consequences

- Muscle memory for `/permission` changes to editing rules in `pi-hooks.jsonc`.
- Twelve agent definitions must be repinned in the same cutover, or helpers lose policy and LSP.
- The old package's classifier levels are gone; only the pattern list survives.
- Every pi-lsp release requires re-checking the pinned version and entry path.
