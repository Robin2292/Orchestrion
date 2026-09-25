import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ToolGrantSetSchema, grantCanonicalJson, normalizeToolGrants } from "../../shared/tool-grant-contracts";
import type { SqliteMigration } from "./migrations";

/** SQL functions are registered by every host open (migrate). A raw connection
 * lacking them cannot write new grant documents: missing function fails closed.
 * Keep version-12 validation frozen when a future wire version is introduced. */
export function registerGrantFunctions(db: DatabaseSync): void {
  db.function("tg1_valid", { deterministic: true }, raw => {
    try { return ToolGrantSetSchema.safeParse(JSON.parse(String(raw))).success ? 1 : 0; } catch { return 0; }
  });
  db.function("tg1_hash", { deterministic: true }, raw =>
    `sha256:${createHash("sha256").update(grantCanonicalJson(JSON.parse(String(raw)))).digest("hex")}`);
  db.function("tg1_canonical_tuple", { deterministic: true }, raw => {
    try {
      const grants=normalizeToolGrants({schema_version:"tool_grants@1",grants:[JSON.parse(String(raw))]});
      return grantCanonicalJson(grants.grants[0]);
    } catch { return null; }
  });
}

const scope = "org_id,project_id,principal_type,principal_id";
const newScope = "NEW.org_id,NEW.project_id,NEW.principal_type,NEW.principal_id";
const columns = "org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL";
const scoped = (alias: string) => `${alias}.org_id=NEW.org_id AND ${alias}.project_id=NEW.project_id AND ${alias}.principal_type=NEW.principal_type AND ${alias}.principal_id=NEW.principal_id`;
const contextFks = `FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)`;
const immutable = (table: string) => `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'TOOL_GRANT_EVIDENCE_IMMUTABLE'); END;
  CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'TOOL_GRANT_EVIDENCE_RETAINED'); END;`;

export const LOCAL_GRANT_REFERENCE_INSERT_TRIGGER_SQL = `CREATE TRIGGER local_grant_reference_insert BEFORE INSERT ON local_tool_grant_references BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM local_version_tool_grants v WHERE ${scoped("v")} AND v.owner_kind=NEW.owner_kind AND v.owner_subject_id=NEW.owner_subject_id AND v.owner_id=NEW.owner_id
        AND json_extract(CASE NEW.slot WHEN 'grants_json' THEN v.grants_json ELSE v.ceiling_json END,'$.grants['||NEW.ordinal||']') IS NEW.grant_json)
        THEN RAISE(ABORT,'TOOL_GRANT_REFERENCE_FORGED') END;
      SELECT CASE WHEN NEW.contract_id IS NOT json_extract(NEW.grant_json,'$.contract.id') OR NEW.contract_hash IS NOT json_extract(NEW.grant_json,'$.contract.hash')
        OR NEW.policy_id IS NOT json_extract(NEW.grant_json,'$.policy.id') OR NEW.approval_id IS NOT json_extract(NEW.grant_json,'$.approval.id')
        OR NEW.connector_id IS NOT json_extract(NEW.grant_json,'$.connection.id') OR NEW.workspace_project_id IS NOT json_extract(NEW.grant_json,'$.execution_target.id')
        THEN RAISE(ABORT,'TOOL_GRANT_REFERENCE_FORGED') END;
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM local_tool_contract_versions c WHERE ${scoped("c")} AND c.id=NEW.contract_id AND c.contract_hash=NEW.contract_hash
        AND c.source_namespace=json_extract(NEW.grant_json,'$.tool.source') AND c.tool_key=json_extract(NEW.grant_json,'$.tool.key')
        AND c.schema_hash=json_extract(NEW.grant_json,'$.constraints.argument_schema_hash')) THEN RAISE(ABORT,'TOOL_GRANT_CONTRACT_UNRESOLVED') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(json_array(json_extract(NEW.grant_json,'$.policy'),json_extract(NEW.grant_json,'$.approval'))) pin
        WHERE pin.type<>'null' AND NOT EXISTS (SELECT 1 FROM local_policy_releases p JOIN local_policy_states s
          ON p.org_id=s.org_id AND p.project_id=s.project_id AND p.principal_type=s.principal_type AND p.principal_id=s.principal_id AND p.id=s.release_id
          JOIN local_tool_contract_versions c ON c.org_id=p.org_id AND c.project_id=p.project_id AND c.principal_type=p.principal_type AND c.principal_id=p.principal_id
          WHERE ${scoped("p")} AND p.id=json_extract(pin.value,'$.id') AND p.release_hash=json_extract(pin.value,'$.hash') AND s.lifecycle='published'
          AND c.id=NEW.contract_id AND c.contract_hash=NEW.contract_hash AND p.tool_anchor_json=c.anchor_json)) THEN RAISE(ABORT,'TOOL_GRANT_POLICY_UNRESOLVED') END;
      SELECT CASE WHEN NEW.connector_id IS NOT NULL AND (json_extract(NEW.grant_json,'$.connection.kind') IS NOT 'local_connector'
        OR NOT EXISTS (SELECT 1 FROM local_connectors c WHERE ${scoped("c")} AND c.id=NEW.connector_id AND c.deleted_at IS NULL
          AND tg1_hash(json_object('id',c.id,'config',json(c.config_json),'auth',json(c.auth_json)))=json_extract(NEW.grant_json,'$.connection.authority_hash')))
        THEN RAISE(ABORT,'TOOL_GRANT_CONNECTION_UNRESOLVED') END;
      SELECT CASE WHEN NEW.workspace_project_id IS NOT NULL AND (json_extract(NEW.grant_json,'$.execution_target.kind') IS NOT 'local_workspace'
        OR json_extract(NEW.grant_json,'$.execution_target.placement') IS NOT 'local_trusted'
        OR NOT EXISTS (SELECT 1 FROM local_session_tree_projects p WHERE ${scoped("p")} AND tg1_hash(p.identity_json)=json_extract(NEW.grant_json,'$.execution_target.workspace_hash')))
        THEN RAISE(ABORT,'TOOL_GRANT_TARGET_UNRESOLVED') END;
    END;`;

