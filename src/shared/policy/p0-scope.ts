import { canonical, exactPath, fail, object, parseCanonical, safeText, type Json, type Scope } from "./p0-canonical";

/** The upstream object declares scope keys, following Web authority_scope.py.
 * Scope values are whitelists, denied flags, numeric ceilings or exact bindings;
 * they are never executable operators. Missing keys inherit; {} removes authority.
 */
export function validateScope(value: Json): asserts value is Scope {
  if (!object(value)) fail("AUTHORITY_SCOPE_INVALID");
  function visit(item: Json): void {
    if (typeof item === "string" && (!safeText(item) || /[*?\[\]{}%\\]/u.test(item)
      || (item.startsWith("/") && !exactPath(item)))) fail("AUTHORITY_SCOPE_INVALID");
    if (typeof item === "number" && (!Number.isSafeInteger(item) || item < 0)) fail("AUTHORITY_SCOPE_INVALID");
    if (Array.isArray(item)) {
      // Nested structured whitelists remain exact values, never partial matches.
      item.forEach(visit);
      if (new Set(item.map((v) => canonical(v))).size !== item.length) fail("AUTHORITY_SCOPE_INVALID");
    } else if (object(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key)
          || ["__proto__", "prototype", "constructor"].includes(key)) fail("AUTHORITY_SCOPE_INVALID");
        visit(child);
      }
    }
  }
  visit(value);
}

/** Validated, sequential authority layers; every incoming field must narrow. */
export function narrowScope(current: Scope, incoming: Scope): Scope {
  if (!Object.keys(incoming).length) return {};
  const result = { ...current };
  for (const [key, next] of Object.entries(incoming)) {
    if (!Object.hasOwn(current, key)) fail("AUTHORITY_SCOPE_WIDENING");
    const previous = current[key];
    if (object(previous) && object(next)) result[key] = narrowScope(previous, next);
    else if (typeof previous === "boolean" && typeof next === "boolean") {
      if (!previous && next) fail("AUTHORITY_SCOPE_WIDENING");
      result[key] = next;
    } else if (Array.isArray(previous) && Array.isArray(next)) {
      const allowed = new Set(previous.map((item) => canonical(item)));
      if (next.some((item) => !allowed.has(canonical(item)))) fail("AUTHORITY_SCOPE_WIDENING");
      result[key] = next;
    } else if (typeof previous === "number" && typeof next === "number") {
      if (next > previous) fail("AUTHORITY_SCOPE_WIDENING");
      result[key] = next;
    } else {
      if (canonical(previous) !== canonical(next)) fail("AUTHORITY_SCOPE_WIDENING");
      result[key] = next;
    }
  }
  return result;
}

/** Independent policies are each checked against upstream before this meet.
 * Matches Web release_evaluator._intersect_policy_scopes, not sequential restore.
 */
export function meetScopes(left: Scope, right: Scope): Scope {
  if (!Object.keys(left).length || !Object.keys(right).length) return {};
  const result = { ...left };
  for (const [key, next] of Object.entries(right)) {
    const previous = result[key];
    if (!Object.hasOwn(result, key)) result[key] = next;
    else if (object(previous) && object(next)) result[key] = meetScopes(previous, next);
    else if (typeof previous === "boolean" && typeof next === "boolean") result[key] = previous && next;
    else if (typeof previous === "number" && typeof next === "number") result[key] = Math.min(previous, next);
    else if (Array.isArray(previous) && Array.isArray(next)) {
      const allowed = new Set(next.map((item) => canonical(item)));
      result[key] = previous.filter((item) => allowed.has(canonical(item)));
    } else if (canonical(previous) !== canonical(next)) fail("TOOL_POLICY_SCOPE_INCOMPATIBLE");
  }
  return result;
}

/** Pure wire entry point. Unlike Web's optional layer utility, missing input fails. */
export function intersectScopeLayers(raw: unknown): Scope {
  const layers = parseCanonical(raw);
  if (!Array.isArray(layers) || !layers.length || layers.length > 64) fail("AUTHORITY_SCOPE_INVALID");
  layers.forEach(validateScope);
  return (layers as Scope[]).reduce(narrowScope);
}
