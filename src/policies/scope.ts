import { posix } from "node:path";
import { type ScopeValue, type ToolScope } from "../shared/tool-scope";
import { StorageError } from "../storage/sqlite/foundation";

function same(a: ScopeValue, b: ScopeValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b))
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  return false;
}

function root(value: ScopeValue): value is string {
  return typeof value === "string" && value.startsWith("/") && !/[\\\u0000%*?]/.test(value)
    && posix.normalize(value) === value && (value === "/" || !value.endsWith("/"));
}

/** Intersect a direct grant/Policy scope without creating execution authority. */
export function narrowScope(parent: ToolScope, child: ToolScope | null): ToolScope {
  const result = structuredClone(parent);
  for (const [key, next] of Object.entries(child ?? {})) {
    if (!Object.hasOwn(parent, key)) throw new StorageError("AUTHORITY_SCOPE_WIDENING");
    const previous = parent[key];
    if (key === "workspace_dir" || key === "base_path") {
      if (!root(previous) || !root(next) || !(next === previous || next.startsWith(previous === "/" ? "/" : `${previous}/`)))
        throw new StorageError("AUTHORITY_SCOPE_WIDENING");
    } else if (!same(previous, next)) throw new StorageError("AUTHORITY_SCOPE_WIDENING");
    result[key] = structuredClone(next);
  }
  return result;
}
