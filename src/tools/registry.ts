import { createHash } from "node:crypto";
import { canonicalToolProjection } from "../shared/tool-projection";
import { LocalContextSchema, type LocalContext } from "../shared/local-contracts";
import { ToolDefinitionSchema, type ToolDefinition } from "../shared/tool-registry-contracts";
import { ToolPlanningReviewSchema, type ToolPlanningReview } from "../shared/tool-invocation-contracts";
import { LocalToolInvocationService, type ToolInvocationOptions } from "../invocations/service";
import { deterministicPlan } from "../invocations/planning";
import { StorageError } from "../storage/sqlite/foundation";

export class ToolRegistryError extends Error {
  constructor(readonly code: "TOOL_CONFLICT" | "TOOL_SCHEMA_INVALID" | "TOOL_SCHEMA_DRIFT" | "TOOL_IMPLEMENTATION_MISSING" | "TOOL_IMPLEMENTATION_UNAVAILABLE" | "TOOL_PROJECTION_STALE" | "TOOL_POLICY_UNAVAILABLE",
    readonly operation?: "register" | "refresh") {
    super(code);
    this.name = "ToolRegistryError";
  }
}
/** Reject lossy JS shapes before Zod or canonicalization can erase constraints. */
export function toolJson(raw: unknown): string {
  try { return canonicalToolProjection(raw); }
  catch { throw new ToolRegistryError("TOOL_SCHEMA_INVALID"); }
}
export function toolDigest(raw: unknown): string {
  return `sha256:${createHash("sha256").update("orchestrion.local.tool-projection.v1\n" + toolJson(raw)).digest("hex")}`;
}
function parse(raw: unknown, operation: "register" | "refresh"): ToolDefinition {
  try {
    toolJson(raw);
    const result = ToolDefinitionSchema.safeParse(raw);
    if (!result.success) throw new ToolRegistryError("TOOL_SCHEMA_INVALID", operation);
    return result.data;
  } catch {
    // Returned declarations are external metadata. Proxy/accessor failures and
    // validation details must never cross the registry trust boundary.
    throw new ToolRegistryError("TOOL_SCHEMA_INVALID", operation);
  }
}
function identity(d: ToolDefinition): string {
  return toolJson([d.context.org_id, d.context.project_id, d.context.principal.type,
    d.context.principal.id, d.connectorId, d.connectionId, d.name]);
}
export function toolAnchor(d: ToolDefinition) {
  return { org_id: d.context.org_id, owner_key: `connection:${toolDigest([d.connectorId, d.connectionId]).slice(7)}`,
    tool_name: d.name, tool_contract_version_id: d.implementationVersion, tool_contract_hash: toolDigest(d) };
}
/** Trusted composition seam, never accepted from IPC/model/config. Callables are
 * retained privately only to prove a real binding; T1 never invokes or exports them.
 * No built-in or privileged adapter is installed by this slice.
 */
