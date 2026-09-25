import type { SqliteMigration } from "./migrations";

/** D2B repairs first-class Agents authored after SQLite14's one-time backfill.
 * They remain legacy-unversioned; no Principal, authority or released version
 * is inferred. Ambiguous org-wide Agent IDs refuse the entire migration. */
export const ASSIGNMENT_CUTOVER_MIGRATION: SqliteMigration = {
  version:15,
  name:"assignment_host_cutover",
  up:`
    CREATE TEMP TABLE m9_cutover_ambiguity (n INTEGER CHECK(n=0));
    INSERT INTO m9_cutover_ambiguity SELECT count(*) FROM (
      SELECT org_id,id FROM local_agents WHERE node_type='agent'
      GROUP BY org_id,id HAVING count(*)>1
    );
    DROP TABLE m9_cutover_ambiguity;

    CREATE TEMP TABLE m9_cutover_missing AS
      SELECT a.org_id,a.id,a.name,a.project_id,a.principal_type,a.principal_id,a.created_at,a.deleted_at
      FROM local_agents a WHERE a.node_type='agent' AND NOT EXISTS (
        SELECT 1 FROM agent_identities i WHERE i.org_id=a.org_id AND i.id=a.id
      );
    CREATE TABLE m9_assignment_cutover_repair (
      org_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      PRIMARY KEY(org_id,agent_id),
      FOREIGN KEY(org_id,agent_id) REFERENCES agent_identities(org_id,id)
    ) STRICT;
    INSERT INTO agent_identities
      (org_id,id,name,visibility,home_project_id,derived_from_agent_version_id,
       agent_principal_id,identity_state,owner_principal_type,owner_principal_id,created_at,removed_at)
    SELECT org_id,id,name,'project',project_id,NULL,NULL,'legacy_unresolved',
           principal_type,principal_id,created_at,deleted_at
    FROM m9_cutover_missing;
    INSERT INTO project_agent_assignments
      (org_id,id,project_id,agent_id,status,current_assignment_version_id,migration_state,created_at,removed_at)
    SELECT org_id,'assignment:'||id,project_id,id,
           CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'removed' END,
           NULL,'legacy_unversioned',created_at,deleted_at
    FROM m9_cutover_missing;
    INSERT INTO m9_assignment_cutover_repair SELECT org_id,id FROM m9_cutover_missing;
    DROP TABLE m9_cutover_missing;
  `,
  down:`
    CREATE TEMP TABLE m9_cutover_down_guard (n INTEGER CHECK(n=0));
    INSERT INTO m9_cutover_down_guard SELECT count(*) FROM m9_assignment_cutover_repair;
    DROP TABLE m9_cutover_down_guard;
    DROP TABLE m9_assignment_cutover_repair;
  `,
};
