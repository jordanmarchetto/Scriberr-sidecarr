import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/db.ts";

test("event ledger deduplicates within an attempt and permits a rerun attempt", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-"));
  const db = new StateStore(path.join(directory, "state.db"));
  try {
    const discovered = db.discover("123e4567-e89b-12d3-a456-426614174000", "/watch/job", new Date().toISOString());
    db.ensureEvent(discovered.job, "job_found", { event: "job_found" });
    db.ensureEvent(discovered.job, "job_found", { event: "job_found" });
    assert.equal(db.pendingEvents().length, 1);

    db.updateJob(discovered.job.job_id, { scriberr_status: "failed", sidecar_state: "transcription_failed" });
    const rerun = db.startNewAttempt(discovered.job.job_id, new Date().toISOString());
    db.ensureEvent(rerun, "transcription_complete", { event: "transcription_complete", attempt: rerun.attempt });

    const events = db.pendingEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1].occurrence_key, "2:transcription_complete");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unprocessed webhook signals survive a database restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-restart-"));
  const dbPath = path.join(directory, "state.db");
  let db: StateStore | undefined;
  try {
    db = new StateStore(dbPath);
    db.recordWebhookSignal("delivery-1", {
      schema_version: "1",
      event: "summary.failed",
      job_id: "123e4567-e89b-12d3-a456-426614174000",
      status: "completed",
      error: "password=do-not-store failure",
      occurred_at: "2026-09-12T01:00:00Z"
    }, "2026-09-12T01:00:01Z");
    db.close();

    db = new StateStore(dbPath);
    const pending = db.pendingWebhookSignals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].delivery_id, "delivery-1");
    assert.equal(pending[0].error_message, "password=[REDACTED] failure");

    db.markWebhookSignalsProcessed(["delivery-1"], "2026-09-12T01:00:02Z");
    db.close();

    db = new StateStore(dbPath);
    assert.equal(db.pendingWebhookSignals().length, 0);
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
