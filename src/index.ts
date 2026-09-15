import pino from "pino";
import { BackgroundRuntime } from "./background-runtime.js";
import { ScriberrBrowserAuth } from "./browser-auth.js";
import { loadBootstrapConfig } from "./config.js";
import { ConfigurationManager } from "./configuration-manager.js";
import { StateStore } from "./db.js";
import { Metrics } from "./metrics.js";
import { UiServer } from "./ui-server.js";
import { WebhookReceiver } from "./webhook-receiver.js";

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
  let runtime = new BackgroundRuntime(config, db, logger, metrics);
  const initialRuntime = runtime;
  configuration.registerActivator("scriberr", (next) => {
    const replacement = new BackgroundRuntime(next, db, logger, metrics);
    runtime = replacement;
    if (configuration.current.canProcess) {
      void replacement.runCycle().catch((error) => logger.error({ err: error }, "cycle failed after Scriberr configuration changed"));
    }
    return () => replacement.close();
  }, () => initialRuntime.close());
  let interval: NodeJS.Timeout | undefined;

  const runCycle = () => configuration.current.canProcess ? runtime.runCycle() : Promise.resolve(false);
  const auth = new ScriberrBrowserAuth(() => configuration.current.config);
  const ui = new UiServer(() => configuration.current.config, configuration, auth, logger);
  const receiver = new WebhookReceiver(
    { ...config, webhookSecret: runtime.webhookSecret },
    db,
    async () => { await runCycle(); },
    logger,
    metrics,
    () => configuration.current.canProcess ? runtime.status : "configuration_required",
    ui
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    if (interval) clearInterval(interval);
    await receiver.close();
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
