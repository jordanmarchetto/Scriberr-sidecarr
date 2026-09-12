# Scriberr Sidecarr

A small sidecar that discovers Scriberr transcription jobs, confirms lifecycle state through Scriberr's API, and publishes metadata-only events over MQTT.

## What it does

With a webhook-capable Scriberr installation—such as the fork with webhooks and auto-summary:

1. Sidecarr registers its own webhook.
2. Scriberr notifies Sidecarr when recordings, transcriptions, and summaries change.
3. Sidecarr confirms the current state through Scriberr's API.
4. Sidecarr publishes MQTT lifecycle events.

With an unmodified Scriberr installation:

1. Sidecarr sees that webhook management is unavailable and falls back automatically.
2. It watches Scriberr's transcript directory to discover jobs.
3. It polls Scriberr's API for state changes.
4. If configured, it asks Scriberr to generate missing summaries.
5. It publishes the same MQTT lifecycle events.

In both cases, SQLite prevents duplicate events and preserves pending MQTT messages across restarts. Sidecarr does not transcribe recordings or generate summaries itself; Scriberr does that work. Optionally, it can also maintain editable Notion pages containing each recording, transcript, and summary.

## Quick start

Sidecarr assumes it shares a user-defined Docker network with Scriberr. The services may be in the same Compose project or in separate projects attached to the same external network.

Copy .env.sample to .env and set the Scriberr API key and MQTT values:

    cp .env.sample .env
    docker compose up -d

The default image is docker.io/jordanmarchetto/scriberr-sidecarr:latest. The API key is sent to Scriberr as X-API-Key. Sidecarr never places the key, transcript, or summary content in MQTT messages or logs.

Safe Scriberr API reads retry transient network errors and HTTP 408, 429, and 5xx responses with bounded exponential backoff. SIDECARR_API_TIMEOUT_SECONDS, SIDECARR_API_MAX_ATTEMPTS, and SIDECARR_API_RETRY_BASE_MILLISECONDS control that behavior. Summary-creation and webhook-creation requests are not automatically retried because doing so could create duplicate work.

## Choose a discovery mode

SIDECARR_DISCOVERY_MODE controls how Sidecarr learns about new job IDs. Regardless of the discovery mode, Sidecarr queries Scriberr's authenticated API for authoritative state.

### Webhook discovery (recommended)

    SIDECARR_DISCOVERY_MODE=webhook

No additional webhook setup is required. Sidecarr:

1. Listens at http://scriberr-sidecarr:8080/webhooks/scriberr.
2. Generates and persists a signing secret in its SQLite database.
3. Creates or repairs its subscription through Scriberr's webhook API.
4. Verifies signatures and deduplicates deliveries.

Sidecarr checks the managed subscription periodically. If Scriberr does not provide the webhook-management routes—as with an unmodified upstream version—Sidecarr logs one compatibility message and falls back to filesystem discovery plus API polling. Temporary registration failures also use the fallback and are retried.

The Compose service keeps the transcript directory mounted so this fallback remains available. Set SIDECARR_TRANSCRIPTS_HOST_PATH if the default host path does not match the Scriberr deployment.

### Filesystem discovery

Use this mode to skip webhook registration explicitly:

    SIDECARR_DISCOVERY_MODE=filesystem
    SIDECARR_WATCH_FOLDER=/watch/transcripts
    SIDECARR_SCAN_INTERVAL_SECONDS=30

Sidecarr scans immediate job directories and then queries Scriberr's API for each discovered job.

## Advanced webhook overrides

Most installations should omit these settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| SIDECARR_WEBHOOK_CALLBACK_URL | http://scriberr-sidecarr:8080/webhooks/scriberr | URL registered with Scriberr |
| SIDECARR_WEBHOOK_HOST | 0.0.0.0 | Listener bind address |
| SIDECARR_WEBHOOK_PORT | 8080 | Listener port |
| SIDECARR_WEBHOOK_PATH | /webhooks/scriberr | Listener path |
| SIDECARR_WEBHOOK_SECRET | generated and persisted | Explicit signing-secret override |

When CALLBACK_URL is omitted, Sidecarr derives it from the default Docker service name plus WEBHOOK_PORT and WEBHOOK_PATH. Override CALLBACK_URL if the service is renamed. Keep the callback reachable only through the shared Docker network or another trusted network.

The container exposes its webhook port to the Docker network without publishing it on the host. GET /health returns a small health response.

## Summary generation

When both SIDECARR_AUTOGENERATE_SUMMARY and Scriberr's auto-summarize feature are enabled, Scriberr owns summary generation. Sidecarr waits for Scriberr and checks the API instead of starting a duplicate request. If the settings check is unavailable, Sidecarr safely defers its own request.

When SIDECARR_AUTOGENERATE_SUMMARY=true, SIDECARR_SUMMARY_TEMPLATE selects a Scriberr template by name (default: Default). Set SIDECARR_SUMMARY_MODEL to override the template's model.

