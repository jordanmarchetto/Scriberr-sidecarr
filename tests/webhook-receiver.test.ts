import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { WebhookReceiver } from "../src/webhook-receiver.ts";

const secret = "test-secret";
const payload = {
  schema_version: "1",
  event: "transcription.completed",
  job_id: "123e4567-e89b-12d3-a456-426614174000",
  title: "Meeting.mp3",
  status: "completed",
  occurred_at: "2026-09-11T12:00:00Z"
};

function signature(body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

test("receiver verifies, validates, and deduplicates Scriberr deliveries", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-webhook-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_WEBHOOK_SECRET: secret
  });
  let signals = 0;
  const receiver = new WebhookReceiver(config, db, () => { signals += 1; }, pino({ level: "silent" }));

  try {
    await receiver.listen(0, "127.0.0.1");
    const url = `http://127.0.0.1:${receiver.port()}${config.webhookPath}`;
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "X-Scriberr-Delivery": "delivery-1",
      "X-Scriberr-Signature": signature(body)
    };

    const accepted = await fetch(url, { method: "POST", headers, body });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false });
    assert.equal(signals, 1);
    assert.equal(db.pendingWebhookSignals().length, 1);

    const duplicate = await fetch(url, { method: "POST", headers, body });
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true });
    assert.equal(signals, 1);
    assert.equal(db.pendingWebhookSignals().length, 1);

    const rejected = await fetch(url, {
      method: "POST",
      headers: { ...headers, "X-Scriberr-Delivery": "delivery-2", "X-Scriberr-Signature": "sha256=" + "0".repeat(64) },
      body
    });
    assert.equal(rejected.status, 401);
    assert.equal(db.pendingWebhookSignals().length, 1);

    const metrics = await fetch(`http://127.0.0.1:${receiver.port()}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get("content-type") ?? "", /^text\/plain/);
    const metricsBody = await metrics.text();
    assert.match(metricsBody, /scriberr_sidecarr_webhook_requests_total\{outcome="accepted"\} 1/);
    assert.match(metricsBody, /scriberr_sidecarr_webhook_requests_total\{outcome="duplicate"\} 1/);
    assert.match(metricsBody, /scriberr_sidecarr_webhook_requests_total\{outcome="invalid"\} 1/);
    assert.match(metricsBody, /scriberr_sidecarr_pending_webhook_signals 1/);
  } finally {
    await receiver.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("receiver rejects unsupported webhook payloads", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-webhook-"));
  const db = new StateStore(path.join(directory, "state.db"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_WEBHOOK_SECRET: secret
  });
  const receiver = new WebhookReceiver(config, db, () => undefined, pino({ level: "silent" }));

  try {
    await receiver.listen(0, "127.0.0.1");
    const url = `http://127.0.0.1:${receiver.port()}${config.webhookPath}`;
    const body = JSON.stringify({ ...payload, schema_version: "2" });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Scriberr-Delivery": "delivery-v2",
        "X-Scriberr-Signature": signature(body)
      },
      body
    });

    assert.equal(response.status, 400);
    assert.equal(db.pendingWebhookSignals().length, 0);
  } finally {
    await receiver.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
