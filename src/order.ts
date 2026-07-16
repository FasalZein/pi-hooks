import { PHASES, type HookModule, type HookPhase } from "./types.js";

export function resolveOrder(modules: readonly HookModule[]): {
  modules: HookModule[];
  phaseOrder: Record<HookPhase, string[]>;
} {
  const byId = new Map<string, HookModule>();
  for (const module of modules) {
    if (byId.has(module.id)) throw new Error(`Duplicate module id: ${module.id}`);
    byId.set(module.id, module);
  }
  for (const module of modules) {
    for (const required of module.requires ?? []) {
      if (!byId.has(required)) throw new Error(`Module ${module.id} requires missing dependency ${required}`);
    }
  }

  const edges = new Map<string, Set<string>>([...byId.keys()].map((id) => [id, new Set()]));
  for (const module of modules) {
    for (const target of module.before ?? []) if (byId.has(target)) edges.get(module.id)?.add(target);
    for (const target of module.after ?? []) if (byId.has(target)) edges.get(target)?.add(module.id);
  }

  const indegree = new Map<string, number>([...byId.keys()].map((id) => [id, 0]));
  for (const targets of edges.values()) {
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0).sort();
  const orderedIds: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    orderedIds.push(id);
    for (const target of [...(edges.get(id) ?? [])].sort()) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (orderedIds.length !== modules.length) {
    const cycle = [...byId.keys()].filter((id) => !orderedIds.includes(id)).sort();
    throw new Error(`Module dependency cycle: ${cycle.join(" -> ")}`);
  }

  const ordered = orderedIds.map((id) => byId.get(id)!);
  const phaseOrder = Object.fromEntries(PHASES.map((phase) => [phase, ordered.filter((module) => hasPhase(module, phase)).map((module) => module.id)])) as Record<HookPhase, string[]>;
  return { modules: ordered, phaseOrder };
}

function hasPhase(module: HookModule, phase: HookPhase): boolean {
  if (phase === "internal-final") return typeof module.internalFinal === "function";
  return typeof module[phase] === "function";
}
