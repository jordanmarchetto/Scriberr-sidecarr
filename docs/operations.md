# Operations

## Health and metrics

`GET /health` returns HTTP 200 while the listener is running and is used by the image's Docker health check. It also reports whether Scriberr is ready without making an upstream outage look like a Sidecarr failure:

```json
{"status":"ok","scriberr":"waiting"}
```

The `scriberr` value changes to `ready` after the upstream service becomes reachable.

`GET /metrics` exposes Prometheus-compatible counts for tracked jobs, pending work, failures, discovery sources, and processing durations. Keep both endpoints on a trusted Docker network unless an authenticated reverse proxy protects them.

## Logs

Sidecarr writes structured JSON to standard output:

```bash
docker compose logs -f scriberr-sidecarr
```

The default `LOG_LEVEL=info` records startup configuration, discovery changes, job transitions, retries, and failures. Temporarily use `LOG_LEVEL=debug` for accepted webhooks, queued events, and successful MQTT publications.

Repeated connection-level retry warnings are limited to one per minute during an outage. Distinct HTTP failures remain visible.

Logs contain identifiers and state metadata, but not configured credentials, transcript or summary text, or audio.

## Troubleshooting in the UI

Open `/sidecarr` and use Overview for dependency health and recent actionable failures. Select a failure or open Jobs to inspect a recording's state history, processing attempts, Notion operations, MQTT publication, and notification delivery. The job page links back to Scriberr and to the managed Notion page when one exists.

The job page can request re-transcription with the job's previous Scriberr settings, cancel a queued request, dismiss a Notion warning, or recreate a missing managed Notion page. Mutations require an authenticated Scriberr browser session, same-origin protection, and explicit confirmation for re-transcription. Errors shown in the UI are sanitized; transcript, summary, credential, and raw delivery payloads are not exposed by its APIs.

For an actively processing job, leave its detail page visible to receive a slow automatic refresh. Hidden browser tabs stop polling. Manual refresh is always available.

## Releases

Pushes to `main` publish `latest` and commit-SHA image tags. A tag such as `v0.2.0` publishes `0.2.0` and `0.2` images.

Pushes to `feature/**` publish a temporary branch image. Slashes become dashes; for example, `feature/job-ready-notifications` publishes:

```text
jordanmarchetto/scriberr-sidecarr:feature-job-ready-notifications
```

Every publish also produces the same tags for the optional preconfigured gateway image:

```text
jordanmarchetto/scriberr-sidecarr-router:feature-job-ready-notifications
```

Use matching full version tags for Sidecarr and its router in production so upgrades are explicit. The router starts independently and tolerates either upstream being unavailable. Before a multi-service rollout, verify that the chosen Scriberr and Sidecarr versions are compatible and confirm deployment ordering with the deployment owner.
