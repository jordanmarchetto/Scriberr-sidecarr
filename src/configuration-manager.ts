import { randomUUID } from "node:crypto";
import {
  resolveConfig,
  settingRegistry,
  type ActivationBehavior,
  type Config,
  type ConfigurationResolution,
  type SettingGroup,
  type SettingKey
} from "./config.js";

export interface SettingsStore {
  getApplicationSettings(): ReadonlyMap<string, string>;
  setApplicationSettings(values: ReadonlyMap<string, string | undefined>, updatedAt?: string): void;
}

export type RuntimeActivator = (next: Config, previous: Config) => void | (() => void) | Promise<void | (() => void)>;
export type ConfigurationUpdate = {
  resolution: ConfigurationResolution;
  revision: string;
  activationError?: Error;
};

export class ConfigurationConflictError extends Error {
  constructor() {
    super("settings changed since they were loaded");
    this.name = "ConfigurationConflictError";
  }
}

export class ConfigurationManager {
  private resolutionValue: ConfigurationResolution;
  private readonly activators = new Map<ActivationBehavior, RuntimeActivator>();
  private readonly cleanups = new Map<ActivationBehavior, () => void>();
  private readonly revisionGeneration = randomUUID();
  private revisionCounter = 1;

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly store: SettingsStore) {
    this.resolutionValue = resolveConfig(env, store);
  }

  get current(): ConfigurationResolution {
    return this.resolutionValue;
  }

  get revision(): string {
    return `${this.revisionGeneration}:${this.revisionCounter}`;
  }

  registerActivator(behavior: ActivationBehavior, activator: RuntimeActivator, currentCleanup?: () => void): void {
    if (behavior === "bootstrap") throw new Error("bootstrap settings cannot be activated in-process");
    this.activators.set(behavior, activator);
    if (currentCleanup) this.cleanups.set(behavior, currentCleanup);
  }

  async updateGroup(
    group: Exclude<SettingGroup, "runtime">,
    values: ReadonlyMap<SettingKey, string | undefined>,
    expectedRevision?: string
  ): Promise<ConfigurationUpdate> {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) throw new ConfigurationConflictError();
    const applicable = new Map<string, string | undefined>();
    for (const [key, value] of values) {
      const definition: (typeof settingRegistry)[number] | undefined = settingRegistry.find((candidate) => candidate.key === key);
      if (!definition || definition.group !== group) throw new Error(`${key} does not belong to the ${group} settings group`);
      if (this.env[definition.env]?.trim()) throw new Error(`${definition.env} is controlled by the environment`);
      applicable.set(key, value);
    }

    const previous = this.resolutionValue.config;
    this.store.setApplicationSettings(applicable);
    const next = resolveConfig(this.env, this.store);
    this.resolutionValue = next;
    this.revisionCounter += 1;
    const behavior = settingRegistry.find((definition) => definition.group === group)?.activation;
    const activator = behavior ? this.activators.get(behavior) : undefined;
    if (!behavior || !activator) return { resolution: next, revision: this.revision };

    try {
      const replacementCleanup = await activator(next.config, previous);
      this.cleanups.get(behavior)?.();
      if (replacementCleanup) this.cleanups.set(behavior, replacementCleanup);
      else this.cleanups.delete(behavior);
      return { resolution: next, revision: this.revision };
    } catch (error) {
      return { resolution: next, revision: this.revision, activationError: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  close(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
  }
}
