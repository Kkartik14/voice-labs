# Platform integration contract

This is Voice Labs Task 4's downstream contract. Platform now mounts the feature
through an authenticated same-origin BFF and a local package link. Hosted release,
managed-agent acceptance, and cross-service deletion remain separate gates.

## Identity and project scope

Every `/api/*` route except `/api/health` requires:

```http
Authorization: Bearer <short-lived Platform access token>
```

The JWT must use RS256 or ES256 and validate against the configured Platform
JWKS URL, issuer, and audience. `sub` is the Platform user ID. `project_id` is
the authoritative project ID. Voice Labs does not trust a project ID supplied
by the browser. An optional `X-Platform-Project-Id` header is accepted only when
it exactly matches the verified claim. Missing or mismatched identity is
rejected before the application service runs.

Hosted tokens must carry a unique non-empty jti, a space-delimited scope, and
an exp no more than five minutes after iat. The aud claim must be the single
exact string voice-labs; an audience array containing extra services is
rejected. Voice Labs checks voice-labs:read on reads, voice-labs:write on other
API operations, and the dedicated voice-labs:project:delete scope for project
purge. Platform must mint the least-privilege scope required by each proxied
operation. Voice Labs requires jti but does not enforce one-time token replay
prevention. Scopes stay outside ProjectContext and are never passed to TVIC.

Configure `VOICE_LABS_ALLOWED_ORIGINS` with exact origins. There is no wildcard
CORS. Local mode must be selected explicitly, has a fixed local user/project,
accepts loopback callers only, uses JSON, and is disabled in production. JWT is
the default when auth mode is unset, including on loopback, so reverse proxies
cannot silently inherit local authentication. Hosted JWT mode requires Postgres.
Every persisted record has a project ID; queries include that ID in their
predicates or keys.

## API routes

All routes use JSON and return `Cache-Control: no-store` for API responses.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | Project ID, latest scenarios/candidates/experiments, evaluators, and 24 recent run summaries (no transcript or tool payload) |
| `GET` | `/api/scenarios`, `/api/variants`, `/api/experiments` | List project resources |
| `POST` | `/api/scenarios`, `/api/variants`, `/api/experiments` | Create immutable revisions/resources |
| `PUT` | `/api/scenarios/:scenarioId`, `/api/variants/:variantId`, `/api/experiments/:experimentId` | Create a new immutable revision from supplied fields |
| `GET` | `/api/experiments/:experimentId[?revision_id=...]` | Latest or selected immutable revision, pinned inputs, newest 50 runs, and revision history |
| `GET` | `/api/experiments/:experimentId/run-status?revision_id=...&run_id=...` | Status-only rows for the newest 50 runs, all active runs, and supplied known run IDs; repeated `run_id` values are allowed up to the active-run batch bound |
| `GET` | `/api/experiments/:experimentId/runs?before_started_at=...&before_id=...&revision_id=...` | Load the next 50 runs using the returned cursor and pinned experiment revision |
| `GET` | `/api/experiments/:experimentId/export[?revision_id=...]` | JSON export of the selected revision's newest 500 runs; `runsTruncated` indicates a larger history |
| `POST` | `/api/experiments/:experimentId/run` | Persist attempts, return `202` with `status=queued` and run IDs, then execute in the background |
| `GET` | `/api/runs/:runId` | Read one project-scoped run |
| `GET` | `/api/runs/:runId/status` | Read only run status and Earshot evidence delivery status for one run |
| `DELETE` | `/api/runs/:runId` | Delete one completed project-scoped run after pending evidence attachment finishes |
| `POST` | `/api/scenarios/:scenarioId/promote` | Pin the selected or latest scenario revision for project-level review |
| `DELETE` | `/api/scenarios/:scenarioId/promote` | Remove a scenario revision pin |
| `DELETE` | `/api/projects/:projectId/purge` | Delete Voice Labs-owned project records and return linked Earshot references for Platform's coordinator |
| `GET` | `/v1/platform/projects/:projectId/lab/summary` | Bounded Platform summary; requires a project-scoped Platform JWT and matching project header |

