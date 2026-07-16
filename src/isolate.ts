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
    if (typeof value !== "function") return value;
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
  try {
    const cloned = structuredClone(value);
    seen.set(value, cloned);
    return cloned;
  } catch (error) {
    if (lenient) return undefined;
    throw error;
  }
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
