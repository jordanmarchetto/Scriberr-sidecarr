import Database from "better-sqlite3";
import { sanitizeError } from "./errors.js";
import type { JobRow, ScriberrWebhookPayload, SidecarState, WebhookSignalRow } from "./types.js";

export type PendingEvent = {
  id: number;
  job_id: string;
  event_type: string;
  occurrence_key: string;
  payload_json: string;
  publish_attempts: number;
};

export class StateStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        transcript_folder TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT,
        last_checked_at TEXT,
        scriberr_status TEXT,
        sidecar_state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        transcription_event_at TEXT,
        summary_event_at TEXT,
        summary_requested_at TEXT,
        summary_started_at TEXT,
        summary_deadline_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        published_at TEXT,
        publish_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(job_id, event_type, occurrence_key)
      );

      CREATE INDEX IF NOT EXISTS events_pending_idx ON events(published_at, id);

      CREATE TABLE IF NOT EXISTS webhook_signals (
        delivery_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        error_message TEXT,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS webhook_signals_pending_idx
        ON webhook_signals(processed_at, received_at);
    `);
    const signalColumns = this.db.prepare("PRAGMA table_info(webhook_signals)").all() as Array<{ name: string }>;
    if (!signalColumns.some((column) => column.name === "error_message")) {
      this.db.exec("ALTER TABLE webhook_signals ADD COLUMN error_message TEXT");
    }

  }

  close(): void {
    this.db.close();
  }

  discover(jobId: string, folder: string, now: string, source = "filesystem"): { inserted: boolean; job: JobRow } {
    const existing = this.getJob(jobId);
    if (existing) {
      this.db.prepare(`
        UPDATE jobs
        SET last_seen_at = ?, transcript_folder = CASE WHEN ? <> '' THEN ? ELSE transcript_folder END, updated_at = ?
        WHERE job_id = ?
      `).run(now, folder, folder, now, jobId);
      return { inserted: false, job: this.getJob(jobId)! };
    }
    this.db.prepare(`
      INSERT INTO jobs (job_id, source, transcript_folder, first_seen_at, last_seen_at,
        sidecar_state, attempt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'discovered', 1, ?, ?)
    `).run(jobId, source, folder, now, now, now, now);
    return { inserted: true, job: this.getJob(jobId)! };
  }

  recordWebhookSignal(deliveryId: string, payload: ScriberrWebhookPayload, receivedAt: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_signals
        (delivery_id, job_id, event_type, occurred_at, received_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(deliveryId, payload.job_id, payload.event, payload.occurred_at, receivedAt, payload.error ? sanitizeError(payload.error) : null);
    return result.changes === 1;
  }

  pendingWebhookSignals(limit = 100): WebhookSignalRow[] {
    return this.db.prepare(`
      SELECT delivery_id, job_id, event_type, occurred_at, received_at, error_message
      FROM webhook_signals
      WHERE processed_at IS NULL
      ORDER BY received_at
      LIMIT ?
    `).all(limit) as WebhookSignalRow[];
  }

  markWebhookSignalsProcessed(deliveryIds: string[], now: string): void {
    if (deliveryIds.length === 0) return;
    const placeholders = deliveryIds.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE webhook_signals SET processed_at = ?
      WHERE delivery_id IN (${placeholders})
    `).run(now, ...deliveryIds);
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  listJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY first_seen_at").all() as JobRow[];
  }

  jobStateCounts(): Array<{ sidecar_state: string; count: number }> {
    return this.db.prepare(`
      SELECT sidecar_state, COUNT(*) AS count
      FROM jobs
      GROUP BY sidecar_state
      ORDER BY sidecar_state
    `).all() as Array<{ sidecar_state: string; count: number }>;
  }

  pendingEventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE published_at IS NULL").get() as { count: number };
    return row.count;
  }

  pendingWebhookSignalCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM webhook_signals WHERE processed_at IS NULL").get() as { count: number };
    return row.count;
  }

  updateJob(jobId: string, fields: Partial<JobRow>): void {
    const entries = Object.entries(fields).filter(([key]) => key !== "job_id");
    if (entries.length === 0) return;
    const set = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${set}, updated_at = @updated_at WHERE job_id = @job_id`).run({
      ...Object.fromEntries(entries),
      updated_at: new Date().toISOString(),
      job_id: jobId
    });
  }

  startNewAttempt(jobId: string, now: string): JobRow {
    this.db.prepare(`UPDATE jobs SET
      attempt = attempt + 1,
      sidecar_state = 'pending_transcription',
      scriberr_status = NULL,
      transcription_event_at = NULL,
      summary_event_at = NULL,
      summary_requested_at = NULL,
      summary_started_at = NULL,
      summary_deadline_at = NULL,
      last_error = NULL,
      updated_at = ?
      WHERE job_id = ?`).run(now, jobId);
    return this.getJob(jobId)!;
  }

  ensureEvent(job: JobRow, eventType: string, payload: object): void {
    const now = new Date().toISOString();
    const occurrenceKey = `${job.attempt}:${eventType}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO events
        (job_id, event_type, occurrence_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.job_id, eventType, occurrenceKey, JSON.stringify(payload), now);
  }

  pendingEvents(limit = 100): PendingEvent[] {
    return this.db.prepare(`
      SELECT id, job_id, event_type, occurrence_key, payload_json, publish_attempts
      FROM events WHERE published_at IS NULL ORDER BY id LIMIT ?
    `).all(limit) as PendingEvent[];
  }

  recordPublishAttempt(id: number, error?: string): void {
    this.db.prepare(`
      UPDATE events SET publish_attempts = publish_attempts + 1, last_error = ? WHERE id = ?
    `).run(error ?? null, id);
  }

  markPublished(id: number, now: string): void {
    this.db.prepare("UPDATE events SET published_at = ?, last_error = NULL WHERE id = ?").run(now, id);
  }
}
