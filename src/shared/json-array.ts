/** Read a plain dense JSON array without invoking indexed getters or iterators.
 * JSON cannot represent extra own properties or holes. Reject them before either
 * schema parsing or command fingerprinting can silently discard that input.
 * Frozen data arrays are valid: writable/configurable flags carry no JSON meaning.
 */
export function readJsonArray(array: readonly unknown[]): unknown[] | null {
  if (Object.getPrototypeOf(array) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(array, "length");
  if (!length || !("value" in length) || length.enumerable || length.configurable
      || !Number.isInteger(length.value) || length.value < 0 || length.value > 0xffffffff) return null;
  const keys = Reflect.ownKeys(array);
  if (keys.length !== length.value + 1) return null; // Exactly length plus dense own indices.
  const items: unknown[] = new Array(length.value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value) return null;
    const property = Object.getOwnPropertyDescriptor(array, key);
    if (!property || !property.enumerable || !("value" in property)) return null;
    items[Number(key)] = property.value;
  }
  return items;
}
