# Scriberr Sidecar — Phase 2 Architecture

## Purpose

Phase 2 adds upstream-friendly lifecycle events to Scriberr and updates `scriberr-sidecar` to consume those events. The goal is to replace or supplement transcript-directory polling with push-based job discovery while preserving the Phase 1 state machine and MQTT contract.

The desired result is:

```text
Scriberr
  └── HTTP lifecycle webhook
          └── scriberr-sidecar
                  └── MQTT lifecycle events
                          └── existing automation consumers
```

The Phase 1 filesystem scanner should remain available as a fallback and reconciliation mechanism.

## Why Phase 2 belongs partly in Scriberr

The current filesystem approach is indirect. The transcript directory may be created before processing finishes, and NFS filesystem events are not a perfect job-completion signal. Scriberr itself knows when transcription and summary operations complete, so it is the correct source for completion events.

The existing Scriberr source already contains the beginnings of webhook support:

- `callback_url` exists in transcription parameters.
- The transcription pipeline can send an HTTP callback.
- Webhook retry behavior exists.

The main gaps are configuration and coverage:

- The normal UI does not expose a callback URL.
- The watch-folder path does not populate one.
- Summary completion needs its own lifecycle event.
- A generic server-level webhook configuration may be more useful than requiring callers to set a per-job URL.
- The existing payload behavior should be reviewed for privacy and extensibility.

The upstream PR should focus on generic HTTP lifecycle events rather than MQTT. MQTT is a homelab-specific transport and should remain in the sidecar or a separate bridge.

## Phase 2 goals

The Scriberr change should:

1. Provide configurable webhook behavior through an appropriate settings path.
2. Expose a UI for webhook configuration if maintainers agree that server-level configuration is appropriate.
3. Emit transcription completion and failure events.
4. Emit summary completion and failure events.
5. Include a stable job ID and event type in every payload.
6. Preserve retry behavior and make delivery failures observable.
7. Avoid coupling Scriberr to MQTT, n8n, or a particular automation platform.
8. Keep the existing REST API as the canonical way to retrieve transcript and summary content.
9. Allow the sidecar to receive push notifications without changing its downstream processing model.

The sidecar change should:

1. Add an HTTP webhook ingestion endpoint.
2. Normalize webhook notifications into the same internal `JobDiscovered`/`JobUpdated` path used by the filesystem scanner.
3. Deduplicate webhook and filesystem notifications by job ID and event identity.
4. Continue querying Scriberr to confirm state and retrieve content.
5. Preserve the same MQTT topic and payload contract used by Phase 1.
6. Keep the filesystem scanner as a fallback and reconciliation source.

## Non-goals

Phase 2 should not:

- Add an MQTT client to Scriberr.
- Make Scriberr know about the sidecar's database.
- Make Scriberr send arbitrary transcript text to every integration by default.
- Replace the REST API with webhook payloads.
- Force users to run the sidecar to use Scriberr.
- Require a maintained Scriberr fork if the PR is accepted upstream.

## Proposed Scriberr configuration

The exact configuration shape should follow Scriberr's existing conventions and maintainer preferences. Conceptually, the server should support:

```text
Webhook enabled: true/false
Webhook URL: https://internal.example/webhooks/scriberr
Webhook secret: optional secret for signing/authentication
Events:
  - transcription.completed
  - transcription.failed
  - summary.completed
  - summary.failed
```

Possible configuration scopes:

### Server-level webhook

Best for watch-folder and automatic-transcription workflows. Every applicable job uses the configured webhook.

Advantages:

- Works for UI uploads, watcher uploads, and API jobs.
- No need to configure each job manually.
- A natural settings page can expose it.

Disadvantages:

- Less flexible for users who want different destinations per job.

### Per-job callback URL

Best for API clients that need a different callback for each request. Scriberr already has the beginnings of this model.

Advantages:

- Flexible for API integrations.
- Existing `callback_url` field can remain useful.

Disadvantages:

- Not convenient for the UI or watcher unless those paths explicitly populate it.
- Callback configuration is easy to miss.

### Recommended combination

Support both if maintainers consider the scope acceptable:

1. A server-level default webhook configuration.
2. An optional per-job callback override.
3. Clear precedence rules.

For example:

```text
per-job callback URL → server default webhook → no webhook
```

This can be split into multiple PRs if maintainers prefer a smaller first change.

## Proposed event model

Events should be explicit and machine-readable. Suggested event names:

```text
transcription.completed
transcription.failed
summary.completed
summary.failed
```

An optional `job.created` or `job.uploaded` event could be useful, but it is not required for Phase 2 because the sidecar can continue discovering jobs through the filesystem or the existing API.

Suggested payload:

```json
{
  "event_id": "uuid-for-this-delivery",
  "event": "transcription.completed",
  "job_id": "caa1624b-215d-42a1-a347-0ee1f80fa1d0",
  "status": "completed",
  "occurred_at": "2026-09-08T15:30:00.000Z",
  "title": "Standard recording 13",
  "api_url": "/api/v1/transcription/caa1624b-215d-42a1-a347-0ee1f80fa1d0"
}
```

