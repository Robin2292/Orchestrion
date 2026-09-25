import type { SqliteMigration } from "./migrations";

/** D2E2 owns the Local tuple-version authority. Event IDs are positive version IDs. */
export const DIRECT_GRANT_CEILING_MIGRATION: SqliteMigration = {
  version: 20,
  name: "local_direct_grant_ceilings",
  up: `
    CREATE TABLE local_direct_grant_ceiling_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK(subject_kind IN ('organization','agent')),
      subject_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
      grant_json TEXT,
      tuple_hash TEXT,
      parent_org_version_id TEXT,
      revoked_version_id TEXT,
      grantor_type TEXT NOT NULL CHECK(grantor_type='user'),
      grantor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(org_id,event_id),
      UNIQUE(org_id,subject_kind,subject_id,revision),
      UNIQUE(org_id,subject_kind,subject_id,grantor_id,idempotency_key),
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(org_id,grantor_type,grantor_id)
        REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,parent_org_version_id)
        REFERENCES local_direct_grant_ceiling_events(org_id,event_id),
      FOREIGN KEY(org_id,revoked_version_id)
        REFERENCES local_direct_grant_ceiling_events(org_id,event_id),
      CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:'),
      CHECK((action='grant' AND grant_json IS NOT NULL AND tuple_hash IS NOT NULL
        AND revoked_version_id IS NULL AND tg1_valid(json_object('schema_version','tool_grants@1',
          'grants',json_array(json(grant_json))))=1 AND grant_json=tg1_canonical_tuple(grant_json)
        AND tg1_hash(grant_json)=tuple_hash
        AND ((subject_kind='organization' AND parent_org_version_id IS NULL)
          OR (subject_kind='agent' AND parent_org_version_id IS NOT NULL)))
        OR (action='revoke' AND grant_json IS NULL AND tuple_hash IS NULL
          AND parent_org_version_id IS NULL AND revoked_version_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX local_direct_grant_subject ON local_direct_grant_ceiling_events
      (org_id,subject_kind,subject_id,revision);
    CREATE INDEX local_direct_grant_revoke ON local_direct_grant_ceiling_events
      (org_id,revoked_version_id);
    CREATE TRIGGER local_direct_grant_event_guard BEFORE INSERT ON local_direct_grant_ceiling_events BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id=NEW.org_id
        AND m.principal_type='user' AND m.principal_id=NEW.grantor_id
        AND m.role IN ('owner','admin')) THEN RAISE(ABORT,'DIRECT_GRANT_GRANTOR_DENIED') END;
      SELECT CASE WHEN NEW.subject_kind='organization' AND NEW.subject_id!=NEW.org_id
        THEN RAISE(ABORT,'DIRECT_GRANT_SUBJECT_INVALID') END;
      SELECT CASE WHEN NEW.subject_kind='agent' AND NOT EXISTS (
        SELECT 1 FROM agent_identities a JOIN local_agents l
          ON l.org_id=a.org_id AND l.project_id=a.home_project_id
          AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
          AND l.id=a.id AND l.node_type='agent'
        WHERE a.org_id=NEW.org_id AND a.id=NEW.subject_id
          AND a.agent_principal_id=a.id AND a.identity_state='governed'
          AND a.removed_at IS NULL AND l.deleted_at IS NULL)
        THEN RAISE(ABORT,'DIRECT_GRANT_AGENT_PRINCIPAL_UNAVAILABLE') END;
      SELECT CASE WHEN NEW.revision!=(SELECT coalesce(max(e.revision),0)+1
        FROM local_direct_grant_ceiling_events e WHERE e.org_id=NEW.org_id
          AND e.subject_kind=NEW.subject_kind AND e.subject_id=NEW.subject_id)
        THEN RAISE(ABORT,'DIRECT_GRANT_REVISION_CONFLICT') END;
      SELECT CASE WHEN NEW.action='grant' AND (SELECT count(*) FROM local_direct_grant_ceiling_events g
        WHERE g.org_id=NEW.org_id AND g.subject_kind=NEW.subject_kind AND g.subject_id=NEW.subject_id
          AND g.action='grant' AND NOT EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events r
            WHERE r.org_id=g.org_id AND r.action='revoke' AND r.revoked_version_id=g.event_id))>=512
        THEN RAISE(ABORT,'DIRECT_GRANT_LIMIT') END;
      SELECT CASE WHEN NEW.action='grant' AND EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events g
        WHERE g.org_id=NEW.org_id AND g.subject_kind=NEW.subject_kind AND g.subject_id=NEW.subject_id
          AND g.action='grant' AND g.tuple_hash=NEW.tuple_hash
          AND NOT EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events r
            WHERE r.org_id=g.org_id AND r.action='revoke' AND r.revoked_version_id=g.event_id))
        THEN RAISE(ABORT,'DIRECT_GRANT_DUPLICATE_TUPLE') END;
      SELECT CASE WHEN NEW.action='grant' AND NEW.subject_kind='agent' AND NOT EXISTS (
        SELECT 1 FROM local_direct_grant_ceiling_events p
        WHERE p.org_id=NEW.org_id AND p.event_id=NEW.parent_org_version_id
          AND p.subject_kind='organization' AND p.subject_id=NEW.org_id
          AND p.action='grant' AND p.tuple_hash=NEW.tuple_hash
          AND NOT EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events r
            WHERE r.org_id=p.org_id AND r.action='revoke' AND r.revoked_version_id=p.event_id))
        THEN RAISE(ABORT,'DIRECT_GRANT_ORGANIZATION_CEILING_REQUIRED') END;
      SELECT CASE WHEN NEW.action='revoke' AND NOT EXISTS (
        SELECT 1 FROM local_direct_grant_ceiling_events g
        WHERE g.org_id=NEW.org_id AND g.event_id=NEW.revoked_version_id
          AND g.subject_kind=NEW.subject_kind AND g.subject_id=NEW.subject_id
          AND g.action='grant' AND NOT EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events r
            WHERE r.org_id=g.org_id AND r.action='revoke' AND r.revoked_version_id=g.event_id))
        THEN RAISE(ABORT,'DIRECT_GRANT_VERSION_INACTIVE') END;
    END;
    CREATE TRIGGER local_direct_grant_event_immutable BEFORE UPDATE ON local_direct_grant_ceiling_events
      BEGIN SELECT RAISE(ABORT,'DIRECT_GRANT_EVENT_IMMUTABLE'); END;
    CREATE TRIGGER local_direct_grant_event_retained BEFORE DELETE ON local_direct_grant_ceiling_events
      BEGIN SELECT RAISE(ABORT,'DIRECT_GRANT_EVENT_IMMUTABLE'); END;
  `,
  // A populated ledger is authority evidence; restore an offline backup or append
  // a compensating revoke rather than silently destroying that history.
  down: `CREATE TEMP TABLE local_direct_grant_down_guard(n INTEGER CHECK(n=0));
    INSERT INTO local_direct_grant_down_guard SELECT count(*) FROM local_direct_grant_ceiling_events;
    DROP TABLE local_direct_grant_down_guard;
    DROP TRIGGER local_direct_grant_event_retained;
    DROP TRIGGER local_direct_grant_event_immutable;
    DROP TRIGGER local_direct_grant_event_guard;
    DROP TABLE local_direct_grant_ceiling_events;`,
};
