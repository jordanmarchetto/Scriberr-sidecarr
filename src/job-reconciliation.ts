import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { ScriberrApiError } from "./scriberr-api.js";
import type { ScriberrJob, ScriberrJobListResponse } from "./types.js";

const cursorSetting = "scriberr_job_reconciliation_cursor_v1";

type ReconciliationApi = {
  listJobsUpdatedAfter(cursor: string): Promise<ScriberrJobListResponse>;
};

export type JobReconciliation = {
  reconcile(): Promise<ScriberrJob[]>;
};

export class ScriberrJobReconciler implements JobReconciliation {
  private nextCheckAt = 0;
  private unsupported = false;
  private warnedUnavailable = false;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly api: ReconciliationApi,
    private readonly logger: pino.Logger,
    private readonly now: () => Date = () => new Date()
  ) {}

  async reconcile(): Promise<ScriberrJob[]> {
    const checkedAt = this.now();
    if (this.unsupported || checkedAt.getTime() < this.nextCheckAt) return [];
    this.nextCheckAt = checkedAt.getTime() + this.config.reconciliationIntervalMs;

    const cursor = this.db.getSetting(cursorSetting);
    if (!cursor) {
      this.db.setSetting(cursorSetting, checkedAt.toISOString());
      this.logger.info(
        { intervalSeconds: this.config.reconciliationIntervalMs / 1000 },
        "Scriberr job reconciliation initialized"
      );
      return [];
    }

    let response: ScriberrJobListResponse;
    try {
      response = await this.api.listJobsUpdatedAfter(cursor);
    } catch (error) {
      if (error instanceof ScriberrApiError && [404, 405].includes(error.status)) {
        this.unsupported = true;
        this.logger.info(
          { status: error.status },
          "Scriberr job list reconciliation is unsupported; existing discovery remains active"
        );
        return [];
      }
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn(
          { error: sanitizeError(error instanceof Error ? error.message : error) },
          "Scriberr job reconciliation failed; existing discovery remains active"
        );
      }
      return [];
    }

    if (this.warnedUnavailable) {
      this.logger.info("Scriberr job reconciliation recovered");
      this.warnedUnavailable = false;
    }

    const cursorTime = Date.parse(cursor);
    const changed = response.jobs.filter((job) => {
      const updatedAt = job.updated_at ? Date.parse(job.updated_at) : Number.NaN;
      return Number.isFinite(updatedAt) && updatedAt > cursorTime;
    });
    const newestUpdate = changed.reduce(
      (latest, job) => Math.max(latest, Date.parse(job.updated_at ?? "")),
      Number.NEGATIVE_INFINITY
    );
    const resultIsFull = response.jobs.length >= response.pagination.limit;
    const nextCursor = resultIsFull && Number.isFinite(newestUpdate)
      ? new Date(newestUpdate).toISOString()
      : checkedAt.toISOString();
    this.db.setSetting(cursorSetting, nextCursor);

    this.logger.debug({
      returnedJobs: response.jobs.length,
      changedJobs: changed.length,
      morePages: response.pagination.pages > 1
    }, "Scriberr job reconciliation completed");
    return changed;
  }
}
