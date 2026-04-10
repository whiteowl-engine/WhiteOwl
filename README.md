<p align="center">
  <img src="public/logo.svg" width="80" alt="WhiteOwl">
</p>

<h1 align="center">WhiteOwl</h1>

<p align="center">
  <strong>AI-Powered Trading Panel for Solana Memecoins</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/typescript-5.x-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/skills-29-orange" alt="Skills">
  <img src="https://img.shields.io/badge/tools-208-orange" alt="Tools">
  <img src="https://img.shields.io/badge/solana-mainnet-purple" alt="Solana">
</p>

<p align="center">
  Web dashboard with autonomous monitoring, analysis and execution on pump.fun via multi-agent AI system with 29 plugin skills and 208 tools.
</p>

---

## Features

- **Web Dashboard** — Full-featured trading panel with real-time data, charts, and controls
- **Multi-Agent System** — Configurable agents (Strategy Commander, Coder, Shit Trader) with independent skills and autonomy levels
- **29 Plugin Skills, 208 Tools** — Modular architecture covering trading, analysis, market intel, portfolio, and automation
- **Multi-LLM Support** — OpenAI, Anthropic Claude, Google Gemini, xAI Grok, Groq, DeepSeek, Ollama (local), OpenRouter, Mistral, Cerebras, Together, Fireworks, GitHub Copilot (free via OAuth), Azure OpenAI, AWS Bedrock, Vertex AI, and more
- **Autonomous Trading** — Shit Trader surface with paper trading, execution profiles, risk engine, and market connections to Axiom and Pump.fun
- **Live Events** — Real-time event streaming via WebSocket with full AI activity log
- **Risk Management** — Hard limits on position size, daily loss, exposure. Emergency stop. AI cannot bypass
- **Token Explorer** — Search by address/symbol/name, market cap, volume, transaction count with KOTH/HOT badges
- **Copy Trading** — Mirror trades from tracked smart money wallets
- **Token Analysis** — Holder distribution, dev wallet checks, rug detection, security audit, curve analysis
- **News Aggregation** — Multi-source news feed with category filters (Crypto, Politics, Tech, DeFi, Solana, etc.)
- **X Tracker** — Real-time Twitter/X monitoring with KOL tracking
- **GMGN Integration** — Token data, security analysis, holder intelligence
- **Axiom Integration** — Direct REST API integration with axiom.trade
- **Browser Automation** — Full browser control via CDP for Axiom, Twitter, GMGN and any site
- **Chrome Extension** — WhiteOwl overlay for pump.fun with AI-powered trading tools
- **Background Jobs** — Scheduled monitoring tasks (Hot Posts Tracker, Live Monitoring)
- **Multi-Wallet** — Multiple Solana wallets with multisig vault support
- **Project Workspace** — Local filesystem access for AI code generation
- **Skill Hub** — Community skill marketplace — browse, import, export, and share skills
- **Built-in Terminal** — Persistent terminal sessions for AI agents
- **SQLite Memory** — All tokens, trades, snapshots, analysis persisted locally

## Quick Start

```bash
git clone https://github.com/user/WhiteOwl.git
cd WhiteOwl
npm install
cp .env.example .env     # Edit with your keys
npm start                # http://localhost:3377
```

LLM can be configured through the Settings page in the panel (GitHub Copilot OAuth for free access, or add API keys for any supported provider).

