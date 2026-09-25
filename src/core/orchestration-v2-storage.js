import {
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  validateOrchestrationConfig,
} from './orchestration-v2.js';

export const ORCHESTRATION_CONFIG_STORAGE_KEY = 'autopilotOrchestrationV2Config';
export const ORCHESTRATION_RUNTIME_STORAGE_KEY = 'autopilotOrchestrationV2Runtime';

export class OrchestrationConfigRepository {
  constructor(chromeApi, { storageKey = ORCHESTRATION_CONFIG_STORAGE_KEY } = {}) {
    if (!chromeApi?.storage?.local) throw new Error('Chrome storage.local required');
    this.chrome = chromeApi;
    this.storageKey = storageKey;
  }
  async load() {
    const result = await this.chrome.storage.local.get(this.storageKey);
    return validateOrchestrationConfig(result?.[this.storageKey] || {});
  }
  async save(raw) {
    const config = validateOrchestrationConfig(raw);
    await this.chrome.storage.local.set({ [this.storageKey]: config });
    return config;
  }
}


export class OrchestrationRuntimeRepository {
  constructor(chromeApi, configRepository, { now = () => Date.now(), storageKey = ORCHESTRATION_RUNTIME_STORAGE_KEY } = {}) {
    if (!chromeApi?.storage?.local) throw new Error('Chrome storage.local required');
    this.chrome = chromeApi;
    this.configRepository = configRepository || new OrchestrationConfigRepository(chromeApi);
    this.now = now;
    this.storageKey = storageKey;
    this.updateChain = Promise.resolve();
  }
  async load() {
    const config = await this.configRepository.load();
    const result = await this.chrome.storage.local.get(this.storageKey);
    return normalizeOrchestrationRuntime(result?.[this.storageKey], config, this.now());
  }
  async save(runtime) {
    const config = await this.configRepository.load();
    const normalized = normalizeOrchestrationRuntime(runtime, config, this.now());
    await this.chrome.storage.local.set({ [this.storageKey]: normalized });
    return normalized;
  }
  update(mutator) {
    const operation = this.updateChain.then(async () => {
      const config = await this.configRepository.load();
      const result = await this.chrome.storage.local.get(this.storageKey);
      const runtime = normalizeOrchestrationRuntime(result?.[this.storageKey], config, this.now());
      const updated = await mutator(runtime, config) || runtime;
      const normalized = normalizeOrchestrationRuntime(updated, config, this.now());
      await this.chrome.storage.local.set({ [this.storageKey]: normalized });
      return normalized;
    });
    this.updateChain = operation.catch(() => undefined);
    return operation;
  }
  async reset() {
    const config = await this.configRepository.load();
    const runtime = createOrchestrationRuntime(config, this.now());
    await this.chrome.storage.local.set({ [this.storageKey]: runtime });
    return runtime;
  }
}