export interface ToolImplementation {
  describe(): unknown;
  adapter: (...args: never[]) => unknown;
  planner: (...args: never[]) => unknown;
  planningReview?: ToolPlanningReview;
}
/** Sole Local registry. Model inventories are disposable values, not backing maps. */
export class ToolRegistry {
  #tools = new Map<string, { definition: ToolDefinition; implementation: ToolImplementation;
    describe: ToolImplementation["describe"]; adapter: ToolImplementation["adapter"]; planner: ToolImplementation["planner"]; review: ToolPlanningReview | null }>();
  register(implementation: ToolImplementation): void {
    const binding = this.binding(implementation, "register");
    const definition = this.definition(implementation, binding.describe, "register"), key = identity(definition);
    if (this.#tools.has(key)) throw new ToolRegistryError("TOOL_CONFLICT", "register");
    // The map changes only after binding, declaration, schema and collision
    // checks complete. A failing external implementation cannot register partly.
    this.#tools.set(key, { definition, implementation, ...binding, review: this.review(implementation) });
  }
  private review(i: ToolImplementation): ToolPlanningReview | null {
    try {
      const raw = i.planningReview;
      if (raw === undefined) return null;
      return ToolPlanningReviewSchema.parse(JSON.parse(toolJson(raw)));
    } catch { throw new ToolRegistryError("TOOL_SCHEMA_INVALID"); }
  }
  private binding(i: ToolImplementation, operation: "register" | "refresh") {
    let describe: ToolImplementation["describe"], adapter: ToolImplementation["adapter"], planner: ToolImplementation["planner"];
    try {
      describe = i?.describe;
      adapter = i?.adapter;
      planner = i?.planner;
    } catch {
      throw new ToolRegistryError("TOOL_IMPLEMENTATION_UNAVAILABLE", operation);
    }
    if (typeof describe !== "function" || typeof adapter !== "function" || typeof planner !== "function")
      throw new ToolRegistryError("TOOL_IMPLEMENTATION_MISSING", operation);
    return { describe, adapter, planner };
  }
  private definition(i: ToolImplementation, describe: ToolImplementation["describe"], operation: "register" | "refresh") {
    let raw: unknown;
    try { raw = describe.call(i); }
    catch { throw new ToolRegistryError("TOOL_IMPLEMENTATION_UNAVAILABLE", operation); }
    return parse(raw, operation);
  }
  unregister(context: LocalContext, connectorId: string, connectionId: string, name: string): void {
    // Scope the mutation to exactly the registration principal too.
    for (const [key, row] of this.#tools) if (toolJson(row.definition.context) === toolJson(LocalContextSchema.parse(context))
      && row.definition.connectorId === connectorId && row.definition.connectionId === connectionId && row.definition.name === name) this.#tools.delete(key);
  }
  list(context: LocalContext): ToolDefinition[] {
    const scope = toolJson(LocalContextSchema.parse(context)), result: ToolDefinition[] = [];
    for (const row of this.#tools.values()) {
      if (toolJson(row.definition.context) !== scope) continue;
      const binding = this.binding(row.implementation, "refresh");
      if (binding.describe !== row.describe || binding.adapter !== row.adapter || binding.planner !== row.planner)
        throw new ToolRegistryError("TOOL_SCHEMA_DRIFT", "refresh");
      if (toolJson(this.review(row.implementation)) !== toolJson(row.review)) throw new ToolRegistryError("TOOL_SCHEMA_DRIFT", "refresh");
      if (toolJson(this.definition(row.implementation, binding.describe, "refresh")) !== toolJson(row.definition))
        throw new ToolRegistryError("TOOL_SCHEMA_DRIFT", "refresh");
      result.push(structuredClone(row.definition));
    }
    return result.sort((a, b) => identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
  }
  get(context: LocalContext, connectorId: string, connectionId: string, name: string): ToolDefinition | undefined {
    return this.list(context).find((d) => d.connectorId === connectorId && d.connectionId === connectionId && d.name === name);
  }
  /** The only route from registry-owned planners to callers is the admission
   * service. No public getPlanner/getAdapter/execute path or grant token exists.
   * Options are trusted host composition, never renderer/model registration. */
  invocations(options: ToolInvocationOptions): LocalToolInvocationService {
    return new LocalToolInvocationService(options, this, (definition) => {
      const current = this.get(definition.context, definition.connectorId, definition.connectionId, definition.name);
      if (!current || toolJson(current) !== toolJson(definition)) throw new StorageError("TOOL_SCHEMA_DRIFT");
      const row = this.#tools.get(identity(current))!;
      if (!row.review) throw new StorageError("TOOL_PLANNER_NOT_READY");
      if (row.review.effect !== "read_only") throw new StorageError("TOOL_PROTECTED_NOT_READY");
      if (row.review.resourceKind !== "logical_workspace_path" && row.review.resourceKind !== "http_endpoint")
        throw new StorageError("TOOL_RESOURCE_NOT_READY");
      // The adapter callable stays private to this closure; only a service
      // execution path can reach it with a plan prepared by that same service.
      return { review: structuredClone(row.review), plan: (input) => deterministicPlan(row.planner, input), adapter: row.adapter };
    });
  }
}
