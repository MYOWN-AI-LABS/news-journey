-- Memory schema v1. Apply explicitly with a migration administrator, never the application login.
-- No database, password, hosted endpoint or user membership is provisioned by this migration.
-- The application login must be a nonowner, NOSUPERUSER, NOCREATEROLE, NOBYPASSRLS member of
-- harness_memory_runtime. Do not grant it membership in a migration/table-owner role.
-- Transactional failure rolls back this migration. Before upgrading an existing deployment,
-- back up and verify restore; retain the previous compatible adapter for rollback. There is
-- deliberately no destructive automatic DOWN migration or in-place archive import.
BEGIN;
CREATE SCHEMA IF NOT EXISTS harness_memory;
REVOKE ALL ON SCHEMA harness_memory FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_memory_runtime') THEN
    CREATE ROLE harness_memory_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_memory_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe existing harness_memory_runtime role';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS harness_memory.schema_migrations (
  version integer PRIMARY KEY, description text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM harness_memory.schema_migrations WHERE version <> 1) THEN
    RAISE EXCEPTION 'Unsupported memory schema version; use its explicit migration and rollback procedure';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS harness_memory.records (
  workspace_id text NOT NULL, publication_id text NOT NULL, key text NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  kind text GENERATED ALWAYS AS (value->>'kind') STORED NOT NULL,
  status text GENERATED ALWAYS AS (value->>'status') STORED NOT NULL,
  revision bigint GENERATED ALWAYS AS ((value->>'revision')::bigint) STORED NOT NULL,
  effective_at bigint GENERATED ALWAYS AS ((value->>'effectiveAt')::bigint) STORED NOT NULL,
  expires_at bigint GENERATED ALWAYS AS ((value->>'expiresAt')::bigint) STORED,
  PRIMARY KEY (workspace_id, publication_id, key),
  CHECK ((value->>'key' = key) IS TRUE), CHECK (revision > 0),
  CHECK (kind IN ('working','semantic','episodic','procedural')),
  CHECK (status IN ('proposed','approved','retired')),
  CHECK (jsonb_typeof(value->'tags') = 'array' AND jsonb_typeof(value->'evidenceRefs') = 'array'),
  CHECK (octet_length(value::text) <= 131072)
);
CREATE TABLE IF NOT EXISTS harness_memory.record_versions (
  workspace_id text NOT NULL, publication_id text NOT NULL, key text NOT NULL, revision bigint NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  PRIMARY KEY (workspace_id, publication_id, key, revision),
  FOREIGN KEY (workspace_id, publication_id, key) REFERENCES harness_memory.records(workspace_id, publication_id, key) ON DELETE CASCADE,
  CHECK ((value->>'key' = key AND (value->>'revision')::bigint = revision) IS TRUE),
  CHECK (octet_length(value::text) <= 131072)
);
CREATE TABLE IF NOT EXISTS harness_memory.stories (
  workspace_id text NOT NULL, publication_id text NOT NULL, id text NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  lookup_entities text[] NOT NULL,
  identity_lookup text CHECK (identity_lookup IS NULL OR identity_lookup ~ '^[a-f0-9]{64}$'),
  observed_at bigint GENERATED ALWAYS AS ((value->>'observedAt')::bigint) STORED NOT NULL,
  PRIMARY KEY (workspace_id, publication_id, id), CHECK ((value->>'id' = id) IS TRUE),
  CHECK (jsonb_typeof(value->'canonicalUrls') = 'array' AND jsonb_typeof(value->'entities') = 'array'),
  CHECK (octet_length(value::text) <= 1048576)
);
CREATE TABLE IF NOT EXISTS harness_memory.coverage (
  workspace_id text NOT NULL, publication_id text NOT NULL, idempotency_key text NOT NULL,
  request_identity text NOT NULL CHECK (request_identity ~ '^[a-f0-9]{64}$'),
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  story_id text GENERATED ALWAYS AS (value->>'storyId') STORED NOT NULL,
  kind text GENERATED ALWAYS AS (value->>'kind') STORED NOT NULL,
  status text GENERATED ALWAYS AS (value->>'status') STORED NOT NULL,
  updated_at bigint GENERATED ALWAYS AS ((value->>'updatedAt')::bigint) STORED NOT NULL,
  expires_at bigint GENERATED ALWAYS AS ((value->>'expiresAt')::bigint) STORED,
  PRIMARY KEY (workspace_id, publication_id, idempotency_key),
  FOREIGN KEY (workspace_id, publication_id, story_id) REFERENCES harness_memory.stories(workspace_id, publication_id, id),
  CHECK ((value->>'idempotencyKey' = idempotency_key) IS TRUE),
  CHECK (kind IN ('story','mention')),
  CHECK (status IN ('draft','reserved','submitted-unconfirmed','published','retracted','cancelled')),
  CHECK ((status NOT IN ('published','retracted') OR
    (jsonb_typeof(value->'receipt') = 'object' AND length(value->'receipt'->>'provider') > 0
      AND length(value->'receipt'->>'remoteId') > 0 AND jsonb_typeof(value->'receipt'->'confirmedAt') = 'number')) IS TRUE),
  CHECK (octet_length(value::text) <= 16384)
);
CREATE TABLE IF NOT EXISTS harness_memory.retention_refs (
  workspace_id text NOT NULL, publication_id text NOT NULL, record_key text NOT NULL, owner_key text NOT NULL,
  PRIMARY KEY (workspace_id, publication_id, record_key, owner_key),
  FOREIGN KEY (workspace_id, publication_id, record_key) REFERENCES harness_memory.records(workspace_id, publication_id, key)
);
CREATE TABLE IF NOT EXISTS harness_memory.journal (
  workspace_id text NOT NULL, publication_id text NOT NULL, id text NOT NULL,
  actor_id text NOT NULL, operation text NOT NULL, at_ms bigint NOT NULL, details jsonb NOT NULL,
  PRIMARY KEY (workspace_id, publication_id, id), CHECK (octet_length(details::text) <= 16384)
);
CREATE INDEX IF NOT EXISTS memory_recall ON harness_memory.records (workspace_id, publication_id, status, kind, effective_at);
CREATE INDEX IF NOT EXISTS memory_story_recent ON harness_memory.stories (workspace_id, publication_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS memory_story_identity ON harness_memory.stories (workspace_id, publication_id, identity_lookup);
CREATE INDEX IF NOT EXISTS memory_coverage_event ON harness_memory.coverage (workspace_id, publication_id, story_id, kind, status);
CREATE INDEX IF NOT EXISTS memory_coverage_recent ON harness_memory.coverage (workspace_id, publication_id, updated_at DESC);

-- Explicit per-table policies. Missing/empty transaction scope denies all rows. Every reference
-- includes both tenant keys; unique/FK checks cannot become a cross-tenant identifier oracle.
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['records','record_versions','stories','coverage','retention_refs','journal'] LOOP
    EXECUTE format('ALTER TABLE harness_memory.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE harness_memory.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('DROP POLICY IF EXISTS memory_scope ON harness_memory.%I', name);
    EXECUTE format('CREATE POLICY memory_scope ON harness_memory.%I TO harness_memory_runtime USING
      (workspace_id = nullif(current_setting(''harness.workspace_id'', true), '''')
       AND publication_id = nullif(current_setting(''harness.publication_id'', true), '''')
       AND nullif(current_setting(''harness.actor_id'', true), '''') IS NOT NULL)
      WITH CHECK
      (workspace_id = nullif(current_setting(''harness.workspace_id'', true), '''')
       AND publication_id = nullif(current_setting(''harness.publication_id'', true), '''')
       AND nullif(current_setting(''harness.actor_id'', true), '''') IS NOT NULL)', name);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA harness_memory FROM PUBLIC;
GRANT USAGE ON SCHEMA harness_memory TO harness_memory_runtime;
GRANT SELECT ON harness_memory.schema_migrations TO harness_memory_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_memory.records, harness_memory.stories, harness_memory.coverage TO harness_memory_runtime;
GRANT SELECT, INSERT ON harness_memory.record_versions TO harness_memory_runtime;
GRANT SELECT, INSERT, DELETE ON harness_memory.retention_refs, harness_memory.journal TO harness_memory_runtime;
-- No TRUNCATE, schema CREATE, trigger, ownership, role administration or journal UPDATE grant.
INSERT INTO harness_memory.schema_migrations(version, description) VALUES (1, 'Scoped memory and publication lifecycle') ON CONFLICT (version) DO NOTHING;
COMMIT;

-- Hosted acceptance still required: connect as the actual application login; prove two-tenant
-- SELECT/INSERT/UPDATE/DELETE isolation, missing-scope denial, concurrent reservation and revision
-- conflicts, rollback after a failed journal write, unknown-delivery preservation, deletion,
-- backup/restore and role/pool configuration. Local adapter fixtures do not establish these.
