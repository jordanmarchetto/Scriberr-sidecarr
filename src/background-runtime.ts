import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { ScriberrJobReconciler } from "./job-reconciliation.js";
import { Metrics } from "./metrics.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { NotebookService } from "./notebook-service.js";
import { NotionPublisher } from "./notion-publisher.js";
import { NotificationService } from "./notification-service.js";
import { ScriberrApi } from "./scriberr-api.js";
import { ScriberrReadinessGate, type ScriberrReadinessStatus } from "./scriberr-readiness.js";
import { SidecarService } from "./service.js";
import { WebhookRegistration } from "./webhook-registration.js";

export class BackgroundRuntime {
  readonly webhookSecret: string | undefined;
  private readonly readiness: ScriberrReadinessGate;
  private readonly registration: WebhookRegistration;
  private readonly mqtt: MqttPublisher;
  private readonly notifications: NotificationService;
  private readonly service: SidecarService;
  private closed = false;

  constructor(
    private readonly config: Config,
    db: StateStore,
    logger: pino.Logger,
    metrics: Metrics
  ) {
    const api = new ScriberrApi(config, metrics, logger);
    this.readiness = new ScriberrReadinessGate(api, logger);
    this.registration = new WebhookRegistration(config, db, api, logger);
    const runtimeConfig = { ...config, webhookSecret: this.registration.secret };
    this.webhookSecret = runtimeConfig.webhookSecret;

    try {
      this.mqtt = new MqttPublisher(runtimeConfig, db, logger, metrics);
    } catch (error) {
      logger.error({ integration: "mqtt", error: sanitizeError(error) }, "optional integration failed to initialize; integration is disabled");
      this.mqtt = new MqttPublisher({ ...runtimeConfig, mqttUrl: undefined, mqttUsername: undefined, mqttPassword: undefined }, db, logger, metrics);
    }
    try {
      this.notifications = new NotificationService(runtimeConfig, db, logger);
    } catch (error) {
      logger.error({ integration: "notifications", error: sanitizeError(error) }, "optional integration failed to initialize; integration is disabled");
      this.notifications = new NotificationService({
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
    if (notion) logger.info({ provider: notion.provider, parentPageId: notion.parentPageId }, "notebook destination enabled");
    const notebook = notion ? new NotebookService(runtimeConfig, db, notion, logger) : undefined;
    const reconciliation = new ScriberrJobReconciler(runtimeConfig, db, api, logger);
    this.service = new SidecarService(
      runtimeConfig,
      db,
      api,
      this.mqtt,
      logger,
      metrics,
      notebook,
      this.notifications,
      reconciliation
    );
  }

  get status(): ScriberrReadinessStatus {
    return this.config.scriberrApiKey ? this.readiness.status : "configuration_required";
  }

  async runCycle(): Promise<boolean> {
    if (this.closed || !this.config.scriberrApiKey) return false;
    return this.readiness.run(async () => {
      const webhookActive = await this.registration.reconcile();
      this.service.setFilesystemDiscoveryEnabled(!webhookActive);
      await this.service.runCycle();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.mqtt.close();
    this.notifications.close();
  }
}
