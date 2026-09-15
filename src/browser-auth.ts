import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "./config.js";

export type BrowserAuthentication =
  | { status: "authenticated"; authorization?: string }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

export type BackgroundCredentialStatus = "missing" | "valid" | "invalid" | "unavailable";

export class ScriberrBrowserAuth {
  constructor(
    private readonly config: () => Config,
    private readonly request: typeof fetch = fetch
  ) {}

  async authenticate(headers: IncomingHttpHeaders): Promise<BrowserAuthentication> {
    const authorization = this.singleHeader(headers.authorization);
    const cookie = this.singleHeader(headers.cookie);
    if (!authorization?.startsWith("Bearer ") && !cookie) return { status: "unauthenticated" };

    const usingBearer = Boolean(authorization?.startsWith("Bearer "));
    const response = usingBearer
      ? await this.safeFetch("/api/v1/api-keys/", { headers: { Authorization: authorization! } })
      : await this.safeFetch("/api/v1/transcription/list?page=1&limit=1", { headers: { Cookie: cookie ?? "" } });
    if (!response) return { status: "unavailable" };
    if (response.status === 401 || response.status === 403) return { status: "unauthenticated" };
    if (!response.ok) return { status: "unavailable" };
    return { status: "authenticated", ...(usingBearer ? { authorization } : {}) };
  }

  async backgroundCredentialStatus(): Promise<BackgroundCredentialStatus> {
    const config = this.config();
    if (!config.scriberrApiKey) return "missing";
    const response = await this.safeFetch("/api/v1/transcription/list?page=1&limit=1", {
      headers: { "X-API-Key": config.scriberrApiKey }
    });
    if (!response) return "unavailable";
    if (response.status === 401 || response.status === 403) return "invalid";
    return response.ok ? "valid" : "unavailable";
  }

  async createBackgroundApiKey(authorization: string | undefined): Promise<string> {
    if (!authorization?.startsWith("Bearer ")) throw new BrowserAuthError(401, "A current Scriberr login is required");
    const response = await this.safeFetch("/api/v1/api-keys/", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Scriberr Sidecarr", description: "Background integration key managed by Scriberr Sidecarr" })
    });
    if (!response) throw new BrowserAuthError(503, "Scriberr is unavailable");
    if (response.status === 401 || response.status === 403) throw new BrowserAuthError(401, "The Scriberr session expired");
    if (!response.ok) throw new BrowserAuthError(502, `Scriberr rejected API-key creation with HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("key" in body) || typeof body.key !== "string" || !body.key) {
      throw new BrowserAuthError(502, "Scriberr returned an invalid API-key response");
    }
    return body.key;
  }

  private async safeFetch(path: string, init: RequestInit): Promise<Response | undefined> {
    try {
      const config = this.config();
      return await this.request(`${config.scriberrUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(config.apiTimeoutMs)
      });
    } catch {
      return undefined;
    }
  }

  private singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}

export class BrowserAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
