import { z } from "zod";

export type SettingGroup = "runtime" | "scriberr" | "discovery" | "mqtt" | "notifications" | "summaries" | "notion";
export type ActivationBehavior = "bootstrap" | Exclude<SettingGroup, "runtime">;
export type SettingSource = "environment" | "database" | "default" | "unset";
export type SettingValue = string | number | boolean | undefined;

export type SettingDefinition = {
  key: string;
  env: string;
  group: SettingGroup;
  parser: z.ZodType<SettingValue, z.ZodTypeDef, unknown>;
  defaultValue?: string;
  secret?: boolean;
  uiManageable: boolean;
  advanced?: boolean;
  activation: ActivationBehavior;
};

const requiredString = z.string().trim().min(1);
const optionalString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional()
);
const url = z.string().trim().url();
const optionalUrl = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().url().optional()
);
const booleanString = z.string().trim().transform((value, context) => {
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
  return z.NEVER;
});
const integer = (minimum: number, maximum?: number): z.ZodType<SettingValue, z.ZodTypeDef, unknown> => z.coerce.number().int().min(minimum).refine(
  (value) => maximum === undefined || value <= maximum,
  maximum === undefined ? undefined : `must be less than or equal to ${maximum}`
);

export const settingRegistry = [
  { key: "logLevel", env: "LOG_LEVEL", group: "runtime", parser: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]), defaultValue: "info", uiManageable: false, activation: "bootstrap" },
  { key: "dbPath", env: "SIDECARR_DB_PATH", group: "runtime", parser: requiredString, defaultValue: "/app/data/sidecar.db", uiManageable: false, activation: "bootstrap" },
  { key: "webhookHost", env: "SIDECARR_WEBHOOK_HOST", group: "runtime", parser: requiredString, defaultValue: "0.0.0.0", uiManageable: false, activation: "bootstrap" },
  { key: "webhookPort", env: "SIDECARR_WEBHOOK_PORT", group: "runtime", parser: integer(1, 65535), defaultValue: "8080", uiManageable: false, activation: "bootstrap" },
  { key: "webhookPath", env: "SIDECARR_WEBHOOK_PATH", group: "runtime", parser: z.string().startsWith("/"), defaultValue: "/webhooks/scriberr", uiManageable: false, activation: "bootstrap" },
  { key: "uiBasePath", env: "SIDECARR_UI_BASE_PATH", group: "runtime", parser: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/, "must be an absolute URL path"), defaultValue: "/sidecarr", uiManageable: false, activation: "bootstrap" },
  { key: "webhookCallbackUrl", env: "SIDECARR_WEBHOOK_CALLBACK_URL", group: "runtime", parser: optionalUrl, uiManageable: false, advanced: true, activation: "bootstrap" },
  { key: "watchFolder", env: "SIDECARR_WATCH_FOLDER", group: "runtime", parser: requiredString, defaultValue: "/watch/transcripts", uiManageable: false, activation: "bootstrap" },
  { key: "scriberrUrl", env: "SIDECARR_SCRIBERR_URL", group: "scriberr", parser: url, defaultValue: "http://scriberr:8080", uiManageable: true, activation: "scriberr" },
  { key: "scriberrPublicUrl", env: "SIDECARR_SCRIBERR_PUBLIC_URL", group: "scriberr", parser: optionalUrl, uiManageable: true, activation: "scriberr" },
  { key: "scriberrApiKey", env: "SIDECARR_SCRIBERR_API_KEY", group: "scriberr", parser: optionalString, secret: true, uiManageable: true, activation: "scriberr" },
  { key: "apiTimeoutSeconds", env: "SIDECARR_API_TIMEOUT_SECONDS", group: "scriberr", parser: integer(1), defaultValue: "15", uiManageable: true, advanced: true, activation: "scriberr" },
  { key: "apiMaxAttempts", env: "SIDECARR_API_MAX_ATTEMPTS", group: "scriberr", parser: integer(1, 5), defaultValue: "3", uiManageable: true, advanced: true, activation: "scriberr" },
  { key: "apiRetryBaseMilliseconds", env: "SIDECARR_API_RETRY_BASE_MILLISECONDS", group: "scriberr", parser: integer(0), defaultValue: "500", uiManageable: true, advanced: true, activation: "scriberr" },
  { key: "discoveryMode", env: "SIDECARR_DISCOVERY_MODE", group: "discovery", parser: z.enum(["webhook", "filesystem"]), defaultValue: "webhook", uiManageable: true, activation: "discovery" },
  { key: "scanIntervalSeconds", env: "SIDECARR_SCAN_INTERVAL_SECONDS", group: "discovery", parser: integer(1), defaultValue: "30", uiManageable: true, advanced: true, activation: "discovery" },
  { key: "reconciliationIntervalSeconds", env: "SIDECARR_RECONCILIATION_INTERVAL_SECONDS", group: "discovery", parser: integer(1), defaultValue: "300", uiManageable: true, advanced: true, activation: "discovery" },
  { key: "webhookSecret", env: "SIDECARR_WEBHOOK_SECRET", group: "discovery", parser: optionalString, secret: true, uiManageable: true, advanced: true, activation: "discovery" },
  { key: "mqttUrl", env: "SIDECARR_MQTT_URL", group: "mqtt", parser: optionalUrl, uiManageable: true, activation: "mqtt" },
  { key: "mqttUsername", env: "SIDECARR_MQTT_USERNAME", group: "mqtt", parser: optionalString, uiManageable: true, activation: "mqtt" },
  { key: "mqttPassword", env: "SIDECARR_MQTT_PASSWORD", group: "mqtt", parser: optionalString, secret: true, uiManageable: true, activation: "mqtt" },
  { key: "mqttTopicPrefix", env: "SIDECARR_MQTT_TOPIC_PREFIX", group: "mqtt", parser: requiredString, defaultValue: "home/audio/scriberr", uiManageable: true, activation: "mqtt" },
  { key: "mqttQos", env: "SIDECARR_MQTT_QOS", group: "mqtt", parser: integer(0, 2), defaultValue: "1", uiManageable: true, advanced: true, activation: "mqtt" },
  { key: "mqttRetain", env: "SIDECARR_MQTT_RETAIN", group: "mqtt", parser: booleanString, defaultValue: "false", uiManageable: true, advanced: true, activation: "mqtt" },
  { key: "notificationWebhookUrl", env: "SIDECARR_NOTIFICATION_WEBHOOK_URL", group: "notifications", parser: optionalUrl, uiManageable: true, activation: "notifications" },
  { key: "notificationWebhookToken", env: "SIDECARR_NOTIFICATION_WEBHOOK_TOKEN", group: "notifications", parser: optionalString, secret: true, uiManageable: true, activation: "notifications" },
  { key: "smtpUrl", env: "SIDECARR_SMTP_URL", group: "notifications", parser: optionalString, secret: true, uiManageable: true, activation: "notifications" },
  { key: "emailFrom", env: "SIDECARR_EMAIL_FROM", group: "notifications", parser: optionalString, uiManageable: true, activation: "notifications" },
  { key: "emailTo", env: "SIDECARR_EMAIL_TO", group: "notifications", parser: optionalString, uiManageable: true, activation: "notifications" },
  { key: "emailSubjectTemplate", env: "SIDECARR_EMAIL_SUBJECT_TEMPLATE", group: "notifications", parser: requiredString, defaultValue: "Scriberr job ready: {title}", uiManageable: true, advanced: true, activation: "notifications" },
  { key: "autogenerateSummary", env: "SIDECARR_AUTOGENERATE_SUMMARY", group: "summaries", parser: booleanString, defaultValue: "false", uiManageable: true, activation: "summaries" },
  { key: "summaryModel", env: "SIDECARR_SUMMARY_MODEL", group: "summaries", parser: optionalString, uiManageable: true, advanced: true, activation: "summaries" },
  { key: "summaryTemplate", env: "SIDECARR_SUMMARY_TEMPLATE", group: "summaries", parser: optionalString, defaultValue: "Default", uiManageable: true, activation: "summaries" },
  { key: "summaryPollIntervalSeconds", env: "SIDECARR_SUMMARY_POLL_INTERVAL_SECONDS", group: "summaries", parser: integer(1), defaultValue: "30", uiManageable: true, advanced: true, activation: "summaries" },
  { key: "summaryTimeoutSeconds", env: "SIDECARR_SUMMARY_TIMEOUT_SECONDS", group: "summaries", parser: integer(1), defaultValue: "3600", uiManageable: true, advanced: true, activation: "summaries" },
  { key: "notebookProvider", env: "SIDECARR_NOTEBOOK_PROVIDER", group: "notion", parser: z.enum(["notion"]).optional(), uiManageable: true, activation: "notion" },
  { key: "notionToken", env: "SIDECARR_NOTION_TOKEN", group: "notion", parser: optionalString, secret: true, uiManageable: true, activation: "notion" },
  { key: "notionParentPageUrl", env: "SIDECARR_NOTION_PARENT_PAGE_URL", group: "notion", parser: optionalUrl, uiManageable: true, activation: "notion" },
  { key: "notionBackfill", env: "SIDECARR_NOTION_BACKFILL", group: "notion", parser: booleanString, defaultValue: "false", uiManageable: true, advanced: true, activation: "notion" }
] as const satisfies readonly SettingDefinition[];

