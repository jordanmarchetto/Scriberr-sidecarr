# Notion

The optional Notion destination maintains one normal, editable page per Scriberr job. It does not use a Notion database.

## Setup

1. Create a Notion internal integration with permission to read, insert, and update content.
2. Create a normal parent page and share it with the integration.
3. Configure Sidecarr:

```dotenv
SIDECARR_NOTEBOOK_PROVIDER=notion
SIDECARR_NOTION_TOKEN=secret_your_integration_token
SIDECARR_NOTION_PARENT_PAGE_URL=https://www.notion.so/your-parent-page-id
```

The token and parent page are both required when Notion is enabled.

## Page behavior

Sidecarr progressively adds status, metadata, editable classification fields, audio, a user-owned Notes area, summary, transcript, and archived rerun attempts. It only replaces blocks it owns, so user-written content is preserved.

After transcription completes, Sidecarr asks Scriberr's configured model for a short subject and uses a dated display title such as `9/29/2026 - ENT Appointment` in Sidecarr, Notion, and readiness notifications. The temporary Scriberr chat session is deleted immediately, the original Scriberr title remains unchanged as filename metadata, and title-generation failures fall back to that original title without blocking the job.

The appointment page and Full Transcript subpage include **Re-transcribe in Sidecarr** links. They open the authenticated Sidecarr job page with a confirmation dialog; simply opening the link never starts work.

Audio is downloaded through Scriberr's authenticated API. No uploads-directory mount is needed. Notion simple uploads are limited to 20 MiB; if a recording is too large or its format is rejected, the page explains the omission and links to Scriberr. Transcript and summary updates still continue.

Existing tracked jobs are not imported when Notion is first enabled. To import them intentionally, set:

```dotenv
SIDECARR_NOTION_BACKFILL=true
```

If the parent page changes, Sidecarr moves only pages it created or recovered using its job marker.

Notion operations retry up to three times. A terminal failure emits `notebook_sync_failed` without stopping discovery, summary coordination, or other destinations. Job details can dismiss an intentional historical failure or recreate a managed page that was deleted or unshared.
