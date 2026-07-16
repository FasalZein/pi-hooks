/**
 * The mutation invariant in one place (SLICE-0008): deep clone inbound payloads,
 * hand modules frozen views, clone outbound explicit results. No other module
 * performs isolation of module-visible payloads.
 */

export function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

export function frozenView<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}