## Optional Notion destination

Notion is disabled by default. To enable it:

1. Create a Notion internal integration with permission to read, insert, and update content.
2. Create a normal Notion page—not a database—to hold the Scriberr notes.
3. Share that page with the integration.
4. Add these settings to `.env`:

       SIDECARR_NOTEBOOK_PROVIDER=notion
       SIDECARR_NOTION_TOKEN=secret_your_integration_token
       SIDECARR_NOTION_PARENT_PAGE_URL=https://www.notion.so/your-parent-page-id

The token and parent URL are both required when the provider is enabled. Sidecarr creates one child page per Scriberr job and progressively adds status, metadata, editable classification fields, audio, a user-owned Notes area, summary, full transcript, and archived rerun attempts. It only replaces blocks it owns, so content added to Notes or elsewhere is preserved.

Sidecarr downloads audio through Scriberr's authenticated API; it does not need an uploads-directory mount. Notion simple uploads are limited to 20 MiB. When a recording exceeds that limit or Notion rejects its media format, the page explains why and links back to the recording in Scriberr. Transcript and summary synchronization continue normally.

Existing tracked jobs are not imported when Notion is first enabled. Set `SIDECARR_NOTION_BACKFILL=true` to opt into backfill. If the configured parent URL later changes, Sidecarr moves only pages it previously created or recovered by their Sidecarr job marker.

Notion failures are retried up to three times and emit `notebook_sync_failed`; they do not stop Scriberr polling, webhook handling, summary coordination, or core MQTT events. Docker logs contain job IDs, operations, and sanitized errors, but never the Notion token, audio, transcript, or summary content.

## Build locally

Use docker-compose.local.yml to build from the checked-out source:

    docker compose -f docker-compose.local.yml up --build

## Releases

Pushes to main publish `latest` and commit-SHA image tags. A semantic-version Git tag such as `v0.2.0` publishes:

    jordanmarchetto/scriberr-sidecarr:0.2.0
    jordanmarchetto/scriberr-sidecarr:0.2

Pushes to a `feature/**` branch also publish a temporary branch tag for testing. Docker tag rules replace the slash with a dash, so `feature/notion-notebook-destination` publishes:

    jordanmarchetto/scriberr-sidecarr:feature-notion-notebook-destination

Set that tag in `docker-compose.yml`, then run `docker compose pull && docker compose up -d` to test the branch image.

Use the full version tag in production so upgrades are explicit. Create and push the Git tag only after the corresponding commit has passed CI.

Deployment assumption: deploy a release containing webhook and auto-summary compatibility alongside the compatible Scriberr fork. Verify the image/tag and service ordering with the deployment owner before rollout.

## Health and metrics

`GET /health` returns HTTP 200 while the sidecar listener is running. The image includes a Docker health check against this endpoint. Uptime Kuma can use an HTTP monitor pointed at:

    http://scriberr-sidecarr:8080/health

`GET /metrics` exposes Prometheus-compatible metrics for:

- tracked jobs by state
- pending MQTT events and webhook signals
- API and MQTT failures
- webhook outcomes and discovery sources
- transcription and summary durations

Keep both endpoints on a trusted Docker network unless they are protected by an authenticated reverse proxy.

## Troubleshooting logs

Sidecarr writes structured JSON logs to standard output, so they appear in Docker logs:

    docker compose logs -f scriberr-sidecarr

The default `LOG_LEVEL=info` records startup configuration, discovery-mode changes, webhook compatibility fallback, job state changes, retries, and failures. Temporarily set `LOG_LEVEL=debug` to also see accepted webhooks, queued events, and successful MQTT publications. Logs include IDs and state metadata, but not API keys, webhook secrets, transcripts, summaries, or MQTT passwords.

## Events

Events are published at SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/{event_name} with QoS and retention controlled by configuration. For example: home/audio/scriberr/123e4567-e89b-12d3-a456-426614174000/summary_complete. Subscribe to SIDECARR_MQTT_TOPIC_PREFIX/+/# to receive all job events or SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/# to follow one job. Messages contain job metadata only, including Scriberr's title when available. Failure events include a bounded, redacted error message. Transcription and summary lifecycle events are tracked independently, and a Scriberr rerun creates a new attempt so later success events are not suppressed by an earlier failure.

When Notion is enabled, meaningful notebook steps use the same topic shape and publish metadata-only events:

- `notebook_page_created`
- `notebook_page_moved`
- `notebook_status_updated`
- `notebook_audio_attached` or `notebook_audio_skipped`
- `notebook_version_archived`
- `notebook_transcript_updated`
- `notebook_summary_updated`
- `notebook_sync_failed`

These payloads contain the provider, job and attempt IDs, operation, Notion page ID/URL, timestamp, and a sanitized error when relevant. They never contain note content, transcripts, summaries, audio, or credentials.
