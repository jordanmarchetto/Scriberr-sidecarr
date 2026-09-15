import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { ConfigurationManager } from "../src/configuration-manager.ts";
import { loadConfig, resolveConfig, safeSettingsSnapshot, settingRegistry } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { WebhookReceiver } from "../src/webhook-receiver.ts";

const coreEnv = {
  SIDECARR_SCRIBERR_URL: "http://scriberr",
  SIDECARR_SCRIBERR_API_KEY: "environment-key"
};

function scenario(): { directory: string; db: StateStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-config-"));
  return { directory, db: new StateStore(path.join(directory, "state.db")) };
}

test("registry describes every setting and resolves environment over database over default", () => {
  const value = scenario();
  try {
    value.db.setApplicationSettings(new Map([
      ["scriberrApiKey", "database-key"],
      ["mqttTopicPrefix", "database/topic"],
      ["mqttRetain", "true"]
    ]));
    const resolution = resolveConfig({ ...coreEnv, SIDECARR_MQTT_TOPIC_PREFIX: "environment/topic" }, value.db);
    assert.equal(resolution.config.scriberrApiKey, "environment-key");
    assert.equal(resolution.settings.get("scriberrApiKey")?.source, "environment");
    assert.equal(resolution.settings.get("scriberrApiKey")?.editable, false);
    assert.equal(resolution.config.mqttTopicPrefix, "environment/topic");
    assert.equal(resolution.config.mqttRetain, true);
    assert.equal(resolution.settings.get("scanIntervalSeconds")?.source, "default");
    assert.equal(new Set(settingRegistry.map((setting) => setting.key)).size, settingRegistry.length);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("empty values fall through while explicit false and zero remain meaningful", () => {
  const value = scenario();
  try {
    value.db.setApplicationSettings(new Map([
      ["mqttRetain", "true"],
      ["apiRetryBaseMilliseconds", "50"]
    ]));
    const resolution = resolveConfig({
      ...coreEnv,
      SIDECARR_MQTT_RETAIN: "false",
      SIDECARR_API_RETRY_BASE_MILLISECONDS: "0",
      SIDECARR_MQTT_TOPIC_PREFIX: ""
    }, value.db);
    assert.equal(resolution.config.mqttRetain, false);
    assert.equal(resolution.config.apiRetryBaseMs, 0);
    assert.equal(resolution.config.mqttTopicPrefix, "home/audio/scriberr");
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("safe setting snapshots expose defaults and provenance without secret values", () => {
  const resolution = resolveConfig(coreEnv);
  const snapshot = safeSettingsSnapshot(resolution);
  const apiKey = snapshot.find((setting) => setting.key === "scriberrApiKey");
  const interval = snapshot.find((setting) => setting.key === "scanIntervalSeconds");
  assert.equal(apiKey?.configured, true);
  assert.equal(apiKey?.value, undefined);
  assert.equal(apiKey?.source, "environment");
  assert.equal(interval?.defaultValue, "30");
  assert.equal(interval?.source, "default");
});

test("database values remain dormant beneath an environment override", () => {
  const value = scenario();
  try {
    value.db.setApplicationSettings(new Map([["summaryTemplate", "Stored template"]]));
    assert.equal(resolveConfig({ ...coreEnv, SIDECARR_SUMMARY_TEMPLATE: "Environment template" }, value.db).config.summaryTemplate, "Environment template");
    assert.equal(resolveConfig(coreEnv, value.db).config.summaryTemplate, "Stored template");
    assert.ok(value.db.getApplicationSettingUpdatedAt("summaryTemplate"));
    assert.equal(statSync(path.join(value.directory, "state.db")).mode & 0o777, 0o600);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("partial optional integrations degrade independently in runtime resolution", () => {
  const resolution = resolveConfig({
    ...coreEnv,
    SIDECARR_MQTT_USERNAME: "user",
    SIDECARR_SMTP_URL: "smtp://mail.example.com",
    SIDECARR_NOTEBOOK_PROVIDER: "notion"
  });
  assert.equal(resolution.canProcess, true);
  assert.equal(resolution.config.mqttUrl, undefined);
  assert.equal(resolution.config.smtpUrl, undefined);
  assert.equal(resolution.config.notebookProvider, undefined);
  assert.deepEqual(new Set(resolution.issues.map((issue) => issue.group)), new Set(["mqtt", "notifications", "notion"]));
  assert.throws(() => loadConfig({ ...coreEnv, SIDECARR_MQTT_USERNAME: "user" }), /SIDECARR_MQTT_URL/);
});

test("missing core configuration keeps the health listener available", async () => {
  const value = scenario();
  const resolution = resolveConfig({}, value.db);
  const receiver = new WebhookReceiver(
    resolution.config,
    value.db,
    () => undefined,
    pino({ level: "silent" }),
    undefined,
    () => "configuration_required"
  );
  try {
    assert.equal(resolution.canProcess, false);
    await receiver.listen(0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${receiver.port()}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", scriberr: "configuration_required" });
  } finally {
    await receiver.close();
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("group updates are atomic, respect environment ownership, and isolate activation failures", async () => {
  const value = scenario();
  const manager = new ConfigurationManager(coreEnv, value.db);
  let mqttActivations = 0;
  manager.registerActivator("mqtt", () => {
    mqttActivations += 1;
    throw new Error("broker unavailable");
  });
  try {
    const update = await manager.updateGroup("mqtt", new Map([
      ["mqttUrl", "mqtt://broker"],
      ["mqttTopicPrefix", "new/topic"]
    ]));
    assert.equal(update.resolution.config.mqttUrl, "mqtt://broker");
    assert.equal(update.resolution.config.mqttTopicPrefix, "new/topic");
    assert.match(update.activationError?.message ?? "", /broker unavailable/);
    assert.equal(mqttActivations, 1);
    assert.equal(manager.current.canProcess, true);
    await assert.rejects(
      manager.updateGroup("scriberr", new Map([["scriberrApiKey", "replacement"]])),
      /controlled by the environment/
    );
  } finally {
    manager.close();
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});
