import type { NamedOverride } from './config.js';

/** Override a complete named entry's supplied fields; never concatenate duplicates. */
export function resolveNamedEntries(defaults: readonly NamedOverride[], overrides: readonly NamedOverride[]): NamedOverride[] {
  const entries = new Map(defaults.map((entry) => [entry.id, { ...entry }]));
  const seen = new Set<string>();
  for (const override of overrides) {
    if (seen.has(override.id)) throw new Error(`Duplicate configuration entry: ${override.id}`);
    seen.add(override.id);
    if (override.enabled === false) entries.delete(override.id);
    else {
      const entry = { ...entries.get(override.id), ...override };
      delete entry.enabled;
      entries.set(entry.id, entry);
    }
  }
  return [...entries.values()];
}
