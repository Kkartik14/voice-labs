# Voice Labs

Voice Labs owns scenarios, immutable experiment revisions, runs, evaluations,
comparisons, and project-level scenario revision pins. TVIC executes voice runs. Earshot stores
metadata-only incident evidence when an experiment requests capture.

This checkout is currently source-available. A product-owner-approved license
has not been selected, so it is not described as open source.

## Local development

```bash
pnpm install
pnpm dev
```

The Vite UI runs at `http://127.0.0.1:4321`; the API runs at
`http://127.0.0.1:4320`. Local mode accepts API requests only from loopback and
uses the single-project JSON adapter. Select it explicitly with
`VOICE_LABS_AUTH_MODE=local`; otherwise startup requires hosted JWT
configuration. `VOICE_LABS_DATA_DIR` selects its data directory. Do not expose
local mode through a public reverse proxy.

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The CLI uses the same local project and data file:

```bash
pnpm lab status
pnpm lab run
```

## Hosted deployment

Set `VOICE_LABS_AUTH_MODE=jwt` and `VOICE_LABS_STORAGE=postgres`. The service
verifies Platform access tokens against `VOICE_LABS_AUTH_JWKS_URL`, issuer, and
the exact `voice-labs` audience. Each token must contain `sub`, authoritative
`project_id`, `jti`, a space-delimited `scope`, and `iat`/`exp` no more than five
minutes apart. Requests require `voice-labs:read` or `voice-labs:write`;
project purge also requires `voice-labs:project:delete`.
Every repository operation carries that verified project ID. The JSON adapter
is refused in JWT mode. See [the Platform integration contract](docs/platform-integration.md)
for routes, token claims, storage, and the embeddable Lab feature.

Production defaults to binding `0.0.0.0` so the Platform service can reach it;
place it behind a private network and TLS-terminating proxy. Platform's bounded
Lab summary route uses the same short-lived, project-scoped Platform JWT as the
other hosted API routes and requires a matching project header. A shared
`VOICE_LABS_SERVICE_TOKEN` is accepted only by the loopback local summary route.

Create the local template from `.env.example`; keep private settings in an
ignored `.env`. Provider credentials can remain in `TVIC_ROOT/.env` and be read
into the Voice Labs process by setting `VOICE_LABS_TVIC_ENABLED=1` and
`VOICE_LABS_LOAD_TVIC_ENV=1`. The loader does not copy or print secret values.
`tvic` mode calls real LLM/TTS providers with scripted input; `audio` mode also
calls real STT using a WAV fixture. Missing provider variables fail preflight
with their names. Provider responses that fail at runtime produce error runs.
Hosted Postgres limits deployments to four simultaneous provider executions and
100 provider-backed attempts per project in a rolling 24-hour window. Usage is
recorded separately from run artifacts, so deleting a run does not reset this
limit. Each project can retain up to 1,000 scenario, candidate, and experiment
revisions combined, with at most 8 MiB of catalog payloads. Further catalog
writes return `429` after either limit is reached.

Scenario pins retain a project-level pointer to an exact scenario revision for
review. They do not launch runs or represent executed regression coverage; runs
are created through experiments.

`POST /api/experiments/:experimentId/run` requires an `Idempotency-Key` header
and the immutable `revision_id` in its JSON body. Retrying that key and revision
returns the original accepted run IDs; reusing the key for a different revision
returns `409`. The UI stores the key before sending and replays an unconfirmed
request after a reload before it creates a new launch request.

On `SIGTERM` or `SIGINT`, Voice Labs stops admitting run starts, waits up to 25
seconds, then requests cancellation for remaining executions. TVIC receives an
`AbortSignal`; the service waits for runtime cleanup and persists completed,
cancelled, or error states before closing Postgres. If cancellation cleanup
cannot be confirmed, the run is stored as an error. Abrupt crashes continue to
use the stale-run recovery rule described in the integration contract.

Voice Labs’ TVIC tool harness has no connected business systems. It returns an
explicit failure instead of claiming the scenario’s expected state was changed.
Use a scenario without expected business-tool calls for a provider transport
smoke test. The TVIC provider trace records the runtime providers and configured
model/voice identifiers; deterministic mode is always labeled as a simulation.

Earshot capture is opt-in per experiment. Its API receives an immutable bundle
with metadata and explicit denials for transcript, audio, tool, model, identity,
diagnostic, and raw OTLP payloads. The run stores the Earshot bundle/session IDs
and digest when ingest succeeds. `EARSHOT_ENDPOINT` and, for project-scoped
deployments, `EARSHOT_API_KEY` are read server-side.

Run transcripts and tool arguments are stored in the configured Voice Labs
repository so run detail and exports work. The current implementation uses a
30-day default run-retention setting; this is not an approved retention policy.
`VOICE_LABS_RUN_RETENTION_DAYS` changes the configured window. A user can delete
one completed run through `DELETE /api/runs/:runId` or the run detail view after
any pending Earshot attachment is reconciled. Pending attachments are durable
outbox entries: Voice Labs retries the exact metadata-only bundle up to eight
times, one minute apart. The stable bundle ID makes an identical Earshot ingest
idempotent, including when Earshot committed a request but its response was
lost. Pending attachments are capped at 250 per project; new evidence-capturing
runs receive `429` while that backlog is full. After the retry budget is
exhausted, the run records evidence as unavailable and can be deleted. Earshot
incidents have their own retention and
deletion policy and are not removed by deleting a Voice Labs run. If a restart
leaves the Earshot sink unconfigured, pending entries still follow the same
retry budget; queued runs that never started are marked unavailable because no
execution result exists to attach.
`DELETE /api/projects/:projectId/purge` requires the dedicated
`voice-labs:project:delete` scope. Voice Labs stops work tracked by its own
process and returns an idempotent `status=local_data_deleted` receipt only
after the repository confirms there is no persistent active run or evidence
lease. If another worker is active, it returns retryable `409` and preserves
the project data. A successful receipt contains linked Earshot references and
does not claim Earshot deletion. `deliveryStatus=attempted` means Earshot may
have committed the ingest even if Voice Labs did not receive its response.
Platform does not expose this endpoint through its BFF while the cross-service
deletion coordinator is unimplemented. The accepted Earshot contract has no
project-wide deletion fence for an incident that has not arrived, so overall
project deletion remains partial until Earshot accepts and confirms the required
deletion behavior.

## Architecture

- `src/domain`: run, evaluator, project, and revision types and pure rules.
- `src/application`: project-aware orchestration, revision pinning, execution,
  evaluation, and evidence attachment.
- `src/adapters`: TVIC and Earshot clients, JSON/Postgres persistence, and the
  deterministic runner.
- `src/server`: Platform token verification, request validation, and HTTP routes.
- `src/web`: local development shell and an embeddable Platform feature.

Postgres stores immutable revision and run payloads in relational tables with
project-scoped keys and indexes. Hosted overview reads select only the latest
catalog revision; detail and run execution load the exact historical input
revisions pinned by an experiment. The JSON adapter is a single local project
and is not suitable for concurrent hosted service processes.
