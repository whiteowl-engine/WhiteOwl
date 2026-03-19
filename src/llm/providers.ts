import { LLMMessage, LLMTool, LLMResponse, LLMToolCall, LLMProvider, ModelConfig, LLMProviderName, LLMStreamChunk } from '../types';
import { OAuthManager } from '../core/oauth-manager';

// Singleton reference to the OAuthManager — set from runtime
let _oauthManager: OAuthManager | null = null;
export function setOAuthManager(manager: OAuthManager): void { _oauthManager = manager; }
export function getOAuthManager(): OAuthManager | null { return _oauthManager; }

// =====================================================
// Base URL registry for OpenAI-compatible providers
// =====================================================

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
  cursor: 'https://api.cursor.com/v1',
};

const OPENAI_COMPATIBLE_PROVIDERS = new Set<LLMProviderName>(
  Object.keys(OPENAI_COMPATIBLE_URLS) as LLMProviderName[]
);

// =====================================================
// OpenAI-compatible provider
// Handles: OpenAI, Groq, DeepSeek, OpenRouter, Mistral,
// xAI, Cerebras, Together, Fireworks, Perplexity,
// HuggingFace, GitHub Models, MiniMax, Moonshot,
// SambaNova, Hyperbolic, Cohere, Lepton, and any
// custom OpenAI-compatible endpoint via baseUrl
// =====================================================

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
    const body: Record<string, any> = {
      model: this.model,
      messages: messages.filter(m => m && m.role).map(m => this.formatMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 16384,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    // OpenRouter requires extra headers
    if (this.providerName === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/axiom-trading/axiom';
      headers['X-Title'] = 'AXIOM Trading Shell';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

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
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return result;
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    const body: Record<string, any> = {
      model: this.model,
      messages: messages.filter(m => m && m.role).map(m => this.formatMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM stream failed (${response.status}): ${errorBody}`);
    }

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
            // Skip malformed SSE chunks
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

    // Support image content blocks for vision models
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

// =====================================================
// Anthropic Claude provider
// =====================================================

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
      body.system = systemMsg.content;
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;

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

    if (systemMsg) body.system = systemMsg.content;

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic stream failed (${response.status}): ${errorBody}`);
    }

    const reader = response.body?.getReader();
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
            // Skip malformed SSE chunks
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
          tool_use_id: msg.toolCallId,
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
          id: tc.id,
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

// =====================================================
// Google Gemini provider (native REST API)
// =====================================================

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

    const contents = nonSystem.map(m => this.formatMessage(m));

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

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

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

// =====================================================
// Azure OpenAI provider
// =====================================================

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
    if (msg.toolCallId) formatted.tool_call_id = msg.toolCallId;
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

// =====================================================
// Amazon Bedrock provider (uses AWS Signature V4)
// Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// =====================================================

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

// =====================================================
// Google Vertex AI provider
// Uses API key auth for simplicity (also supports OAuth)
// =====================================================

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
    // Delegate to Gemini-style call via Vertex endpoint
    messages = messages.filter(m => m && m.role);
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const contents = nonSystem.map(m => {
      if (m.image && m.role === 'user') {
        return {
          role: 'user',
          parts: [
            { text: m.content },
            { inlineData: { mimeType: 'image/png', data: m.image.replace(/^data:image\/[^;]+;base64,/, '') } },
          ],
        };
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      };
    });

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

    const url = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:generateContent`;
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

// =====================================================
// Ollama local model provider
// =====================================================

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: ModelConfig) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model;
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const body: Record<string, any> = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content,
      })),
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as any;

    const result: LLMResponse = {
      content: data.message?.content || '',
    };

    if (data.message?.tool_calls) {
      result.toolCalls = data.message.tool_calls.map((tc: any): LLMToolCall => ({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }

    return result;
  }
}

// =====================================================
// GitHub Copilot provider (OAuth — free with Copilot subscription)
// Two-step auth: GitHub OAuth token → Copilot session token → Chat API
// Supports both /chat/completions and /responses endpoints
// =====================================================

// Models that require the Responses API (/responses) instead of /chat/completions
const RESPONSES_ONLY_MODELS = new Set([
  'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-codex',
  'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5-mini',
  'o4-mini', 'o3', 'o3-mini', 'o1', 'o1-mini', 'o1-preview',
]);

export class CopilotProvider implements LLMProvider {
  private model: string;
  private oauthProvider: string;
  private copilotToken: string | null = null;
  private copilotTokenExpiresAt = 0;

  constructor(config: ModelConfig) {
    this.model = config.model || 'gpt-4o';
    this.oauthProvider = 'github';
  }

  private needsResponsesAPI(): boolean {
    // Only GPT models that strictly require Responses API
    // Claude does NOT support Responses API on Copilot (returns 400)
    return RESPONSES_ONLY_MODELS.has(this.model);
  }

  private getEffectiveModel(_hasTools: boolean): string {
    return this.model;
  }

  // Track if Responses API failed for this model — fall back to chat/completions
  private _responsesApiFailed = false;

  /**
   * Exchange GitHub OAuth token for a Copilot session token.
   * The session token is short-lived and cached until near-expiry.
   */
  private async getCopilotToken(): Promise<string> {
    // Return cached token if still valid (with 2min buffer)
    if (this.copilotToken && Date.now() < this.copilotTokenExpiresAt - 2 * 60 * 1000) {
      return this.copilotToken;
    }

    const manager = getOAuthManager();
    if (!manager) throw new Error('OAuthManager not initialized. Connect GitHub via Settings -> OAuth.');
    const githubToken = await manager.getToken(this.oauthProvider);
    if (!githubToken) throw new Error('No GitHub OAuth token. Connect GitHub via Settings -> OAuth.');

    // Exchange OAuth token for Copilot session token
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
    this.copilotTokenExpiresAt = data.expires_at * 1000; // convert unix seconds to ms
    return this.copilotToken!;
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    messages = messages.filter(m => m && m.role);
    const token = await this.getCopilotToken();
    const hasTools = !!(tools && tools.length > 0);
    const effectiveModel = this.getEffectiveModel(hasTools);

    if (this.needsResponsesAPI() && !this._responsesApiFailed) {
      try {
        return await this.chatViaResponses(token, messages, tools, options);
      } catch (err: any) {
        // If Responses API fails for this model, fall back to chat/completions permanently
        if (!RESPONSES_ONLY_MODELS.has(this.model)) {
          console.warn(`[Copilot] Responses API failed for ${this.model}, falling back to chat/completions: ${err.message}`);
          this._responsesApiFailed = true;
          // Fall through to chat/completions below
        } else {
          throw err;
        }
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

    const formattedMessages = messages.map(m => formatOpenAIMessage(m));

    // Helper: make a single chat/completions call with given tool_choice
    const doCall = async (toolChoice: string): Promise<any> => {
      const body: Record<string, any> = {
        model: effectiveModel,
        messages: formattedMessages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 16384,
      };
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
        console.error(`[Copilot] ERROR ${resp.status}: ${errBody.slice(0, 500)}`);
        if (resp.status === 401 || resp.status === 403) {
          this.copilotToken = null;
          this.copilotTokenExpiresAt = 0;
        }
        throw new Error(`Copilot LLM request failed (${resp.status}): ${errBody}`);
      }  

      return resp.json();
    };

    // First attempt with tool_choice=auto
    let rawJson = await doCall('auto');
    let choice0 = rawJson.choices?.[0];
    let msg0 = choice0?.message;
    console.log(`[Copilot] response: model=${effectiveModel}, content=${(msg0?.content || '').slice(0, 80)}, tool_calls=${msg0?.tool_calls?.length || 0}, finish_reason=${choice0?.finish_reason || 'N/A'}`);

    // Detect broken tool calling: finish_reason=tool_calls but tool_calls is empty
    const isBrokenToolCall = (c: any, m: any) => {
      const fr = c?.finish_reason;
      const present = m?.tool_calls && m.tool_calls.length > 0;
      return (fr === 'tool_calls' || fr === 'tool_use') && !present;
    };

    if (isBrokenToolCall(choice0, msg0) && hasTools) {
      console.warn(`[Copilot] ${effectiveModel} returned broken tool_calls (empty array). Retrying with tool_choice=required...`);

      // Retry with tool_choice=required to force tool call generation
      try {
        rawJson = await doCall('required');
        choice0 = rawJson.choices?.[0];
        msg0 = choice0?.message;
        console.log(`[Copilot] retry response: model=${effectiveModel}, content=${(msg0?.content || '').slice(0, 80)}, tool_calls=${msg0?.tool_calls?.length || 0}, finish_reason=${choice0?.finish_reason || 'N/A'}`);
      } catch (retryErr: any) {
        console.warn(`[Copilot] retry with tool_choice=required failed: ${retryErr.message}`);
      }

      // If still broken after retry, try extracting tool calls from content text
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
        // Last resort: return content-only, agent-runner nudge will re-prompt
        console.warn(`[Copilot] ${effectiveModel} tool_calls broken after retry — returning content-only`);
        return { content: contentText, usage: rawJson.usage ? { promptTokens: rawJson.usage.prompt_tokens, completionTokens: rawJson.usage.completion_tokens } : undefined };
      }
    }

    const parsed = parseOpenAIResponse(rawJson);
    return parsed;
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    messages = messages.filter(m => m && m.role);
    const token = await this.getCopilotToken();
    const hasTools = !!(tools && tools.length > 0);
    const effectiveModel = this.getEffectiveModel(hasTools);

    if (this.needsResponsesAPI() && !this._responsesApiFailed) {
      try {
        yield* this.streamViaResponses(token, messages, tools, options);
        return;
      } catch (err: any) {
        if (!RESPONSES_ONLY_MODELS.has(this.model)) {
          console.warn(`[Copilot] Responses API stream failed for ${this.model}, falling back to chat/completions: ${err.message}`);
          this._responsesApiFailed = true;
          // Fall through to chat/completions below
        } else {
          throw err;
        }
      }
    }

    const body: Record<string, any> = {
      model: effectiveModel,
      messages: messages.map(m => formatOpenAIMessage(m)),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
    };
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
      if (response.status === 401 || response.status === 403) {
        this.copilotToken = null;
        this.copilotTokenExpiresAt = 0;
      }
      throw new Error(`Copilot LLM stream failed (${response.status}): ${errBody}`);
    }

    yield* streamOpenAIResponse(response);
  }

  // ── Responses API (/responses) for newer models ──

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

  /**
   * Convert LLMMessage[] + LLMTool[] into OpenAI Responses API format.
   * The Responses API uses `input` (array of items) instead of `messages`.
   */
  private buildResponsesBody(
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
    stream = false,
  ): Record<string, any> {
    const input: any[] = [];
    // Responses API enforces: id must start with 'fc', max 64 chars, only [a-zA-Z0-9_-]
    const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
    const idMap = new Map<string, string>();
    let idCounter = 0;
    const shortId = (original: string): string => {
      if (!original) return `fc_${idCounter++}`;
      if (idMap.has(original)) return idMap.get(original)!;
      const clean = sanitize(original);
      // Ensure 'fc' prefix as required by Responses API
      const prefixed = clean.startsWith('fc') ? clean : `fc_${clean}`;
      if (prefixed.length <= 64) { idMap.set(original, prefixed); return prefixed; }
      const short = `fc_${idCounter++}_${clean.slice(0, 52)}`;
      idMap.set(original, short);
      return short;
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages become developer instructions
        input.push({ role: 'developer', content: msg.content });
      } else if (msg.role === 'tool') {
        // Tool results
        input.push({
          type: 'function_call_output',
          call_id: shortId(msg.toolCallId || ''),
          output: msg.content,
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Assistant with tool calls → emit both message + function_call items
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
      } else {
        input.push({ role: msg.role, content: msg.content });
      }
    }

    const body: Record<string, any> = {
      model: this.model,
      input,
    };

    // o-series reasoning models don't support temperature
    if (!this.model.startsWith('o')) {
      body.temperature = options?.temperature ?? 0.7;
    }
    body.max_output_tokens = options?.maxTokens ?? 16384;

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    if (stream) body.stream = true;

    return body;
  }

  private async chatViaResponses(
    token: string,
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
  ): Promise<LLMResponse> {
    const body = this.buildResponsesBody(messages, tools, options);
    const bodyJson = JSON.stringify(body);
    const bodySize = Buffer.byteLength(bodyJson, 'utf8');
    console.log(`[Copilot/Responses] chat request: model=${this.model}, input=${body.input.length}, tools=${tools?.length || 0}, bodySize=${(bodySize / 1024).toFixed(1)}KB`);

    const response = await fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      headers: this.copilotHeaders(token),
      body: bodyJson,
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Copilot/Responses] ERROR ${response.status}: ${errBody.slice(0, 500)}`);
      if (response.status === 401 || response.status === 403) {
        this.copilotToken = null;
        this.copilotTokenExpiresAt = 0;
      }
      throw new Error(`Copilot Responses API failed (${response.status}): ${errBody}`);
    }

    const data = await response.json() as any;
    const parsed = this.parseResponsesResult(data);
    console.log(`[Copilot/Responses] response: content=${(parsed.content || '').slice(0, 100)}, toolCalls=${parsed.toolCalls?.length || 0}, outputItems=${data.output?.length || 0}`);
    return parsed;
  }

  private async *streamViaResponses(
    token: string,
    messages: LLMMessage[],
    tools?: LLMTool[],
    options?: Record<string, any>,
  ): AsyncGenerator<LLMStreamChunk> {
    const body = this.buildResponsesBody(messages, tools, options, true);
    const bodyJson = JSON.stringify(body);
    console.log(`[Copilot/Responses] stream request: model=${this.model}, input=${body.input.length}, tools=${tools?.length || 0}, bodySize=${(Buffer.byteLength(bodyJson, 'utf8') / 1024).toFixed(1)}KB`);

    const response = await fetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      headers: this.copilotHeaders(token),
      body: bodyJson,
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Copilot/Responses] STREAM ERROR ${response.status}: ${errBody.slice(0, 500)}`);
      if (response.status === 401 || response.status === 403) {
        this.copilotToken = null;
        this.copilotTokenExpiresAt = 0;
      }
      throw new Error(`Copilot Responses stream failed (${response.status}): ${errBody}`);
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
              toolCalls.set(item.id || item.call_id, {
                id: item.id || item.call_id,
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
          } catch { /* skip malformed SSE */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Flush remaining
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

  /**
   * Parse a non-streaming Responses API result into LLMResponse.
   */
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
        toolCalls.push({
          id: item.id || item.call_id || `fc_${Date.now()}`,
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

// =====================================================
// Cursor API provider
// Uses Cursor API key auth, independent from GitHub Copilot OAuth
// =====================================================

export class CursorProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  private static _cachedRepos: string[] | null = null;
  private static _cachedReposAt = 0;
  private static _workingSource: { repository: string; ref?: string } | null = null;

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || process.env.CURSOR_API_KEY || '';
    this.baseUrl = 'https://api.cursor.com';
  }

  async chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse> {
    const text = await this.runCloudAgent(messages, tools, options);
    return { content: text };
  }

  async *stream(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk> {
    const text = await this.runCloudAgent(messages, tools, options);
    if (text) yield { content: text, done: false };
    yield { done: true };
  }

  private async requestCursor(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, any>): Promise<Response> {
    const token = await this.resolveCursorToken();
    const url = `${this.baseUrl}${path}`;
    const bodyJson = body ? JSON.stringify(body) : undefined;
    const basic = Buffer.from(`${token}:`).toString('base64');
    const mkHeaders = (auth: string): Record<string, string> => {
      const h: Record<string, string> = { 'Authorization': auth };
      if (body) h['Content-Type'] = 'application/json';
      return h;
    };

    let response = await fetch(url, {
      method,
      headers: mkHeaders(`Basic ${basic}`),
      body: bodyJson,
    });
    if (response.ok) return response;

    if (response.status === 401 || response.status === 403) {
      response = await fetch(url, {
        method,
        headers: mkHeaders(`Bearer ${token}`),
        body: bodyJson,
      });
      if (response.ok) return response;
    }

    const errorBody = await response.text();
    throw new Error(`Cursor API request failed (${response.status}): ${errorBody}`);
  }

  private buildAgentPrompt(
    messages: LLMMessage[],
    tools?: LLMTool[],
  ): string {
    const compact = messages
      .filter(m => m && m.role && (m.content || m.toolCalls))
      .slice(-24)
      .map(m => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return `[assistant_tool_calls]: ${m.toolCalls.map(tc => tc.function.name).join(', ')}`;
        }
        return `[${m.role}]: ${String(m.content || '').slice(0, 4000)}`;
      })
      .join('\n');

    const toolHint = tools && tools.length > 0
      ? `\n\nLocal tools exist in WhiteOwl, but Cursor Cloud Agents API cannot call local MCP/tools directly in this integration. Respond with best possible answer using text reasoning only.`
      : '';

    return `${compact}${toolHint}`.slice(0, 120000);
  }

  /**
   * Fetch repositories accessible to the user through Cursor's own GitHub integration.
   * Cached for 1 hour due to strict rate limits (1/min, 30/hr).
   */
  private async getCursorAccessibleRepos(): Promise<string[]> {
    const now = Date.now();
    if (CursorProvider._cachedRepos && now - CursorProvider._cachedReposAt < 3600000) {
      return CursorProvider._cachedRepos;
    }

    try {
      const resp = await this.requestCursor('GET', '/v0/repositories');
      const data = await resp.json() as any;
      const repos: string[] = (data.repositories || [])
        .map((r: any) => r?.repository)
        .filter(Boolean);
      CursorProvider._cachedRepos = repos;
      CursorProvider._cachedReposAt = now;
      console.log(`[Cursor] Fetched ${repos.length} accessible repos from Cursor API`);
      return repos;
    } catch (err: any) {
      console.log(`[Cursor] Failed to fetch repos from Cursor API: ${String(err?.message || '').slice(0, 120)}`);
      return CursorProvider._cachedRepos || [];
    }
  }

  /**
   * Attempt to push an initial commit to the user's empty GitHub repos.
   * This fixes the "Git Repository is empty" Cursor error.
   * Returns true if at least one repo was successfully initialized.
   */
  private async tryInitializeEmptyRepos(): Promise<boolean> {
    const mgr = getOAuthManager();
    if (!mgr) return false;
    const ghToken = await mgr.getToken('github');
    if (!ghToken) return false;

    const ghHeaders = {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'WhiteOwl-CursorProvider',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      const resp = await fetch('https://api.github.com/user/repos?per_page=10&sort=updated&direction=desc', {
        headers: ghHeaders,
      });
      if (!resp.ok) return false;
      const repos = await resp.json() as any[];

      for (const repo of (repos || [])) {
        if (!repo?.full_name) continue;
        const branch = String(repo.default_branch || 'main');

        const refResp = await fetch(`https://api.github.com/repos/${repo.full_name}/git/ref/heads/${branch}`, {
          headers: ghHeaders,
        });
        if (refResp.ok) continue;

        console.log(`[Cursor] Repo ${repo.full_name} is empty, attempting to initialize...`);
        const ok = await this.initializeEmptyRepo(ghHeaders, repo.full_name, branch);
        if (ok) {
          console.log(`[Cursor] Successfully initialized ${repo.full_name}`);
          return true;
        }
        console.log(`[Cursor] Failed to initialize ${repo.full_name} (OAuth may lack repo scope)`);
      }
    } catch { /* ignore */ }

    try {
      for (const name of ['whiteowl-cursor-chat', `whiteowl-cursor-${Date.now().toString(36)}`]) {
        const createResp = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            private: true,
            auto_init: true,
            description: 'Auto-provisioned for WhiteOwl Cursor API',
          }),
        });
        if (createResp.ok) {
          console.log(`[Cursor] Created new initialized repo: ${name}`);
          return true;
        }
      }
    } catch { /* ignore */ }

    return false;
  }

  private async autoProvisionRepositoryFromGithubOAuth(): Promise<{ repository: string; ref?: string } | null> {
    const mgr = getOAuthManager();
    if (!mgr) return null;
    const ghToken = await mgr.getToken('github');
    if (!ghToken) return null;

    const ghHeaders = {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'WhiteOwl-CursorProvider',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      const existingResp = await fetch('https://api.github.com/user/repos?per_page=10&sort=updated&direction=desc', {
        headers: ghHeaders,
      });
      if (existingResp.ok) {
        const repos = await existingResp.json() as any[];
        for (const repo of (repos || [])) {
          if (!repo?.html_url || !repo?.full_name) continue;
          const branch = String(repo.default_branch || 'main');
          try {
            const refResp = await fetch(`https://api.github.com/repos/${repo.full_name}/git/ref/heads/${branch}`, {
              headers: ghHeaders,
            });
            if (refResp.ok) {
              return { repository: String(repo.html_url) };
            }
          } catch { /* skip */ }
        }

        const firstRepo = repos?.[0];
        if (firstRepo?.full_name && firstRepo?.html_url) {
          const branch = String(firstRepo.default_branch || 'main');
          const initialized = await this.initializeEmptyRepo(ghHeaders, firstRepo.full_name, branch);
          if (initialized) {
            return { repository: String(firstRepo.html_url) };
          }
        }
      }
    } catch { /* ignore */ }

    for (const name of ['whiteowl-cursor-chat', `whiteowl-cursor-${Date.now().toString(36)}`]) {
      try {
        const createResp = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            private: true,
            auto_init: true,
            description: 'Auto-provisioned repository for WhiteOwl Cursor API chat',
          }),
        });
        if (!createResp.ok) continue;
        const created = await createResp.json() as any;
        if (created?.html_url) {
          await new Promise(r => setTimeout(r, 2000));
          return { repository: String(created.html_url) };
        }
      } catch { /* next */ }
    }

    return null;
  }

  private async initializeEmptyRepo(
    ghHeaders: Record<string, string>,
    fullName: string,
    branch: string,
  ): Promise<boolean> {
    try {
      const content = Buffer.from('# WhiteOwl Cursor Chat\nAuto-provisioned repository.\n').toString('base64');
      const resp = await fetch(`https://api.github.com/repos/${fullName}/contents/README.md`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Initial commit', content, branch }),
      });
      if (resp.ok) {
        await new Promise(r => setTimeout(r, 1500));
        return true;
      }
      if (resp.status === 422) {
        const resp2 = await fetch(`https://api.github.com/repos/${fullName}/contents/README.md`, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Initial commit', content }),
        });
        if (resp2.ok) {
          await new Promise(r => setTimeout(r, 1500));
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private isRepoError(msg: string): boolean {
    return /repository is required|default repository|source\.repository|Repository is empty|Git Repository is empty|Branch.*does not exist|branch.*ref|Failed to verify/i.test(msg);
  }

  private static _repoFailureMessage: string | null = null;

  static resetRepoFailure(): void {
    CursorProvider._repoFailureMessage = null;
    CursorProvider._workingSource = null;
    CursorProvider._cachedRepos = null;
    CursorProvider._cachedReposAt = 0;
  }

  private async runCloudAgent(
    messages: LLMMessage[],
    tools?: LLMTool[],
    _options?: Record<string, any>,
  ): Promise<string> {
    // Permanent cache until user reconnects OAuth or changes settings
    if (CursorProvider._repoFailureMessage) {
      return CursorProvider._repoFailureMessage;
    }

    const promptText = this.buildAgentPrompt(messages, tools);

    let payload: Record<string, any> = {
      prompt: { text: promptText },
      target: { autoCreatePr: false },
    };
    if (this.model && this.model !== 'default') payload.model = this.model;

    if (CursorProvider._workingSource) {
      payload.source = { ...CursorProvider._workingSource };
    }

    // Step 1: Try with current payload (cached source or Cursor dashboard default)
    try {
      const resp = await this.requestCursor('POST', '/v0/agents', payload);
      const result = await this.pollAgentResult(resp);
      CursorProvider._repoFailureMessage = null;
      return result;
    } catch (err: any) {
      const msg = String(err?.message || '');

      if (!this.isRepoError(msg)) {
        if (this.model && /model|invalid|unsupported/i.test(msg)) {
          console.log(`[Cursor] Model issue, retrying without model param`);
          delete payload.model;
          try {
            const resp = await this.requestCursor('POST', '/v0/agents', payload);
            return await this.pollAgentResult(resp);
          } catch { /* fall through */ }
        }
        return `[Cursor API Error] ${msg.slice(0, 300)}`;
      }
      console.log(`[Cursor] Step 1 repo error: ${msg.slice(0, 150)}`);
    }

    // Step 2: The repo is empty — try to initialize it via GitHub OAuth
    CursorProvider._workingSource = null;
    const initialized = await this.tryInitializeEmptyRepos();
    if (initialized) {
      console.log(`[Cursor] Step 2: initialized repo, retrying...`);
      await new Promise(r => setTimeout(r, 3000));
      try {
        const resp = await this.requestCursor('POST', '/v0/agents', payload);
        CursorProvider._repoFailureMessage = null;
        return await this.pollAgentResult(resp);
      } catch (err: any) {
        console.log(`[Cursor] Retry after init failed: ${String(err?.message || '').slice(0, 150)}`);
      }
    }

    // Step 3: Try repos from Cursor's /v0/repositories
    const cursorRepos = await this.getCursorAccessibleRepos();
    for (const repoUrl of cursorRepos) {
      payload.source = { repository: repoUrl };
      console.log(`[Cursor] Step 3: trying Cursor-accessible repo: ${repoUrl}`);
      try {
        const resp = await this.requestCursor('POST', '/v0/agents', payload);
        CursorProvider._workingSource = { repository: repoUrl };
        CursorProvider._repoFailureMessage = null;
        return await this.pollAgentResult(resp);
      } catch (err: any) {
        const msg = String(err?.message || '');
        if (!this.isRepoError(msg)) return `[Cursor API Error] ${msg.slice(0, 300)}`;
      }
    }

    // Step 4: Try env-configured or auto-provisioned repo (with explicit source)
    const envRepo = process.env.CURSOR_REPOSITORY_URL;
    if (envRepo) {
      payload.source = { repository: envRepo };
      try {
        const resp = await this.requestCursor('POST', '/v0/agents', payload);
        CursorProvider._workingSource = { repository: envRepo };
        CursorProvider._repoFailureMessage = null;
        return await this.pollAgentResult(resp);
      } catch { /* fall through */ }
    }
    const auto = await this.autoProvisionRepositoryFromGithubOAuth();
    if (auto) {
      payload.source = { ...auto };
      console.log(`[Cursor] Step 4: trying auto-provisioned repo: ${auto.repository}`);
      try {
        const resp = await this.requestCursor('POST', '/v0/agents', payload);
        CursorProvider._workingSource = auto;
        CursorProvider._repoFailureMessage = null;
        return await this.pollAgentResult(resp);
      } catch (err: any) {
        console.log(`[Cursor] Auto-provisioned repo failed: ${String(err?.message || '').slice(0, 150)}`);
      }
    }

    const guidance =
      'I cannot process this request right now. Your Cursor Cloud Agents setup needs a GitHub repository with at least one commit.\n\n' +
      '**How to fix:**\n' +
      '1. Go to [cursor.com/dashboard/cloud-agents](https://cursor.com/dashboard/cloud-agents)\n' +
      '2. Under "Default Repository", select a repo that has at least one commit\n' +
      '3. If your repo is empty, push any commit to it (even just a README)\n' +
      '4. Come back here and try again\n\n' +
      'Alternatively, reconnect GitHub in Settings → OAuth to allow auto-provisioning.';

    CursorProvider._repoFailureMessage = guidance;
    console.log('[Cursor] All methods exhausted — caching guidance until OAuth reconnect');
    return guidance;
  }

  private async pollAgentResult(createResp: Response): Promise<string> {
    const created = await createResp.json() as any;
    const agentId = created?.id;
    if (!agentId) throw new Error('Cursor API: failed to create cloud agent (missing id)');

    const startedAt = Date.now();
    const timeoutMs = 120000;
    const terminal = new Set(['FINISHED', 'FAILED', 'STOPPED', 'CANCELLED', 'ERRORED']);
    let status = '';

    while (Date.now() - startedAt < timeoutMs) {
      const stResp = await this.requestCursor('GET', `/v0/agents/${agentId}`);
      const st = await stResp.json() as any;
      status = String(st?.status || '');
      if (terminal.has(status)) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const convResp = await this.requestCursor('GET', `/v0/agents/${agentId}/conversation`);
    const conv = await convResp.json() as any;
    const messagesList = Array.isArray(conv?.messages) ? conv.messages : [];
    const assistantText = messagesList
      .filter((m: any) => m?.type === 'assistant_message')
      .map((m: any) => String(m?.text || '').trim())
      .filter(Boolean)
      .pop() || '';

    if (assistantText) return assistantText;
    if (status && status !== 'FINISHED') {
      throw new Error(`Cursor agent finished without answer (status: ${status})`);
    }
    throw new Error('Cursor API: no assistant response in conversation');
  }

  private async resolveCursorToken(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const envToken = process.env.CURSOR_API_KEY || '';
    if (envToken) return envToken;
    const manager = getOAuthManager();
    if (manager) {
      const oauthToken = await manager.getToken('cursor');
      if (oauthToken) return oauthToken;
    }
    throw new Error('Cursor API key missing. Set CURSOR_API_KEY in Settings -> API Keys.');
  }
}

// =====================================================
// Generic OAuth-based OpenAI-compatible provider
// For Google (Vertex/Gemini via OpenAI compat) and Azure AD OAuth
// =====================================================

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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OAuth LLM request failed (${response.status}): ${errBody}`);
    }

    return parseOpenAIResponse(await response.json());
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OAuth LLM stream failed (${response.status}): ${errBody}`);
    }

    yield* streamOpenAIResponse(response);
  }
}

