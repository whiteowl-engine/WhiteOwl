import { LLMMessage, LLMTool, LLMResponse, LLMToolCall, LLMProvider, ModelConfig, LLMProviderName, LLMStreamChunk } from '../types.ts';
import { OAuthManager } from '../core/oauth-manager.ts';

let _oauthManager: OAuthManager | null = null;
export function setOAuthManager(manager: OAuthManager): void { _oauthManager = manager; }
export function getOAuthManager(): OAuthManager | null { return _oauthManager; }

const OPENAI_COMPATIBLE_URLS: Partial<Record<LLMProviderName, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  perplexity: 'https://api.perplexity.ai',
  huggingface: 'https://api-inference.huggingface.co/v1',
  github: 'https://models.inference.ai.azure.com',
  minimax: 'https://api.minimax.chat/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  hyperbolic: 'https://api.hyperbolic.xyz/v1',
  cohere: 'https://api.cohere.com/compatibility/v1',
  lepton: 'https://api.lepton.ai/v1',
  // Kiro acts as an OpenAI-compatible aggregator: same plug-and-play model as
  // pointing the OpenAI client at a custom base URL (similar to how Visual
  // Studio / Copilot wires in alternative providers). Override via KIRO_BASE_URL.
  kiro: 'https://api.kiro.dev/v1',
};

const OPENAI_COMPATIBLE_PROVIDERS = new Set<LLMProviderName>(
  Object.keys(OPENAI_COMPATIBLE_URLS) as LLMProviderName[]
);

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private providerName: LLMProviderName;

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || '';
    this.providerName = config.provider;
    this.baseUrl = config.baseUrl || OPENAI_COMPATIBLE_URLS[config.provider] || 'https://api.openai.com/v1';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {

    const filteredMessages = messages.filter(m => m && m.role);
    const isGroq = this.providerName === 'groq';
    const isDeepSeek = this.providerName === 'deepseek';
    const processedMessages = isGroq
      ? this.trimForRateLimit(filteredMessages)
      : filteredMessages;

    const body: Record<string, any> = {
      model: this.model,
      messages: processedMessages.map(m => this.formatMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? (isGroq ? 4096 : 16384),
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    if (this.providerName === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/axiom-trading/axiom';
      headers['X-Title'] = 'AXIOM Trading Shell';
    }


    const MAX_RETRIES = 4;
    const BACKOFF_MS = [5000, 15000, 30000, 60000];
    const FETCH_TIMEOUT_MS = 300_000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
                response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error(`LLM request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          const errorBody = await response.text();
          throw new Error(`LLM request failed (429): ${errorBody}`);
        }

        const retryAfterHeader = response.headers.get('retry-after');
        let waitMs = BACKOFF_MS[attempt] || 60000;
        if (retryAfterHeader) {
          waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfterHeader) * 1000 + 500));
        } else {
          const body429 = await response.text();
          const match = body429.match(/try again in ([0-9.]+)s/i);
          if (match) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(match[1]) * 1000 + 500));
        }
        console.warn(`[${this.providerName}] 429 rate limit — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${errorBody}`);
      }

      const data = await response.json() as any;
      const choice = data.choices[0];
      const msg = choice.message;

      const result: LLMResponse = {
        content: msg.content || '',
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
        } : undefined,
      };

      if (msg.tool_calls) {
        result.toolCalls = msg.tool_calls.map((tc: any): LLMToolCall => ({
          id: tc.id,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }

      return result;
    }

    throw new Error('LLM request failed after retries');
  }

private trimForRateLimit(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;


    const TOOL_RESULT_LIMIT = 3000;
    const SYS_LIMIT = 6000;

    return messages.map((m, i) => {

      if (m.role === 'system' && m.content && m.content.length > SYS_LIMIT) {
        return { ...m, content: m.content.slice(0, SYS_LIMIT) + '\n[...trimmed for rate limit]' };
      }

      if (m.role === 'tool' && m.content && m.content.length > TOOL_RESULT_LIMIT) {
        const isRecent = i >= messages.length - 16;
        if (!isRecent) {
          return { ...m, content: m.content.slice(0, TOOL_RESULT_LIMIT) + '\n[trimmed]' };
        }
      }
      return m;
    });
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    const isGroq = this.providerName === 'groq';
    const isDeepSeek = this.providerName === 'deepseek';
    const filteredMessages = messages.filter(m => m && m.role);
    const processedMessages = isGroq ? this.trimForRateLimit(filteredMessages) : filteredMessages;

    const body: Record<string, any> = {
      model: this.model,
      messages: processedMessages.map(m => this.formatMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? (isGroq ? 4096 : 16384),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    if (this.providerName === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/axiom-trading/axiom';
      headers['X-Title'] = 'AXIOM Trading Shell';
    }


    let response: Response | null = null;
    const MAX_RETRIES = 4;
    const BACKOFF_MS = [5000, 15000, 30000, 60000];
    const FETCH_TIMEOUT_MS = 300_000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
      try {
                response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abort.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error(`LLM stream timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          const errorBody = await response.text();
          throw new Error(`LLM stream failed (429): ${errorBody}`);
        }
        const retryAfterHeader = response.headers.get('retry-after');
        let waitMs = BACKOFF_MS[attempt] || 60000;
        if (retryAfterHeader) {
          waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfterHeader) * 1000 + 500));
        } else {
          const body429 = await response.text();
          const match = body429.match(/try again in ([0-9.]+)s/i);
          if (match) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(match[1]) * 1000 + 500));
        }
        console.warn(`[${this.providerName}] stream 429 — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errorBody = await response!.text();
      throw new Error(`LLM stream failed (${response!.status}): ${errorBody}`);
    }

    const reader = response!.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const sseData = trimmed.slice(6);
          if (sseData === '[DONE]') {
            if (toolCallAccumulator.size > 0) {
              const toolCalls: LLMToolCall[] = Array.from(toolCallAccumulator.values()).map(tc => ({
                id: tc.id,
                function: { name: tc.name, arguments: tc.args },
              }));
              yield { toolCalls, done: true };
            } else {
              yield { done: true };
            }
            return;
          }

          try {
            const parsed = JSON.parse(sseData);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              yield { content: delta.content, done: false };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccumulator.has(idx)) {
                  toolCallAccumulator.set(idx, { id: tc.id || '', name: '', args: '' });
                }
                const acc = toolCallAccumulator.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }
          } catch {

          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (toolCallAccumulator.size > 0) {
      const toolCalls: LLMToolCall[] = Array.from(toolCallAccumulator.values()).map(tc => ({
        id: tc.id,
        function: { name: tc.name, arguments: tc.args },
      }));
      yield { toolCalls, done: true };
    } else {
      yield { done: true };
    }
  }

  private formatMessage(msg: LLMMessage): Record<string, any> {
    const formatted: Record<string, any> = {
      role: msg.role,
    };


    if (msg.image && msg.role === 'user') {
      const base64 = msg.image.replace(/^data:image\/[^;]+;base64,/, '');
      formatted.content = [
        { type: 'text', text: msg.content },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
      ];
    } else {
      formatted.content = msg.content;
    }

    if (msg.toolCallId) {
      formatted.tool_call_id = msg.toolCallId;
    }

    if (msg.toolCalls) {
      formatted.tool_calls = msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      }));
    }

    return formatted;
  }
}


export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: ModelConfig) {
    this.apiKey = config.apiKey || '';
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map(m => this.formatMessage(m)),
    };

    if (systemMsg) {

      body.system = [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }];
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));

      if (body.tools.length > 0) {
        body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
      }
    }


    let response: Response | null = null;
    const MAX_RETRIES = 4;
    const BACKOFF_MS = [5000, 15000, 30000, 60000];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          const errorBody = await response.text();
          throw new Error(`Anthropic request failed (429): ${errorBody}`);
        }
        const retryAfter = response.headers.get('retry-after');
        let waitMs = BACKOFF_MS[attempt] || 60000;
        if (retryAfter) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfter) * 1000 + 500));
        console.warn(`[Anthropic] 429 — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errorBody = await response!.text();
      throw new Error(`Anthropic request failed (${response!.status}): ${errorBody}`);
    }

    const data = await response!.json() as any;

    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      } : undefined,
    };
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map(m => this.formatMessage(m)),
      stream: true,
    };

    if (systemMsg) {
      body.system = [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }];
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      if (body.tools.length > 0) {
        body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
      }
    }


    let response: Response | null = null;
    const STREAM_MAX_RETRIES = 4;
    const STREAM_BACKOFF = [5000, 15000, 30000, 60000];
    for (let attempt = 0; attempt <= STREAM_MAX_RETRIES; attempt++) {
            response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429) {
        if (attempt === STREAM_MAX_RETRIES) {
          const errorBody = await response.text();
          throw new Error(`Anthropic stream failed (429): ${errorBody}`);
        }
        const retryAfter = response.headers.get('retry-after');
        let waitMs = STREAM_BACKOFF[attempt] || 60000;
        if (retryAfter) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfter) * 1000 + 500));
        console.warn(`[Anthropic] stream 429 — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${STREAM_MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errorBody = await response!.text();
      throw new Error(`Anthropic stream failed (${response!.status}): ${errorBody}`);
    }

    const reader = response!.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallAccumulator = new Map<string, { id: string; name: string; args: string }>();
    let currentToolId = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const sseData = trimmed.slice(6);

          try {
            const event = JSON.parse(sseData);

            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              currentToolId = event.content_block.id;
              toolCallAccumulator.set(currentToolId, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: '',
              });
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                yield { content: event.delta.text, done: false };
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                const acc = toolCallAccumulator.get(currentToolId);
                if (acc) acc.args += event.delta.partial_json;
              }
            } else if (event.type === 'message_stop') {
              if (toolCallAccumulator.size > 0) {
                const toolCalls: LLMToolCall[] = Array.from(toolCallAccumulator.values()).map(tc => ({
                  id: tc.id,
                  function: { name: tc.name, arguments: tc.args },
                }));
                yield { toolCalls, done: true };
              } else {
                yield { done: true };
              }
              return;
            } else if (event.type === 'message_delta' && event.usage) {
              yield {
                done: false,
                usage: {
                  promptTokens: 0,
                  completionTokens: event.usage.output_tokens || 0,
                },
              };
            }
          } catch {

          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { done: true };
  }

  private formatMessage(msg: LLMMessage): Record<string, any> {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: sanitizeToolId(msg.toolCallId || ''),
          content: msg.content,
        }],
      };
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: sanitizeToolId(tc.id),
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
      return { role: 'assistant', content };
    }

    return { role: msg.role === 'user' ? 'user' : 'assistant', content: msg.image && msg.role === 'user' ? [
      { type: 'text', text: msg.content },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: msg.image.replace(/^data:image\/[^;]+;base64,/, '') } },
    ] : msg.content };
  }
}


function normalizeGeminiContents(msgs: LLMMessage[]): Record<string, any>[] {
  const result: Record<string, any>[] = [];

  for (const msg of msgs) {
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';

    let parts: any[];
    if (msg.role === 'tool') {
      parts = [{
        functionResponse: {
          name: msg.toolCallId || 'unknown_tool',
          response: { content: msg.content },
        },
      }];
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        try {
          parts.push({ functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) } });
        } catch {
          parts.push({ functionCall: { name: tc.function.name, args: {} } });
        }
      }
    } else if (msg.image && msg.role === 'user') {
      parts = [
        { text: msg.content || '' },
        { inlineData: { mimeType: 'image/png', data: msg.image.replace(/^data:image\/[^;]+;base64,/, '') } },
      ];
    } else {
      parts = [{ text: msg.content || '' }];
    }

    const last = result[result.length - 1];
    if (last && last.role === geminiRole && geminiRole === 'user') {

      last.parts.push(...parts);
    } else {
      result.push({ role: geminiRole, parts });
    }
  }


  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', parts: [{ text: '' }] });
  }

  return result;
}


export class GoogleGeminiProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: ModelConfig) {
    this.apiKey = config.apiKey || '';
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const contents = normalizeGeminiContents(nonSystem);

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
    };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }


    const fallbackChain = [
      this.model,
      ...(this.model !== 'gemini-2.5-flash' ? ['gemini-2.5-flash'] : []),
      ...(this.model !== 'gemini-2.5-flash-lite' ? ['gemini-2.5-flash-lite'] : []),
    ];

    let lastError = '';
    for (let i = 0; i < fallbackChain.length; i++) {
      const modelToTry = fallbackChain[i];
      if (i > 0) {
        console.warn(`[Gemini] Falling back from ${fallbackChain[i - 1]} to ${modelToTry}`);
        this.model = modelToTry;
      }

      const url = `${this.baseUrl}/models/${modelToTry}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json() as any;
        const candidate = data.candidates?.[0];
        if (!candidate) throw new Error('Gemini returned no candidates');
        return this._parseCandidate(candidate, data);
      }

      const errorBody = await response.text();
      lastError = `Gemini request failed (${response.status}) for ${modelToTry}: ${errorBody}`;


      if (response.status !== 429 && response.status !== 404) {
        throw new Error(lastError);
      }


      if (response.status === 429 && i < fallbackChain.length - 1) {
        const retryAfterMs = Math.min(10_000, (parseInt(response.headers.get('retry-after') || '0', 10) || 2) * 1000);
        await new Promise(r => setTimeout(r, retryAfterMs));
      }
    }

    throw new Error(lastError);
  }

  private _parseCandidate(candidate: any, data: any): LLMResponse {
    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount || 0,
        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
      } : undefined,
    };
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const contents = normalizeGeminiContents(nonSystem);

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
    };
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
    }

    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const response = await fetch(url, {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini stream failed (${response.status}): ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for Gemini streaming');
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const sseData = trimmed.slice(6);
          if (sseData === '[DONE]') { yield { done: true }; return; }
          try {
            const parsed = JSON.parse(sseData);
            const candidate = parsed.candidates?.[0];
            if (!candidate) continue;
            for (const part of candidate.content?.parts || []) {
              if (part.text) yield { content: part.text, done: false };
              if (part.functionCall) {
                yield {
                  toolCalls: [{
                    id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
                  }],
                  done: false,
                };
              }
            }
            if (candidate.finishReason) yield { done: true };
          } catch {  }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { done: true };
  }

  private formatMessage(msg: LLMMessage): Record<string, any> {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolCallId || 'tool',
            response: { content: msg.content },
          },
        }],
      };
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          },
        });
      }
      return { role: 'model', parts };
    }

    if (msg.image && msg.role === 'user') {
      return {
        role: 'user',
        parts: [
          { text: msg.content },
          { inlineData: { mimeType: 'image/png', data: msg.image.replace(/^data:image\/[^;]+;base64,/, '') } },
        ],
      };
    }

    return {
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    };
  }
}


