import type { GlobalConfig } from "./config.js";
import { resolveOrder } from "./order.js";
import type { HookModule, HookPhase } from "./types.js";

/**
 * Pure effective-policy preparation (SLICE-0008): duplicate available-ID
 * rejection before any id-keyed lookup is built, configured-module selection,
 * and deterministic ordering. The seam SLICE-0004's authority compiler extends.
 */

export interface EffectivePolicy {
  ok: true;
  modules: HookModule[];
  phaseOrder: Record<HookPhase, string[]>;
}

export interface PolicyFailure {
  ok: false;
  failure: string;
}

export function preparePolicy(available: readonly HookModule[], config: GlobalConfig): EffectivePolicy | PolicyFailure {
  const seen = new Set<string>();
  for (const module of available) {
    if (seen.has(module.id)) return { ok: false, failure: `Duplicate available module id: ${module.id}` };
    seen.add(module.id);
  }

  const byId = new Map(available.map((module) => [module.id, module]));
  const configuredIds = new Set<string>();
  const enabled: HookModule[] = [];
  for (const entry of config.modules) {
    if (configuredIds.has(entry.id)) return { ok: false, failure: `Duplicate configured module id: ${entry.id}` };
    configuredIds.add(entry.id);
    if (entry.enabled === false) continue;
    const module = byId.get(entry.id);
    if (!module) return { ok: false, failure: `Configured module is unavailable: ${entry.id}` };
    enabled.push(module);
  }

  try {
    return { ok: true, ...resolveOrder(enabled) };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
}