// =====================================================
// Extract tool calls from Claude content text
// Claude sometimes embeds tool use in content when
// the chat/completions API fails to structure them
// =====================================================

function extractToolCallsFromContent(content: string, tools: LLMTool[]): LLMToolCall[] {
  const validToolNames = new Set(tools.map(t => t.function.name));
  const extracted: LLMToolCall[] = [];

  // Pattern 1: Anthropic XML-style <tool_use> blocks
  // <tool_use><name>tool_name</name><arguments>{"key":"value"}</arguments></tool_use>
  const xmlPattern = /<tool_use>\s*<name>([^<]+)<\/name>\s*(?:<arguments>|<input>)([\s\S]*?)(?:<\/arguments>|<\/input>)\s*<\/tool_use>/gi;
  let match;
  while ((match = xmlPattern.exec(content)) !== null) {
    const name = match[1].trim();
    const args = match[2].trim();
    if (validToolNames.has(name)) {
      try {
        JSON.parse(args); // validate JSON
        extracted.push({
          id: `extracted_${Date.now()}_${extracted.length}`,
          function: { name, arguments: args },
        });
      } catch { /* invalid JSON, skip */ }
    }
  }
  if (extracted.length > 0) return extracted;

  // Pattern 2: JSON-style tool call in content
  // Look for patterns like: {"name": "tool_name", "arguments": {...}}
  // or: tool_name({"key": "value"})
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
      } catch { /* invalid JSON, skip */ }
    }
  }

  return extracted;
}

// =====================================================
// Shared OpenAI-format helpers
// =====================================================

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
  if (msg.toolCallId) formatted.tool_call_id = msg.toolCallId;
  if (msg.toolCalls) {
    formatted.tool_calls = msg.toolCalls.map(tc => ({
      id: tc.id, type: 'function', function: tc.function,
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
        } catch { /* skip malformed SSE */ }
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

// =====================================================
// Provider factory
// =====================================================

export function createLLMProvider(config: ModelConfig): LLMProvider {
  // Cursor API (independent from Copilot OAuth)
  if (config.provider === 'cursor') {
    return new CursorProvider(config);
  }

  // GitHub Copilot (OAuth)
  if (config.provider === 'copilot') {
    return new CopilotProvider(config);
  }

  // OAuth-based providers (google-oauth, azure-oauth)
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

  // OpenAI-compatible providers
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
      // Fallback: try as OpenAI-compatible with custom baseUrl
      if (config.baseUrl) {
        return new OpenAIProvider(config);
      }
      throw new Error(`Unknown LLM provider: ${config.provider}. Set baseUrl for custom OpenAI-compatible endpoints.`);
  }
}