export type SettingKey = typeof settingRegistry[number]["key"];
export type ResolvedSetting = Omit<SettingDefinition, "key" | "parser" | "secret" | "advanced" | "uiManageable"> & {
  key: SettingKey;
  value: SettingValue;
  source: SettingSource;
  editable: boolean;
  secret: boolean;
  advanced: boolean;
  error?: string;
};
export type ConfigurationIssue = { key: SettingKey; env: string; group: SettingGroup; source: SettingSource; message: string };

export type Config = {
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
  discoveryMode: "webhook" | "filesystem";
  watchFolder: string;
  scanIntervalMs: number;
  reconciliationIntervalMs: number;
  scriberrUrl: string;
  scriberrPublicUrl: string;
  scriberrApiKey: string;
  apiTimeoutMs: number;
  apiMaxAttempts: number;
  apiRetryBaseMs: number;
  mqttUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  mqttTopicPrefix: string;
  mqttQos: 0 | 1 | 2;
  mqttRetain: boolean;
  notificationWebhookUrl?: string;
  notificationWebhookToken?: string;
  smtpUrl?: string;
  emailFrom?: string;
  emailTo?: string;
  emailSubjectTemplate: string;
  autogenerateSummary: boolean;
  summaryModel?: string;
  summaryTemplate?: string;
  summaryPollIntervalMs: number;
  summaryTimeoutMs: number;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  uiBasePath: string;
  webhookCallbackUrl: string;
  webhookSecret?: string;
  notebookProvider?: "notion";
  notionToken?: string;
  notionParentPageUrl?: string;
  notionBackfill: boolean;
  dbPath: string;
};

