# Scriberr Sidecarr

A small sidecar that discovers Scriberr transcription jobs, polls Scriberr for authoritative lifecycle state, and publishes metadata-only events over MQTT.

## Configuration

Copy .env.sample to .env and set the Scriberr API key and MQTT values. All application variables use the SIDECARR_ prefix.

The API key must be sent to Scriberr as X-API-Key. The sidecar never places the key, transcript, or summary content in MQTT messages or logs.

When SIDECARR_AUTOGENERATE_SUMMARY=true, SIDECARR_SUMMARY_TEMPLATE selects a Scriberr summary template by name (default: Default). The template supplies the prompt and model; set SIDECARR_SUMMARY_MODEL to override the template's model.

## Run with the published image

The default docker-compose.yml uses:

    docker.io/jordanmarchetto/scriberr-sidecarr:latest

It is intended as a reference service definition that can be copied into the existing Scriberr Compose project. Mount the transcript directory read-only and persist /app/data on local disk.

    cp .env.sample .env
    docker compose up -d

The public-image Compose file uses the host-side overrides SIDECARR_TRANSCRIPTS_HOST_PATH and SIDECARR_DATA_HOST_PATH when the defaults do not match the deployment.

## Build locally

Use docker-compose.local.yml to build from the checked-out source:

    docker compose -f docker-compose.local.yml up --build

## Scriberr webhooks

The sidecar accepts Scriberr lifecycle webhooks at:

    http://scriberr-sidecarr:8080/webhooks/scriberr

Use that URL when Scriberr and the sidecar share a Docker network. Configure the same long random secret in Scriberr and as SIDECARR_WEBHOOK_SECRET. The receiver verifies Scriberr's HMAC-SHA256 signature against the raw request body and deduplicates retries using X-Scriberr-Delivery.

The listener host, port, and path are configurable with SIDECARR_WEBHOOK_HOST, SIDECARR_WEBHOOK_PORT, and SIDECARR_WEBHOOK_PATH. If SIDECARR_WEBHOOK_SECRET is empty or unset, unsigned webhooks are accepted; only use that mode on a trusted internal network.

Webhook signals are persisted before the request is acknowledged, then the sidecar queries Scriberr's authenticated API for authoritative state and publishes the existing MQTT event format. The filesystem scanner remains enabled as a fallback.

The container exposes port 8080 to its Docker network without publishing it on the host. If Scriberr runs on a different Docker network, connect the services to a shared network or explicitly publish the webhook port.

GET /health returns a small health response for container checks.

## Events

Events are published at SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/{event_name} with QoS and retention controlled by configuration. For example: home/audio/scriberr/123e4567-e89b-12d3-a456-426614174000/summary_complete. Subscribe to SIDECARR_MQTT_TOPIC_PREFIX/+/# to receive all job events or SIDECARR_MQTT_TOPIC_PREFIX/{job_id}/# to follow one job. Messages contain job metadata only, including Scriberr's title when available. Transcription and summary lifecycle events are tracked independently, and a Scriberr rerun creates a new attempt so later success events are not suppressed by an earlier failure.
