import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Transporter } from "nodemailer";
import pino from "pino";
import { loadConfig, type Config } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { sanitizeError } from "../src/errors.ts";
import { MqttPublisher } from "../src/mqtt-publisher.ts";
import type { NotebookService } from "../src/notebook-service.ts";
import { NotificationService, type JobReadyPayload } from "../src/notification-service.ts";
import { ScriberrApi } from "../src/scriberr-api.ts";
import { SidecarService } from "../src/service.ts";
import type { ScriberrJob, ScriberrSummarySettings } from "../src/types.ts";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const logger = pino({ level: "silent" });

class TranscriptOnlyApi extends ScriberrApi {
  constructor(config: Config) {
    super(config);
  }

  override async getJob(): Promise<ScriberrJob> {
    return {
      id: jobId,
      status: "completed",
      title: "Doctor appointment",
      transcript: JSON.stringify({ text: "Transcript", segments: [] }),
      summary: null
    };
  }

  override async getSummary(): Promise<{ content: null }> {
    return { content: null };
  }

  override async getSummarySettings(): Promise<ScriberrSummarySettings> {
    return { auto_summarize: false };
  }
}

function payload(): JobReadyPayload {
  return {
    event: "job_ready",
    job_id: jobId,
    title: "Doctor appointment",
    outcome: "ready",
    attempt: 1,
    notion_url: "https://notion.so/page",
    scriberr_url: `https://scriberr.example/audio/${jobId}`,
    occurred_at: "2026-09-14T12:00:00.000Z"
  };
}

