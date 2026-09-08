# Scriberr Sidecar — Phase 1 Architecture

## Purpose

This document describes the initial version of `scriberr-sidecar`: a small integration service that watches Scriberr's transcript output directory, asks Scriberr's API for authoritative job state, and publishes useful lifecycle events over MQTT.

The sidecar is intentionally not an emailer, note-taking service, medical-record exporter, or general-purpose automation engine. Its job is to turn Scriberr job state into reliable, deduplicated events that other homelab services can consume.

The initial implementation uses filesystem discovery. Phase 2 (documented separately) can add Scriberr webhooks as another discovery source without changing the downstream state machine.

## Current Scriberr deployment context

Scriberr runs as a Docker Compose service and is reached through:

```text
https://scriberr.kestis.nexus
```

Scriberr's persistent application data is stored on the Synology NAS through the host's NFS mount:

```text
/media/holocron/Storage/Backups/voice_recordings/scriberr_data/app_data/
```

The relevant directories are:

```text
app_data/
├── scriberr.db
├── uploads/
├── transcripts/
├── temp/
└── ...
```

WhisperX's environment and model cache are also on the NAS:

```text
/media/holocron/Storage/Backups/voice_recordings/scriberr_data/whisperx-env/
```

The sidecar should only need read access to the transcript directory. It should not need to modify Scriberr's database, upload directory, or WhisperX environment.

Note: this is my local configuration, and our sidecar should be configurable to work with other people's configurations.

Note: the Scriberr source code is available here: `/home/jmarchetto/copy/Scriberr`

## What Scriberr stores

The canonical job record is in `scriberr.db`. A transcription job includes a UUID-like job ID, status, audio path, transcript, summary, error information, and transcription parameters.

For normal single-track jobs, Scriberr creates a transcript output directory based on the job ID:

```text
/app/data/transcripts/{job_id}/
```

On this host that maps to:

```text
/media/holocron/Storage/Backups/voice_recordings/scriberr_data/app_data/transcripts/{job_id}/
```

The job ID therefore provides a useful correlation key between:

```text
Scriberr API job
        ↓
transcripts/{job_id}/
        ↓
uploads/{job_id}_...
```

The existence of the transcript directory is not proof that transcription has completed. Scriberr creates output directories during processing, and failed or interrupted jobs may leave directories behind. The API remains the source of truth for status.

## Goals

Phase 1 should:

1. Discover new job IDs from the transcript directory.
2. Track discovered jobs in a local SQLite database.
3. Poll Scriberr's API for authoritative status.
4. Detect transcription completion and failure.
5. Detect summary completion when a summary becomes available.
6. Optionally request summary generation through the Scriberr API using the configured Scriberr summary template and its model, with an explicit model override available.
7. Publish stable, metadata-only lifecycle events through MQTT.
8. Survive restarts without duplicating events unnecessarily.
9. Keep the implementation small enough to run as a low-resource Docker service.

## Non-goals

Phase 1 should not:

- Modify Scriberr's source code.
- Modify Scriberr's SQLite database directly.
- Read or rewrite WhisperX output files as the primary data source.
- Send emails, notifications, or create external notes directly.
- Put transcript or summary bodies into MQTT messages by default.
- Depend on filesystem notifications as the only discovery mechanism.
- Add MQTT-specific code to Scriberr.

## Recommended implementation language and libraries

Use TypeScript on Node.js. This matches the primary operator's work experience and provides a straightforward path to a future HTTP webhook receiver.

Recommended components:

- TypeScript and Node.js.
- Native `fetch` for Scriberr API requests.
- `better-sqlite3` for the local state database.
- `mqtt.js` for MQTT publishing.
- `zod` for configuration and API-response validation.
- `pino` for structured logs.
- Fastify later, when the webhook ingestion endpoint is added.

The first version does not need a web framework because it only scans, polls, and publishes. It should nevertheless keep discovery behind an internal interface so a webhook input can be added later.

