import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import pino from "pino";
import { safeSettingsSnapshot, settingRegistry, type Config, type SettingDefinition, type SettingKey, type SettingSource } from "./config.js";
import { ConfigurationConflictError, ConfigurationManager } from "./configuration-manager.js";
import { BrowserAuthError, ScriberrBrowserAuth, type BrowserAuthentication } from "./browser-auth.js";
import { sanitizeError } from "./errors.js";

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

export class UiServer {
  readonly basePath: string;

  constructor(
    private readonly config: () => Config,
    private readonly configuration: ConfigurationManager,
    private readonly auth: ScriberrBrowserAuth,
    private readonly logger: pino.Logger,
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