export type ConfigurationResolution = { config: Config; settings: ReadonlyMap<SettingKey, ResolvedSetting>; issues: readonly ConfigurationIssue[]; canProcess: boolean };
export type SafeResolvedSetting = Omit<ResolvedSetting, "value"> & { value?: Exclude<SettingValue, undefined>; configured: boolean };
export interface SettingsReader { getApplicationSettings(): ReadonlyMap<string, string> }

export class ConfigurationError extends Error {
  constructor(public readonly issues: readonly ConfigurationIssue[]) {
    super(issues.map((issue) => `${issue.env}: ${issue.message}`).join("; "));
    this.name = "ConfigurationError";
  }
}

function selectedRawValue(
  definition: SettingDefinition,
  env: NodeJS.ProcessEnv,
  database: ReadonlyMap<string, string>
): { raw: string | undefined; source: SettingSource } {
  const environmentValue = env[definition.env];
  if (environmentValue !== undefined && environmentValue.trim() !== "") return { raw: environmentValue, source: "environment" };
  const databaseValue = database.get(definition.key);
  if (databaseValue !== undefined && databaseValue.trim() !== "") return { raw: databaseValue, source: "database" };
  if (definition.defaultValue !== undefined) return { raw: definition.defaultValue, source: "default" };
  return { raw: undefined, source: "unset" };
}

function issueMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join(", ");
}

function stringValue(settings: ReadonlyMap<SettingKey, ResolvedSetting>, key: SettingKey, fallback = ""): string {
  const value = settings.get(key)?.value;
  return typeof value === "string" ? value : fallback;
}

function optionalValue(settings: ReadonlyMap<SettingKey, ResolvedSetting>, key: SettingKey): string | undefined {
  const value = settings.get(key)?.value;
  return typeof value === "string" ? value : undefined;
}

function numberValue(settings: ReadonlyMap<SettingKey, ResolvedSetting>, key: SettingKey, fallback: number): number {
  const value = settings.get(key)?.value;
  return typeof value === "number" ? value : fallback;
}

function booleanValue(settings: ReadonlyMap<SettingKey, ResolvedSetting>, key: SettingKey, fallback = false): boolean {
  const value = settings.get(key)?.value;
  return typeof value === "boolean" ? value : fallback;
}

