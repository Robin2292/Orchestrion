import type { SqliteMigration } from "./migrations";

/** D2C Local-only ceiling facts. No Agent principal or membership is fabricated. */
export const BUDGET_CEILING_MIGRATION: SqliteMigration = {
  version: 16,
  name: "trusted_local_budget_ceilings",
  up: `
    CREATE TABLE organization_budget_ceiling_events (
      org_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
      model_tokens INTEGER NOT NULL CHECK(model_tokens BETWEEN 1 AND 9007199254740991),
      tool_calls INTEGER NOT NULL CHECK(tool_calls BETWEEN 1 AND 9007199254740991),
      cost_usd REAL NOT NULL CHECK(cost_usd BETWEEN 0 AND 1000000000000000),
      grantor_type TEXT NOT NULL CHECK(grantor_type='user'), grantor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,revision),
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(org_id,grantor_type,grantor_id)
        REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE agent_budget_ceiling_events (
      org_id TEXT NOT NULL, agent_principal_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
      model_tokens INTEGER NOT NULL CHECK(model_tokens BETWEEN 1 AND 9007199254740991),
      tool_calls INTEGER NOT NULL CHECK(tool_calls BETWEEN 1 AND 9007199254740991),
      cost_usd REAL NOT NULL CHECK(cost_usd BETWEEN 0 AND 1000000000000000),
      grantor_type TEXT NOT NULL CHECK(grantor_type='user'), grantor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,agent_principal_id,revision),
      FOREIGN KEY(org_id,agent_principal_id) REFERENCES agent_identities(org_id,id),
      FOREIGN KEY(org_id,grantor_type,grantor_id)
        REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TRIGGER local_org_budget_event_grantor BEFORE INSERT ON organization_budget_ceiling_events
      WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=NEW.org_id
        AND m.principal_type='user' AND m.principal_id=NEW.grantor_id AND m.role IN ('owner','admin'))
      BEGIN SELECT RAISE(ABORT,'BUDGET_GRANTOR_DENIED'); END;
    CREATE TRIGGER local_agent_budget_event_grantor BEFORE INSERT ON agent_budget_ceiling_events
      WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=NEW.org_id
        AND m.principal_type='user' AND m.principal_id=NEW.grantor_id AND m.role IN ('owner','admin'))
      BEGIN SELECT RAISE(ABORT,'BUDGET_GRANTOR_DENIED'); END;
    CREATE TRIGGER local_org_budget_event_sequence BEFORE INSERT ON organization_budget_ceiling_events
      WHEN NEW.revision!=(SELECT coalesce(max(revision),0)+1 FROM organization_budget_ceiling_events
        WHERE org_id=NEW.org_id)
        OR (NEW.action='revoke' AND (SELECT action FROM organization_budget_ceiling_events
          WHERE org_id=NEW.org_id ORDER BY revision DESC LIMIT 1) IS NOT 'grant')
      BEGIN SELECT RAISE(ABORT,'BUDGET_REVISION_CONFLICT'); END;
    CREATE TRIGGER local_agent_budget_event_sequence BEFORE INSERT ON agent_budget_ceiling_events
      WHEN NEW.revision!=(SELECT coalesce(max(revision),0)+1 FROM agent_budget_ceiling_events
        WHERE org_id=NEW.org_id AND agent_principal_id=NEW.agent_principal_id)
        OR (NEW.action='revoke' AND (SELECT action FROM agent_budget_ceiling_events
          WHERE org_id=NEW.org_id AND agent_principal_id=NEW.agent_principal_id
          ORDER BY revision DESC LIMIT 1) IS NOT 'grant')
      BEGIN SELECT RAISE(ABORT,'BUDGET_REVISION_CONFLICT'); END;
    CREATE TRIGGER local_org_budget_revoke_values BEFORE INSERT ON organization_budget_ceiling_events
      WHEN NEW.action='revoke' AND NOT EXISTS (
        SELECT 1 FROM organization_budget_ceiling_events o WHERE o.org_id=NEW.org_id
          AND o.revision=NEW.revision-1 AND o.action='grant'
          AND o.model_tokens=NEW.model_tokens AND o.tool_calls=NEW.tool_calls
          AND o.cost_usd=NEW.cost_usd)
      BEGIN SELECT RAISE(ABORT,'BUDGET_REVOKE_MISMATCH'); END;
    CREATE TRIGGER local_agent_budget_revoke_values BEFORE INSERT ON agent_budget_ceiling_events
      WHEN NEW.action='revoke' AND NOT EXISTS (
        SELECT 1 FROM agent_budget_ceiling_events e WHERE e.org_id=NEW.org_id
          AND e.agent_principal_id=NEW.agent_principal_id AND e.revision=NEW.revision-1
          AND e.action='grant' AND e.model_tokens=NEW.model_tokens
          AND e.tool_calls=NEW.tool_calls AND e.cost_usd=NEW.cost_usd)
      BEGIN SELECT RAISE(ABORT,'BUDGET_REVOKE_MISMATCH'); END;
    CREATE TRIGGER local_agent_budget_subject BEFORE INSERT ON agent_budget_ceiling_events
      WHEN NEW.action='grant' AND NOT EXISTS (
        SELECT 1 FROM agent_identities a JOIN local_agents l
          ON l.org_id=a.org_id AND l.project_id=a.home_project_id
          AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
          AND l.id=a.id AND l.node_type='agent'
        WHERE a.org_id=NEW.org_id AND a.id=NEW.agent_principal_id
          AND a.agent_principal_id=NEW.agent_principal_id
          AND a.identity_state='governed' AND a.removed_at IS NULL AND l.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'BUDGET_AGENT_PRINCIPAL_UNAVAILABLE'); END;
    CREATE TRIGGER local_agent_budget_org_ceiling BEFORE INSERT ON agent_budget_ceiling_events
      WHEN NEW.action='grant' AND NOT EXISTS (
        SELECT 1 FROM organization_budget_ceiling_events o WHERE o.org_id=NEW.org_id
          AND o.revision=(SELECT max(revision) FROM organization_budget_ceiling_events
            WHERE org_id=NEW.org_id) AND o.action='grant'
          AND NEW.model_tokens<=o.model_tokens AND NEW.tool_calls<=o.tool_calls
          AND NEW.cost_usd<=o.cost_usd)
      BEGIN SELECT RAISE(ABORT,'BUDGET_ORGANIZATION_CEILING_REQUIRED'); END;
    CREATE TRIGGER local_org_budget_event_immutable BEFORE UPDATE ON organization_budget_ceiling_events
      BEGIN SELECT RAISE(ABORT,'BUDGET_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER local_org_budget_event_retained BEFORE DELETE ON organization_budget_ceiling_events
      BEGIN SELECT RAISE(ABORT,'BUDGET_EVENT_RETAINED'); END;
    CREATE TRIGGER local_agent_budget_event_immutable BEFORE UPDATE ON agent_budget_ceiling_events
      BEGIN SELECT RAISE(ABORT,'BUDGET_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER local_agent_budget_event_retained BEFORE DELETE ON agent_budget_ceiling_events
      BEGIN SELECT RAISE(ABORT,'BUDGET_EVENT_RETAINED'); END;
  `,
  down: `
    CREATE TEMP TABLE local_budget_down_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_budget_down_guard SELECT
      (SELECT count(*) FROM organization_budget_ceiling_events) +
      (SELECT count(*) FROM agent_budget_ceiling_events);
    DROP TABLE local_budget_down_guard;
    DROP TABLE agent_budget_ceiling_events;
    DROP TABLE organization_budget_ceiling_events;
  `,
};
