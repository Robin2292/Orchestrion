import type { SqliteMigration } from "./migrations";

/** C3A records are append-only. An activation is an immutable pointer event. */
export const SOURCE_PUBLICATION_MIGRATION: SqliteMigration = {
  version: 19,
  name: "accepted_source_publications",
  up: `
    CREATE TABLE local_source_snapshots (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, connector_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
      accepted_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,id,connector_id),
      CHECK(json_extract(snapshot_json,'$.id') IS id AND json_extract(snapshot_json,'$.sourceId') IS connector_id
        AND json_extract(snapshot_json,'$.contentHash') IS content_hash),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,connector_id)
        REFERENCES local_connectors(org_id,project_id,principal_type,principal_id,id)
    ) STRICT;
    CREATE INDEX local_source_snapshots_connector ON local_source_snapshots
      (org_id,project_id,principal_type,principal_id,connector_id,accepted_at);
    CREATE TABLE local_source_drafts (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, connector_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
      reviewed_hash TEXT, created_at TEXT NOT NULL, reviewed_at TEXT,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,id,connector_id,snapshot_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,snapshot_id,connector_id)
        REFERENCES local_source_snapshots(org_id,project_id,principal_type,principal_id,id,connector_id),
      CHECK((reviewed_hash IS NULL)=(reviewed_at IS NULL))
    ) STRICT;
    CREATE TABLE local_source_releases (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      id TEXT NOT NULL, connector_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
      draft_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      publication_json TEXT NOT NULL CHECK(json_valid(publication_json) AND json_type(publication_json)='object'),
      published_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,id),
      UNIQUE(org_id,project_id,principal_type,principal_id,id,connector_id),
      UNIQUE(org_id,project_id,principal_type,principal_id,connector_id,version),
      UNIQUE(org_id,project_id,principal_type,principal_id,draft_id),
      CHECK(json_extract(publication_json,'$.id') IS id AND json_extract(publication_json,'$.sourceId') IS connector_id
        AND json_extract(publication_json,'$.snapshotId') IS snapshot_id
        AND json_extract(publication_json,'$.snapshotHash') IS content_hash),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,draft_id,connector_id,snapshot_id)
        REFERENCES local_source_drafts(org_id,project_id,principal_type,principal_id,id,connector_id,snapshot_id),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,snapshot_id,connector_id)
        REFERENCES local_source_snapshots(org_id,project_id,principal_type,principal_id,id,connector_id)
    ) STRICT;
    CREATE TABLE local_source_activation_events (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      connector_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), release_id TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      PRIMARY KEY(org_id,project_id,principal_type,principal_id,connector_id,revision),
      FOREIGN KEY(org_id,project_id,principal_type,principal_id,release_id,connector_id)
        REFERENCES local_source_releases(org_id,project_id,principal_type,principal_id,id,connector_id)
    ) STRICT;
    CREATE TRIGGER local_source_snapshot_immutable BEFORE UPDATE ON local_source_snapshots
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_snapshot_retained BEFORE DELETE ON local_source_snapshots
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_draft_frozen BEFORE UPDATE ON local_source_drafts
      WHEN OLD.reviewed_at IS NOT NULL OR NEW.reviewed_at IS NULL OR NEW.reviewed_hash IS NULL
        OR NEW.org_id!=OLD.org_id OR NEW.project_id!=OLD.project_id
        OR NEW.principal_type!=OLD.principal_type OR NEW.principal_id!=OLD.principal_id
        OR NEW.id!=OLD.id OR NEW.connector_id!=OLD.connector_id OR NEW.snapshot_id!=OLD.snapshot_id
        OR NEW.created_at!=OLD.created_at
      BEGIN SELECT RAISE(ABORT,'SOURCE_DRAFT_FROZEN'); END;
    CREATE TRIGGER local_source_draft_retained BEFORE DELETE ON local_source_drafts
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_release_immutable BEFORE UPDATE ON local_source_releases
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_release_retained BEFORE DELETE ON local_source_releases
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_activation_immutable BEFORE UPDATE ON local_source_activation_events
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
    CREATE TRIGGER local_source_activation_retained BEFORE DELETE ON local_source_activation_events
      BEGIN SELECT RAISE(ABORT,'SOURCE_IMMUTABLE'); END;
  `,
  // An offline backup is required before discarding accepted/reviewed history.
  down: `CREATE TEMP TABLE local_source_down_guard(n INTEGER CHECK(n=0));
    INSERT INTO local_source_down_guard SELECT
      (SELECT count(*) FROM local_source_snapshots)+(SELECT count(*) FROM local_source_drafts)+
      (SELECT count(*) FROM local_source_releases)+(SELECT count(*) FROM local_source_activation_events);
    DROP TABLE local_source_down_guard;
    DROP TRIGGER local_source_activation_retained; DROP TRIGGER local_source_activation_immutable;
    DROP TRIGGER local_source_release_retained; DROP TRIGGER local_source_release_immutable;
    DROP TRIGGER local_source_draft_retained; DROP TRIGGER local_source_draft_frozen;
    DROP TRIGGER local_source_snapshot_retained; DROP TRIGGER local_source_snapshot_immutable;
    DROP TABLE local_source_activation_events; DROP TABLE local_source_releases;
    DROP TABLE local_source_drafts; DROP TABLE local_source_snapshots;`,
};
