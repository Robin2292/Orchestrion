import type { SqliteMigration } from "./migrations";

/** Only versions created after this migration carry SOUL provenance. Existing
 * prompt fields and Session pins are deliberately left untouched. */
export const AGENT_SOUL_MIGRATION: SqliteMigration = {
  version: 23,
  name: "local_agent_soul_snapshots",
  up: `CREATE TABLE local_agent_soul_snapshots (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL, agent_id TEXT NOT NULL, version_id TEXT NOT NULL,
      content TEXT NOT NULL, content_hash TEXT NOT NULL
        CHECK(length(content_hash)=71 AND substr(content_hash,1,7)='sha256:'
          AND substr(content_hash,8) NOT GLOB '*[^0-9a-f]*'),
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,agent_id,version_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,agent_id,version_id)
        REFERENCES local_agent_versions(org_id,project_id,principal_type,principal_id,agent_id,id)
    ) STRICT;
    CREATE TRIGGER local_agent_soul_immutable BEFORE UPDATE ON local_agent_soul_snapshots
      BEGIN SELECT RAISE(ABORT,'AGENT_SOUL_IMMUTABLE'); END;
    CREATE TRIGGER local_agent_soul_retained BEFORE DELETE ON local_agent_soul_snapshots
      BEGIN SELECT RAISE(ABORT,'AGENT_SOUL_IMMUTABLE'); END;`,
  // A published snapshot is immutable behavior evidence. Roll back populated
  // profiles only from an explicit offline backup, never by silently dropping it.
  down: `CREATE TEMP TABLE local_agent_soul_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_agent_soul_downgrade_guard SELECT count(*) FROM local_agent_soul_snapshots;
    DROP TABLE local_agent_soul_downgrade_guard;
    DROP TABLE local_agent_soul_snapshots;`,
};
