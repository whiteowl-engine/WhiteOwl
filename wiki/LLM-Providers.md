# LLM Providers

WhiteOwl supports **17+ LLM providers** out of the box. The provider layer lives in `src/llm/` and presents a unified interface to all agents regardless of which backend is used.

---

## Provider Overview

| Provider | Models | Auth Method |
|---|---|---|
| **OpenAI** | GPT-4o, GPT-4.1, GPT-4o-mini, o3, o4-mini, … | `OPENAI_API_KEY` |
| **Anthropic Claude** | Claude Sonnet 3.7/4, Claude Opus 4, Claude Haiku | `ANTHROPIC_API_KEY` |
| **Google Gemini** | Gemini 2.5 Pro/Flash, Gemini 1.5 Pro | `GOOGLE_API_KEY` or OAuth |
| **xAI Grok** | Grok-3, Grok-3-mini | `XAI_API_KEY` |
| **Groq** | Llama 3.3-70B, DeepSeek-R1, Mixtral (fast inference) | `GROQ_API_KEY` |
| **DeepSeek** | DeepSeek-V3, DeepSeek-R1 | `DEEPSEEK_API_KEY` |
| **Mistral AI** | Mistral Large, Codestral | `MISTRAL_API_KEY` |
| **Cerebras** | Llama-3.3-70B (ultra-fast) | `CEREBRAS_API_KEY` |
| **Together AI** | Llama 4, DeepSeek-R1, Qwen, … | `TOGETHER_API_KEY` |
| **Fireworks AI** | Llama, DeepSeek, Qwen (fast hosting) | `FIREWORKS_API_KEY` |
| **SambaNova** | Llama 4 (fast inference) | `SAMBANOVA_API_KEY` |
| **OpenRouter** | All major models via unified gateway | `OPENROUTER_API_KEY` |
| **Ollama** | Any locally installed model | Auto-detected or `OLLAMA_BASE_URL` |
| **GitHub Copilot** | GPT-4o, Claude Sonnet (via Copilot API) | OAuth device-flow (free) |
| **Azure OpenAI** | GPT-4o, GPT-4.1 (enterprise) | `OAUTH_AZURE_CLIENT_ID` + OAuth |
| **Google Vertex AI** | Gemini models (enterprise) | OAuth |
| **AWS Bedrock** | Claude, Llama via AWS | AWS credentials |

---

## Configuring Providers

### Via .env

Add the API key for any provider to your `.env` file. The corresponding models will appear automatically in the UI model selector.

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
```

### Via Settings Page

Go to **Settings → AI Models** to add or remove API keys without editing `.env`. Keys are stored encrypted in `data/api-keys.enc`.

### Via OAuth (Free)

#### GitHub Copilot (Recommended for free use)
1. Go to **Settings → AI Models**
2. Click **Connect GitHub Copilot**
3. Complete the device-flow (visit the URL shown, enter the code)
4. GPT-4o and Claude Sonnet become available at no extra cost (within Copilot quota)

#### Google Gemini via OAuth
1. Set `OAUTH_GOOGLE_CLIENT_ID` in `.env`
2. Click **Connect Google** in Settings
3. Complete the OAuth consent flow

---

## Selecting a Model

Models are selected **per agent** — different agents can use different providers simultaneously:

1. Open the **AI Chat** surface
2. Click the model selector dropdown next to the agent name
3. Choose any available provider/model
4. The choice is persisted to `data/model-config.json`

Or configure models in a YAML config file:

```yaml
agents:
  - id: scanner
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  - id: trader
    model:
      provider: groq
      model: llama-3.3-70b-versatile
```

---

## Local Models with Ollama

1. Install [Ollama](https://ollama.ai)
2. Pull a model: `ollama pull llama3.3`
3. WhiteOwl auto-detects Ollama on `http://127.0.0.1:11434`
4. Local models appear in the model selector under **Ollama**

Set a custom Ollama URL:

```env
OLLAMA_BASE_URL=http://192.168.1.100:11434
```

---

## Streaming

All providers support **streamed responses** — tokens appear in the AI Chat surface as they are generated. The streaming status indicator is shown next to the agent name while a response is in flight.

---

## Tool Calling Compatibility

Not all models support function/tool calling. WhiteOwl uses tool calling for all skill execution. Recommended models with full tool-calling support:

- GPT-4o, GPT-4.1, GPT-4o-mini
- Claude Sonnet 3.7+, Claude Haiku 3.5+
- Gemini 2.5 Pro/Flash
- Llama 3.3 70B (via Groq, Together, or Ollama)
- DeepSeek-V3, DeepSeek-R1

Models without tool calling can still be used for chat-only interactions (e.g., the Coder agent for Q&A).
