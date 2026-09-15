import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { z } from "zod";
import type { Config } from "./config.js";
import { StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import { Metrics } from "./metrics.js";
import type { ScriberrWebhookPayload } from "./types.js";
import type { ScriberrReadinessStatus } from "./scriberr-readiness.js";
import type { UiServer } from "./ui-server.js";

const maxBodyBytes = 1024 * 1024;

const webhookSchema = z.object({
  schema_version: z.literal("1"),
  event: z.enum([
    "recording.uploaded",
    "transcription.completed",
    "transcription.failed",
    "summary.completed",
    "summary.failed"
  ]),
  job_id: z.string().min(1),
  title: z.string().optional(),
  status: z.string(),
  audio_path: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  occurred_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp")
});

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class WebhookReceiver {
  private readonly server: Server;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly onSignal: () => void | Promise<void>,
    private readonly logger: pino.Logger,
    private readonly metrics = new Metrics(),
    private readonly scriberrStatus: () => ScriberrReadinessStatus = () => "waiting",
    private readonly ui?: UiServer
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async listen(port = this.config.webhookPort, host = this.config.webhookHost): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
    this.logger.info({ host, port: this.port(), path: this.config.webhookPath }, "webhook receiver listening");
  }

  port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? (address as AddressInfo).port : this.config.webhookPort;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://sidecar");
      if (request.method === "GET" && url.pathname === "/health") {
        this.respond(response, 200, { status: "ok", scriberr: this.scriberrStatus() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        this.respondText(response, 200, this.metrics.render(this.db));
        return;
      }
      if (this.ui && await this.ui.handle(request, response, url)) return;
      if (url.pathname !== this.config.webhookPath) {
        this.respond(response, 404, { error: "not found" });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        this.respond(response, 405, { error: "method not allowed" });
        return;
      }
      if (!request.headers["content-type"]?.startsWith("application/json")) {
        throw new HttpError(415, "content type must be application/json");
      }

      const deliveryId = this.header(request, "x-scriberr-delivery");
      if (!deliveryId) throw new HttpError(400, "missing X-Scriberr-Delivery header");

      const body = await this.readBody(request);
      if (!this.validSignature(body, this.header(request, "x-scriberr-signature"))) {
        throw new HttpError(401, "invalid webhook signature");
      }

      let input: unknown;
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        throw new HttpError(400, "invalid JSON");
      }
      const parsed = webhookSchema.safeParse(input);
      if (!parsed.success) throw new HttpError(400, "invalid webhook payload");

      const payload: ScriberrWebhookPayload = parsed.data;
      const inserted = this.db.recordWebhookSignal(deliveryId, payload, new Date().toISOString());
      this.respond(response, 202, { accepted: true, duplicate: !inserted });
      this.metrics.incrementWebhook(inserted ? "accepted" : "duplicate");
      this.logger.debug({
        deliveryId,
        jobId: payload.job_id,
        event: payload.event,
        duplicate: !inserted
      }, inserted ? "webhook accepted" : "duplicate webhook ignored");

      if (inserted) {
        void Promise.resolve().then(() => this.onSignal()).catch((error: unknown) => {
          const message = sanitizeError(error);
          this.logger.error({ jobId: payload.job_id, event: payload.event, error: message }, "webhook processing failed");
        });
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "internal server error";
      const details = {
        method: request.method,
        path: request.url,
        deliveryId: this.header(request, "x-scriberr-delivery") || undefined,
        status,
        error: sanitizeError(status === 500 ? error : message)
      };
      if (status === 500) this.logger.error(details, "webhook request failed");
      else this.logger.warn(details, "webhook request rejected");
      this.respond(response, status, { error: message });
      this.metrics.incrementWebhook(status === 500 ? "error" : "invalid");
    }
  }

  private header(request: IncomingMessage, name: string): string {
    const value = request.headers[name];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  }

  private async readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) throw new HttpError(413, "webhook payload too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private validSignature(body: Buffer, signature: string): boolean {
    const secret = this.config.webhookSecret;
    if (!secret) return true;
    if (!/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;

    const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
    const expected = createHmac("sha256", secret).update(body).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private respond(response: ServerResponse, status: number, body: object): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private respondText(response: ServerResponse, status: number, body: string): void {
    if (response.headersSent) return;
    response.writeHead(status, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(body);
  }
}
