export type ScriberrStatus = "uploaded" | "pending" | "processing" | "completed" | "failed" | string;

export type ScriberrJob = {
  id: string;
  status: ScriberrStatus;
  title?: string | null;
  transcript?: string | null;
  summary?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ScriberrSummary = {
  transcription_id?: string;
  content?: string | null;
};

export type SidecarState =
  | "discovered"
  | "pending_transcription"
  | "processing_transcription"
  | "transcription_complete"
  | "summary_pending"
  | "summary_processing"
  | "summary_complete"
  | "transcription_failed"
  | "summary_failed";

export type JobRow = {
  job_id: string;
  source: string;
  transcript_folder: string;
  first_seen_at: string;
  last_seen_at: string | null;
  last_checked_at: string | null;
  scriberr_status: string | null;
  sidecar_state: SidecarState;
  attempt: number;
  transcription_event_at: string | null;
  summary_event_at: string | null;
  summary_requested_at: string | null;
  summary_started_at: string | null;
  summary_deadline_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type ScriberrSummaryTemplate = {
  id: string;
  name: string;
  model?: string | null;
  prompt: string;
  include_speaker_info?: boolean;
};
