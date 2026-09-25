import { z } from "zod";
import { readJsonArray } from "./json-array";

export type ScopeValue = null | boolean | number | string | ScopeValue[] | { [key: string]: ScopeValue };
const value: z.ZodType<ScopeValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(8192), z.array(value).max(512), z.record(value),
]));

const rawScopeRecord = z.unknown().superRefine((raw, ctx) => {
  function check(x: unknown, depth: number): void {
    if (depth > 32) { ctx.addIssue({ code: "custom", message: "INVALID_SCOPE", fatal: true }); return; }
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      const items = readJsonArray(x);
      if (!items) { ctx.addIssue({ code: "custom", message: "INVALID_SCOPE_ARRAY", fatal: true }); return; }
      for (const item of items) check(item, depth + 1);
      return;
    }
    const prototype = Object.getPrototypeOf(x);
    if (prototype !== Object.prototype && prototype !== null) {
      ctx.addIssue({ code: "custom", message: "INVALID_SCOPE", fatal: true }); return;
    }
    for (const key of Reflect.ownKeys(x)) {
      const property = Object.getOwnPropertyDescriptor(x, key)!;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
          || !property.enumerable || !("value" in property)) {
        ctx.addIssue({ code: "custom", message: "INVALID_SCOPE_KEY", fatal: true }); continue;
      }
      check(property.value, depth + 1);
    }
  }
  check(raw, 0);
});

/** Bounded, secret-free Policy scope used by direct Tool grants. */
export const ToolScopeSchema = rawScopeRecord.pipe(z.record(value)).superRefine((scope, ctx) => {
  function check(x: ScopeValue, depth: number): void {
    if (depth > 32) { ctx.addIssue({ code: "custom", message: "INVALID_SCOPE" }); return; }
    if (x && typeof x === "object") for (const [key, item] of Object.entries(x)) {
      if (/(key|token|secret|password|credential|authorization)/i.test(key))
        ctx.addIssue({ code: "custom", message: "SECRET_MATERIAL_DENIED" });
      check(item, depth + 1);
    }
  }
  check(scope, 0);
});
export type ToolScope = z.infer<typeof ToolScopeSchema>;
