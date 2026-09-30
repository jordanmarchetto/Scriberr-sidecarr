import assert from "node:assert/strict";
import test from "node:test";
import { buildDisplayTitle } from "../src/job-title.ts";

test("builds a dated display title from the generated subject", () => {
  assert.equal(
    buildDisplayTitle("  **ENT Appointment.**\nExtra explanation", "2026-09-29T23:45:00Z"),
    "9/29/2026 - ENT Appointment"
  );
});

test("rejects an empty generated subject", () => {
  assert.throws(() => buildDisplayTitle("  \n", "2026-09-29T12:00:00Z"), /empty generated title/);
  assert.throws(() => buildDisplayTitle("Error: model unavailable", "2026-09-29T12:00:00Z"), /did not complete/);
});

test("keeps the complete display title within 60 characters", () => {
  const title = buildDisplayTitle("A very long generated subject that should be shortened to fit comfortably", "2026-09-29T12:00:00Z");
  assert.ok(title.length <= 60);
  assert.match(title, /^9\/29\/2026 - .+…$/);
});
