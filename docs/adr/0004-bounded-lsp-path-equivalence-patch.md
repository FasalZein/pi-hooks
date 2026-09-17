---
status: accepted
---

# Bound the LSP path-equivalence patch

The owner accepted this exception on 2026-09-17 after the integrated workspace-edit proof exposed a defect in `@ian-pascoe/pi-lsp@0.4.4`.

## Context

The checked dependency patch in ADR-0003 only adapted LSP settings. A successful workspace edit can report one existing file through equivalent path spellings. On macOS, the prepared Mutation Manifest can contain `/private/var/...`, while `changed_paths` contains `/var/...`. The upstream exact-string comparison then omits post-edit diagnostics.

## Decision

- Extend the pinned, version-checked dependency patch only for post-edit diagnostic path equivalence.
- Treat two different path strings as equivalent only when both resolve to the same existing file.
- Keep exact matching for identical path strings, including paths that do not exist.
- Return the verified Mutation Manifest path for diagnostics.
- Do not admit unrelated paths through failed or partial path resolution.
- Keep the LSP protocol, Approval, Mutation Manifest validation, execution input, write authorization, apply, cancellation, and rollback behavior unchanged.
- Keep all other dependency files byte-identical.
- Maintain this exception until upstream resolves the defect.
- Do not change machine settings or publish this repair to the upstream repository as part of this decision.

## Consequences

The bundled extension can attach post-edit diagnostics when the successful apply result uses an equivalent alias path. The checked patch now owns one narrow upstream source repair in addition to the settings adapter. Every dependency version change must revalidate the exact source and output checksums. Cutover still requires separate authorization and independent verification.
