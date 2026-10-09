# Team 4 Voice Labs discussion and decision log

This document records the user’s instructions, the main implementation decisions, review debate, and the precise point at which work stopped. It accompanies the [implementation journal](team-4-voice-labs-implementation-journal.md), which has the file inventory and verification ledger.

## Scope and attribution

The active handoff was `/Users/kartik/Desktop/personal/Platform/local/handoffs/team-4-voice-labs.md`, whose owner is Voice Labs. The user had previously identified themselves as the owner of Task 4, first requested codebase understanding and no changes, then authorized a fresh local worktree and code work for the Team 4 handoff. This discussion log therefore covers the Team 4 Voice Labs work.

No Task 1/Platform implementation files were edited in this worktree. Platform-owned contract findings are included because they affect Task 4 acceptance, but the Task 1 owner needs to perform the Platform-side implementation. The latest phrase “team 1 task” conflicts with the explicit earlier Task 4 ownership and Team 4 handoff; clarify that wording before anyone reassigns this log to Task 1.

## User instructions recorded

### Conversation timeline and how each instruction affected the work

1. **Codebase orientation:** The user asked for a broad understanding of TVIC, Earshot, Voice Labs, and Platform, including business and data flows, and pointed to root documentation. They authorized using as many subagents as useful. The task was to understand ownership boundaries and handoffs before changing code.
2. **Read-only clarification:** The user specifically pointed to `/Users/kartik/Desktop/personal/Platform/local/README.md` and said to read it, make no code changes, and understand the code first. This was the active constraint at that stage; it was not permission to begin implementation.
3. **Implementation authorization:** The user then requested a fresh worktree from `main`, an understandable branch name, local-only edits, and expressly forbade `git add`, `git commit`, and `git push`. They also asked for first-principles design and clear separation between application/business rules and database mechanics. They authorized real TVIC credentials from the existing environment for verification and requested a senior review/debate, a latency-oriented judge, and a red/blue review.
4. **Continuation and task source:** After asking to continue, the user supplied `/Users/kartik/Desktop/personal/Platform/local/handoffs/team-4-voice-labs.md` and asked to run the same review loops for that Team 4 work. The implementation described in the companion journal belongs to this handoff.
5. **Halt and documentation request:** The user then said to halt the entire task and make detailed documents covering work, code changes, rationale, agents, and discussions so another person could continue. This instruction immediately stopped implementation and review. It supersedes the earlier request to finish those loops; it does not undo the local changes already made.
6. **Scope wording discrepancy:** In the documentation request the user referred to “team 1,” although the preceding explicit task source and ownership were Team 4 / Voice Labs. The docs therefore document the work actually performed (Team 4) and clearly state that no Task 1 implementation was done. If the phrase meant another task, that separate scope has not been documented here.

The documentation task is the only active work after step 5. No additional code edits, tests, live provider calls, or reviewer rounds should be inferred from the existence of earlier authorizations.

### Initial codebase understanding request

The user asked for an end-to-end understanding of the TVIC, Earshot, Voice Labs, and Platform codebases, including data flow and business flow, using the root documentation and subagents as useful.

### Read-only stage

The user then named `/Users/kartik/Desktop/personal/Platform/local/README.md`, reiterated “do not code” and “do not make changes yet,” and said the code needed to be understood first. That read-only constraint applied to that earlier stage. The user later explicitly authorized local code changes, which superseded it for the subsequent Team 4 implementation.

### Worktree and code-quality constraints

The user requested a new worktree from `main`, an understandable community-facing branch name, and local-only changes. They explicitly prohibited `git add`, `git commit`, and `git push`. The branch used for this follow-up is `feat/project-scoped-lab`; at inspection it was based on `main` HEAD `1354a50`.

They emphasized first-principles reasoning and a clear filesystem/layering distinction: business behavior belongs in the application/domain layer, while storage mechanics belong in repository/database adapters. That drove the `LabRepository` port and adapter-specific persistence work.

### Testing and reviewer loop requested

The user explicitly allowed provider verification using real credentials available in TVIC main, prohibited fake credentials, and said cost was not a concern. The work used the existing TVIC `.env` process-locally and reported only credential-presence booleans and non-sensitive smoke metadata. No provider values, transcript, or audio were emitted.

