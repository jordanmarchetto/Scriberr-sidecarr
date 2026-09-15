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
  activationError?: Error;
};

export class ConfigurationManager {
  private resolutionValue: ConfigurationResolution;
  private readonly activators = new Map<ActivationBehavior, RuntimeActivator>();
  private readonly cleanups = new Map<ActivationBehavior, () => void>();

  constructor(private readonly env: NodeJS.ProcessEnv, private readonly store: SettingsStore) {
    this.resolutionValue = resolveConfig(env, store);
  }

  get current(): ConfigurationResolution {
    return this.resolutionValue;
  }

  registerActivator(behavior: ActivationBehavior, activator: RuntimeActivator): void {
    if (behavior === "bootstrap") throw new Error("bootstrap settings cannot be activated in-process");
    this.activators.set(behavior, activator);
  }

  async updateGroup(group: Exclude<SettingGroup, "runtime">, values: ReadonlyMap<SettingKey, string | undefined>): Promise<ConfigurationUpdate> {
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
    const behavior = settingRegistry.find((definition) => definition.group === group)?.activation;
    const activator = behavior ? this.activators.get(behavior) : undefined;
    if (!behavior || !activator) return { resolution: next };

    try {
      const replacementCleanup = await activator(next.config, previous);
      this.cleanups.get(behavior)?.();
      if (replacementCleanup) this.cleanups.set(behavior, replacementCleanup);
      else this.cleanups.delete(behavior);
      return { resolution: next };
    } catch (error) {
      return { resolution: next, activationError: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  close(): void {
    for (const cleanup of this.cleanups.values()) cleanup();
    this.cleanups.clear();
  }
}
