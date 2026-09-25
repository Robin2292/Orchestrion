import type { SqliteMigration } from "./migrations";
import {
  LOCAL_GRANT_PROJECT_TRIGGER_SQL,
  LOCAL_GRANT_REFERENCE_INSERT_TRIGGER_SQL,
} from "./tool-grant-migration";

/** Retires Local Toolset authority without deleting historical bytes.  The
 * evidence table has no repository/service and is intentionally non-executable. */
export const TOOLSET_RETIREMENT_MIGRATION: SqliteMigration = {
  version: 13,
  name: "retire_local_toolsets",
  up: `
    PRAGMA defer_foreign_keys=ON;
    CREATE TABLE local_legacy_toolset_evidence (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      source_table TEXT NOT NULL CHECK(source_table IN ('local_toolsets','local_toolset_versions','local_agent_toolset_bindings','local_policy_releases')),
      source_key TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), archived_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,source_table,source_key),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TRIGGER local_legacy_toolset_evidence_immutable BEFORE UPDATE ON local_legacy_toolset_evidence
      BEGIN SELECT RAISE(ABORT,'TG5_LEGACY_TOOLSET_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER local_legacy_toolset_evidence_retained BEFORE DELETE ON local_legacy_toolset_evidence
      BEGIN SELECT RAISE(ABORT,'TG5_LEGACY_TOOLSET_EVIDENCE_RETAINED'); END;

    INSERT INTO local_legacy_toolset_evidence SELECT org_id,project_id,principal_type,principal_id,
      'local_toolsets',id,json_object('id',id,'currentVersion',current_version,'status',status,
      'approvalStatus',approval_status,'createdAt',created_at,'deletedAt',deleted_at),datetime('now') FROM local_toolsets;
    INSERT INTO local_legacy_toolset_evidence SELECT org_id,project_id,principal_type,principal_id,
      'local_toolset_versions',toolset_id||':'||version,json_object('toolsetId',toolset_id,'version',version,
      'configJson',config_json),datetime('now') FROM local_toolset_versions;
    INSERT INTO local_legacy_toolset_evidence SELECT org_id,project_id,principal_type,principal_id,
      'local_agent_toolset_bindings',id,json_object('agentId',agent_id,'agentVersionId',agent_version_id,
      'id',id,'toolsetId',toolset_id,'toolsetVersion',toolset_version,'bindingJson',binding_json),datetime('now')
      FROM local_agent_toolset_bindings;
    INSERT INTO local_legacy_toolset_evidence SELECT org_id,project_id,principal_type,principal_id,
      'local_policy_releases',id,json_object('id',id,'toolsetBindingJson',toolset_binding_json),datetime('now')
      FROM local_policy_releases;

    DROP TRIGGER local_policy_release_immutable;
    DROP TRIGGER local_policy_release_retained;
    DROP TRIGGER local_policy_activation_immutable;
    DROP TRIGGER local_policy_activation_retained;
    DROP TRIGGER local_policy_state_identity;
    DROP TRIGGER local_policy_state_retained;
    DROP TRIGGER local_policy_state_transition;
    DROP TRIGGER local_grant_reference_insert;
    DROP TRIGGER local_grant_project;
    DROP TRIGGER local_tool_grant_references_immutable;
    DROP TRIGGER local_tool_grant_references_retained;
    CREATE TABLE local_policy_releases_v13 (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, binding_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json)='object'),
      release_hash TEXT NOT NULL, hash_schema TEXT NOT NULL CHECK(hash_schema IN ('legacy_toolset_v1','direct_policy_v2')),
      tool_anchor_json TEXT NOT NULL CHECK(json_valid(tool_anchor_json)
        AND json_extract(tool_anchor_json,'$.org_id') IS org_id), created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,revision),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,binding_id)
        REFERENCES local_policy_bindings(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TABLE local_policy_states_v13 (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      release_id TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','reviewed','published','revoked')),
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,release_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,release_id)
        REFERENCES local_policy_releases_v13(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TABLE local_policy_activations_v13 (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, binding_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
      release_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('activate','rollback','deactivate')), created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,sequence),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,binding_id,release_id)
        REFERENCES local_policy_releases_v13(org_id,project_id,principal_type,principal_id,binding_id,id)
    ) STRICT;
    CREATE TABLE local_tool_grant_references_v13 (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_subject_id TEXT NOT NULL,
      slot TEXT NOT NULL CHECK(slot IN ('grants_json','ceiling_json')), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
      contract_id TEXT NOT NULL, contract_hash TEXT NOT NULL, connector_id TEXT, workspace_project_id TEXT,
      policy_id TEXT NOT NULL, approval_id TEXT, grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,owner_kind,owner_subject_id,owner_id,slot,ordinal),
      CHECK((connector_id IS NULL)<>(workspace_project_id IS NULL)),
      CHECK(workspace_project_id IS NULL OR workspace_project_id=project_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,owner_kind,owner_subject_id,owner_id)
        REFERENCES local_version_tool_grants(org_id,project_id,principal_type,principal_id,owner_kind,owner_subject_id,owner_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,contract_id,contract_hash)
        REFERENCES local_tool_contract_versions(org_id,project_id,principal_type,principal_id,id,contract_hash),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,connector_id)
        REFERENCES local_connectors(org_id,project_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,workspace_project_id,principal_type,principal_id)
        REFERENCES local_session_tree_projects(org_id,project_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,policy_id)
        REFERENCES local_policy_releases_v13(org_id,project_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,approval_id)
        REFERENCES local_policy_releases_v13(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    INSERT INTO local_policy_releases_v13
      SELECT org_id,project_id,principal_type,principal_id,id,binding_id,revision,definition_json,
      json(COALESCE(json_extract(toolset_binding_json,'$.scopeConfig'),'{}')),release_hash,'legacy_toolset_v1',tool_anchor_json,created_at
      FROM local_policy_releases;
    INSERT INTO local_policy_states_v13 SELECT * FROM local_policy_states;
    INSERT INTO local_policy_activations_v13 SELECT * FROM local_policy_activations;
    INSERT INTO local_tool_grant_references_v13 SELECT * FROM local_tool_grant_references;
    DROP TABLE local_tool_grant_references;
    DROP TABLE local_policy_activations;
    DROP TABLE local_policy_states;
    DROP TABLE local_policy_releases;
    ALTER TABLE local_policy_releases_v13 RENAME TO local_policy_releases;
    ALTER TABLE local_policy_states_v13 RENAME TO local_policy_states;
    ALTER TABLE local_policy_activations_v13 RENAME TO local_policy_activations;
    ALTER TABLE local_tool_grant_references_v13 RENAME TO local_tool_grant_references;
    CREATE INDEX local_policy_activation_release ON local_policy_activations
      (org_id,project_id,principal_type,principal_id,release_id);
    CREATE TRIGGER local_policy_release_immutable BEFORE UPDATE ON local_policy_releases
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_release_retained BEFORE DELETE ON local_policy_releases
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_activation_immutable BEFORE UPDATE ON local_policy_activations
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_activation_retained BEFORE DELETE ON local_policy_activations
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_state_identity BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,release_id ON local_policy_states
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_state_retained BEFORE DELETE ON local_policy_states
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_state_transition BEFORE UPDATE ON local_policy_states
      WHEN NEW.revision != OLD.revision+1 OR NOT (
        (OLD.lifecycle='draft' AND NEW.lifecycle='reviewed') OR
        (OLD.lifecycle='reviewed' AND NEW.lifecycle='published') OR
        (OLD.lifecycle!='revoked' AND NEW.lifecycle='revoked'))
      BEGIN SELECT RAISE(ABORT,'POLICY_STATE_CONFLICT'); END;
    ${LOCAL_GRANT_REFERENCE_INSERT_TRIGGER_SQL}
    ${LOCAL_GRANT_PROJECT_TRIGGER_SQL}
    CREATE TRIGGER local_tool_grant_references_immutable BEFORE UPDATE ON local_tool_grant_references
      BEGIN SELECT RAISE(ABORT,'TOOL_GRANT_EVIDENCE_IMMUTABLE'); END;
    CREATE TRIGGER local_tool_grant_references_retained BEFORE DELETE ON local_tool_grant_references
      BEGIN SELECT RAISE(ABORT,'TOOL_GRANT_EVIDENCE_RETAINED'); END;

    DROP TRIGGER local_toolset_binding_immutable;
    DROP TRIGGER local_toolset_binding_retained;
    DROP TRIGGER local_toolset_version_immutable;
    DROP TRIGGER local_toolset_version_retained;
    DROP TRIGGER local_toolset_identity_immutable;
    DROP TRIGGER local_toolset_retained;
    DROP TABLE local_agent_toolset_bindings;
    DROP TABLE local_toolset_versions;
    DROP TABLE local_toolsets;
  `,
  down: `CREATE TEMP TABLE tg5_backup_restore_required (n INTEGER);
    CREATE TEMP TRIGGER tg5_backup_restore_required_guard BEFORE INSERT ON tg5_backup_restore_required
      BEGIN SELECT RAISE(ABORT,'TG5_BACKUP_RESTORE_REQUIRED: restore a verified pre-v13 SQLite backup'); END;
    INSERT INTO tg5_backup_restore_required VALUES (1);`,
};