The user requested a senior developer/open-source advocate debate, iterative code improvement, a distinguished latency-focused judge with a stated 98% correction target, and a final red/blue pass. For this follow-up, the senior review was run once and identified three findings. A regression test was added and the first valid issue was confirmed red; work then began on a correction. The user halted the code/review task before the correction could be tested or the reviewer loops could be repeated. No current-follow-up judge score or final red/blue approval exists.

### New task handoff and stop instruction

The next task source was `/Users/kartik/Desktop/personal/Platform/local/handoffs/team-4-voice-labs.md`. The user asked to run the same debate/judge loops for that task.

The latest instruction explicitly halted the implementation task and replaced the next action with detailed documentation of all work, discussions, changes, reasons, agents, and handoff state. This document and the implementation journal are that documentation. The prior code/review objective is paused by the user, not completed.

## Decisions and why

### Product decision ownership

The user clarified that product decisions are theirs and can be made later; they are not needed to continue the current technical work. Do not block implementation or review on these questions or answer them by inference. Continue from existing documented behavior and record temporary assumptions. Deferred choices include project purge behavior and user-facing retry text; what counts as complete Earshot deletion; idempotency receipt expiry; retention/privacy; configured quotas; auth contract policy; package name, license, and release route; managed-agent/tool acceptance; audio acceptance; evaluator requirements; and latency target semantics. Inspect technical facts from existing code and contracts directly. Keep secrets out of docs and chat.

| Decision | Reasoning / boundary |
|---|---|
| Use a separate `feat/project-scoped-lab` worktree/branch. | Keeps changes isolated from `main` and names the work in a way that is understandable in review. |
| Never stage, commit, or push. | Explicit user constraint. Local working tree remains reviewable; no Git publication occurred. |
| Do not invent a root license. | The handoff requires a product-owner-approved license. A license choice is a legal/product decision and cannot be inferred from engineering convenience. Docs correctly call the repository source-available pending approval. |
| Build an embeddable package separately from the runnable app. | Platform needs a feature component rather than a second global app shell. Separate Vite/type outputs and CSS scoping let the app remain private while the component has an eventual release path. |
| Do not publish the package or edit Platform’s dependency pin. | The license and registry namespace were not approved, and Platform owns its package/lockfile integration. The package was only packed and tested locally. |
| Treat JWT project claim as identity. | A user-controlled project header must not authorize data access. Platform signs the token; Voice Labs verifies issuer/audience/time/subject/project/scope and creates `ProjectContext` at the HTTP boundary. |
| Do not pass Platform JWT policy into TVIC. | Voice Labs owns API authorization and TVIC is an execution SDK. The runner receives an established project/user context but no bearer token or Platform access policy. |
| Scope all data by the verified project. | Voice Labs owns experiment/run/evaluation state. Repository methods use the trusted project ID, and hosted mode requires Postgres rather than a shared JSON file. |
| Store run-start acceptance receipts with queued rows. | Returning accepted IDs only after an atomic receipt+run write makes a lost 202 response safely replayable without launching duplicate provider work. |
| Pin experiment/scenario/variant revision IDs. | A run needs immutable inputs. Resolving “latest” again on retry or execution would change what a repeated accepted request means. |
| Keep evaluator unknown distinct from fail/pass. | Missing expected facts or an aborted runtime is not evidence of success; provider error/cancellation and evaluation outcome are separate. |
| Describe latency precisely. | The reported duration is executor wall-clock including runtime setup and excluding evaluation, database writes, and Earshot upload. A single provider smoke is not a request SLO or percentile benchmark. |
| Use a minimal Earshot reference ledger outside expiring run rows. | Run deletion/retention must not erase incident IDs Platform needs for a later project purge. The ledger stores endpoint/project/delivery state, never the key. |
| Keep deletion ownership with each service. | Voice Labs can delete its own rows and return linked IDs. Platform owns cross-service coordination; Earshot owns incident deletion. A Voice Labs receipt cannot claim Earshot deleted data. |
| Expose ambiguous ingest outcomes. | A request may commit upstream while the response is lost. `attempted` is distinct from `attached`; Earshot 404 for an absent ID is not a tombstone. |
| Stop once the user says halt. | The latest instruction supersedes ongoing code implementation, test iteration, and reviewer work. The remaining task is documentation and a clear handoff, not additional code. |

## Review and debate record

These preexisting agents were available and reused. Their completed outputs are summarized below; see the implementation journal for consequences and exact findings.

### Earshot review

