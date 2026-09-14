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

Logs contain identifiers and state metadata, but not configured credentials, transcript or summary text, or audio.

## Releases

Pushes to `main` publish `latest` and commit-SHA image tags. A tag such as `v0.2.0` publishes `0.2.0` and `0.2` images.

Pushes to `feature/**` publish a temporary branch image. Slashes become dashes; for example, `feature/job-ready-notifications` publishes:

```text
jordanmarchetto/scriberr-sidecarr:feature-job-ready-notifications
```

Use full version tags for production so upgrades are explicit. Before a multi-service rollout, verify that the chosen Scriberr and Sidecarr versions are compatible and confirm deployment ordering with the deployment owner.