export class AzureOpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private deployment: string;
  private apiVersion: string;

  constructor(config: ModelConfig) {
    this.apiKey = config.apiKey || '';
    this.deployment = config.model;
    this.baseUrl = config.baseUrl || '';
    this.apiVersion = '2024-06-01';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    if (!this.baseUrl) {
      throw new Error('Azure OpenAI requires baseUrl (e.g. https://<resource>.openai.azure.com)');
    }

    messages = messages.filter(m => m && m.role);
    const body: Record<string, any> = {
      messages: messages.map(m => this.formatMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const url = `${this.baseUrl}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const response = await fetch(url, {
            method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure OpenAI request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;
    const choice = data.choices[0];
    const msg = choice.message;

    const result: LLMResponse = {
      content: msg.content || '',
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };

    if (msg.tool_calls) {
      result.toolCalls = msg.tool_calls.map((tc: any): LLMToolCall => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return result;
  }

  private formatMessage(msg: LLMMessage): Record<string, any> {
    const formatted: Record<string, any> = {
      role: msg.role,
    };
    if (msg.image && msg.role === 'user') {
      const base64 = msg.image.replace(/^data:image\/[^;]+;base64,/, '');
      formatted.content = [
        { type: 'text', text: msg.content },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
      ];
    } else {
      formatted.content = msg.content;
    }
    if (msg.toolCallId) formatted.tool_call_id = sanitizeToolId(msg.toolCallId);
    if (msg.toolCalls) {
      formatted.tool_calls = msg.toolCalls.map(tc => ({
        id: sanitizeToolId(tc.id),
        type: 'function',
        function: tc.function,
      }));
    }
    return formatted;
  }
}


export class BedrockProvider implements LLMProvider {
  private model: string;
  private region: string;
  private accessKeyId: string;
  private secretAccessKey: string;

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.region = config.region || process.env.AWS_REGION || 'us-east-1';
    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body: Record<string, any> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options?.maxTokens ?? 4096,
      messages: nonSystem.map(m => {
        const role = m.role === 'tool' ? 'user' : m.role === 'assistant' ? 'assistant' : 'user';
        if (m.image && m.role === 'user') {
          return { role, content: [
            { type: 'text', text: m.content },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: m.image.replace(/^data:image\/[^;]+;base64,/, '') } },
          ] };
        }
        return { role, content: m.content };
      }),
    };

    if (systemMsg) body.system = systemMsg.content;

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(this.model)}/invoke`;
    const payload = JSON.stringify(body);

    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

    const headers = await this.signRequest('POST', host, path, payload, dateStamp, amzDate);

        const response = await fetch(`https://${host}${path}`, {
            method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: payload,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Bedrock request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;

    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === 'text') content += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens || 0,
        completionTokens: data.usage.output_tokens || 0,
      } : undefined,
    };
  }

  private async signRequest(
    method: string,
    host: string,
    path: string,
    payload: string,
    dateStamp: string,
    amzDate: string
  ): Promise<Record<string, string>> {
    const { createHmac, createHash } = await import('crypto');

    const service = 'bedrock';
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;

    const payloadHash = createHash('sha256').update(payload).digest('hex');

    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';

    const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${this.secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(this.region).digest();
    const kService = createHmac('sha256', kRegion).update(service).digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();

    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      'x-amz-date': amzDate,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}


export class VertexAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private projectId: string;
  private region: string;

  constructor(config: ModelConfig) {
    this.apiKey = config.apiKey || '';
    this.model = config.model;
    this.projectId = process.env.GOOGLE_PROJECT_ID || '';
    this.region = config.region || process.env.GOOGLE_REGION || 'us-central1';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {

    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const contents = normalizeGeminiContents(nonSystem);

    const body: Record<string, any> = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 4096,
      },
    };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      }];
    }

    const url = `https://api.anthropic.com/v1/messages`;
    const response = await fetch(url, {
            method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Vertex AI request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Vertex AI returned no candidates');

    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const part of candidate.content?.parts || []) {
      if (part.text) content += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount || 0,
        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
      } : undefined,
    };
  }
}