`/root/earshot_review` inspected the Earshot API/storage contract. The reviewer confirmed single-incident DELETE only, idempotent 204 for known tombstones, 404 for unknown/other-project IDs without creating a tombstone, and no project-wide purge endpoint. Its report also described project API key scope and an Earshot deployment caveat: the project boundary is not necessarily a hostile multi-tenant boundary. This informed the Voice Labs receipt and Platform partial-deletion wording.

### TVIC review

`/root/tvic_review` inspected the pinned `voice-runtime@1.2.0` APIs and cancellation behavior. It found that TVIC supports cooperative `AbortSignal` and `agent.stop()`, but cleanup can fail or time out. It recommended tracking execution promises, stopping new admission, bounded grace, cancellation, terminal persistence, and protection against late worker updates. The implementation added a run AbortSignal, tracking/draining, explicit unconfirmed cancellation errors, and terminal-state protection in the repository.

### Voice Labs lifecycle review

`/root/voice_labs_review` agreed Platform should coordinate deletion while each service deletes its own records. It flagged two concrete requirements: retain a project-level Earshot reference ledger across run expiration/deletion; and account for an Earshot POST that can commit after an absent incident returned 404. It also recommended retaining run-start idempotency receipts beyond individual run retention. The reference ledger and `attempted`/`attached` receipt state were implemented. Receipt retention remained open and was independently flagged in the final senior review.

### Senior open-source review: first result

The senior developer/open-source advocate was asked to review the current full diff, challenge correctness, and be direct. The first result examined purge service-local state, Postgres fences, run locks, provider slots, evidence leases, idempotency retention, and package readiness.

The reviewer found:

1. **P1 multi-replica purge race.** Only one service instance’s AbortControllers and promises are drained. A second replica may continue a provider request or Earshot POST while the first purges rows and frees a global provider slot. The reviewer asked for durable cross-replica coordination plus two-worker tests.
2. **P2 unbounded receipts.** Accepted idempotency rows have `created_at` but no cleanup. Run artifacts expire; old receipts can keep returning IDs whose rows are gone. Define retention, prune, and document replay after expiry.
3. **P2 package publish readiness.** The feature package had `private:false` and public publish config before owner-approved license/namespace. Disable publication until approval or add the correct release metadata.

The reviewer did not edit files or run tests. Auth scope enforcement and shutdown draining were called sound in that pass.

### Cross-replica purge regression and partial response

To convert the purge concern into a concrete check, a test was added with two `LabService` instances sharing one `MemoryRepository`. Instance A holds an active run; instance B attempts project purge. The test failed red because B returned a `local_data_deleted` receipt and erased the state.

The next coding action began a fail-closed response: check persistent run/evidence leases and queued/running records; add the run lock to Postgres purge fencing; serialize local JSON lifecycle changes; translate a blocked purge to 409; and retry after remote work settles. This does not implement an immediate distributed cancellation broadcast. The user stopped the task before the code was tested and before asking the senior agent whether 409/retry satisfies the required bar. The exact status is recorded as unresolved, not as reviewer approval.

### Latency judge and red/blue review

The previous task record reports a judge score of 99/100 for an earlier implementation and explicitly qualifies it as static review rather than a measured 250 ms result. This is historical and does not cover the current follow-up changes. The latency judge did not return a new result in this stopped task. A new final red/blue review was not run.

## Outcomes from live verification

The only live provider execution used TVIC’s configured real Groq/Cartesia credentials loaded in process from `/Users/kartik/Desktop/personal/TVIC/.env`. The environment check printed a JSON map of booleans for expected variable presence and never printed their values.

The first smoke used the seed scenario’s 1,400 ms latency threshold. The call completed with provider trace and transcript data but measured 1,432 ms, so the run truthfully received `failed` on latency. No text of that transcript was printed.

The second smoke used one harmless scripted caller turn, no expected business-tool call, only guardrail/latency evaluators, and a 60,000 ms budget. It returned `passed`, a Groq/Cartesia provider trace, 1,341 ms executor duration, two transcript turns, a call ID, and zero failed smoke evaluators. No transcript content or credentials were printed. This was a small provider transport smoke, not a full customer acceptance flow, real STT/audio run, Earshot integration, saved Platform agent run, benchmark, or 250 ms request SLO.

## What the next reader should do first

