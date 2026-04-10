import { ModelConfig, LLMProvider, LLMMessage, LLMTool, LLMResponse, LLMStreamChunk, LLMProviderName } from '../types.ts';
import {
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  GoogleGeminiProvider,
  AzureOpenAIProvider,
  BedrockProvider,
  VertexAIProvider,
  CopilotProvider,
  OAuthOpenAIProvider,
  createLLMProvider,
  setOAuthManager,
  getOAuthManager,
} from './providers.ts';

export {
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  GoogleGeminiProvider,
  AzureOpenAIProvider,
  BedrockProvider,
  VertexAIProvider,
  CopilotProvider,
  OAuthOpenAIProvider,
  createLLMProvider,
  setOAuthManager,
  getOAuthManager,
};

const BILLING_PATTERNS = [
  'insufficient_quota', 'insufficient credits', 'credit balance too low',
  'billing_hard_limit_reached', 'exceeded your current quota',
  'payment required', 'account is deactivated', 'plan limit reached',
  'rate_limit_exceeded.*tokens', 'out of credits', 'no remaining credits',
];
const BILLING_RE = new RegExp(BILLING_PATTERNS.join('|'), 'i');

function isBillingError(err: any): boolean {
  const msg = String(err?.message || err || '');
  if (msg.includes('402') || msg.includes('payment required')) return true;
  return BILLING_RE.test(msg);
}

function isRateLimitError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return msg.includes('429') || /rate.?limit/i.test(msg);
}

function isAuthError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return msg.includes('401') || msg.includes('403') || /unauthorized|forbidden|invalid.?key/i.test(msg);
}

function isNotFoundError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return msg.includes('404') || /model.*not.*found|does not exist|not available|model_not_supported/i.test(msg);
}

interface CooldownEntry {
  cooldownUntil: number;
  errorCount: number;
  disabledUntil?: number;
  disabledReason?: string;
  lastError?: string;
}

const cooldownState = new Map<string, CooldownEntry>();

const COOLDOWN_BACKOFF = [60_000, 300_000, 1_500_000, 3_600_000];
const BILLING_BACKOFF = [18_000_000, 36_000_000, 86_400_000];

function getCooldownKey(config: ModelConfig): string {
  return `${config.provider}:${config.apiKey || 'default'}`;
}

function isProviderCoolingDown(config: ModelConfig): boolean {
  const key = getCooldownKey(config);
  const entry = cooldownState.get(key);
  if (!entry) return false;
  const now = Date.now();
  if (entry.disabledUntil && now < entry.disabledUntil) return true;
  if (entry.cooldownUntil && now < entry.cooldownUntil) return true;
  return false;
}

function markProviderCooldown(config: ModelConfig, error: any): void {
  const key = getCooldownKey(config);
  const entry = cooldownState.get(key) || { cooldownUntil: 0, errorCount: 0 };
  entry.errorCount++;
  entry.lastError = String(error?.message || error).slice(0, 200);

  if (isBillingError(error)) {
    const idx = Math.min(entry.errorCount - 1, BILLING_BACKOFF.length - 1);
    entry.disabledUntil = Date.now() + BILLING_BACKOFF[idx];
    entry.disabledReason = 'billing';
    console.warn(`[failover] Provider ${config.provider} DISABLED (billing) until ${new Date(entry.disabledUntil).toLocaleTimeString()}`);
  } else {
    const idx = Math.min(entry.errorCount - 1, COOLDOWN_BACKOFF.length - 1);
    entry.cooldownUntil = Date.now() + COOLDOWN_BACKOFF[idx];
    console.warn(`[failover] Provider ${config.provider} cooldown ${(COOLDOWN_BACKOFF[idx] / 1000).toFixed(0)}s (errors: ${entry.errorCount})`);
  }

  cooldownState.set(key, entry);
}

function clearProviderCooldown(config: ModelConfig): void {
  const key = getCooldownKey(config);
  cooldownState.delete(key);
}


