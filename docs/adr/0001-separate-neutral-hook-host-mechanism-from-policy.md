---
status: accepted
---

# Separate neutral Hook Host mechanism from policy

Copied from the Linear record (ADR-001, accepted 2026-08-12) so the repository is self-contained. Wording unchanged except formatting.

## Context

The current package implements a largely generic Hook Host but the default extension composition includes the Policy Engine Provider. Invalid or missing trusted configuration also activates a hardcoded read-tool allowlist. Claude-style event aliases appear in core normalization. These defaults make policy and compatibility choices appear to be Host semantics.

The two prior pi-hooks references are different products. One adapts Claude command hooks. The other bundles feature extensions and permission levels. Pi's public ExtensionAPI is the actual runtime boundary for this package.

## Decision

- pi-hooks is primarily a neutral Hook Host.
- The Pi-native contract is authoritative.
- Core owns structural invariants: typed effects, deterministic order, isolation, transactional activation, declared grants, explicit failure behavior, bounded audit transport, and Inactive Host behavior.
- Core does not decide which tools, inputs, commands, or actions are acceptable.
- The default export is a Bare Host with no bundled Hook Modules or Providers.
- A missing configuration file is a valid empty configuration. The Bare Host remains active, reports status, and changes no Pi event result.
- A present invalid configuration produces an Inactive Host. No configured modules or Providers activate, and Pi events pass through unchanged.
- A required Module or Provider failure makes the complete Host inactive. All staged registrations and processes roll back before Pi binding.
- An optional Module or Provider failure isolates that component. Healthy components remain active. Runtime health becomes degraded with component attribution.
- Top-level status reports activation as `active` or `inactive`. Runtime health and audit health remain separate lanes.
- Core does not apply a hardcoded read-tool allowlist.
- Policy Engine remains available through a named Policy Preset and Provider export in this package.
- Claude command hooks and prior permission behavior remain optional Compatibility Providers.
- Core normalization accepts native Pi event names only. Compatibility Providers translate native events into external protocols.
- Product language stays bounded to observed Pi events. It makes no universal-enforcement, process-final, or OS-containment claim.
- The first delivery keeps the current nine-event typed contract stable. Broader Pi event coverage is separate work.
- The next pre-1.0 release makes a clean break. It changes current default composition and invalid-configuration behavior without a permanent compatibility mode.

## Considered options

- **Host with safe defaults.** Rejected: every default allowlist, approval rule, and danger classification is a policy decision.
- **Minimal event bus only.** Rejected: typed effects, ordering, isolation, grants, and failure behavior are general composition invariants.
- **Disable a failed required component only.** Rejected: makes `required` informational.
- **Fail extension loading.** Rejected: an inspectable Inactive Host reports the exact error through `/hooks status`.
- **Collapse all health into one status.** Rejected: configuration, runtime, and audit failures have different owners.
- **Independent runtime-neutral contract.** Rejected: Pi is the only supported runtime.
- **Claude-compatible contract or core aliases.** Rejected: Claude semantics do not map exactly to Pi.
- **Missing configuration as an error.** Rejected: absence means empty intent.
- **Policy Provider export without a Preset.** Rejected: forces every user to author a composition.
- **Separate Policy Engine package.** Deferred.
- **One broad neutralization and event-expansion release.** Rejected: too large.
- **Deprecation or permanent compatibility mode.** Rejected: pre-1.0.

## Consequences

- Users who want Policy Engine behavior select the named Preset or compose the Provider explicitly.
- Missing configuration becomes a no-op Bare Host instead of read-only policy.
- The hardcoded safe mode and Claude alias acceptance leave core.
- Tests must distinguish Bare Host, Inactive Host, optional degradation, and Preset behavior.
