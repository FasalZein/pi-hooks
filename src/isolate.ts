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
 * Frozen deep clone tolerating every SDK-valid payload value: plain objects
 * and arrays are cloned recursively (cycle-aware); any other value is cloned
 * structurally when possible and dropped otherwise. Unfreezable cloned leaves
 * (typed arrays, ArrayBuffers) stay mutable but are private to this view.
 * This is the module-visible view of a whole normalized event, so no handler
 * can reach live Pi state through the invocation.
 */
export function safeFrozenView<T>(value: T): T {
  return freezeDeep(safeClone(value, new WeakMap())) as T;
}

function safeClone(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? undefined : value;
  }
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(safeClone(item, seen));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, nested] of Object.entries(value)) out[key] = safeClone(nested, seen);
    return out;
  }
  try {
    const cloned = structuredClone(value);
    seen.set(value, cloned);
    return cloned;
  } catch {
    return undefined;
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  // Freezing a non-empty ArrayBuffer view throws; the leaf is already a
  // private clone, so leaving it unfrozen cannot reach Pi.
  if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) Object.freeze(value);
  for (const nested of Object.values(value)) freezeDeep(nested, seen);
  return value;
}
