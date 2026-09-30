import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { JobActionService } from "../src/job-action-service.ts";
import { ScriberrApi } from "../src/scriberr-api.ts";
import type { ScriberrJob, ScriberrSummary } from "../src/types.ts";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const logger = pino({ level: "silent" });

class ActionApi extends ScriberrApi {
  job: ScriberrJob = { id: jobId, status: "completed", parameters: { model: "large-v3", diarize: true } };
  summary: ScriberrSummary = { id: "summary-attempt-1", content: "old" };
  starts: Array<Record<string, unknown>> = [];
  startError?: Error;

  override async getJob(): Promise<ScriberrJob> {
    return this.job;
  }

  override async getSummary(): Promise<ScriberrSummary> {
    return this.summary;
  }

  override async startTranscription(_id: string, parameters: Record<string, unknown>): Promise<ScriberrJob> {
    if (this.startError) throw this.startError;
    this.starts.push(parameters);
    this.job = { ...this.job, status: "pending", transcript: null, summary: null };
    return this.job;
  }
}

function scenario(state = "job_ready") {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-actions-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr:8080",
    SIDECARR_SCRIBERR_API_KEY: "api-key"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const row = db.discover(jobId, "", new Date().toISOString(), "webhook").job;
  db.updateJob(row.job_id, { sidecar_state: state as typeof row.sidecar_state, scriberr_status: "completed", summary_expected: 1 });
  const api = new ActionApi(config);
  const service = new JobActionService(db, api, logger);
  return { directory, db, api, service };
}

test("re-transcription reuses prior settings and starts a new Sidecarr attempt", async () => {
  const value = scenario();
  try {
    const action = await value.service.requestRetranscription(jobId);

    assert.equal(action.status, "started");
    assert.deepEqual(value.api.starts, [{ model: "large-v3", diarize: true }]);
    assert.equal(value.db.getJob(jobId)?.attempt, 2);
    assert.equal(value.db.getJob(jobId)?.sidecar_state, "pending_transcription");
    assert.equal(value.db.getJob(jobId)?.summary_baseline_id, "summary-attempt-1");
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("re-transcription queues durably while a summary is active", async () => {
  const value = scenario("summary_processing");
  try {
    const requested = await value.service.requestRetranscription(jobId);
    assert.equal(requested.status, "queued");
    assert.equal(value.api.starts.length, 0);

    const restarted = new JobActionService(value.db, value.api, logger);
    assert.equal(await restarted.processQueued(), false);
    value.db.updateJob(jobId, { sidecar_state: "summary_complete" });
    assert.equal(await restarted.processQueued(), true);
    assert.equal(value.db.latestJobAction(jobId)?.status, "started");
    assert.equal(value.db.getJob(jobId)?.attempt, 2);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a queued re-transcription can be cancelled", async () => {
  const value = scenario("summary_pending");
  try {
    await value.service.requestRetranscription(jobId);
    const cancelled = value.service.cancelRetranscription(jobId);
    assert.equal(cancelled.status, "cancelled");
    value.db.updateJob(jobId, { sidecar_state: "summary_complete" });
    assert.equal(await value.service.processQueued(), false);
    assert.equal(value.api.starts.length, 0);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("a failed Scriberr start does not create a Sidecarr attempt", async () => {
  const value = scenario();
  try {
    value.api.startError = new Error("Scriberr unavailable");
    await assert.rejects(value.service.requestRetranscription(jobId), /Scriberr unavailable/);
    assert.equal(value.db.getJob(jobId)?.attempt, 1);
    assert.equal(value.db.latestJobAction(jobId)?.status, "failed");
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});
