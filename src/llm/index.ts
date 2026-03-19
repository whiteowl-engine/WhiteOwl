import { ModelConfig, LLMProvider, LLMMessage, LLMTool, LLMResponse, LLMStreamChunk } from '../types';
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
} from './providers';

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

// =====================================================
// Fallback LLM provider — tries providers in order
// =====================================================

export class FallbackLLMProvider implements LLMProvider {
  private providers: LLMProvider[];
  private names: string[];
  private lastSuccessIndex = 0;

  constructor(configs: ModelConfig[]) {
    this.providers = configs.map(c => createLLMProvider(c));
    this.names = configs.map(c => `${c.provider}/${c.model}`);
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    // Start from the last successful provider for hot-path speed
    const order = [
      this.lastSuccessIndex,
      ...Array.from({ length: this.providers.length }, (_, i) => i).filter(i => i !== this.lastSuccessIndex),
    ];

    let lastError: Error | null = null;

    for (const idx of order) {
      try {
        const result = await this.providers[idx].chat(messages, tools, options);
        this.lastSuccessIndex = idx;
        return result;
      } catch (err: any) {
        lastError = err;
      }
    }

    throw new Error(`All LLM providers failed. Last error: ${lastError?.message}`);
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const order = [
      this.lastSuccessIndex,
      ...Array.from({ length: this.providers.length }, (_, i) => i).filter(i => i !== this.lastSuccessIndex),
    ];

    let lastError: Error | null = null;

    for (const idx of order) {
      const provider = this.providers[idx];
      if (!provider.stream) continue;

      try {
        const gen = provider.stream(messages, tools, options);
        // Yield first chunk to verify the stream works before committing
        const first = await gen.next();
        if (!first.done) {
          this.lastSuccessIndex = idx;
          yield first.value;
          yield* gen;
          return;
        }
      } catch (err: any) {
        lastError = err;
      }
    }

    throw new Error(`All LLM providers failed streaming. Last error: ${lastError?.message}`);
  }
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

/**
 * Create a fallback chain from multiple model configs.
 * Tries each provider in order; on failure, falls over to the next.
 */
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
