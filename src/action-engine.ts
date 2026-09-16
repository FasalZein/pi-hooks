import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNativeEvent } from "./events.js";
import { defineProvider, type ProcessGrant } from "./grants.js";
import type { GuardResult, HookInvocation, HookModule, ToolResultPatch } from "./types.js";

const EffectKind = Type.Union([Type.Literal("block"), Type.Literal("add-context"), Type.Literal("patch-result")]);
const RecipeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  event: Type.String({ minLength: 1 }),
  tool: Type.Optional(Type.String({ minLength: 1 })),
  commands: Type.Array(Type.Object({
    command: Type.String({ minLength: 1 }), args: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }), { minItems: 1 }),
  timeoutMs: Type.Integer({ minimum: 1 }),
  onFailure: Type.Optional(Type.Union([Type.Literal("ignore"), Type.Literal("block")])),
  effects: Type.Optional(Type.Array(EffectKind, { uniqueItems: true })),
}, { additionalProperties: false });

export const ActionEngineConfigSchema = Type.Object({ recipes: Type.Array(RecipeSchema) }, { additionalProperties: false });
export type Recipe = Static<typeof RecipeSchema>;
const EffectSchema = Type.Union([
  Type.Object({ type: Type.Literal("block"), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("add-context"), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("patch-result"), content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false })) }, { additionalProperties: false }),
]);

interface RecipeResult { block?: GuardResult; patch?: ToolResultPatch }

export const actionEngineProvider = defineProvider({
  manifest: { id: "action-engine", version: "1.0.0", grants: ["events", "process"], configSchema: ActionEngineConfigSchema },
  activate(facade, raw) {
    const { recipes } = raw as Static<typeof ActionEngineConfigSchema>;
    const ids = new Set<string>();
    for (const recipe of recipes) {
      assertNativeEvent(recipe.event);
      if (ids.has(recipe.id)) throw new Error(`Recipe ${recipe.id}: duplicate id`);
      ids.add(recipe.id);
      if (recipe.onFailure === "block" && recipe.event !== "tool_call") throw new Error(`Recipe ${recipe.id}: onFailure block requires tool_call`);
      facade.events.registerModule(recipeModule(recipe, facade.process));
    }
  },
});

function recipeModule(recipe: Recipe, process: ProcessGrant): HookModule {
  const id = `recipe:${recipe.id}`;
  const run = (invocation: HookInvocation) => runRecipe(recipe, process, invocation);
  if (recipe.event === "tool_call") return { id, tool_call: { guard: async (invocation) => (await run(invocation)).block } };
  if (recipe.event === "tool_result") return { id, tool_result: { patch: async (invocation) => (await run(invocation)).patch } };
  return { id, [recipe.event]: { observe: async (invocation: HookInvocation) => { await run(invocation); } } };
}

async function runRecipe(recipe: Recipe, process: ProcessGrant, invocation: HookInvocation): Promise<RecipeResult> {
  if (recipe.tool !== undefined && recipe.tool !== invocation.event.toolName) return {};
  const result: RecipeResult = {};
  const stdin = JSON.stringify({
    event: invocation.event.type, sessionId: invocation.context.sessionManager?.getSessionId?.() ?? null,
    payload: invocation.event.payload, input: invocation.input,
  });
  for (const command of recipe.commands) {
    let output: string;
    try {
      output = await process.run({ ...command, cwd: invocation.context.cwd, stdin, timeoutMs: recipe.timeoutMs, signal: invocation.context.signal });
    } catch (error) {
      const reason = `Recipe ${recipe.id}: ${error instanceof Error ? error.message : String(error)}`;
      await invocation.reportFailure?.(reason);
      if (recipe.onFailure === "block") return { block: { decision: "deny", reason } };
      continue;
    }
    await applyOutput(recipe, invocation, output, result);
    if (result.block) break;
  }
  return result;
}

async function applyOutput(recipe: Recipe, invocation: HookInvocation, output: string, result: RecipeResult): Promise<void> {
  if (!output.trim()) return;
  let effects: unknown;
  try { effects = JSON.parse(output); } catch {
    await invocation.reportFailure?.(`Recipe ${recipe.id}: malformed stdout; no effects applied`);
    return;
  }
  for (const effect of Array.isArray(effects) ? effects : [effects]) {
    if (!Value.Check(EffectSchema, effect)) {
      await invocation.reportFailure?.(`Recipe ${recipe.id}: unsupported effect`);
      continue;
    }
    const allowed = recipe.effects?.includes(effect.type)
      && (effect.type !== "block" || recipe.event === "tool_call")
      && (effect.type !== "patch-result" || recipe.event === "tool_result");
    if (!allowed) {
      await invocation.reportFailure?.(`Recipe ${recipe.id}: refused ${effect.type} effect for ${recipe.event}`);
      continue;
    }
    if (effect.type === "block") result.block = { decision: "deny", reason: `Recipe ${recipe.id}: ${effect.reason}` };
    else if (effect.type === "patch-result") result.patch = { content: effect.content };
    else invocation.addContext?.(effect.text);
  }
}
