import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig, type Config } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import type { MqttPublisher } from "../src/mqtt-publisher.ts";
import { ScriberrApi, ScriberrApiError } from "../src/scriberr-api.ts";
import { SidecarService } from "../src/service.ts";
import type { ScriberrJob, ScriberrWebhook, ScriberrWebhookInput } from "../src/types.ts";
import { WebhookRegistration } from "../src/webhook-registration.ts";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const logger = pino({ level: "silent" });

class FakeScriberrApi extends ScriberrApi {
  hooks: ScriberrWebhook[] = [];
  listError: Error | undefined;
  listCalls = 0;
  createCalls = 0;
  updateCalls = 0;
  lastInput: ScriberrWebhookInput | undefined;

  override async listWebhooks(): Promise<ScriberrWebhook[]> {
    this.listCalls += 1;
    if (this.listError) throw this.listError;
    return this.hooks;
  }

  override async createWebhook(input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    this.createCalls += 1;
    this.lastInput = input;
    const hook: ScriberrWebhook = {
      id: "managed-hook",
      name: input.name,
      url: input.url,
      events: input.events,
      enabled: input.enabled,
      has_secret: Boolean(input.secret)
    };
    this.hooks = [hook];
    return hook;
  }

  override async updateWebhook(id: string, input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    this.updateCalls += 1;
    this.lastInput = input;
    const hook: ScriberrWebhook = {
      id,
      name: input.name,
      url: input.url,
      events: input.events,
      enabled: input.enabled,
      has_secret: Boolean(input.secret)
    };
    this.hooks = [hook];
    return hook;
  }
}

type Scenario = {
  api: FakeScriberrApi;
  config: Config;
  db: StateStore;
  directory: string;
};

function scenario(env: NodeJS.ProcessEnv = {}): Scenario {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-registration-"));
  const config = loadConfig({
    SIDECARR_WATCH_FOLDER: directory,
    SIDECARR_SCRIBERR_URL: "http://scriberr:8080",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    ...env
  });
  const db = new StateStore(path.join(directory, "state.db"));
  return { api: new FakeScriberrApi(config), config, db, directory };
}

function cleanup(value: Scenario): void {
  value.db.close();
  rmSync(value.directory, { recursive: true, force: true });
}

test("webhook discovery automatically creates and remembers its Scriberr subscription", async () => {
  const value = scenario();
  try {
    const registration = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(await registration.reconcile(), true);
    assert.equal(value.api.createCalls, 1);
    assert.equal(value.api.lastInput?.url, "http://scriberr-sidecarr:8080/webhooks/scriberr");
    assert.deepEqual(value.api.lastInput?.events, [
      "recording.uploaded",
      "transcription.completed",
      "transcription.failed",
      "summary.completed",
      "summary.failed"
    ]);
    assert.equal(value.api.lastInput?.secret.length, 64);
    assert.equal(value.db.getSetting("managed_webhook_id"), "managed-hook");
    assert.equal(value.db.getSetting("managed_webhook_secret"), value.api.lastInput?.secret);

    const restarted = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(restarted.secret, registration.secret);
    assert.equal(await restarted.reconcile(), true);
    assert.equal(value.api.createCalls, 1);
    assert.equal(value.api.updateCalls, 1);
  } finally {
    cleanup(value);
  }
});

test("webhook discovery repairs an existing Sidecarr subscription", async () => {
  const value = scenario({ SIDECARR_WEBHOOK_CALLBACK_URL: "http://sidecar:9090/custom-hook" });
  try {
    value.api.hooks = [{
      id: "old-hook",
      name: "Scriberr Sidecarr",
      url: "http://old-sidecar:8080/webhooks/scriberr",
      events: ["transcription.completed"],
      enabled: false,
      has_secret: false
    }];
    value.db.setSetting("managed_webhook_id", "old-hook");
    const registration = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(await registration.reconcile(), true);
    assert.equal(value.api.updateCalls, 1);
    assert.equal(value.api.lastInput?.url, "http://sidecar:9090/custom-hook");
    assert.equal(value.api.lastInput?.enabled, true);
  } finally {
    cleanup(value);
  }
});

test("missing webhook routes fall back without repeated registration attempts", async () => {
  const value = scenario();
  try {
    value.api.listError = new ScriberrApiError(404, "Scriberr API 404");
    const registration = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(await registration.reconcile(), false);
    assert.equal(await registration.reconcile(), false);
    assert.equal(value.api.listCalls, 1);
    assert.equal(value.api.createCalls, 0);
  } finally {
    cleanup(value);
  }
});

test("temporary webhook failures are backed off instead of retried every cycle", async () => {
  const value = scenario();
  try {
    value.api.listError = new Error("temporary outage");
    const registration = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(await registration.reconcile(), false);
    assert.equal(await registration.reconcile(), false);
    assert.equal(value.api.listCalls, 1);
  } finally {
    cleanup(value);
  }
});

