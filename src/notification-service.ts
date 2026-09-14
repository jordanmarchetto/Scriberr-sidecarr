import nodemailer, { type Transporter } from "nodemailer";
import pino from "pino";
import type { Config } from "./config.js";
import { StateStore, type NotificationDeliveryRow, type NotificationDestination } from "./db.js";
import { sanitizeError } from "./errors.js";
import type { JobRow } from "./types.js";

const maxAttempts = 3;

export type JobReadyOutcome = "ready" | "ready_with_warnings";

export type JobReadyPayload = {
  event: "job_ready";
  job_id: string;
  title: string;
  outcome: JobReadyOutcome;
  attempt: number;
  notion_url: string | null;
  scriberr_url: string;
  occurred_at: string;
};

export class NotificationService {
  private readonly transporter?: Pick<Transporter, "sendMail" | "close">;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly logger: pino.Logger,
    transporter?: Pick<Transporter, "sendMail" | "close">
  ) {
    if (transporter) {
      this.transporter = transporter;
    } else if (config.smtpUrl) {
      const url = new URL(config.smtpUrl);
      const port = url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587;
      this.transporter = nodemailer.createTransport({
        host: url.hostname,
        port,
        secure: url.protocol === "smtps:",
        auth: url.username ? {
          user: decodeURIComponent(url.username),
          pass: decodeURIComponent(url.password)
        } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000
      });
    }
  }

  enqueue(job: JobRow, payload: JobReadyPayload): void {
    if (this.config.notificationWebhookUrl) this.enqueueDestination(job, "webhook", payload);
    if (this.transporter) this.enqueueDestination(job, "smtp", payload);
  }

  async flush(): Promise<void> {
    for (const delivery of this.db.pendingNotificationDeliveries(maxAttempts)) {
      try {
        await this.deliver(delivery);
        this.db.markNotificationDelivered(delivery.id, new Date().toISOString());
        this.logger.info({
          jobId: delivery.job_id,
          attempt: delivery.attempt,
          destination: delivery.destination
        }, "job ready notification delivered");
      } catch (error) {
        const message = sanitizeError(error);
        const attempts = this.db.recordNotificationFailure(delivery.id, message);
        this.logger.warn({
          jobId: delivery.job_id,
          attempt: delivery.attempt,
          destination: delivery.destination,
          attempts,
          exhausted: attempts >= maxAttempts,
          error: message
        }, "job ready notification failed");
      }
    }
  }

  close(): void {
    this.transporter?.close();
  }

  private enqueueDestination(job: JobRow, destination: NotificationDestination, payload: JobReadyPayload): void {
    const queued = this.db.ensureNotificationDelivery(job, destination, payload);
    this.logger.debug({
      jobId: job.job_id,
      attempt: job.attempt,
      destination,
      queued
    }, queued ? "job ready notification queued" : "job ready notification already queued");
  }

  private async deliver(delivery: NotificationDeliveryRow): Promise<void> {
    const payload = JSON.parse(delivery.payload_json) as JobReadyPayload;
    if (delivery.destination === "webhook") {
      await this.deliverWebhook(delivery, payload);
      return;
    }
    await this.deliverEmail(payload);
  }

  private async deliverWebhook(delivery: NotificationDeliveryRow, payload: JobReadyPayload): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": `${delivery.job_id}:${delivery.attempt}:job_ready`
    };
    if (this.config.notificationWebhookToken) {
      headers.Authorization = `Bearer ${this.config.notificationWebhookToken}`;
    }
    const response = await fetch(this.config.notificationWebhookUrl!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`notification webhook returned HTTP ${response.status}`);
  }

  private async deliverEmail(payload: JobReadyPayload): Promise<void> {
    if (!this.transporter || !this.config.emailFrom || !this.config.emailTo) return;
    const subject = this.config.emailSubjectTemplate
      .replaceAll("{title}", payload.title)
      .replaceAll("{outcome}", payload.outcome)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 998);
    const lines = [
      `${payload.title} has finished processing.`,
      "",
      `Status: ${payload.outcome === "ready" ? "Ready" : "Ready with warnings"}`,
      ...(payload.notion_url ? [`Notion: ${payload.notion_url}`] : []),
      `Scriberr: ${payload.scriberr_url}`
    ];
    await this.transporter.sendMail({
      from: this.config.emailFrom,
      to: this.config.emailTo,
      subject,
      text: lines.join("\n")
    });
  }
}