export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: ModelConfig) {

    const raw = config.baseUrl || 'http://127.0.0.1:11434';
    const url = new URL(raw);
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    this.baseUrl = isLocal ? raw.replace(/\/$/, '') : 'http://127.0.0.1:11434';
    this.model = config.model;
  }

private formatMessages(messages: LLMMessage[]): any[] {
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {

        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        out.push({ role: 'tool', content, tool_call_id: sanitizeToolId(m.toolCallId || '') });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          tool_calls: m.toolCalls.map(tc => {

            let args: any = tc.function.arguments;
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { /* keep original string */ }
            }
            return {
              id: sanitizeToolId(tc.id),
              type: 'function',
              function: { name: tc.function.name, arguments: args },
            };
          }),
        });
      } else {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        out.push({ role: m.role, content });
      }
    }
    return out;
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);

    const body: Record<string, any> = {
      model: this.model,
      messages: this.formatMessages(messages),
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.3,
        num_predict: options?.maxTokens ?? 8192,
        num_ctx: 32768,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();

      if (response.status === 404) {
        throw new Error(`Ollama model "${this.model}" not found. Run: ollama pull ${this.model}`);
      }
      throw new Error(`Ollama request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;
    const result: LLMResponse = { content: data.message?.content || '' };

    if (data.message?.tool_calls?.length) {
      result.toolCalls = data.message.tool_calls.map((tc: any): LLMToolCall => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        function: {
          name: tc.function.name,

          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments || {}),
        },
      }));
    }


    if (!result.toolCalls?.length && result.content && tools && tools.length > 0) {
      const extracted = extractToolCallsFromContent(result.content, tools);
      if (extracted.length > 0) {
        result.toolCalls = extracted;
        result.content = '';
      }
    }

    return result;
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);

    const body: Record<string, any> = {
      model: this.model,
      messages: this.formatMessages(messages),
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.3,
        num_predict: options?.maxTokens ?? 8192,
        num_ctx: 32768,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
      }));
    }

        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama stream failed (${response.status}): ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for Ollama streaming');
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            const msg = parsed.message;
            if (msg?.content) yield { content: msg.content, done: false };
            if (msg?.tool_calls?.length) {
              yield {
                toolCalls: msg.tool_calls.map((tc: any): LLMToolCall => ({
                  id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                      ? tc.function.arguments
                      : JSON.stringify(tc.function.arguments || {}),
                  },
                })),
                done: false,
              };
            }
            if (parsed.done) { yield { done: true }; return; }
          } catch {  }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield { done: true };
  }
}


const CHAT_COMPLETIONS_ONLY = new Set([

  'claude-opus-4', 'claude-sonnet-4', 'claude-sonnet-3.5',
  'claude-haiku-3.5', 'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku',
]);


const COPILOT_MODEL_FALLBACK: string[] = [
  'gpt-4.1',
  'gpt-4o',
  'claude-sonnet-4',
  'gpt-4o-mini',
];


const _copilotUnsupportedModels = new Set<string>();


const _copilotResponsesUnsupported = new Set<string>();

function normalizeCopilotModel(model: string): string {


  return model.replace(/-\d{8}$/, '');
}

export class CopilotProvider implements LLMProvider {
  private model: string;
  private oauthProvider: string;
  private copilotToken: string | null = null;
  private copilotTokenExpiresAt = 0;
  private _temperatureUnsupported = false;


  private _lastResponseId: string | null = null;
  private _lastResponseMsgCount = 0;
  private _chainingUnsupported = false;
  private _lastSentToolNames = new Set<string>();

  constructor(config: ModelConfig) {
    this.model = normalizeCopilotModel(config.model || 'gpt-4o');
    this.oauthProvider = 'github';
  }

  private needsResponsesAPI(): boolean {


    if (this._responsesApiFailed) return false;
    if (CHAT_COMPLETIONS_ONLY.has(this.model)) return false;

    if (this.model.includes('claude')) return false;

    if (_copilotResponsesUnsupported.has(this.model)) return false;
    return true;
  }

  private getEffectiveModel(_hasTools: boolean): string {
    return this.model;
  }


  private _responsesApiFailed = false;


  private static readonly MAX_PAYLOAD_BYTES = 200 * 1024;


  private static readonly MAX_INPUT_ITEMS = 200;

  private static readonly RETRYABLE_5XX = new Set([500, 502, 503, 504]);

private trimMessagesForPayload(messages: LLMMessage[]): LLMMessage[] {
    const TRIM_LIMIT = 400;
    const KEEP_RECENT = 3;
    let toolIdx = 0;
    const totalToolMsgs = messages.filter(m => m.role === 'tool').length;
    return messages.map(m => {
      if (m.role === 'tool') {
        toolIdx++;
        const isRecent = toolIdx > totalToolMsgs - KEEP_RECENT;
        if (!isRecent && m.content && m.content.length > TRIM_LIMIT) {
          const head = m.content.slice(0, Math.floor(TRIM_LIMIT * 0.5));
          const tail = m.content.slice(-Math.floor(TRIM_LIMIT * 0.4));
          return { ...m, content: head + '\n...[trimmed]...\n' + tail };
        }
      }
      return m;
    });
  }

private trimInputForPayload(input: any[], aggressive = false): any[] {
    const TRIM_LIMIT = aggressive ? 120 : 400;
    const KEEP_RECENT = aggressive ? 1 : 3;
    let outputIdx = 0;
    const totalOutputs = input.filter((item: any) => item.type === 'function_call_output').length;
    return input.map((item: any) => {
      if (item.type === 'function_call_output') {
        outputIdx++;
        const isRecent = outputIdx > totalOutputs - KEEP_RECENT;
        if (!isRecent && item.output && item.output.length > TRIM_LIMIT) {
          const head = item.output.slice(0, Math.floor(TRIM_LIMIT * 0.5));
          const tail = item.output.slice(-Math.floor(TRIM_LIMIT * 0.4));
          return { ...item, output: head + '\n...[trimmed]...\n' + tail };
        }
      }
      return item;
    });
  }

private truncateInput(input: any[], keepLast = 12): any[] {

    const head: any[] = [];
    let startIdx = 0;
    for (let i = 0; i < input.length; i++) {
      if (input[i].role === 'developer' || input[i].role === 'system') {
        head.push(input[i]);
        startIdx = i + 1;
      } else break;
    }
    const rest = input.slice(startIdx);
    if (rest.length <= keepLast) return input;
    let kept = rest.slice(-keepLast);

    while (kept.length > 0 && kept[0].type === 'function_call_output') kept.shift();

    const keptCallIds = new Set(kept.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id));
    kept = kept.filter((item: any) => {
      if (item.type === 'function_call_output' && !keptCallIds.has(item.call_id)) return false;
      return true;
    });
    const summary = { role: 'user', content: `[Context trimmed: ${rest.length - kept.length} older items removed to fit context window]` };
    return [...head, summary, ...kept];
  }

private compactParamSchema(schema: Record<string, any>): Record<string, any> {
    if (!schema || typeof schema !== 'object') return schema;
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'description' && typeof value === 'string' && value.length > 80) {
        result[key] = value.slice(0, 77) + '...';
      } else if (key === 'enum' && Array.isArray(value) && value.length > 8) {
        result[key] = value.slice(0, 8);
      } else if (key === 'examples' || key === 'example') {

      } else if (key === 'properties' && typeof value === 'object') {
        const props: Record<string, any> = {};
        for (const [pName, pVal] of Object.entries(value)) {
          props[pName] = this.compactParamSchema(pVal as Record<string, any>);
        }
        result[key] = props;
      } else if (key === 'items' && typeof value === 'object') {
        result[key] = this.compactParamSchema(value as Record<string, any>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

private pruneToolsForPayload(body: Record<string, any>, level: 1 | 2 = 1): void {
    if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) return;
    const originalSize = JSON.stringify(body.tools).length;


    const essentialNames = new Set([
      'project_write', 'project_read', 'project_list', 'project_str_replace',
      'project_run', 'project_execute', 'project_serve', 'project_mkdir', 'project_start',
    ]);

    if (level >= 2) {

      const usedNames = new Set<string>();
      for (const item of body.input || []) {
        if (item.type === 'function_call' && item.name) usedNames.add(item.name);
      }
      if (usedNames.size > 0) {
        body.tools = body.tools.filter((t: any) =>
          usedNames.has(t.name) || essentialNames.has(t.name)
        );
      }
    }


    for (const t of body.tools) {
      if (essentialNames.has(t.name)) {

        if (level >= 2 && t.parameters?.properties) {
          for (const prop of Object.values(t.parameters.properties) as any[]) {
            delete prop.description;
          }
        }
        continue;
      }
      if (t.description && t.description.length > 60) {
        t.description = t.description.slice(0, 57) + '...';
      }

      if (level >= 2 && t.parameters?.properties) {
        for (const prop of Object.values(t.parameters.properties) as any[]) {
          delete prop.description;
        }
      }
    }

    const newSize = JSON.stringify(body.tools).length;
    if (newSize < originalSize) {
      console.warn(`[Copilot/Responses] Pruned tools L${level}: ${(originalSize / 1024).toFixed(1)}KB → ${(newSize / 1024).toFixed(1)}KB (${body.tools.length} tools)`);
    }
  }

private async getCopilotToken(): Promise<string> {

    if (this.copilotToken && Date.now() < this.copilotTokenExpiresAt - 2 * 60 * 1000) {
      return this.copilotToken;
    }

    const manager = getOAuthManager();
    if (!manager) throw new Error('OAuthManager not initialized. Connect GitHub via Settings -> OAuth.');
    const githubToken = await manager.getToken(this.oauthProvider);
    if (!githubToken) throw new Error('No GitHub OAuth token. Connect GitHub via Settings -> OAuth.');


        const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        'Authorization': `token ${githubToken}`,
        'Accept': 'application/json',
        'User-Agent': 'GithubCopilot/1.0',
      },
    });

    if (!response.ok) {
      const errBody = await response.text();
      if (response.status === 401) {
        throw new Error('GitHub token expired or invalid. Please re-authenticate via Settings → OAuth.');
      }
      if (response.status === 403) {
        throw new Error('No active GitHub Copilot subscription. Visit https://github.com/features/copilot to subscribe.');
      }
      throw new Error(`Copilot token exchange failed (${response.status}): ${errBody}`);
    }

    const data = await response.json() as any;
    this.copilotToken = data.token;
    this.copilotTokenExpiresAt = data.expires_at * 1000;
    return this.copilotToken!;
  }

private static isModelNotSupported(err: any): boolean {
    const msg = String(err?.message || err || '');
    return msg.includes('model_not_supported') || msg.includes('The requested model is not supported');
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    try {
      return await this._chatInternal(messages, tools, options);
    } catch (err: any) {
      if (!CopilotProvider.isModelNotSupported(err)) throw err;

      _copilotUnsupportedModels.add(this.model);
      const originalModel = this.model;
      for (const fallback of COPILOT_MODEL_FALLBACK) {
        if (fallback === originalModel || _copilotUnsupportedModels.has(fallback)) continue;
        console.warn(`[Copilot] Model "${originalModel}" not supported — trying fallback: ${fallback}`);
        this.model = fallback;
        this._responsesApiFailed = false;
        try {
          const result = await this._chatInternal(messages, tools, options);
          console.log(`[Copilot] Fallback to "${fallback}" succeeded — using this model going forward`);
          return result;
        } catch (fbErr: any) {
          if (CopilotProvider.isModelNotSupported(fbErr)) {
            _copilotUnsupportedModels.add(fallback);
            continue;
          }
          throw fbErr;
        }
      }

      this.model = originalModel;
      throw err;
    }
  }

  private async _chatInternal(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    const token = await this.getCopilotToken();
    const hasTools = !!(tools && tools.length > 0);
    const effectiveModel = this.getEffectiveModel(hasTools);

    if (this.needsResponsesAPI() && !this._responsesApiFailed) {
      try {
        return await this.chatViaResponses(token, messages, tools, options);
      } catch (err: any) {

        if (CopilotProvider.isModelNotSupported(err)) throw err;

        console.warn(`[Copilot] Responses API failed for ${this.model}, falling back to chat/completions: ${err.message}`);
        this._responsesApiFailed = true;
        _copilotResponsesUnsupported.add(this.model);

      }
    }

    const copilotHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Editor-Version': 'vscode/1.96.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Openai-Organization': 'github-copilot',
      'Openai-Intent': 'conversation-panel',
    };

    let formattedMessages = messages.map(m => formatOpenAIMessage(m));


    const toolsSize = tools && tools.length > 0 ? JSON.stringify(tools).length : 0;
    const msgsSize = JSON.stringify(formattedMessages).length;
    if (msgsSize + toolsSize > this.getPayloadBudget()) {
      console.warn(`[Copilot] Total payload too large (msgs=${(msgsSize / 1024).toFixed(0)}KB + tools=${(toolsSize / 1024).toFixed(0)}KB) — trimming old tool results`);
      formattedMessages = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
    }


    const doCall = async (toolChoice: string): Promise<any> => {
      const body: Record<string, any> = {
        model: effectiveModel,
        messages: formattedMessages,
        max_tokens: options?.maxTokens ?? 8192,
      };

      const skipTemp = this.model.startsWith('o') || this.model.includes('claude') || this._temperatureUnsupported;
      if (!skipTemp) {
        body.temperature = options?.temperature ?? 0.7;
      }
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = toolChoice;
      }
      const bodyJson = JSON.stringify(body);
      const bodySize = Buffer.byteLength(bodyJson, 'utf8');
      console.log(`[Copilot] chat request: model=${effectiveModel}, messages=${messages.length}, tools=${tools?.length || 0}, tool_choice=${toolChoice}, bodySize=${(bodySize / 1024).toFixed(1)}KB`);

            const resp = await fetch('https://api.githubcopilot.com/chat/completions', {
                method: 'POST',
        headers: copilotHeaders,
        body: bodyJson,
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        console.error(`[Copilot] ERROR ${resp.status}: ${errBody.slice(0, 2000)}`);

        if (resp.status === 400 && errBody.includes('Unsupported parameter')) {
          const paramMatch = errBody.match(/Unsupported parameter:\s*'(\w+)'/);
          if (paramMatch) {
            const badParam = paramMatch[1];
            console.warn(`[Copilot] Model ${effectiveModel} rejects '${badParam}' — retrying without it`);
            if (badParam === 'temperature') this._temperatureUnsupported = true;
            delete body[badParam];
                        const retryResp = await fetch('https://api.githubcopilot.com/chat/completions', {
                            method: 'POST',
              headers: copilotHeaders,
              body: JSON.stringify(body),
            });
            if (retryResp.ok) return retryResp.json();
            const retryErr = await retryResp.text();
            throw new Error(`Copilot LLM request failed (${retryResp.status}): ${retryErr}`);
          }
        }

        if (CopilotProvider.RETRYABLE_5XX.has(resp.status)) {

          console.warn(`[Copilot] ${resp.status} server error — L1 trim + retry in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          body.messages = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
                    const retry1 = await fetch('https://api.githubcopilot.com/chat/completions', {
                        method: 'POST',
            headers: copilotHeaders,
            body: JSON.stringify(body),
          });
          if (retry1.ok) return retry1.json();

          console.warn(`[Copilot] L1 retry failed (${retry1.status}) — L2 aggressive trim + drop old messages in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          const trimmedMsgs = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
          const system = trimmedMsgs[0];
          const recent = trimmedMsgs.slice(-11);
          body.messages = [system, { role: 'user', content: '[Context trimmed to fit limits. Continue from current state.]' }, ...recent];
                    const retry2 = await fetch('https://api.githubcopilot.com/chat/completions', {
                        method: 'POST',
            headers: copilotHeaders,
            body: JSON.stringify(body),
          });
          if (retry2.ok) return retry2.json();
          const retryErr = await retry2.text();
          console.error(`[Copilot] 5xx L2 retry also failed (${retry2.status}): ${retryErr.slice(0, 2000)}`);
          throw new Error(`Copilot LLM request failed (${retry2.status}): ${retryErr}`);
        }
        if (resp.status === 401 || resp.status === 403) {
          this.copilotToken = null;
          this.copilotTokenExpiresAt = 0;
        }
        throw new Error(`Copilot LLM request failed (${resp.status}): ${errBody}`);
      }

      return resp.json();
    };


    let rawJson = await doCall('auto');
    let choice0 = rawJson.choices?.[0];
    let msg0 = choice0?.message;
    console.log(`[Copilot] response: model=${effectiveModel}, content=${(msg0?.content || '').slice(0, 80)}, tool_calls=${msg0?.tool_calls?.length || 0}, finish_reason=${choice0?.finish_reason || 'N/A'}`);


    const isBrokenToolCall = (c: any, m: any) => {
      const fr = c?.finish_reason;
      const present = m?.tool_calls && m.tool_calls.length > 0;
      return (fr === 'tool_calls' || fr === 'tool_use') && !present;
    };

    if (isBrokenToolCall(choice0, msg0) && hasTools) {
      console.warn(`[Copilot] ${effectiveModel} returned broken tool_calls (empty array). Retrying with tool_choice=required...`);


      try {
        rawJson = await doCall('required');
        choice0 = rawJson.choices?.[0];
        msg0 = choice0?.message;
        console.log(`[Copilot] retry response: model=${effectiveModel}, content=${(msg0?.content || '').slice(0, 80)}, tool_calls=${msg0?.tool_calls?.length || 0}, finish_reason=${choice0?.finish_reason || 'N/A'}`);
      } catch (retryErr: any) {
        console.warn(`[Copilot] retry with tool_choice=required failed: ${retryErr.message}`);
      }


      if (isBrokenToolCall(choice0, msg0) || !(msg0?.tool_calls?.length > 0)) {
        const contentText = msg0?.content || '';
        const extracted = extractToolCallsFromContent(contentText, tools || []);
        if (extracted.length > 0) {
          console.log(`[Copilot] Extracted ${extracted.length} tool call(s) from content text`);
          return {
            content: '',
            toolCalls: extracted,
            usage: rawJson.usage ? { promptTokens: rawJson.usage.prompt_tokens, completionTokens: rawJson.usage.completion_tokens } : undefined,
          };
        }

        console.warn(`[Copilot] ${effectiveModel} tool_calls broken after retry — returning content-only`);
        return { content: contentText, usage: rawJson.usage ? { promptTokens: rawJson.usage.prompt_tokens, completionTokens: rawJson.usage.completion_tokens } : undefined };
      }
    }

    const parsed = parseOpenAIResponse(rawJson);
    return parsed;
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    try {
      yield* this._streamInternal(messages, tools, options);
      return;
    } catch (err: any) {
      if (!CopilotProvider.isModelNotSupported(err)) throw err;

      _copilotUnsupportedModels.add(this.model);
      const originalModel = this.model;
      for (const fallback of COPILOT_MODEL_FALLBACK) {
        if (fallback === originalModel || _copilotUnsupportedModels.has(fallback)) continue;
        console.warn(`[Copilot] Stream: model "${originalModel}" not supported — trying fallback: ${fallback}`);
        this.model = fallback;
        this._responsesApiFailed = false;
        try {
          yield* this._streamInternal(messages, tools, options);
          console.log(`[Copilot] Stream fallback to "${fallback}" succeeded`);
          return;
        } catch (fbErr: any) {
          if (CopilotProvider.isModelNotSupported(fbErr)) {
            _copilotUnsupportedModels.add(fallback);
            continue;
          }
          throw fbErr;
        }
      }
      this.model = originalModel;
      throw err;
    }
  }

  private async *_streamInternal(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    const token = await this.getCopilotToken();
    const hasTools = !!(tools && tools.length > 0);
    const effectiveModel = this.getEffectiveModel(hasTools);

    if (this.needsResponsesAPI() && !this._responsesApiFailed) {
      try {
        yield* this.streamViaResponses(token, messages, tools, options);
        return;
      } catch (err: any) {
        if (CopilotProvider.isModelNotSupported(err)) throw err;
        console.warn(`[Copilot] Responses API stream failed for ${this.model}, falling back to chat/completions: ${err.message}`);
        this._responsesApiFailed = true;
        _copilotResponsesUnsupported.add(this.model);

      }
    }

    let streamMessages = messages.map(m => formatOpenAIMessage(m));


    const toolsSize = tools && tools.length > 0 ? JSON.stringify(tools).length : 0;
    const msgsSize = JSON.stringify(streamMessages).length;
    if (msgsSize + toolsSize > this.getPayloadBudget()) {
      console.warn(`[Copilot] Stream payload too large (msgs=${(msgsSize / 1024).toFixed(0)}KB + tools=${(toolsSize / 1024).toFixed(0)}KB) — trimming old tool results`);
      streamMessages = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
    }

    const body: Record<string, any> = {
      model: effectiveModel,
      messages: streamMessages,
      max_tokens: options?.maxTokens ?? 8192,
      stream: true,
    };

    const skipTemp = this.model.startsWith('o') || this.model.includes('claude') || this._temperatureUnsupported;
    if (!skipTemp) {
      body.temperature = options?.temperature ?? 0.7;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const bodyJson = JSON.stringify(body);
    console.log(`[Copilot] stream request: model=${effectiveModel}, messages=${messages.length}, tools=${tools?.length || 0}, bodySize=${(Buffer.byteLength(bodyJson, 'utf8') / 1024).toFixed(1)}KB`);

        const response = await fetch('https://api.githubcopilot.com/chat/completions', {
            method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Editor-Version': 'vscode/1.96.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'Openai-Organization': 'github-copilot',
        'Openai-Intent': 'conversation-panel',
      },
      body: bodyJson,
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Copilot] STREAM ERROR ${response.status}: ${errBody.slice(0, 500)}`);
      if (response.status === 400 && errBody.includes('Unsupported parameter')) {
        const paramMatch = errBody.match(/Unsupported parameter:\s*'(\w+)'/);
        if (paramMatch) {
          const badParam = paramMatch[1];
          console.warn(`[Copilot] stream: Model ${effectiveModel} rejects '${badParam}' — marking and retrying`);
          if (badParam === 'temperature') this._temperatureUnsupported = true;
          delete body[badParam];
                    const retryResp = await fetch('https://api.githubcopilot.com/chat/completions', {
                        method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              'Editor-Version': 'vscode/1.96.0',
              'Copilot-Integration-Id': 'vscode-chat',
              'Openai-Organization': 'github-copilot',
              'Openai-Intent': 'conversation-panel',
            },
            body: JSON.stringify(body),
          });
          if (retryResp.ok) {
            yield* streamOpenAIResponse(retryResp);
            return;
          }
        }
      }

      if (CopilotProvider.RETRYABLE_5XX.has(response.status)) {
        const streamHeaders = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Editor-Version': 'vscode/1.96.0',
          'Copilot-Integration-Id': 'vscode-chat',
          'Openai-Organization': 'github-copilot',
          'Openai-Intent': 'conversation-panel',
        };

        console.warn(`[Copilot] stream ${response.status} server error — L1 trim + retry in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        body.messages = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
                const retry1 = await fetch('https://api.githubcopilot.com/chat/completions', {
                    method: 'POST',
          headers: streamHeaders,
          body: JSON.stringify(body),
        });
        if (retry1.ok) {
          yield* streamOpenAIResponse(retry1);
          return;
        }

        console.warn(`[Copilot] stream L1 retry failed (${retry1.status}) — L2 aggressive trim in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        const trimmedMsgs = this.trimMessagesForPayload(messages).map(m => formatOpenAIMessage(m));
        const system = trimmedMsgs[0];
        const recent = trimmedMsgs.slice(-11);
        body.messages = [system, { role: 'user', content: '[Context trimmed to fit limits.]' }, ...recent];
                const retry2 = await fetch('https://api.githubcopilot.com/chat/completions', {
                    method: 'POST',
          headers: streamHeaders,
          body: JSON.stringify(body),
        });
        if (retry2.ok) {
          yield* streamOpenAIResponse(retry2);
          return;
        }
        const retryErr = await retry2.text();
        console.error(`[Copilot] stream 5xx L2 retry also failed (${retry2.status}): ${retryErr.slice(0, 300)}`);
        throw new Error(`Copilot LLM stream failed (${retry2.status}): ${retryErr}`);
      }
      if (response.status === 401 || response.status === 403) {
        this.copilotToken = null;
        this.copilotTokenExpiresAt = 0;
      }
      throw new Error(`Copilot LLM stream failed (${response.status}): ${errBody}`);
    }

    yield* streamOpenAIResponse(response);
  }


  private copilotHeaders(token: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Editor-Version': 'vscode/1.96.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Openai-Organization': 'github-copilot',
      'Openai-Intent': 'conversation-panel',
    };
  }

