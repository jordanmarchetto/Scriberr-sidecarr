import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import pino from "pino";
import type { Config, SettingSource } from "./config.js";
import { ConfigurationManager } from "./configuration-manager.js";
import { BrowserAuthError, ScriberrBrowserAuth } from "./browser-auth.js";
import { sanitizeError } from "./errors.js";

const maxApiBodyBytes = 64 * 1024;
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
