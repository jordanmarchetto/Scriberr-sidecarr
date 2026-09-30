import pino from "pino";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { ScriberrApi, ScriberrApiError } from "./scriberr-api.js";
import type { JobActionRow, JobRow, ScriberrJob } from "./types.js";

const transcriptionStates = new Set(["uploaded", "pending", "processing"]);
const summaryStates = new Set(["transcription_complete", "summary_pending", "summary_processing"]);

export class JobActionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "JobActionError";
  }
}

export class JobActionService {
  private readonly active = new Set<string>();

  constructor(
    private readonly db: StateStore,
    private readonly api: ScriberrApi,
    private readonly logger: pino.Logger
  ) {}

  async requestRetranscription(jobId: string): Promise<JobActionRow> {
    const row = this.requireJob(jobId);
    const remote = await this.api.getJob(jobId);
    if (["pending", "processing"].includes(remote.status)) {
      throw new JobActionError(409, "This job is already being transcribed");
    }
    if (!transcriptionStates.has(remote.status) && remote.status !== "completed" && remote.status !== "failed") {
      throw new JobActionError(409, `Scriberr cannot re-transcribe a job with status ${remote.status}`);
    }
    if (!remote.parameters || Object.keys(remote.parameters).length === 0) {
      throw new JobActionError(422, "Scriberr did not return the previous transcription settings");
    }

    const action = this.db.enqueueRetranscription(row.job_id);
    await this.process(action, remote);
    return this.db.latestJobAction(row.job_id)!;
  }

  cancelRetranscription(jobId: string): JobActionRow {
    this.requireJob(jobId);
    if (!this.db.cancelRetranscription(jobId)) {
      throw new JobActionError(409, "There is no queued re-transcription to cancel");
    }
    return this.db.latestJobAction(jobId)!;
  }

  dismissNotionWarning(jobId: string): void {
    this.requireJob(jobId);
    if (this.db.acknowledgeNotebookFailures(jobId, "notion") === 0) {
      throw new JobActionError(409, "This job has no unresolved Notion warning");
    }
  }

  recreateNotionPage(jobId: string): void {
    this.requireJob(jobId);
    if (!this.db.resetNotebookPage(jobId, "notion")) {
      throw new JobActionError(409, "This job does not have a managed Notion page to recreate");
    }
  }

  async processQueued(): Promise<boolean> {
    let started = false;
    for (const action of this.db.queuedRetranscriptions()) started = await this.process(action) || started;
    return started;
  }

  private async process(action: JobActionRow, knownRemote?: ScriberrJob): Promise<boolean> {
    if (this.active.has(action.job_id)) return false;
    const row = this.db.getJob(action.job_id);
    if (!row || summaryStates.has(row.sidecar_state)) return false;
    this.active.add(action.job_id);
    try {
      const remote = knownRemote ?? await this.api.getJob(action.job_id);
      if (["pending", "processing"].includes(remote.status)) {
        if (this.db.claimJobAction(action.id)) {
          this.db.failJobAction(action.id, "Scriberr began another transcription before the queued request could start");
        }
        return false;
      }
      if (!remote.parameters || Object.keys(remote.parameters).length === 0) {
        throw new JobActionError(422, "Scriberr did not return the previous transcription settings");
      }
      if (!this.db.claimJobAction(action.id)) return false;
      const baselineSummaryId = await this.summaryId(remote.id);
      const attempt = row.attempt;
      const started = await this.api.startTranscription(remote.id, remote.parameters);
      const current = this.db.getJob(remote.id);
      if (!current) throw new Error("Sidecarr lost the job while starting re-transcription");
      if (current.attempt === attempt) {
        this.db.startNewAttempt(remote.id, new Date().toISOString(), baselineSummaryId);
      } else if (current.attempt === attempt + 1) {
        this.db.updateJob(remote.id, { summary_baseline_id: baselineSummaryId });
      }
      this.db.updateJob(remote.id, { scriberr_status: started.status });
      this.db.completeJobAction(action.id);
      this.logger.info({ jobId: remote.id, attempt: attempt + 1 }, "re-transcription started");
      return true;
    } catch (error) {
      const latest = this.db.latestJobAction(action.job_id);
      if (latest?.id === action.id && latest.status === "starting") {
        this.db.failJobAction(action.id, sanitizeError(error));
      }
      this.logger.warn({ jobId: action.job_id, error: sanitizeError(error) }, "re-transcription failed to start");
      if (knownRemote) throw error;
      return false;
    } finally {
      this.active.delete(action.job_id);
    }
  }

  private requireJob(jobId: string): JobRow {
    const row = this.db.getJob(jobId);
    if (!row) throw new JobActionError(404, "Job not found");
    return row;
  }

  private async summaryId(jobId: string): Promise<string | null> {
    try {
      return (await this.api.getSummary(jobId)).id ?? null;
    } catch (error) {
      if (error instanceof ScriberrApiError && error.status === 404) return null;
      throw error;
    }
  }
}