private buildResponsesBody(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
    stream = false,
  ): Record<string, any> {
    messages = messages.filter(m => m && m.role);
    const input: any[] = [];

    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
    const idMap = new Map<string, string>();
    let idCounter = 0;
    const shortId = (original: string): string => {
      if (!original) return `fc_${idCounter++}`;
      if (idMap.has(original)) return idMap.get(original)!;
      const clean = sanitize(original);

      const prefixed = clean.startsWith('fc') ? clean : `fc_${clean}`;
      if (prefixed.length <= 64) { idMap.set(original, prefixed); return prefixed; }
      const short = `fc_${idCounter++}_${clean.slice(0, 52)}`;
      idMap.set(original, short);
      return short;
    };

    for (const msg of messages) {
      if (msg.role === 'system') {

        input.push({ role: 'developer', content: msg.content });
      } else if (msg.role === 'tool') {

        input.push({
          type: 'function_call_output',
          call_id: shortId(msg.toolCallId || ''),
          output: msg.content,
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {

        if (msg.content) {
          input.push({ role: 'assistant', content: msg.content });
        }
        for (const tc of msg.toolCalls) {
          const cid = shortId(tc.id);
          input.push({
            type: 'function_call',
            call_id: cid,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else if (msg.role === 'user' && msg.image) {

        const mimeMatch = msg.image.match(/^data:(image\/[^;]+);base64,/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const base64 = msg.image.replace(/^data:image\/[^;]+;base64,/, '');
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: msg.content || '' },
            { type: 'input_image', image_url: `data:${mime};base64,${base64}` },
          ],
        });
      } else {
        input.push({ role: msg.role, content: msg.content });
      }
    }


    const knownCallIds = new Set(
      input.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id)
    );
    const repairedInput = input.filter((item: any) => {
      if (item.type === 'function_call_output' && !knownCallIds.has(item.call_id)) {
        return false;
      }
      return true;
    });

    const body: Record<string, any> = {
      model: this.model,
      input: repairedInput,
    };


    body.max_output_tokens = options?.maxTokens ?? 8192;

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => {
        const params = t.function.parameters;


        let compactParams = params;
        if (params && typeof params === 'object') {
          compactParams = this.compactParamSchema(params);
        }
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description,
          parameters: compactParams,
        };
      });
    }

    if (stream) body.stream = true;

    return body;
  }

