# Configuration

WhiteOwl is configured through a `.env` file in the project root. Copy `.env.example` to `.env` and fill in the values you need. **At minimum, only `SOLANA_RPC_URL` and `HELIUS_API_KEY` are required to run.**

All other LLM and integration keys are optional and can also be configured interactively through the **Settings** page in the dashboard.

---

## Minimal .env

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY
```

---

## Full .env Reference

### Solana / Blockchain

| Variable | Required | Description |
|---|---|---|
| `SOLANA_RPC_URL` | ✅ Yes | Solana JSON-RPC endpoint (Helius recommended) |
| `HELIUS_API_KEY` | ✅ Yes | Helius API key for enhanced RPC + webhooks |

### LLM API Keys

Any one of these enables the corresponding models in the UI model selector.

| Variable | Provider |
|---|---|
| `OPENAI_API_KEY` | OpenAI (GPT-4o, GPT-4.1, o3, …) |
| `ANTHROPIC_API_KEY` | Anthropic Claude (Sonnet, Opus, Haiku) |
| `GOOGLE_API_KEY` | Google Gemini |
| `GROQ_API_KEY` | Groq (fast inference) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `OPENROUTER_API_KEY` | OpenRouter (unified gateway) |
| `MISTRAL_API_KEY` | Mistral AI |
| `XAI_API_KEY` | xAI Grok |
| `CEREBRAS_API_KEY` | Cerebras |
| `TOGETHER_API_KEY` | Together AI |
| `FIREWORKS_API_KEY` | Fireworks AI |
| `SAMBANOVA_API_KEY` | SambaNova |

### Local LLM (Ollama)

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Base URL of a running Ollama instance |

Ollama is auto-detected on startup; if running locally, its models appear automatically in the model selector.

### OAuth / Free AI

GitHub Copilot access is available for free via the built-in OAuth device-flow — **no env variable required**. Just click **Connect GitHub Copilot** in the Settings page.

| Variable | Description |
|---|---|
| `OAUTH_GOOGLE_CLIENT_ID` | Google OAuth client ID (for Gemini OAuth flow) |
| `OAUTH_AZURE_CLIENT_ID` | Azure AD client ID (for Azure OpenAI OAuth flow) |

### Telegram Notifications

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat or group ID to send alerts to |

---

## Settings Page

Most configuration can be changed at runtime through the **Settings** page without restarting:

- **RPC Configuration** — Solana RPC URL, Helius API key (persisted to `data/rpc-config.json`)
- **AI Model Selection** — Add/remove API keys, switch active model per agent
- **OAuth Connections** — GitHub Copilot, Google, Azure device-flow login
- **Browser CDP** — Connect WhiteOwl to a running Chrome/Chromium for browser automation
- **System Health** — View runtime status, memory usage, skill load status

---

## Config File (Advanced)

You can pass a YAML or JSON config file at startup:

```bash
npm start -- --config=./my-config.yaml
```

The config file can override any value from the default `AppConfig` — agents, risk limits, API port, skill assignments, etc. See `src/types.ts` for the full `AppConfig` type definition.

---

## Strategy Files

Place YAML strategy files in a `./strategies/` directory. They are loaded automatically on startup:

```
strategies/
├── conservative.yaml
├── aggressive.yaml
└── scalp.yaml
```

List loaded strategies with `strategies` in the interactive CLI, or view them in the **Shit Trader** surface under **Execution Profile**.