function addSectionIssue(
  settings: ReadonlyMap<SettingKey, ResolvedSetting>,
  issues: ConfigurationIssue[],
  key: SettingKey,
  message: string
): void {
  const setting = settings.get(key);
  if (setting) issues.push({ key, env: setting.env, group: setting.group, source: setting.source, message });
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env, reader?: SettingsReader): ConfigurationResolution {
  const database = reader?.getApplicationSettings() ?? new Map<string, string>();
  const settings = new Map<SettingKey, ResolvedSetting>();
  const issues: ConfigurationIssue[] = [];

  for (const definition of settingRegistry) {
    const metadata: SettingDefinition = definition;
    const selected = selectedRawValue(metadata, env, database);
    const parsed = metadata.parser.safeParse(selected.raw);
    const error = parsed.success ? undefined : issueMessage(parsed.error);
    const setting: ResolvedSetting = {
      key: definition.key,
      env: metadata.env,
      group: metadata.group,
      value: parsed.success ? parsed.data : undefined,
      source: selected.source,
      editable: metadata.uiManageable && selected.source !== "environment",
      secret: metadata.secret ?? false,
      advanced: metadata.advanced ?? false,
      activation: metadata.activation,
      ...(metadata.defaultValue === undefined ? {} : { defaultValue: metadata.defaultValue }),
      ...(error ? { error } : {})
    };
    settings.set(definition.key, setting);
    if (error) issues.push({ key: definition.key, env: metadata.env, group: metadata.group, source: selected.source, message: error });
  }

  let mqttUrl = optionalValue(settings, "mqttUrl");
  let mqttUsername = optionalValue(settings, "mqttUsername");
  let mqttPassword = optionalValue(settings, "mqttPassword");
  if (!mqttUrl && (mqttUsername || mqttPassword)) {
    addSectionIssue(settings, issues, "mqttUrl", "is required when MQTT credentials are present");
    mqttUrl = mqttUsername = mqttPassword = undefined;
  }

  let notificationWebhookUrl = optionalValue(settings, "notificationWebhookUrl");
  let notificationWebhookToken = optionalValue(settings, "notificationWebhookToken");
  if (!notificationWebhookUrl && notificationWebhookToken) {
    addSectionIssue(settings, issues, "notificationWebhookUrl", "is required when a notification webhook token is present");
    notificationWebhookUrl = notificationWebhookToken = undefined;
  }

  let smtpUrl = optionalValue(settings, "smtpUrl");
  let emailFrom = optionalValue(settings, "emailFrom");
  let emailTo = optionalValue(settings, "emailTo");
  if (smtpUrl || emailFrom || emailTo) {
    let valid = true;
    if (!smtpUrl) {
      addSectionIssue(settings, issues, "smtpUrl", "is required when email notifications are enabled");
      valid = false;
    } else {
      try {
        const parsed = new URL(smtpUrl);
        if (!["smtp:", "smtps:"].includes(parsed.protocol) || !parsed.hostname) throw new Error("invalid SMTP URL");
      } catch {
        addSectionIssue(settings, issues, "smtpUrl", "must be a valid smtp:// or smtps:// URL");
        valid = false;
      }
    }
    if (!emailFrom) {
      addSectionIssue(settings, issues, "emailFrom", "is required when email notifications are enabled");
      valid = false;
    }
    if (!emailTo) {
      addSectionIssue(settings, issues, "emailTo", "is required when email notifications are enabled");
      valid = false;
    }
    if (!valid) smtpUrl = emailFrom = emailTo = undefined;
  }

  let notebookProvider = optionalValue(settings, "notebookProvider");
  let notionToken = optionalValue(settings, "notionToken");
  let notionParentPageUrl = optionalValue(settings, "notionParentPageUrl");
  if (notebookProvider || notionToken || notionParentPageUrl) {
    let valid = true;
    if (notebookProvider !== "notion") {
      addSectionIssue(settings, issues, "notebookProvider", "must be notion when Notion settings are present");
      valid = false;
    }
    if (!notionToken) {
      addSectionIssue(settings, issues, "notionToken", "is required when Notion is enabled");
      valid = false;
    }
    if (!notionParentPageUrl) {
      addSectionIssue(settings, issues, "notionParentPageUrl", "is required when Notion is enabled");
      valid = false;
    }
    if (!valid) notebookProvider = notionToken = notionParentPageUrl = undefined;
  }

  const scriberrUrl = stringValue(settings, "scriberrUrl", "http://scriberr:8080").replace(/\/$/, "");
  const scriberrApiKey = optionalValue(settings, "scriberrApiKey") ?? "";
  const webhookPort = numberValue(settings, "webhookPort", 8080);
  const webhookPath = stringValue(settings, "webhookPath", "/webhooks/scriberr");
  const config: Config = {
    logLevel: (() => {
      const value = stringValue(settings, "logLevel", "info");
      return (["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const).find((level) => level === value) ?? "info";
    })(),
    discoveryMode: stringValue(settings, "discoveryMode", "webhook") === "filesystem" ? "filesystem" : "webhook",
    watchFolder: stringValue(settings, "watchFolder", "/watch/transcripts"),
    scanIntervalMs: numberValue(settings, "scanIntervalSeconds", 30) * 1000,
    reconciliationIntervalMs: numberValue(settings, "reconciliationIntervalSeconds", 300) * 1000,
    scriberrUrl,
    scriberrPublicUrl: (optionalValue(settings, "scriberrPublicUrl") ?? scriberrUrl).replace(/\/$/, ""),
    scriberrApiKey,
    apiTimeoutMs: numberValue(settings, "apiTimeoutSeconds", 15) * 1000,
    apiMaxAttempts: numberValue(settings, "apiMaxAttempts", 3),
    apiRetryBaseMs: numberValue(settings, "apiRetryBaseMilliseconds", 500),
    mqttUrl, mqttUsername, mqttPassword,
    mqttTopicPrefix: stringValue(settings, "mqttTopicPrefix", "home/audio/scriberr").replace(/\/$/, ""),
    mqttQos: numberValue(settings, "mqttQos", 1) as 0 | 1 | 2,
    mqttRetain: booleanValue(settings, "mqttRetain"),
    notificationWebhookUrl, notificationWebhookToken, smtpUrl, emailFrom, emailTo,
    emailSubjectTemplate: stringValue(settings, "emailSubjectTemplate", "Scriberr job ready: {title}"),
    autogenerateSummary: booleanValue(settings, "autogenerateSummary"),
    summaryModel: optionalValue(settings, "summaryModel"),
    summaryTemplate: optionalValue(settings, "summaryTemplate") ?? "Default",
    summaryPollIntervalMs: numberValue(settings, "summaryPollIntervalSeconds", 30) * 1000,
    summaryTimeoutMs: numberValue(settings, "summaryTimeoutSeconds", 3600) * 1000,
    webhookHost: stringValue(settings, "webhookHost", "0.0.0.0"), webhookPort, webhookPath,
    uiBasePath: `/${stringValue(settings, "uiBasePath", "/sidecarr").replace(/^\/+|\/+$/g, "")}`,
    webhookCallbackUrl: optionalValue(settings, "webhookCallbackUrl") ?? `http://scriberr-sidecarr:${webhookPort}${webhookPath}`,
    webhookSecret: optionalValue(settings, "webhookSecret"),
    notebookProvider: notebookProvider === "notion" ? "notion" : undefined,
    notionToken, notionParentPageUrl,
    notionBackfill: booleanValue(settings, "notionBackfill"),
    dbPath: stringValue(settings, "dbPath", "/app/data/sidecar.db")
  };
  if (!scriberrApiKey && !issues.some((issue) => issue.key === "scriberrApiKey")) {
    addSectionIssue(settings, issues, "scriberrApiKey", "is required for background processing");
  }
  const canProcess = Boolean(scriberrApiKey) && !issues.some((issue) => issue.key === "scriberrUrl" || issue.key === "scriberrApiKey");
  return { config, settings, issues, canProcess };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resolution = resolveConfig(env);
  if (resolution.issues.length > 0) throw new ConfigurationError(resolution.issues);
  return resolution.config;
}

export function loadBootstrapConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, "logLevel" | "dbPath" | "webhookHost" | "webhookPort" | "webhookPath" | "uiBasePath"> {
  const config = resolveConfig(env).config;
  return {
    logLevel: config.logLevel,
    dbPath: config.dbPath,
    webhookHost: config.webhookHost,
    webhookPort: config.webhookPort,
    webhookPath: config.webhookPath,
    uiBasePath: config.uiBasePath
  };
}

export function safeSettingsSnapshot(resolution: ConfigurationResolution): readonly SafeResolvedSetting[] {
  return [...resolution.settings.values()].map((setting) => ({
    ...setting,
    configured: setting.value !== undefined,
    ...(setting.secret || setting.value === undefined ? { value: undefined } : { value: setting.value })
  }));
}
