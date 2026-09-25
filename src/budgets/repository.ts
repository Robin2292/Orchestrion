import { LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

export type LocalBudgetBounds = Readonly<{ modelTokens: number; toolCalls: number; costUsd: number }>;
export type LocalBudgetCeilings = Readonly<{
  organization: LocalBudgetBounds; principal: LocalBudgetBounds;
  organizationRevision: number; principalRevision: number;
  agentPrincipalId: string;
}>;
type CeilingRow = { revision: number; action: string; model_tokens: number; tool_calls: number; cost_usd: number };

/** All reads and writes use the host's transaction and organization scope. */
export class LocalBudgetCeilingRepository {
  constructor(private readonly tx: SqliteUnit, private readonly context: LocalContext) {
    new ProjectRepository(tx,context);
  }

  assertHumanGrantor(): void {
    const c=this.context;
    if (c.principal.type!=="user" || !this.tx.get(`SELECT 1 FROM memberships
      WHERE org_id=? AND principal_type='user' AND principal_id=? AND role IN ('owner','admin')`,
    c.org_id,c.principal.id)) throw new StorageError("BUDGET_GRANTOR_DENIED");
  }

  latestOrganization(): CeilingRow | null {
    return (this.tx.get(`SELECT revision,action,model_tokens,tool_calls,cost_usd
      FROM organization_budget_ceiling_events WHERE org_id=? ORDER BY revision DESC LIMIT 1`,
    this.context.org_id) as unknown as CeilingRow | undefined) ?? null;
  }

  latestAgent(agentPrincipalId: string): CeilingRow | null {
    const row=this.tx.get(`SELECT revision,action,model_tokens,tool_calls,cost_usd
      FROM agent_budget_ceiling_events WHERE org_id=? AND agent_principal_id=?
      ORDER BY revision DESC LIMIT 1`,this.context.org_id,LocalIdSchema.parse(agentPrincipalId));
    return (row as unknown as CeilingRow | undefined) ?? null;
  }

  assertLiveAgent(agentPrincipalId: string): void {
    const c=this.context;
    if (!this.tx.get(`SELECT 1 FROM agent_identities a JOIN local_agents l
      ON l.org_id=a.org_id AND l.project_id=a.home_project_id
      AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
      AND l.id=a.id AND l.node_type='agent'
      WHERE a.org_id=? AND a.id=? AND a.agent_principal_id=a.id
        AND a.identity_state='governed' AND a.removed_at IS NULL AND l.deleted_at IS NULL`,
    c.org_id,LocalIdSchema.parse(agentPrincipalId))) throw new StorageError("BUDGET_AGENT_PRINCIPAL_UNAVAILABLE");
  }

  appendOrganization(action: "grant"|"revoke", revision: number, bounds: LocalBudgetBounds, now: string): void {
    const c=this.context;
    this.tx.run(`INSERT INTO organization_budget_ceiling_events
      (org_id,revision,action,model_tokens,tool_calls,cost_usd,grantor_type,grantor_id,created_at)
      VALUES (?,?,?,?,?,?,'user',?,?)`,c.org_id,revision,action,bounds.modelTokens,bounds.toolCalls,
    bounds.costUsd,c.principal.id,now);
  }

  appendAgent(agentPrincipalId: string, action: "grant"|"revoke", revision: number,
              bounds: LocalBudgetBounds, now: string): void {
    const c=this.context;
    this.tx.run(`INSERT INTO agent_budget_ceiling_events
      (org_id,agent_principal_id,revision,action,model_tokens,tool_calls,cost_usd,grantor_type,grantor_id,created_at)
      VALUES (?,?,?,?,?,?,?,'user',?,?)`,c.org_id,LocalIdSchema.parse(agentPrincipalId),revision,
    action,bounds.modelTokens,bounds.toolCalls,bounds.costUsd,c.principal.id,now);
  }

  /** The assignment's Agent identity, never the authenticated operator, is the budget subject. */
  resolveForAssignment(assignmentId: string, projectId: string): LocalBudgetCeilings {
    const c=this.context;
    if (projectId!==c.project_id) throw new StorageError("BUDGET_PROJECT_SCOPE_DENIED");
    const row=this.tx.get(`SELECT a.agent_principal_id FROM project_agent_assignments x
      JOIN agent_identities a ON a.org_id=x.org_id AND a.id=x.agent_id
      JOIN local_agents l ON l.org_id=a.org_id AND l.project_id=a.home_project_id
        AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
        AND l.id=a.id AND l.node_type='agent'
      WHERE x.org_id=? AND x.project_id=? AND x.id=? AND x.status='active'
        AND x.migration_state='governed' AND a.identity_state='governed'
        AND a.agent_principal_id=a.id AND a.removed_at IS NULL AND l.deleted_at IS NULL
        AND (a.visibility='organization' OR a.home_project_id=x.project_id)`,
    c.org_id,LocalIdSchema.parse(projectId),LocalIdSchema.parse(assignmentId));
    if (!row) throw new StorageError("BUDGET_AGENT_PRINCIPAL_UNAVAILABLE");
    const agentPrincipalId=String(row.agent_principal_id);
    const organization=this.latestOrganization(), principal=this.latestAgent(agentPrincipalId);
    if (!organization || organization.action!=="grant" || !principal || principal.action!=="grant")
      throw new StorageError("BUDGET_CEILING_REQUIRED");
    return { organization:{modelTokens:Number(organization.model_tokens),toolCalls:Number(organization.tool_calls),
        costUsd:Number(organization.cost_usd)},
      principal:{modelTokens:Number(principal.model_tokens),toolCalls:Number(principal.tool_calls),
        costUsd:Number(principal.cost_usd)},
      organizationRevision:Number(organization.revision),principalRevision:Number(principal.revision),
      agentPrincipalId };
  }
}
