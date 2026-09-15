# Sidecarr UI

The optional UI is served at `/sidecarr` by the same listener that receives Scriberr webhooks. It currently provides the authenticated application shell, connection setup, responsive navigation, and light/dark themes. Settings and job details arrive in later checkpoints.

## Authentication

The browser uses the current Scriberr user session. Sidecarr asks Scriberr to validate that session and never accepts `SIDECARR_SCRIBERR_API_KEY` as browser authentication. If no current session exists, the login form sends the credentials directly to Scriberr; Sidecarr never receives or stores the password.

The unattended worker still needs a dedicated Scriberr API key. A working environment-provided key bypasses setup. When no key exists, an authenticated user can let Sidecarr create `Scriberr Sidecarr` through Scriberr's API and store it in the protected Sidecarr SQLite volume. An environment-provided key cannot be replaced from the UI.

## Recommended: bundled gateway

Scriberr and Sidecarr remain separate containers on the same Docker network. The preconfigured `scriberr-sidecarr-router` image gives them one browser address without requiring another configuration file:

```text
https://scriberr.example.com/             -> Scriberr
https://scriberr.example.com/sidecarr/... -> Sidecarr
```

Add this service to the Compose project containing Scriberr and Sidecarr:

```yaml
services:
  scriberr-router:
    image: docker.io/jordanmarchetto/scriberr-sidecarr-router:latest
    restart: unless-stopped
    ports:
      - "8383:8080"
```

Remove Scriberr's host mapping for port `8383` so the router owns it. Scriberr may retain `expose: 8080`. The router expects Docker service names `scriberr` and `scriberr-sidecarr`, both reachable on its network. It deliberately has no startup dependency on either application: Scriberr remains reachable through the gateway when Sidecarr is unavailable, and upstream requests recover automatically as each application starts.

Users with an existing reverse proxy can omit `ports` and point that proxy at `http://scriberr-router:8080`. The external proxy needs only a single catch-all hostname rule; the bundled router handles `/sidecarr` internally. The router image is published with the same `latest`, feature-branch, version, and commit tags as Sidecarr, so pin both images to matching tags when using a pinned release.

The repository's Compose files define this service under the opt-in `gateway` profile to avoid taking port `8383` from an existing deployment unexpectedly:

```bash
docker compose --profile gateway up -d
```

## Alternative: existing reverse-proxy rules

Instead of running the bundled gateway, an existing proxy can route `/sidecarr` directly to Sidecarr. Do not strip `/sidecarr`, and give this route higher priority than Scriberr's catch-all route. For Traefik using a shared Docker network and file-provider configuration:

```yaml
http:
  routers:
    scriberr-sidecarr-router:
      rule: "Host(`scriberr.example.com`) && PathPrefix(`/sidecarr`)"
      priority: 100
      service: scriberr-sidecarr-service

  services:
    scriberr-sidecarr-service:
      loadBalancer:
        servers:
          - url: "http://scriberr-sidecarr:8080"
```

## Alternative: inline gateway configuration

To use the upstream Caddy image without the preconfigured router image, modern Docker Compose releases can keep the routing rules inside `docker-compose.yml`:

```yaml
services:
  scriberr-router:
    image: caddy:2-alpine
    ports:
      - "8383:8080"
    configs:
      - source: scriberr_gateway
        target: /etc/caddy/Caddyfile

configs:
  scriberr_gateway:
    content: |
      :8080 {
        @sidecarr path /sidecarr /sidecarr/*
        handle @sidecarr {
          reverse_proxy scriberr-sidecarr:8080
        }
        handle {
          reverse_proxy scriberr:8080
        }
      }
```

The inline `content` form requires Docker Compose 2.23.1 or newer.

The internal `/webhooks/scriberr` callback is unchanged and does not need public routing. `/health` and `/metrics` should remain private unless separately protected.

The bundled router currently expects the default `/sidecarr` path. If deployment-owned `SIDECARR_UI_BASE_PATH` overrides it, use custom inline or external proxy rules to match. Same-origin operation is required for this initial authentication model.