const FORWARD_COMPAT_FALLBACKS: Record<string, string> = {

  'gpt-5.4': 'gpt-5.2',
  'gpt-5.3-codex': 'gpt-5.2',
  'gpt-5.2': 'gpt-5.1',
  'gpt-5.1': 'gpt-4o',
  'gpt-5-mini': 'gpt-4o-mini',

  'o4-mini': 'o3-mini',
  'o3': 'gpt-4.1',
  'o3-mini': 'gpt-4o-mini',
  'o1': 'gpt-4o',
  'o1-mini': 'gpt-4o-mini',
  'o1-preview': 'gpt-4o',

  'claude-opus-4.6': 'claude-opus-4.5',
  'claude-sonnet-4.6': 'claude-sonnet-4.5',
  'claude-opus-4.5': 'claude-opus-4-20250514',
  'claude-sonnet-4.5': 'claude-sonnet-4-20250514',

  'gemini-3.1-pro-preview': 'gemini-2.5-pro',
  'gemini-3-flash-preview': 'gemini-2.5-flash',

  'grok-3': 'grok-2',
};

function getForwardCompatFallback(model: string): string | null {
  return FORWARD_COMPAT_FALLBACKS[model] || null;
}


export function parseApiKeys(provider: LLMProviderName): string[] {
  const keys: string[] = [];
  const envPrefix = provider.toUpperCase().replace(/-/g, '_');


  const multiKey = process.env[`${envPrefix}_API_KEYS`];
  if (multiKey) {
    keys.push(...multiKey.split(/[,;]/).map(k => k.trim()).filter(Boolean));
  }


  const singleKey = process.env[`${envPrefix}_API_KEY`];
  if (singleKey && !keys.includes(singleKey)) {
    keys.push(singleKey);
  }


  for (let i = 1; i <= 10; i++) {
    const k = process.env[`${envPrefix}_API_KEY_${i}`];
    if (k && !keys.includes(k)) keys.push(k);
  }


  if ((provider === 'google' || provider === 'google-oauth') && keys.length === 0) {
    const gk = process.env.GOOGLE_API_KEY;
    if (gk) keys.push(gk);
  }

  return keys;
}


export class FallbackLLMProvider implements LLMProvider {
  private providers: LLMProvider[];
  private configs: ModelConfig[];
  private names: string[];
  private lastSuccessIndex = 0;

  constructor(configs: ModelConfig[]) {
    this.configs = configs;
    this.providers = configs.map(c => createLLMProvider(c));
    this.names = configs.map(c => `${c.provider}/${c.model}`);
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);

    const order = [
      this.lastSuccessIndex,
      ...Array.from({ length: this.providers.length }, (_, i) => i).filter(i => i !== this.lastSuccessIndex),
    ];

    let lastError: Error | null = null;