## High-level architecture

```text
NAS transcript directory
        │
        │ periodic scan
        ▼
Filesystem discovery adapter
        │
        │ JobDiscovered(job_id, source)
        ▼
Local SQLite state store
        │
        │ jobs needing polling
        ▼
Scriberr API client
        │
        │ status, transcript, summary, errors
        ▼
Job lifecycle state machine
        │
        │ deduplicated events
        ▼
MQTT publisher
        │
        ▼
Existing MQTT consumers / automation services
```

The source of discovery is deliberately separate from the lifecycle processor. The initial source is a directory scanner. A future source can be an HTTP webhook from Scriberr. Both should feed the same `JobDiscovered` operation.

## Deployment and image distribution

The sidecar repository is the source and image-build project. It should produce a Docker image that can be published to Docker Hub and consumed by the existing Scriberr Docker Compose stack. The sidecar does not need a separate production Compose stack on the host.

The repository should contain at least:

- A production `Dockerfile` for the TypeScript/Node.js service.
- A `docker-compose-sample.yml` (or equivalent) showing how to run the sidecar and configure its mounts.
- GitHub Actions configuration that builds and publishes the image to Docker Hub, using repository or organization secrets for registry credentials.

The production deployment should add a `scriberr-sidecarr` service to the existing Scriberr `docker-compose.yml`, using the published image. The Compose service should normally use an immutable release tag or digest rather than relying only on `latest`.

The existing Scriberr Compose project remains responsible for deployment configuration, networking, restart policy, and integration with the local MQTT broker. A typical service will look conceptually like this:

```yaml
services:
  scriberr-sidecarr:
    image: docker.io/<dockerhub-user>/<image-name>:<tag>
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - /media/holocron/Storage/Backups/voice_recordings/scriberr_data/app_data/transcripts:/watch/transcripts:ro
      - ./scriberr-sidecarr-data:/app/data
```

The sample Compose file in this repository should use the public Docker Hub image and show the intended consumer-facing deployment. A separate local-development Compose file may use `build: .` for testing the image from source. Production users can copy the public-image service definition into their existing Scriberr stack instead of creating a second stack.

Suggested container mounts:

```yaml
volumes:
  - /media/holocron/Storage/Backups/voice_recordings/scriberr_data/app_data/transcripts:/watch/transcripts:ro
  - ./data:/app/data
```

The NAS mount must be read-only from the sidecar. For the integrated Scriberr deployment, the SQLite database should be stored in a local-disk bind mount belonging to the Scriberr Compose project, for example `/docker/scriberr/data/scriberr-sidecarr/`. The exact host path is deployment-specific and should not be placed on the NAS NFS share.

### Image publishing and deployment flow

The intended lifecycle is:

```text
commit / tag in GitHub
        ↓
GitHub Actions builds the Docker image
        ↓
GitHub Actions publishes the image to Docker Hub
        ↓
existing Scriberr Compose stack pulls the new image
        ↓
scriberr-sidecarr runs beside Scriberr
```

The initial GitHub Actions workflow may follow the working pattern used by the `exercise-log` project. It should at minimum build the Dockerfile and publish the image on the appropriate branch or release event. Deployment remains a concern of the host's Compose/Tugtainer workflow.

The image should support the architecture used by the production Docker host. Multi-architecture publishing can be added if broader reuse is desired, but is not required for the initial deployment path.

## Configuration

Initial configuration should use environment variables prefixed with `SIDECARR_`, with secrets kept in a local `.env` file that is not committed. The repository should commit a `.env.sample` containing documented placeholder values and ignore the deployment's `.env` file.

Suggested configuration:

