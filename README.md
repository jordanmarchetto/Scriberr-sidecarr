# Scriberr Sidecarr

A small sidecar that discovers Scriberr transcription jobs, confirms lifecycle state through Scriberr's API, and publishes metadata-only events over MQTT.

## Quick start

Sidecarr assumes it shares a user-defined Docker network with Scriberr. The services may be in the same Compose project or in separate projects attached to the same external network.

Copy .env.sample to .env and set the Scriberr API key and MQTT values:

    cp .env.sample .env
    docker compose up -d

The default image is docker.io/jordanmarchetto/scriberr-sidecarr:latest. The API key is sent to Scriberr as X-API-Key. Sidecarr never places the key, transcript, or summary content in MQTT messages or logs.

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

## Build locally

Use docker-compose.local.yml to build from the checked-out source:

    docker compose -f docker-compose.local.yml up --build

## Events

Events are published at SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/{event_name}. For example: home/audio/scriberr/123e4567-e89b-12d3-a456-426614174000/summary_complete.

Subscribe to SIDECARR_MQTT_TOPIC_PREFIX/+/# for all jobs or SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/# for one job. Messages contain job metadata only. Transcription and summary lifecycles are tracked independently, and a Scriberr rerun creates a new attempt so later success events are not suppressed by an earlier failure.
