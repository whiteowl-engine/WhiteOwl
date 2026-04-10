# Dashboard

The WhiteOwl dashboard runs at **http://localhost:3377** and is organised into the following surfaces (pages).

---

## Dashboard (Home)

The main landing page shows:

- **P&L Overview** — Current session profit/loss in SOL
- **Session Info** — Active session ID, mode, duration
- **Recent Trades** — Last executed trades with token, entry/exit, and result
- **AI Explanations** — Plain-language summaries of recent agent decisions

---

## AI Chat

A multi-agent operator console for direct interaction with AI agents.

- Select which agent to chat with (Strategy Commander, Coder, Shit Trader, or any custom agent)
- Switch models mid-conversation
- Set **Auto-Approve Level** — controls how many agent tool calls are executed automatically without manual confirmation (levels: Off, Low, Medium, High, Full)
- View streamed reasoning tokens as they arrive
- Persistent conversation history per session

---

## Portfolio

- **PNL Summary** — Aggregate profit/loss across all tokens
- **SPL Token Balances** — Current holdings fetched from the connected wallet
- **Trade History** — Local SQLite log + GMGN trade history merged

---

## Wallet

- **Multi-Wallet Management** — Add, switch, and delete Solana keypairs
- **Deposit / Withdraw** — Generate QR codes for deposits; sign withdrawal transactions
- **Import / Export** — Import keypairs from seed phrase or private key; export with encryption
- **Multisig Vaults** — Create and manage Squads multisig vaults (via `@sqds/multisig`)

---

## Token Explorer

Search and browse Solana tokens:

- Search by mint address, symbol, or name
- Filter by market cap, volume, and transaction count
- Time-frame filters: **1H**, **6H**, **24H**
- **KOTH** (King of the Hill) and **HOT** badges
- Click any token to open a full detail view with chart, holders, and security audit

---

## AI Activity

Real-time log of every AI decision:

- LLM prompt/response pairs
- Tool calls and their results
- Token usage per request
- Reasoning steps (for supported models)

Useful for auditing what the AI is doing and why.

---

## Live Events

Full event stream from all system components, delivered via WebSocket. Events include:

- Trade signals and executions
- Risk manager decisions (approved / blocked)
- Skill calls and responses
- Session state changes
- Background job completions

---

## News

Aggregated crypto news feed:

- Sources: Reddit, Hacker News, Decrypt, and more
- Category filters: **Crypto**, **Solana**, **DeFi**, **Politics**, **Tech**, and others
- News items are enriched and stored locally for AI consumption

---

## X Tracker

Real-time Twitter/X monitoring:

- Filter by handle, keyword, or specific tweet URL
- KOL (Key Opinion Leader) tracking list
- LLM-powered sentiment and relevance scoring
- Feed data is available to the `social-monitor` skill

---

## Agent

Agent management cards showing:

- Agent role and name
- Current autonomy level
- Active LLM model
- Token usage stats
- Assigned skill set
- Quick-chat button

---

## Background Jobs

Scheduled monitoring tasks:

- **Hot Posts Tracker** — Periodically scans social platforms for trending tokens
- **Live Monitoring** — Continuous pump.fun + market data polling

Each job card shows: run count, last run time, current status, and last result.

---

## Shit Trader

The autonomous trading surface. Two modes:

| Mode | Description |
|---|---|
| **Paper** | Simulated trades — no real SOL spent, all logic runs normally |
| **Live** | Real trades executed on-chain via Jupiter / Pump SDK |

Key panels:

- **Execution Profile** — Strategy selection, trade size, slippage, priority fee
- **Risk Engine** — Set hard limits (position size, daily loss, max exposure, emergency stop)
- **Market Connections** — Axiom and Pump.fun live data feeds
- **Active Positions** — Open positions with real-time P&L
- **Trade Log** — Executed trades this session

---

## Skills

Browse all 29 installed skills and 208 tools:

- Organised by category: **Trading**, **Analysis**, **Market Intel**, **Portfolio**, **Other**
- Each skill card shows: name, version, tool count, and description
- Expandable tool list with parameter details

See [Skill System](Skill-System.md) for full documentation.

---

## Projects

Local AI project workspace:

- File browser for any directory on the host machine
- AI agents can read, write, and execute files via the `projects` skill
- Useful for AI-assisted code generation and script automation

---

## Terminal

Built-in terminal with two tabs:

- **AI Agent** — Terminal session that AI agents can write to and read from
- **Manual** — Standard interactive terminal for the operator

Powered by `node-pty` and exposed to the `terminal` skill (4 tools: `run`, `read`, `write`, `kill`).

---

## Settings

System configuration page:

- **RPC** — Solana RPC URL and Helius API key
- **AI Models** — API key management, OAuth connections (GitHub Copilot, Google, Azure)
- **Browser** — Chrome DevTools Protocol (CDP) URL for browser automation
- **System Health** — Runtime diagnostics and skill load status
