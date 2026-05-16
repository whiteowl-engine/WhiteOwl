<p align="center">
  <img src="https://raw.githubusercontent.com/whiteowl-engine/WhiteOwl/main/public/github-hero.gif?v=2" width="100%" alt="WhiteOwl hero banner">
</p>

<h1 align="center">WhiteOwl</h1>

<p align="center">
  <strong>AI-powered trading panel for Solana memecoins</strong>
</p>

<p align="center">
  Local-first dashboard for AI chat, wallet management, live market monitoring, browser automation, and autonomous trading workflows.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-111827?style=for-the-badge&logo=node.js&logoColor=7ee787&labelColor=020617" alt="Node">
  <img src="https://img.shields.io/badge/typescript-5.x-111827?style=for-the-badge&logo=typescript&logoColor=7dd3fc&labelColor=020617" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&logo=opensourceinitiative&logoColor=a3e635&labelColor=020617" alt="License">
  <img src="https://img.shields.io/badge/skills-31-111827?style=for-the-badge&logo=buffer&logoColor=f59e0b&labelColor=020617" alt="Skills">
  <img src="https://img.shields.io/badge/tools-224-111827?style=for-the-badge&logo=raycast&logoColor=f97316&labelColor=020617" alt="Tools">
  <img src="https://img.shields.io/badge/solana-mainnet-111827?style=for-the-badge&logo=solana&logoColor=c084fc&labelColor=020617" alt="Solana">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#highlights">Highlights</a> •
  <a href="#companion-extension">Extension</a> •
  <a href="#dashboard-surfaces">Dashboard</a> •
  <a href="#skill-system">Skills</a> •
  <a href="#api">API</a>
</p>

---

## Highlights

| Surface | What it does |
|---|---|
| **AI Chat** | Multi-agent operator console with model switching, auto-approve controls, streamed reasoning, and persistent sessions |
| **Market Intel** | Live events, news aggregation, X tracking, token discovery, holder analysis, and pump.fun monitoring |
| **Trading Workflow** | Paper/live execution profiles, risk limits, copy trading, curve analysis, exit automation, and wallet tools |
| **Announcement Sniper** | Detects high-signal buybacks, burns, listings, partnerships, and exploit news, then routes scored signals into manual or automated execution |
| **Perp Desk** | Native Hyperliquid perp surface with funding, marks, live or paper positions, and encrypted API settings |
| **Local Ops** | Browser automation, terminal access, project workspace, SQLite-backed memory, and background jobs |

## Panel 1.0.9 Update

WhiteOwl 1.0.9 ships with native **Kiro aggregator** support, available in both connection modes:

- **API key**: drop a `KIRO_API_KEY` into `.env` (or paste it via Settings → API Keys, optionally with `KIRO_BASE_URL` for self-hosted deployments). Models surface immediately in the dashboard picker.
- **OAuth device flow**: hit Settings → OAuth → Kiro and connect via the same device-code experience used for GitHub Copilot, Google, and Azure. Configure `OAUTH_KIRO_CLIENT_ID` (plus optional `OAUTH_KIRO_DEVICE_URL` / `OAUTH_KIRO_TOKEN_URL` / `OAUTH_KIRO_SCOPES`) on the server.

Either path exposes Kiro-routed Claude, GPT, Gemini, Grok, DeepSeek, Qwen, and Llama variants through one OpenAI-compatible endpoint, plugging in exactly the way Visual Studio / Copilot wires custom AI providers.

## Panel 1.0.7 Patch

WhiteOwl 1.0.7 fixes the TypeScript release build for the ESM runtime: `.ts` source imports now compile cleanly, `import.meta` is supported during `npm run build`, and the package lock version is back in sync with the release version.

## Panel 1.0.5 Update

WhiteOwl 1.0.5 adds native dashboard surfaces for **Announce Sniper** and **HL Perps**. Announce Sniper watches GMGN Twitter/news events for high-impact token announcements, sanitizes noisy social/HTML text, scores long/short patterns, supports manual approval, and can feed announcement-aware risk and sniper sizing. HL Perps adds a Hyperliquid adapter with live and paper execution, signed live order routing, marks, funding, announcement-driven shorts, and encrypted Hyperliquid API settings in `Settings -> API Keys`.

