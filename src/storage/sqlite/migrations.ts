import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ASSIGNMENT_MIGRATION } from "./assignment-migration";
import { ASSIGNMENT_CUTOVER_MIGRATION } from "./assignment-cutover-migration";
import { BUDGET_CEILING_MIGRATION } from "./budget-ceiling-migration";
import { AGENT_SESSION_MIGRATION } from "./agent-session-migration";
import { DIRECT_SESSION_MIGRATION } from "./direct-session-migration";
import { DIRECT_GRANT_CEILING_MIGRATION } from "./direct-grant-ceiling-migration";
import { CODEX_ACCOUNT_MIGRATION } from "./codex-account-migration";
import { CODEX_ACCOUNT_LIFECYCLE_MIGRATION } from "./codex-account-lifecycle-migration";
import { AGENT_SOUL_MIGRATION } from "./agent-soul-migration";
import { DIRECT_PROVIDER_CALL_MIGRATION } from "./direct-provider-call-migration";
import { DIRECT_CONTEXT_MIGRATION } from "./direct-context-migration";
import { DIRECT_REPOSITORY_INSTRUCTIONS_MIGRATION } from "./direct-repository-instructions-migration";

/** Append-only, contiguous SQLite chain. Never reuse the PostgreSQL/Alembic chain. */
export interface SqliteMigration { version: number; name: string; up: string; down: string }
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [{
  version: 1,
  name: "local_foundation",
  up: `
    CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE principals (
      type TEXT NOT NULL CHECK(type IN ('user','agent','service')), id TEXT NOT NULL,
      PRIMARY KEY(type,id)
    ) STRICT;
    CREATE TABLE memberships (
      org_id TEXT NOT NULL REFERENCES organizations(id), principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','member','viewer')),
      PRIMARY KEY(org_id,principal_type,principal_id),
      FOREIGN KEY(principal_type,principal_id) REFERENCES principals(type,id)
    ) STRICT;
    CREATE TABLE projects (
      org_id TEXT NOT NULL REFERENCES organizations(id), id TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY(org_id,id)
    ) STRICT;
    CREATE TABLE personal_workspace (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), org_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK(principal_type='user'), principal_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE TABLE runtime_incarnation (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991)
    ) STRICT;
    CREATE TABLE resource_fences (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, resource_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991), hash TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,resource_key),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE TABLE command_commits (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL, command TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      content_hash TEXT NOT NULL, result_ref TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,command,idempotency_key),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
  `,
  down: `DROP TABLE command_commits; DROP TABLE resource_fences; DROP TABLE runtime_incarnation;
    DROP TABLE personal_workspace; DROP TABLE projects; DROP TABLE memberships;
    DROP TABLE principals; DROP TABLE organizations;`,
}, {
  version: 2,
  name: "credential_metadata",
  up: `
    CREATE TABLE credential_metadata (
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      credential_ref TEXT PRIMARY KEY NOT NULL, connector_id TEXT NOT NULL,
      locator_ref TEXT UNIQUE,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      state TEXT NOT NULL CHECK(state IN ('active','revoked','tombstoned')),
      created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
      updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN created_at AND 9007199254740991),
      revoked_at INTEGER, tombstoned_at INTEGER,
      CHECK((state='active' AND locator_ref IS NOT NULL AND revoked_at IS NULL AND tombstoned_at IS NULL)
        OR (state='revoked' AND locator_ref IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at=updated_at AND tombstoned_at IS NULL)
        OR (state='tombstoned' AND locator_ref IS NULL AND tombstoned_at IS NOT NULL AND tombstoned_at=updated_at)),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE INDEX credential_metadata_scope ON credential_metadata(org_id,principal_type,principal_id,connector_id);
  `,
  // Preserve even tombstones: silently deleting them could resurrect old refs.
  // The CHECK aborts the entire migration (including ledger) before DROP.
  down: `CREATE TEMP TABLE credential_metadata_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO credential_metadata_downgrade_guard SELECT count(*) FROM credential_metadata;
    DROP TABLE credential_metadata_downgrade_guard;
    DROP TABLE credential_metadata;`,
}, {
  version: 3,
  name: "synthetic_job_outbox",
  up: `
    CREATE TABLE local_jobs (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
      principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('success','retry','unknown')),
      status TEXT NOT NULL CHECK(status IN ('queued','claimed','effect','succeeded','failed','cancelled','unknown')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
      max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
      available_at INTEGER NOT NULL CHECK(available_at BETWEEN 0 AND 9007199254740991),
      epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch BETWEEN 0 AND 9007199254740991),
      owner_instance TEXT, owner_epoch INTEGER, lease_until INTEGER,
      CHECK((status IN ('claimed','effect') AND owner_instance IS NOT NULL AND owner_epoch IS NOT NULL
        AND lease_until IS NOT NULL) OR (status NOT IN ('claimed','effect') AND owner_instance IS NULL
        AND owner_epoch IS NULL AND lease_until IS NULL)),
      PRIMARY KEY(org_id,project_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE local_job_outbox (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,job_id),
      FOREIGN KEY(org_id,project_id,job_id) REFERENCES local_jobs(org_id,project_id,id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE local_synthetic_effects (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result='synthetic-confirmed'),
      PRIMARY KEY(org_id,project_id,job_id),
      FOREIGN KEY(org_id,project_id,job_id) REFERENCES local_jobs(org_id,project_id,id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX local_jobs_due ON local_jobs(org_id,project_id,status,available_at);
    CREATE INDEX local_jobs_expired ON local_jobs(org_id,project_id,status,lease_until);
  `,
  // Offline rollback requires an explicit backup and disposal of F6 synthetic data.
  // Never silently erase pending work or confirmed-effect deduplication evidence.
  down: `CREATE TEMP TABLE local_jobs_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_jobs_downgrade_guard SELECT count(*) FROM local_jobs;
    DROP TABLE local_jobs_downgrade_guard;
    DROP TABLE local_synthetic_effects; DROP TABLE local_job_outbox; DROP TABLE local_jobs;`,
}, {
  version: 4,
  name: "synthetic_event_log",
  up: `
    CREATE TABLE local_job_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991),
      event_id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      subject_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 9007199254740991),
      status TEXT NOT NULL CHECK(status IN ('queued','claimed','effect','succeeded','failed','cancelled','unknown')),
      timestamp TEXT NOT NULL,
      FOREIGN KEY(org_id,project_id,subject_id) REFERENCES local_jobs(org_id,project_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE UNIQUE INDEX local_job_event_order ON local_job_events(org_id,project_id,principal_type,principal_id,subject_id,ordinal);
    CREATE INDEX local_job_event_cursor ON local_job_events(org_id,project_id,principal_type,principal_id,subject_id,sequence);
    INSERT INTO local_job_events(event_id,org_id,project_id,principal_type,principal_id,subject_id,ordinal,status,timestamp)
      SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
        org_id,project_id,principal_type,principal_id,id,1,status,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM local_jobs;
  `,
  // Offline explicit disposal only. Never silently lose cursor/dedup evidence.
  down: `CREATE TEMP TABLE local_events_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_events_downgrade_guard SELECT count(*) FROM local_job_events;
    DROP TABLE local_events_downgrade_guard; DROP TABLE local_job_events;`,
}, {
  version: 5,
  name: "local_agents",
  up: `
    CREATE TABLE local_agents (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, node_type TEXT NOT NULL CHECK(node_type IN ('agent','terminal','code','coding_agent','sub_workflow')),
      name TEXT NOT NULL, description TEXT, user_guide TEXT, legacy_instructions TEXT,
      latest_version_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,id,node_type),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,id,latest_version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id)
    ) STRICT;
    CREATE TABLE local_agent_versions (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, id TEXT NOT NULL, node_type TEXT NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number BETWEEN 1 AND 9007199254740991),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,agent_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,agent_id,version_number),
      CHECK(json_extract(definition_json,'$.nodeType') IS node_type),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id,node_type)
        REFERENCES local_agents(org_id,project_id,principal_type,principal_id,id,node_type)
    ) STRICT;
    CREATE TRIGGER local_agent_identity_immutable BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,id,node_type,legacy_instructions,created_at ON local_agents
      BEGIN SELECT RAISE(ABORT,'AGENT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER local_agent_version_immutable BEFORE UPDATE ON local_agent_versions
      BEGIN SELECT RAISE(ABORT,'AGENT_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER local_agent_version_retained BEFORE DELETE ON local_agent_versions
      BEGIN SELECT RAISE(ABORT,'AGENT_VERSION_IMMUTABLE'); END;
    CREATE TABLE local_legacy_imports (
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      source_id TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,principal_type,principal_id,source_id),
      UNIQUE(org_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE local_legacy_identity_map (
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, import_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('project','agent','session')), legacy_id TEXT NOT NULL,
      project_id TEXT NOT NULL, local_id TEXT NOT NULL,
      PRIMARY KEY(org_id,principal_type,principal_id,kind,legacy_id),
      FOREIGN KEY(org_id,principal_type,principal_id,import_id) REFERENCES local_legacy_imports(org_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE TABLE local_legacy_projects (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE local_legacy_sessions (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, agent_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id)
        REFERENCES local_agents(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TRIGGER local_legacy_session_immutable BEFORE UPDATE ON local_legacy_sessions
      BEGIN SELECT RAISE(ABORT,'LEGACY_SESSION_IMMUTABLE'); END;
  `,
  // Every A0 fact, including imports with zero Agents and deleted identities, protects rollback.
  down: `CREATE TEMP TABLE local_agents_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_agents_downgrade_guard SELECT
      (SELECT count(*) FROM local_agents) + (SELECT count(*) FROM local_agent_versions) +
      (SELECT count(*) FROM local_legacy_imports) + (SELECT count(*) FROM local_legacy_identity_map) +
      (SELECT count(*) FROM local_legacy_projects) + (SELECT count(*) FROM local_legacy_sessions);
    DROP TABLE local_agents_downgrade_guard;
    DROP TABLE local_legacy_sessions; DROP TABLE local_legacy_projects;
    DROP TABLE local_legacy_identity_map; DROP TABLE local_legacy_imports;
    DROP TABLE local_agent_versions; DROP TABLE local_agents;`,
}, {
  version: 6,
  name: "local_toolsets",
  up: `
    CREATE TABLE local_toolsets (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, current_version INTEGER NOT NULL CHECK(current_version BETWEEN 1 AND 9007199254740991),
      status TEXT NOT NULL CHECK(status IN ('active','inactive','deprecated')),
      approval_status TEXT NOT NULL CHECK(approval_status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,id,current_version)
        REFERENCES local_toolset_versions(org_id,project_id,principal_type,principal_id,toolset_id,version)
        DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TABLE local_toolset_versions (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      toolset_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
      config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,toolset_id,version),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,toolset_id)
        REFERENCES local_toolsets(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TABLE local_agent_toolset_bindings (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, agent_version_id TEXT NOT NULL, id TEXT NOT NULL,
      toolset_id TEXT NOT NULL, toolset_version INTEGER NOT NULL,
      binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json)='object'),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,agent_id,agent_version_id,toolset_id),
      CHECK(json_extract(binding_json,'$.id') IS id),
      CHECK(json_extract(binding_json,'$.toolsetId') IS toolset_id),
      CHECK(json_extract(binding_json,'$.toolsetVersion') IS toolset_version),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id,agent_version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,toolset_id,toolset_version)
        REFERENCES local_toolset_versions(org_id,project_id,principal_type,principal_id,toolset_id,version)
    ) STRICT;
    CREATE INDEX local_binding_toolset_reference ON local_agent_toolset_bindings
      (org_id,project_id,principal_type,principal_id,toolset_id,toolset_version);
    CREATE TRIGGER local_toolset_identity_immutable BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,id,created_at ON local_toolsets
      BEGIN SELECT RAISE(ABORT,'TOOLSET_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER local_toolset_retained BEFORE DELETE ON local_toolsets
      BEGIN SELECT RAISE(ABORT,'TOOLSET_RETAINED'); END;
    CREATE TRIGGER local_toolset_version_immutable BEFORE UPDATE ON local_toolset_versions
      BEGIN SELECT RAISE(ABORT,'TOOLSET_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER local_toolset_version_retained BEFORE DELETE ON local_toolset_versions
      BEGIN SELECT RAISE(ABORT,'TOOLSET_VERSION_IMMUTABLE'); END;
    CREATE TRIGGER local_toolset_binding_immutable BEFORE UPDATE ON local_agent_toolset_bindings
      BEGIN SELECT RAISE(ABORT,'TOOLSET_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER local_toolset_binding_retained BEFORE DELETE ON local_agent_toolset_bindings
      BEGIN SELECT RAISE(ABORT,'TOOLSET_BINDING_IMMUTABLE'); END;
  `,
  // A tombstone/version/binding is retained evidence, never silently discarded.
  down: `CREATE TEMP TABLE local_toolsets_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_toolsets_downgrade_guard SELECT
      (SELECT count(*) FROM local_toolsets) + (SELECT count(*) FROM local_toolset_versions) +
      (SELECT count(*) FROM local_agent_toolset_bindings);
    DROP TABLE local_toolsets_downgrade_guard;
    DROP TABLE local_agent_toolset_bindings; DROP TABLE local_toolset_versions; DROP TABLE local_toolsets;`,
}, {
  version: 7,
  name: "local_policy_releases",
  up: `
    CREATE TABLE local_policy_bindings (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, target_json TEXT NOT NULL CHECK(json_valid(target_json)), tool_name TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,target_json,tool_name),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE local_policy_releases (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, binding_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      toolset_binding_json TEXT NOT NULL CHECK(json_valid(toolset_binding_json)), release_hash TEXT NOT NULL,
      tool_anchor_json TEXT NOT NULL CHECK(json_valid(tool_anchor_json) AND json_extract(tool_anchor_json,'$.org_id') IS org_id),
      created_at TEXT NOT NULL,
      toolset_id TEXT GENERATED ALWAYS AS (json_extract(toolset_binding_json,'$.toolsetId')) STORED NOT NULL,
      toolset_version INTEGER GENERATED ALWAYS AS (json_extract(toolset_binding_json,'$.toolsetVersion')) STORED NOT NULL,
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,toolset_id,toolset_version)
        REFERENCES local_toolset_versions(org_id,project_id,principal_type,principal_id,toolset_id,version),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,revision),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,binding_id)
        REFERENCES local_policy_bindings(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TABLE local_policy_states (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      release_id TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','reviewed','published','revoked')),
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991), updated_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,release_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,release_id)
        REFERENCES local_policy_releases(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TABLE local_policy_activations (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, binding_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 9007199254740991),
      release_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('activate','rollback','deactivate')), created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,binding_id,sequence),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,binding_id,release_id)
        REFERENCES local_policy_releases(org_id,project_id,principal_type,principal_id,binding_id,id)
    ) STRICT;
    CREATE INDEX local_policy_activation_release ON local_policy_activations
      (org_id,project_id,principal_type,principal_id,release_id);
    CREATE TRIGGER local_policy_binding_immutable BEFORE UPDATE ON local_policy_bindings
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
    CREATE TRIGGER local_policy_binding_retained BEFORE DELETE ON local_policy_bindings
      BEGIN SELECT RAISE(ABORT,'POLICY_IMMUTABLE'); END;
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
  `,
  // Offline only: even inactive/revoked history prevents destructive downgrade.
  down: `CREATE TEMP TABLE local_policy_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_policy_downgrade_guard SELECT
      (SELECT count(*) FROM local_policy_bindings) + (SELECT count(*) FROM local_policy_releases) +
      (SELECT count(*) FROM local_policy_states) + (SELECT count(*) FROM local_policy_activations);
    DROP TABLE local_policy_downgrade_guard;
    DROP TABLE local_policy_activations; DROP TABLE local_policy_states;
    DROP TABLE local_policy_releases; DROP TABLE local_policy_bindings;`,
}, {
  version: 8,
  name: "local_connectors",
  up: `
    CREATE TABLE credential_staging (
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      connector_id TEXT NOT NULL, credential_ref TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      state TEXT NOT NULL CHECK(state IN ('pending','published','cleared')),
      PRIMARY KEY(credential_ref,revision),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE INDEX credential_staging_connector ON credential_staging(org_id,principal_type,principal_id,connector_id,state);
    CREATE TRIGGER credential_staging_identity BEFORE UPDATE OF org_id,principal_type,principal_id,connector_id,credential_ref,revision ON credential_staging
      BEGIN SELECT RAISE(ABORT,'CREDENTIAL_STAGING_IMMUTABLE'); END;
    CREATE TRIGGER credential_staging_transition BEFORE UPDATE OF state ON credential_staging
      WHEN OLD.state!='pending' OR NEW.state NOT IN ('published','cleared')
      BEGIN SELECT RAISE(ABORT,'CREDENTIAL_STAGING_IMMUTABLE'); END;
    CREATE TRIGGER credential_staging_retained BEFORE DELETE ON credential_staging
      BEGIN SELECT RAISE(ABORT,'CREDENTIAL_STAGING_RETAINED'); END;
    CREATE TABLE local_connectors (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      name TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json)='object'),
      origin TEXT NOT NULL CHECK(origin IN ('local','runner')),
      auth_json TEXT NOT NULL CHECK(json_valid(auth_json) AND json_type(auth_json)='object'),
      status TEXT NOT NULL CHECK(status='inactive'), cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0,1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      CHECK(json_extract(config_json,'$.name') IS name),
      CHECK((origin='runner' AND json_extract(config_json,'$.transport') IS 'stdio') OR
        (origin='local' AND json_extract(config_json,'$.transport') IS 'http')),
      CHECK(deleted_at IS NULL OR cleanup_required=0),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE UNIQUE INDEX local_connector_name ON local_connectors(org_id,project_id,principal_type,principal_id,name) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX local_connector_runner_source ON local_connectors
      (org_id,project_id,principal_type,principal_id,json_extract(config_json,'$.sourceId')) WHERE origin='runner';
    CREATE TABLE local_connector_auth_bindings (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      connector_id TEXT NOT NULL, connector_revision INTEGER NOT NULL CHECK(connector_revision BETWEEN 0 AND 9007199254740991),
      credential_ref TEXT NOT NULL REFERENCES credential_metadata(credential_ref),
      credential_revision INTEGER NOT NULL CHECK(credential_revision BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,connector_id,connector_revision),
      UNIQUE(credential_ref,credential_revision),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,connector_id)
        REFERENCES local_connectors(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TRIGGER local_connector_auth_scope BEFORE INSERT ON local_connector_auth_bindings
      WHEN NOT EXISTS (SELECT 1 FROM credential_metadata c WHERE c.org_id=NEW.org_id
        AND c.principal_type=NEW.principal_type AND c.principal_id=NEW.principal_id
        AND c.connector_id=NEW.connector_id AND c.credential_ref=NEW.credential_ref
        AND c.revision=NEW.credential_revision AND c.state='active')
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_CREDENTIAL_UNAVAILABLE'); END;
    CREATE TABLE local_connector_tombstones (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      connector_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      cleanup_proof_ref TEXT NOT NULL, deleted_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,connector_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,connector_id)
        REFERENCES local_connectors(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE TRIGGER local_connector_identity BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,id,origin,created_at ON local_connectors
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_IMMUTABLE'); END;
    CREATE TRIGGER local_connector_revision BEFORE UPDATE ON local_connectors
      WHEN OLD.deleted_at IS NOT NULL OR NEW.revision != OLD.revision+1
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_REVISION_CONFLICT'); END;
    CREATE TRIGGER local_connector_retained BEFORE DELETE ON local_connectors
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_RETAINED'); END;
    CREATE TRIGGER local_connector_auth_immutable BEFORE UPDATE ON local_connector_auth_bindings
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_IMMUTABLE'); END;
    CREATE TRIGGER local_connector_auth_retained BEFORE DELETE ON local_connector_auth_bindings
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_RETAINED'); END;
    CREATE TRIGGER local_connector_tombstone_immutable BEFORE UPDATE ON local_connector_tombstones
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_IMMUTABLE'); END;
    CREATE TRIGGER local_connector_tombstone_retained BEFORE DELETE ON local_connector_tombstones
      BEGIN SELECT RAISE(ABORT,'CONNECTOR_RETAINED'); END;
  `,
  // Even inactive identities, auth history and cleanup proofs are durable facts.
  down: `CREATE TEMP TABLE local_connector_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_connector_downgrade_guard SELECT (SELECT count(*) FROM local_connectors) +
      (SELECT count(*) FROM local_connector_auth_bindings) + (SELECT count(*) FROM local_connector_tombstones) +
      (SELECT count(*) FROM credential_staging);
    DROP TABLE local_connector_downgrade_guard;
    DROP TABLE local_connector_tombstones; DROP TABLE local_connector_auth_bindings; DROP TABLE local_connectors;
    DROP TABLE credential_staging;`,
}, {
  version: 9,
  name: "local_execution_attempts",
  up: `
    CREATE TABLE local_execution_attempts (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      session_id TEXT NOT NULL, attempt_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_version_id TEXT NOT NULL,
      placement TEXT NOT NULL CHECK(placement IN ('local_trusted','local_isolated','remote_self_hosted','managed_cloud')),
      placement_json TEXT NOT NULL CHECK(json_valid(placement_json) AND json_type(placement_json)='object'),
      workspace_identity_json TEXT CHECK(workspace_identity_json IS NULL
        OR (json_valid(workspace_identity_json) AND json_type(workspace_identity_json)='object')),
      binding_hash TEXT NOT NULL CHECK(length(binding_hash)=71 AND substr(binding_hash,1,7)='sha256:'
        AND substr(binding_hash,8) NOT GLOB '*[^0-9a-f]*'),
      owner_instance_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL CHECK(owner_epoch BETWEEN 0 AND 9007199254740991),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('bound','active','completed','failed','cancelled','requires_rebind')),
      revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
      bound_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,attempt_id),
      UNIQUE(org_id,principal_type,principal_id,attempt_id),
      CHECK(json_extract(placement_json,'$.schema_version') IS 'orchestrion.execution-placement.v1'),
      CHECK(json_extract(placement_json,'$.project_id') IS project_id),
      CHECK(json_extract(placement_json,'$.task_id') IS session_id),
      CHECK(json_extract(placement_json,'$.attempt_id') IS attempt_id),
      CHECK(json_extract(placement_json,'$.placement') IS placement),
      CHECK(json_type(placement_json,'$.frozen')='true' AND json_extract(placement_json,'$.fallback') IS 'forbidden'),
      CHECK((placement='local_trusted' AND json_extract(placement_json,'$.workspace.kind') IS 'local_folder')
        OR (placement='local_isolated' AND json_extract(placement_json,'$.workspace.kind') IS 'mounted_folder')
        OR (placement='managed_cloud' AND json_extract(placement_json,'$.workspace.kind') IS 'repository_ref')
        OR (placement='remote_self_hosted' AND json_extract(placement_json,'$.workspace.kind') IN ('mounted_folder','repository_ref'))),
      CHECK((placement='local_trusted' AND workspace_identity_json IS NOT NULL
        AND json_extract(workspace_identity_json,'$.kind') IS 'local_folder'
        AND json_type(workspace_identity_json,'$.canonical_path')='text' AND length(json_extract(workspace_identity_json,'$.canonical_path'))>0
        AND json_type(workspace_identity_json,'$.dev')='integer' AND json_extract(workspace_identity_json,'$.dev')>=0
        AND json_type(workspace_identity_json,'$.ino')='integer' AND json_extract(workspace_identity_json,'$.ino')>=0)
        OR (placement!='local_trusted' AND workspace_identity_json IS NULL)),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id,agent_version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id)
    ) STRICT;
    CREATE INDEX local_execution_attempt_session ON local_execution_attempts
      (org_id,project_id,principal_type,principal_id,session_id,lifecycle);
    CREATE INDEX local_execution_attempt_agent_version ON local_execution_attempts
      (org_id,project_id,principal_type,principal_id,agent_id,agent_version_id);
    CREATE TRIGGER local_execution_attempt_birth BEFORE INSERT ON local_execution_attempts
      WHEN NEW.lifecycle!='bound' OR NEW.revision!=0
      BEGIN SELECT RAISE(ABORT,'EXECUTION_ATTEMPT_STATE_CONFLICT'); END;
    CREATE TRIGGER local_execution_attempt_identity BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,
      session_id,attempt_id,agent_id,agent_version_id,placement,placement_json,workspace_identity_json,binding_hash,
      owner_instance_id,owner_epoch,bound_at ON local_execution_attempts
      BEGIN SELECT RAISE(ABORT,'EXECUTION_ATTEMPT_IMMUTABLE'); END;
    CREATE TRIGGER local_execution_attempt_retained BEFORE DELETE ON local_execution_attempts
      BEGIN SELECT RAISE(ABORT,'EXECUTION_ATTEMPT_RETAINED'); END;
    CREATE TRIGGER local_execution_attempt_transition BEFORE UPDATE ON local_execution_attempts
      WHEN NEW.revision != OLD.revision+1 OR NOT (
        (OLD.lifecycle='bound' AND NEW.lifecycle IN ('active','cancelled','requires_rebind')) OR
        (OLD.lifecycle='active' AND NEW.lifecycle IN ('completed','failed','cancelled','requires_rebind')) OR
        (OLD.lifecycle='requires_rebind' AND NEW.lifecycle='cancelled'))
      BEGIN SELECT RAISE(ABORT,'EXECUTION_ATTEMPT_STATE_CONFLICT'); END;
  `,
  // Every attempt is execution evidence: which AgentVersion, placement, folder and
  // runtime owner were bound. Offline explicit disposal only; never silently erased.
  down: `CREATE TEMP TABLE local_execution_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_execution_downgrade_guard SELECT count(*) FROM local_execution_attempts;
    DROP TABLE local_execution_downgrade_guard;
    DROP TABLE local_execution_attempts;`,
}, {
  version: 10,
  name: "local_governed_tool_events",
  up: `
    CREATE TABLE local_governed_tool_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence BETWEEN 1 AND 9007199254740991),
      event_id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      session_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      thread_id TEXT NOT NULL CHECK(length(thread_id)>0), turn_id TEXT NOT NULL CHECK(length(turn_id)>0),
      call_id TEXT NOT NULL CHECK(length(call_id)>0), tool_name TEXT NOT NULL CHECK(length(tool_name)>0),
      ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),
      event_type TEXT NOT NULL CHECK(event_type IN ('admitted','denied','completed','failed','cancelled')),
      reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code)>0 AND reason_code NOT GLOB '*[^A-Z0-9_]*')),
      plan_hash TEXT CHECK(plan_hash IS NULL OR (length(plan_hash)=71 AND substr(plan_hash,1,7)='sha256:'
        AND substr(plan_hash,8) NOT GLOB '*[^0-9a-f]*')),
      result_hash TEXT CHECK(result_hash IS NULL OR (length(result_hash)=71 AND substr(result_hash,1,7)='sha256:'
        AND substr(result_hash,8) NOT GLOB '*[^0-9a-f]*')),
      result_bytes INTEGER CHECK(result_bytes IS NULL OR result_bytes BETWEEN 0 AND 9007199254740991),
      request_id TEXT NOT NULL CHECK(length(request_id)>0), causation_id TEXT NOT NULL CHECK(length(causation_id)>0),
      owner_instance_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL CHECK(owner_epoch BETWEEN 0 AND 9007199254740991),
      timestamp TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK(json_valid(data_json) AND json_type(data_json)='object'),
      UNIQUE(org_id,project_id,principal_type,principal_id,attempt_id,call_id,ordinal),
      CHECK((ordinal=1 AND event_type IN ('admitted','denied')) OR (ordinal=2 AND event_type IN ('completed','failed','cancelled'))),
      CHECK((event_type IN ('admitted','completed') AND reason_code IS NULL)
        OR (event_type IN ('denied','failed','cancelled') AND reason_code IS NOT NULL)),
      CHECK((event_type='denied') OR plan_hash IS NOT NULL),
      CHECK((event_type='completed' AND result_hash IS NOT NULL AND result_bytes IS NOT NULL)
        OR (event_type!='completed' AND result_hash IS NULL AND result_bytes IS NULL)),
      CHECK(json_extract(data_json,'$.tool') IS tool_name),
      CHECK(json_extract(data_json,'$.call_id') IS call_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,attempt_id)
        REFERENCES local_execution_attempts(org_id,project_id,principal_type,principal_id,attempt_id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE INDEX local_governed_tool_event_session ON local_governed_tool_events
      (org_id,project_id,principal_type,principal_id,session_id,sequence);
    CREATE TRIGGER local_governed_tool_event_attempt BEFORE INSERT ON local_governed_tool_events
      WHEN NOT EXISTS (SELECT 1 FROM local_execution_attempts a WHERE a.org_id=NEW.org_id AND a.project_id=NEW.project_id
        AND a.principal_type=NEW.principal_type AND a.principal_id=NEW.principal_id AND a.attempt_id=NEW.attempt_id
        AND a.session_id=NEW.session_id
        AND (NEW.event_type!='admitted' OR (a.owner_instance_id=NEW.owner_instance_id AND a.owner_epoch=NEW.owner_epoch)))
      BEGIN SELECT RAISE(ABORT,'GOVERNED_TOOL_EVENT_ATTEMPT_MISMATCH'); END;
    CREATE TRIGGER local_governed_tool_event_order BEFORE INSERT ON local_governed_tool_events
      WHEN NEW.ordinal=2 AND NOT EXISTS (SELECT 1 FROM local_governed_tool_events e WHERE e.org_id=NEW.org_id
        AND e.project_id=NEW.project_id AND e.principal_type=NEW.principal_type AND e.principal_id=NEW.principal_id
        AND e.attempt_id=NEW.attempt_id AND e.call_id=NEW.call_id AND e.ordinal=1 AND e.event_type='admitted'
        AND e.plan_hash IS NEW.plan_hash AND e.session_id=NEW.session_id AND e.thread_id=NEW.thread_id
        AND e.turn_id=NEW.turn_id AND e.tool_name=NEW.tool_name AND e.causation_id=NEW.causation_id
        AND e.owner_instance_id=NEW.owner_instance_id AND e.owner_epoch=NEW.owner_epoch
        AND json_extract(e.data_json,'$.path') IS json_extract(NEW.data_json,'$.path'))
      BEGIN SELECT RAISE(ABORT,'GOVERNED_TOOL_EVENT_ORDER'); END;
    CREATE TRIGGER local_governed_tool_event_immutable BEFORE UPDATE ON local_governed_tool_events
      BEGIN SELECT RAISE(ABORT,'GOVERNED_TOOL_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER local_governed_tool_event_retained BEFORE DELETE ON local_governed_tool_events
      BEGIN SELECT RAISE(ABORT,'GOVERNED_TOOL_EVENT_RETAINED'); END;
  `,
  // Every governed call is audit evidence: which attempt, plan and outcome. Offline
  // explicit disposal only; a populated log is never silently erased.
  down: `CREATE TEMP TABLE local_governed_tool_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_governed_tool_downgrade_guard SELECT count(*) FROM local_governed_tool_events;
    DROP TABLE local_governed_tool_downgrade_guard;
    DROP TABLE local_governed_tool_events;`,
}, {
  version: 11,
  name: "local_governed_session_tree",
  up: `
    CREATE TABLE local_session_tree_projects (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      path TEXT NOT NULL, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)), created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id)
    ) STRICT;
    CREATE TABLE local_session_tree_agents (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, version_id TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,agent_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id)
        REFERENCES local_session_tree_projects(org_id,project_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id,version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id)
    ) STRICT;
    CREATE TABLE local_session_tree_sessions (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, agent_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      CHECK(json_extract(record_json,'$.id') IS id),
      CHECK(json_extract(record_json,'$.agentId') IS agent_id),
      CHECK(json_extract(record_json,'$.executionMode') IS 'governed'),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id)
        REFERENCES local_session_tree_agents(org_id,project_id,principal_type,principal_id,agent_id)
    ) STRICT;
    CREATE TRIGGER local_session_tree_project_immutable BEFORE UPDATE ON local_session_tree_projects
      BEGIN SELECT RAISE(ABORT,'SESSION_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER local_session_tree_agent_immutable BEFORE UPDATE ON local_session_tree_agents
      BEGIN SELECT RAISE(ABORT,'SESSION_BINDING_IMMUTABLE'); END;
    CREATE TRIGGER local_session_tree_session_identity BEFORE UPDATE OF org_id,project_id,principal_type,principal_id,id,agent_id ON local_session_tree_sessions
      BEGIN SELECT RAISE(ABORT,'SESSION_BINDING_IMMUTABLE'); END;
  `,
  // Never downgrade populated bindings into native JSON identities. Restore a
  // pre-upgrade offline backup to undo adoption, keeping this profile for evidence.
  down: `CREATE TEMP TABLE local_session_tree_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_session_tree_downgrade_guard SELECT count(*) FROM local_session_tree_projects;
    DROP TABLE local_session_tree_downgrade_guard;
    DROP TABLE local_session_tree_sessions;
    DROP TABLE local_session_tree_agents;
    DROP TABLE local_session_tree_projects;`,
}, { ...TOOL_GRANT_MIGRATION }, { ...TOOLSET_RETIREMENT_MIGRATION }, { ...ASSIGNMENT_MIGRATION }, { ...ASSIGNMENT_CUTOVER_MIGRATION }, { ...BUDGET_CEILING_MIGRATION }, { ...AGENT_SESSION_MIGRATION }, { ...DIRECT_SESSION_MIGRATION }, { ...SOURCE_PUBLICATION_MIGRATION }, { ...DIRECT_GRANT_CEILING_MIGRATION }, { ...CODEX_ACCOUNT_MIGRATION }, { ...CODEX_ACCOUNT_LIFECYCLE_MIGRATION }, { ...AGENT_SOUL_MIGRATION }, { ...DIRECT_PROVIDER_CALL_MIGRATION }, { ...DIRECT_CONTEXT_MIGRATION }, { ...DIRECT_REPOSITORY_INSTRUCTIONS_MIGRATION }];

