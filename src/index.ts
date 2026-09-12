import pino from "pino";
import { loadConfig } from "./config.js";
import { StateStore } from "./db.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { Metrics } from "./metrics.js";
import { ScriberrApi } from "./scriberr-api.js";
import { SidecarService } from "./service.js";
import { WebhookReceiver } from "./webhook-receiver.js";
import { WebhookRegistration } from "./webhook-registration.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

try {
  const config = loadConfig();
  logger.info({
    discoveryMode: config.discoveryMode,
    scriberrEndpoint: safeEndpoint(config.scriberrUrl),
    mqttEndpoint: safeEndpoint(config.mqttUrl),
    mqttTopicPrefix: config.mqttTopicPrefix,
    watchFolder: config.watchFolder,
    scanIntervalSeconds: config.scanIntervalMs / 1000,
    apiTimeoutSeconds: config.apiTimeoutMs / 1000,
    apiMaxAttempts: config.apiMaxAttempts,
    webhookCallbackUrl: safeEndpoint(config.webhookCallbackUrl),
    webhookListen: `${config.webhookHost}:${config.webhookPort}${config.webhookPath}`,
    autogenerateSummary: config.autogenerateSummary,
    summaryTemplate: config.summaryTemplate
  }, "configuration loaded");
  const metrics = new Metrics();
  const db = new StateStore(config.dbPath);
  logger.info({ dbPath: config.dbPath }, "state database opened");
  const api = new ScriberrApi(config, metrics, logger);
  const registration = new WebhookRegistration(config, db, api, logger);
  const runtimeConfig = { ...config, webhookSecret: registration.secret };
  const mqtt = new MqttPublisher(runtimeConfig, db, logger, metrics);
  const service = new SidecarService(runtimeConfig, db, api, mqtt, logger, metrics);
  const receiver = new WebhookReceiver(runtimeConfig, db, () => service.runCycle(), logger, metrics);
  let interval: NodeJS.Timeout | undefined;

  const runCycle = async () => {
    const webhookActive = await registration.reconcile();
    service.setFilesystemDiscoveryEnabled(!webhookActive);
    await service.runCycle();
  };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    if (interval) clearInterval(interval);
    await receiver.close();
    mqtt.close();
    db.close();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await receiver.listen();
  await runCycle();
  interval = setInterval(
    () => runCycle().catch((error) => logger.error({ err: error }, "cycle failed")),
    config.scanIntervalMs
  );
  logger.info({ discoveryMode: config.discoveryMode, intervalSeconds: config.scanIntervalMs / 1000 }, "scriberr sidecarr started");
} catch (error) {
  logger.fatal({ err: error }, "scriberr sidecarr failed to start");
  process.exit(1);
}
