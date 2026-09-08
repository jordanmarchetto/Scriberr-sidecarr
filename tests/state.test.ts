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
