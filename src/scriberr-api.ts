import pino from "pino";
import type { Config } from "./config.js";
import { sanitizeError } from "./errors.js";
import { Metrics } from "./metrics.js";
import type {
  ScriberrJob,
  ScriberrSummary,
  ScriberrSummarySettings,
  ScriberrSummaryTemplate,
  ScriberrWebhook,
  ScriberrWebhookInput
} from "./types.js";

const webhookManagementTimeoutMs = 10_000;
const availabilityTimeoutMs = 5_000;

export class ScriberrApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ScriberrApiError";
  }
}

export class ScriberrApi {
  private summaryModel: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly metrics = new Metrics(),
    private readonly logger?: pino.Logger
  ) {}

  async getJob(jobId: string): Promise<ScriberrJob> {
    return this.request<ScriberrJob>(`/api/v1/transcription/${encodeURIComponent(jobId)}`);
  }

  async getSummary(jobId: string): Promise<ScriberrSummary> {
    return this.request<ScriberrSummary>(`/api/v1/transcription/${encodeURIComponent(jobId)}/summary`);
  }

  async getSummarySettings(): Promise<ScriberrSummarySettings> {
    return this.request<ScriberrSummarySettings>("/api/v1/summaries/settings");
  }

  async getAudio(jobId: string): Promise<Response> {
    const response = await this.fetch(`/api/v1/transcription/${encodeURIComponent(jobId)}/audio`, {}, this.config.apiTimeoutMs);
    if (!response.ok) {
      this.metrics.incrementApiFailure();
      await this.throwResponse(response);
    }
    return response;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.scriberrUrl}/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(this.config.apiTimeoutMs, availabilityTimeoutMs))
      });
      await response.body?.cancel();
      return response.ok || [401, 403, 404, 405].includes(response.status);
    } catch {
      return false;
    }
  }

  async listWebhooks(): Promise<ScriberrWebhook[]> {
    return this.request<ScriberrWebhook[]>("/api/v1/webhooks/", {}, webhookManagementTimeoutMs);
  }

  async createWebhook(input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    return this.requestOnce<ScriberrWebhook>("/api/v1/webhooks/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }, webhookManagementTimeoutMs);
  }

  async updateWebhook(id: string, input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    return this.requestOnce<ScriberrWebhook>(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }, webhookManagementTimeoutMs);
  }

  async requestSummary(job: ScriberrJob): Promise<void> {
    const template = await this.getSummaryTemplate();
    const configuredModel = this.config.summaryModel?.trim();
    const model = configuredModel || template?.model?.trim() || await this.getSummaryModel();
    if (!model) throw new Error("Scriberr has no configured summary model");
    if (!job.transcript) throw new Error("Scriberr job has no transcript to summarize");

    const content = template
      ? "Transcript:\n" + job.transcript + "\n\nInstructions:\n" + template.prompt
      : job.transcript;

    let response: Response;
    try {
      response = await this.fetch("/api/v1/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          content,
          transcription_id: job.id,
          ...(template ? { template_id: template.id } : {})
        })
      }, this.config.summaryTimeoutMs);
    } catch (error) {
      this.metrics.incrementApiFailure();
      throw error;
    }
    if (!response.ok) {
      this.metrics.incrementApiFailure();
      await this.throwResponse(response);
    }
    try {
      // Scriberr streams generated text and persists the summary when the stream ends.
      await response.text();
    } catch (error) {
      this.metrics.incrementApiFailure();
      throw error;
    }
  }

  private async getSummaryTemplate(): Promise<ScriberrSummaryTemplate | undefined> {
    const templateName = this.config.summaryTemplate?.trim();
    if (!templateName) return undefined;

    const templates = await this.request<ScriberrSummaryTemplate[]>("/api/v1/summaries/");
    const template = templates.find((item) => item.name === templateName);
    if (!template) throw new Error("Scriberr summary template not found: " + templateName);
    return template;
  }

  private async getSummaryModel(): Promise<string> {
    if (this.summaryModel !== undefined) return this.summaryModel;
    const response = await this.getSummarySettings();
    this.summaryModel = response.default_model ?? "";
    return this.summaryModel;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.config.apiTimeoutMs
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.apiMaxAttempts; attempt += 1) {
      try {
        const response = await this.fetch(path, init, timeoutMs);
        if (response.ok) {
          if (attempt > 1) {
            this.logger?.info(
              { method: init.method ?? "GET", path, attempt },
              "Scriberr API request recovered after retry"
            );
          }
          return await response.json() as T;
        }

        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.config.apiMaxAttempts) {
          this.metrics.incrementApiFailure();
          await this.throwResponse(response);
        }
        await response.text().catch(() => "");
        lastError = new ScriberrApiError(response.status, `Scriberr API ${response.status}`);
        const delayMs = this.config.apiRetryBaseMs * 2 ** (attempt - 1);
        this.logRetry(path, init, attempt, delayMs, { status: response.status });
      } catch (error) {
        if (error instanceof ScriberrApiError) throw error;
        lastError = error;
        if (attempt === this.config.apiMaxAttempts) {
          this.metrics.incrementApiFailure();
          throw error;
        }
        const delayMs = this.config.apiRetryBaseMs * 2 ** (attempt - 1);
        this.logRetry(path, init, attempt, delayMs, { error: sanitizeError(error) });
      }

      const delayMs = this.config.apiRetryBaseMs * 2 ** (attempt - 1);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    this.metrics.incrementApiFailure();
    throw lastError instanceof Error ? lastError : new Error("Scriberr API request failed");
  }

  private logRetry(
    path: string,
    init: RequestInit,
    attempt: number,
    delayMs: number,
    failure: { status: number } | { error: string }
  ): void {
    this.logger?.warn({
      method: init.method ?? "GET",
      path,
      attempt,
      maxAttempts: this.config.apiMaxAttempts,
      delayMs,
      ...failure
    }, "Scriberr API request failed; retrying");
  }

  private async requestOnce<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    try {
      const response = await this.fetch(path, init, timeoutMs);
      if (!response.ok) {
        this.metrics.incrementApiFailure();
        await this.throwResponse(response);
      }
      return await response.json() as T;
    } catch (error) {
      if (!(error instanceof ScriberrApiError)) this.metrics.incrementApiFailure();
      throw error;
    }
  }

  private fetch(path: string, init: RequestInit = {}, timeoutMs = this.config.apiTimeoutMs): Promise<Response> {
    return fetch(`${this.config.scriberrUrl}${path}`, {
      ...init,
      headers: {
        "X-API-Key": this.config.scriberrApiKey,
        Accept: "application/json",
        ...(init.headers ?? {})
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs)
    });
  }

  private async throwResponse(response: Response): Promise<never> {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${sanitizeError(body, 200)}` : "";
    throw new ScriberrApiError(response.status, `Scriberr API ${response.status}${detail}`);
  }
}
