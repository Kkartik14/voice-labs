import type { Pool, PoolClient } from "pg";
import { defaultEvaluators } from "../domain/evaluate.js";
import { earshotIncidentReferenceFromRun, mergeEarshotIncidentReferences, sortEarshotIncidentReferences } from "../domain/earshot-reference.js";
import { UNCONFIRMED_RUNTIME_CLEANUP_CODE } from "../domain/run-lifecycle.js";
import { MAX_CONCURRENT_PROVIDER_RUNS, MAX_EXPIRED_EVIDENCE_LEASES_CLEANED_PER_SWEEP, MAX_MAINTENANCE_RUN_BATCH, MAX_PROJECT_CATALOG_PAYLOAD_BYTES, MAX_PROJECT_CATALOG_REVISIONS } from "../domain/limits.js";
import type { AcceptedRunStart, EarshotIncidentReference, EvidenceReference, Experiment, ExperimentRevisionSummary, ExperimentRunStatusSnapshot, LabState, ProjectPurgeReceipt, RegressionEntry, RunArtifact, RunProgressSnapshot, RunStartRequestRecord, RunSummary, ScenarioRevision, VariantRevision } from "../domain/model.js";
import { emptyState, missingExperimentRunStatusIds, ProjectCatalogCapacityError, ProjectPurgedError, ProjectPurgeBlockedError, type ExperimentRunProgressWithProjectStatus, type LabRepository, type RepositoryReadOptions, type RunProgressWithProjectStatus, type RunQuery, type RunStartRequestClaim, type RunWithProjectStatus } from "./repository.js";

