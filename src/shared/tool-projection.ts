import { readJsonArray } from "./json-array";
import { canonical, type Json } from "./policy/p0-canonical";

/** Data-only canonicalization for Local Tool contract projections.  It is safe
 * for renderer typechecking: no registry, storage, service or executable
 * adapter dependency is reachable from this module. */
export function canonicalToolProjection(raw: unknown): string {
  function normalize(value: unknown, depth: number): Json {
    if (depth > 32) throw new Error("TOOL_SCHEMA_INVALID");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
    if (typeof value === "string" && !/\p{Cs}/u.test(value)) return value;
    if (Array.isArray(value)) {
      const items = readJsonArray(value);
      if (!items) throw new Error("TOOL_SCHEMA_INVALID");
      return items.map((item) => normalize(item, depth + 1));
    }
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
      const result: Record<string, Json> = {};
      for (const key of Reflect.ownKeys(value)) {
        const property = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
          || !property.enumerable || !("value" in property)) throw new Error("TOOL_SCHEMA_INVALID");
        result[key] = normalize(property.value, depth + 1);
      }
      return result;
    }
    throw new Error("TOOL_SCHEMA_INVALID");
  }

  const normalized = normalize(raw, 0);
  const bytes = canonical(normalized);
  let byteLength=0;
  for (const character of bytes) {
    const point=character.codePointAt(0)!;
    byteLength += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (byteLength > 1024 * 1024) throw new Error("TOOL_SCHEMA_INVALID");
  }
  return bytes;
}