test("webhook mode does not poll terminal jobs without a new signal", async () => {
  const value = scenario();
  try {
    const row = value.db.discover(jobId, "", new Date().toISOString(), "webhook").job;
    value.db.updateJob(row.job_id, { sidecar_state: "summary_complete", scriberr_status: "completed" });
    let jobLookups = 0;
    const api = new class extends ScriberrApi {
      override async getJob(): Promise<ScriberrJob> {
        jobLookups += 1;
        return { id: jobId, status: "completed", summary: "done" };
      }
    }(value.config);
    const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
    const service = new SidecarService(value.config, value.db, api, mqtt, logger);
    service.setFilesystemDiscoveryEnabled(false);

    await service.runCycle();

    assert.equal(jobLookups, 0);
  } finally {
    cleanup(value);
  }
});

test("a missing Scriberr job is recorded once and not polled forever", async () => {
  const value = scenario();
  try {
    value.db.discover(jobId, "", new Date().toISOString(), "webhook");
    let jobLookups = 0;
    const api = new class extends ScriberrApi {
      override async getJob(): Promise<ScriberrJob> {
        jobLookups += 1;
        throw new ScriberrApiError(404, "job not found");
      }
    }(value.config);
    const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
    const service = new SidecarService(value.config, value.db, api, mqtt, logger);
    service.setFilesystemDiscoveryEnabled(false);

    await service.runCycle();
    await service.runCycle();

    assert.equal(jobLookups, 1);
    assert.equal(value.db.getJob(jobId)?.scriberr_status, "not_found");
  } finally {
    cleanup(value);
  }
});

test("failed background lookups back off and each cycle has a bounded batch", async () => {
  const value = scenario();
  try {
    for (let index = 0; index < 8; index += 1) {
      value.db.discover(`job-${index}`, "", new Date().toISOString(), "filesystem");
    }
    let jobLookups = 0;
    const api = new class extends ScriberrApi {
      override async getJob(): Promise<ScriberrJob> {
        jobLookups += 1;
        throw new Error("temporary timeout");
      }
    }(value.config);
    const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
    const service = new SidecarService(value.config, value.db, api, mqtt, logger);
    service.setFilesystemDiscoveryEnabled(false);

    await service.runCycle();
    assert.equal(jobLookups, 5);
    await service.runCycle();
    assert.equal(jobLookups, 8);
    await service.runCycle();
    assert.equal(jobLookups, 8);
  } finally {
    cleanup(value);
  }
});

test("a failed webhook-triggered lookup retains the signal but respects backoff", async () => {
  const value = scenario();
  try {
    const receivedAt = new Date().toISOString();
    value.db.recordWebhookSignal("delivery-1", {
      schema_version: "1",
      event: "transcription.completed",
      job_id: jobId,
      status: "completed",
      occurred_at: receivedAt
    }, receivedAt);
    let jobLookups = 0;
    const api = new class extends ScriberrApi {
      override async getJob(): Promise<ScriberrJob> {
        jobLookups += 1;
        throw new Error("temporary timeout");
      }
    }(value.config);
    const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
    const service = new SidecarService(value.config, value.db, api, mqtt, logger);
    service.setFilesystemDiscoveryEnabled(false);

    await service.runCycle();
    await service.runCycle();

    assert.equal(jobLookups, 1);
    assert.equal(value.db.pendingWebhookSignalCount(), 1);
  } finally {
    cleanup(value);
  }
});

test("filesystem mode skips webhook management", async () => {
  const value = scenario({ SIDECARR_DISCOVERY_MODE: "filesystem" });
  try {
    const registration = new WebhookRegistration(value.config, value.db, value.api, logger);
    assert.equal(await registration.reconcile(), false);
    assert.equal(value.api.listCalls, 0);
  } finally {
    cleanup(value);
  }
});

test("filesystem discovery can be disabled after webhook registration succeeds", async () => {
  const value = scenario();
  try {
    mkdirSync(path.join(value.directory, jobId));
    const api = new class extends ScriberrApi {
      override async getJob(id: string): Promise<ScriberrJob> {
        return { id, status: "pending" };
      }
    }(value.config);
    const mqtt = { flush: async () => undefined } as unknown as MqttPublisher;
    const service = new SidecarService(value.config, value.db, api, mqtt, logger);

    service.setFilesystemDiscoveryEnabled(false);
    await service.runCycle();
    assert.equal(value.db.getJob(jobId), undefined);

    service.setFilesystemDiscoveryEnabled(true);
    await service.runCycle();
    assert.equal(value.db.getJob(jobId)?.source, "filesystem");
  } finally {
    cleanup(value);
  }
});
