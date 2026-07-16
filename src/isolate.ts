/**
 * The mutation invariant in one place (SLICE-0008): deep clone inbound payloads,
 * hand modules frozen views, clone outbound explicit results. No other module
 * performs isolation of module-visible payloads.
 *
 * All clone paths share one primitive that privatizes shared memory:
 * structuredClone deliberately aliases SharedArrayBuffer storage, so direct
 * SharedArrayBuffers and views backed by them are copied byte-for-byte into
 * private ArrayBuffer storage. Cycles and repeated references are preserved.
 */

export function cloneDeep<T>(value: T): T {
  return isolatedClone(value, new WeakMap(), false) as T;
}

export function frozenView<T>(value: T): T {
  return freezeDeep(cloneDeep(value));
}

/**
 * Frozen deep clone tolerating every SDK-valid payload value: non-cloneable
 * leaves (functions, live host objects like AbortSignal) are dropped instead
 * of throwing. Unfreezable cloned leaves (typed arrays, buffers) stay mutable
 * but are private to this view. This is the module-visible view of a whole
 * normalized event, so no handler can reach live Pi state through it.
 */
export function safeFrozenView<T>(value: T): T {
  return freezeDeep(isolatedClone(value, new WeakMap(), true)) as T;
}

function isolatedClone(value: unknown, seen: WeakMap<object, unknown>, lenient: boolean): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value !== "function" && typeof value !== "symbol") return value;
    if (lenient) return undefined;
    return structuredClone(value); // throws DataCloneError, matching strict clone semantics
  }
  if (seen.has(value)) return seen.get(value);

  if (isSharedArrayBuffer(value)) {
    const copy = copySharedBytes(value);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const copy = privatizeView(value);
    seen.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(isolatedClone(item, seen, lenient));
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, nested] of Object.entries(value)) out[key] = isolatedClone(nested, seen, lenient);
    return out;
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    seen.set(value, out);
    for (const [key, nested] of value) out.set(isolatedClone(key, seen, lenient), isolatedClone(nested, seen, lenient));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    seen.set(value, out);
    for (const item of value) out.add(isolatedClone(item, seen, lenient));
    return out;
  }
  try {
    const cloned = structuredClone(value);
    // structuredClone privatizes ordinary storage but aliases SharedArrayBuffer
    // memory nested inside delegated containers; copy those bytes too.
    privatizeSharedLeaves(cloned, new WeakMap());
    seen.set(value, cloned);
    return cloned;
  } catch (error) {
    if (lenient) return undefined;
    throw error;
  }
}

/**
 * Walk an owned cloned graph in place, replacing shared-memory leaves with
 * private copies. Replacements are memoized so a leaf referenced more than
 * once maps to one private copy, preserving reference identity.
 */
function privatizeSharedLeaves(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (isSharedArrayBuffer(value)) {
    const copy = copySharedBytes(value);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    if (!isSharedArrayBuffer(value.buffer)) return value;
    const copy = privatizeView(value);
    seen.set(value, copy);
    return copy;
  }
  seen.set(value, value);
  if (value instanceof Map) {
    for (const [key, nested] of [...value]) {
      const privateKey = privatizeSharedLeaves(key, seen);
      const privateNested = privatizeSharedLeaves(nested, seen);
      if (privateKey !== key) value.delete(key);
      value.set(privateKey, privateNested);
    }
    return value;
  }
  if (value instanceof Set) {
    for (const item of [...value]) {
      const privateItem = privatizeSharedLeaves(item, seen);
      if (privateItem !== item) {
        value.delete(item);
        value.add(privateItem);
      }
    }
    return value;
  }
  // structuredClone output carries data properties only, but not all are
  // enumerable (Error.cause, AggregateError.errors) — walk every own property.
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const privateNested = privatizeSharedLeaves(descriptor.value, seen);
    if (privateNested !== descriptor.value) {
      Object.defineProperty(value, key, { ...descriptor, value: privateNested });
    }
  }
  return value;
}

function isSharedArrayBuffer(value: object): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function copySharedBytes(buffer: SharedArrayBuffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buffer));
  return copy;
}

/** Copy a typed array or DataView into private ArrayBuffer-backed storage. */
function privatizeView(view: ArrayBufferView): ArrayBufferView {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const buffer = new ArrayBuffer(view.byteLength);
  new Uint8Array(buffer).set(bytes);
  if (view instanceof DataView) return new DataView(buffer);
  const Ctor = view.constructor as new (buffer: ArrayBuffer) => ArrayBufferView;
  return new Ctor(buffer);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  // Freezing a non-empty ArrayBuffer view throws; buffers and views are
  // already private copies, so leaving them unfrozen cannot reach Pi.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeDeep(nested, seen);
  return value;
}