1. Verify they are in `/Users/kartik/Desktop/personal/voice-labs-project-scoped-lab` on `feat/project-scoped-lab` and preserve the local-only/no-Git-write constraint.
2. Inspect current diff and this implementation journal’s “Current unverified purge changes” section. Do not assume tests cover the code now present.
3. Run typecheck and the newly added purge regression. It must pass before any further reviewer invitation.
4. Decide whether cross-replica purge should return 409/retry or actively signal/cancel remote workers. The reviewer requested durable coordination, not only process-local abort.
5. Define and implement receipt retention together with the browser’s saved-key expiration behavior.
6. Make the feature package unpublishable pending license/namespace approval.
7. Complete Postgres tests against a designated non-production DB, then rerun all build/package checks.
8. Resume the requested senior debate loop, then the latency judge, and finally separate red/blue risk review. Record exact scope and outcomes; do not recycle the old 99/100 score as a new result.
9. Update the Platform task/handoff status and ask the product owner for the specific license/namespace decision only after producing a concrete release candidate.

## User-directed continuation — 2026-09-30

The user resumed the task and clarified that local Platform integration is in
scope while public release remains deferred. This supersedes the earlier
decision not to modify Platform's package manifest: a local `file:` dependency
and Platform lockfile update are now explicitly required and completed. The
package stays private; no license was invented and no registry publication or
release pin occurred.

The user confirmed that overall project deletion remains partial until Earshot
formally accepts/releases its deletion contract and confirms deletion. A local
Earshot Task 3 candidate API is not the accepted Platform contract and is not
called. The Platform BFF excludes Voice Labs project purge while the
coordinator is missing. Voice Labs' local receipt is explicitly scoped to
Voice Labs-owned data.

Other confirmed constraints remain: preserve unbounded current run-start
receipts/replay without arbitrary expiry; do not infer retention/privacy policy
from the current 30-day setting or metadata-only Earshot bundle; preserve the
current implementation limits without product claims; keep `jti` unique but
do not impose one-time replay; keep managed-agent/tool acceptance deferred; use
the real TVIC environment process-locally for provider tests; and do not present
the observed executor duration as a 250 ms target.

The active-run purge regression, both full service test suites, typechecks, and
builds are passing at the recorded checkpoints. Real provider verification
covered scripted LLM/TTS and a successful audio STT/LLM/TTS retry. One initial
audio attempt failed with a remote hangup and remains part of the evidence. The
requested senior debate, judge threshold pass, and red/blue review have not yet
occurred; they are the next required review steps, not completed historical
results.

## User-directed optimization continuation — 2026-10-05

The user called out a remaining waste in run-status polling and asked for a
careful optimization pass. The audit found two related paths: run-detail status
checks had been hydrating experiment/catalog data to inspect the purge fence,
and experiment polling could reload complete recent runs and project bootstrap
on its timer. The implementation was narrowed to status projections and
project-fence existence checks. Platform's BFF forwards only the bounded
status-route query values.

During review, the senior developer found an additional edge in the new
experiment status query: if the visible recent page had no active row, the UI
effect still returned before making the request. This meant an active run
outside the page might not be discovered. The first note that said initial
reconciliation had landed was inaccurate; inspection showed the early-return
condition remained. The user was told this explicitly, and the gate was then
removed. Experiment entry now checks once regardless of visible active count,
and repeats after success only when the service reports active work. The
request URL helper used by the UI is covered with zero-visible-active and
active-ID cases. The Platform proxy fixture was aligned with the current
`{ runs, missingRunIds }` contract and now asserts the body is forwarded.

The correction passed the full Voice Labs suite (117/117, with all 15 Postgres
repository tests enabled), typecheck, web build, and feature build. Platform's
affected proxy tests passed 7/7; typecheck and build also passed. The previously
recorded Platform full suite was 90/90 with Postgres integration enabled. No
TVIC execution code changed, so provider smokes were not repeated. The senior
review requested a proxy-fixture contract correction; after it was made and
tested, the reviewer confirmed full concurrence. The exact-tree judge passed
at 99/100. Red/blue found no release-stopping security, privacy, or user-flow
issue and recorded three P3 notes: the current active-view cadence is 1.5
seconds, a run started by another client after polling stops needs refresh or
re-entry, and a future in-place project-switch flow must re-key or remount the
feature. The integration docs now state the cross-client refresh/re-entry
behavior. No 250 ms SLO is claimed, Earshot deletion remains partial pending
acceptance/confirmation. The disposable Postgres container was removed after
verification. No Git command was run.
