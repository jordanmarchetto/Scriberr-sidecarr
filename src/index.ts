import pino from "pino";
import { loadConfig } from "./config.js";
import { StateStore } from "./db.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { Metrics } from "./metrics.js";
import { ScriberrApi } from "./scriberr-api.js";
import { SidecarService } from "./service.js";
import { WebhookReceiver } from "./webhook-receiver.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

try {
  const config = loadConfig();
  const metrics = new Metrics();
  const db = new StateStore(config.dbPath);
  const api = new ScriberrApi(config, metrics);
  const mqtt = new MqttPublisher(config, db, logger, metrics);
  const service = new SidecarService(config, db, api, mqtt, logger, metrics);
  const receiver = new WebhookReceiver(config, db, () => service.runCycle(), logger, metrics);
  let interval: NodeJS.Timeout | undefined;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down");
    if (interval) clearInterval(interval);
    await receiver.close();
    mqtt.close();
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await receiver.listen();
  await service.runCycle();
  interval = setInterval(
    () => service.runCycle().catch((error) => logger.error({ error }, "cycle failed")),
    config.scanIntervalMs
  );
  logger.info({ intervalSeconds: config.scanIntervalMs / 1000 }, "scriberr sidecarr started");
} catch (error) {
  logger.fatal({ error }, "scriberr sidecarr failed to start");
  process.exit(1);
}