private sanitizeResponsesBody(body: Record<string, any>): void {
    const KNOWN_FIELDS = new Set([
      'model', 'input', 'tools', 'stream', 'max_output_tokens',
      'temperature', 'top_p', 'tool_choice', 'previous_response_id',
      'truncation', 'instructions',
    ]);
    for (const key of Object.keys(body)) {
      if (!KNOWN_FIELDS.has(key)) {
        console.warn(`[Copilot/Responses] Stripping unknown body field '${key}' before retry`);
        delete body[key];
      }
    }
  }

private getPayloadBudget(): number {

    const m = this.model.toLowerCase();
    let contextTokens = 128_000;
    if (m.includes('claude') || m.includes('gemini')) contextTokens = 200_000;
    else if (m.includes('gpt-3.5') || m.includes('mixtral')) contextTokens = 32_000;

    const tokenBudget = Math.floor(contextTokens * 0.8);
    const byteBudget = tokenBudget * 4;

    return Math.min(Math.max(byteBudget, CopilotProvider.MAX_PAYLOAD_BYTES), 800 * 1024);
  }

  private async chatViaResponses(
    token: string,
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
  ): Promise<LLMResponse> {


    let body: Record<string, any>;
    const fullBody = this.buildResponsesBody(messages, tools, options);

    if (!this._chainingUnsupported && this._lastResponseId && this._lastResponseMsgCount > 0 && messages.length > this._lastResponseMsgCount) {

      const newMessages = messages.slice(this._lastResponseMsgCount);
      const deltaBody = this.buildResponsesBody(newMessages, tools, options);
      deltaBody.previous_response_id = this._lastResponseId;


      const curToolNames = new Set((tools || []).map(t => t.function.name));
      const toolsChanged = this._lastSentToolNames.size !== curToolNames.size ||
        [...curToolNames].some(n => !this._lastSentToolNames.has(n)) ||
        [...this._lastSentToolNames].some(n => !curToolNames.has(n));
      if (!toolsChanged) {
        delete deltaBody.tools;
      } else {
        console.log(`[Copilot/Responses] Tool set changed — resending tools with chained request`);
      }
      body = deltaBody;
      console.log(`[Copilot/Responses] Using previous_response_id chaining: ${messages.length - this._lastResponseMsgCount} new messages (saved ${this._lastResponseMsgCount} from history)`);
    } else {
      body = fullBody;
    }

    this._lastSentToolNames = new Set((tools || []).map(t => t.function.name));


    if (body.input.length > CopilotProvider.MAX_INPUT_ITEMS) {
      console.warn(`[Copilot/Responses] Input items ${body.input.length} > ${CopilotProvider.MAX_INPUT_ITEMS} — truncating`);
      body.input = this.truncateInput(body.input, CopilotProvider.MAX_INPUT_ITEMS);
    }


    const payloadBudget = this.getPayloadBudget();
    let estimatedSize = JSON.stringify(body).length;
    if (estimatedSize > payloadBudget) {
      console.warn(`[Copilot/Responses] Body too large (${(estimatedSize / 1024).toFixed(0)}KB > ${(payloadBudget / 1024).toFixed(0)}KB budget) — trimming old function outputs`);
      body.input = this.trimInputForPayload(body.input);
      let recheck = JSON.stringify(body).length;

      if (recheck > payloadBudget) {
        this.pruneToolsForPayload(body, 1);
        recheck = JSON.stringify(body).length;
      }

      if (recheck > payloadBudget) {
        console.warn(`[Copilot/Responses] Still too large after L1 trim (${(recheck / 1024).toFixed(0)}KB) — aggressive trim`);
        body.input = this.trimInputForPayload(body.input, true);
        this.pruneToolsForPayload(body, 2);
        for (let keep = 16; keep >= 4; keep -= 4) {
          body.input = this.truncateInput(body.input, keep);
          recheck = JSON.stringify(body).length;
          if (recheck <= payloadBudget) break;
          console.warn(`[Copilot/Responses] Still ${(recheck / 1024).toFixed(0)}KB after truncate(${keep}) — reducing further`);
        }
      }
    }


    const bodyJson = JSON.stringify(body);
    const bodySize = Buffer.byteLength(bodyJson, 'utf8');
    console.log(`[Copilot/Responses] chat request: model=${this.model}, input=${body.input.length}, tools=${tools?.length || 0}, bodySize=${(bodySize / 1024).toFixed(1)}KB${body.previous_response_id ? ', chained' : ''}`);

        let response = await fetch('https://api.githubcopilot.com/responses', {
            method: 'POST',
      headers: this.copilotHeaders(token),
      body: bodyJson,
    });


    if (!response.ok && body.previous_response_id) {
      const errText = await response.text();
      console.warn(`[Copilot/Responses] Chained request failed (${response.status}): ${errText.slice(0, 200)} — falling back to full body`);
      this._lastResponseId = null;
      this._lastResponseMsgCount = 0;

      if (errText.includes('previous_response_id is not supported') || errText.includes('unsupported_value')) {
        this._chainingUnsupported = true;
        console.warn(`[Copilot/Responses] previous_response_id not supported — disabling chaining permanently`);
      }

      const fallbackBody = fullBody;
      if (fallbackBody.input.length > CopilotProvider.MAX_INPUT_ITEMS) {
        fallbackBody.input = this.truncateInput(fallbackBody.input, CopilotProvider.MAX_INPUT_ITEMS);
      }
      let fbSize = JSON.stringify(fallbackBody).length;
      const fallbackBudget = this.getPayloadBudget();
      if (fbSize > fallbackBudget) {
        fallbackBody.input = this.trimInputForPayload(fallbackBody.input);
        this.pruneToolsForPayload(fallbackBody, 1);
        fbSize = JSON.stringify(fallbackBody).length;
        if (fbSize > fallbackBudget) {
          fallbackBody.input = this.trimInputForPayload(fallbackBody.input, true);
          this.pruneToolsForPayload(fallbackBody, 2);
          for (let keep = 16; keep >= 4; keep -= 4) {
            fallbackBody.input = this.truncateInput(fallbackBody.input, keep);
            fbSize = JSON.stringify(fallbackBody).length;
            if (fbSize <= fallbackBudget) break;
          }
        }
      }
      console.log(`[Copilot/Responses] Fallback: full body with ${fallbackBody.input.length} input items`);
            response = await fetch('https://api.githubcopilot.com/responses', {
                method: 'POST',
        headers: this.copilotHeaders(token),
        body: JSON.stringify(fallbackBody),
      });
      Object.assign(body, fallbackBody);
      delete body.previous_response_id;
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Copilot/Responses] ERROR ${response.status}: ${errBody.slice(0, 2000)}`);

      if (response.status === 400 && errBody.includes('Unsupported parameter')) {

        const paramMatch = errBody.match(/Unsupported parameter:\s*'(\w+)'/);
        if (paramMatch) {
          const badParam = paramMatch[1];
          console.warn(`[Copilot/Responses] Model ${this.model} rejects '${badParam}' — retrying without it`);
          if (badParam === 'temperature') this._temperatureUnsupported = true;
          delete body[badParam];
                    const retryResp = await fetch('https://api.githubcopilot.com/responses', {
                        method: 'POST',
            headers: this.copilotHeaders(token),
            body: JSON.stringify(body),
          });
          if (retryResp.ok) {
            const retryData = await retryResp.json() as any;
            return this.parseResponsesResult(retryData);
          }
          const retryErr = await retryResp.text();
          throw new Error(`Copilot Responses API failed (${retryResp.status}): ${retryErr}`);
        }
      }
      if (response.status === 401 || response.status === 403) {
        this.copilotToken = null;
        this.copilotTokenExpiresAt = 0;
      }

      if (CopilotProvider.RETRYABLE_5XX.has(response.status)) {

        this.sanitizeResponsesBody(body);

        console.warn(`[Copilot/Responses] ${response.status} server error — L1 sanitize + trim + tool prune + retry in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        body.input = this.trimInputForPayload(body.input);
        this.pruneToolsForPayload(body, 1);
                const retry1 = await fetch('https://api.githubcopilot.com/responses', {
                    method: 'POST',
          headers: this.copilotHeaders(token),
          body: JSON.stringify(body),
        });
        if (retry1.ok) {
          const retryData = await retry1.json() as any;
          return this.parseResponsesResult(retryData);
        }

        console.warn(`[Copilot/Responses] L1 retry failed (${retry1.status}) — L2 aggressive trim + prune tools + truncate + retry in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        body.input = this.trimInputForPayload(body.input, true);
        this.pruneToolsForPayload(body, 2);

        for (let keep = 16; keep >= 4; keep -= 4) {
          body.input = this.truncateInput(body.input, keep);
          const l2size = JSON.stringify(body).length;
          if (l2size <= this.getPayloadBudget()) break;
          console.warn(`[Copilot/Responses] L2 still ${(l2size / 1024).toFixed(0)}KB after truncate(${keep}) — reducing further`);
        }
                const retry2 = await fetch('https://api.githubcopilot.com/responses', {
                    method: 'POST',
          headers: this.copilotHeaders(token),
          body: JSON.stringify(body),
        });
        if (retry2.ok) {
          const retryData = await retry2.json() as any;
          return this.parseResponsesResult(retryData);
        }
        const retryErr = await retry2.text();
        console.error(`[Copilot/Responses] 5xx L2 retry also failed (${retry2.status}): ${retryErr.slice(0, 2000)}`);
        throw new Error(`Copilot Responses API failed (${retry2.status}): ${retryErr}`);
      }
      throw new Error(`Copilot Responses API failed (${response.status}): ${errBody}`);
    }

    const data = await response.json() as any;
    const parsed = this.parseResponsesResult(data);


    if (data.id) {
      this._lastResponseId = data.id;
      this._lastResponseMsgCount = messages.length;
      console.log(`[Copilot/Responses] Stored response ID for chaining: ${data.id.slice(0, 20)}...`);
    }

    console.log(`[Copilot/Responses] response: content=${(parsed.content || '').slice(0, 100)}, toolCalls=${parsed.toolCalls?.length || 0}, outputItems=${data.output?.length || 0}, usage=${parsed.usage ? parsed.usage.promptTokens + '+' + parsed.usage.completionTokens : 'NONE'}`);
    return parsed;
  }

  private async *streamViaResponses(
    token: string,
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
  ): AsyncGenerator<LLMStreamChunk> {
    const body = this.buildResponsesBody(messages, tools, options, true);


    if (body.input.length > CopilotProvider.MAX_INPUT_ITEMS) {
      console.warn(`[Copilot/Responses] stream input items ${body.input.length} > ${CopilotProvider.MAX_INPUT_ITEMS} — truncating`);
      body.input = this.truncateInput(body.input, CopilotProvider.MAX_INPUT_ITEMS);
    }


    const streamBudget = this.getPayloadBudget();
    let estimatedSize = JSON.stringify(body).length;
    if (estimatedSize > streamBudget) {
      console.warn(`[Copilot/Responses] stream body too large (${(estimatedSize / 1024).toFixed(0)}KB > ${(streamBudget / 1024).toFixed(0)}KB budget) — trimming old function outputs`);
      body.input = this.trimInputForPayload(body.input);
      let recheck = JSON.stringify(body).length;
      if (recheck > streamBudget) {
        this.pruneToolsForPayload(body, 1);
        recheck = JSON.stringify(body).length;
      }
      if (recheck > streamBudget) {
        console.warn(`[Copilot/Responses] stream still too large after L1 (${(recheck / 1024).toFixed(0)}KB) — aggressive trim`);
        body.input = this.trimInputForPayload(body.input, true);
        this.pruneToolsForPayload(body, 2);
        for (let keep = 16; keep >= 4; keep -= 4) {
          body.input = this.truncateInput(body.input, keep);
          recheck = JSON.stringify(body).length;
          if (recheck <= streamBudget) break;
          console.warn(`[Copilot/Responses] stream still ${(recheck / 1024).toFixed(0)}KB after truncate(${keep}) — reducing further`);
        }
      }
    }

    const bodyJson = JSON.stringify(body);
    console.log(`[Copilot/Responses] stream request: model=${this.model}, input=${body.input.length}, tools=${tools?.length || 0}, bodySize=${(Buffer.byteLength(bodyJson, 'utf8') / 1024).toFixed(1)}KB`);

        let response = await fetch('https://api.githubcopilot.com/responses', {
            method: 'POST',
      headers: this.copilotHeaders(token),
      body: bodyJson,
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Copilot/Responses] STREAM ERROR ${response.status}: ${errBody.slice(0, 2000)}`);
      if (response.status === 400 && errBody.includes('Unsupported parameter')) {
        const paramMatch = errBody.match(/Unsupported parameter:\s*'(\w+)'/);
        if (paramMatch) {
          const badParam = paramMatch[1];
          console.warn(`[Copilot/Responses] stream: Model ${this.model} rejects '${badParam}' — marking and retrying`);
          if (badParam === 'temperature') this._temperatureUnsupported = true;
          delete body[badParam];
                    response = await fetch('https://api.githubcopilot.com/responses', {
                        method: 'POST',
            headers: this.copilotHeaders(token),
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const retryErr = await response.text();
            throw new Error(`Copilot Responses stream failed (${response.status}): ${retryErr}`);
          }

        } else {
          throw new Error(`Copilot Responses stream failed (${response.status}): ${errBody}`);
        }
      } else if (CopilotProvider.RETRYABLE_5XX.has(response.status)) {

        this.sanitizeResponsesBody(body);
        console.warn(`[Copilot/Responses] stream ${response.status} server error — L1 sanitize + trim + tool prune + retry in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        body.input = this.trimInputForPayload(body.input);
        this.pruneToolsForPayload(body, 1);
        body.stream = true;
                response = await fetch('https://api.githubcopilot.com/responses', {
                    method: 'POST',
          headers: this.copilotHeaders(token),
          body: JSON.stringify(body),
        });
        if (!response.ok) {

          console.warn(`[Copilot/Responses] stream L1 retry failed (${response.status}) — L2 aggressive trim + prune tools + retry in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          body.input = this.trimInputForPayload(body.input, true);
          this.pruneToolsForPayload(body, 2);
          for (let keep = 16; keep >= 4; keep -= 4) {
            body.input = this.truncateInput(body.input, keep);
            const l2size = JSON.stringify(body).length;
            if (l2size <= this.getPayloadBudget()) break;
            console.warn(`[Copilot/Responses] stream L2 still ${(l2size / 1024).toFixed(0)}KB after truncate(${keep}) — reducing further`);
          }
          body.stream = true;
                    response = await fetch('https://api.githubcopilot.com/responses', {
                        method: 'POST',
            headers: this.copilotHeaders(token),
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const retryErr = await response.text();
            console.error(`[Copilot/Responses] stream 5xx L2 retry also failed (${response.status}): ${retryErr.slice(0, 2000)}`);
            throw new Error(`Copilot Responses stream failed (${response.status}): ${retryErr}`);
          }
        }

      } else {
        if (response.status === 401 || response.status === 403) {
          this.copilotToken = null;
          this.copilotTokenExpiresAt = 0;
        }
        throw new Error(`Copilot Responses stream failed (${response.status}): ${errBody}`);
      }
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls = new Map<string, { id: string; name: string; args: string }>();
    let lastUsage: { promptTokens: number; completionTokens: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const sseData = trimmed.slice(6);
          if (sseData === '[DONE]') {
            if (toolCalls.size > 0) {
              yield {
                toolCalls: Array.from(toolCalls.values()).map(tc => ({
                  id: tc.id, function: { name: tc.name, arguments: tc.args },
                })),
                done: true,
                usage: lastUsage,
              };
            } else {
              yield { done: true, usage: lastUsage };
            }
            return;
          }
          try {
            const evt = JSON.parse(sseData);
            const type = evt.type;

            if (type === 'response.output_text.delta' && evt.delta) {
              yield { content: evt.delta, done: false };
            } else if (type === 'response.content_part.delta' && evt.delta?.text) {
              yield { content: evt.delta.text, done: false };
            } else if (type === 'response.function_call_arguments.delta') {
              const callId = evt.item_id || evt.call_id || '';
              if (!toolCalls.has(callId)) {
                toolCalls.set(callId, { id: callId, name: evt.name || '', args: '' });
              }
              const tc = toolCalls.get(callId)!;
              if (evt.name) tc.name = evt.name;
              tc.args += evt.delta || '';
            } else if (type === 'response.output_item.added' && evt.item?.type === 'function_call') {
              const item = evt.item;
              const sanitizedId = sanitizeToolId(item.id || item.call_id || '');
              toolCalls.set(item.id || item.call_id, {
                id: sanitizedId,
                name: item.name || '',
                args: item.arguments || '',
              });
            } else if (type === 'response.function_call_arguments.done') {
              const callId = evt.item_id || evt.call_id || '';
              if (toolCalls.has(callId)) {
                const tc = toolCalls.get(callId)!;
                if (evt.name) tc.name = evt.name;
                if (evt.arguments) tc.args = evt.arguments;
              }
            } else if (type === 'response.completed' && evt.response?.usage) {
              const u = evt.response.usage;
              lastUsage = {
                promptTokens: u.input_tokens || 0,
                completionTokens: u.output_tokens || 0,
              };
            }
          } catch {  }
        }
      }
    } finally {
      reader.releaseLock();
    }


    if (toolCalls.size > 0) {
      yield {
        toolCalls: Array.from(toolCalls.values()).map(tc => ({
          id: tc.id, function: { name: tc.name, arguments: tc.args },
        })),
        done: true,
        usage: lastUsage,
      };
    } else {
      yield { done: true, usage: lastUsage };
    }
  }

