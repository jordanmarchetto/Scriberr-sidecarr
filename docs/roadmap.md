# Roadmap and Current Status

> Last audited: 2026-10-01, through PR #16 (`90ee879`). This is the canonical source for shipped capabilities and planned work. “Shipped” means merged to `main` and published in its image; a particular Docker stack may still need to pull and recreate its container. Local phase documents under `scratch/` preserve design rationale and historical delivery plans.

## Shipped

- Signed Scriberr webhook discovery with automatic filesystem/API fallback and missed-job reconciliation.
- Durable lifecycle state, bounded retries, terminal-job polling suppression, health checks, metrics, and optional MQTT events.
- Progressive Notion pages with audio or a fallback link, recording metadata, summary, transcript, user-owned Notes, classification scaffolding, and archived processing attempts.
- Durable `job_ready` notifications through optional MQTT, webhook, and SMTP destinations.
- Responsive authenticated Sidecarr UI for setup, settings, health, recent jobs, warnings, attempt history, and delivery outcomes.
- Likely-duplicate warnings for the same filename (case-insensitive, ignoring outer whitespace) discovered within one hour.
- Re-transcription from Sidecarr or a managed Notion page, including queued cancellation during summary work and preservation of prior Notion content.
- Recovery actions for dismissed Notion warnings and missing managed pages.
- Sidecarr-owned dated titles generated through Scriberr's configured model, while preserving the original Scriberr filename.
- Stable deep links from Notion to Sidecarr job details.

## Next: resolve likely duplicates

Detection is shipped; cleanup is not. The next product slice should turn a warning into an explicit, reviewable workflow:

1. Present every same-filename/one-hour candidate together.
2. Recommend the longest recording as canonical, breaking ties by size and recency.
3. Preview every Scriberr job, managed Notion page, and Sidecarr record that would be affected.
4. Require confirmation before any destructive action.
5. Keep a minimal audit record of the canonical job and superseded jobs.

Before implementation, decide whether the first version permanently deletes superseded Scriberr jobs or marks them superseded and archives their Notion pages. Sidecarr must never delete candidates automatically.

## Later product work

### Combine related recordings into one appointment

Several intentional recordings from one appointment—such as separate conversations with a nurse, nurse practitioner, and doctor—should be able to contribute to one appointment-level Notion page. This is aggregation, not duplicate cleanup: every source recording remains valid. Define appointment identity, ordering, combined summaries, notifications, and the fate of existing per-recording pages before implementation.

### Classification and correction

- Infer person, appointment type, and tags with confidence and human review.
- Keep user-confirmed values authoritative.
- Preserve raw Scriberr output and represent corrections as versioned overlays.
- Keep speaker mappings recording-specific.
- Allow one active content revision per job initially and produce a new readiness transition when it settles.
- Decide how direct Notion edits and summary regeneration participate before implementation.

### Notifications and follow-up

- Add failure-specific alerts if operational experience shows they are needed.
- Consider interactive clarification for ambiguous classifications only after authentication, privacy, retry, and reply-routing behavior are defined.

## Operational backlog

- Shared logging/observability utilities if current structured logs become difficult to evolve consistently.
- Adaptive polling intervals.
- Uptime Kuma monitors, alerting, and a small metrics dashboard.
- Configurable job-ID matching for nonstandard Scriberr directory layouts.
- Multi-architecture images if deployment expands beyond the current host architecture.
- Configuration audit history.
- Notebook-provider migration or continued synchronization across providers.
- Separate-host authentication and finer-grained authorization.
- Stronger notification-delivery recovery and manual resend/resync actions.
- Retention and privacy controls for audio, transcripts, and summaries.

## Documentation map

- `docs/*.md` describes supported operation and configuration.
- `scratch/phase-1-architecture.md` and `scratch/phase-2-architecture.md` preserve discovery and lifecycle design history.
- `scratch/phase-3-*` records the implemented Notion design.
- `scratch/phase-4-*` records the implemented readiness/notification design.
- `scratch/phase-5-*` records the implemented UI design and its deferred correction model.
- `scratch/post-mvp.md` contains the original duplicate-recording incident and now points planning back to this roadmap.