An experiment has a stable `experimentId` and an immutable revision `id`. A run
stores the stable experiment ID plus its exact experiment, scenario, and
candidate revision IDs. Updating source scenarios does not silently change an
existing experiment. A new experiment revision pins the latest selected inputs.
The detail screen can select earlier experiment revisions and inspect their
own runs; historical revisions are read-only. Comparison totals describe the
currently loaded run pages, and the detail screen offers keyset pagination to
load older pages. Bootstrap and overview health use the 24 most recent project
runs, while experiment-card counts use that same recent summary window.

The scenario pin list stores one exact revision per logical scenario so the
team can review which cases it wants to preserve. These pins are metadata only;
they do not create or run an experiment. Runs still require an experiment that
selects the scenario revisions.

The run endpoint is asynchronous so provider calls cannot outlive a Platform
proxy request and leave users with a misleading HTTP timeout. Attempt rows are
inserted together as `queued`; each attempt becomes `running` and receives its
runtime start timestamp when its executor begins. Hosted Postgres deployments
allow up to four simultaneous provider-backed executions across replicas and
return `503` when all provider slots are occupied. Each project is also limited
to 100 provider-backed attempts in a rolling 24-hour window; usage lives in a
separate ledger, so deleting run artifacts does not reset the quota. An
experiment that would exceed the quota returns `429`. Deterministic runs do not
use provider slots or the provider quota. Each project can store at most 1,000
scenario, candidate, and experiment revisions combined, with an 8 MiB total
catalog-payload budget; writes beyond either cap return `429`. This bounds
provider sessions and attempts; it is not a measured 250 ms request SLO.
On experiment entry, the feature performs one status reconciliation even if
the visible recent page has no active run. It continues polling while the
status response reports active work and sends each cached active ID as a
repeated `run_id` query value. The response contains `{ runs, missingRunIds }`:
`runs` includes the newest 50 statuses, every currently active run, and any
supplied ID that still belongs to the pinned revision; `missingRunIds`
explicitly lists supplied IDs that no longer exist there. This preserves an old
run that has just become terminal outside the newest-50 window while still
letting the UI remove a confirmed deletion. The service caps known IDs at the
existing eight-cell run guardrail. The feature fetches full run artifacts after
a status becomes terminal; it also fetches one full artifact when status
reconciliation discovers an active run outside the recent detail page so the
UI can render it. Experiment detail reloads only when a new run appears. When
the response reports no active work, the experiment view stops background
polling; a run started later by another tab or client appears after refresh or
re-entry. The one-run screen uses
the run status route, which joins the keyed run lookup with the project purge
fence. Its evidence projection includes only delivery status, session ID, and
message; it does not repeat the source label or destination URL. Neither poll
hydrates the project catalog or retransmits transcripts, audio, evaluation
details, or tool arguments. Returning to overview triggers a normal bootstrap
refresh. The browser stops polling after a 404 or 410 response so it does not
retry a missing run or purged project indefinitely; transient errors remain
retryable. The newest-50 status window and current 1.5-second browser interval
are implementation settings, not approved product policy or a latency target.

Run start requires an Idempotency-Key header and a JSON body containing the
pinned revision_id. The key is hashed before persistence and scoped by project.
The accepted receipt and all queued run rows are committed together; a retry
with the same revision returns the original run IDs, while reusing the key for
a different revision returns 409. Preparing requests use a lease so a crashed
preparer can be reclaimed. The embedded UI persists a key before sending and
replays it after reload when the response could not be confirmed.

