# Events and job-ready notifications

`job_ready` means a processing attempt is as complete as Sidecarr can make it automatically: the transcript exists, an expected summary exists, and managed Notion work has settled. Skipped audio or a terminal summary failure produces `ready_with_warnings`.

Historical terminal jobs are suppressed when the feature is first enabled, avoiding a notification burst. A later rerun is eligible normally.

## MQTT

MQTT is disabled when `SIDECARR_MQTT_URL` is omitted. When enabled, events publish to:

```text
{SIDECARR_MQTT_TOPIC_PREFIX}/{job_id}/{event_name}
```

Example configuration:

```dotenv
SIDECARR_MQTT_URL=mqtt://mosquitto:1883
SIDECARR_MQTT_USERNAME=
SIDECARR_MQTT_PASSWORD=
SIDECARR_MQTT_TOPIC_PREFIX=home/audio/scriberr
SIDECARR_MQTT_QOS=1
SIDECARR_MQTT_RETAIN=false
```

Subscribe to `{prefix}/+/#` for all jobs. Messages contain metadata and links, never transcripts, summaries, audio, or credentials.

Lifecycle events include transcription, summary, `job_ready`, and these optional Notion steps:

- `notebook_page_created`
- `notebook_page_moved`
- `notebook_status_updated`
- `notebook_audio_attached` or `notebook_audio_skipped`
- `notebook_version_archived`
- `notebook_transcript_updated`
- `notebook_summary_updated`
- `notebook_sync_failed`

## Outbound webhook

```dotenv
SIDECARR_NOTIFICATION_WEBHOOK_URL=https://automation.example.com/webhook/scriberr-ready
SIDECARR_NOTIFICATION_WEBHOOK_TOKEN=replace-me
```

The token is an optional Bearer token. Requests include an `Idempotency-Key` header and retry at most three times. The endpoint can be n8n, Pipedream, Apprise, or any ordinary HTTP receiver.

Example body:

```json
{
  "event": "job_ready",
  "job_id": "123e4567-e89b-12d3-a456-426614174000",
  "title": "Doctor appointment",
  "outcome": "ready",
  "attempt": 1,
  "notion_url": "https://www.notion.so/example",
  "scriberr_url": "https://scriberr.example.com/audio/123e4567-e89b-12d3-a456-426614174000",
  "occurred_at": "2026-09-14T12:00:00.000Z"
}
```

## Direct email

```dotenv
SIDECARR_SMTP_URL=smtps://username:password@smtp.example.com:465
SIDECARR_EMAIL_FROM=Scriberr <scriberr@example.com>
SIDECARR_EMAIL_TO=you@example.com
SIDECARR_EMAIL_SUBJECT_TEMPLATE=Scriberr job ready: {title}
```

Use `smtp://...:587` for STARTTLS or `smtps://...:465` for implicit TLS. URL-encode special characters in credentials. The subject supports `{title}` and `{outcome}`. Email contains status and links, not transcript or summary content, and retries at most three times.
