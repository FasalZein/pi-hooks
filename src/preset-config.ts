import defaultRules from './default-rules.json' with { type: 'json' };
import type { GlobalConfig, NamedOverride, ProviderConfigEntry } from './config.js';
import { resolveNamedEntries } from './named-entries.js';

export function resolvePresetConfig(config: GlobalConfig): GlobalConfig {
  const defaults: ProviderConfigEntry[] = [
    { id: 'policy-engine', config: { rules: resolveNamedEntries(defaultRules as NamedOverride[], config.rules ?? []) } },
    { id: 'action-engine', required: false, config: { recipes: resolveNamedEntries([], config.recipes ?? []) } },
  ];
  const byId = new Map(defaults.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const entry of config.providers) {
    if (seen.has(entry.id)) throw new Error(`Duplicate Provider configuration: ${entry.id}`);
    seen.add(entry.id);
    byId.set(entry.id, { ...byId.get(entry.id), ...entry });
  }
  return { ...config, providers: [...byId.values()] };
}
