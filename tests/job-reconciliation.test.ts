import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { ScriberrJobReconciler } from "../src/job-reconciliation.ts";
import type { ScriberrJob, ScriberrJobListResponse } from "../src/types.ts";

test("job reconciliation establishes a baseline then returns only newly updated Scriberr jobs", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-reconciliation-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_RECONCILIATION_INTERVAL_SECONDS: "300"
  });
  let now = new Date("2026-09-14T12:00:00.000Z");
  const calls: string[] = [];
  const oldJob: ScriberrJob = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    status: "completed",
    updated_at: "2026-09-14T11:59:00.000Z"
  };
  const newJob: ScriberrJob = {
    id: "223e4567-e89b-12d3-a456-426614174000",
    status: "completed",
    updated_at: "2026-09-14T12:04:00.000Z"
  };
  const api = {
    async listJobsUpdatedAfter(cursor: string): Promise<ScriberrJobListResponse> {
      calls.push(cursor);
      return {
        jobs: [oldJob, newJob],
        pagination: { page: 1, limit: 20, total: 2, pages: 1 }
      };
    }
  };
  const reconciler = new ScriberrJobReconciler(config, db, api, pino({ level: "silent" }), () => now);

  try {
    assert.deepEqual(await reconciler.reconcile(), []);
    assert.equal(calls.length, 0);

    now = new Date("2026-09-14T12:05:00.001Z");
    assert.deepEqual(await reconciler.reconcile(), [newJob]);
    assert.deepEqual(calls, ["2026-09-14T12:00:00.000Z"]);

    assert.deepEqual(await reconciler.reconcile(), []);
    assert.equal(calls.length, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("jobs returned by API reconciliation enter the normal discovery and polling flow", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-reconciliation-service-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key"
  });
  const job: ScriberrJob = {
    id: "323e4567-e89b-12d3-a456-426614174000",
    status: "pending",
    updated_at: "2026-09-14T12:05:00.000Z"
  };
  let lookups = 0;
  const api = {
    async getJob(): Promise<ScriberrJob> {
      lookups += 1;
      return job;
    }
  };
  const reconciliation = { reconcile: async () => [job] };

  try {
    const { SidecarService } = await import("../src/service.ts");
    const mqtt = { flush: async () => undefined };
    const service = new SidecarService(
      config,
      db,
      api as unknown as import("../src/scriberr-api.ts").ScriberrApi,
      mqtt as unknown as import("../src/mqtt-publisher.ts").MqttPublisher,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      reconciliation
    );
    service.setFilesystemDiscoveryEnabled(false);
    await service.runCycle();

    assert.equal(db.getJob(job.id)?.source, "scriberr_api");
    assert.equal(db.getJob(job.id)?.sidecar_state, "pending_transcription");
    assert.equal(lookups, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("API reconciliation immediately rechecks an updated terminal job", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-reconciliation-rerun-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key"
  });
  const job: ScriberrJob = {
    id: "423e4567-e89b-12d3-a456-426614174000",
    status: "pending",
    updated_at: "2026-09-14T12:05:00.000Z"
  };
  const tracked = db.discover(job.id, "", "2026-09-14T11:00:00.000Z", "webhook").job;
  db.updateJob(tracked.job_id, {
    sidecar_state: "job_ready",
    scriberr_status: "completed",
    last_checked_at: new Date().toISOString()
  });
  let lookups = 0;
  const api = {
    async getJob(): Promise<ScriberrJob> {
      lookups += 1;
      return job;
    }
  };
  const reconciliation = { reconcile: async () => [job] };

  try {
    const { SidecarService } = await import("../src/service.ts");
    const mqtt = { flush: async () => undefined };
    const service = new SidecarService(
      config,
      db,
      api as unknown as import("../src/scriberr-api.ts").ScriberrApi,
      mqtt as unknown as import("../src/mqtt-publisher.ts").MqttPublisher,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      reconciliation
    );
    service.setFilesystemDiscoveryEnabled(false);
    await service.runCycle();

    assert.equal(lookups, 1);
    assert.equal(db.getJob(job.id)?.sidecar_state, "pending_transcription");
    assert.equal(db.getJob(job.id)?.attempt, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