    for (const idx of order) {

      if (isProviderCoolingDown(this.configs[idx])) {
        console.warn(`[failover] Skipping ${this.names[idx]} (in cooldown)`);
        continue;
      }

      try {
        const result = await this.providers[idx].chat(messages, tools, options);
        this.lastSuccessIndex = idx;
        clearProviderCooldown(this.configs[idx]);
        return result;
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err?.message || '');
        console.warn(`[failover] ${this.names[idx]} failed: ${errMsg.slice(0, 150)}`);


        if (isBillingError(err)) {
          markProviderCooldown(this.configs[idx], err);
          continue;
        }


        if (isNotFoundError(err)) {
          const fallbackModel = getForwardCompatFallback(this.configs[idx].model);
          if (fallbackModel) {
            console.warn(`[failover] 404 → forward-compat fallback: ${this.configs[idx].model} → ${fallbackModel}`);
            try {
              const fallbackConfig = { ...this.configs[idx], model: fallbackModel };
              const fallbackProvider = createLLMProvider(fallbackConfig);
              const result = await fallbackProvider.chat(messages, tools, options);

              this.providers[idx] = fallbackProvider;
              this.configs[idx] = fallbackConfig;
              this.names[idx] = `${fallbackConfig.provider}/${fallbackModel}`;
              this.lastSuccessIndex = idx;
              return result;
            } catch (e2: any) {
              console.warn(`[failover] Forward-compat fallback also failed: ${String(e2?.message || '').slice(0, 100)}`);
            }
          }
          continue;
        }


        if (isRateLimitError(err) || isAuthError(err)) {
          markProviderCooldown(this.configs[idx], err);
          continue;
        }


      }
    }

    throw new Error(`All ${this.providers.length} LLM providers failed. Last error: ${lastError?.message}`);
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const order = [
      this.lastSuccessIndex,
      ...Array.from({ length: this.providers.length }, (_, i) => i).filter(i => i !== this.lastSuccessIndex),
    ];

    let lastError: Error | null = null;

    for (const idx of order) {
      if (isProviderCoolingDown(this.configs[idx])) continue;

      const provider = this.providers[idx];
      if (!provider.stream) continue;

      try {
        const gen = provider.stream(messages, tools, options);

        const first = await gen.next();
        if (!first.done) {
          this.lastSuccessIndex = idx;
          clearProviderCooldown(this.configs[idx]);
          yield first.value;
          yield* gen;
          return;
        }
      } catch (err: any) {
        lastError = err;
        console.warn(`[failover] stream ${this.names[idx]} failed: ${String(err?.message || '').slice(0, 150)}`);

        if (isBillingError(err) || isRateLimitError(err) || isAuthError(err)) {
          markProviderCooldown(this.configs[idx], err);
        }
      }
    }

    throw new Error(`All LLM providers failed streaming. Last error: ${lastError?.message}`);
  }
}


export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cyrillicCount = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latinCount = text.length - cyrillicCount;
  return Math.ceil(latinCount / 4 + cyrillicCount / 2.5);
}

export function getContextWindowTokens(config: ModelConfig): number {
  if (config.contextWindow) return config.contextWindow;


  const model = config.model.toLowerCase();


  if (model.includes('claude') || model.includes('gemini')) return 200_000;


  if (model.includes('gpt-5') || model.includes('gpt-4o') || model.includes('gpt-4.1') || model.includes('gpt-4-turbo')) return 128_000;
  if (model.includes('deepseek') || model.includes('qwen')) return 128_000;
  if (model.includes('llama-4') || model.includes('llama4')) return 128_000;
  if (model.includes('grok')) return 128_000;
  if (model.includes('mistral-large')) return 128_000;


  if (model.includes('gpt-3.5') || model.includes('mixtral')) return 32_000;
  if (model.includes('llama-3.3') || model.includes('llama3.3')) return 128_000;
  if (model.includes('llama-3.1') || model.includes('llama3.1')) return 128_000;


  if (config.provider === 'ollama') return 32_000;


  return 128_000;
}

const providerCache = new Map<string, LLMProvider>();

export function getLLMProvider(config: ModelConfig): LLMProvider {
  const key = `${config.provider}:${config.model}:${config.baseUrl || ''}`;

  let provider = providerCache.get(key);
  if (!provider) {
    provider = createLLMProvider(config);
    providerCache.set(key, provider);
  }

  return provider;
}

export function getLLMProviderWithFallback(configs: ModelConfig[]): LLMProvider {
  if (configs.length === 0) throw new Error('At least one model config required');
  if (configs.length === 1) return getLLMProvider(configs[0]);

  const key = configs.map(c => `${c.provider}:${c.model}`).join('|');
  let provider = providerCache.get(key);
  if (!provider) {
    provider = new FallbackLLMProvider(configs);
    providerCache.set(key, provider);
  }
  return provider;
}

export function clearProviderCache(): void {
  providerCache.clear();
}
