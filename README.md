# Scriberr Sidecarr

Scriberr Sidecarr watches Scriberr jobs and sends their results to the services you choose. It does not transcribe audio itself.

```mermaid
flowchart LR
    S[Scriberr] -->|webhooks| C[Sidecarr]
    F[Transcript folder] -. fallback discovery .-> C
    C -->|API checks and summary requests| S
    C --> N[Notion]
    C --> M[MQTT]
    C --> E[Email]
    C --> W[Webhook / n8n]
```

## What it does

With the webhook and auto-summary Scriberr fork, Sidecarr mostly listens for lifecycle changes, updates Notion, and publishes notifications.

With unmodified Scriberr, it watches the transcript directory, polls the Scriberr API, and can request missing summaries. Webhook mode falls back to this behavior automatically when Scriberr does not support webhooks.

In both modes, SQLite prevents duplicate work across restarts. MQTT, Notion, email, and outbound webhooks are all optional.

Sidecarr also provides an optional responsive UI at `/sidecarr`. It uses your existing Scriberr login and does not introduce another user account. The bundled router can put Scriberr and Sidecarr on one port without requiring an existing reverse proxy; see [Sidecarr UI](docs/ui.md).

## Quick start

Sidecarr and Scriberr must share a Docker network. They may be in the same Compose project or separate projects on the same external network.

```bash
cp .env.sample .env
```

Set these required values:

```dotenv
SIDECARR_SCRIBERR_URL=http://scriberr:8080
SIDECARR_SCRIBERR_PUBLIC_URL=https://scriberr.example.com
SIDECARR_SCRIBERR_API_KEY=replace-me
```

`SIDECARR_SCRIBERR_URL` is the Docker-internal address. `SIDECARR_SCRIBERR_PUBLIC_URL` is the address people use in a browser and is used for links in Notion and notifications.

Then start the service:

```bash
docker compose up -d
docker compose logs -f scriberr-sidecarr
```

The defaults use webhook discovery with automatic filesystem fallback. The transcript directory and SQLite data directory are configured in `docker-compose.yml`.

For direct browser access to both applications on port `8383`, remove Scriberr's host port mapping and start the bundled gateway profile:

```bash
docker compose --profile gateway up -d
```

Then open Scriberr normally at `http://server:8383` and Sidecarr at `http://server:8383/sidecarr`. Both services must use the same Docker network and the Scriberr service must be named `scriberr`.

The gateway wraps Scriberr's service worker so Scriberr keeps its PWA behavior without capturing `/sidecarr`. This is a documented compatibility boundary; see [Sidecarr UI](docs/ui.md).

## Optional destinations

Enable only the destinations you want in `.env`:

```dotenv
# MQTT lifecycle events
SIDECARR_MQTT_URL=mqtt://mosquitto:1883

# Notion pages
SIDECARR_NOTEBOOK_PROVIDER=notion
SIDECARR_NOTION_TOKEN=secret_replace-me
SIDECARR_NOTION_PARENT_PAGE_URL=https://www.notion.so/your-parent-page-id

# Direct job-ready email
SIDECARR_SMTP_URL=smtps://username:password@smtp.example.com:465
SIDECARR_EMAIL_FROM=Scriberr <scriberr@example.com>
SIDECARR_EMAIL_TO=you@example.com

# Job-ready webhook, including n8n
SIDECARR_NOTIFICATION_WEBHOOK_URL=https://automation.example.com/webhook/scriberr-ready
```

Omit a destination's settings to disable it. See [.env.sample](.env.sample) for the full list of common settings.

## Documentation

- [Configuration and discovery](docs/configuration.md)
- [Notion](docs/notion.md)
- [Events and job-ready notifications](docs/notifications.md)
- [Operations, releases, and troubleshooting](docs/operations.md)
- [Sidecarr UI and gateway setup](docs/ui.md)

## Development

```bash
npm install
npm test
docker compose -f docker-compose.local.yml up --build
```