private parseResponsesResult(data: any): LLMResponse {
    let content = '';
    const toolCalls: LLMToolCall[] = [];

    for (const item of data.output || []) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text') content += part.text || '';
          else if (part.text) content += part.text;
        }
      } else if (item.type === 'function_call') {

        const fcId = sanitizeToolId(item.id || item.call_id || '');
        toolCalls.push({
          id: fcId,
          function: {
            name: item.name,
            arguments: item.arguments || '{}',
          },
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens || 0,
        completionTokens: data.usage.output_tokens || 0,
      } : undefined,
    };
  }
}


export class OAuthOpenAIProvider implements LLMProvider {
  private model: string;
  private baseUrl: string;
  private oauthProvider: string;

  constructor(config: ModelConfig & { oauthProvider: string }) {
    this.model = config.model;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.oauthProvider = config.oauthProvider;
  }

  private async getAuthToken(): Promise<string> {
    const manager = getOAuthManager();
    if (!manager) throw new Error(`OAuthManager not initialized. Run \`axiom auth ${this.oauthProvider}\` first.`);
    const token = await manager.getToken(this.oauthProvider);
    if (!token) throw new Error(`No OAuth token for ${this.oauthProvider}. Run \`axiom auth ${this.oauthProvider}\` to authenticate.`);
    return token;
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const token = await this.getAuthToken();
    const body: Record<string, any> = {
      model: this.model,
      messages: messages.map(m => formatOpenAIMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let response: Response | null = null;
    const MAX_RETRIES = 4;
    const BACKOFF_MS = [5000, 15000, 30000, 60000];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          const errBody = await response.text();
          throw new Error(`OAuth LLM request failed (429): ${errBody}`);
        }
        const retryAfter = response.headers.get('retry-after');
        let waitMs = BACKOFF_MS[attempt] || 60000;
        if (retryAfter) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfter) * 1000 + 500));
        console.warn(`[OAuth/${this.oauthProvider}] 429 — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const errBody = await response!.text();
      throw new Error(`OAuth LLM request failed (${response!.status}): ${errBody}`);
    }

    return parseOpenAIResponse(await response!.json());
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const token = await this.getAuthToken();
    const body: Record<string, any> = {
      model: this.model,
      messages: messages.map(m => formatOpenAIMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }


    let streamResp: Response | null = null;
    const S_MAX_RETRIES = 4;
    const S_BACKOFF = [5000, 15000, 30000, 60000];
    for (let attempt = 0; attempt <= S_MAX_RETRIES; attempt++) {
            streamResp = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (streamResp.status === 429) {
        if (attempt === S_MAX_RETRIES) {
          const errBody = await streamResp.text();
          throw new Error(`OAuth LLM stream failed (429): ${errBody}`);
        }
        const retryAfter = streamResp.headers.get('retry-after');
        let waitMs = S_BACKOFF[attempt] || 60000;
        if (retryAfter) waitMs = Math.max(waitMs, Math.min(90000, parseFloat(retryAfter) * 1000 + 500));
        console.warn(`[OAuth/${this.oauthProvider}] stream 429 — waiting ${(waitMs/1000).toFixed(1)}s (attempt ${attempt + 1}/${S_MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }

    if (!streamResp!.ok) {
      const errBody = await streamResp!.text();
      throw new Error(`OAuth LLM stream failed (${streamResp!.status}): ${errBody}`);
    }

    yield* streamOpenAIResponse(streamResp!);
  }
}