```env
SIDECARR_WATCH_FOLDER=/watch/transcripts
SIDECARR_SCAN_INTERVAL_SECONDS=30

SIDECARR_SCRIBERR_URL=https://scriberr.kestis.nexus
SIDECARR_SCRIBERR_API_KEY=replace-me

SIDECARR_MQTT_URL=mqtt://mosquitto:1883
SIDECARR_MQTT_USERNAME=optional
SIDECARR_MQTT_PASSWORD=optional
SIDECARR_MQTT_TOPIC_PREFIX=home/audio/scriberr
SIDECARR_MQTT_QOS=1
SIDECARR_MQTT_RETAIN=false

SIDECARR_AUTOGENERATE_SUMMARY=true
SIDECARR_SUMMARY_TEMPLATE=Default
SIDECARR_SUMMARY_MODEL=
SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS=30
SIDECARR_SUMMARY_TIMEOUT_SECONDS=3600
```

Names may change during implementation. The important design points are:

- All sidecar-specific environment variables use the `SIDECARR_` prefix.

- Scriberr URL and credentials are configurable.
- The watched folder is configurable.
- Polling intervals are configurable.
- MQTT broker and topic prefix are configurable.
- Summary autogeneration is explicitly configurable.

The credential should preferably be a dedicated Scriberr API key rather than a user's password. The exact header format must follow Scriberr's API authentication implementation. Do not log the key, include it in MQTT, or commit it to Git.

## Filesystem discovery

The scanner periodically lists immediate child directories below the configured transcript folder. A candidate job directory is a directory whose name looks like a Scriberr job ID. The scanner should not assume every arbitrary directory is valid; it should validate the expected ID format or allow a configurable permissive mode.

For each candidate:

1. Extract the directory name as `job_id`.
2. Insert the job into SQLite if it does not already exist.
3. Record `source = filesystem` and `first_seen`.
4. Publish `job_found` once.
5. Queue the job for API polling.

Scanning is preferred over relying only on `fsnotify`/inotify because the directory is backed by NFS. A periodic scan is less sensitive to event delivery, container restarts, and temporary NFS behavior.

- A directory appearing while Scriberr is still processing.
- A directory disappearing temporarily.
- Permission or NFS errors.
- Empty directories.
- Failed jobs that never produce a complete transcript.
- Container restarts and duplicate discovery.

Configurable permissive job-ID matching is **POST-MVP**; the initial scanner can validate Scriberr's expected job-ID format.

## Scriberr API interaction

For each tracked job, the sidecar should retrieve the job record from:

```text
GET /api/v1/transcription/{job_id}
```

The returned record is expected to contain at least:

```text
id
status
title
transcript
summary
error_message
created_at
updated_at
```

The list endpoint may also be useful for reconciliation. This is **POST-MVP**; initial discovery comes from the transcript directory and persisted jobs:

```text
GET /api/v1/transcription/list?page=1&limit=...
```

The API should be the authoritative source for job status. Files in the transcript directory can be used for discovery and optional diagnostics, but the sidecar should not decide that a job is complete merely because an output file exists.

## State machine

The external Scriberr status values are expected to include:

- `uploaded`
- `pending`
- `processing`
- `completed`
- `failed`

The sidecar can normalize these into its own states:

```text
discovered
pending_transcription
processing_transcription
transcription_complete
summary_pending
summary_processing
summary_complete
transcription_failed
summary_failed
```

Not every state needs to be persisted as an exact Scriberr status. Persist both the last observed Scriberr status and sidecar milestones where useful.

Suggested transitions:

```text
new folder
  → discovered

uploaded / pending
  → pending_transcription

processing
  → processing_transcription

completed + no summary requested
  → transcription_complete

completed + summary requested but summary empty
  → summary_pending

completed + summary present
  → summary_complete

failed
  → failed
```

A later Scriberr rerun may move a previously failed job back through pending or processing and then to completed. The sidecar must recognize that as a new attempt and publish the corresponding new lifecycle events.

