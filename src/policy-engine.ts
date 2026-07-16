import { Type, type Static } from "typebox";
import { defineProvider, type InteractionGrant } from "./grants.js";
import type { GuardResult, HookInvocation } from "./types.js";

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
}, { additionalProperties: false });

export type PolicyRuleConfig = Static<typeof PolicyRule>;
export type PolicyEngineConfig = Static<typeof PolicyEngineConfigSchema>;

const SEVERITY: Record<PolicyRuleConfig["decision"], number> = {
  allow: 0,
  ask: 1,
  deny: 2,
  "hard-deny": 3,
};

export const policyEngineProvider = defineProvider({
  manifest: {
    id: "policy-engine",
    version: "1.0.0",
    grants: ["events", "interaction"],
    configSchema: PolicyEngineConfigSchema,
  },
  activate(facade, config) {
    const rules = prepareRules(config as PolicyEngineConfig);
    facade.events.registerModule({
      id: "policy-engine",
      tool_call: {
        guard: (invocation) => decide(rules, invocation, facade.interaction),
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

async function decide(
  rules: readonly PolicyRuleConfig[],
  invocation: HookInvocation,
  interaction: InteractionGrant,
): Promise<GuardResult | undefined> {
  const winner = composeDecision(rules, invocation);
  if (!winner || winner.decision === "allow") return undefined;
  const toolName = invocation.event.toolName ?? "(unnamed)";
  if (winner.decision === "hard-deny") {
    // Hard-denies are unapprovable: never consult the interaction broker.
    return {
      decision: "deny",
      reason: `Policy Engine rule "${winner.id}" (severity: hard-deny) denies tool "${toolName}"`,
    };
  }
  if (winner.decision === "ask") {
    // Two-phase approval, phase one: ask exactly once for the exact elevated
    // action. Unattended sessions fail closed — no UI means denied immediately.
    const outcome = await interaction.confirm(
      {
        title: "Policy Engine approval",
        message: `Rule "${winner.id}" requires approval to run tool "${toolName}"`,
      },
      { noUiOutcome: "denied" },
    );
    if (outcome === "approved") return undefined;
    return {
      decision: "deny",
      reason: `Policy Engine rule "${winner.id}" (severity: ask) denies tool "${toolName}": approval was not granted`,
    };
  }
  // A plain deny blocks at this observed boundary.
  return {
    decision: "deny",
    reason: `Policy Engine rule "${winner.id}" (severity: ${winner.decision}) denies tool "${toolName}"`,
  };
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