const schema = `
CREATE TABLE IF NOT EXISTS voice_labs_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voice_labs_scenarios (
  project_id text NOT NULL,
  scenario_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, scenario_id, revision)
);
CREATE INDEX IF NOT EXISTS voice_labs_scenarios_project_latest
  ON voice_labs_scenarios (project_id, scenario_id, revision DESC);

CREATE TABLE IF NOT EXISTS voice_labs_variants (
  project_id text NOT NULL,
  variant_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, variant_id, revision)
);
CREATE INDEX IF NOT EXISTS voice_labs_variants_project_latest
  ON voice_labs_variants (project_id, variant_id, revision DESC);

CREATE TABLE IF NOT EXISTS voice_labs_experiments (
  project_id text NOT NULL,
  experiment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  id text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, experiment_id, revision)
);
ALTER TABLE voice_labs_experiments ADD COLUMN IF NOT EXISTS name text;
UPDATE voice_labs_experiments SET name = payload->>'name' WHERE name IS NULL;
ALTER TABLE voice_labs_experiments ALTER COLUMN name SET NOT NULL;
CREATE INDEX IF NOT EXISTS voice_labs_experiments_project_latest
  ON voice_labs_experiments (project_id, experiment_id, revision DESC);

CREATE TABLE IF NOT EXISTS voice_labs_project_catalog_usage (
  project_id text PRIMARY KEY,
  revision_count integer NOT NULL CHECK (revision_count >= 0),
  payload_bytes bigint NOT NULL CHECK (payload_bytes >= 0)
);
DO $voice_labs_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM voice_labs_schema_migrations WHERE name = 'project_catalog_usage_v1') THEN
    INSERT INTO voice_labs_project_catalog_usage (project_id, revision_count, payload_bytes)
    SELECT project_id, count(*)::integer, sum(payload_bytes)::bigint
    FROM (
      SELECT project_id, octet_length(payload::text) AS payload_bytes FROM voice_labs_scenarios
      UNION ALL
      SELECT project_id, octet_length(payload::text) AS payload_bytes FROM voice_labs_variants
      UNION ALL
      SELECT project_id, octet_length(payload::text) AS payload_bytes FROM voice_labs_experiments
    ) AS catalog_revisions
    GROUP BY project_id
    ON CONFLICT (project_id) DO NOTHING;
    INSERT INTO voice_labs_schema_migrations (name) VALUES ('project_catalog_usage_v1');
  END IF;
END
$voice_labs_migration$;

CREATE TABLE IF NOT EXISTS voice_labs_runs (
  project_id text NOT NULL,
  experiment_id text NOT NULL,
  experiment_revision_id text NOT NULL,
  id text NOT NULL,
  started_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'unknown',
  payload jsonb NOT NULL,
  PRIMARY KEY (project_id, id)
);
ALTER TABLE voice_labs_runs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unknown';
DO $voice_labs_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM voice_labs_schema_migrations WHERE name = 'run_status_backfill_v1') THEN
    UPDATE voice_labs_runs
    SET status = payload->>'status'
    WHERE status = 'unknown' AND payload->>'status' IS NOT NULL;
    INSERT INTO voice_labs_schema_migrations (name) VALUES ('run_status_backfill_v1');
  END IF;
END
$voice_labs_migration$;
CREATE INDEX IF NOT EXISTS voice_labs_runs_project_experiment
  ON voice_labs_runs (project_id, experiment_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_labs_runs_project_revision
  ON voice_labs_runs (project_id, experiment_revision_id, started_at DESC);
CREATE INDEX IF NOT EXISTS voice_labs_runs_active_experiment
  ON voice_labs_runs (project_id, experiment_id, experiment_revision_id, started_at DESC, id COLLATE "C" DESC)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS voice_labs_runs_project_started_cursor
  ON voice_labs_runs (project_id, started_at DESC, id COLLATE "C" DESC);
DROP INDEX IF EXISTS voice_labs_runs_project_started;
CREATE INDEX IF NOT EXISTS voice_labs_runs_status_started
  ON voice_labs_runs (status, started_at);
CREATE INDEX IF NOT EXISTS voice_labs_runs_recovery_started
  ON voice_labs_runs (started_at, id COLLATE "C")
  WHERE status IN ('queued', 'running') OR payload->'evidence'->>'status' = 'pending';
CREATE INDEX IF NOT EXISTS voice_labs_runs_pending_evidence_started
  ON voice_labs_runs (started_at, id COLLATE "C")
  WHERE status NOT IN ('queued', 'running') AND payload->'evidence'->>'status' = 'pending';
CREATE INDEX IF NOT EXISTS voice_labs_runs_pending_evidence_project
  ON voice_labs_runs (project_id)
  WHERE payload->'evidence'->>'status' = 'pending';
CREATE INDEX IF NOT EXISTS voice_labs_runs_retention_started
  ON voice_labs_runs (started_at, id COLLATE "C")
  WHERE status NOT IN ('queued', 'running') AND COALESCE(payload->'evidence'->>'status', '') <> 'pending';
CREATE INDEX IF NOT EXISTS voice_labs_runs_provider_started
  ON voice_labs_runs (started_at, project_id, id)
  WHERE payload->>'mode' IN ('tvic', 'audio');
CREATE INDEX IF NOT EXISTS voice_labs_runs_runtime_cleanup_guard
  ON voice_labs_runs (project_id)
  WHERE payload->'error'->>'code' = 'cancellation_unconfirmed'
     OR (status = 'running' AND payload->>'mode' IN ('tvic', 'audio') AND payload ? 'startedAt');

CREATE TABLE IF NOT EXISTS voice_labs_evidence_retry_leases (
  project_id text NOT NULL,
  run_id text NOT NULL,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, run_id)
);
CREATE INDEX IF NOT EXISTS voice_labs_evidence_retry_leases_expiry
  ON voice_labs_evidence_retry_leases (expires_at);

CREATE TABLE IF NOT EXISTS voice_labs_provider_attempt_usage (
  project_id text NOT NULL,
  run_id text NOT NULL,
  queued_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, run_id)
);
CREATE INDEX IF NOT EXISTS voice_labs_provider_attempt_usage_project_queued
  ON voice_labs_provider_attempt_usage (project_id, queued_at);
CREATE INDEX IF NOT EXISTS voice_labs_provider_attempt_usage_retention
  ON voice_labs_provider_attempt_usage (queued_at, project_id, run_id);

CREATE TABLE IF NOT EXISTS voice_labs_run_start_requests (
  project_id text NOT NULL,
  request_key_hash text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('preparing', 'accepted')),
  owner_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  acceptance jsonb,
  PRIMARY KEY (project_id, request_key_hash),
  CHECK ((status = 'preparing' AND acceptance IS NULL) OR (status = 'accepted' AND acceptance IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS voice_labs_run_start_requests_preparing
  ON voice_labs_run_start_requests (lease_expires_at)
  WHERE status = 'preparing';

CREATE TABLE IF NOT EXISTS voice_labs_earshot_references (
  project_id text NOT NULL,
  incident_id text NOT NULL,
  endpoint text NOT NULL,
  upstream_project_id text NOT NULL DEFAULT '',
  delivery_status text NOT NULL CHECK (delivery_status IN ('attempted', 'attached')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, incident_id, endpoint, upstream_project_id)
);
ALTER TABLE voice_labs_earshot_references ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'attempted';
DO $voice_labs_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM voice_labs_schema_migrations WHERE name = 'earshot_reference_history_v1') THEN
    UPDATE voice_labs_earshot_references SET upstream_project_id = '' WHERE upstream_project_id IS NULL;
    ALTER TABLE voice_labs_earshot_references ALTER COLUMN upstream_project_id SET DEFAULT '';
    ALTER TABLE voice_labs_earshot_references ALTER COLUMN upstream_project_id SET NOT NULL;
    ALTER TABLE voice_labs_earshot_references
      DROP CONSTRAINT IF EXISTS voice_labs_earshot_references_pkey;
    ALTER TABLE voice_labs_earshot_references
      ADD CONSTRAINT voice_labs_earshot_references_pkey PRIMARY KEY (project_id, incident_id, endpoint, upstream_project_id);
    INSERT INTO voice_labs_earshot_references (
      project_id, incident_id, endpoint, upstream_project_id, delivery_status, created_at
    )
    SELECT DISTINCT ON (
      run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), '')
    )
      run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), ''),
      CASE WHEN run.payload->'evidence'->>'status' = 'attached' THEN 'attached' ELSE 'attempted' END,
      run.started_at
    FROM voice_labs_runs AS run
    WHERE NULLIF(run.payload->'evidence'->>'incidentId', '') IS NOT NULL
      AND NULLIF(run.payload->'evidence'->>'endpoint', '') IS NOT NULL
    ORDER BY run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), ''),
      (run.payload->'evidence'->>'status' = 'attached') DESC
    ON CONFLICT (project_id, incident_id, endpoint, upstream_project_id) DO UPDATE
    SET delivery_status = CASE WHEN voice_labs_earshot_references.delivery_status = 'attached' OR EXCLUDED.delivery_status = 'attached'
          THEN 'attached' ELSE 'attempted' END;
    INSERT INTO voice_labs_schema_migrations (name) VALUES ('earshot_reference_history_v1');
  END IF;
END
$voice_labs_migration$;

DO $voice_labs_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM voice_labs_schema_migrations WHERE name = 'earshot_reference_project_destination_v2') THEN
    UPDATE voice_labs_earshot_references SET upstream_project_id = '' WHERE upstream_project_id IS NULL;
    ALTER TABLE voice_labs_earshot_references ALTER COLUMN upstream_project_id SET DEFAULT '';
    ALTER TABLE voice_labs_earshot_references ALTER COLUMN upstream_project_id SET NOT NULL;
    ALTER TABLE voice_labs_earshot_references
      DROP CONSTRAINT IF EXISTS voice_labs_earshot_references_pkey;
    ALTER TABLE voice_labs_earshot_references
      ADD CONSTRAINT voice_labs_earshot_references_pkey PRIMARY KEY (project_id, incident_id, endpoint, upstream_project_id);
    INSERT INTO voice_labs_earshot_references (
      project_id, incident_id, endpoint, upstream_project_id, delivery_status, created_at
    )
    SELECT DISTINCT ON (
      run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), '')
    )
      run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), ''),
      CASE WHEN run.payload->'evidence'->>'status' = 'attached' THEN 'attached' ELSE 'attempted' END,
      run.started_at
    FROM voice_labs_runs AS run
    WHERE NULLIF(run.payload->'evidence'->>'incidentId', '') IS NOT NULL
      AND NULLIF(run.payload->'evidence'->>'endpoint', '') IS NOT NULL
    ORDER BY run.project_id,
      run.payload->'evidence'->>'incidentId',
      run.payload->'evidence'->>'endpoint',
      COALESCE(NULLIF(run.payload->'evidence'->>'upstreamProjectId', ''), ''),
      (run.payload->'evidence'->>'status' = 'attached') DESC
    ON CONFLICT (project_id, incident_id, endpoint, upstream_project_id) DO UPDATE
    SET delivery_status = CASE WHEN voice_labs_earshot_references.delivery_status = 'attached' OR EXCLUDED.delivery_status = 'attached'
          THEN 'attached' ELSE 'attempted' END;
    INSERT INTO voice_labs_schema_migrations (name) VALUES ('earshot_reference_project_destination_v2');
  END IF;
END
$voice_labs_migration$;

CREATE TABLE IF NOT EXISTS voice_labs_project_purge_receipts (
  project_id text PRIMARY KEY,
  receipt jsonb NOT NULL,
  completed_at timestamptz NOT NULL
);
DO $voice_labs_migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM voice_labs_schema_migrations WHERE name = 'provider_attempt_usage_v1') THEN
    INSERT INTO voice_labs_provider_attempt_usage (project_id, run_id, queued_at)
    SELECT project_id, id, COALESCE(NULLIF(payload->>'queuedAt', '')::timestamptz, started_at)
    FROM voice_labs_runs
    WHERE payload->>'mode' IN ('tvic', 'audio') AND started_at >= now() - interval '24 hours'
    ON CONFLICT (project_id, run_id) DO NOTHING;
    INSERT INTO voice_labs_schema_migrations (name) VALUES ('provider_attempt_usage_v1');
  END IF;
END
$voice_labs_migration$;

CREATE TABLE IF NOT EXISTS voice_labs_project_run_locks (
  project_id text PRIMARY KEY,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_labs_provider_run_slots (
  slot_id integer PRIMARY KEY,
  project_id text,
  owner_id text,
  expires_at timestamptz
);
INSERT INTO voice_labs_provider_run_slots (slot_id)
SELECT generate_series(1, ${MAX_CONCURRENT_PROVIDER_RUNS})
ON CONFLICT (slot_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS voice_labs_regression_entries (
  project_id text NOT NULL,
  scenario_id text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (project_id, scenario_id)
);

CREATE TABLE IF NOT EXISTS voice_labs_project_write_fences (
  project_id text PRIMARY KEY,
  purged boolean NOT NULL DEFAULT false
);

CREATE OR REPLACE FUNCTION voice_labs_reject_project_purged_write() RETURNS trigger AS $voice_labs_fence$
DECLARE project_is_purged boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Voice Labs records cannot move between projects' USING ERRCODE = '55000';
  END IF;
  INSERT INTO voice_labs_project_write_fences (project_id, purged)
  VALUES (NEW.project_id, false)
  ON CONFLICT (project_id) DO NOTHING;
  SELECT purged INTO project_is_purged
  FROM voice_labs_project_write_fences
  WHERE project_id = NEW.project_id
  FOR SHARE;
  IF project_is_purged THEN
    RAISE EXCEPTION 'This Voice Labs project has been purged' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$voice_labs_fence$ LANGUAGE plpgsql;

DO $voice_labs_fence_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'voice_labs_scenarios',
    'voice_labs_variants',
    'voice_labs_experiments',
    'voice_labs_project_catalog_usage',
    'voice_labs_runs',
    'voice_labs_evidence_retry_leases',
    'voice_labs_provider_attempt_usage',
    'voice_labs_run_start_requests',
    'voice_labs_earshot_references',
    'voice_labs_regression_entries',
    'voice_labs_project_run_locks'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass(table_name)
        AND tgname = table_name || '_purge_fence'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION voice_labs_reject_project_purged_write()',
        table_name || '_purge_fence', table_name
      );
    END IF;
  END LOOP;
END
$voice_labs_fence_triggers$;
`;

