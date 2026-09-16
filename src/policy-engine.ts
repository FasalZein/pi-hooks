import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { defineProvider, type InteractionGrant } from "./grants.js";
import type { GuardResult, HookInvocation } from "./types.js";
import { matchesGlob } from "./glob.js";

/**
 * Policy Engine core (SLICE-0011): a config-driven Capability Provider on the
 * events grant lane. Rules are closed declarative data (ADR-0006) evaluated at
 * the observed public tool_call boundary — never universal enforcement or OS
 * containment (ADR-0001). Composition is a severity lattice
 * allow < ask < deny < hard-deny: the highest severity among matching rules
 * wins, same-severity ties resolve to the lexicographically smallest rule id,
 * and the full outcome (decision, winning rule id, reason) is deterministic
 * under any reordering of the rules array and of object keys.
 */

const InputMatcher = Type.Object({
  /** Canonical-JSON deep equality: object key order never matters. */
  equals: Type.Optional(Type.Unknown()),
  /** Substring match on a string value. */
  contains: Type.Optional(Type.String({ minLength: 1 })),
  glob: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RuleMatch = Type.Object({
  tool: Type.Optional(Type.Union([
    Type.String({ minLength: 1 }),
    Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  ])),
  provenance: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("builtin"), Type.Literal("extension")]),
    /** Exact provenance source id; narrows the kind match. */
    sourceId: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
  /** Dot-path keyed matchers over the normalized tool input. */
  input: Type.Optional(Type.Record(Type.String({ minLength: 1 }), InputMatcher)),
}, { additionalProperties: false });