function extractToolCallsFromContent(content: string, tools: LLMTool[]): LLMToolCall[] {
  const validToolNames = new Set(tools.map(t => t.function.name));
  const extracted: LLMToolCall[] = [];


  const xmlPattern = /<tool_use>\s*<name>([^<]+)<\/name>\s*(?:<arguments>|<input>)([\s\S]*?)(?:<\/arguments>|<\/input>)\s*<\/tool_use>/gi;
  let match;
  while ((match = xmlPattern.exec(content)) !== null) {
    const name = match[1].trim();
    const args = match[2].trim();
    if (validToolNames.has(name)) {
      try {
        JSON.parse(args);
        extracted.push({
          id: `extracted_${Date.now()}_${extracted.length}`,
          function: { name, arguments: args },
        });
      } catch {  }
    }
  }
  if (extracted.length > 0) return extracted;


  for (const tool of tools) {
    const funcCallPattern = new RegExp(
      tool.function.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)',
      'g'
    );
    while ((match = funcCallPattern.exec(content)) !== null) {
      const args = match[1].trim();
      try {
        JSON.parse(args);
        extracted.push({
          id: `extracted_${Date.now()}_${extracted.length}`,
          function: { name: tool.function.name, arguments: args },
        });
      } catch {  }
    }
  }
  if (extracted.length > 0) return extracted;


  const jsonObjPattern = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((match = jsonObjPattern.exec(content)) !== null) {
    const name = match[1].trim();
    const args = match[2].trim();
    if (validToolNames.has(name)) {
      try {
        JSON.parse(args);
        extracted.push({
          id: `extracted_${Date.now()}_${extracted.length}`,
          function: { name, arguments: args },
        });
      } catch {  }
    }
  }

  return extracted;
}