const upsertEarshotReferenceSql = `
  INSERT INTO voice_labs_earshot_references (project_id, incident_id, endpoint, upstream_project_id, delivery_status, created_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (project_id, incident_id, endpoint, upstream_project_id) DO UPDATE
  SET delivery_status = CASE WHEN voice_labs_earshot_references.delivery_status = 'attached' OR EXCLUDED.delivery_status = 'attached'
        THEN 'attached' ELSE 'attempted' END
`;

async function lockProjectWriteFence(client: PoolClient, projectId: string): Promise<void> {
  await client.query(
    `INSERT INTO voice_labs_project_write_fences (project_id, purged)
     VALUES ($1, false) ON CONFLICT (project_id) DO NOTHING`,
    [projectId],
  );
  const fence = await client.query<{ purged: boolean }>(
    "SELECT purged FROM voice_labs_project_write_fences WHERE project_id = $1 FOR SHARE",
    [projectId],
  );
  if (fence.rows[0]?.purged) throw new ProjectPurgedError();
}

async function writeEarshotReference(
  executor: Pool | PoolClient,
  projectId: string,
  reference: EarshotIncidentReference,
): Promise<void> {
  await executor.query(upsertEarshotReferenceSql, [
    projectId,
    reference.incidentId,
    reference.endpoint,
    reference.upstreamProjectId ?? "",
    reference.deliveryStatus,
  ]);
}

type PayloadRow<T> = { payload: T };

/** Hosted adapter: every read and write carries the authorized project key. */
export class PostgresRepository implements LabRepository {
  public constructor(private readonly pool: Pool) {}

