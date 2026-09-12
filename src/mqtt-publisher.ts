import mqtt, { type MqttClient } from "mqtt";
import type { Config } from "./config.js";
import { sanitizeError } from "./errors.js";
import { StateStore } from "./db.js";
import type { PendingEvent } from "./db.js";
import pino from "pino";
import { Metrics } from "./metrics.js";

export class MqttPublisher {
  private readonly client: MqttClient;
  private connected = false;
  private reconnectAttempt = 0;
  private closing = false;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly logger: pino.Logger,
    private readonly metrics = new Metrics()
  ) {
    this.client = mqtt.connect(config.mqttUrl, {
      username: config.mqttUsername,
      password: config.mqttPassword,
      reconnectPeriod: 5000,
      connectTimeout: 10000
    });
    this.client.on("connect", () => {
      const reconnected = this.reconnectAttempt > 0;
      this.connected = true;
      this.logger.info({ endpoint: this.safeEndpoint(), reconnected }, "mqtt connected");
      this.reconnectAttempt = 0;
    });
    this.client.on("reconnect", () => {
      this.connected = false;
      this.reconnectAttempt += 1;
      this.logger.warn({ endpoint: this.safeEndpoint(), attempt: this.reconnectAttempt }, "mqtt reconnecting");
    });
    this.client.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected && !this.closing) this.logger.warn({ endpoint: this.safeEndpoint() }, "mqtt connection closed");
    });
    this.client.on("error", (error) => this.logger.error({ error: error.message }, "mqtt error"));
  }

  async flush(): Promise<void> {
    for (const event of this.db.pendingEvents()) {
      try {
        await this.publish(event);
        this.db.markPublished(event.id, new Date().toISOString());
        this.logger.debug({
          eventId: event.id,
          jobId: event.job_id,
          eventType: event.event_type,
          topic: this.topic(event),
          attempt: event.publish_attempts + 1
        }, "mqtt event published");
      } catch (error) {
        this.metrics.incrementMqttFailure();
        const message = sanitizeError(error);
        this.db.recordPublishAttempt(event.id, message);
        this.logger.warn({
          eventId: event.id,
          jobId: event.job_id,
          eventType: event.event_type,
          topic: this.topic(event),
          attempt: event.publish_attempts + 1,
          connected: this.connected,
          error: message
        }, "mqtt publish failed");
        break;
      }
    }
  }

  close(): void {
    this.closing = true;
    this.client.end(true);
  }

  private async publish(event: PendingEvent): Promise<void> {
    await this.waitForConnection();
    const topic = this.topic(event);
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, event.payload_json, {
        qos: this.config.mqttQos,
        retain: this.config.mqttRetain
      }, (error) => error ? reject(error) : resolve());
    });
  }

  private topic(event: PendingEvent): string {
    return `${this.config.mqttTopicPrefix}/${event.job_id}/${event.event_type}`;
  }

  private safeEndpoint(): string {
    try {
      const url = new URL(this.config.mqttUrl);
      return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
    } catch {
      return "invalid endpoint";
    }
  }

  private async waitForConnection(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("MQTT connection timeout"));
      }, 10000);
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        clearTimeout(timeout);
        this.client.off("connect", onConnect);
        this.client.off("error", onError);
      };
      this.client.once("connect", onConnect);
      this.client.once("error", onError);
    });
  }
}