const _toolIdCache = new Map<string, string>();
function sanitizeToolId(id: string): string {
  if (!id) return 'tc_' + Math.random().toString(36).slice(2, 10);

  const cached = _toolIdCache.get(id);
  if (cached) return cached;
  let clean = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean.length > 40) {

    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    clean = clean.slice(0, 32) + '_' + Math.abs(h).toString(36).slice(0, 7);
  }
  _toolIdCache.set(id, clean);
  return clean;
}

function formatOpenAIMessage(msg: LLMMessage): Record<string, any> {
  if (!msg || !msg.role) return { role: 'user', content: '' };
  const formatted: Record<string, any> = { role: msg.role };
  if (msg.image && msg.role === 'user') {
    const base64 = msg.image.replace(/^data:image\/[^;]+;base64,/, '');
    formatted.content = [
      { type: 'text', text: msg.content },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
    ];
  } else {
    formatted.content = msg.content;
  }
  if (msg.toolCallId) formatted.tool_call_id = sanitizeToolId(msg.toolCallId);
  if (msg.toolCalls) {
    formatted.tool_calls = msg.toolCalls.map(tc => ({
      id: sanitizeToolId(tc.id), type: 'function', function: tc.function,
    }));
  }
  return formatted;
}

function parseOpenAIResponse(data: any): LLMResponse {
  const choice = data.choices[0];
  const msg = choice.message;
  const result: LLMResponse = {
    content: msg.content || '',
    usage: data.usage ? {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
    } : undefined,
  };
  if (msg.tool_calls) {
    result.toolCalls = msg.tool_calls.map((tc: any): LLMToolCall => ({
      id: tc.id,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  return result;
}

async function* streamOpenAIResponse(response: Response): AsyncGenerator<LLMStreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body for streaming');
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const sseData = trimmed.slice(6);
        if (sseData === '[DONE]') {
          if (toolCallAccumulator.size > 0) {
            yield { toolCalls: Array.from(toolCallAccumulator.values()).map(tc => ({
              id: tc.id, function: { name: tc.name, arguments: tc.args },
            })), done: true };
          } else {
            yield { done: true };
          }
          return;
        }
        try {
          const parsed = JSON.parse(sseData);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) yield { content: delta.content, done: false };
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallAccumulator.has(idx)) toolCallAccumulator.set(idx, { id: tc.id || '', name: '', args: '' });
              const acc = toolCallAccumulator.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
        } catch {  }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (toolCallAccumulator.size > 0) {
    yield { toolCalls: Array.from(toolCallAccumulator.values()).map(tc => ({
      id: tc.id, function: { name: tc.name, arguments: tc.args },
    })), done: true };
  } else {
    yield { done: true };
  }
}


export function createLLMProvider(config: ModelConfig): LLMProvider {

  if (config.provider === 'copilot') {
    return new CopilotProvider(config);
  }


  if (config.provider === 'google-oauth') {
    return new OAuthOpenAIProvider({
      ...config,
      oauthProvider: 'google',
      baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
  }
  if (config.provider === 'azure-oauth') {
    return new OAuthOpenAIProvider({
      ...config,
      oauthProvider: 'azure',
    });
  }


  if (OPENAI_COMPATIBLE_PROVIDERS.has(config.provider)) {
    return new OpenAIProvider(config);
  }

  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'google':
      return new GoogleGeminiProvider(config);
    case 'google-vertex':
      return new VertexAIProvider(config);
    case 'azure':
      return new AzureOpenAIProvider(config);
    case 'amazon-bedrock':
      return new BedrockProvider(config);
    default:

      if (config.baseUrl) {
        return new OpenAIProvider(config);
      }
      throw new Error(`Unknown LLM provider: ${config.provider}. Set baseUrl for custom OpenAI-compatible endpoints.`);
  }
}