## Companion Extension

WhiteOwl is designed as a two-part stack:

- [WhiteOwl](https://github.com/whiteowl-engine/WhiteOwl) is the main local panel, backend runtime, AI agent layer, market dashboard, jobs surface, and automation desk.
- [WhiteOwl Extension](https://github.com/whiteowl-engine/WhiteOwl-Extension) is the browser wallet, provider bridge, connected-site layer, inspector, and in-browser side panel.

Run them together for the full workflow: the panel provides the runtime and backend services, while the extension provides the browser-native wallet and page context layer that feeds directly into the desk.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/whiteowl-engine/WhiteOwl-Extension/main/screenshots/wallet-overview.png" alt="WhiteOwl Extension wallet" width="100%">
      <p><strong>Wallet companion</strong><br>The extension carries wallet actions, connected-site state, and browser-local controls next to the main panel.</p>
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/whiteowl-engine/WhiteOwl-Extension/main/screenshots/inspector-surface.png" alt="WhiteOwl Extension inspector" width="100%">
      <p><strong>Browser context layer</strong><br>Inspector and page capture flows move live browser context into the WhiteOwl panel for analysis and action.</p>
    </td>
  </tr>
</table>

## What Is WhiteOwl?

WhiteOwl is a local-first trading panel designed for fast operator workflows around Solana memecoins. It combines a browser dashboard, AI agent layer, market scanners, wallet tooling, and automation primitives in one runtime.

The current public build exposes the main dashboard, agent chat, portfolio, wallet, token explorer, news and X feeds, live events, jobs, projects, skills, terminal, settings, and the autonomous trading surface. Runtime data stays local in `data/`, and secrets stay out of Git via `.gitignore`.

## Features

- **Web Dashboard** — Full-featured trading panel with real-time data, charts, and controls
- **Multi-Agent System** — Configurable agents (Strategy Commander, Coder, Shit Trader) with independent skills and autonomy levels
- **31 Plugin Skills, 224 Tools** — Modular architecture covering trading, analysis, market intel, portfolio, perps, announcements, and automation
- **Multi-LLM Support** — OpenAI, Anthropic Claude, Google Gemini, xAI Grok, Groq, DeepSeek, Ollama (local), OpenRouter, Mistral, Cerebras, Together, Fireworks, GitHub Copilot (free via OAuth), Azure OpenAI, AWS Bedrock, Vertex AI, Kiro aggregator, and more
- **Autonomous Trading** — Shit Trader surface with paper trading, execution profiles, risk engine, and market connections to Axiom and Pump.fun
- **Live Events** — Real-time event streaming via WebSocket with full AI activity log
- **Risk Management** — Hard limits on position size, daily loss, exposure. Emergency stop. AI cannot bypass
- **Token Explorer** — Search by address/symbol/name, market cap, volume, transaction count with KOTH/HOT badges
- **Copy Trading** — Mirror trades from tracked smart money wallets
- **Token Analysis** — Holder distribution, dev wallet checks, rug detection, security audit, curve analysis
- **News Aggregation** — Multi-source news feed with category filters (Crypto, Politics, Tech, DeFi, Solana, etc.)
- **Announce Sniper** - High-signal announcement detector for buybacks, burns, listings, partnerships, exploits, and manual/auto execution flows
- **HL Perps** - Native Hyperliquid perp desk with funding, mark prices, live or paper positions, and encrypted API settings
- **X Tracker** — Real-time Twitter/X monitoring with KOL tracking
- **GMGN Integration** — Token data, security analysis, holder intelligence
- **Axiom Integration** — Direct REST API integration with axiom.trade
- **Browser Automation** — Full browser control via CDP for Axiom, Twitter, GMGN and any site
- **Background Jobs** — Scheduled monitoring tasks (Hot Posts Tracker, Live Monitoring)
- **Multi-Wallet** — Multiple Solana wallets with multisig vault support
- **Project Workspace** — Local filesystem access for AI code generation
- **Built-in Terminal** — Persistent terminal sessions for AI agents
- **SQLite Memory** — All tokens, trades, snapshots, analysis persisted locally

## Quick Start

```powershell
git clone https://github.com/whiteowl-engine/WhiteOwl.git
cd WhiteOwl
npm install
Copy-Item .env.example .env
npm start                # http://localhost:3377
```

macOS/Linux:

```bash
cp .env.example .env
```

Minimal `.env` values:

```env
SOLANA_RPC_URL=
HELIUS_API_KEY=
```

LLM can be configured through the Settings page in the panel (GitHub Copilot OAuth for free access, or add API keys for any supported provider).

Companion extension repo:

```text
https://github.com/whiteowl-engine/WhiteOwl-Extension
```

| Command | Description |
|---------|-------------|
| `npm start` | Start the panel (http://localhost:3377) |
| `npm run dev` | Development mode with hot reload |
| `npm run autopilot` | Full autonomous trading |
| `npm run monitor` | Watch-only, no trades |

## Dashboard Surfaces

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
| **Announce Sniper** | Native announcement detection desk with active/history queues, score thresholds, paper/live controls, and manual approval |
| **HL Perps** | Hyperliquid perp surface with funding rates, mark prices, live or paper position controls, and announcement-short bridge |
| **Skills** | 31 skills and 224 tools organized by category (Trading, Analysis, Market Intel, Portfolio, Perps, Other) |
| **Projects** | Local AI project workspace with file management |
| **Terminal** | Built-in terminal with AI Agent and manual tabs |
| **Settings** | RPC configuration, OAuth / AI model selection, browser CDP connection, system health |

## Skill System

31 skills organized by category:

**Trading**
| Skill | Tools | Description |
|-------|-------|-------------|
| shit-trader | 19 | Unified shitcoin trading — manual buy/sell via Pump SDK + Jupiter |
| advanced-trader | 15 | DCA, trailing stop-loss, grid trading, graduation sniping |
| exit-optimizer | 7 | AI exit strategy — profit-taking, trailing stops, volume decay |
| copy-trade | 4 | Automated copy trading from tracked wallets |
| hyperliquid-perp | 7 | Hyperliquid perp adapter with live and paper execution, marks, funding, positions, and bearish-announcement short bridge |

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
| announcement-sniper | 9 | Announcement detector for buybacks, burns, listings, partnerships, exploits, and manual approval workflows |

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

Total: **31 skills**, **224 tools** available to AI agents.

Representative runtime skills include `pump-monitor`, `token-analyzer`, `shit-trader`, `announcement-sniper`, `hyperliquid-perp`, `portfolio`, `wallet-tracker`, `gmgn`, `browser-eye`, `projects`, `terminal`, `background-jobs`, `ai-memory`, and `news-search`.

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

## Project Structure

```
WhiteOwl/
├── src/
│   ├── api/            # Express server, news provider, CRX builder
│   ├── core/           # Agent runner, browser, scheduler, risk, events
│   ├── lib/            # Pump SDK, cabalspy
│   ├── llm/            # Multi-provider LLM layer (OpenAI, Anthropic, Gemini, ...)
│   ├── memory/         # SQLite store, token/trade/news persistence
│   ├── skills/         # 31 modular skill plugins (224 tools)
│   └── wallet/         # Solana wallet, multisig, multi-wallet
├── public/             # Dashboard frontend (HTML/JS/CSS)
├── data/               # Runtime data (gitignored)
└── .env                # API keys & config (gitignored)
```

## Development

```bash
npm run build            # Compile TypeScript
npm run dev              # Development mode with hot reload
npm start                # Run via tsx from source
npx tsc --noEmit         # Type checking
```

## Disclaimer

This software is for educational and research purposes. Trading memecoins is extremely risky. You can lose all invested funds. The authors are not responsible for any financial losses. Use at your own risk.

## License

MIT