On normal SIGTERM or SIGINT, Voice Labs stops new run starts, waits 25 seconds,
requests cancellation for remaining work through TVIC's AbortSignal, and waits
for runtime cleanup plus terminal-state persistence before closing Postgres.
Completed attempts retain results; confirmed cancellations become `cancelled`;
unconfirmed cleanup becomes `error`. An abrupt worker interruption leaves
durable `queued` or `running` attempt rows. Stale started TVIC/audio rows become
`cancellation_unconfirmed`, because Voice Labs cannot establish whether a
remote runtime stopped; deterministic rows and attempts that never started use
`run_abandoned`. Same-project admission checks stale provider rows even before
the recovery sweep runs, and global provider capacity counts them after their
worker leases expire. Recovery preserves the cleanup marker. The marker blocks
run deletion, retention pruning, and project purge. Voice Labs has no automated
reconciliation path, so affected projects remain blocked until the service
owner establishes a safe resolution. Accepted provider work is never replayed
after a process crash.

A terminal run with pending Earshot evidence remains in the durable outbox and
is retried after restart. Voice Labs retries the exact metadata-only bundle up
to eight times, at least one minute apart. Its stable bundle ID lets Earshot
return the original incident on an identical retry, including when the first
response was lost after ingest. Once all attempts fail, Voice Labs records
`evidence.status=unavailable`, and the run can be deleted. If the sink is
unconfigured after a restart, pending entries still advance through the same
retry budget. An abandoned queued run with no `startedAt` becomes unavailable
during recovery because there is no result to attach. Each project is limited
to 250 pending attachments; further evidence-capturing runs return `429` until
delivery clears the backlog.

The Earshot sink rejects redirects, limits response bodies to 16 KiB, and
keeps its 10-second request timeout and caller cancellation active until the
bounded response is parsed. It cancels non-success response bodies before
returning an ingest error. These values describe the current implementation,
not an approved product contract.

## Embeddable Lab UI

Platform renders the owned Lab feature without Voice Labs' local sidebar or
user/workspace chrome. Build the package export with `pnpm build:feature`. Its
default export contains only the embeddable UI, and React/React DOM are peer
dependencies. The package remains private while its namespace and license are
provisional.

```tsx
import { VoiceLabsFeature } from "@voice-labs/feature";
import "@voice-labs/feature/styles.css";

<VoiceLabsFeature apiBaseUrl="/api/voice-labs" />
```

Platform's catch-all BFF derives the signed-in project from the server session,
allows only the routes used by the feature, and mints a two-minute read or write
JWT for each request. It forwards neither browser cookies nor browser-supplied
bearer tokens. The BFF does not expose project purge; cross-service deletion
must use the Platform coordinator after its downstream contract is accepted.
Standalone hosts may provide `apiBaseUrl` and a short-lived `accessToken` when
they call the Voice Labs API directly.
The feature reads `?runId=...` on its same-origin URL or accepts an
`initialRunId` prop to open the run selected by a Platform-owned link. A
Platform link to a historical run should preserve that run ID in the URL or
prop after the host route mounts the feature.
The feature does not accept a browser-selected project ID. The feature stylesheet scopes its selectors below
`.voice-labs-feature` and uses Platform's `--canvas`, `--surface`,
`--surface-subtle`, `--border`, `--ink`, `--ink-secondary`, `--ink-muted`,
`--brand`, `--good`, `--warn`, and `--bad` tokens, with local fallbacks for
development. Platform remains responsible for the outer shell, navigation,
account, and project selection.

For local development from sibling checkouts, build with
`pnpm --dir ../voice-labs-project-scoped-lab build:feature`. Platform consumes
`../voice-labs-project-scoped-lab/packages/feature` through a local `file:`
dependency recorded in Platform's lockfile. This is a local integration link,
not a public release or deployment pin. Do not publish until the package name
and license are approved.

The Evidence link opens `/observe?sessionId=<session_id>`, matching the
Platform Observe page's current query contract. Task 3 still needs to verify
that the deployed Observe API resolves this session identifier to the linked
Earshot evidence.

