import pino from "pino";
import { loadConfig } from "./config.js";
import { StateStore } from "./db.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { ScriberrApi } from "./scriberr-api.js";
import { SidecarService } from "./service.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

try {
  const config = loadConfig();
  const db = new StateStore(config.dbPath);
  const api = new ScriberrApi(config);
  const mqtt = new MqttPublisher(config, db, logger);
  const service = new SidecarService(config, db, api, mqtt, logger);

  const shutdown = () => {
    logger.info("shutting down");
    mqtt.close();
    db.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await service.runCycle();
  setInterval(() => service.runCycle().catch((error) => logger.error({ error }, "cycle failed")), config.scanIntervalMs);
  logger.info({ intervalSeconds: config.scanIntervalMs / 1000 }, "scriberr sidecarr started");
} catch (error) {
  logger.fatal({ error }, "scriberr sidecarr failed to start");
  process.exit(1);
}
