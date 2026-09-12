import { z } from "zod";

const bool = z
  .string()
  .optional()
  .default("false")
  .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));

const configSchema = z.object({
  SIDECARR_DISCOVERY_MODE: z.enum(["webhook", "filesystem"]).default("webhook"),
  SIDECARR_WATCH_FOLDER: z.string().default("/watch/transcripts"),
  SIDECARR_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  SIDECARR_SCRIBERR_URL: z.string().url(),
  SIDECARR_SCRIBERR_API_KEY: z.string().min(1),
  SIDECARR_API_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(15),
  SIDECARR_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  SIDECARR_API_RETRY_BASE_MILLISECONDS: z.coerce.number().int().min(0).default(500),
  SIDECARR_MQTT_URL: z.string().min(1),
  SIDECARR_MQTT_USERNAME: z.string().optional(),
  SIDECARR_MQTT_PASSWORD: z.string().optional(),
  SIDECARR_MQTT_TOPIC_PREFIX: z.string().min(1).default("home/audio/scriberr"),
  SIDECARR_MQTT_QOS: z.coerce.number().int().min(0).max(2).default(1),
  SIDECARR_MQTT_RETAIN: bool,
  SIDECARR_AUTOGENERATE_SUMMARY: bool,
  SIDECARR_SUMMARY_MODEL: z.string().optional(),
  SIDECARR_SUMMARY_TEMPLATE: z.string().optional().default("Default"),
  SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  SIDECARR_SUMMARY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3600),
  SIDECARR_WEBHOOK_HOST: z.string().min(1).default("0.0.0.0"),
  SIDECARR_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SIDECARR_WEBHOOK_PATH: z.string().startsWith("/").default("/webhooks/scriberr"),
  SIDECARR_WEBHOOK_CALLBACK_URL: z.string().url().optional(),
  SIDECARR_WEBHOOK_SECRET: z.string().optional(),
  SIDECARR_DB_PATH: z.string().default("/app/data/sidecar.db")
});

export type Config = {
  discoveryMode: "webhook" | "filesystem";
  watchFolder: string;
  scanIntervalMs: number;
  scriberrUrl: string;
  scriberrApiKey: string;
  apiTimeoutMs: number;
  apiMaxAttempts: number;
  apiRetryBaseMs: number;
  mqttUrl: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttTopicPrefix: string;
  mqttQos: 0 | 1 | 2;
  mqttRetain: boolean;
  autogenerateSummary: boolean;
  summaryModel?: string;
  summaryTemplate?: string;
  summaryPollIntervalMs: number;
  summaryTimeoutMs: number;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  webhookCallbackUrl: string;
  webhookSecret?: string;
  dbPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);
  return {
    discoveryMode: parsed.SIDECARR_DISCOVERY_MODE,
    watchFolder: parsed.SIDECARR_WATCH_FOLDER,
    scanIntervalMs: parsed.SIDECARR_SCAN_INTERVAL_SECONDS * 1000,
    scriberrUrl: parsed.SIDECARR_SCRIBERR_URL.replace(/\/$/, ""),
    scriberrApiKey: parsed.SIDECARR_SCRIBERR_API_KEY,
    mqttUrl: parsed.SIDECARR_MQTT_URL,
    apiTimeoutMs: parsed.SIDECARR_API_TIMEOUT_SECONDS * 1000,
    apiMaxAttempts: parsed.SIDECARR_API_MAX_ATTEMPTS,
    apiRetryBaseMs: parsed.SIDECARR_API_RETRY_BASE_MILLISECONDS,
    mqttUsername: parsed.SIDECARR_MQTT_USERNAME,
    mqttPassword: parsed.SIDECARR_MQTT_PASSWORD,
    mqttTopicPrefix: parsed.SIDECARR_MQTT_TOPIC_PREFIX.replace(/\/$/, ""),
    mqttQos: parsed.SIDECARR_MQTT_QOS as 0 | 1 | 2,
    mqttRetain: parsed.SIDECARR_MQTT_RETAIN,
    autogenerateSummary: parsed.SIDECARR_AUTOGENERATE_SUMMARY,
    summaryModel: parsed.SIDECARR_SUMMARY_MODEL,
    summaryTemplate: parsed.SIDECARR_SUMMARY_TEMPLATE,
    summaryPollIntervalMs: parsed.SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS * 1000,
    summaryTimeoutMs: parsed.SIDECARR_SUMMARY_TIMEOUT_SECONDS * 1000,
    webhookHost: parsed.SIDECARR_WEBHOOK_HOST,
    webhookPort: parsed.SIDECARR_WEBHOOK_PORT,
    webhookPath: parsed.SIDECARR_WEBHOOK_PATH,
    webhookCallbackUrl: parsed.SIDECARR_WEBHOOK_CALLBACK_URL
      ?? `http://scriberr-sidecarr:${parsed.SIDECARR_WEBHOOK_PORT}${parsed.SIDECARR_WEBHOOK_PATH}`,
    webhookSecret: parsed.SIDECARR_WEBHOOK_SECRET,
    dbPath: parsed.SIDECARR_DB_PATH
  };
}
