import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig, type Config } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import type { MqttPublisher } from "../src/mqtt-publisher.ts";
import { ScriberrApi } from "../src/scriberr-api.ts";
import { SidecarService } from "../src/service.ts";
import type { ScriberrJob, ScriberrSummarySettings } from "../src/types.ts";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const job: ScriberrJob = {
  id: jobId,
  status: "completed",
  title: "Meeting.mp3",
  transcript: JSON.stringify({ text: "Meeting transcript", segments: [] }),
  summary: null
};

class FakeScriberrApi extends ScriberrApi {
  summaryRequests = 0;

  constructor(
    config: Config,
    private readonly settings: ScriberrSummarySettings | Error,
    private readonly summaryRequest: () => Promise<void> = async () => undefined,
    private readonly summaryContent: string | null = null
  ) {
    super(config);
  }

  override async getJob(): Promise<ScriberrJob> {
    return job;
  }

  override async getSummary(): Promise<{ content: string | null }> {
    return { content: this.summaryContent };
  }

  override async getSummarySettings(): Promise<ScriberrSummarySettings> {
    if (this.settings instanceof Error) throw this.settings;
    return this.settings;
  }

  override async requestSummary(): Promise<void> {
    this.summaryRequests += 1;
    await this.summaryRequest();
  }
}

type Scenario = {
  api: FakeScriberrApi;
  db: StateStore;
  directory: string;
  service: SidecarService;
};

function scenario(
  settings: ScriberrSummarySettings | Error,
  summaryRequest?: () => Promise<void>,
  summaryContent?: string
): Scenario {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-auto-summary-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_AUTOGENERATE_SUMMARY: "true",
    SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS: "1",
  });
  const db = new StateStore(path.join(directory, "state.db"));
  db.discover(jobId, "", new Date().toISOString(), "webhook");
  const api = new FakeScriberrApi(config, settings, summaryRequest, summaryContent);
  const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
  const service = new SidecarService(config, db, api, mqtt, pino({ level: "silent" }));
  return { api, db, directory, service };
}

function cleanup(value: Scenario): void {
  value.db.close();
  rmSync(value.directory, { recursive: true, force: true });
}

test("waits for Scriberr when server-side auto-summary is enabled", async () => {
  const value = scenario({ auto_summarize: true, default_template_id: "template-1" });
  try {
    await value.service.runCycle();

    assert.equal(value.api.summaryRequests, 0);
    assert.equal(value.db.getJob(jobId)?.sidecar_state, "summary_pending");
  } finally {
    cleanup(value);
  }
});

test("keeps sidecar summary generation for Scriberr without auto-summary enabled", async () => {
  const value = scenario({ auto_summarize: false });
  try {
    await value.service.runCycle();

    assert.equal(value.api.summaryRequests, 1);
    assert.equal(value.db.getJob(jobId)?.sidecar_state, "summary_processing");
  } finally {
    cleanup(value);
  }
});

test("defers sidecar generation when summary ownership cannot be checked", async () => {
  const value = scenario(new Error("settings unavailable"));
  try {
    await value.service.runCycle();

    assert.equal(value.api.summaryRequests, 0);
    assert.equal(value.db.getJob(jobId)?.sidecar_state, "summary_pending");
  } finally {
    cleanup(value);
  }
});

test("discovers a completed summary through API polling without a webhook", async () => {
  const value = scenario(
    { auto_summarize: true, default_template_id: "template-1" },
    undefined,
    "Summary discovered by polling"
  );
  try {
    await value.service.runCycle();

    assert.equal(value.db.getJob(jobId)?.sidecar_state, "job_ready");
    assert.ok(value.db.pendingEvents().some((event) => event.event_type === "summary_complete"));
  } finally {
    cleanup(value);
  }
});

test("does not hold the polling cycle open for a slow summary request", async () => {
  const neverFinishes = new Promise<void>(() => undefined);
  const value = scenario({ auto_summarize: false }, () => neverFinishes);
  try {
    const completedPromptly = await Promise.race([
      value.service.runCycle().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);

    assert.equal(completedPromptly, true);
    assert.equal(value.api.summaryRequests, 1);
    assert.equal(value.db.getJob(jobId)?.sidecar_state, "summary_processing");
  } finally {
    cleanup(value);
  }
});

test("records a sanitized failure when background summary generation fails", async () => {
  const value = scenario(
    { auto_summarize: false },
    async () => { throw new Error("token=super-secret summary provider failed\nwith details"); }
  );
  try {
    await value.service.runCycle();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(value.db.getJob(jobId)?.sidecar_state, "job_ready");
    assert.equal(value.db.getJob(jobId)?.job_ready_outcome, "ready_with_warnings");
    const failed = value.db.pendingEvents().find((event) => event.event_type === "summary_failed");
    assert.ok(failed);
    const payload = JSON.parse(failed.payload_json) as { error?: string };
    assert.equal(payload.error, "token=[REDACTED] summary provider failed with details");
  } finally {
    cleanup(value);
  }
});
