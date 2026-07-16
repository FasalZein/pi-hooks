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

/**
 * Frozen deep clone tolerating non-cloneable leaves (functions, AbortSignal,
 * live host objects): plain objects and arrays are cloned recursively; any
 * other value is cloned structurally when possible and dropped otherwise.
 * This is the module-visible view of a whole normalized event, so no handler
 * can reach live Pi state through the invocation.
 */
export function safeFrozenView<T>(value: T): T {
  return freezeDeep(safeClone(value)) as T;
}

function safeClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? undefined : value;
  }
  if (Array.isArray(value)) return value.map(safeClone);
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = safeClone(nested);
    return out;
  }
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}