Failure payloads can add:

```json
{
  "error": {
    "message": "human-readable failure description"
  }
}
```

The default payload should contain metadata and a job ID, not full transcript or summary bodies. Consumers can retrieve content through the authenticated API. This minimizes accidental exposure through webhook logs, queues, retries, and retained messages.

If Scriberr maintainers want to preserve the current callback payload behavior, the API should at least make the content-bearing behavior explicit and configurable. A metadata-only default is safer for medical and other sensitive recordings.

## Webhook delivery behavior

The existing retry approach is useful but should be reviewed for production behavior. Desired properties:

- HTTP POST with `Content-Type: application/json`.
- A clear user-agent identifying Scriberr.
- A stable `event_id` for deduplication.
- A timeout.
- Bounded retries with backoff.
- Retries for network errors and 5xx responses.
- No or limited retries for permanent 4xx responses.
- Logs that include job ID and event type but not transcript content or secrets.
- Delivery failure must not make the transcription job itself fail.

If a webhook secret is supported, use a standard signature header such as an HMAC over the raw body. Avoid putting secrets in query strings where they can appear in logs.

Example headers:

```text
Content-Type: application/json
User-Agent: Scriberr-Webhook/1.0
X-Scriberr-Event: transcription.completed
X-Scriberr-Event-ID: ...
X-Scriberr-Signature: sha256=...
```

Exact header names should follow project conventions.

## Where Scriberr should emit events

### Transcription events

Emit the completion/failure event at the shared transcription service boundary, after the job and execution record have been updated to the terminal state. This avoids emitting success before the database reflects success.

The event should be emitted for all relevant job entry points:

- UI uploads.
- Automatic transcription.
- Watch-folder uploads.
- REST API-started jobs.
- Re-transcriptions.

### Summary events

Emit summary events at the shared summary service boundary, after the summary has been persisted successfully. Do not put the hook only in one UI handler if summaries can be generated through multiple API or service paths.

The event should occur after:

1. The LLM request succeeds.
2. The summary record is saved.
3. The associated job state is updated if applicable.

If the summary operation fails, emit `summary.failed` with the job ID and sanitized error metadata.

## Sidecar Phase 2 design

The sidecar should add an HTTP input adapter, not a second processing path.

```text
Filesystem scanner ─┐
                    ├─→ Job discovery/update normalization
Scriberr webhook ───┘
                    │
                    ▼
             SQLite state store
                    │
                    ▼
             Scriberr API polling
                    │
                    ▼
             MQTT event publisher
```

The webhook handler should be intentionally thin:

1. Validate authentication/signature.
2. Parse the event type and job ID.
3. Record the notification or enqueue the job ID.
4. Return HTTP 2xx quickly.
5. Let the existing worker retrieve authoritative state from Scriberr.

The webhook request should not synchronously fetch the entire transcript, generate a summary, or publish multiple downstream messages before responding. Quick acknowledgment reduces retries and makes the system more resilient.

## Source normalization

Both discovery sources should produce an internal structure similar to:

```ts
type JobSignal = {
  jobId: string;
  source: "filesystem" | "webhook";
  eventType?:
    | "job_found"
    | "transcription.completed"
    | "transcription.failed"
    | "summary.completed"
    | "summary.failed";
  receivedAt: string;
};
```

The state processor should not trust a webhook payload blindly. It should use the job ID to query Scriberr and verify the current state. Webhooks provide low-latency hints; the API provides authoritative state.

## Deduplication

The same job may be discovered through both mechanisms. For example:

1. Filesystem scan discovers the transcript directory.
2. Scriberr sends `transcription.completed`.
3. A later reconciliation scan sees the same directory.

The sidecar must not emit duplicate logical events merely because the source differs.

Deduplication should use:

```text
job_id + normalized lifecycle event
```

If Scriberr supplies `event_id`, store it as an additional delivery identifier. The sidecar can record the source and event ID for diagnostics without making source identity part of the MQTT event semantics.

## Sidecar MQTT behavior

The external MQTT contract should remain stable between phases. For example:

```text
home/audio/scriberr/job_found
home/audio/scriberr/transcription_complete
home/audio/scriberr/summary_complete
home/audio/scriberr/failed
```

The sidecar can map Scriberr events to its own normalized event names:

```text
transcription.completed → transcription_complete
summary.completed       → summary_complete
*.failed                → failed
```

Consumers should not need to know whether a job was discovered from the NAS or by webhook.

## API content retrieval

Webhook and MQTT payloads should normally contain the job ID only. Consumers can retrieve the full record from:

```text
GET /api/v1/transcription/{job_id}
```

The job response contains the persisted transcript and summary fields when available. The sidecar may optionally provide a small authenticated proxy in a future phase, but that is outside the initial scope.

This arrangement has several advantages:

- MQTT remains low-volume and metadata-only.
- Sensitive text is not copied into the broker.
- Consumers retrieve the latest persisted value.
- Summary generation races are reduced because consumers can fetch after the terminal event.
- Scriberr remains the canonical content store.

