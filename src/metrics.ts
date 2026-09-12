import { StateStore } from "./db.js";

type DurationKind = "summary" | "transcription";
type WebhookOutcome = "accepted" | "duplicate" | "invalid" | "error";

export class Metrics {
  private apiFailures = 0;
  private mqttFailures = 0;
  private readonly discovered = new Map<string, number>();
  private readonly webhookRequests = new Map<WebhookOutcome, number>();
  private readonly durationCount: Record<DurationKind, number> = { summary: 0, transcription: 0 };
  private readonly durationSum: Record<DurationKind, number> = { summary: 0, transcription: 0 };

  incrementApiFailure(): void {
    this.apiFailures += 1;
  }

  incrementMqttFailure(): void {
    this.mqttFailures += 1;
  }

  incrementDiscovered(source: string): void {
    this.discovered.set(source, (this.discovered.get(source) ?? 0) + 1);
  }

  incrementWebhook(outcome: WebhookOutcome): void {
    this.webhookRequests.set(outcome, (this.webhookRequests.get(outcome) ?? 0) + 1);
  }

  observeDuration(kind: DurationKind, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.durationCount[kind] += 1;
    this.durationSum[kind] += seconds;
  }

  render(db: StateStore): string {
    const lines = [
      "# HELP scriberr_sidecarr_api_failures_total Scriberr API operations that exhausted retries.",
      "# TYPE scriberr_sidecarr_api_failures_total counter",
      `scriberr_sidecarr_api_failures_total ${this.apiFailures}`,
      "# HELP scriberr_sidecarr_mqtt_publish_failures_total MQTT publish failures.",
      "# TYPE scriberr_sidecarr_mqtt_publish_failures_total counter",
      `scriberr_sidecarr_mqtt_publish_failures_total ${this.mqttFailures}`,
      "# HELP scriberr_sidecarr_jobs_discovered_total Jobs discovered by source.",
      "# TYPE scriberr_sidecarr_jobs_discovered_total counter"
    ];

    for (const [source, value] of this.discovered) {
      lines.push(`scriberr_sidecarr_jobs_discovered_total{source="${escapeLabel(source)}"} ${value}`);
    }

    lines.push(
      "# HELP scriberr_sidecarr_webhook_requests_total Webhook requests by outcome.",
      "# TYPE scriberr_sidecarr_webhook_requests_total counter"
    );
    for (const [outcome, value] of this.webhookRequests) {
      lines.push(`scriberr_sidecarr_webhook_requests_total{outcome="${outcome}"} ${value}`);
    }

    lines.push(
      "# HELP scriberr_sidecarr_jobs Current tracked jobs by sidecar state.",
      "# TYPE scriberr_sidecarr_jobs gauge"
    );
    for (const row of db.jobStateCounts()) {
      lines.push(`scriberr_sidecarr_jobs{state="${escapeLabel(row.sidecar_state)}"} ${row.count}`);
    }

    lines.push(
      "# HELP scriberr_sidecarr_pending_mqtt_events MQTT events waiting to publish.",
      "# TYPE scriberr_sidecarr_pending_mqtt_events gauge",
      `scriberr_sidecarr_pending_mqtt_events ${db.pendingEventCount()}`,
      "# HELP scriberr_sidecarr_pending_webhook_signals Webhook signals waiting for API confirmation.",
      "# TYPE scriberr_sidecarr_pending_webhook_signals gauge",
      `scriberr_sidecarr_pending_webhook_signals ${db.pendingWebhookSignalCount()}`
    );

    for (const kind of ["transcription", "summary"] as const) {
      lines.push(
        `# HELP scriberr_sidecarr_${kind}_duration_seconds Time from discovery or request to completion.`,
        `# TYPE scriberr_sidecarr_${kind}_duration_seconds summary`,
        `scriberr_sidecarr_${kind}_duration_seconds_count ${this.durationCount[kind]}`,
        `scriberr_sidecarr_${kind}_duration_seconds_sum ${this.durationSum[kind]}`
      );
    }

    return lines.join("\n") + "\n";
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
