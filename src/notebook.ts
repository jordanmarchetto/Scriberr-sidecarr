import type { JobRow, ScriberrJob } from "./types.js";

export const notebookEventTypes = [
  "notebook_page_created",
  "notebook_page_moved",
  "notebook_status_updated",
  "notebook_audio_attached",
  "notebook_audio_skipped",
  "notebook_version_archived",
  "notebook_transcript_updated",
  "notebook_summary_updated",
  "notebook_sync_failed"
] as const;

export type NotebookEventType = typeof notebookEventTypes[number];

export type NotebookOutcome = {
  event: NotebookEventType;
  operation: string;
  occurrenceKey: string;
  pageId?: string;
  pageUrl?: string;
  error?: string;
};

export interface NotebookPublisher {
  readonly provider: string;
  readonly reconciliationKey?: string;
  sync(job: ScriberrJob, row: JobRow): Promise<NotebookOutcome[]>;
}
