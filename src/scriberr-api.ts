import pino from "pino";
import type { Config } from "./config.js";
import { sanitizeError } from "./errors.js";
import { Metrics } from "./metrics.js";
import type {
  ScriberrJob,
  ScriberrAudioMetadata,
  ScriberrJobListResponse,
  ScriberrSummary,
  ScriberrSummarySettings,
  ScriberrSummaryTemplate,
  ScriberrWebhook,
  ScriberrWebhookInput
} from "./types.js";

const webhookManagementTimeoutMs = 10_000;
const availabilityTimeoutMs = 5_000;
const connectionRetryLogIntervalMs = 60_000;

export class ScriberrApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ScriberrApiError";
  }
}

export class ScriberrApi {
  private summaryModel: string | undefined;
  private lastConnectionRetryLogAt = 0;

  constructor(
    private readonly config: Config,
    private readonly metrics = new Metrics(),
    private readonly logger?: pino.Logger
  ) {}

  async getJob(jobId: string): Promise<ScriberrJob> {
    return this.request<ScriberrJob>(`/api/v1/transcription/${encodeURIComponent(jobId)}`);
  }

  async listJobsUpdatedAfter(updatedAfter: string): Promise<ScriberrJobListResponse> {
    const query = new URLSearchParams({
      page: "1",
      limit: "20",
      sort_by: "updated_at",
      sort_order: "asc",
      updated_after: updatedAfter
    });
    return this.request<ScriberrJobListResponse>(`/api/v1/transcription/list?${query.toString()}`);
  }

  async getSummary(jobId: string): Promise<ScriberrSummary> {
    return this.request<ScriberrSummary>(`/api/v1/transcription/${encodeURIComponent(jobId)}/summary`);
  }

  async startTranscription(jobId: string, parameters: Record<string, unknown>): Promise<ScriberrJob> {
    return this.requestOnce<ScriberrJob>(`/api/v1/transcription/${encodeURIComponent(jobId)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters)
    }, this.config.apiTimeoutMs);
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

  async getAudioMetadata(jobId: string): Promise<ScriberrAudioMetadata> {
    const response = await this.fetch(`/api/v1/transcription/${encodeURIComponent(jobId)}/audio`, {
      headers: { Range: "bytes=0-0" }
    }, this.config.apiTimeoutMs);
    if (!response.ok) {
      this.metrics.incrementApiFailure();
      await this.throwResponse(response);
    }
    const contentRange = response.headers.get("content-range");
    const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
    const contentLength = response.status === 200 ? response.headers.get("content-length") : null;
    const parsed = Number(rangeSize ?? contentLength);
    await response.body?.cancel();
    return { sizeBytes: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null };
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

  async generateTitleSubject(jobId: string): Promise<string> {
    const configuredModel = this.config.summaryModel?.trim();
    const model = configuredModel || await this.getSummaryModel();
    if (!model) throw new Error("Scriberr has no configured model for title generation");

    const timeoutMs = Math.min(this.config.summaryTimeoutMs, 5 * 60 * 1000);
    const session = await this.requestOnce<{ id: string }>("/api/v1/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcription_id: jobId,
        model,
        title: "Sidecarr temporary title generation"
      })
    }, timeoutMs);

    try {
      const response = await this.fetch(`/api/v1/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Create a specific 2-5 word title for this recording. Return only the title, with no date, quotation marks, or ending punctuation. Prefer a recognizable event such as ENT Appointment, Project Planning, or Family Catch-Up; never use generic words like Recording, Transcript, Conversation, or Summary."
        })
      }, timeoutMs);
      if (!response.ok) {
        this.metrics.incrementApiFailure();
        await this.throwResponse(response);
      }
      return await response.text();
    } finally {
      const response = await this.fetch(`/api/v1/chat/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE"
      }, this.config.apiTimeoutMs).catch((error: unknown) => {
        this.logger?.warn({ jobId, sessionId: session.id, error: sanitizeError(error) }, "temporary Scriberr title session cleanup failed");
        return undefined;
      });
      if (response && !response.ok && response.status !== 404) {
        this.logger?.warn({ jobId, sessionId: session.id, status: response.status }, "temporary Scriberr title session cleanup failed");
        await response.body?.cancel();
      }
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
          this.lastConnectionRetryLogAt = 0;
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
    if ("error" in failure) {
      const now = Date.now();
      if (now - this.lastConnectionRetryLogAt < connectionRetryLogIntervalMs) return;
      this.lastConnectionRetryLogAt = now;
    }
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
