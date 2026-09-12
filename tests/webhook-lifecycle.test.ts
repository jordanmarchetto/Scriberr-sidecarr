import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig, type Config } from "../src/config.ts";
import { StateStore, type PendingEvent } from "../src/db.ts";
import type { MqttPublisher } from "../src/mqtt-publisher.ts";
import { ScriberrApi } from "../src/scriberr-api.ts";
import { SidecarService } from "../src/service.ts";
import type { ScriberrJob } from "../src/types.ts";
import { WebhookReceiver } from "../src/webhook-receiver.ts";

const secret = "integration-secret";
const jobId = "123e4567-e89b-12d3-a456-426614174000";

class CompletedJobApi extends ScriberrApi {
  constructor(config: Config) {
    super(config);
  }

  override async getJob(): Promise<ScriberrJob> {
    return {
      id: jobId,
      status: "completed",
      title: "Appointment.mp3",
      transcript: JSON.stringify({ text: "Transcript", segments: [] })
    };
  }

  override async getSummary(): Promise<{ content: string }> {
    return { content: "Generated summary" };
  }
}

class RecordingPublisher {
  readonly published: PendingEvent[] = [];

  constructor(private readonly db: StateStore) {}

  async flush(): Promise<void> {
    for (const event of this.db.pendingEvents()) {
      this.published.push(event);
      this.db.markPublished(event.id, new Date().toISOString());
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle processing");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("webhook signal is API-confirmed and published once through the MQTT boundary", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-lifecycle-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_WEBHOOK_SECRET: secret
  });
  const publisher = new RecordingPublisher(db);
  const service = new SidecarService(
    config,
    db,
    new CompletedJobApi(config),
    publisher as unknown as MqttPublisher,
    pino({ level: "silent" })
  );
  const receiver = new WebhookReceiver(config, db, () => service.runCycle(), pino({ level: "silent" }));

  try {
    await receiver.listen(0, "127.0.0.1");
    const body = JSON.stringify({
      schema_version: "1",
      event: "summary.completed",
      job_id: jobId,
      status: "completed",
      occurred_at: "2026-09-12T02:00:00Z"
    });
    const url = `http://127.0.0.1:${receiver.port()}${config.webhookPath}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Scriberr-Delivery": "delivery-integration",
      "X-Scriberr-Signature": "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
    };

    const accepted = await fetch(url, { method: "POST", headers, body });
    assert.equal(accepted.status, 202);
    await waitFor(() => db.pendingWebhookSignalCount() === 0 && publisher.published.length === 3);

    assert.deepEqual(
      publisher.published.map((event) => event.event_type),
      ["job_found", "transcription_complete", "summary_complete"]
    );

    const duplicate = await fetch(url, { method: "POST", headers, body });
    assert.equal(duplicate.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(publisher.published.length, 3);
  } finally {
    await receiver.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
