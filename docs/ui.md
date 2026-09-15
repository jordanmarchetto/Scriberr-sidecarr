# Sidecarr UI

The optional UI is served at `/sidecarr` by the same listener that receives Scriberr webhooks. It currently provides the authenticated application shell, connection setup, responsive navigation, and light/dark themes. Settings and job details arrive in later checkpoints.

## Authentication

The browser uses the current Scriberr user session. Sidecarr asks Scriberr to validate that session and never accepts `SIDECARR_SCRIBERR_API_KEY` as browser authentication. If no current session exists, the login form sends the credentials directly to Scriberr; Sidecarr never receives or stores the password.

The unattended worker still needs a dedicated Scriberr API key. A working environment-provided key bypasses setup. When no key exists, an authenticated user can let Sidecarr create `Scriberr Sidecarr` through Scriberr's API and store it in the protected Sidecarr SQLite volume. An environment-provided key cannot be replaced from the UI.

## Same-origin routing

Scriberr and Sidecarr remain separate containers on the same Docker network. Route the UI path under the same browser hostname as Scriberr:

```text
https://scriberr.example.com/             -> Scriberr
https://scriberr.example.com/sidecarr/... -> Sidecarr
```

Do not strip `/sidecarr`. Give its router higher priority than Scriberr's catch-all route. For Traefik using a shared Docker network and file-provider configuration:

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

The internal `/webhooks/scriberr` callback is unchanged and does not need public routing. `/health` and `/metrics` should remain private unless separately protected.

The deployment-owned `SIDECARR_UI_BASE_PATH` may override `/sidecarr`; update the reverse-proxy rule to match. Same-origin operation is required for this initial authentication model.
