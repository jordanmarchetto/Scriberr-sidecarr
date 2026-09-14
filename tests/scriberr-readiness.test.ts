import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import pino from "pino";
import { ScriberrReadinessGate } from "../src/scriberr-readiness.ts";

test("readiness gate pauses all work until Scriberr is reachable and pauses again after an outage", async () => {
  const results = [false, false, true, false, true];
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()));
      callback();
    }
  });
  let checks = 0;
  let workCalls = 0;
  const api = {
    async isAvailable(): Promise<boolean> {
      checks += 1;
      return results.shift() ?? false;
    }
  };
  const gate = new ScriberrReadinessGate(api, pino({}, stream));
  const work = async () => { workCalls += 1; };

  assert.equal(gate.status, "waiting");
  assert.equal(await gate.run(work), false);
  assert.equal(await gate.run(work), false);
  assert.equal(workCalls, 0);

  assert.equal(await gate.run(work), true);
  assert.equal(gate.status, "ready");
  assert.equal(workCalls, 1);

  assert.equal(await gate.run(work), false);
  assert.equal(gate.status, "waiting");
  assert.equal(workCalls, 1);

  assert.equal(await gate.run(work), true);
  assert.equal(gate.status, "ready");
  assert.equal(workCalls, 2);
  assert.equal(checks, 5);
  assert.deepEqual(records.map((record) => record.msg), [
    "waiting for Scriberr; processing is paused",
    "Scriberr is available; processing is starting",
    "Scriberr became unavailable; processing is paused",
    "Scriberr is available; processing is starting"
  ]);
});