const PolicyRule = Type.Object({
  id: Type.String({ minLength: 1 }),
  match: RuleMatch,
  decision: Type.Union([
    Type.Literal("allow"),
    Type.Literal("ask"),
    Type.Literal("deny"),
    Type.Literal("hard-deny"),
  ]),
  scope: Type.String({ minLength: 1 }),
  remedy: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const RuleSource = Type.Object({
  id: Type.String({ minLength: 1 }),
  rules: Type.Array(PolicyRule),
}, { additionalProperties: false });

export const PolicyEngineConfigSchema = Type.Object({
  rules: Type.Array(PolicyRule),
  /** Additional declarative layers composed with the provider's base rules. */
  ruleSources: Type.Optional(Type.Array(RuleSource)),
  /** Interactive approval lifetime; defaults to five minutes. */
  approvalTtlSeconds: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

export type PolicyRuleConfig = Static<typeof PolicyRule>;
export type PolicyEngineConfig = Static<typeof PolicyEngineConfigSchema>;

const SEVERITY: Record<PolicyRuleConfig["decision"], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
  "hard-deny": 3,
};

interface PendingApproval {
  fingerprint: string;
  expiresAt: number;
  rule: PolicyRuleConfig;
}

export const policyEngineProvider = defineProvider({
  manifest: {
    id: "policy-engine",
    version: "1.0.0",
    grants: ["events", "interaction"],
    configSchema: PolicyEngineConfigSchema,
  },
  activate(facade, rawConfig) {
    const config = rawConfig as PolicyEngineConfig;
    const rules = prepareRules(config);
    const approvalTtlMs = (config.approvalTtlSeconds ?? 300) * 1000;
    // Provider activation is Host-lived, so approvals survive across dispatches
    // but never escape this Host/session. Each toolCallId owns at most one token.
    const approvals = new Map<string, PendingApproval>();
    facade.events.registerModule({
      id: "policy-engine",
      tool_call: {
        guard: (invocation) => decideGuard(rules, invocation, facade.interaction, approvals, approvalTtlMs),
        internalFinal: (invocation) => validateFinalApproval(rules, invocation, facade.interaction, approvals, approvalTtlMs),
      },
    });
  },
});

/** Rule ids carry attribution; duplicates would make the tie-break ambiguous. */
function prepareRules(config: PolicyEngineConfig): readonly PolicyRuleConfig[] {
  const rules = [
    ...config.rules,
    ...(config.ruleSources ?? []).flatMap((source) => source.rules),
  ];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`duplicate policy rule id: ${rule.id}`);
    seen.add(rule.id);
  }
  return rules;
}

async function decideGuard(
  rules: readonly PolicyRuleConfig[],
  invocation: HookInvocation,
  interaction: InteractionGrant,
  approvals: Map<string, PendingApproval>,
  approvalTtlMs: number,
  approvalRule?: PolicyRuleConfig,
): Promise<GuardResult | undefined> {
  const winner = approvalRule ?? composeDecision(rules, invocation);
  if (!winner || winner.decision === "allow") return undefined;
  const toolName = invocation.event.toolName ?? "(unnamed)";
  if (winner.decision === "hard-deny") {
    // Hard-denies are unapprovable: never consult the interaction broker.
    return {
      decision: "deny",
      reason: denialReason(winner, toolName),
    };
  }
  if (winner.decision === "ask") {
    // Two-phase approval, phase one: ask exactly once for the exact elevated
    // action. Unattended sessions fail closed — no UI means denied immediately.
    const outcome = await interaction.confirm(
      {
        title: "Policy Engine approval",
        message: `Rule: ${winner.id}\nTool: ${toolName}\nCommand: ${typeof invocation.input.command === "string" ? invocation.input.command : canonicalJson(invocation.input)}\nScope: ${winner.scope}\nRemedy: ${winner.remedy}`,
      },
      { noUiOutcome: "denied" },
    );
    if (outcome !== "approved") {
      return {
        decision: "deny",
        reason: denialReason(winner, toolName, "approval was not granted"),
      };
    }
    const toolCallId = invocation.event.toolCallId;
    if (toolCallId === undefined) {
      return {
        decision: "deny",
        reason: denialReason(winner, toolName, "approval could not be bound to this tool call"),
      };
    }
    approvals.set(toolCallId, {
      fingerprint: toolCallFingerprint(toolName, invocation.input),
      expiresAt: Date.now() + approvalTtlMs,
      rule: winner,
    });
    return undefined;
  }
  // A plain deny blocks at this observed boundary.
  return {
    decision: "deny",
    reason: denialReason(winner, toolName),
  };
}

/**
 * Two-phase approval, phase two: consume the toolCallId-bound token exactly
 * once and compare its SHA256 fingerprint with the Host-final observed input.
 * A transform mismatch requires fresh approval for the final input. Expiry denies.
 */
async function validateFinalApproval(
  rules: readonly PolicyRuleConfig[],
  invocation: HookInvocation,
  interaction: InteractionGrant,
  approvals: Map<string, PendingApproval>,
  approvalTtlMs: number,
): Promise<GuardResult | undefined> {
  const toolCallId = invocation.event.toolCallId;
  const approval = toolCallId === undefined ? undefined : approvals.get(toolCallId);
  if (toolCallId !== undefined) approvals.delete(toolCallId);
  const winner = composeDecision(rules, invocation);
  const toolName = invocation.event.toolName ?? "(unnamed)";
  if (winner?.decision === "deny" || winner?.decision === "hard-deny") {
    return { decision: "deny", reason: denialReason(winner, toolName) };
  }
  if (!approval) {
    const result = await decideGuard(rules, invocation, interaction, approvals, approvalTtlMs);
    if (toolCallId !== undefined) approvals.delete(toolCallId);
    return result;
  }
  if (Date.now() >= approval.expiresAt) {
    return {
      decision: "deny",
      reason: denialReason(approval.rule, toolName, "approval expired before Host-final validation"),
    };
  }
  if (toolCallFingerprint(toolName, invocation.input) !== approval.fingerprint) {
    const rule = winner?.decision === "ask" ? winner : approval.rule;
    const result = await decideGuard([], invocation, interaction, approvals, approvalTtlMs, rule);
    if (toolCallId !== undefined) approvals.delete(toolCallId);
    return result;
  }
  return undefined;
}

function toolCallFingerprint(toolName: string, input: Readonly<Record<string, unknown>>): string {
  const serialized = canonicalJson({ toolName, input });
  return createHash("sha256").update(serialized ?? "null").digest("hex");
}

function denialReason(rule: PolicyRuleConfig, toolName: string, detail?: string): string {
  const guidance = `Scope: ${rule.scope}. Remedy: ${rule.remedy}.`;
  return `Policy Engine rule "${rule.id}" (severity: ${rule.decision}) denies tool "${toolName}". ${guidance}${detail === undefined ? "" : ` Detail: ${detail}.`}`;
}

/** Highest severity wins; same-severity ties go to the smallest rule id. */
function composeDecision(rules: readonly PolicyRuleConfig[], invocation: HookInvocation): PolicyRuleConfig | undefined {
  let winner: PolicyRuleConfig | undefined;
  for (const rule of rules) {
    if (!matches(rule.match, invocation)) continue;
    if (
      winner === undefined
      || SEVERITY[rule.decision] > SEVERITY[winner.decision]
      || (SEVERITY[rule.decision] === SEVERITY[winner.decision] && rule.id < winner.id)
    ) {
      winner = rule;
    }
  }
  return winner;
}

function matches(match: Static<typeof RuleMatch>, invocation: HookInvocation): boolean {
  const { event, input } = invocation;
  if (match.tool !== undefined) {
    const names = typeof match.tool === "string" ? [match.tool] : match.tool;
    if (event.toolName === undefined || !names.includes(event.toolName)) return false;
  }
  if (match.provenance !== undefined) {
    const source = event.provenance?.source;
    if (match.provenance.kind === "builtin") {
      if (source !== "builtin") return false;
    } else if (source === undefined || source === "builtin") {
      return false;
    }
    if (match.provenance.sourceId !== undefined && source !== match.provenance.sourceId) return false;
  }
  if (match.input !== undefined) {
    for (const [path, matcher] of Object.entries(match.input)) {
      const value = resolvePath(input, path);
      if (Object.hasOwn(matcher, "equals") && canonicalJson(value) !== canonicalJson(matcher.equals)) return false;
      if (matcher.contains !== undefined && (typeof value !== "string" || !value.includes(matcher.contains))) return false;
      if (matcher.glob !== undefined && (typeof value !== "string" || !matchesGlob(matcher.glob, value))) return false;
    }
  }
  return true;
}

function resolvePath(input: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Canonical JSON: recursively key-sorted, so object key order never matters. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeysDeep(record[key])]));
  }
  return value;
}
