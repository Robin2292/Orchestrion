import { z } from "zod";
import { localCommandSchema } from "../local-contracts";
import { exactPath, parseCanonical, PolicyInputError, type Json, type Scope } from "./p0-canonical";
import { meetScopes, narrowScope, validateScope } from "./p0-scope";

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
const path = z.string().refine(exactPath);
const endpoint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const decision = z.enum(["allow", "require_approval", "deny"]);
const scope = z.unknown().superRefine((value, ctx) => {
  try { validateScope(value as Json); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid scope" }); }
}).transform((value) => value as Scope);

// Exact field vocabulary from ToolPolicyRuleV1; unknown operators fail closed.
export const P0RuleSchema = z.object({
  rule_id: token, resource_type: z.enum(["workspace_path", "http_endpoint"]),mode:z.enum(["read","write"]),
  matcher:z.object({kind:z.enum(["exact","path_prefix"]),value:z.string()}).strict(),
  decision,reason_code:token,
}).strict().superRefine((v,ctx)=>{
  if (v.resource_type==="http_endpoint"
    ? v.mode!=="read" || v.matcher.kind!=="exact" || !endpoint.safeParse(v.matcher.value).success
    : !path.safeParse(v.matcher.value).success)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"INVALID_RESOURCE_RULE"});
});

/** Narrow P0-owned projection of already resolved policy input. It deliberately
 * has no release lifecycle, Tool contract, grant, credential or execution authority.
 * A future owner must prove the remaining Web authority dimensions separately.
 */
export const P0EvaluationSchema = z.object({
  profile: z.literal("canonical_resource_rules@1"),
  // Native case folding is not inferred from the host. Such adapters are future.
  path_semantics: z.literal("posix_case_sensitive"),
  upstream_scope: scope,
  approval_required: z.boolean(),
  policies: z.array(z.object({
    policy_key: token.max(128), scope, approval_required: z.boolean(),
    rules: z.array(P0RuleSchema).min(1).max(256), default_decision: z.literal("deny"),
  }).strict().refine((p) => new Set(p.rules.map((r) => r.rule_id)).size === p.rules.length)).max(64),
  claims: z.array(z.object({type:z.enum(["workspace_path","http_endpoint"]),value:z.string(),
    mode:z.enum(["read","write"])}).strict().superRefine((v,ctx)=>{
      if (v.type==="http_endpoint" ? v.mode!=="read" || !endpoint.safeParse(v.value).success
        : !path.safeParse(v.value).success)
        ctx.addIssue({code:z.ZodIssueCode.custom,message:"INVALID_RESOURCE_CLAIM"});
    })).min(1).max(256),
}).strict().refine((p) => new Set(p.policies.map((r) => r.policy_key)).size === p.policies.length);

/** F2 envelope reuse only; intentionally no IPC handler/registration in P0. */
export const P0EvaluationCommandSchema = localCommandSchema("policy.evaluate", P0EvaluationSchema);
export type P0Evaluation = z.infer<typeof P0EvaluationSchema>;
export type P0Decision = {
  outcome: z.infer<typeof decision>;
  restriction_order: number;
  reason_codes: string[];
  effective_scope: Scope;
};
const order = { allow: 0, require_approval: 1, deny: 2 } as const;

function denied(reason: string): P0Decision {
  return { outcome: "deny", restriction_order: 2, reason_codes: [reason], effective_scope: {} };
}

/** Pure evaluation, not admission or an execution grant. Canonical bytes only:
 * caller getters/proxies/functions are never traversed. No I/O or ambient state.
 * Actual filesystem identity/TOCTOU/symlinks must be proved at future admission.
 */
export function evaluateLocalPolicy(raw: unknown): P0Decision {
  try {
    const input = P0EvaluationSchema.safeParse(parseCanonical(raw));
    if (!input.success) return denied("TOOL_POLICY_INPUT_INVALID");
    const value = input.data;
    if (!value.policies.length) return denied("TOOL_POLICY_MISSING");
    let effective = value.upstream_scope as Scope;
    const policies = [...value.policies].sort((a, b) => a.policy_key < b.policy_key ? -1 : 1);
    for (const policy of policies) {
      narrowScope(value.upstream_scope as Scope, policy.scope as Scope);
      effective = meetScopes(effective, policy.scope as Scope);
    }
    let strictest: P0Decision["outcome"] = "allow";
    const reasons = new Set<string>();
    const add = (outcome: P0Decision["outcome"], reason: string) => {
      if (order[outcome] > order[strictest]) strictest = outcome;
      reasons.add(reason);
    };
    if (value.approval_required || policies.some((p) => p.approval_required)) {
      add("require_approval", "TOOL_POLICY_APPROVAL_REQUIRED");
    }
    for (const policy of policies) {
      for (const claim of value.claims) {
        const matches = policy.rules.filter((rule) => rule.resource_type === claim.type
          && rule.mode === claim.mode && (claim.value === rule.matcher.value
            || (rule.resource_type === "workspace_path" && rule.matcher.kind === "path_prefix"
              && claim.type === "workspace_path" && claim.value.startsWith(`${rule.matcher.value}/`))));
        if (!matches.length) add("deny", "TOOL_POLICY_DEFAULT_DENY");
        for (const rule of matches) add(rule.decision, rule.reason_code);
      }
    }
    return { outcome: strictest, restriction_order: order[strictest], reason_codes: [...reasons].sort(), effective_scope: effective };
  } catch (error) {
    return denied(error instanceof PolicyInputError ? error.code : "TOOL_POLICY_INPUT_INVALID");
  }
}