The exact summary states depend on the Scriberr summary API. If summary generation cannot be reliably initiated or observed in Phase 1, the sidecar should still publish transcription events and record that summary handling is unavailable rather than silently looping forever.

## Polling behavior

A simple initial policy is acceptable:

- Scan the transcript directory every 30 seconds.
- Poll newly discovered jobs every 15–30 seconds.
- Stop transcription polling only after a transcription terminal state is reached.
- Continue summary polling for tracked jobs when a summary is absent, because a summary may be generated externally even when `AUTOGENERATE_SUMMARY=false`.
- Retry transient HTTP, authentication, and NFS errors with backoff.
- Keep failed jobs in the database for inspection and optional retry.

Polling should be idempotent. A sidecar restart must not cause an uncontrolled burst of duplicate MQTT events.

An improved policy can use adaptive polling (**POST-MVP**):

- Poll frequently for the first few minutes.
- Back off for long-running transcriptions.
- Poll summary generation separately.
- Reconcile all nonterminal jobs on startup.

## Local database

SQLite is sufficient because the sidecar is a single process with a small amount of state. The database is not a copy of Scriberr's data; it is an event-delivery and reconciliation ledger.

An initial `jobs` table could contain:

```text
job_id TEXT PRIMARY KEY
source TEXT NOT NULL
transcript_folder TEXT
first_seen_at TEXT NOT NULL
last_seen_at TEXT
last_checked_at TEXT
scriberr_status TEXT
sidecar_state TEXT NOT NULL
transcription_event_at TEXT
summary_event_at TEXT
summary_requested_at TEXT
last_error TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

An `events` table is useful for deduplication and auditing:

```text
id INTEGER PRIMARY KEY
job_id TEXT NOT NULL
event_type TEXT NOT NULL
payload_hash TEXT
published_at TEXT
publish_attempts INTEGER NOT NULL DEFAULT 0
last_error TEXT
UNIQUE(job_id, event_type, occurrence_key)
```

The event key must identify a particular lifecycle occurrence or state transition, not only the job and event type. This allows a failed job to emit a later successful completion event after it is rerun, while still preventing duplicate publication during restarts or repeated polling.

## MQTT events

The sidecar should publish metadata-only events by default. Transcript and summary bodies can contain medical information and should not be copied into MQTT messages, retained broker storage, logs, or unrelated subscribers.

Suggested topics:

```text
{prefix}/job_found
{prefix}/pending_transcription
{prefix}/transcription_processing
{prefix}/transcription_complete
{prefix}/summary_pending
{prefix}/summary_complete
{prefix}/transcription_failed
{prefix}/summary_failed
```

Example event:

```json
{
  "event": "transcription_complete",
  "job_id": "caa1624b-215d-42a1-a347-0ee1f80fa1d0",
  "status": "completed",
  "source": "filesystem",
  "occurred_at": "2026-09-08T15:30:00.000Z",
  "scriberr_url": "https://scriberr.kestis.nexus"
}
```

Do not include by default:

- Transcript text.
- Summary text.
- API keys.
- Passwords.
- Full internal NAS paths.
- Raw Scriberr API responses.

Consumers can use `job_id` to retrieve the full job from Scriberr. If a future use case requires text in MQTT, it should be an explicit opt-in with clear retention and privacy behavior.

Use MQTT QoS 1 initially. Retained messages should default to false because lifecycle events are historical notifications, not current-state configuration. Consumers that need current state should query Scriberr or maintain their own state from events.

## Summary handling

Transcription and summary generation are separate operations. The sidecar should not assume that a completed transcription implies a completed summary.

The intended behavior is:

1. Wait for Scriberr transcription status `completed`.
2. Confirm whether the job already has a summary.
3. If `AUTOGENERATE_SUMMARY=false`, publish `transcription_complete` and continue polling for an externally generated summary when appropriate.
4. If a summary exists, publish `summary_complete`.
5. If no summary exists and the API supports summary generation, request it.
6. Poll until summary content is present or the summary timeout expires.
7. Publish `summary_complete` or `summary_failed` accordingly. Transcription failures should publish `transcription_failed` independently.

The exact summary endpoint and request body must be verified against the checked-out Scriberr source before implementation. The sidecar must not guess at an endpoint or repeatedly submit duplicate summary requests.

## API credential handling

Use a dedicated Scriberr API key with the minimum access needed. Store it in the sidecar's `.env` or Docker secret mechanism, not in the database or MQTT payload.

The sidecar should:

- Load the credential only at startup.
- Never log request headers.
- Redact credentials from error messages and configuration dumps.
- Fail clearly if authentication is rejected.
- Use HTTPS when accessing Scriberr through the routed hostname.

If an API key cannot read the required endpoints, use a dedicated service account/token rather than the primary user's password.

## Failure and recovery behavior

The sidecar should distinguish between:

- A job that Scriberr reports as failed.
- A temporary API failure.
- An authentication failure.
- A temporary NFS scan failure.
- An MQTT connection failure.
- A summary timeout.

MQTT delivery failures should remain recorded in SQLite and be retried. A job that later succeeds after being rerun in Scriberr must be allowed to emit new lifecycle events for the new attempt, including a new transcription completion or summary completion event. A broker outage should not erase discovered jobs or cause them to be forgotten.

If Scriberr is unavailable, the sidecar should retain jobs and resume polling after recovery. If the NAS is unavailable, the sidecar can continue processing already-known jobs through the API but should report scanner errors.

## Observability

Logs should be structured and low-noise. Useful fields include:

```text
job_id
event_type
source
scriberr_status
sidecar_state
attempt
error
```

Useful metrics (**POST-MVP**):

- Jobs discovered.
- Jobs currently pending.
- Jobs completed.
- Jobs failed.
- API request failures.
- MQTT publish failures.
- Average transcription duration.
- Average summary duration.
- Number of jobs awaiting summary.

The sidecar should expose no public web interface in Phase 1. A health endpoint for Docker/Uptime Kuma is **POST-MVP**.

## Privacy and security

Audio, transcripts, and summaries may contain medical information. The default design should minimize data movement:

- Read-only transcript mount.
- Metadata-only MQTT messages.
- No transcript bodies in logs.
- No summary bodies in logs.
- No public webhook or sidecar endpoint in Phase 1.
- API access over HTTPS.
- Dedicated API credential.
- No MQTT retained content by default.

If downstream consumers need transcript text, they should retrieve it directly from Scriberr over authenticated API access.

## Initial implementation milestones

### Milestone 1: project skeleton

- TypeScript project.
- Configuration loader.
- Logger.
- Docker build/run path.
- Basic SQLite migration.
- Production `Dockerfile`.
- Sample Compose service/configuration.
- GitHub Actions workflow for publishing the image to Docker Hub.

### Milestone 2: filesystem discovery

- Periodic directory scan.
- Job ID validation.
- Idempotent database insertion.
- `job_found` event.

### Milestone 3: Scriberr API polling

- Authenticated job lookup.
- Status normalization.
- Retry/backoff behavior.
- Transcription completion/failure events.

### Milestone 4: summary tracking

- Detect existing summary.
- Verify summary-generation endpoint.
- Optional summary request.
- Summary completion/failure events.

### Milestone 5: production hardening

- Reconciliation on startup.
- MQTT reconnect handling.
- Event delivery ledger.
- Health checks (**POST-MVP**).
- Redaction tests.
- Production image tags and update procedure (**POST-MVP**).
- Verification of the published-image deployment in the existing Scriberr Compose stack.

## Design principle

The sidecar should be an event translator and state tracker, not a second Scriberr. Scriberr remains responsible for audio processing and persisted transcript/summary content. The sidecar remains responsible for reliable discovery, lifecycle tracking, deduplicated event publication, and integration boundaries.
