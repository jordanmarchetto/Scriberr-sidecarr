import pino from "pino";
import { loadBootstrapConfig } from "./config.js";
import { ConfigurationManager } from "./configuration-manager.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { Metrics } from "./metrics.js";
import { ScriberrJobReconciler } from "./job-reconciliation.js";
import { NotebookService } from "./notebook-service.js";
import { NotionPublisher } from "./notion-publisher.js";
import { NotificationService } from "./notification-service.js";
import { ScriberrApi } from "./scriberr-api.js";
import { ScriberrReadinessGate } from "./scriberr-readiness.js";
import { SidecarService } from "./service.js";
import { WebhookReceiver } from "./webhook-receiver.js";
import { WebhookRegistration } from "./webhook-registration.js";

const bootstrap = loadBootstrapConfig();
const logger = pino({ level: bootstrap.logLevel });

function safeEndpoint(value?: string): string {
  if (!value) return "disabled";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}

try {
  const db = new StateStore(bootstrap.dbPath);
  const configuration = new ConfigurationManager(process.env, db);
  const { config } = configuration.current;
  for (const issue of configuration.current.issues) {
    logger.warn({ setting: issue.env, group: issue.group, source: issue.source, error: issue.message }, "configuration setting is unavailable");
  }
  logger.info({
    discoveryMode: config.discoveryMode,
    scriberrEndpoint: safeEndpoint(config.scriberrUrl),
    scriberrPublicEndpoint: safeEndpoint(config.scriberrPublicUrl),
    mqttEndpoint: safeEndpoint(config.mqttUrl),
    mqttTopicPrefix: config.mqttTopicPrefix,
    watchFolder: config.watchFolder,
    scanIntervalSeconds: config.scanIntervalMs / 1000,
    reconciliationIntervalSeconds: config.reconciliationIntervalMs / 1000,
    apiTimeoutSeconds: config.apiTimeoutMs / 1000,
    apiMaxAttempts: config.apiMaxAttempts,
    webhookCallbackUrl: safeEndpoint(config.webhookCallbackUrl),
    webhookListen: `${config.webhookHost}:${config.webhookPort}${config.webhookPath}`,
    autogenerateSummary: config.autogenerateSummary,
    summaryTemplate: config.summaryTemplate,
    notebookProvider: config.notebookProvider ?? "disabled",
    notificationWebhookEndpoint: safeEndpoint(config.notificationWebhookUrl),
    smtpEndpoint: safeEndpoint(config.smtpUrl)
  }, "configuration loaded");
  const metrics = new Metrics();
  logger.info({ dbPath: config.dbPath }, "state database opened");
  const api = new ScriberrApi(config, metrics, logger);
  const readiness = new ScriberrReadinessGate(api, logger);
  const registration = new WebhookRegistration(config, db, api, logger);
  const jobReconciliation = new ScriberrJobReconciler(config, db, api, logger);
  const runtimeConfig = { ...config, webhookSecret: registration.secret };
  let mqtt: MqttPublisher;
  try {
    mqtt = new MqttPublisher(runtimeConfig, db, logger, metrics);
  } catch (error) {
    logger.error({ integration: "mqtt", error: sanitizeError(error) }, "optional integration failed to initialize; integration is disabled");
    mqtt = new MqttPublisher({ ...runtimeConfig, mqttUrl: undefined, mqttUsername: undefined, mqttPassword: undefined }, db, logger, metrics);
  }
  let notifications: NotificationService;
  try {
    notifications = new NotificationService(runtimeConfig, db, logger);
  } catch (error) {
    logger.error({ integration: "notifications", error: sanitizeError(error) }, "optional integration failed to initialize; integration is disabled");
    notifications = new NotificationService({
      ...runtimeConfig,
      notificationWebhookUrl: undefined,
      notificationWebhookToken: undefined,
      smtpUrl: undefined,
      emailFrom: undefined,
      emailTo: undefined
    }, db, logger);
  }
  let notion: NotionPublisher | undefined;
  if (runtimeConfig.notebookProvider === "notion") {
    try {
      notion = new NotionPublisher(runtimeConfig, db, api, logger);
    } catch (error) {
      logger.error({ integration: "notion", error: sanitizeError(error) }, "optional integration failed to initialize; integration is disabled");
    }
  }
  if (notion) {
    logger.info({ provider: notion.provider, parentPageId: notion.parentPageId }, "notebook destination enabled");
  }
  const notebook = notion ? new NotebookService(runtimeConfig, db, notion, logger) : undefined;
  const service = new SidecarService(
    runtimeConfig,
    db,
    api,
    mqtt,
    logger,
    metrics,
    notebook,
    notifications,
    jobReconciliation
  );
  let interval: NodeJS.Timeout | undefined;

  const runCycle = async () => {
    if (!configuration.current.canProcess) return false;
    return readiness.run(async () => {
      const webhookActive = await registration.reconcile();
      service.setFilesystemDiscoveryEnabled(!webhookActive);
      await service.runCycle();
    });
  };
  const receiver = new WebhookReceiver(
    runtimeConfig,
    db,
    async () => { await runCycle(); },
    logger,
    metrics,
    () => configuration.current.canProcess ? readiness.status : "configuration_required"
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    if (interval) clearInterval(interval);
    await receiver.close();
    mqtt.close();
    notifications.close();
    configuration.close();
    db.close();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await receiver.listen();
  if (!configuration.current.canProcess) {
    logger.warn("Scriberr background processing is paused until required configuration is provided");
  }
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
