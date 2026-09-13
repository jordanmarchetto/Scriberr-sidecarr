import { readdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { Metrics } from "./metrics.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { NotebookService } from "./notebook-service.js";
import { ScriberrApi, ScriberrApiError } from "./scriberr-api.js";
import type { JobRow, ScriberrJob, SidecarState, WebhookSignalRow } from "./types.js";

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminalPollIntervalMs = 15 * 60 * 1000;
const failedPollBackoffMs = 5 * 60 * 1000;
const missingJobPollIntervalMs = 6 * 60 * 60 * 1000;
const backgroundPollLimit = 5;
const terminalStates = new Set<SidecarState>(["summary_complete", "summary_failed", "transcription_failed"]);

export class SidecarService {
  private cycleRunning = false;
  private cycleQueued = false;
  private readonly summaryCheckedAt = new Map<string, number>();
  private readonly activeSummaryRequests = new Set<string>();
  private filesystemDiscoveryEnabled = true;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly api: ScriberrApi,
    private readonly mqtt: MqttPublisher,
    private readonly logger: pino.Logger,
    private readonly metrics = new Metrics(),
    private readonly notebook?: NotebookService
  ) {}

  setFilesystemDiscoveryEnabled(enabled: boolean): void {
    if (this.filesystemDiscoveryEnabled !== enabled) {
      this.logger.info({
        configuredDiscoveryMode: this.config.discoveryMode,
        effectiveDiscoveryMode: enabled ? "filesystem" : "webhook"
      }, "discovery mode changed");
    }
    this.filesystemDiscoveryEnabled = enabled;
  }

  async runCycle(): Promise<void> {
    if (this.cycleRunning) {
      this.cycleQueued = true;
      return;
    }
    this.cycleRunning = true;
    try {
      do {
        this.cycleQueued = false;
        if (this.filesystemDiscoveryEnabled) await this.scan();
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
            this.metrics.incrementDiscovered("webhook");
          }
        }
        const jobs = this.db.listJobs();
        const signaled = jobs.filter((job) => {
          const jobSignals = signalsByJob.get(job.job_id) ?? [];
          return jobSignals.length > 0 && this.shouldPoll(job, jobSignals);
        });
        const background = jobs
          .filter((job) => !signalsByJob.has(job.job_id) && this.shouldPoll(job))
          .sort((left, right) => this.pollPriority(left) - this.pollPriority(right))
          .slice(0, backgroundPollLimit);
        this.logger.debug({
          trackedJobs: jobs.length,
          signaledJobs: signaled.length,
          backgroundJobs: background.length,
          deferredJobs: jobs.length - signaled.length - background.length
        }, "poll candidates selected");
        for (const job of [...signaled, ...background]) {
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
        this.metrics.incrementDiscovered("filesystem");
      }
    }
  }

  private async poll(previous: JobRow, signals: WebhookSignalRow[] = []): Promise<boolean> {
    const checkedAt = new Date().toISOString();
    let job: ScriberrJob;
    try {
      job = await this.api.getJob(previous.job_id);
    } catch (error) {
      const missing = error instanceof ScriberrApiError && error.status === 404;
      this.db.updateJob(previous.job_id, {
        last_checked_at: checkedAt,
        last_error: this.safeError(error),
        ...(missing ? { scriberr_status: "not_found" } : {})
      });
      if (missing) {
        this.logger.info({ jobId: previous.job_id }, "Scriberr job no longer exists; suppressing routine polling");
        return true;
      }
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
      await this.syncNotebook(job);
      return true;
    }
    if (job.status === "processing") {
      this.transition(current, "processing_transcription", "transcription_processing", job.status, job.title);
      await this.syncNotebook(job);
      return true;
    }
    if (job.status === "failed") {
      if (!current.last_error) {
        this.db.updateJob(previous.job_id, { last_error: "Scriberr reported transcription failure" });
      }
      this.transition(this.db.getJob(previous.job_id)!, "transcription_failed", "transcription_failed", job.status, job.title);
      await this.syncNotebook(job);
      return true;
    }
    if (job.status === "completed") {
      await this.handleCompleted(
        current,
        job,
        signals.some((signal) => signal.event_type.startsWith("summary."))
      );
      await this.mqtt.flush();
      const summaryFailure = signals.find((signal) => signal.event_type === "summary.failed");
      if (summaryFailure) {
        this.db.updateJob(previous.job_id, {
          last_error: summaryFailure.error_message ?? "Scriberr reported summary failure"
        });
        current = this.db.getJob(previous.job_id)!;
        this.transition(current, "summary_failed", "summary_failed", job.status, job.title);
      }
      await this.syncNotebook(job);
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
    if (!summaryContent) {
      try {
        const summary = await this.api.getSummary(job.id);
        summaryContent = summary.content?.trim() || "";
      } catch (error) {
        this.logger.debug({ jobId: job.id, error: this.safeError(error) }, "summary lookup failed");
      }
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
      this.db.updateJob(row.job_id, { last_error: "Summary generation timed out" });
      current = this.db.getJob(row.job_id)!;
      this.transition(current, "summary_failed", "summary_failed", job.status, job.title);
      return;
    }

    this.transition(current, "summary_pending", "summary_pending", job.status, job.title);
    current = this.db.getJob(row.job_id)!;
    if (!this.config.autogenerateSummary || current.summary_requested_at) return;

    try {
      const settings = await this.api.getSummarySettings();
      if (settings.auto_summarize) {
        this.logger.debug({ jobId: job.id }, "waiting for Scriberr automatic summary");
        return;
      }
    } catch (error) {
      this.logger.warn(
        { jobId: job.id, error: this.safeError(error) },
        "Scriberr auto-summary settings lookup failed; deferring sidecar summary request"
      );
      return;
    }

    this.startSummaryRequest(current, job);
  }


  private startSummaryRequest(row: JobRow, job: ScriberrJob): void {
    if (this.activeSummaryRequests.has(job.id)) return;

    const startedAt = new Date().toISOString();
    this.db.updateJob(row.job_id, { summary_requested_at: startedAt, summary_started_at: startedAt });
    this.transition(this.db.getJob(row.job_id)!, "summary_processing", "summary_processing", job.status, job.title);
    this.activeSummaryRequests.add(job.id);

    void this.api.requestSummary(job)
      .then(() => {
        void this.runCycle().catch((error: unknown) => {
          this.logger.error({ jobId: job.id, error: this.safeError(error) }, "post-summary cycle failed");
        });
      })
      .catch(async (error: unknown) => {
        const message = this.safeError(error);
        this.db.updateJob(row.job_id, { summary_requested_at: null, last_error: message });
        const failed = this.db.getJob(row.job_id)!;
        this.transition(failed, "summary_failed", "summary_failed", job.status, job.title);
        this.logger.warn({ jobId: job.id, error: message }, "summary request failed");
        await this.mqtt.flush();
      })
      .finally(() => {
        this.activeSummaryRequests.delete(job.id);
      });
  }

  private transition(row: JobRow, state: SidecarState, eventType: string, status: string, title?: string | null): void {
    if (row.sidecar_state === state) return;
    const previousState = row.sidecar_state;
    this.db.updateJob(row.job_id, { sidecar_state: state });
    const updated = this.db.getJob(row.job_id)!;
    this.emit(updated, eventType, state, status, title);
    this.logger.info({
      jobId: row.job_id,
      attempt: updated.attempt,
      source: updated.source,
      previousState,
      state,
      scriberrStatus: status,
      eventType
    }, "job state changed");
    if (eventType.startsWith("transcription_")) this.db.updateJob(row.job_id, { transcription_event_at: new Date().toISOString() });
    if (eventType.startsWith("summary_")) this.db.updateJob(row.job_id, { summary_event_at: new Date().toISOString() });
  }

  private emit(row: JobRow, eventType: string, _state: SidecarState, status: string, title?: string | null): void {
    const completedAt = Date.now();
    if (eventType === "transcription_complete") {
      this.metrics.observeDuration("transcription", (completedAt - Date.parse(row.first_seen_at)) / 1000);
    }
    if (eventType === "summary_complete") {
      const startedAt = row.summary_started_at ?? row.transcription_event_at;
      if (startedAt) this.metrics.observeDuration("summary", (completedAt - Date.parse(startedAt)) / 1000);
    }

    const inserted = this.db.ensureEvent(row, eventType, {
      event: eventType,
      job_id: row.job_id,
      title: title ?? null,
      status,
      source: row.source,
      attempt: row.attempt,
      occurred_at: new Date().toISOString(),
      scriberr_url: this.config.scriberrPublicUrl,
      ...(eventType.endsWith("_failed") && row.last_error ? { error: this.safeError(row.last_error) } : {})
    });
    this.logger.debug({
      jobId: row.job_id,
      attempt: row.attempt,
      eventType,
      queued: inserted
    }, inserted ? "MQTT event queued" : "MQTT event already queued");
  }

  private safeError(error: unknown): string {
    return sanitizeError(error instanceof ScriberrApiError ? error.message : error);
  }

  private shouldPoll(job: JobRow, signals: WebhookSignalRow[] = []): boolean {
    const elapsed = job.last_checked_at ? Date.now() - Date.parse(job.last_checked_at) : Number.POSITIVE_INFINITY;
    const hasNewSignal = signals.some((signal) => !job.last_checked_at || Date.parse(signal.received_at) > Date.parse(job.last_checked_at));
    if (hasNewSignal) return true;
    if (this.notebook?.needsReconciliation(job.job_id)) return true;
    if (job.scriberr_status === "not_found") {
      return this.filesystemDiscoveryEnabled && elapsed >= missingJobPollIntervalMs;
    }
    if (!this.filesystemDiscoveryEnabled && terminalStates.has(job.sidecar_state)) return false;
    if (job.last_error && elapsed < failedPollBackoffMs) return false;
    if (terminalStates.has(job.sidecar_state) && elapsed < terminalPollIntervalMs) return false;
    return true;
  }

  private pollPriority(job: JobRow): number {
    if (this.notebook?.needsReconciliation(job.job_id)) return -1;
    if (["pending_transcription", "processing_transcription", "summary_pending", "summary_processing"].includes(job.sidecar_state)) return 0;
    if (job.sidecar_state === "discovered" && !job.last_error) return 1;
    if (terminalStates.has(job.sidecar_state)) return 3;
    return 2;
  }

  private async syncNotebook(job: ScriberrJob): Promise<void> {
    if (!this.notebook) return;
    // Core MQTT events should not wait for a slower notebook API.
    await this.mqtt.flush();
    const current = this.db.getJob(job.id);
    if (current) await this.notebook.sync(job, current);
  }
}