The required hosted contract for
`GET /v1/platform/projects/{project_id}/lab/summary` is a short-lived,
project-scoped Platform JWT as the bearer token plus the same
`X-Platform-Project-Id`; Voice Labs verifies the JWT project claim against
both the route and header. The response contains at most 50 items with run ID,
experiment/scenario title, status, timestamp, and a same-origin
`/lab?runId=...` link. It never includes transcript, evaluation evidence, or
tool arguments. In loopback local mode only, the route can use the optional
`VOICE_LABS_SERVICE_TOKEN`.

**Local integration status (2026-09-30):** Platform now mints a short-lived
project-scoped read JWT for its server-owned Lab summary route, and its mounted
feature BFF mints read/write JWTs per API request. The former static hosted
service-token mismatch is resolved in the local checkouts. Same-user/project
hosted acceptance has not been run, so this is not deployment evidence. The
optional `VOICE_LABS_SERVICE_TOKEN` remains limited to the loopback local
summary route; Voice Labs must not treat a project header as identity or accept
a global service token in hosted mode.

Audio fixtures are provisioned on the Voice Labs host, not uploaded by the
browser. Set `VOICE_LABS_AUDIO_ROOT`; place each project's files under a folder
named with the lowercase SHA-256 hex digest of its Platform project ID. Scenario
fixture paths are relative to that folder. Each path must resolve to a regular
file of at most 1 MiB containing mono, 16 kHz, 16-bit uncompressed PCM WAV, and
audio mode requires exactly one fixture for each caller turn. Symlink escapes
and paths outside the project folder are rejected.

## Run states and measurement

Run status is derived from the executor result and evaluator evidence:

- `passed`: all configured evaluator checks passed.
- `failed`: at least one evaluator failed.
- `unknown`: one or more evaluator results cannot be determined.
- `error`: TVIC could not complete execution; evaluator evidence is unknown.
- `cancelled`: execution was explicitly cancelled.
- `queued`: the attempt is persisted and waiting for its turn in the experiment.
- `running`: the executor has started this attempt. Runs left queued or running
  after a worker exits are marked as errors after the 30-minute run lease expires.

Deterministic runs are simulations. TVIC transcript mode reports real LLM/TTS
with scripted input; audio mode reports real STT/LLM/TTS. The current Voice Labs
tool harness has no real customer business tools, so it refuses tool effects
and returns no expected facts. Evaluator names and reasons are persisted per
run; missing outcome/tool evidence fails or reports unknown according to the
configured expectation.

`durationMs` is executor wall-clock time, from runtime setup through the final
runtime event. It includes provider setup and execution. It excludes evaluation,
database writes, and Earshot upload. `firstResponseMs` measures the first agent
output from executor start when TVIC reports one. It is not a turn-level
latency percentile.

## Earshot evidence

When `captureEvidence` is true, Voice Labs posts a JSON bundle to
`EARSHOT_ENDPOINT` (with `/v1/incidents` appended when omitted). It uses the
server-side project mapping and asserts
`X-Earshot-Project-Id: <mapped Earshot project ID>`. Hosted deployments set
`EARSHOT_PROJECT_MAPPINGS` to a JSON object keyed by the verified Platform
project ID; each entry has an `earshotProjectId` and its own `apiKey`. A local
single-project deployment can set `EARSHOT_PROJECT_ID`, `EARSHOT_API_KEY`, and
optionally `EARSHOT_PLATFORM_PROJECT_ID` (which defaults to `local` in local
auth mode). Hosted mappings must use a distinct Earshot project ID for each
Platform project; aliases are rejected at startup. The bundle ID is
deterministically derived from the Voice Labs run ID, and its session ID is the
TVIC session ID when available. The run stores
Earshot's bundle ID, session ID, digest, and API endpoint. A pending attachment
is a durable outbox entry; exact retries reuse the same bundle ID and metadata.
After eight unsuccessful attempts, evidence is recorded as `unavailable`; the
completed run remains available for inspection or deletion.

