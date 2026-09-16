import type { GlobalConfig } from "./config.js";
import { resolveOrder } from "./order.js";
import { validateModuleEvents } from "./events.js";
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
  /** Requiredness per configured module id, sourced only from trusted global entries (default true). */
  required: Map<string, boolean>;
  failures: string[];
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
  const required = new Map<string, boolean>();
  const enabled: HookModule[] = [];
  const failures: string[] = [];
  for (const entry of config.modules) {
    if (configuredIds.has(entry.id)) return { ok: false, failure: `Duplicate configured module id: ${entry.id}` };
    configuredIds.add(entry.id);
    required.set(entry.id, entry.required !== false);
    if (entry.enabled === false) continue;
    const module = byId.get(entry.id);
    if (!module) {
      if (entry.required !== false) return { ok: false, failure: `Configured required module is unavailable: ${entry.id}` };
      failures.push(`Configured optional module is unavailable: ${entry.id}`);
      continue;
    }
    try {
      validateModuleEvents(module);
      enabled.push(module);
    } catch (error) {
      const failure = `Module ${entry.id}: ${error instanceof Error ? error.message : String(error)}`;
      if (entry.required !== false) return { ok: false, failure };
      failures.push(failure);
    }
  }

  try {
    return { ok: true, ...resolveOrder(enabled), required, failures };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
}