export const LOCAL_GRANT_PROJECT_TRIGGER_SQL = `CREATE TRIGGER local_grant_project AFTER INSERT ON local_version_tool_grants BEGIN
      INSERT INTO local_tool_grant_references SELECT ${newScope},NEW.owner_kind,NEW.owner_id,NEW.owner_subject_id,slot,j.key,
        json_extract(j.value,'$.contract.id'),json_extract(j.value,'$.contract.hash'),json_extract(j.value,'$.connection.id'),json_extract(j.value,'$.execution_target.id'),
        json_extract(j.value,'$.policy.id'),json_extract(j.value,'$.approval.id'),j.value
        FROM (SELECT 'grants_json' slot,NEW.grants_json doc UNION ALL SELECT 'ceiling_json',NEW.ceiling_json) d,json_each(d.doc,'$.grants') j;
    END;`;

/** Version-owned documents and FK projections only; no executable Workflow or
 * second authority store. No Plugin/Skill/Toolset can populate a direct grant. */
export const TOOL_GRANT_MIGRATION: SqliteMigration = {
  version: 12, name: "local_tool_grant_contract",
  up: `
    CREATE TABLE local_tool_contract_versions (
      ${columns}, id TEXT NOT NULL, source_namespace TEXT NOT NULL CHECK(length(source_namespace)>0),
      tool_key TEXT NOT NULL CHECK(length(tool_key)>0), contract_hash TEXT NOT NULL, schema_hash TEXT NOT NULL,
      anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)), contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
      PRIMARY KEY(${scope},id,contract_hash), ${contextFks},
      CHECK(json_extract(anchor_json,'$.org_id') IS org_id),
      CHECK(json_extract(anchor_json,'$.tool_contract_version_id') IS id),
      CHECK(json_extract(anchor_json,'$.tool_contract_hash') IS contract_hash)
    ) STRICT;
    CREATE TABLE local_workflow_versions (
      ${columns}, workflow_id TEXT NOT NULL, id TEXT NOT NULL, version_number INTEGER NOT NULL CHECK(version_number>0),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), definition_hash TEXT NOT NULL,
      grants_json TEXT CHECK(grants_json IS NULL OR tg1_valid(grants_json)=1),
      ceiling_json TEXT CHECK(ceiling_json IS NULL OR tg1_valid(ceiling_json)=1),
      PRIMARY KEY(${scope},workflow_id,id), UNIQUE(${scope},workflow_id,version_number), UNIQUE(${scope},id), ${contextFks},
      CHECK(tg1_hash(definition_json)=definition_hash)
    ) STRICT;
    CREATE TABLE local_version_tool_grants (
      ${columns}, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_subject_id TEXT NOT NULL,
      agent_id TEXT, agent_version_id TEXT, workflow_id TEXT, workflow_version_id TEXT,
      grants_json TEXT CHECK(grants_json IS NULL OR tg1_valid(grants_json)=1),
      ceiling_json TEXT CHECK(ceiling_json IS NULL OR tg1_valid(ceiling_json)=1),
      PRIMARY KEY(${scope},owner_kind,owner_subject_id,owner_id), ${contextFks},
      CHECK((owner_kind='agent' AND agent_id IS NOT NULL AND owner_subject_id=agent_id AND agent_version_id IS NOT NULL AND owner_id=agent_version_id AND workflow_id IS NULL AND workflow_version_id IS NULL AND ceiling_json IS NULL)
        OR (owner_kind='workflow' AND workflow_id IS NOT NULL AND owner_subject_id=workflow_id AND workflow_version_id IS NOT NULL AND owner_id=workflow_version_id AND agent_id IS NULL AND agent_version_id IS NULL)),
      FOREIGN KEY(${scope},agent_id,agent_version_id) REFERENCES local_agent_versions(${scope},agent_id,id),
      FOREIGN KEY(${scope},workflow_id,workflow_version_id) REFERENCES local_workflow_versions(${scope},workflow_id,id)
    ) STRICT;
    CREATE TABLE local_tool_grant_references (
      ${columns}, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_subject_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('grants_json','ceiling_json')),
      ordinal INTEGER NOT NULL CHECK(ordinal>=0), contract_id TEXT NOT NULL, contract_hash TEXT NOT NULL,
      connector_id TEXT, workspace_project_id TEXT, policy_id TEXT NOT NULL, approval_id TEXT,
      grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
      PRIMARY KEY(${scope},owner_kind,owner_subject_id,owner_id,slot,ordinal),
      CHECK((connector_id IS NULL)<>(workspace_project_id IS NULL)),
      CHECK(workspace_project_id IS NULL OR workspace_project_id=project_id),
      FOREIGN KEY(${scope},owner_kind,owner_subject_id,owner_id) REFERENCES local_version_tool_grants(${scope},owner_kind,owner_subject_id,owner_id),
      FOREIGN KEY(${scope},contract_id,contract_hash) REFERENCES local_tool_contract_versions(${scope},id,contract_hash),
      FOREIGN KEY(${scope},connector_id) REFERENCES local_connectors(${scope},id),
      FOREIGN KEY(org_id,workspace_project_id,principal_type,principal_id) REFERENCES local_session_tree_projects(${scope}),
      FOREIGN KEY(${scope},policy_id) REFERENCES local_policy_releases(${scope},id),
      FOREIGN KEY(${scope},approval_id) REFERENCES local_policy_releases(${scope},id)
    ) STRICT;
    CREATE TRIGGER local_grant_owner_insert BEFORE INSERT ON local_version_tool_grants BEGIN
      SELECT CASE WHEN NEW.owner_kind='agent' AND NOT EXISTS (SELECT 1 FROM local_agent_versions v WHERE ${scoped("v")}
        AND v.agent_id=NEW.agent_id AND v.id=NEW.owner_id AND json_extract(v.definition_json,'$.toolGrants') IS NEW.grants_json)
        THEN RAISE(ABORT,'TOOL_GRANT_OWNER_MISMATCH') END;
      SELECT CASE WHEN NEW.owner_kind='workflow' AND NOT EXISTS (SELECT 1 FROM local_workflow_versions v WHERE ${scoped("v")}
        AND v.workflow_id=NEW.workflow_id AND v.id=NEW.owner_id AND v.grants_json IS NEW.grants_json AND v.ceiling_json IS NEW.ceiling_json)
        THEN RAISE(ABORT,'TOOL_GRANT_OWNER_MISMATCH') END;
    END;
    ${LOCAL_GRANT_REFERENCE_INSERT_TRIGGER_SQL}
    ${LOCAL_GRANT_PROJECT_TRIGGER_SQL}
    CREATE TRIGGER local_agent_grant_insert AFTER INSERT ON local_agent_versions BEGIN
      INSERT INTO local_version_tool_grants VALUES (${newScope},'agent',NEW.id,NEW.agent_id,NEW.agent_id,NEW.id,NULL,NULL,json_extract(NEW.definition_json,'$.toolGrants'),NULL);
    END;
    CREATE TRIGGER local_workflow_grant_insert AFTER INSERT ON local_workflow_versions BEGIN
      INSERT INTO local_version_tool_grants VALUES (${newScope},'workflow',NEW.id,NEW.workflow_id,NULL,NULL,NEW.workflow_id,NEW.id,NEW.grants_json,NEW.ceiling_json);
    END;
    -- Nonempty v11 versions retain all definition/Toolset/audit bytes. Absent or
    -- explicit null becomes an immutable unconverted sidecar, never allow-all.
    INSERT INTO local_version_tool_grants SELECT ${scope},'agent',id,agent_id,agent_id,id,NULL,NULL,json_extract(definition_json,'$.toolGrants'),NULL FROM local_agent_versions;
    ${["local_tool_contract_versions", "local_workflow_versions", "local_version_tool_grants", "local_tool_grant_references"].map(immutable).join("\n")}
  `,
  down: `
    CREATE TEMP TABLE tg1_backup_restore_required (n INTEGER CHECK(n=0));
    INSERT INTO tg1_backup_restore_required SELECT
      (SELECT count(*) FROM local_version_tool_grants WHERE grants_json IS NOT NULL OR ceiling_json IS NOT NULL)+
      (SELECT count(*) FROM local_tool_contract_versions)+(SELECT count(*) FROM local_workflow_versions);
    DROP TABLE tg1_backup_restore_required;
    DROP TRIGGER local_agent_grant_insert;
    DROP TRIGGER local_workflow_grant_insert;
    DROP TABLE local_tool_grant_references;
    DROP TABLE local_version_tool_grants;
    DROP TABLE local_workflow_versions;
    DROP TABLE local_tool_contract_versions;
  `,
};
