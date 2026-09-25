import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import pino from "pino";
import { safeSettingsSnapshot, settingRegistry, type Config, type SettingDefinition, type SettingKey, type SettingSource } from "./config.js";
import { ConfigurationConflictError, ConfigurationManager } from "./configuration-manager.js";
import { BrowserAuthError, ScriberrBrowserAuth, type BrowserAuthentication } from "./browser-auth.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import type { ScriberrReadinessStatus } from "./scriberr-readiness.js";
import type { JobRow, SidecarState } from "./types.js";

const maxApiBodyBytes = 64 * 1024;
const settingsGroups = ["scriberr", "discovery", "notion", "mqtt", "notifications", "summaries"] as const;
type SettingsGroup = typeof settingsGroups[number];
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

type SetupState = {
  required: boolean;
  manageable: boolean;
  credentialStatus: "missing" | "valid" | "invalid" | "unavailable";
  source: SettingSource;
};

type OperationsStatus = {
  scriberr: ScriberrReadinessStatus;
  discoveryMode: "webhook" | "filesystem";
};

const activeJobStates = new Set<SidecarState>([
  "discovered",
  "pending_transcription",
  "processing_transcription",
  "transcription_complete",
  "summary_pending",
  "summary_processing"
]);

export class UiServer {
  readonly basePath: string;

