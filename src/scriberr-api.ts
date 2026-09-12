import type { Config } from "./config.js";
import type {
  ScriberrJob,
  ScriberrSummary,
  ScriberrSummarySettings,
  ScriberrSummaryTemplate,
  ScriberrWebhook,
  ScriberrWebhookInput
} from "./types.js";

const webhookManagementTimeoutMs = 10_000;

export class ScriberrApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ScriberrApiError";
  }
}

export class ScriberrApi {
  private summaryModel: string | undefined;

  constructor(private readonly config: Config) {}

  async getJob(jobId: string): Promise<ScriberrJob> {
    return this.request<ScriberrJob>(`/api/v1/transcription/${encodeURIComponent(jobId)}`);
  }

  async getSummary(jobId: string): Promise<ScriberrSummary> {
    return this.request<ScriberrSummary>(`/api/v1/transcription/${encodeURIComponent(jobId)}/summary`);
  }

  async getSummarySettings(): Promise<ScriberrSummarySettings> {
    return this.request<ScriberrSummarySettings>("/api/v1/summaries/settings");
  }

  async listWebhooks(): Promise<ScriberrWebhook[]> {
    return this.request<ScriberrWebhook[]>("/api/v1/webhooks/", {}, webhookManagementTimeoutMs);
  }

  async createWebhook(input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    return this.request<ScriberrWebhook>("/api/v1/webhooks/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    }, webhookManagementTimeoutMs);
  }

  async updateWebhook(id: string, input: ScriberrWebhookInput): Promise<ScriberrWebhook> {
    return this.request<ScriberrWebhook>(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
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

    const response = await this.fetch("/api/v1/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        content,
        transcription_id: job.id,
        ...(template ? { template_id: template.id } : {})
      })
    });
    if (!response.ok) await this.throwResponse(response);
    // Scriberr streams generated text and persists the summary when the stream ends.
    await response.text();
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

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = this.config.summaryTimeoutMs): Promise<T> {
    const response = await this.fetch(path, init, timeoutMs);
    if (!response.ok) await this.throwResponse(response);
    return response.json() as Promise<T>;
  }

  private fetch(path: string, init: RequestInit = {}, timeoutMs = this.config.summaryTimeoutMs): Promise<Response> {
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
    const detail = body ? `: ${body.slice(0, 200)}` : "";
    throw new ScriberrApiError(response.status, `Scriberr API ${response.status}${detail}`);
  }
}
