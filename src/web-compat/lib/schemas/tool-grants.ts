import { z } from "zod";

/** Canonical TG1 wire contract, reused by Web and Local. These are configured
 * grants, not proof that a runtime has admitted an invocation. null/absent means
 * legacy-unconverted; an explicit empty grants array authorizes nothing. */
const id = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const pin = z.object({ id, hash }).strict();
export const ToolIdentitySchema = z.object({ source: id, key: id }).strict();
export const ToolGrantSchema = z.object({
  tool: ToolIdentitySchema,
  contract: pin,
  connection: z.object({ kind: z.enum(["mcp_server", "database", "local_connector"]), id, authority_hash: hash }).strict().nullable(),
  execution_target: z.object({ kind: z.enum(["local_workspace", "runner"]), id,
    placement: z.enum(["local_trusted", "local_isolated", "remote_self_hosted", "managed_cloud"]), workspace_hash: hash,
  }).strict().refine(v => v.kind === "local_workspace" ? v.placement === "local_trusted" : v.placement === "remote_self_hosted").nullable(),
  resource_scope: z.object({ kind: id, resource: z.string().min(1).max(8192) }).strict(),
  constraints: z.object({ effects: z.array(z.enum(["read", "write", "delete", "execute"])).min(1).max(4)
    .refine(v => new Set(v).size === v.length), argument_schema_hash: hash,
    max_output_bytes: z.number().int().positive().safe(), max_runtime_seconds: z.number().int().positive().safe(),
  }).strict(),
  policy: pin,
  approval: pin.nullable(),
}).strict().refine(v => (v.connection === null) !== (v.execution_target === null), "exactly one target is required");
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

/** Keys in this closed schema are ASCII; integers are safe in both runtimes.
 * Resource strings must be valid Unicode so Python/JS UTF-8 bytes agree. */
export function grantCanonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))
      throw new Error("INVALID_GRANT_UNICODE");
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}
export function grantMaterial(value: ToolGrant) {
  return { ...value, constraints: { ...value.constraints, effects: [...value.constraints.effects].sort() } };
}
export const ToolGrantSetSchema = z.object({ schema_version: z.literal("tool_grants@1"), grants: z.array(ToolGrantSchema).max(512) }).strict()
  .superRefine((v, ctx) => {
    try {
      const keys = v.grants.map(g => grantCanonicalJson(grantMaterial(g)));
      if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "duplicate exact grant tuple" });
    } catch { ctx.addIssue({ code: "custom", message: "INVALID_GRANT_UNICODE" }); }
  });
export type ToolGrantSet = z.infer<typeof ToolGrantSetSchema>;
export function normalizeToolGrants(value: unknown): ToolGrantSet {
  const parsed = ToolGrantSetSchema.parse(value);
  return { schema_version: parsed.schema_version, grants: parsed.grants.map(grantMaterial)
    .sort((a, b) => {
      // UTF-8 order agrees with Python even when resource names contain astral
      // characters (JS's default UTF-16 comparison does not).
      const x = new TextEncoder().encode(grantCanonicalJson(a)), y = new TextEncoder().encode(grantCanonicalJson(b));
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    }) };
}
export function serializeToolGrants(value: ToolGrantSet): string { return grantCanonicalJson(normalizeToolGrants(value)); }
export function loadToolGrants(value: string): ToolGrantSet { return normalizeToolGrants(JSON.parse(value)); }