## Summary event and sidecar behavior

The sidecar should recognize two cases:

### Summary generated by Scriberr

When Scriberr sends `summary.completed`, the sidecar verifies the job via API, records `summary_complete`, and publishes the normalized MQTT event.

### Summary requested by sidecar

If Phase 1 or a later sidecar feature asks Scriberr to generate a summary, the sidecar records `summary_requested_at` and waits for either:

- A `summary.completed` webhook.
- A nonempty summary in a polled job response.
- A `summary.failed` webhook.
- A timeout.

The sidecar must avoid repeatedly triggering summary generation on every scan or webhook retry. A database flag or idempotency key is required.

## Suggested PR decomposition

The feature may be easier for upstream review as a sequence of small PRs.

### PR 1: lifecycle event abstraction

- Define event names and payload types.
- Add a shared event publisher interface.
- Keep existing behavior unchanged by default.
- Add unit tests.

### PR 2: transcription webhooks

- Add or refine server-level webhook configuration.
- Add UI settings if appropriate.
- Emit completed/failed transcription events.
- Add retry and delivery tests.

### PR 3: summary webhooks

- Locate the shared summary completion/failure boundary.
- Emit summary events after persistence.
- Add tests for success and failure.

### PR 4: watcher/API integration

- Ensure automatic and watch-folder jobs inherit the server-level webhook.
- Preserve per-job callback overrides if supported.
- Add integration coverage showing watcher-created jobs produce events.

The maintainers may prefer combining these, but separating them makes the review easier and reduces risk.

## Testing plan

### Scriberr tests

- Transcription success emits one completion event.
- Transcription failure emits one failure event.
- Summary success emits one completion event after persistence.
- Summary failure emits one failure event.
- Callback delivery retries transient failures.
- Permanent 4xx responses do not retry indefinitely.
- No webhook configuration causes no outgoing request.
- Secrets and transcript content are not logged.
- Watch-folder jobs use the configured webhook.
- Per-job callback precedence is deterministic if both mechanisms exist.

### Sidecar tests

- New transcript directory creates one tracked job.
- Repeated scans do not duplicate the job.
- Webhook discovery is idempotent.
- Filesystem and webhook discovery of the same job converge.
- API status transitions produce the expected normalized events.
- Duplicate webhook deliveries do not duplicate MQTT events.
- MQTT outages preserve pending events for retry.
- Scriberr API outages preserve pending jobs.
- Invalid signatures/authentication are rejected.
- Transcript and summary text do not appear in MQTT by default.

### End-to-end test

Use a local test webhook receiver and MQTT broker:

```text
create/upload job
  → Scriberr processes job
  → Scriberr sends transcription.completed
  → sidecar acknowledges webhook
  → sidecar queries API
  → sidecar publishes transcription_complete
  → summary is generated
  → Scriberr sends summary.completed
  → sidecar publishes summary_complete
```

## Migration and fallback strategy

The filesystem scanner should remain enabled after webhook support is deployed. It provides:

- Recovery if a webhook is lost.
- Discovery of jobs created while the webhook was disabled.
- Reconciliation after a sidecar restart.
- A useful compatibility path for older Scriberr versions.

Once webhook delivery is proven reliable, the scan interval can be increased to reduce API and NFS activity. It should not necessarily be removed.

If Scriberr's upstream PR is not accepted, the sidecar can continue using Phase 1 unchanged. If it is accepted, the sidecar can enable webhook ingestion through configuration without changing the MQTT consumer contract.

## Security and privacy

Medical recordings and their derived text require conservative defaults.

Scriberr webhook behavior should:

- Prefer HTTPS where possible.
- Support request authentication or signing.
- Avoid transcript/summary bodies in metadata events by default.
- Avoid secrets in query strings.
- Redact payload content from logs.

The sidecar should:

- Expose the webhook listener only on an internal Docker network or trusted LAN interface.
- Validate a shared secret or HMAC signature.
- Store Scriberr and MQTT credentials outside Git.
- Keep the NAS mount read-only.
- Avoid MQTT retained messages for sensitive events.
- Publish only job IDs and lifecycle metadata by default.

## Success criteria

Phase 2 is successful when:

1. Scriberr can be configured to send lifecycle events without custom per-job manual work.
2. Watch-folder jobs generate transcription and summary events.
3. The sidecar can consume those events and publish the same MQTT messages as Phase 1.
4. Filesystem polling remains a safe fallback.
5. Duplicate discovery does not create duplicate downstream events.
6. Transcript and summary retrieval still happens through Scriberr's authenticated API.
7. No MQTT-specific dependency is added to Scriberr.
8. The upstream PR is useful to Scriberr users even if they never use this sidecar.

## Design principle

Scriberr should own the truth about its job lifecycle and expose generic, secure HTTP events. The sidecar should own homelab-specific event translation and MQTT integration. Keeping those responsibilities separate makes the upstream change broadly useful while preserving the flexibility of the local automation system.
