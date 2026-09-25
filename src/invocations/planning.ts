import { createHash } from "node:crypto";
import { ToolPlannerOutputSchema, type ToolPlannerInput } from "../shared/tool-invocation-contracts";
import type { ToolParameterSchema } from "../shared/tool-registry-contracts";
import { toolJson } from "../tools/registry";
import { StorageError } from "../storage/sqlite/foundation";

export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable); Object.freeze(value);
  }
  return value;
}
export function planHash(value: unknown): string {
  return `sha256:${createHash("sha256").update("orchestrion.local.tool-plan.v1\n" + toolJson(value)).digest("hex")}`;
}
/** Evaluate only the bounded schema vocabulary already validated by T1. No
 * coercion, defaults, unknown-key stripping, arbitrary JSON Schema or code eval. */
export function validateArguments(schema: ToolParameterSchema, value: unknown): void {
  const invalid = () => { throw new StorageError("TOOL_ARGUMENTS_INVALID"); };
  if (schema.enum && !schema.enum.some((v) => v === value)) invalid();
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const object = value as Record<string, unknown>, properties = schema.properties ?? {};
    if (schema.required?.some((k) => !Object.hasOwn(object, k))) invalid();
    for (const [key, child] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) validateArguments(properties[key], child);
      else if (schema.additionalProperties === false) invalid();
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || !schema.items) return invalid();
    value.forEach((v) => validateArguments(schema.items!, v));
  } else if (schema.type === "null" ? value !== null
    : schema.type === "integer" || schema.type === "number" ? !Number.isSafeInteger(value)
      : typeof value !== schema.type) invalid();
}
/** Only registered, reviewed synchronous pure code reaches here. No adapter,
 * credential, SQL unit or host object is provided. Native resource planners need
 * their own reviewed confinement owner and remain Not Ready in T2. */
export function deterministicPlan(planner: (...args: never[]) => unknown, input: ToolPlannerInput) {
  function once() {
    try {
      const raw = Reflect.apply(planner, undefined, [immutable(structuredClone(input))]);
      if (raw instanceof Promise) {
        void raw.catch(() => undefined); throw new Error();
      }
      const bytes = toolJson(raw);
      if (Buffer.byteLength(bytes) > 128 * 1024) throw new Error();
      const plan = ToolPlannerOutputSchema.parse(JSON.parse(bytes));
      if (toolJson(plan) !== bytes) throw new Error();
      return plan;
    } catch { throw new StorageError("TOOL_PLAN_INVALID"); }
  }
  const first = once(), second = once();
  if (toolJson(first) !== toolJson(second)) throw new StorageError("TOOL_PLAN_NONDETERMINISTIC");
  return first;
}
