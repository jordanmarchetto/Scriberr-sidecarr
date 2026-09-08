import mqtt, { type MqttClient } from "mqtt";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import type { PendingEvent } from "./db.js";
import pino from "pino";

export class MqttPublisher {
  private readonly client: MqttClient;
  private connected = false;

  constructor(private readonly config: Config, private readonly db: StateStore, private readonly logger: pino.Logger) {
    this.client = mqtt.connect(config.mqttUrl, {
      username: config.mqttUsername,
      password: config.mqttPassword,
      reconnectPeriod: 5000,
      connectTimeout: 10000
    });
    this.client.on("connect", () => {
      this.connected = true;
      this.logger.info("mqtt connected");
    });
    this.client.on("reconnect", () => {
      this.connected = false;
      this.logger.warn("mqtt reconnecting");
    });
    this.client.on("close", () => { this.connected = false; });
    this.client.on("error", (error) => this.logger.error({ error: error.message }, "mqtt error"));
  }

  async flush(): Promise<void> {
    for (const event of this.db.pendingEvents()) {
      try {
        await this.publish(event);
        this.db.markPublished(event.id, new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.recordPublishAttempt(event.id, message);
        this.logger.warn({ eventId: event.id, eventType: event.event_type, error: message }, "mqtt publish failed");
        break;
      }
    }
  }

  close(): void {
    this.client.end(true);
  }

  private async publish(event: PendingEvent): Promise<void> {
    await this.waitForConnection();
    const topic = `${this.config.mqttTopicPrefix}/${event.job_id}/${event.event_type}`;
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, event.payload_json, {
        qos: this.config.mqttQos,
        retain: this.config.mqttRetain
      }, (error) => error ? reject(error) : resolve());
    });
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