test("starts and reaches job_ready without MQTT or summary generation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-no-mqtt-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const mqtt = new MqttPublisher(config, db, logger);
  const service = new SidecarService(config, db, new TranscriptOnlyApi(config), mqtt, logger);
  db.discover(jobId, "", new Date().toISOString(), "webhook");

  try {
    await service.runCycle();
    assert.equal(config.mqttUrl, undefined);
    assert.equal(db.getJob(jobId)?.sidecar_state, "job_ready");
    assert.equal(db.getJob(jobId)?.summary_expected, 0);
    assert.equal(db.pendingEvents().length, 0);
  } finally {
    mqtt.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes job_ready to MQTT when MQTT is configured", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-mqtt-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
  const service = new SidecarService(config, db, new TranscriptOnlyApi(config), mqtt, logger);
  db.discover(jobId, "", new Date().toISOString(), "webhook");

  try {
    await service.runCycle();
    const ready = db.pendingEvents().find((event) => event.event_type === "job_ready");
    assert.ok(ready);
    assert.equal(JSON.parse(ready.payload_json).outcome, "ready");
    assert.equal(JSON.parse(ready.payload_json).scriberr_url, `http://scriberr/audio/${jobId}`);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waits for the configured notebook before publishing job_ready", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-notebook-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
  let notebookReady = false;
  const notebook = {
    sync: async () => undefined,
    needsReconciliation: () => false,
    readiness: () => ({ ready: notebookReady, warning: false, pageUrl: "https://notion.so/ready-page" })
  } as unknown as NotebookService;
  const service = new SidecarService(config, db, new TranscriptOnlyApi(config), mqtt, logger, undefined, notebook);
  db.discover(jobId, "", new Date().toISOString(), "webhook");

  try {
    await service.runCycle();
    assert.equal(db.getJob(jobId)?.sidecar_state, "transcription_complete");
    assert.equal(db.pendingEvents().some((event) => event.event_type === "job_ready"), false);

    notebookReady = true;
    await service.runCycle();
    assert.equal(db.getJob(jobId)?.sidecar_state, "job_ready");
    const ready = db.pendingEvents().find((event) => event.event_type === "job_ready");
    assert.equal(JSON.parse(ready!.payload_json).notion_url, "https://notion.so/ready-page");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("suppresses historical terminal jobs but permits their next attempt", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-history-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
  const service = new SidecarService(config, db, new TranscriptOnlyApi(config), mqtt, logger);
  db.discover(jobId, "", new Date().toISOString(), "webhook");
  db.updateJob(jobId, { sidecar_state: "summary_complete", job_ready_suppressed: 1 });

  try {
    await service.runCycle();
    assert.equal(db.pendingEvents().some((event) => event.event_type === "job_ready"), false);

    db.startNewAttempt(jobId, new Date().toISOString());
    await service.runCycle();
    assert.equal(db.getJob(jobId)?.job_ready_suppressed, 0);
    assert.equal(db.pendingEvents().some((event) => event.event_type === "job_ready"), true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("delivers the job_ready payload to an authenticated webhook once", async () => {
  const requests: Array<{ authorization?: string; idempotencyKey?: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        body
      });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-webhook-"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_NOTIFICATION_WEBHOOK_URL: `http://127.0.0.1:${address.port}/ready`,
    SIDECARR_NOTIFICATION_WEBHOOK_TOKEN: "notification-secret"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const service = new NotificationService(config, db, logger);
  const row = db.discover(jobId, "", new Date().toISOString(), "webhook").job;

  try {
    service.enqueue(row, payload());
    service.enqueue(row, payload());
    await service.flush();
    await service.flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.authorization, "Bearer notification-secret");
    assert.equal(requests[0]?.idempotencyKey, `${jobId}:1:job_ready`);
    assert.deepEqual(JSON.parse(requests[0]!.body), payload());
  } finally {
    service.close();
    db.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sends a customizable job_ready email once", async () => {
  const messages: Array<{ from?: string; to?: string; subject?: string; text?: string }> = [];
  const transporter = {
    sendMail: async (message: { from?: string; to?: string; subject?: string; text?: string }) => {
      messages.push(message);
      return {};
    },
    close: () => undefined
  } as unknown as Pick<Transporter, "sendMail" | "close">;
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-email-"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_SMTP_URL: "smtps://user:password@smtp.example.com:465",
    SIDECARR_EMAIL_FROM: "Scriberr <scriberr@example.com>",
    SIDECARR_EMAIL_TO: "owner@example.com",
    SIDECARR_EMAIL_SUBJECT_TEMPLATE: "Ready ({outcome}): {title}"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const service = new NotificationService(config, db, logger, transporter);
  const row = db.discover(jobId, "", new Date().toISOString(), "webhook").job;

  try {
    service.enqueue(row, payload());
    await service.flush();
    await service.flush();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.subject, "Ready (ready): Doctor appointment");
    assert.match(messages[0]?.text ?? "", /Notion: https:\/\/notion\.so\/page/);
    assert.match(messages[0]?.text ?? "", new RegExp(`/audio/${jobId}`));
  } finally {
    service.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failing webhook does not block email and stops after three attempts", async () => {
  let webhookRequests = 0;
  const server = createServer((_request, response) => {
    webhookRequests += 1;
    response.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  let emails = 0;
  const transporter = {
    sendMail: async () => {
      emails += 1;
      return {};
    },
    close: () => undefined
  } as unknown as Pick<Transporter, "sendMail" | "close">;
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-ready-independent-"));
  const config = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_NOTIFICATION_WEBHOOK_URL: `http://127.0.0.1:${address.port}/ready`,
    SIDECARR_SMTP_URL: "smtp://smtp.example.com:587",
    SIDECARR_EMAIL_FROM: "scriberr@example.com",
    SIDECARR_EMAIL_TO: "owner@example.com"
  });
  const db = new StateStore(path.join(directory, "state.db"));
  const service = new NotificationService(config, db, logger, transporter);
  const row = db.discover(jobId, "", new Date().toISOString(), "webhook").job;

  try {
    service.enqueue(row, payload());
    await service.flush();
    await service.flush();
    await service.flush();
    await service.flush();
    assert.equal(emails, 1);
    assert.equal(webhookRequests, 3);
    assert.equal(db.pendingNotificationDeliveries().length, 0);
  } finally {
    service.close();
    db.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects partial MQTT, webhook, and SMTP configuration", () => {
  const base = { SIDECARR_SCRIBERR_URL: "http://scriberr", SIDECARR_SCRIBERR_API_KEY: "api-key" };
  assert.throws(() => loadConfig({ ...base, SIDECARR_MQTT_USERNAME: "user" }), /SIDECARR_MQTT_URL/);
  assert.throws(() => loadConfig({ ...base, SIDECARR_NOTIFICATION_WEBHOOK_TOKEN: "token" }), /SIDECARR_NOTIFICATION_WEBHOOK_URL/);
  assert.throws(() => loadConfig({ ...base, SIDECARR_SMTP_URL: "smtp://mail.example.com" }), /SIDECARR_EMAIL_FROM/);
  assert.equal(
    sanitizeError("delivery failed at smtps://user:super-secret@smtp.example.com:465"),
    "delivery failed at smtps://[REDACTED]@smtp.example.com:465"
  );
});
