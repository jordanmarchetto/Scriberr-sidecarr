import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
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

export type NotificationDestination = "webhook" | "smtp";

export type NotificationDeliveryRow = {
  id: number;
  job_id: string;
  attempt: number;
  destination: NotificationDestination;
  payload_json: string;
  attempts: number;
};

export type NotebookPageRow = {
  job_id: string;
  provider: string;
  parent_page_id: string;
  page_id: string;
  page_url: string;
  current_attempt: number;
  status_block_id: string;
  metadata_table_id: string;
  classification_table_id: string;
  person_row_id: string;
  appointment_type_row_id: string;
  tags_row_id: string;
  review_status_row_id: string;
  person_value: string | null;
  person_provenance: string;
  appointment_type_value: string | null;
  appointment_type_provenance: string;
  tags_value: string | null;
  tags_provenance: string;
  review_status_value: string | null;
  review_status_provenance: string;
  classification_checked_at: string | null;
  audio_container_id: string;
  audio_block_id: string | null;
  audio_state: string;
  summary_container_id: string;
  summary_block_ids_json: string;
  summary_hash: string | null;
  transcript_page_id: string;
  transcript_block_ids_json: string;
  transcript_hash: string | null;
  versions_container_id: string;
  last_status: string | null;
  last_title: string | null;
  created_at: string;
  updated_at: string;
};