  constructor(
    private readonly config: () => Config,
    private readonly configuration: ConfigurationManager,
    private readonly auth: ScriberrBrowserAuth,
    private readonly logger: pino.Logger,
    private readonly db: StateStore,
    private readonly operationsStatus: () => OperationsStatus = () => ({ scriberr: "waiting", discoveryMode: "filesystem" }),
    private readonly assetsPath = path.resolve("ui-dist")
  ) {
    this.basePath = config().uiBasePath;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === `${this.basePath}/api/session`) {
      await this.session(request, response);
      return true;
    }
    if (url.pathname === `${this.basePath}/api/setup/api-key`) {
      await this.createApiKey(request, response);
      return true;
    }
    if (url.pathname === `${this.basePath}/api/settings`) {
      await this.settings(request, response);
      return true;
    }
    if (url.pathname === `${this.basePath}/api/operations/overview`) {
      await this.operationsOverview(request, response);
      return true;
    }
    if (url.pathname === `${this.basePath}/api/jobs`) {
      await this.jobs(request, response, url);
      return true;
    }
    const jobMatch = url.pathname.match(new RegExp(`^${this.basePath}/api/jobs/([^/]+)$`));
    if (jobMatch) {
      await this.jobDetails(request, response, jobMatch[1]);
      return true;
    }
    const settingsGroup = url.pathname.match(new RegExp(`^${this.basePath}/api/settings/([^/]+)$`))?.[1];
    if (settingsGroup) {
      await this.updateSettings(request, response, settingsGroup);
      return true;
    }
    if (url.pathname === `${this.basePath}/api` || url.pathname.startsWith(`${this.basePath}/api/`)) {
      this.respondJson(response, 404, { error: "not found" });
      return true;
    }
    if (url.pathname === this.basePath) {
      response.writeHead(308, { Location: `${this.basePath}/` });
      response.end();
      return true;
    }
    if (!url.pathname.startsWith(`${this.basePath}/`)) return false;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      this.respondJson(response, 405, { error: "method not allowed" });
      return true;
    }
    await this.staticAsset(request, response, url.pathname);
    return true;
  }

  private async session(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      this.respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    const authentication = await this.auth.authenticate(request.headers);
    if (authentication.status === "unauthenticated") {
      this.logger.info({ path: request.url }, "unauthenticated Sidecarr UI request");
      this.respondJson(response, 401, { authenticated: false });
      return;
    }
    if (authentication.status === "unavailable") {
      this.logger.warn("Scriberr unavailable while validating a Sidecarr UI session");
      this.respondJson(response, 503, { error: "Scriberr is unavailable" });
      return;
    }
    const setup = await this.setupState();
    this.respondJson(response, 200, {
      authenticated: true,
      setup,
      scriberrUrl: this.config().scriberrPublicUrl
    });
  }

  private async createApiKey(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      this.respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (!this.validMutationOrigin(request) || request.headers["x-sidecarr-request"] !== "1") {
      this.logger.warn({ path: request.url }, "Sidecarr UI mutation rejected by origin protection");
      this.respondJson(response, 403, { error: "request origin rejected" });
      return;
    }
    const authentication = await this.auth.authenticate(request.headers);
    if (authentication.status === "unauthenticated") {
      this.respondJson(response, 401, { error: "Scriberr authentication required" });
      return;
    }
    if (authentication.status === "unavailable") {
      this.respondJson(response, 503, { error: "Scriberr is unavailable" });
      return;
    }
    const apiKeySetting = this.configuration.current.settings.get("scriberrApiKey");
    if (apiKeySetting?.source === "environment") {
      this.respondJson(response, 409, { error: "SIDECARR_SCRIBERR_API_KEY is controlled by the environment" });
      return;
    }
    try {
      await this.discardBody(request);
      const key = await this.auth.createBackgroundApiKey(authentication.authorization);
      const update = await this.configuration.updateGroup("scriberr", new Map([["scriberrApiKey", key]]));
      if (update.activationError) {
        this.logger.error({ error: sanitizeError(update.activationError) }, "created Sidecarr API key but runtime activation failed");
        this.respondJson(response, 202, { configured: true, active: false, restartRequired: true });
        return;
      }
      this.logger.info("Sidecarr background API key created and activated");
      this.respondJson(response, 201, { configured: true, active: true, restartRequired: false });
    } catch (error) {
      const status = error instanceof BrowserAuthError ? error.status : 500;
      const message = error instanceof BrowserAuthError ? error.message : "Unable to configure the Sidecarr API key";
      this.logger.warn({ status, error: sanitizeError(error) }, "Sidecarr API-key setup failed");
      this.respondJson(response, status, { error: message });
    }
  }

  private async settings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      this.respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    const authentication = await this.authenticated(request, response);
    if (!authentication) return;
    this.respondJson(response, 200, this.settingsPayload());
  }

  private async updateSettings(request: IncomingMessage, response: ServerResponse, groupName: string): Promise<void> {
    if (request.method !== "PUT") {
      response.setHeader("Allow", "PUT");
      this.respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (!settingsGroups.includes(groupName as SettingsGroup)) {
      this.respondJson(response, 404, { error: "settings group not found" });
      return;
    }
    if (!this.validMutationOrigin(request) || request.headers["x-sidecarr-request"] !== "1") {
      this.logger.warn({ group: groupName }, "Sidecarr settings update rejected by origin protection");
      this.respondJson(response, 403, { error: "request origin rejected" });
      return;
    }
    const authentication = await this.authenticated(request, response);
    if (!authentication) return;

    try {
      const body = await this.readJson(request);
      if (!body || typeof body !== "object" || !("revision" in body) || typeof body.revision !== "string" || !("values" in body) || !body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
        throw new BrowserAuthError(400, "invalid settings request");
      }
      const group = groupName as SettingsGroup;
      const values = this.parseSettingsValues(group, body.values as Record<string, unknown>);
      const update = await this.configuration.updateGroup(group, values, body.revision);
      this.logger.info({ group, active: !update.activationError }, "Sidecarr settings updated");
      this.respondJson(response, update.activationError ? 202 : 200, {
        ...this.settingsPayload(),
        active: !update.activationError,
        restartRequired: Boolean(update.activationError),
        ...(update.activationError ? { activationError: sanitizeError(update.activationError) } : {})
      });
    } catch (error) {
      const status = error instanceof ConfigurationConflictError ? 409 : error instanceof BrowserAuthError ? error.status : 400;
      const message = error instanceof ConfigurationConflictError
        ? "Settings changed in another session. Reload before saving again."
        : error instanceof BrowserAuthError ? error.message : "Unable to save settings";
      this.logger.warn({ group: groupName, status, error: sanitizeError(error) }, "Sidecarr settings update failed");
      this.respondJson(response, status, { error: message, ...(status === 409 ? { revision: this.configuration.revision } : {}) });
    }
  }

  private async operationsOverview(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.getRequest(request, response)) return;
    const authentication = await this.authenticated(request, response);
    if (!authentication) return;
    const config = this.config();
    const runtime = this.operationsStatus();
    const failures = this.db.destinationFailureCounts();
    const status = (enabled: boolean, failed: boolean): "disabled" | "healthy" | "needs_attention" => {
      if (!enabled) return "disabled";
      return failed ? "needs_attention" : "healthy";
    };
    this.respondJson(response, 200, {
      health: [
        {
          key: "scriberr",
          label: "Scriberr",
          status: runtime.scriberr === "ready" ? "healthy" : runtime.scriberr === "configuration_required" ? "paused" : "needs_attention",
          detail: runtime.scriberr === "ready" ? "Background connection is ready." : `Background status: ${runtime.scriberr}.`
        },
        {
          key: "discovery",
          label: "Discovery",
          status: "healthy",
          detail: `${runtime.discoveryMode === "webhook" ? "Webhook" : "Filesystem"} discovery is active.`
        },
        {
          key: "notion",
          label: "Notion",
          status: status(config.notebookProvider === "notion", failures.notion > 0),
          detail: config.notebookProvider === "notion" ? "Notebook publishing is enabled." : "Not configured."
        },
        {
          key: "mqtt",
          label: "MQTT",
          status: status(Boolean(config.mqttUrl), failures.mqtt > 0),
          detail: config.mqttUrl ? "Lifecycle publishing is enabled." : "Not configured."
        },
        {
          key: "notifications",
          label: "Notifications",
          status: status(Boolean(config.notificationWebhookUrl || config.smtpUrl), failures.notifications > 0),
          detail: config.notificationWebhookUrl || config.smtpUrl ? "Job-ready notifications are enabled." : "Not configured."
        }
      ],
      recentFailures: this.db.recentOperationalFailures().map((failure) => ({
        category: failure.category,
        jobId: failure.job_id,
        title: failure.title ?? `Scriberr job ${failure.job_id}`,
        message: sanitizeError(failure.message),
        occurredAt: failure.occurred_at
      }))
    });
  }

  private async jobs(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!this.getRequest(request, response)) return;
    const authentication = await this.authenticated(request, response);
    if (!authentication) return;
    const page = this.positiveInteger(url.searchParams.get("page"), 1);
    const limit = Math.min(this.positiveInteger(url.searchParams.get("limit"), 10), 50);
    const result = this.db.listRecentJobs(page, limit);
    this.respondJson(response, 200, {
      jobs: result.jobs.map((job) => this.safeJob(job)),
      pagination: {
        page,
        limit,
        total: result.total,
        pages: Math.max(1, Math.ceil(result.total / limit))
      }
    });
  }

  private async jobDetails(request: IncomingMessage, response: ServerResponse, encodedJobId: string): Promise<void> {
    if (!this.getRequest(request, response)) return;
    const authentication = await this.authenticated(request, response);
    if (!authentication) return;
    let jobId: string;
    try {
      jobId = decodeURIComponent(encodedJobId);
    } catch {
      this.respondJson(response, 400, { error: "invalid job ID" });
      return;
    }
    const job = this.db.getJob(jobId);
    if (!job) {
      this.respondJson(response, 404, { error: "job not found" });
      return;
    }
    const notion = this.db.getNotebookPage(jobId, "notion");
    const notionOperations = this.db.notebookOperations(jobId);
    const notionStatus = notionOperations.some((operation) => operation.status === "failed")
      ? "needs attention"
      : notion?.last_status ? "synchronized" : "pending";
    this.respondJson(response, 200, {
      job: this.safeJob(job),
      links: {
        scriberr: `${this.config().scriberrPublicUrl}/audio/${encodeURIComponent(jobId)}`,
        notion: notion?.page_url ?? null
      },
      history: this.db.jobStateHistory(jobId).map((entry) => ({
        attempt: entry.attempt,
        state: entry.sidecar_state,
        scriberrStatus: entry.scriberr_status,
        error: entry.error ? sanitizeError(entry.error) : null,
        occurredAt: entry.occurred_at
      })),
      destinations: {
        notion: notion ? {
          status: notionStatus,
          audioStatus: notion.audio_state,
          currentAttempt: notion.current_attempt,
          updatedAt: notion.updated_at,
          operations: notionOperations.map((operation) => ({
            operation: operation.operation,
            status: operation.status,
            attempts: operation.attempts,
            error: operation.last_error ? sanitizeError(operation.last_error) : null,
            updatedAt: operation.updated_at,
            completedAt: operation.completed_at
          }))
        } : null,
        mqtt: this.db.jobEvents(jobId).map((event) => ({
          event: event.event_type,
          status: event.published_at ? "delivered" : event.last_error ? "failed" : "pending",
          attempts: event.publish_attempts,
          error: event.last_error ? sanitizeError(event.last_error) : null,
          createdAt: event.created_at,
          deliveredAt: event.published_at
        })),
        notifications: this.db.notificationDeliveries(jobId).map((delivery) => ({
          attempt: delivery.attempt,
          destination: delivery.destination,
          status: delivery.delivered_at ? "delivered" : delivery.attempts >= 3 ? "failed" : "pending",
          attempts: delivery.attempts,
          error: delivery.last_error ? sanitizeError(delivery.last_error) : null,
          createdAt: delivery.created_at,
          deliveredAt: delivery.delivered_at
        }))
      }
    });
  }

  private safeJob(job: JobRow): object {
    return {
      id: job.job_id,
      title: job.title ?? `Scriberr job ${job.job_id}`,
      source: job.source,
      state: job.sidecar_state,
      scriberrStatus: job.scriberr_status,
      status: this.displayStatus(job),
      active: activeJobStates.has(job.sidecar_state),
      attempt: job.attempt,
      outcome: job.job_ready_outcome,
      firstSeenAt: job.first_seen_at,
      lastSeenAt: job.last_seen_at,
      lastCheckedAt: job.last_checked_at,
      updatedAt: job.updated_at,
      readyAt: job.job_ready_at,
      error: job.last_error ? sanitizeError(job.last_error) : null
    };
  }

  private displayStatus(job: JobRow): string {
    if (job.sidecar_state === "job_ready") return job.job_ready_outcome === "ready_with_warnings" ? "Ready with warnings" : "Ready";
    if (job.sidecar_state === "transcription_failed" || job.sidecar_state === "summary_failed") return "Failed";
    if (job.sidecar_state === "processing_transcription") return "Transcribing";
    if (["transcription_complete", "summary_pending", "summary_processing", "summary_complete"].includes(job.sidecar_state)) return "Generating summary";
    return "Waiting";
  }

  private getRequest(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method === "GET") return true;
    response.setHeader("Allow", "GET");
    this.respondJson(response, 405, { error: "method not allowed" });
    return false;
  }

  private positiveInteger(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private settingsPayload(): object {
    const resolution = this.configuration.current;
    const manageableKeys = new Set<SettingKey>(settingRegistry.filter((definition) => definition.uiManageable).map((definition) => definition.key));
    const snapshot = safeSettingsSnapshot(resolution).filter((setting) => manageableKeys.has(setting.key));
    return {
      revision: this.configuration.revision,
      groups: settingsGroups.map((group) => ({
        key: group,
        settings: snapshot.filter((setting) => setting.group === group)
      })),
      issues: resolution.issues.filter((issue) => manageableKeys.has(issue.key))
    };
  }

  private parseSettingsValues(group: SettingsGroup, input: Record<string, unknown>): Map<SettingKey, string | undefined> {
    const values = new Map<SettingKey, string | undefined>();
    for (const [key, inputValue] of Object.entries(input)) {
      const definition: SettingDefinition | undefined = settingRegistry.find((candidate) => candidate.key === key);
      if (!definition || !definition.uiManageable || definition.group !== group) {
        throw new BrowserAuthError(400, `${key} is not an editable ${group} setting`);
      }
      const settingKey = definition.key as SettingKey;
      const current = this.configuration.current.settings.get(settingKey);
      if (!current?.editable) throw new BrowserAuthError(409, `${definition.env} is controlled by the environment`);

      if (definition.secret) {
        if (!inputValue || typeof inputValue !== "object" || !("action" in inputValue)) {
          throw new BrowserAuthError(400, `${key} requires an explicit secret action`);
        }
        const secret = inputValue as { action?: unknown; value?: unknown };
        if (secret.action === "preserve") continue;
        if (secret.action === "remove") values.set(settingKey, undefined);
        else if (secret.action === "replace" && typeof secret.value === "string" && secret.value.trim()) values.set(settingKey, secret.value);
        else throw new BrowserAuthError(400, `${key} has an invalid secret action`);
        continue;
      }

      if (inputValue === null || inputValue === "") values.set(settingKey, undefined);
      else if (["string", "number", "boolean"].includes(typeof inputValue)) values.set(settingKey, String(inputValue));
      else throw new BrowserAuthError(400, `${key} has an invalid value`);
    }
    return values;
  }

  private async authenticated(request: IncomingMessage, response: ServerResponse): Promise<BrowserAuthentication & { status: "authenticated" } | undefined> {
    const authentication = await this.auth.authenticate(request.headers);
    if (authentication.status === "unauthenticated") {
      this.respondJson(response, 401, { error: "Scriberr authentication required" });
      return undefined;
    }
    if (authentication.status === "unavailable") {
      this.respondJson(response, 503, { error: "Scriberr is unavailable" });
      return undefined;
    }
    return authentication;
  }

  private async setupState(): Promise<SetupState> {
    const setting = this.configuration.current.settings.get("scriberrApiKey");
    const credentialStatus = await this.auth.backgroundCredentialStatus();
    return {
      required: credentialStatus === "missing" || credentialStatus === "invalid",
      manageable: setting?.source !== "environment",
      credentialStatus,
      source: setting?.source ?? "unset"
    };
  }

  private validMutationOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return false;
    try {
      const originUrl = new URL(origin);
      const expectedHost = this.singleHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
      return Boolean(expectedHost) && originUrl.host === expectedHost && ["http:", "https:"].includes(originUrl.protocol);
    } catch {
      return false;
    }
  }

  private async discardBody(request: IncomingMessage): Promise<void> {
    let size = 0;
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > maxApiBodyBytes) throw new BrowserAuthError(413, "request body too large");
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxApiBodyBytes) throw new BrowserAuthError(413, "request body too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BrowserAuthError(400, "invalid JSON");
    }
  }

  private async staticAsset(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(this.basePath.length)).replace(/^\/+/, "");
    } catch {
      this.respondJson(response, 400, { error: "invalid URL path" });
      return;
    }
    const requested = relative && path.extname(relative) ? relative : "index.html";
    const root = path.resolve(this.assetsPath);
    const filePath = path.resolve(root, requested);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      this.respondJson(response, 404, { error: "not found" });
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      const file = await readFile(filePath);
      const body = requested === "index.html"
        ? Buffer.from(file.toString("utf8").replaceAll("__SIDECARR_BASE_PATH__", this.basePath))
        : file;
      const immutable = requested.startsWith("assets/");
      response.writeHead(200, {
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "Content-Length": body.byteLength,
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
        "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      this.respondJson(response, 404, { error: "UI asset not found" });
    }
  }

  private respondJson(response: ServerResponse, status: number, body: object): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }

  private singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