function digest(m: SqliteMigration): string {
  return createHash("sha256").update(JSON.stringify([m.version, m.name, m.up, m.down])).digest("hex");
}

/** Caller owns the exclusive host lock. One atomic upgrade/downgrade, including ledger. */
export function migrate(db: DatabaseSync, target = SQLITE_MIGRATIONS.length,
  chain: readonly SqliteMigration[] = SQLITE_MIGRATIONS): void {
  registerGrantFunctions(db);
  if (!Number.isInteger(target) || target < 0 || target > chain.length
      || chain.some((m, i) => m.version !== i + 1)) throw new Error("SQLITE_MIGRATION_CHAIN_INVALID");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL
    ) STRICT`);
    const rows = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    if (version !== rows.length || rows.some((r, i) => !chain[i] || r.version !== i + 1
        || r.name !== chain[i].name || r.checksum !== digest(chain[i])))
      throw new Error("SQLITE_MIGRATION_HISTORY_MISMATCH");
    if (target > rows.length) {
      for (let i = rows.length; i < target; i++) {
        db.exec(chain[i].up);
        db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(i + 1, chain[i].name, digest(chain[i]));
      }
    } else {
      for (let i = rows.length; i > target; i--) {
        db.exec(chain[i - 1].down);
        db.prepare("DELETE FROM schema_migrations WHERE version=?").run(i);
      }
    }
    db.exec(`PRAGMA user_version=${target}`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLITE_FOREIGN_KEY_CHECK_FAILED");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

import { TOOL_GRANT_MIGRATION, registerGrantFunctions } from "./tool-grant-migration";
import { TOOLSET_RETIREMENT_MIGRATION } from "./toolset-retirement-migration";
import { SOURCE_PUBLICATION_MIGRATION } from "./source-publication-migration";
