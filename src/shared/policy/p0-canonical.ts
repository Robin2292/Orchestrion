/** P0 accepts the integer-only subset of F2's orchestrion.canonical-json.v1.
 * Canonical bytes are required: parsing and re-stringifying arbitrary JSON would
 * silently erase Python's int/float distinction, duplicate keys and signed zero.
 * This is not a new release/decision hash protocol.
 */
import { P0_RESOURCE_CHARACTER_RANGES } from "./p0-unicode14";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Scope = { [key: string]: Json };

export class PolicyInputError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function fail(code = "TOOL_POLICY_INPUT_INVALID"): never {
  throw new PolicyInputError(code);
}

// Canonical JSON sorts Unicode code points, not JS UTF-16 code units.
function compareKeys(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Internal serializer for data already parsed from JSON (never caller objects). */
export function canonical(value: Json, depth = 0): string {
  if (depth > 32) fail();
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) fail();
  if (typeof value === "string" && /\p{Cs}/u.test(value)) fail();
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareKeys).map((k) =>
      `${canonical(k, depth + 1)}:${canonical(value[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseCanonical(raw: unknown): Json {
  if (typeof raw !== "string" || raw.length > 128 * 1024) fail();
  let value: Json;
  try { value = JSON.parse(raw) as Json; } catch { return fail(); }
  if (canonical(value) !== raw) fail();
  return value;
}

export function object(value: Json): value is Scope {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function acceptedCharacter(point: number): boolean {
  let low = 0;
  let high = P0_RESOURCE_CHARACTER_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end] = P0_RESOURCE_CHARACTER_RANGES[middle];
    if (point < start) high = middle - 1;
    else if (point > end) low = middle + 1;
    else return true;
  }
  return false;
}

/** Fixed Unicode-14 Web repertoire, independent of host Unicode/ICU versions.
 * Every allowed character is individually NFC and no marks are allowed. Only
 * Hangul L+V / LV+T can compose across such characters (checked by the generator).
 * Reject those sequences instead of silently normalizing them into authority.
 * No host category tables, normalization, URI decoding or platform lookup.
 */
export function safeText(value: string): boolean {
  if (!value.length || value.length > 2048) return false;
  let previous = -1;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (!acceptedCharacter(point) || point === 0x5c) return false;
    if ((previous >= 0x1100 && previous <= 0x1112 && point >= 0x1161 && point <= 0x1175)
      || (previous >= 0xac00 && previous <= 0xd7a3 && (previous - 0xac00) % 28 === 0
        && point >= 0x11a8 && point <= 0x11c2)) return false;
    previous = point;
  }
  return true;
}

export function exactPath(value: string): boolean {
  return safeText(value) && value.startsWith("/") && value !== "/"
    && !/[*?\[\]{}%:~]/u.test(value)
    && value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."
      && part.trim() === part && !part.endsWith("."));
}
