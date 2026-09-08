import { z } from "zod";

const bool = z
  .string()
  .optional()
  .default("false")
  .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()));

const configSchema = z.object({
  SIDECARR_WATCH_FOLDER: z.string().default("/watch/transcripts"),
  SIDECARR_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  SIDECARR_SCRIBERR_URL: z.string().url(),
  SIDECARR_SCRIBERR_API_KEY: z.string().min(1),
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
  SIDECARR_DB_PATH: z.string().default("/app/data/sidecar.db")
});

export type Config = {
  watchFolder: string;
  scanIntervalMs: number;
  scriberrUrl: string;
  scriberrApiKey: string;
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
  dbPath: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);
  return {
    watchFolder: parsed.SIDECARR_WATCH_FOLDER,
    scanIntervalMs: parsed.SIDECARR_SCAN_INTERVAL_SECONDS * 1000,
    scriberrUrl: parsed.SIDECARR_SCRIBERR_URL.replace(/\/$/, ""),
    scriberrApiKey: parsed.SIDECARR_SCRIBERR_API_KEY,
    mqttUrl: parsed.SIDECARR_MQTT_URL,
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
    dbPath: parsed.SIDECARR_DB_PATH
  };
}
