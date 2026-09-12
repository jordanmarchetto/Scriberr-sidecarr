import { randomBytes } from "node:crypto";
import pino from "pino";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { ScriberrApi, ScriberrApiError } from "./scriberr-api.js";
import type { ScriberrWebhook, ScriberrWebhookEvent, ScriberrWebhookInput } from "./types.js";

const webhookIdSetting = "managed_webhook_id";
const webhookSecretSetting = "managed_webhook_secret";
const webhookName = "Scriberr Sidecarr";
const reconciliationIntervalMs = 5 * 60 * 1000;
const events: ScriberrWebhookEvent[] = [
  "recording.uploaded",
  "transcription.completed",
  "transcription.failed",
  "summary.completed",
  "summary.failed"
];

export class WebhookRegistration {
  readonly secret: string | undefined;
  private active = false;
  private unsupported = false;
  private warnedUnavailable = false;
  private nextCheckAt = 0;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly api: ScriberrApi,
    private readonly logger: pino.Logger
  ) {
    if (config.discoveryMode === "filesystem") {
      this.secret = config.webhookSecret;
      return;
    }

    const storedSecret = db.getSetting(webhookSecretSetting);
    const configuredSecret = config.webhookSecret?.trim();
    this.secret = configuredSecret || storedSecret || randomBytes(32).toString("hex");
    db.setSetting(webhookSecretSetting, this.secret);
  }

  isActive(): boolean {
    return this.active;
  }

  async reconcile(): Promise<boolean> {
    if (this.config.discoveryMode === "filesystem" || this.unsupported) return false;
    if (this.active && Date.now() < this.nextCheckAt) return true;

    this.logger.debug("reconciling Scriberr webhook registration");

    let hooks: ScriberrWebhook[];
    try {
      hooks = await this.api.listWebhooks();
    } catch (error) {
      if (error instanceof ScriberrApiError && [404, 405].includes(error.status)) {
        this.unsupported = true;
        this.active = false;
        this.logger.info(
          { status: error.status, configuredDiscoveryMode: this.config.discoveryMode },
          "Scriberr webhook API is unsupported; using filesystem discovery and API polling"
        );
        return false;
      }
      this.active = false;
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn(
          { error: this.errorMessage(error) },
          "webhook registration unavailable; temporarily using filesystem discovery and API polling"
        );
      }
      return false;
    }

    const savedId = this.db.getSetting(webhookIdSetting);
    const hook = hooks.find((item) => item.id === savedId)
      ?? hooks.find((item) => item.name === webhookName && item.url === this.config.webhookCallbackUrl);
    const input: ScriberrWebhookInput = {
      name: webhookName,
      url: this.config.webhookCallbackUrl,
      events,
      enabled: true,
      secret: this.secret ?? ""
    };

    try {
      const action = hook ? "updated" : "created";
      const managed = hook
        ? await this.api.updateWebhook(hook.id, input)
        : await this.api.createWebhook(input);
      this.db.setSetting(webhookIdSetting, managed.id);
      if (!this.active) {
        this.logger.info(
          { webhookId: managed.id },
          `Scriberr webhook registration ${action}`
        );
      }
      this.active = true;
      this.warnedUnavailable = false;
      this.nextCheckAt = Date.now() + reconciliationIntervalMs;
      return true;
    } catch (error) {
      this.active = false;
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn(
          { error: this.errorMessage(error) },
          "webhook registration failed; temporarily using filesystem discovery and API polling"
        );
      }
      return false;
    }
  }

  private errorMessage(error: unknown): string {
    return sanitizeError(error instanceof Error ? error.message : error);
  }
}
