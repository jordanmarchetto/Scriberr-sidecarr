import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import type { NotebookOutcome, NotebookPublisher } from "./notebook.js";
import type { JobRow, ScriberrJob } from "./types.js";

const enabledAtSetting = "notebook_enabled_at";

export class NotebookService {
  private readonly enabledAt: number;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly publisher: NotebookPublisher,
    private readonly logger: pino.Logger
  ) {
    const stored = db.getSetting(enabledAtSetting);
    const now = new Date().toISOString();
    if (!stored) db.setSetting(enabledAtSetting, now);
    this.enabledAt = Date.parse(stored ?? now);
  }

  async sync(job: ScriberrJob, row: JobRow): Promise<void> {
    if (!this.config.notionBackfill && Date.parse(row.first_seen_at) < this.enabledAt) {
      this.logger.debug({ jobId: row.job_id, provider: this.publisher.provider }, "notebook backfill skipped for existing job");
      return;
    }
    let outcomes: NotebookOutcome[];
    try {
      outcomes = await this.publisher.sync(job, row);
    } catch (error) {
      const message = sanitizeError(error);
      this.logger.error({ jobId: row.job_id, provider: this.publisher.provider, error: message }, "notebook synchronization failed unexpectedly");
      outcomes = [{
        event: "notebook_sync_failed",
        operation: "sync",
        occurrenceKey: `unexpected:${row.attempt}:${job.status}`,
        error: message
      }];
    }
    for (const outcome of outcomes) this.emit(row, outcome);
  }

  needsReconciliation(jobId: string): boolean {
    const key = this.publisher.reconciliationKey;
    if (!key || !this.db.getNotebookPage(jobId, this.publisher.provider)) return false;
    return !this.db.getNotebookOperation(jobId, this.publisher.provider, key);
  }

  private emit(row: JobRow, outcome: NotebookOutcome): void {
    const occurredAt = new Date().toISOString();
    const queued = this.db.ensureEventWithKey(row, outcome.event, `${row.attempt}:${outcome.occurrenceKey}`, {
      event: outcome.event,
      provider: this.publisher.provider,
      job_id: row.job_id,
      attempt: row.attempt,
      operation: outcome.operation,
      page_id: outcome.pageId ?? null,
      page_url: outcome.pageUrl ?? null,
      occurred_at: occurredAt,
      ...(outcome.error ? { error: sanitizeError(outcome.error) } : {})
    });
    this.logger.debug({
      jobId: row.job_id,
      provider: this.publisher.provider,
      operation: outcome.operation,
      eventType: outcome.event,
      queued
    }, queued ? "notebook MQTT event queued" : "notebook MQTT event already queued");
  }
}
