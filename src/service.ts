import { readdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { ScriberrApi, ScriberrApiError } from "./scriberr-api.js";
import type { JobRow, ScriberrJob, SidecarState, WebhookSignalRow } from "./types.js";

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SidecarService {
  private cycleRunning = false;
  private cycleQueued = false;
  private readonly summaryCheckedAt = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly api: ScriberrApi,
    private readonly mqtt: MqttPublisher,
    private readonly logger: pino.Logger
  ) {}

  async runCycle(): Promise<void> {
    if (this.cycleRunning) {
      this.cycleQueued = true;
      return;
    }
    this.cycleRunning = true;
    try {
      do {
        this.cycleQueued = false;
        await this.scan();
        const signals = this.db.pendingWebhookSignals();
        const signalsByJob = new Map<string, WebhookSignalRow[]>();
        for (const signal of signals) {
          const jobSignals = signalsByJob.get(signal.job_id) ?? [];
          jobSignals.push(signal);
          signalsByJob.set(signal.job_id, jobSignals);
          const result = this.db.discover(signal.job_id, "", signal.received_at, "webhook");
          if (result.inserted) {
            this.emit(result.job, "job_found", "discovered", "discovered", null);
            this.logger.info({ jobId: signal.job_id, source: "webhook" }, "job discovered");
          }
        }
        for (const job of this.db.listJobs()) {
          const jobSignals = signalsByJob.get(job.job_id) ?? [];
          if (await this.poll(job, jobSignals)) {
            this.db.markWebhookSignalsProcessed(
              jobSignals.map((signal) => signal.delivery_id),
              new Date().toISOString()
            );
          }
        }
        await this.mqtt.flush();
      } while (this.cycleQueued);
    } finally {
      this.cycleRunning = false;
    }
  }

  private async scan(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.config.watchFolder, { withFileTypes: true });
    } catch (error) {
      this.logger.warn({ folder: this.config.watchFolder, error: this.safeError(error) }, "transcript scan failed");
      return;
    }
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (!entry.isDirectory() || !jobIdPattern.test(entry.name)) continue;
      const folder = path.join(this.config.watchFolder, entry.name);
      const result = this.db.discover(entry.name, folder, now);
      if (result.inserted) {
        this.emit(result.job, "job_found", "discovered", "discovered", null);
        this.logger.info({ jobId: entry.name, source: "filesystem" }, "job discovered");
      }
    }
  }

  private async poll(previous: JobRow, signals: WebhookSignalRow[] = []): Promise<boolean> {
    const checkedAt = new Date().toISOString();
    let job: ScriberrJob;
    try {
      job = await this.api.getJob(previous.job_id);
    } catch (error) {
      this.db.updateJob(previous.job_id, { last_checked_at: checkedAt, last_error: this.safeError(error) });
      this.logger.warn({ jobId: previous.job_id, error: this.safeError(error) }, "Scriberr job lookup failed");
      return false;
    }

    let current = this.db.getJob(previous.job_id)!;
    if (current.scriberr_status === "failed" && ["uploaded", "pending", "processing"].includes(job.status)) {
      current = this.db.startNewAttempt(previous.job_id, checkedAt);
      this.logger.info({ jobId: previous.job_id, attempt: current.attempt }, "Scriberr job rerun detected");
    }
    this.db.updateJob(previous.job_id, {
      scriberr_status: job.status,
      last_checked_at: checkedAt,
      last_error: job.error_message ?? null
    });
    current = this.db.getJob(previous.job_id)!;

    if (job.status === "uploaded" || job.status === "pending") {
      this.transition(current, "pending_transcription", "pending_transcription", job.status, job.title);
      return true;
    }
    if (job.status === "processing") {
      this.transition(current, "processing_transcription", "transcription_processing", job.status, job.title);
      return true;
    }
    if (job.status === "failed") {
      this.transition(current, "transcription_failed", "transcription_failed", job.status, job.title);
      return true;
    }
    if (job.status === "completed") {
      await this.handleCompleted(
        current,
        job,
        signals.some((signal) => signal.event_type.startsWith("summary."))
      );
      if (signals.some((signal) => signal.event_type === "summary.failed")) {
        current = this.db.getJob(previous.job_id)!;
        this.transition(current, "summary_failed", "summary_failed", job.status, job.title);
      }
    }
    return true;
  }

  private async handleCompleted(row: JobRow, job: ScriberrJob, forceSummaryCheck = false): Promise<void> {
    const nowMs = Date.now();
    const lastSummaryCheck = this.summaryCheckedAt.get(job.id) ?? 0;
    if (!forceSummaryCheck && nowMs - lastSummaryCheck < this.config.summaryPollIntervalMs) return;
    this.summaryCheckedAt.set(job.id, nowMs);
    let current = this.db.getJob(row.job_id)!;
    if (!["transcription_complete", "summary_pending", "summary_processing", "summary_complete", "summary_failed"].includes(current.sidecar_state)) {
      this.transition(current, "transcription_complete", "transcription_complete", job.status, job.title);
      current = this.db.getJob(row.job_id)!;
    }

    let summaryContent = job.summary?.trim() ?? "";
    try {
      const summary = await this.api.getSummary(job.id);
      summaryContent = summary.content?.trim() || summaryContent;
    } catch (error) {
      this.logger.debug({ jobId: job.id, error: this.safeError(error) }, "summary lookup failed");
    }

    if (summaryContent) {
      this.transition(current, "summary_complete", "summary_complete", job.status, job.title);
      return;
    }

    current = this.db.getJob(row.job_id)!;
    const now = Date.now();
    const deadline = current.summary_deadline_at ? Date.parse(current.summary_deadline_at) : now + this.config.summaryTimeoutMs;
    if (!current.summary_deadline_at) {
      this.db.updateJob(row.job_id, { summary_deadline_at: new Date(deadline).toISOString() });
      current = this.db.getJob(row.job_id)!;
    }
    if (now >= deadline) {
      this.transition(current, "summary_failed", "summary_failed", job.status, job.title);
      return;
    }

    this.transition(current, "summary_pending", "summary_pending", job.status, job.title);
    current = this.db.getJob(row.job_id)!;
    if (!this.config.autogenerateSummary || current.summary_requested_at) return;

    try {
      this.db.updateJob(row.job_id, { summary_requested_at: new Date().toISOString(), summary_started_at: new Date().toISOString() });
      current = this.db.getJob(row.job_id)!;
      this.transition(current, "summary_processing", "summary_processing", job.status, job.title);
      await this.api.requestSummary(job);
    } catch (error) {
      this.db.updateJob(row.job_id, { summary_requested_at: null, last_error: this.safeError(error) });
      const failed = this.db.getJob(row.job_id)!;
      this.db.updateJob(row.job_id, { sidecar_state: "summary_failed" });
      this.emit(this.db.getJob(row.job_id)!, "summary_failed", "summary_failed", job.status, job.title);
      this.logger.warn({ jobId: job.id, error: this.safeError(error) }, "summary request failed");
    }
  }

  private transition(row: JobRow, state: SidecarState, eventType: string, status: string, title?: string | null): void {
    if (row.sidecar_state === state) return;
    this.db.updateJob(row.job_id, { sidecar_state: state });
    const updated = this.db.getJob(row.job_id)!;
    this.emit(updated, eventType, state, status, title);
    if (eventType.startsWith("transcription_")) this.db.updateJob(row.job_id, { transcription_event_at: new Date().toISOString() });
    if (eventType.startsWith("summary_")) this.db.updateJob(row.job_id, { summary_event_at: new Date().toISOString() });
  }

  private emit(row: JobRow, eventType: string, _state: SidecarState, status: string, title?: string | null): void {
    this.db.ensureEvent(row, eventType, {
      event: eventType,
      job_id: row.job_id,
      title: title ?? null,
      status,
      source: row.source,
      attempt: row.attempt,
      occurred_at: new Date().toISOString(),
      scriberr_url: this.config.scriberrUrl
    });
  }

  private safeError(error: unknown): string {
    if (error instanceof ScriberrApiError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }
}
