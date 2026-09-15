# Configuration and discovery

Start with [.env.sample](../.env.sample). This page explains the settings that usually need context.

Sidecarr currently continues to use `.env` as its user-facing configuration interface. Internally, settings now resolve per field as `environment > Sidecarr database > built-in default` in preparation for the optional UI. Environment values always win and are never copied into SQLite. Until the settings UI is released, do not edit the `application_settings` table manually.

Missing Scriberr credentials leave `/health` available and pause background processing instead of terminating the container. An incomplete optional MQTT, Notion, SMTP, or notification-webhook section disables that integration and logs the affected environment-variable names without logging secret values.

## Scriberr connection

`SIDECARR_SCRIBERR_URL` is the Docker-internal API address. `SIDECARR_SCRIBERR_PUBLIC_URL` is the browser-facing base URL used in links. The API key is sent to Scriberr as `X-API-Key`.

Safe API reads retry transient network errors and HTTP 408, 429, and 5xx responses with bounded backoff. These settings tune that behavior:

```dotenv
SIDECARR_API_TIMEOUT_SECONDS=15
SIDECARR_API_MAX_ATTEMPTS=3
SIDECARR_API_RETRY_BASE_MILLISECONDS=500
```

Summary-creation and webhook-creation requests are not automatically retried because a retry could create duplicate work.

## Discovery modes

Webhook discovery is recommended:

```dotenv
SIDECARR_DISCOVERY_MODE=webhook
```

Sidecarr creates and maintains its own signed Scriberr webhook. If the webhook-management API does not exist, as with unmodified Scriberr, it logs the compatibility fallback and uses filesystem discovery plus API polling.

To skip webhook registration explicitly:

```dotenv
SIDECARR_DISCOVERY_MODE=filesystem
SIDECARR_WATCH_FOLDER=/watch/transcripts
SIDECARR_SCAN_INTERVAL_SECONDS=30
```

Both modes use Scriberr's authenticated API as the authoritative source of job state.

Every five minutes, Sidecarr also checks Scriberr's list endpoint for recently updated jobs that the primary discovery path may have missed. The first run records a baseline rather than importing historical jobs. Adjust the interval if needed:

```dotenv
SIDECARR_RECONCILIATION_INTERVAL_SECONDS=300
```

## Scriberr readiness

Sidecarr starts its own listener immediately, then checks Scriberr's `/health` endpoint once per processing interval. Until Scriberr is reachable, webhook registration, filesystem scanning, and job API requests remain paused. One message is logged when waiting begins and another when Scriberr becomes available.

This behavior also applies if Scriberr becomes unavailable later. A Scriberr version without a `/health` route is treated as reachable once it returns an HTTP response, allowing the normal compatibility checks to proceed.

## Advanced webhook overrides

Most installations should omit these values:

| Variable | Default |
| --- | --- |
| `SIDECARR_WEBHOOK_CALLBACK_URL` | `http://scriberr-sidecarr:8080/webhooks/scriberr` |
| `SIDECARR_WEBHOOK_HOST` | `0.0.0.0` |
| `SIDECARR_WEBHOOK_PORT` | `8080` |
| `SIDECARR_WEBHOOK_PATH` | `/webhooks/scriberr` |
| `SIDECARR_WEBHOOK_SECRET` | Generated and persisted |

Override the callback URL if the Docker service is not named `scriberr-sidecarr`. Keep the callback reachable only from a trusted network.

## Summary generation

When Scriberr auto-summary is enabled, Scriberr owns summary generation and Sidecarr waits for it. Otherwise, Sidecarr can request a summary:

```dotenv
SIDECARR_AUTOGENERATE_SUMMARY=true
SIDECARR_SUMMARY_TEMPLATE=Default
SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS=30
SIDECARR_SUMMARY_TIMEOUT_SECONDS=3600
```

`SIDECARR_SUMMARY_MODEL` may override the selected template's model. If neither Scriberr nor Sidecarr is configured to generate summaries, transcription is the terminal state.
