import pino from "pino";

export type ScriberrReadinessStatus = "configuration_required" | "waiting" | "ready";

type AvailabilityCheck = {
  isAvailable(): Promise<boolean>;
};

export class ScriberrReadinessGate {
  private currentStatus: ScriberrReadinessStatus = "waiting";
  private checked = false;

  constructor(
    private readonly api: AvailabilityCheck,
    private readonly logger: pino.Logger
  ) {}

  get status(): ScriberrReadinessStatus {
    return this.currentStatus;
  }

  async run(work: () => void | Promise<void>): Promise<boolean> {
    const available = await this.api.isAvailable();
    if (!available) {
      if (!this.checked) {
        this.logger.info("waiting for Scriberr; processing is paused");
      } else if (this.currentStatus === "ready") {
        this.logger.warn("Scriberr became unavailable; processing is paused");
      }
      this.checked = true;
      this.currentStatus = "waiting";
      return false;
    }

    if (this.currentStatus === "waiting") {
      this.logger.info("Scriberr is available; processing is starting");
    }
    this.checked = true;
    this.currentStatus = "ready";
    await work();
    return true;
  }
}
