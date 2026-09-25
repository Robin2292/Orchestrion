import type { SqliteMigration } from "./migrations";

/** M9 D2A only. D1B Session and WorkflowRoleBinding designs stay unregistered. */
export const ASSIGNMENT_MIGRATION: SqliteMigration = {
  version: 14,
  name: "project_agent_assignments",
  up: `
    CREATE TEMP TABLE m9_assignment_ambiguity (n INTEGER CHECK(n=0));
    INSERT INTO m9_assignment_ambiguity SELECT count(*) FROM (
      SELECT org_id,id FROM local_agents WHERE node_type='agent'
      GROUP BY org_id,id HAVING count(*)>1
    );
    DROP TABLE m9_assignment_ambiguity;

    CREATE TABLE agent_identities (
      org_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('organization','project')),
      home_project_id TEXT NOT NULL,
      derived_from_agent_version_id TEXT,
      agent_principal_id TEXT,
      identity_state TEXT NOT NULL CHECK(identity_state IN ('legacy_unresolved','governed')),
      owner_principal_type TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL, removed_at TEXT,
      PRIMARY KEY(org_id,id),
      UNIQUE(org_id,id,home_project_id,owner_principal_type,owner_principal_id),
      FOREIGN KEY(org_id,home_project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,home_project_id,owner_principal_type,owner_principal_id,id)
        REFERENCES local_agents(org_id,project_id,principal_type,principal_id,id),
      CHECK(identity_state!='governed' OR agent_principal_id IS NOT NULL)
    ) STRICT;

    CREATE TABLE project_agent_assignments (
      org_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','disabled','removed')),
      current_assignment_version_id TEXT,
      migration_state TEXT NOT NULL CHECK(migration_state IN ('legacy_unversioned','governed')),
      created_at TEXT NOT NULL, removed_at TEXT,
      PRIMARY KEY(org_id,id),
      UNIQUE(org_id,id,project_id,agent_id),
      UNIQUE(org_id,project_id,agent_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,agent_id) REFERENCES agent_identities(org_id,id),
      FOREIGN KEY(org_id,id,current_assignment_version_id)
        REFERENCES project_agent_assignment_versions(org_id,assignment_id,id) DEFERRABLE INITIALLY DEFERRED,
      CHECK((status='removed' AND removed_at IS NOT NULL) OR (status!='removed' AND removed_at IS NULL)),
      CHECK(migration_state='governed' OR current_assignment_version_id IS NULL)
    ) STRICT;
    CREATE INDEX ix_project_agent_assignment_list
      ON project_agent_assignments(org_id,project_id,status,created_at,id);

    CREATE TABLE project_agent_assignment_versions (
      org_id TEXT NOT NULL, id TEXT NOT NULL, assignment_id TEXT NOT NULL,
      project_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0),
      agent_version_id TEXT NOT NULL, agent_home_project_id TEXT NOT NULL,
      agent_owner_principal_type TEXT NOT NULL, agent_owner_principal_id TEXT NOT NULL,
      contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND json_type(contract_json)='object'),
      resolved_config_hash TEXT NOT NULL CHECK(length(resolved_config_hash)=71 AND substr(resolved_config_hash,1,7)='sha256:'),
      authority_ceiling_hash TEXT NOT NULL CHECK(length(authority_ceiling_hash)=71 AND substr(authority_ceiling_hash,1,7)='sha256:'),
      memory_scope_hash TEXT NOT NULL CHECK(length(memory_scope_hash)=71 AND substr(memory_scope_hash,1,7)='sha256:'),
      created_by_principal_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,id),
      UNIQUE(org_id,assignment_id,id),
      UNIQUE(org_id,assignment_id,revision),
      FOREIGN KEY(org_id,assignment_id,project_id,agent_id)
        REFERENCES project_agent_assignments(org_id,id,project_id,agent_id),
      FOREIGN KEY(org_id,agent_id,agent_home_project_id,agent_owner_principal_type,agent_owner_principal_id)
        REFERENCES agent_identities(org_id,id,home_project_id,owner_principal_type,owner_principal_id),
      FOREIGN KEY(org_id,agent_home_project_id,agent_owner_principal_type,agent_owner_principal_id,agent_id,agent_version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id)
    ) STRICT;

    CREATE TABLE project_agent_assignment_events (
      org_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, assignment_id TEXT,
      event_type TEXT NOT NULL CHECK(event_type IN ('created','adopted','added','version_released',
        'disabled','enabled','removed','promoted')),
      actor_principal_type TEXT NOT NULL, actor_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,agent_id) REFERENCES agent_identities(org_id,id),
      FOREIGN KEY(org_id,assignment_id) REFERENCES project_agent_assignments(org_id,id),
      FOREIGN KEY(org_id,actor_principal_type,actor_principal_id)
        REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE INDEX ix_assignment_events_scope
      ON project_agent_assignment_events(org_id,project_id,agent_id,created_at,id);
    CREATE TRIGGER m9_assignment_event_immutable BEFORE UPDATE ON project_agent_assignment_events
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER m9_assignment_event_retained BEFORE DELETE ON project_agent_assignment_events
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_EVENT_IMMUTABLE'); END;

    CREATE TRIGGER m9_assignment_version_immutable BEFORE UPDATE ON project_agent_assignment_versions
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER m9_assignment_version_retained BEFORE DELETE ON project_agent_assignment_versions
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER m9_assignment_identity_immutable BEFORE UPDATE OF org_id,id,project_id,agent_id,created_at
      ON project_agent_assignments BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER m9_agent_identity_immutable BEFORE UPDATE OF
      org_id,id,home_project_id,derived_from_agent_version_id,owner_principal_type,owner_principal_id,
      created_at ON agent_identities
      BEGIN SELECT RAISE(ABORT,'M9_AGENT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER m9_agent_principal_immutable BEFORE UPDATE OF agent_principal_id ON agent_identities
      WHEN OLD.agent_principal_id IS NOT NULL OR NEW.agent_principal_id IS NOT NEW.id
      BEGIN SELECT RAISE(ABORT,'M9_AGENT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER m9_variant_provenance_insert BEFORE INSERT ON agent_identities
      WHEN NEW.derived_from_agent_version_id IS NOT NULL AND
        (SELECT count(*) FROM local_agent_versions v JOIN agent_identities a
           ON a.org_id=v.org_id AND a.id=v.agent_id
           WHERE v.org_id=NEW.org_id AND v.id=NEW.derived_from_agent_version_id
             AND v.node_type='agent' AND a.identity_state='governed')!=1
      BEGIN SELECT RAISE(ABORT,'M9_VARIANT_SOURCE_UNRESOLVED'); END;
    CREATE TRIGGER m9_agent_no_demote BEFORE UPDATE OF visibility,identity_state ON agent_identities
      WHEN (OLD.visibility='organization' AND NEW.visibility='project')
        OR (OLD.identity_state='governed' AND NEW.identity_state!='governed')
      BEGIN SELECT RAISE(ABORT,'M9_AGENT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER m9_assignment_placement_insert BEFORE INSERT ON project_agent_assignments
      WHEN NEW.migration_state='governed' AND NOT EXISTS (
        SELECT 1 FROM agent_identities a WHERE a.org_id=NEW.org_id AND a.id=NEW.agent_id
          AND a.identity_state='governed'
          AND (a.visibility='organization' OR a.home_project_id=NEW.project_id))
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_PLACEMENT_DENIED'); END;
    CREATE TRIGGER m9_assignment_placement_update BEFORE UPDATE OF status,migration_state ON project_agent_assignments
      WHEN NEW.status!='removed' AND NEW.migration_state='governed' AND NOT EXISTS (
        SELECT 1 FROM agent_identities a WHERE a.org_id=NEW.org_id AND a.id=NEW.agent_id
          AND a.identity_state='governed'
          AND (a.visibility='organization' OR a.home_project_id=NEW.project_id))
      BEGIN SELECT RAISE(ABORT,'M9_ASSIGNMENT_PLACEMENT_DENIED'); END;

    INSERT INTO agent_identities
      (org_id,id,name,visibility,home_project_id,derived_from_agent_version_id,
       agent_principal_id,identity_state,owner_principal_type,owner_principal_id,created_at,removed_at)
    SELECT org_id,id,name,'project',project_id,NULL,NULL,'legacy_unresolved',
           principal_type,principal_id,created_at,deleted_at
    FROM local_agents WHERE node_type='agent';
    INSERT INTO project_agent_assignments
      (org_id,id,project_id,agent_id,status,current_assignment_version_id,migration_state,created_at,removed_at)
    SELECT org_id,'assignment:'||id,home_project_id,id,
           CASE WHEN removed_at IS NULL THEN 'active' ELSE 'removed' END,
           NULL,'legacy_unversioned',created_at,removed_at
    FROM agent_identities;
  `,
  down: `
    CREATE TEMP TABLE m9_assignment_down_guard (n INTEGER CHECK(n=0));
    INSERT INTO m9_assignment_down_guard SELECT
      (SELECT count(*) FROM agent_identities) +
      (SELECT count(*) FROM project_agent_assignments) +
      (SELECT count(*) FROM project_agent_assignment_versions) +
      (SELECT count(*) FROM project_agent_assignment_events);
    DROP TABLE m9_assignment_down_guard;
    DROP TABLE project_agent_assignment_events;
    DROP TABLE project_agent_assignment_versions;
    DROP TABLE project_agent_assignments;
    DROP TABLE agent_identities;
  `,
};