export type NotebookOperationRow = {
  id: number;
  job_id: string;
  provider: string;
  operation_key: string;
  operation: string;
  attempts: number;
  status: "pending" | "completed" | "failed";
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class StateStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
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
        summary_expected INTEGER,
        job_ready_at TEXT,
        job_ready_outcome TEXT,
        job_ready_suppressed INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notebook_pages (
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        parent_page_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        page_url TEXT NOT NULL,
        current_attempt INTEGER NOT NULL,
        status_block_id TEXT NOT NULL,
        metadata_table_id TEXT NOT NULL,
        classification_table_id TEXT NOT NULL,
        person_row_id TEXT NOT NULL,
        appointment_type_row_id TEXT NOT NULL,
        tags_row_id TEXT NOT NULL,
        review_status_row_id TEXT NOT NULL,
        person_value TEXT,
        person_provenance TEXT NOT NULL DEFAULT 'unset',
        appointment_type_value TEXT,
        appointment_type_provenance TEXT NOT NULL DEFAULT 'unset',
        tags_value TEXT,
        tags_provenance TEXT NOT NULL DEFAULT 'unset',
        review_status_value TEXT,
        review_status_provenance TEXT NOT NULL DEFAULT 'automatic',
        classification_checked_at TEXT,
        audio_container_id TEXT NOT NULL,
        audio_block_id TEXT,
        audio_state TEXT NOT NULL DEFAULT 'pending',
        summary_container_id TEXT NOT NULL,
        summary_block_ids_json TEXT NOT NULL DEFAULT '[]',
        summary_hash TEXT,
        transcript_page_id TEXT NOT NULL,
        transcript_block_ids_json TEXT NOT NULL DEFAULT '[]',
        transcript_hash TEXT,
        versions_container_id TEXT NOT NULL,
        last_status TEXT,
        last_title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, provider),
        UNIQUE(provider, page_id)
      );

      CREATE TABLE IF NOT EXISTS notebook_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, provider, operation_key)
      );

      CREATE INDEX IF NOT EXISTS notebook_operations_pending_idx
        ON notebook_operations(status, id);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, attempt, destination)
      );

      CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx
        ON notification_deliveries(delivered_at, attempts, id);
    `);
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "summary_expected")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN summary_expected INTEGER");
    }
    if (!jobColumns.some((column) => column.name === "job_ready_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN job_ready_at TEXT");
    }
    if (!jobColumns.some((column) => column.name === "job_ready_outcome")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN job_ready_outcome TEXT");
    }
    if (!jobColumns.some((column) => column.name === "job_ready_suppressed")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN job_ready_suppressed INTEGER NOT NULL DEFAULT 0");
    }
    const signalColumns = this.db.prepare("PRAGMA table_info(webhook_signals)").all() as Array<{ name: string }>;
    if (!signalColumns.some((column) => column.name === "error_message")) {
      this.db.exec("ALTER TABLE webhook_signals ADD COLUMN error_message TEXT");
    }

    const readyMigration = this.db.prepare("SELECT value FROM settings WHERE key = 'job_ready_initialized_v1'").get();
    if (!readyMigration) {
      this.db.transaction(() => {
        this.db.prepare(`
          UPDATE jobs SET job_ready_suppressed = 1
          WHERE sidecar_state IN ('summary_complete', 'summary_failed', 'transcription_failed')
        `).run();
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('job_ready_initialized_v1', ?)")
          .run(new Date().toISOString());
      })();
    }

  }

  close(): void {
    this.db.close();
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getApplicationSettings(): ReadonlyMap<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM application_settings").all() as Array<{ key: string; value: string }>;
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  setApplicationSettings(values: ReadonlyMap<string, string | undefined>, updatedAt = new Date().toISOString()): void {
    const upsert = this.db.prepare(`
      INSERT INTO application_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const remove = this.db.prepare("DELETE FROM application_settings WHERE key = ?");
    this.db.transaction(() => {
      for (const [key, value] of values) {
        if (value === undefined || value.trim() === "") remove.run(key);
        else upsert.run(key, value, updatedAt);
      }
    })();
  }

  getApplicationSettingUpdatedAt(key: string): string | undefined {
    const row = this.db.prepare("SELECT updated_at FROM application_settings WHERE key = ?").get(key) as { updated_at: string } | undefined;
    return row?.updated_at;
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
      summary_expected = NULL,
      job_ready_at = NULL,
      job_ready_outcome = NULL,
      job_ready_suppressed = 0,
      last_error = NULL,
      updated_at = ?
      WHERE job_id = ?`).run(now, jobId);
    return this.getJob(jobId)!;
  }

  ensureEvent(job: JobRow, eventType: string, payload: object): boolean {
    const now = new Date().toISOString();
    const occurrenceKey = `${job.attempt}:${eventType}`;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (job_id, event_type, occurrence_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.job_id, eventType, occurrenceKey, JSON.stringify(payload), now);
    return result.changes === 1;
  }

  ensureEventWithKey(job: JobRow, eventType: string, occurrenceKey: string, payload: object): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (job_id, event_type, occurrence_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.job_id, eventType, occurrenceKey, JSON.stringify(payload), now);
    return result.changes === 1;
  }

  getNotebookPage(jobId: string, provider: string): NotebookPageRow | undefined {
    return this.db.prepare(`SELECT * FROM notebook_pages WHERE job_id = ? AND provider = ?`)
      .get(jobId, provider) as NotebookPageRow | undefined;
  }

  listNotebookPages(provider: string): NotebookPageRow[] {
    return this.db.prepare(`SELECT * FROM notebook_pages WHERE provider = ? ORDER BY created_at`)
      .all(provider) as NotebookPageRow[];
  }

  saveNotebookPage(row: NotebookPageRow): void {
    this.db.prepare(`
      INSERT INTO notebook_pages (
        job_id, provider, parent_page_id, page_id, page_url, current_attempt,
        status_block_id, metadata_table_id, classification_table_id,
        person_row_id, appointment_type_row_id, tags_row_id, review_status_row_id,
        person_value, person_provenance, appointment_type_value, appointment_type_provenance,
        tags_value, tags_provenance, review_status_value, review_status_provenance,
        classification_checked_at, audio_container_id, audio_block_id, audio_state,
        summary_container_id, summary_block_ids_json, summary_hash,
        transcript_page_id, transcript_block_ids_json, transcript_hash,
        versions_container_id, last_status, last_title, created_at, updated_at
      ) VALUES (
        @job_id, @provider, @parent_page_id, @page_id, @page_url, @current_attempt,
        @status_block_id, @metadata_table_id, @classification_table_id,
        @person_row_id, @appointment_type_row_id, @tags_row_id, @review_status_row_id,
        @person_value, @person_provenance, @appointment_type_value, @appointment_type_provenance,
        @tags_value, @tags_provenance, @review_status_value, @review_status_provenance,
        @classification_checked_at, @audio_container_id, @audio_block_id, @audio_state,
        @summary_container_id, @summary_block_ids_json, @summary_hash,
        @transcript_page_id, @transcript_block_ids_json, @transcript_hash,
        @versions_container_id, @last_status, @last_title, @created_at, @updated_at
      ) ON CONFLICT(job_id, provider) DO UPDATE SET
        parent_page_id = excluded.parent_page_id,
        page_id = excluded.page_id,
        page_url = excluded.page_url,
        current_attempt = excluded.current_attempt,
        status_block_id = excluded.status_block_id,
        metadata_table_id = excluded.metadata_table_id,
        classification_table_id = excluded.classification_table_id,
        person_row_id = excluded.person_row_id,
        appointment_type_row_id = excluded.appointment_type_row_id,
        tags_row_id = excluded.tags_row_id,
        review_status_row_id = excluded.review_status_row_id,
        person_value = excluded.person_value,
        person_provenance = excluded.person_provenance,
        appointment_type_value = excluded.appointment_type_value,
        appointment_type_provenance = excluded.appointment_type_provenance,
        tags_value = excluded.tags_value,
        tags_provenance = excluded.tags_provenance,
        review_status_value = excluded.review_status_value,
        review_status_provenance = excluded.review_status_provenance,
        classification_checked_at = excluded.classification_checked_at,
        audio_container_id = excluded.audio_container_id,
        audio_block_id = excluded.audio_block_id,
        audio_state = excluded.audio_state,
        summary_container_id = excluded.summary_container_id,
        summary_block_ids_json = excluded.summary_block_ids_json,
        summary_hash = excluded.summary_hash,
        transcript_page_id = excluded.transcript_page_id,
        transcript_block_ids_json = excluded.transcript_block_ids_json,
        transcript_hash = excluded.transcript_hash,
        versions_container_id = excluded.versions_container_id,
        last_status = excluded.last_status,
        last_title = excluded.last_title,
        updated_at = excluded.updated_at
    `).run(row);
  }

  updateNotebookPage(jobId: string, provider: string, fields: Partial<NotebookPageRow>): void {
    const entries = Object.entries(fields).filter(([key]) => !["job_id", "provider"].includes(key));
    if (entries.length === 0) return;
    const set = entries.map(([key]) => `${key} = @${key}`).join(", ");
    this.db.prepare(`UPDATE notebook_pages SET ${set}, updated_at = @updated_at WHERE job_id = @job_id AND provider = @provider`).run({
      ...Object.fromEntries(entries),
      updated_at: new Date().toISOString(),
      job_id: jobId,
      provider
    });
  }

  beginNotebookOperation(jobId: string, provider: string, operationKey: string, operation: string): NotebookOperationRow {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO notebook_operations
        (job_id, provider, operation_key, operation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, provider, operationKey, operation, now, now);
    return this.getNotebookOperation(jobId, provider, operationKey)!;
  }

  getNotebookOperation(jobId: string, provider: string, operationKey: string): NotebookOperationRow | undefined {
    return this.db.prepare(`
      SELECT * FROM notebook_operations WHERE job_id = ? AND provider = ? AND operation_key = ?
    `).get(jobId, provider, operationKey) as NotebookOperationRow | undefined;
  }

  recordNotebookOperationFailure(id: number, error: string, exhausted: boolean): void {
    this.db.prepare(`
      UPDATE notebook_operations
      SET attempts = attempts + 1, status = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(exhausted ? "failed" : "pending", sanitizeError(error), new Date().toISOString(), id);
  }

  completeNotebookOperation(id: number): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE notebook_operations
      SET status = 'completed', completed_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
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

  ensureNotificationDelivery(
    job: JobRow,
    destination: NotificationDestination,
    payload: object
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO notification_deliveries
        (job_id, attempt, destination, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.job_id, job.attempt, destination, JSON.stringify(payload), now, now);
    return result.changes === 1;
  }

  pendingNotificationDeliveries(maxAttempts = 3, limit = 100): NotificationDeliveryRow[] {
    return this.db.prepare(`
      SELECT id, job_id, attempt, destination, payload_json, attempts
      FROM notification_deliveries
      WHERE delivered_at IS NULL AND attempts < ?
      ORDER BY id
      LIMIT ?
    `).all(maxAttempts, limit) as NotificationDeliveryRow[];
  }

  markNotificationDelivered(id: number, now: string): void {
    this.db.prepare(`
      UPDATE notification_deliveries
      SET delivered_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
  }

  recordNotificationFailure(id: number, error: string): number {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE notification_deliveries
      SET attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(sanitizeError(error), now, id);
    const row = this.db.prepare("SELECT attempts FROM notification_deliveries WHERE id = ?").get(id) as { attempts: number };
    return row.attempts;
  }
}
