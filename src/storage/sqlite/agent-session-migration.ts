import type { SqliteMigration } from "./migrations";

/** D3A persistence only. Legacy thread and execution records remain their own
 * continuation owners; this table is a read projection until D3B cutover. */
export const AGENT_SESSION_MIGRATION: SqliteMigration = {
  version: 17,
  name: "agent_session_persistence",
  up: `
    CREATE TEMP TABLE m9_session_ambiguity (n INTEGER CHECK(n=0));
    INSERT INTO m9_session_ambiguity SELECT count(*) FROM (
      SELECT org_id,id FROM (
        SELECT org_id,id FROM local_legacy_sessions
        UNION ALL SELECT org_id,id FROM local_session_tree_sessions
      ) GROUP BY org_id,id HAVING count(*)>1
    );
    INSERT INTO m9_session_ambiguity SELECT count(*) FROM (
      SELECT s.org_id,s.id,s.project_id,s.agent_id,s.record_json
        FROM local_legacy_sessions s
      UNION ALL
      SELECT s.org_id,s.id,s.project_id,s.agent_id,s.record_json
        FROM local_session_tree_sessions s
    ) s JOIN agent_identities a ON a.org_id=s.org_id AND a.id=s.agent_id
      WHERE json_type(s.record_json,'$.threadId') NOT IN ('text','null')
        OR (json_type(s.record_json,'$.threadId')='text' AND
          (a.home_project_id!=s.project_id
          OR length(json_extract(s.record_json,'$.threadId'))=0
          OR json_type(s.record_json,'$.createdAt')!='text'
          OR length(json_extract(s.record_json,'$.createdAt'))=0));
    DROP TABLE m9_session_ambiguity;

    CREATE TABLE agent_sessions (
      org_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source='direct'),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
      provenance TEXT NOT NULL CHECK(provenance IN ('released','legacy_unversioned')),
      agent_version_id TEXT, assignment_id TEXT, assignment_version_id TEXT,
      resolved_config_hash TEXT,
      agent_principal_json TEXT, initiated_by_json TEXT, materialized_by_json TEXT,
      memory_scope_json TEXT NOT NULL CHECK(json_valid(memory_scope_json) AND json_type(memory_scope_json)='object'),
      original_thread_id TEXT, legacy_configuration_evidence TEXT,
      archived_at TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,agent_id) REFERENCES agent_identities(org_id,id),
      FOREIGN KEY(org_id,assignment_id,project_id,agent_id)
        REFERENCES project_agent_assignments(org_id,id,project_id,agent_id),
      FOREIGN KEY(org_id,assignment_id,assignment_version_id)
        REFERENCES project_agent_assignment_versions(org_id,assignment_id,id),
      CHECK((lifecycle='archived')=(archived_at IS NOT NULL)),
      CHECK((provenance='legacy_unversioned' AND agent_version_id IS NULL
          AND assignment_version_id IS NULL AND resolved_config_hash IS NULL
          AND agent_principal_json IS NULL AND initiated_by_json IS NULL
          AND materialized_by_json IS NULL AND original_thread_id IS NOT NULL
          AND legacy_configuration_evidence IS NOT NULL
          AND json_valid(legacy_configuration_evidence))
        OR (provenance='released' AND agent_version_id IS NOT NULL
          AND assignment_id IS NOT NULL AND assignment_version_id IS NOT NULL
          AND resolved_config_hash IS NOT NULL
          AND length(resolved_config_hash)=71 AND substr(resolved_config_hash,1,7)='sha256:'
          AND agent_principal_json IS NOT NULL AND json_valid(agent_principal_json)
          AND initiated_by_json IS NOT NULL AND json_valid(initiated_by_json)
          AND materialized_by_json IS NOT NULL AND json_valid(materialized_by_json)
          AND original_thread_id IS NULL AND legacy_configuration_evidence IS NULL))
    ) STRICT;
    CREATE INDEX ix_agent_sessions_project_source ON agent_sessions(org_id,project_id,source,created_at,id);
    CREATE INDEX ix_agent_sessions_agent ON agent_sessions(org_id,project_id,agent_id,created_at,id);
    CREATE INDEX ix_agent_sessions_thread ON agent_sessions(org_id,original_thread_id)
      WHERE original_thread_id IS NOT NULL;
    CREATE TRIGGER m9_session_placement BEFORE INSERT ON agent_sessions
      WHEN EXISTS (SELECT 1 FROM agent_sessions s WHERE s.org_id=NEW.org_id AND s.id=NEW.id)
        OR NOT EXISTS (SELECT 1 FROM project_agent_assignments a
        WHERE a.org_id=NEW.org_id AND a.id=NEW.assignment_id
          AND a.project_id=NEW.project_id AND a.agent_id=NEW.agent_id)
        OR (NEW.provenance='released' AND NOT EXISTS (
          SELECT 1 FROM project_agent_assignment_versions v
          WHERE v.org_id=NEW.org_id AND v.assignment_id=NEW.assignment_id
            AND v.id=NEW.assignment_version_id AND v.project_id=NEW.project_id
            AND v.agent_id=NEW.agent_id AND v.agent_version_id=NEW.agent_version_id
            AND v.resolved_config_hash=NEW.resolved_config_hash))
      BEGIN SELECT RAISE(ABORT,'M9_SESSION_PIN_MISMATCH'); END;
    CREATE TRIGGER m9_session_pins_immutable BEFORE UPDATE OF
      org_id,id,project_id,agent_id,source,provenance,agent_version_id,assignment_id,
      assignment_version_id,resolved_config_hash,agent_principal_json,initiated_by_json,
      materialized_by_json,memory_scope_json,original_thread_id,legacy_configuration_evidence,created_at
      ON agent_sessions BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;
    CREATE TRIGGER m9_session_retained BEFORE DELETE ON agent_sessions
      BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;

    CREATE TABLE agent_session_attempts (
      org_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
      execution_placement_binding_id TEXT NOT NULL CHECK(length(execution_placement_binding_id)>0),
      workspace_binding_id TEXT NOT NULL CHECK(length(workspace_binding_id)>0),
      source_revision_or_snapshot TEXT NOT NULL CHECK(length(source_revision_or_snapshot)>0),
      runtime_owner_json TEXT NOT NULL CHECK(json_valid(runtime_owner_json)
        AND json_type(runtime_owner_json)='object'
        AND json_extract(runtime_owner_json,'$.engine') IN ('web','local')
        AND json_type(runtime_owner_json,'$.instanceId')='text'
        AND length(json_extract(runtime_owner_json,'$.instanceId'))>0
        AND json_type(runtime_owner_json,'$.epoch')='integer'
        AND json_extract(runtime_owner_json,'$.epoch') BETWEEN 0 AND 9007199254740991),
      fencing_token TEXT NOT NULL CHECK(length(fencing_token)>0),
      effective_authority_hash TEXT NOT NULL CHECK(length(effective_authority_hash)=71 AND substr(effective_authority_hash,1,7)='sha256:'),
      resolved_config_hash TEXT NOT NULL CHECK(length(resolved_config_hash)=71 AND substr(resolved_config_hash,1,7)='sha256:'),
      accounting_identity TEXT NOT NULL CHECK(length(accounting_identity)>0),
      provider_execution_ref TEXT, fallback TEXT NOT NULL CHECK(fallback='forbidden'),
      outcome TEXT NOT NULL CHECK(outcome IN ('running','waiting','completed','failed','cancelled')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,id), UNIQUE(org_id,session_id,attempt_number),
      FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id)
    ) STRICT;
    CREATE INDEX ix_agent_session_attempts_session ON agent_session_attempts(org_id,session_id,attempt_number);
    CREATE TRIGGER m9_attempt_released BEFORE INSERT ON agent_session_attempts
      WHEN EXISTS (SELECT 1 FROM agent_session_attempts a
        WHERE a.org_id=NEW.org_id AND a.id=NEW.id)
        OR NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.org_id=NEW.org_id
        AND s.id=NEW.session_id AND s.provenance='released'
        AND s.resolved_config_hash=NEW.resolved_config_hash)
        OR NEW.attempt_number!=(SELECT coalesce(max(attempt_number),0)+1
          FROM agent_session_attempts WHERE org_id=NEW.org_id AND session_id=NEW.session_id)
        OR EXISTS (SELECT 1 FROM agent_session_attempts a
          WHERE a.org_id=NEW.org_id AND a.session_id=NEW.session_id
            AND a.attempt_number=(SELECT max(attempt_number) FROM agent_session_attempts
              WHERE org_id=NEW.org_id AND session_id=NEW.session_id)
            AND a.outcome NOT IN ('completed','failed','cancelled'))
      BEGIN SELECT RAISE(ABORT,'M9_ATTEMPT_PIN_MISMATCH'); END;
    CREATE TRIGGER m9_attempt_binding_immutable BEFORE UPDATE OF
      org_id,id,session_id,attempt_number,execution_placement_binding_id,
      workspace_binding_id,source_revision_or_snapshot,runtime_owner_json,fencing_token,
      effective_authority_hash,resolved_config_hash,accounting_identity,
      provider_execution_ref,fallback,created_at ON agent_session_attempts
      BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;
    CREATE TRIGGER m9_attempt_outcome_transition BEFORE UPDATE OF outcome ON agent_session_attempts
      WHEN OLD.outcome IN ('completed','failed','cancelled')
        OR (OLD.outcome='running' AND NEW.outcome NOT IN ('waiting','completed','failed','cancelled'))
        OR (OLD.outcome='waiting' AND NEW.outcome NOT IN ('running','completed','failed','cancelled'))
      BEGIN SELECT RAISE(ABORT,'M9_ATTEMPT_OUTCOME_CONFLICT'); END;
    CREATE TRIGGER m9_attempt_retained BEFORE DELETE ON agent_session_attempts
      BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;

    -- Drafts with no provider thread remain readable in their original store.
    -- D3B must reconcile them during the single-writer cutover; there is no
    -- fictional original_thread_id and no mirror write in this migration.
    INSERT INTO agent_sessions(org_id,id,project_id,agent_id,source,lifecycle,provenance,
      assignment_id,memory_scope_json,original_thread_id,legacy_configuration_evidence,created_at)
    SELECT s.org_id,s.id,s.project_id,s.agent_id,'direct','active','legacy_unversioned',
      'assignment:'||s.agent_id,
      json_object('type','direct','projectId',s.project_id,'sessionId',s.id,'sharing','session_only'),
      json_extract(s.record_json,'$.threadId'),
      json_object('source','local_legacy_sessions','record',json(s.record_json)),
      json_extract(s.record_json,'$.createdAt')
    FROM local_legacy_sessions s JOIN agent_identities a ON a.org_id=s.org_id AND a.id=s.agent_id
    WHERE json_type(s.record_json,'$.threadId')='text';
    INSERT INTO agent_sessions(org_id,id,project_id,agent_id,source,lifecycle,provenance,
      assignment_id,memory_scope_json,original_thread_id,legacy_configuration_evidence,created_at)
    SELECT s.org_id,s.id,s.project_id,s.agent_id,'direct','active','legacy_unversioned',
      'assignment:'||s.agent_id,
      json_object('type','direct','projectId',s.project_id,'sessionId',s.id,'sharing','session_only'),
      json_extract(s.record_json,'$.threadId'),
      json_object('source','local_session_tree_sessions','record',json(s.record_json)),
      json_extract(s.record_json,'$.createdAt')
    FROM local_session_tree_sessions s JOIN agent_identities a ON a.org_id=s.org_id AND a.id=s.agent_id
    WHERE json_type(s.record_json,'$.threadId')='text';
  `,
  down: `
    CREATE TEMP TABLE m9_session_down_guard (n INTEGER CHECK(n=0));
    INSERT INTO m9_session_down_guard SELECT
      (SELECT count(*) FROM agent_sessions)+(SELECT count(*) FROM agent_session_attempts);
    DROP TABLE m9_session_down_guard;
    DROP TABLE agent_session_attempts;
    DROP TABLE agent_sessions;
  `,
};