| Command | Description |
|---------|-------------|
| `npm start` | Start the panel (http://localhost:3377) |
| `npm run dev` | Development mode with hot reload |
| `npm run autopilot` | Full autonomous trading |
| `npm run monitor` | Watch-only, no trades |

## Dashboard Pages

| Page | Description |
|------|-------------|
| **Dashboard** | P&L overview, session info, recent trades, AI explanations |
| **AI Chat** | Chat with AI agents, model selection, auto-approve levels, conversation history |
| **Portfolio** | PNL summary, SPL token balances, trade history (local + GMGN) |
| **Wallet** | Multi-wallet management, deposit/withdraw, import/export, multisig vaults |
| **Token** | Token search and explorer with market data, filters (1H/6H/24H) |
| **AI Activity** | Real-time AI event log — decisions, tool calls, LLM responses, token usage |
| **Live Events** | Full event stream from all system components |
| **News** | Aggregated news from Reddit, Hacker News, Decrypt and more with category filters |
| **X Tracker** | Twitter/X feed monitoring, filter by handle, keyword, or tweet URL |
| **Agent** | Agent cards with role, autonomy level, model, stats, skill assignments, chat |
| **Background Jobs** | Scheduled tasks with run counts, status, and results |
| **Shit Trader** | Autonomous trading surface — paper/live toggle, execution profile, risk engine, Axiom + Pump.fun connections |
| **Skills** | 29 skills and 208 tools organized by category (Trading, Analysis, Market Intel, Portfolio, Other) |
| **Skill Hub** | Community skill marketplace — browse, import, export, share |
| **Projects** | Local AI project workspace with file management |
| **Extension** | Chrome extension installer and management for pump.fun overlay |
| **Terminal** | Built-in terminal with AI Agent and manual tabs |
| **Settings** | RPC configuration, OAuth / AI model selection, browser CDP connection, system health |

## Skills

29 skills organized by category:

**Trading**
| Skill | Tools | Description |
|-------|-------|-------------|
| shit-trader | 19 | Unified shitcoin trading — manual buy/sell via Pump SDK + Jupiter |
| advanced-trader | 15 | DCA, trailing stop-loss, grid trading, graduation sniping |
| exit-optimizer | 7 | AI exit strategy — profit-taking, trailing stops, volume decay |
| copy-trade | 4 | Automated copy trading from tracked wallets |

**Analysis**
| Skill | Tools | Description |
|-------|-------|-------------|
| token-analyzer | 10 | Comprehensive token analysis — metadata, holder distribution, rug detection |
| token-security | 5 | On-chain security auditor — mint/freeze authority, LP locks, metadata |
| curve-analyzer | 8 | Real-time bonding curve analysis via pump SDK |
| holder-intelligence | 8 | Deep on-chain holder analysis with pump.fun tokenomics |
| volume-detector | 8 | Volume anomaly detection — wash trading, spikes, organic analysis |

**Market Intel**
| Skill | Tools | Description |
|-------|-------|-------------|
| pump-monitor | 35 | Full pump.fun integration — monitor launches, on-chain data |
| social-monitor | 14 | Social media with real KOL tracking, LLM-powered NLP |
| alpha-scanner | 12 | Telegram, Twitter, and secondary sites for new token alerts |

**Portfolio**
| Skill | Tools | Description |
|-------|-------|-------------|
| portfolio | 9 | Position tracking, P&L calculation, reports |
| wallet-tracker | 8 | Smart money wallet tracking, trade monitoring, copy signals |

**Other**
| Skill | Tools | Description |
|-------|-------|-------------|
| projects | 28 | Local filesystem access — read, write, execute files |
| browser-eye | 24 | Full autonomous browser control via CDP |
| blockchain | 11 | Solana on-chain intelligence — address ID, wallet profiling |
| axiom-api | 11 | Direct REST API integration with axiom.trade |
| web-intel | 9 | Scrape real-time token data from Axiom and GMGN |
| gmgn | 8 | GMGN.ai integration — token data, security, holder intelligence |
| web-search | 7 | Web search and content fetching |
| skill-hub | 7 | Community Skill Hub — browse, import, export, share |
| insightx | 7 | Holder analysis — clusters, snipers, bundlers, insiders |
| background-jobs | 7 | Schedule and manage background jobs |
| ai-memory | 5 | Persistent AI memory — save and recall notes, token analyses |
| skill-builder | 4 | Create and manage custom skills via AI |
| terminal | 4 | Persistent shared terminal sessions |
| news-search | 3 | Search and browse aggregated crypto news |
| screenshot | 1 | Take screenshots of web pages |

Total: **29 skills**, **208 tools** available to AI agents.

## Risk Management

The Risk Manager enforces hard limits that **no agent can bypass**:

- **Position Size** — Max SOL per single trade
- **Open Positions** — Max concurrent positions
- **Daily Loss** — Trading pauses after hitting daily loss limit
- **Total Exposure** — Sum of all position sizes capped
- **Emergency Stop** — Kills all trading if total loss exceeds threshold
- **Loss Streak Cooldown** — Automatic pause after consecutive losses

Configurable through the Shit Trader page (Execution Profile + Risk Engine panels).

## API

REST API + WebSocket server on port 3377:

- `GET /api/status` — System status + wallet balance
- `GET /api/stats` — Current session stats
- `GET /api/trades` — Trade history
- `GET /api/tokens/:mint` — Token details + analysis
- `GET /api/events` — Recent event log
- `GET /api/skills` — Available skills + tools
- `POST /api/chat` — Chat with agent
- `ws://localhost:3377/ws` — Live event stream

## Chrome Extension

WhiteOwl browser extension provides an AI-powered overlay directly on pump.fun. Supports Chrome, Edge, and Brave. Install from the Extension page in the panel or from Chrome Web Store.

## Project Structure

```
WhiteOwl/
├── src/
│   ├── api/            # Express server, news provider, CRX builder
│   ├── core/           # Agent runner, browser, scheduler, risk, events
│   ├── lib/            # Pump SDK, cabalspy
│   ├── llm/            # Multi-provider LLM layer (OpenAI, Anthropic, Gemini, ...)
│   ├── memory/         # SQLite store, token/trade/news persistence
│   ├── skills/         # 29 modular skill plugins (208 tools)
│   └── wallet/         # Solana wallet, multisig, multi-wallet
├── public/             # Dashboard frontend (HTML/JS/CSS)
├── data/               # Runtime data (gitignored)
└── .env                # API keys & config (gitignored)
```

## Development

```bash
npm run build            # Compile TypeScript
npm run dev              # Development mode with hot reload
npx tsc --noEmit         # Type checking
```

## Disclaimer

This software is for educational and research purposes. Trading memecoins is extremely risky. You can lose all invested funds. The authors are not responsible for any financial losses. Use at your own risk.

## License

MIT