Capture is metadata-only. Transcript, audio, tool arguments, model text,
identity, diagnostics, and raw OTLP are explicitly denied and absent from the
incident. A project without capture requested has no evidence reference and is
shown as “No evidence requested.”

The current implementation stores run artifacts that can include transcripts
and tool arguments, with a 30-day default run-retention setting adjustable by
`VOICE_LABS_RUN_RETENTION_DAYS`. This is an implementation default, not an
approved retention policy. Active runs, runs with pending Earshot delivery, and
runs with unconfirmed TVIC cleanup are excluded from run pruning and can remain
beyond that configured window. Users can delete a Voice Labs run with
`DELETE /api/runs/:runId` or from its detail view. That does not delete the
linked Earshot incident; Earshot owns its evidence and retention state.

### Project deletion

Voice Labs exposes `DELETE /api/projects/:projectId/purge` to a caller with the
exact `voice-labs:project:delete` scope. It stops locally tracked work, refuses
to purge while persistent run/evidence work is active, deletes Voice Labs-owned
catalog/run/quota/retry data, and keeps an idempotent receipt. The receipt says
`local_data_deleted` and lists linked Earshot references; it does not say
Earshot deleted them. Platform's BFF does not expose this route because its
cross-service deletion coordinator is not implemented.

The Earshot reference ledger is keyed by incident ID, destination endpoint, and
Earshot project ID so a mapping change cannot overwrite an older destination.
Its Postgres migration backfills references from surviving run payloads, and
run deletion/retention pruning records references before removing those
payloads. This preserves known destinations for a later owner-coordinated
purge. The migration cannot recover destinations already lost by an earlier
same-key overwrite followed by run deletion/pruning, and it does not rewrite
receipts for projects already purged. Reconcile those historical cases with
the owning service before treating a future purge receipt as complete.

Postgres run-retention pruning also writes references from each expired run
before deleting its row, under the same transaction and project write fence.
The Earshot sink rejects redirects; a redirect error follows the ordinary
pending/retry path instead of forwarding project and credential headers.

The reference-history and project-destination migrations change the reference
table's primary key and are not compatible with a mixed-version rolling
deployment: old instances still upsert by the previous key. Drain all
pre-migration Voice Labs instances before starting a version that applies these
migrations. A zero-downtime rollout would require an expand/contract migration
and compatible intermediate code. This schema change is forward-only: after it
has run, do not resume a pre-migration binary against the migrated database,
because its old conflict target no longer has a matching unique key and ledger
writes can fail. Prefer a forward fix. Recovery to the old binary requires
stopping every writer and restoring a verified backup taken before migration;
that restore discards database writes made after the backup unless they are
recovered separately. Keep traffic stopped until the compatible binary and
schema are verified.

Platform remains the cross-service deletion coordinator. The accepted Earshot
contract does not provide a project-wide purge or tombstone for an incident
that has not arrived; a local candidate API is not accepted or released for
Platform use. `deliveryStatus=attempted` means ingest may have committed even
when Voice Labs did not receive its response. Keep overall project deletion
partial until Earshot confirms its linked records are deleted under an accepted
contract; the final deletion promise remains deferred.

## Current cross-task dependencies

Task 2's published `voice-runtime@1.2.0` package is used. Platform's local Lab
feature and BFF are mounted, but a same-user/project hosted acceptance run is
still pending. The current TVIC executor creates a run agent from the pinned Voice Labs candidate
instructions and process-configured provider settings. It does not resolve or
reuse Platform's saved managed TVIC agent ID/configuration. Task 1/2 must provide
a trusted shared-agent execution contract before Task 4 can meet the “same
managed agent as the browser call” acceptance criterion. The final integration
run also needs the same non-production Platform project, TVIC agent
configuration, and Earshot project key.