  public async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7439915262::bigint)");
      await client.query(schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async isProjectPurged(projectId: string): Promise<boolean> {
    const result = await this.pool.query<{ purged: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM voice_labs_project_purge_receipts WHERE project_id = $1) AS purged",
      [projectId],
    );
    return result.rows[0]?.purged ?? false;
  }

  public async getProjectPurgeReceipt(projectId: string): Promise<ProjectPurgeReceipt | null> {
    const result = await this.pool.query<{ receipt: ProjectPurgeReceipt }>(
      "SELECT receipt FROM voice_labs_project_purge_receipts WHERE project_id = $1",
      [projectId],
    );
    return result.rows[0]?.receipt ?? null;
  }

  public async getRunWithProjectStatus(projectId: string, runId: string): Promise<RunWithProjectStatus> {
    const result = await this.pool.query<{
      run: RunArtifact | null;
      project_purged: boolean;
    }>(
      `SELECT run_row.payload AS run, purge_row.project_id IS NOT NULL AS project_purged
       FROM (SELECT $1::text AS project_id, $2::text AS run_id) AS requested
       LEFT JOIN voice_labs_project_purge_receipts AS purge_row
         ON purge_row.project_id = requested.project_id
       LEFT JOIN voice_labs_runs AS run_row
         ON run_row.project_id = requested.project_id AND run_row.id = requested.run_id`,
      [projectId, runId],
    );
    const row = result.rows[0];
    return {
      run: row?.run ?? undefined,
      projectPurged: row?.project_purged ?? false,
    };
  }

  public async getRunProgressWithProjectStatus(projectId: string, runId: string): Promise<RunProgressWithProjectStatus> {
    const result = await this.pool.query<{
      id: string | null;
      status: RunProgressSnapshot["status"] | null;
      evidence: RunProgressSnapshot["evidence"] | null;
      project_purged: boolean;
    }>(
      `SELECT run_row.id, run_row.status,
              CASE WHEN run_row.payload ? 'evidence' THEN
                jsonb_strip_nulls(jsonb_build_object(
                  'status', run_row.payload->'evidence'->>'status',
                  'sessionId', run_row.payload->'evidence'->>'sessionId',
                  'message', run_row.payload->'evidence'->>'message'
                ))
              END AS evidence,
              purge_row.project_id IS NOT NULL AS project_purged
       FROM (SELECT $1::text AS project_id, $2::text AS run_id) AS requested
       LEFT JOIN voice_labs_project_purge_receipts AS purge_row
         ON purge_row.project_id = requested.project_id
       LEFT JOIN voice_labs_runs AS run_row
         ON run_row.project_id = requested.project_id AND run_row.id = requested.run_id`,
      [projectId, runId],
    );
    const row = result.rows[0];
    return {
      progress: row?.id ? {
        id: row.id,
        ...(row.status !== null ? { status: row.status } : {}),
        ...(row.evidence ? { evidence: row.evidence } : {}),
      } : undefined,
      projectPurged: row?.project_purged ?? false,
    };
  }

  public async getExperimentRunProgressWithProjectStatus(
    projectId: string,
    experimentId: string,
    revisionId: string,
    limit: number,
    knownRunIds: readonly string[] = [],
  ): Promise<ExperimentRunProgressWithProjectStatus> {
    const result = await this.pool.query<{
      experiment_found: boolean;
      runs: ExperimentRunStatusSnapshot[];
      project_purged: boolean;
    }>(
      `SELECT experiment.id IS NOT NULL AS experiment_found,
              purge_row.project_id IS NOT NULL AS project_purged,
              COALESCE(progress.runs, '[]'::jsonb) AS runs
       FROM (SELECT $1::text AS project_id, $2::text AS experiment_id, $3::text AS revision_id,
                    $4::integer AS run_limit, $5::text[] AS known_run_ids) AS requested
       LEFT JOIN voice_labs_project_purge_receipts AS purge_row
         ON purge_row.project_id = requested.project_id
       LEFT JOIN voice_labs_experiments AS experiment
         ON experiment.project_id = requested.project_id
        AND experiment.experiment_id = requested.experiment_id
        AND experiment.id = requested.revision_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object('id', status_rows.id, 'status', status_rows.status)
                  ORDER BY status_rows.started_at DESC, status_rows.id COLLATE "C" DESC
                ) AS runs
         FROM (
           SELECT recent.id, recent.status, recent.started_at
           FROM (
             SELECT run_row.id, run_row.status, run_row.started_at
             FROM voice_labs_runs AS run_row
             WHERE run_row.project_id = requested.project_id
               AND run_row.experiment_id = requested.experiment_id
               AND run_row.experiment_revision_id = experiment.id
             ORDER BY run_row.started_at DESC, run_row.id COLLATE "C" DESC
             LIMIT requested.run_limit
           ) AS recent
           UNION
           SELECT active_run.id, active_run.status, active_run.started_at
           FROM voice_labs_runs AS active_run
           WHERE active_run.project_id = requested.project_id
             AND active_run.experiment_id = requested.experiment_id
             AND active_run.experiment_revision_id = experiment.id
             AND active_run.status IN ('queued', 'running')
           UNION
           SELECT known_run.id, known_run.status, known_run.started_at
           FROM voice_labs_runs AS known_run
           WHERE known_run.project_id = requested.project_id
             AND known_run.experiment_id = requested.experiment_id
             AND known_run.experiment_revision_id = experiment.id
             AND known_run.id = ANY(requested.known_run_ids)
         ) AS status_rows
       ) AS progress ON TRUE`,
      [projectId, experimentId, revisionId, limit, [...knownRunIds]],
    );
    const row = result.rows[0];
    const runs = row?.runs ?? [];
    return {
      experimentFound: row?.experiment_found ?? false,
      runs,
      missingRunIds: missingExperimentRunStatusIds(knownRunIds, runs),
      projectPurged: row?.project_purged ?? false,
    };
  }

  public async read(projectId: string, options?: RepositoryReadOptions): Promise<LabState> {
    const projectPurgeQuery = options?.includeProjectPurgeReceipt === false
      ? Promise.resolve({ rows: [] as { receipt: ProjectPurgeReceipt }[] })
      : this.pool.query<{ receipt: ProjectPurgeReceipt }>(
        "SELECT receipt FROM voice_labs_project_purge_receipts WHERE project_id = $1",
        [projectId],
      );
    if (options?.latestCatalogOnly && !options.experimentId && !options.experimentRevisionIds) {
      const [experiments, scenarios, variants, regressionSet] = await Promise.all([
        this.pool.query<PayloadRow<Experiment>>(
          "SELECT DISTINCT ON (experiment_id) payload FROM voice_labs_experiments WHERE project_id = $1 ORDER BY experiment_id, revision DESC",
          [projectId],
        ),
        this.pool.query<PayloadRow<ScenarioRevision>>(
          "SELECT DISTINCT ON (scenario_id) payload FROM voice_labs_scenarios WHERE project_id = $1 ORDER BY scenario_id, revision DESC",
          [projectId],
        ),
        this.pool.query<PayloadRow<VariantRevision>>(
          "SELECT DISTINCT ON (variant_id) payload FROM voice_labs_variants WHERE project_id = $1 ORDER BY variant_id, revision DESC",
          [projectId],
        ),
        options.includeRegressionSet
          ? this.pool.query<PayloadRow<RegressionEntry>>("SELECT payload FROM voice_labs_regression_entries WHERE project_id = $1", [projectId])
          : Promise.resolve({ rows: [] as PayloadRow<RegressionEntry>[] }),
      ]);
      return {
        ...emptyState(),
        scenarios: scenarios.rows.map((row) => row.payload),
        variants: variants.rows.map((row) => row.payload),
        evaluators: defaultEvaluators(),
        experiments: experiments.rows.map((row) => row.payload),
        runs: [],
        regressionSet: regressionSet.rows.map((row) => row.payload),
        projectPurge: (await projectPurgeQuery).rows[0]?.receipt ?? null,
      };
    }

    let experimentQuery: Promise<{ rows: PayloadRow<Experiment>[] }>;
    if (options?.experimentId) {
      experimentQuery = this.pool.query<PayloadRow<Experiment>>(
        `SELECT payload FROM voice_labs_experiments WHERE project_id = $1 AND experiment_id = $2
         ORDER BY revision DESC${options.latestExperimentOnly ? " LIMIT 1" : ""}`,
        [projectId, options.experimentId],
      );
    } else if (options?.experimentRevisionIds) {
      experimentQuery = options.experimentRevisionIds.length
        ? this.pool.query<PayloadRow<Experiment>>(
            "SELECT payload FROM voice_labs_experiments WHERE project_id = $1 AND id = ANY($2::text[])",
            [projectId, [...options.experimentRevisionIds]],
          )
        : Promise.resolve({ rows: [] });
    } else {
      experimentQuery = this.pool.query<PayloadRow<Experiment>>(
        "SELECT payload FROM voice_labs_experiments WHERE project_id = $1",
        [projectId],
      );
    }
    const experimentRows = await experimentQuery;
    const experiments = experimentRows.rows.map((row) => row.payload);
    const scenarioRevisionIds = [...new Set(experiments.flatMap((experiment) => experiment.scenarioRevisionIds))];
    const variantRevisionIds = [...new Set(experiments.flatMap((experiment) => experiment.variantRevisionIds))];
    const [scenarios, variants, regressionSet] = await Promise.all([
      options?.experimentId || options?.experimentRevisionIds
        ? scenarioRevisionIds.length
          ? this.pool.query<PayloadRow<ScenarioRevision>>("SELECT payload FROM voice_labs_scenarios WHERE project_id = $1 AND id = ANY($2::text[])", [projectId, scenarioRevisionIds])
          : Promise.resolve({ rows: [] })
        : this.pool.query<PayloadRow<ScenarioRevision>>("SELECT payload FROM voice_labs_scenarios WHERE project_id = $1", [projectId]),
      options?.experimentId || options?.experimentRevisionIds
        ? variantRevisionIds.length
          ? this.pool.query<PayloadRow<VariantRevision>>("SELECT payload FROM voice_labs_variants WHERE project_id = $1 AND id = ANY($2::text[])", [projectId, variantRevisionIds])
          : Promise.resolve({ rows: [] })
        : this.pool.query<PayloadRow<VariantRevision>>("SELECT payload FROM voice_labs_variants WHERE project_id = $1", [projectId]),
      (options?.includeRegressionSet ?? (!options?.latestCatalogOnly && !options?.experimentId && !options?.experimentRevisionIds))
        ? this.pool.query<PayloadRow<RegressionEntry>>("SELECT payload FROM voice_labs_regression_entries WHERE project_id = $1", [projectId])
        : Promise.resolve({ rows: [] }),
    ]);
    return {
      ...emptyState(),
      scenarios: scenarios.rows.map((row) => row.payload),
      variants: variants.rows.map((row) => row.payload),
      evaluators: defaultEvaluators(),
      experiments,
      runs: [],
      regressionSet: regressionSet.rows.map((row) => row.payload),
      projectPurge: (await projectPurgeQuery).rows[0]?.receipt ?? null,
    };
  }

  public async getScenarioRevision(projectId: string, scenarioId: string, revisionId?: string): Promise<ScenarioRevision | undefined> {
    const result = await this.pool.query<PayloadRow<ScenarioRevision>>(
      `SELECT payload FROM voice_labs_scenarios WHERE project_id = $1 AND scenario_id = $2${revisionId ? " AND id = $3" : ""}
       ORDER BY revision DESC LIMIT 1`,
      revisionId ? [projectId, scenarioId, revisionId] : [projectId, scenarioId],
    );
    return result.rows[0]?.payload;
  }

  public async listExperimentRevisionSummaries(projectId: string, experimentId: string): Promise<ExperimentRevisionSummary[]> {
    const result = await this.pool.query<ExperimentRevisionSummary>(
      `SELECT id, experiment_id AS "experimentId", revision, name, created_at::text AS "createdAt"
       FROM voice_labs_experiments WHERE project_id = $1 AND experiment_id = $2 ORDER BY revision ASC`,
      [projectId, experimentId],
    );
    return result.rows;
  }

  public async getExperimentRevisionSummary(projectId: string, experimentId: string, revisionId?: string): Promise<ExperimentRevisionSummary | undefined> {
    const result = await this.pool.query<ExperimentRevisionSummary>(
      `SELECT id, experiment_id AS "experimentId", revision, name, created_at::text AS "createdAt"
       FROM voice_labs_experiments WHERE project_id = $1 AND experiment_id = $2${revisionId ? " AND id = $3" : ""}
       ORDER BY revision DESC LIMIT 1`,
      revisionId ? [projectId, experimentId, revisionId] : [projectId, experimentId],
    );
    return result.rows[0];
  }

  public async listRuns(projectId: string, query: RunQuery = {}): Promise<RunArtifact[]> {
    const conditions = ["project_id = $1"];
    const parameters: Array<string | number> = [projectId];
    if (query.runId) {
      parameters.push(query.runId);
      conditions.push(`id = $${parameters.length}`);
    } else if (query.experimentRevisionId) {
      parameters.push(query.experimentRevisionId);
      conditions.push(`experiment_revision_id = $${parameters.length}`);
    }
    if (query.status) {
      parameters.push(query.status);
      conditions.push(`status = $${parameters.length}`);
    }
    if (query.before) {
      parameters.push(query.before.startedAt, query.before.id);
      conditions.push(`(started_at, id COLLATE "C") < ($${parameters.length - 1}, $${parameters.length} COLLATE "C")`);
    }
    const limit = query.limit === undefined ? "" : ` LIMIT $${parameters.push(query.limit)}`;
    const result = await this.pool.query<PayloadRow<RunArtifact>>(
      `SELECT payload FROM voice_labs_runs WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC, id COLLATE "C" DESC${limit}`,
      parameters,
    );
    return result.rows.map((row) => row.payload);
  }

  public async countPendingEvidence(projectId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM voice_labs_runs
       WHERE project_id = $1 AND payload->'evidence'->>'status' = 'pending'`,
      [projectId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async claimPendingEvidenceDue(cutoff: string, ownerId: string, leaseExpiresAt: string, limit: number): Promise<RunArtifact[]> {
    const threshold = Date.parse(cutoff);
    if (!Number.isFinite(threshold)) throw new Error("Evidence retry cutoff must be a valid timestamp.");
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Evidence retry limit must be a positive integer.");
    if (!ownerId.trim() || !Number.isFinite(Date.parse(leaseExpiresAt))) throw new Error("Evidence retry lease requires an owner and valid expiry.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `WITH expired AS (
           SELECT project_id, run_id
           FROM voice_labs_evidence_retry_leases
           WHERE expires_at <= $1::timestamptz
           ORDER BY expires_at, project_id, run_id
           LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM voice_labs_evidence_retry_leases AS lease
         USING expired
         WHERE lease.project_id = expired.project_id AND lease.run_id = expired.run_id`,
        [cutoff, MAX_EXPIRED_EVIDENCE_LEASES_CLEANED_PER_SWEEP],
      );
      const candidates = await client.query<{ project_id: string; id: string; payload: RunArtifact }>(
        `SELECT run.project_id, run.id, run.payload
         FROM voice_labs_runs AS run
         LEFT JOIN voice_labs_evidence_retry_leases AS lease
           ON lease.project_id = run.project_id AND lease.run_id = run.id
         WHERE run.status NOT IN ('queued', 'running')
           AND run.payload->'evidence'->>'status' = 'pending'
           AND (NULLIF(run.payload->'evidence'->>'retryAt', '') IS NULL
             OR (run.payload->'evidence'->>'retryAt')::timestamptz <= $1::timestamptz)
           AND (lease.run_id IS NULL OR lease.expires_at <= $1::timestamptz)
         ORDER BY run.started_at, run.id COLLATE "C"
         LIMIT $2 FOR UPDATE OF run SKIP LOCKED`,
        [cutoff, Math.min(limit, MAX_MAINTENANCE_RUN_BATCH)],
      );
      if (candidates.rows.length > 0) {
        await client.query(
          `INSERT INTO voice_labs_evidence_retry_leases (project_id, run_id, owner_id, expires_at)
           SELECT claim.project_id, claim.run_id, $3, $4
           FROM unnest($1::text[], $2::text[]) AS claim(project_id, run_id)
           ON CONFLICT (project_id, run_id) DO UPDATE
           SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at`,
          [candidates.rows.map((row) => row.project_id), candidates.rows.map((row) => row.id), ownerId, leaseExpiresAt],
        );
      }
      await client.query("COMMIT");
      return candidates.rows.map((row) => row.payload);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async releasePendingEvidenceClaim(projectId: string, runId: string, ownerId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM voice_labs_evidence_retry_leases WHERE project_id = $1 AND run_id = $2 AND owner_id = $3",
      [projectId, runId, ownerId],
    );
  }

  public async listRecentRunSummaries(projectId: string, limit: number, runId?: string): Promise<RunSummary[]> {
    const result = await this.pool.query<{
      id: string; experiment_id: string; experiment_revision_id: string; scenario_id: string;
      variant_id: string; repetition: number; run_started_at: string; duration_ms: number | null; status: RunArtifact["status"] | null;
      experiment_name: string | null; scenario_name: string | null; variant_name: string | null;
    }>(
      `SELECT run.id, run.experiment_id, run.experiment_revision_id,
              run.payload->>'scenarioId' AS scenario_id, run.payload->>'variantId' AS variant_id,
              (run.payload->>'repetition')::integer AS repetition,
              COALESCE(run.payload->>'startedAt', run.payload->>'queuedAt') AS run_started_at,
              NULLIF(run.payload->>'durationMs', '')::integer AS duration_ms,
              run.status,
              experiment.payload->>'name' AS experiment_name,
              scenario.payload->>'name' AS scenario_name,
              variant.payload->>'name' AS variant_name
       FROM voice_labs_runs AS run
       LEFT JOIN voice_labs_experiments AS experiment
         ON experiment.project_id = run.project_id AND experiment.id = run.experiment_revision_id
       LEFT JOIN voice_labs_scenarios AS scenario
         ON scenario.project_id = run.project_id AND scenario.id = run.payload->>'scenarioId'
       LEFT JOIN voice_labs_variants AS variant
         ON variant.project_id = run.project_id AND variant.id = run.payload->>'variantId'
       WHERE run.project_id = $1${runId ? " AND run.id = $3" : ""}
       ORDER BY run.started_at DESC, run.id COLLATE "C" DESC LIMIT $2`,
      runId ? [projectId, limit, runId] : [projectId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      experimentId: row.experiment_id,
      experimentRevisionId: row.experiment_revision_id,
      scenarioId: row.scenario_id,
      variantId: row.variant_id,
      repetition: row.repetition,
      startedAt: row.run_started_at,
      ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
      ...(row.status === null ? {} : { status: row.status }),
      ...(row.experiment_name === null ? {} : { experimentName: row.experiment_name }),
      ...(row.scenario_name === null ? {} : { scenarioName: row.scenario_name }),
      ...(row.variant_name === null ? {} : { variantName: row.variant_name }),
    }));
  }

  public async countProviderRunsSince(projectId: string, cutoff: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM voice_labs_provider_attempt_usage
       WHERE project_id = $1 AND queued_at >= $2`,
      [projectId, cutoff],
    );
    return result.rows[0]?.count ?? 0;
  }

  public async pruneProviderAttemptUsageBefore(cutoff: string): Promise<number> {
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT project_id, run_id FROM voice_labs_provider_attempt_usage
         WHERE queued_at < $1
         ORDER BY queued_at, project_id, run_id LIMIT $2
       )
       DELETE FROM voice_labs_provider_attempt_usage AS stored USING expired
       WHERE stored.project_id = expired.project_id AND stored.run_id = expired.run_id`,
      [cutoff, MAX_MAINTENANCE_RUN_BATCH],
    );
    return result.rowCount ?? 0;
  }

  public async acquireProjectRunLock(projectId: string, ownerId: string, expiresAt: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectWriteFence(client, projectId);
      const result = await client.query(
        `INSERT INTO voice_labs_project_run_locks (project_id, owner_id, expires_at)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM voice_labs_runs
           WHERE project_id = $1
             AND (
               payload->'error'->>'code' = '${UNCONFIRMED_RUNTIME_CLEANUP_CODE}'
               OR (
                 status = 'running'
                 AND payload->>'mode' IN ('tvic', 'audio')
                 AND payload ? 'startedAt'
                 AND NOT EXISTS (
                   SELECT 1 FROM voice_labs_project_run_locks AS active_lock
                   WHERE active_lock.project_id = voice_labs_runs.project_id
                     AND active_lock.expires_at > now()
                 )
               )
             )
         )
         ON CONFLICT (project_id) DO UPDATE
         SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at
         WHERE voice_labs_project_run_locks.expires_at <= now()
           AND NOT EXISTS (
           SELECT 1 FROM voice_labs_runs
           WHERE project_id = $1
               AND (
                 payload->'error'->>'code' = '${UNCONFIRMED_RUNTIME_CLEANUP_CODE}'
                 OR (
                   status = 'running'
                   AND payload->>'mode' IN ('tvic', 'audio')
                   AND payload ? 'startedAt'
                   AND NOT EXISTS (
                     SELECT 1 FROM voice_labs_project_run_locks AS active_lock
                     WHERE active_lock.project_id = voice_labs_runs.project_id
                       AND active_lock.expires_at > now()
                   )
                 )
               )
           )
         RETURNING project_id`,
        [projectId, ownerId, expiresAt],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async releaseProjectRunLock(projectId: string, ownerId: string): Promise<void> {
    await this.pool.query("DELETE FROM voice_labs_project_run_locks WHERE project_id = $1 AND owner_id = $2", [projectId, ownerId]);
  }

  public async acquireProviderRunSlot(projectId: string, ownerId: string, expiresAt: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7439915263::bigint)");
      await lockProjectWriteFence(client, projectId);
      const occupancy = await client.query<{ active_slots: number; unresolved_runs: number; stale_provider_runs: number }>(
        `SELECT
           (SELECT count(*)::integer FROM voice_labs_provider_run_slots
            WHERE project_id IS NOT NULL AND expires_at > now()) AS active_slots,
           (SELECT count(*)::integer FROM voice_labs_runs
            WHERE payload->>'mode' IN ('tvic', 'audio')
              AND payload->'error'->>'code' = '${UNCONFIRMED_RUNTIME_CLEANUP_CODE}') AS unresolved_runs,
           (SELECT count(DISTINCT uncertain.project_id)::integer FROM voice_labs_runs AS uncertain
            WHERE uncertain.status = 'running'
              AND uncertain.payload->>'mode' IN ('tvic', 'audio')
              AND uncertain.payload ? 'startedAt'
              AND COALESCE(uncertain.payload->'error'->>'code', '') <> '${UNCONFIRMED_RUNTIME_CLEANUP_CODE}'
              AND NOT EXISTS (
                SELECT 1 FROM voice_labs_project_run_locks AS active_lock
                WHERE active_lock.project_id = uncertain.project_id AND active_lock.expires_at > now()
              )
              AND NOT EXISTS (
                SELECT 1 FROM voice_labs_provider_run_slots AS active_slot
                WHERE active_slot.project_id = uncertain.project_id AND active_slot.expires_at > now()
              )) AS stale_provider_runs`,
      );
      const { active_slots: activeSlots, unresolved_runs: unresolvedRuns, stale_provider_runs: staleProviderRuns } = occupancy.rows[0];
      if (activeSlots + unresolvedRuns + staleProviderRuns >= MAX_CONCURRENT_PROVIDER_RUNS) {
        await client.query("COMMIT");
        return false;
      }
      const result = await client.query<{ slot_id: number }>(
        `WITH candidate AS (
           SELECT slot_id FROM voice_labs_provider_run_slots
           WHERE project_id IS NULL OR expires_at <= now()
           ORDER BY slot_id FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE voice_labs_provider_run_slots AS slot
         SET project_id = $1, owner_id = $2, expires_at = $3
         FROM candidate WHERE slot.slot_id = candidate.slot_id
         RETURNING slot.slot_id`,
        [projectId, ownerId, expiresAt],
      );
      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async releaseProviderRunSlot(projectId: string, ownerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE voice_labs_provider_run_slots SET project_id = NULL, owner_id = NULL, expires_at = NULL WHERE project_id = $1 AND owner_id = $2",
      [projectId, ownerId],
    );
  }

  public async addScenarioRevision(projectId: string, revision: ScenarioRevision): Promise<void> {
    this.#assertProject(projectId, revision.projectId);
    await this.#insertCatalogRevision(projectId, revision, (client, payload) => client.query(
      `INSERT INTO voice_labs_scenarios (project_id, scenario_id, revision, id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [projectId, revision.scenarioId, revision.revision, revision.id, payload, revision.createdAt],
    ));
  }

  public async addVariantRevision(projectId: string, revision: VariantRevision): Promise<void> {
    this.#assertProject(projectId, revision.projectId);
    await this.#insertCatalogRevision(projectId, revision, (client, payload) => client.query(
      `INSERT INTO voice_labs_variants (project_id, variant_id, revision, id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [projectId, revision.variantId, revision.revision, revision.id, payload, revision.createdAt],
    ));
  }

  public async addExperimentRevision(projectId: string, revision: Experiment): Promise<void> {
    this.#assertProject(projectId, revision.projectId);
    await this.#insertCatalogRevision(projectId, revision, (client, payload) => client.query(
      `INSERT INTO voice_labs_experiments (project_id, experiment_id, revision, id, name, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [projectId, revision.experimentId, revision.revision, revision.id, revision.name, payload, revision.createdAt],
    ));
  }

  public async appendRun(projectId: string, run: RunArtifact): Promise<void> {
    await this.appendRuns(projectId, [run]);
  }

  public async appendRuns(projectId: string, runs: readonly RunArtifact[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.#insertRuns(client, projectId, runs);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimRunStartRequest(projectId: string, record: RunStartRequestRecord, now: string): Promise<RunStartRequestClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO voice_labs_run_start_requests
           (project_id, request_key_hash, request_fingerprint, status, owner_id, lease_expires_at, created_at)
         VALUES ($1, $2, $3, 'preparing', $4, $5, $6)
         ON CONFLICT (project_id, request_key_hash) DO NOTHING
         RETURNING request_key_hash`,
        [projectId, record.requestKeyHash, record.requestFingerprint, record.ownerId, record.leaseExpiresAt, record.createdAt],
      );
      if (inserted.rowCount === 1) {
        await client.query("COMMIT");
        return { state: "claimed" };
      }

      const existing = await client.query<{
        request_fingerprint: string;
        status: "preparing" | "accepted";
        owner_id: string;
        lease_expires_at: string;
        acceptance: AcceptedRunStart | null;
      }>(
        `SELECT request_fingerprint, status, owner_id, lease_expires_at, acceptance
         FROM voice_labs_run_start_requests
         WHERE project_id = $1 AND request_key_hash = $2
         FOR UPDATE`,
        [projectId, record.requestKeyHash],
      );
      const row = existing.rows[0];
      if (!row || row.request_fingerprint !== record.requestFingerprint) {
        await client.query("COMMIT");
        return { state: "conflict" };
      }
      if (row.status === "accepted" && row.acceptance) {
        await client.query("COMMIT");
        return { state: "accepted", acceptance: row.acceptance };
      }
      if (Date.parse(row.lease_expires_at) <= Date.parse(now)) {
        await client.query(
          `UPDATE voice_labs_run_start_requests
           SET owner_id = $3, lease_expires_at = $4
           WHERE project_id = $1 AND request_key_hash = $2`,
          [projectId, record.requestKeyHash, record.ownerId, record.leaseExpiresAt],
        );
        await client.query("COMMIT");
        return { state: "claimed" };
      }
      await client.query("COMMIT");
      return { state: "pending", leaseExpiresAt: row.lease_expires_at };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeRunStartRequest(
    projectId: string,
    requestKeyHash: string,
    ownerId: string,
    acceptance: AcceptedRunStart,
    runs: readonly RunArtifact[],
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const completed = await client.query(
        `UPDATE voice_labs_run_start_requests
         SET status = 'accepted', acceptance = $4::jsonb
         WHERE project_id = $1 AND request_key_hash = $2 AND owner_id = $3 AND status = 'preparing'
         RETURNING request_key_hash`,
        [projectId, requestKeyHash, ownerId, JSON.stringify(acceptance)],
      );
      if (completed.rowCount !== 1) {
        await client.query("COMMIT");
        return false;
      }
      await this.#insertRuns(client, projectId, runs);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async releaseRunStartRequest(projectId: string, requestKeyHash: string, ownerId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM voice_labs_run_start_requests
       WHERE project_id = $1 AND request_key_hash = $2 AND owner_id = $3 AND status = 'preparing'`,
      [projectId, requestKeyHash, ownerId],
    );
  }

  public async recordEarshotReference(projectId: string, reference: EarshotIncidentReference): Promise<void> {
    await writeEarshotReference(this.pool, projectId, reference);
  }

  public async purgeProject(projectId: string, completedAt: string): Promise<ProjectPurgeReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [projectId]);
      const existing = await client.query<{ receipt: ProjectPurgeReceipt }>(
        "SELECT receipt FROM voice_labs_project_purge_receipts WHERE project_id = $1 FOR UPDATE",
        [projectId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return existing.rows[0].receipt;
      }
      await client.query(
        `INSERT INTO voice_labs_project_write_fences (project_id, purged)
         VALUES ($1, false) ON CONFLICT (project_id) DO NOTHING`,
        [projectId],
      );
      await client.query(
        "UPDATE voice_labs_project_write_fences SET purged = true WHERE project_id = $1",
        [projectId],
      );
      const activeWork = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM voice_labs_project_run_locks
           WHERE project_id = $1 AND expires_at > now()
           UNION ALL
           SELECT 1 FROM voice_labs_runs
           WHERE project_id = $1 AND status IN ('queued', 'running')
           UNION ALL
           SELECT 1 FROM voice_labs_evidence_retry_leases
           WHERE project_id = $1 AND expires_at > now()
           UNION ALL
           SELECT 1 FROM voice_labs_runs
           WHERE project_id = $1 AND payload->'error'->>'code' = $2
         ) AS active`,
        [projectId, UNCONFIRMED_RUNTIME_CLEANUP_CODE],
      );
      if (activeWork.rows[0]?.active) throw new ProjectPurgeBlockedError();
      const linked = await client.query<{
        incident_id: string;
        endpoint: string;
        upstream_project_id: string | null;
        delivery_status: string | null;
      }>(
        `SELECT incident_id, endpoint, upstream_project_id, delivery_status
         FROM voice_labs_earshot_references WHERE project_id = $1
         UNION
         SELECT payload->'evidence'->>'incidentId', payload->'evidence'->>'endpoint', payload->'evidence'->>'upstreamProjectId', payload->'evidence'->>'status'
         FROM voice_labs_runs
         WHERE project_id = $1 AND payload->'evidence'->>'incidentId' IS NOT NULL`,
        [projectId],
      );
      const linkedEarshotIncidents = sortEarshotIncidentReferences(mergeEarshotIncidentReferences(
        [],
        linked.rows.map((row) => row.incident_id && row.endpoint ? {
          incidentId: row.incident_id,
          endpoint: row.endpoint,
          deliveryStatus: row.delivery_status === "attached" ? "attached" : "attempted",
          ...(row.upstream_project_id ? { upstreamProjectId: row.upstream_project_id } : {}),
        } : undefined),
      ));
      const receipt: ProjectPurgeReceipt = {
        projectId,
        status: "local_data_deleted",
        linkedEarshotIncidents,
        completedAt,
      };

      await client.query(
        "INSERT INTO voice_labs_project_purge_receipts (project_id, receipt, completed_at) VALUES ($1, $2::jsonb, $3)",
        [projectId, JSON.stringify(receipt), completedAt],
      );
      await client.query("DELETE FROM voice_labs_scenarios WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_variants WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_experiments WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_runs WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_provider_attempt_usage WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_evidence_retry_leases WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_run_start_requests WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_project_run_locks WHERE project_id = $1", [projectId]);
      await client.query("UPDATE voice_labs_provider_run_slots SET project_id = NULL, owner_id = NULL, expires_at = NULL WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_regression_entries WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_project_catalog_usage WHERE project_id = $1", [projectId]);
      await client.query("DELETE FROM voice_labs_earshot_references WHERE project_id = $1", [projectId]);
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateRun(projectId: string, run: RunArtifact): Promise<void> {
    const result = await this.pool.query(
      `UPDATE voice_labs_runs
       SET experiment_id = $3, experiment_revision_id = $4, started_at = $5, status = $6, payload = $7::jsonb
       WHERE project_id = $1 AND id = $2
         AND (status IN ('queued', 'running') OR $6 IN ('queued', 'running') OR status = $6)`,
      [projectId, run.id, run.experimentId, run.experimentRevisionId, run.startedAt ?? run.queuedAt, run.status ?? "unknown", JSON.stringify(run)],
    );
    if (result.rowCount === 0) {
      const existing = await this.pool.query("SELECT 1 FROM voice_labs_runs WHERE project_id = $1 AND id = $2", [projectId, run.id]);
      if (existing.rowCount === 0) throw new Error(`Run not found: ${run.id}`);
    }
  }

  public async saveRunEvidence(projectId: string, runId: string, evidence: EvidenceReference): Promise<void> {
    const result = await this.pool.query(
      `UPDATE voice_labs_runs
       SET payload = jsonb_set(payload, '{evidence}', $3::jsonb, true)
       WHERE project_id = $1 AND id = $2`,
      [projectId, runId, JSON.stringify(evidence)],
    );
    if (result.rowCount === 0) throw new Error(`Run not found: ${runId}`);
  }

  public async savePendingRunEvidence(projectId: string, runId: string, evidence: EvidenceReference): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE voice_labs_runs
       SET payload = jsonb_set(payload, '{evidence}', $3::jsonb, true)
       WHERE project_id = $1 AND id = $2 AND payload->'evidence'->>'status' = 'pending'
         AND COALESCE(NULLIF(payload->'evidence'->>'attemptCount', '')::integer, 0) = $4`,
      [projectId, runId, JSON.stringify(evidence), evidence.attemptCount ?? 0],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async reservePendingEvidenceAttempt(projectId: string, runId: string, ownerId: string, expectedAttemptCount: number, evidence: EvidenceReference): Promise<boolean> {
    if (!Number.isInteger(expectedAttemptCount) || expectedAttemptCount < 0 || evidence.attemptCount !== expectedAttemptCount + 1) {
      throw new Error("Evidence retry reservation must increment the expected attempt count by one.");
    }
    const result = await this.pool.query(
      `UPDATE voice_labs_runs AS run
       SET payload = jsonb_set(run.payload, '{evidence}', $5::jsonb, true)
       WHERE run.project_id = $1 AND run.id = $2 AND run.payload->'evidence'->>'status' = 'pending'
         AND COALESCE(NULLIF(run.payload->'evidence'->>'attemptCount', '')::integer, 0) = $4
         AND EXISTS (
           SELECT 1 FROM voice_labs_evidence_retry_leases AS lease
           WHERE lease.project_id = run.project_id AND lease.run_id = run.id AND lease.owner_id = $3
         )`,
      [projectId, runId, ownerId, expectedAttemptCount, JSON.stringify(evidence)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async deleteRun(projectId: string, runId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectWriteFence(client, projectId);
      const result = await client.query<{ payload: RunArtifact }>(
        `DELETE FROM voice_labs_runs
         WHERE project_id = $1 AND id = $2
           AND status NOT IN ('queued', 'running')
           AND COALESCE(payload->'error'->>'code', '') <> $3
           AND COALESCE(payload->'evidence'->>'status', '') <> 'pending'
         RETURNING payload`,
        [projectId, runId, UNCONFIRMED_RUNTIME_CLEANUP_CODE],
      );
      const deletedRun = result.rows[0]?.payload;
      if (!deletedRun) {
        await client.query("COMMIT");
        return false;
      }
      const reference = earshotIncidentReferenceFromRun(deletedRun);
      if (reference) await writeEarshotReference(client, projectId, reference);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireStaleRunsBefore(cutoff: string, transition: (run: RunArtifact) => RunArtifact): Promise<number> {
    const candidates = await this.pool.query<{ project_id: string; payload: RunArtifact }>(
      `SELECT project_id, payload FROM voice_labs_runs
       WHERE status IN ('queued', 'running') AND started_at < $1
       ORDER BY started_at, id COLLATE "C" LIMIT $2`,
      [cutoff, MAX_MAINTENANCE_RUN_BATCH],
    );
    if (candidates.rows.length === 0) return 0;
    const parameters: unknown[] = [];
    const values = candidates.rows.map(({ project_id, payload }) => {
      const run = transition(payload);
      const offset = parameters.length;
      parameters.push(project_id, run.id, run.status ?? "error", JSON.stringify(run));
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb)`;
    });
    parameters.push(cutoff);
    const result = await this.pool.query(
      `UPDATE voice_labs_runs AS stored SET status = updates.status, payload = updates.payload
       FROM (VALUES ${values.join(", ")}) AS updates(project_id, id, status, payload)
       WHERE stored.project_id = updates.project_id AND stored.id = updates.id
         AND stored.status IN ('queued', 'running')
         AND stored.started_at < $${parameters.length}`,
      parameters,
    );
    return result.rowCount ?? 0;
  }

  public async pruneRunsBefore(cutoff: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates = await client.query<{ project_id: string }>(
        `SELECT project_id FROM (
           SELECT project_id FROM voice_labs_runs
           WHERE started_at < $1 AND status NOT IN ('queued', 'running')
             AND COALESCE(payload->'error'->>'code', '') <> $3
             AND COALESCE(payload->'evidence'->>'status', '') <> 'pending'
           ORDER BY started_at, id COLLATE "C" LIMIT $2
         ) AS expired_projects
         GROUP BY project_id ORDER BY project_id COLLATE "C"`,
        [cutoff, MAX_MAINTENANCE_RUN_BATCH, UNCONFIRMED_RUNTIME_CLEANUP_CODE],
      );
      const candidateProjectIds = candidates.rows.map((row) => row.project_id);
      if (candidateProjectIds.length === 0) {
        await client.query("COMMIT");
        return 0;
      }

      const writableProjectIds: string[] = [];
      for (const projectId of candidateProjectIds) {
        try {
          await lockProjectWriteFence(client, projectId);
          writableProjectIds.push(projectId);
        } catch (error) {
          if (!(error instanceof ProjectPurgedError)) throw error;
        }
      }
      if (writableProjectIds.length === 0) {
        await client.query("COMMIT");
        return 0;
      }

      const expired = await client.query<{ project_id: string; id: string; payload: RunArtifact }>(
        `SELECT project_id, id, payload FROM voice_labs_runs
         WHERE project_id = ANY($1::text[])
           AND started_at < $2 AND status NOT IN ('queued', 'running')
           AND COALESCE(payload->'error'->>'code', '') <> $4
           AND COALESCE(payload->'evidence'->>'status', '') <> 'pending'
         ORDER BY started_at, id COLLATE "C" LIMIT $3 FOR UPDATE`,
        [writableProjectIds, cutoff, MAX_MAINTENANCE_RUN_BATCH, UNCONFIRMED_RUNTIME_CLEANUP_CODE],
      );
      for (const row of expired.rows) {
        const reference = earshotIncidentReferenceFromRun(row.payload);
        if (reference) await writeEarshotReference(client, row.project_id, reference);
      }
      if (expired.rows.length === 0) {
        await client.query("COMMIT");
        return 0;
      }

      const result = await client.query(
        `DELETE FROM voice_labs_runs AS stored
         USING unnest($1::text[], $2::text[]) AS expired(project_id, id)
         WHERE stored.project_id = expired.project_id AND stored.id = expired.id
           AND stored.started_at < $3 AND stored.status NOT IN ('queued', 'running')
           AND COALESCE(stored.payload->'error'->>'code', '') <> $4
           AND COALESCE(stored.payload->'evidence'->>'status', '') <> 'pending'`,
        [expired.rows.map((row) => row.project_id), expired.rows.map((row) => row.id), cutoff, UNCONFIRMED_RUNTIME_CLEANUP_CODE],
      );
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async appendRegressionEntry(projectId: string, entry: RegressionEntry): Promise<void> {
    this.#assertProject(projectId, entry.projectId);
    await this.pool.query(
      `INSERT INTO voice_labs_regression_entries (project_id, scenario_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (project_id, scenario_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [projectId, entry.scenarioId, JSON.stringify(entry)],
    );
  }

  public async removeRegressionEntry(projectId: string, scenarioId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM voice_labs_regression_entries WHERE project_id = $1 AND scenario_id = $2",
      [projectId, scenarioId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async #insertRuns(client: PoolClient, projectId: string, runs: readonly RunArtifact[]): Promise<void> {
    for (const run of runs) this.#assertProject(projectId, run.projectId);
    if (runs.length === 0) return;
    await client.query(
      `WITH items AS (
         SELECT item, item->>'id' AS id
         FROM jsonb_array_elements($2::jsonb) AS source(item)
       ),
       inserted_runs AS (
         INSERT INTO voice_labs_runs (project_id, experiment_id, experiment_revision_id, id, started_at, status, payload)
         SELECT $1, item->>'experimentId', item->>'experimentRevisionId', id,
                COALESCE(NULLIF(item->>'startedAt', '')::timestamptz, NULLIF(item->>'queuedAt', '')::timestamptz),
                COALESCE(item->>'status', 'unknown'), item
         FROM items
         RETURNING id
       )
       INSERT INTO voice_labs_provider_attempt_usage (project_id, run_id, queued_at)
       SELECT $1, items.id,
              COALESCE(NULLIF(items.item->>'queuedAt', '')::timestamptz, NULLIF(items.item->>'startedAt', '')::timestamptz)
       FROM items JOIN inserted_runs USING (id)
       WHERE items.item->>'mode' IN ('tvic', 'audio')`,
      [projectId, JSON.stringify(runs)],
    );
  }

  #assertProject(requestProjectId: string, entityProjectId: string): void {
    if (requestProjectId !== entityProjectId) throw new Error("Project-scoped record does not match the authorized project.");
  }

  async #insertCatalogRevision<T extends ScenarioRevision | VariantRevision | Experiment>(
    projectId: string,
    revision: T,
    insert: (client: PoolClient, payload: string) => Promise<unknown>,
  ): Promise<void> {
    const client = await this.pool.connect();
    const payload = JSON.stringify(revision);
    try {
      await client.query("BEGIN");
      const reservation = await client.query(
        `INSERT INTO voice_labs_project_catalog_usage (project_id, revision_count, payload_bytes)
         SELECT $1, 1, octet_length($2::jsonb::text)
         WHERE octet_length($2::jsonb::text) <= $4
         ON CONFLICT (project_id) DO UPDATE
         SET revision_count = voice_labs_project_catalog_usage.revision_count + 1,
             payload_bytes = voice_labs_project_catalog_usage.payload_bytes + octet_length($2::jsonb::text)
         WHERE voice_labs_project_catalog_usage.revision_count < $3
           AND voice_labs_project_catalog_usage.payload_bytes + octet_length($2::jsonb::text) <= $4
         RETURNING project_id`,
        [projectId, payload, MAX_PROJECT_CATALOG_REVISIONS, MAX_PROJECT_CATALOG_PAYLOAD_BYTES],
      );
      if (reservation.rowCount !== 1) throw new ProjectCatalogCapacityError();
      await insert(client, payload);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
