# Architecture

WhiteOwl is a single Node.js process written in TypeScript. It bundles a web server, AI agent runtime, WebSocket event bus, blockchain integrations, and a local SQLite database.

---

## Project Structure

```
WhiteOwl/
├── src/
│   ├── index.ts          # Entrypoint — CLI, mode dispatch, graceful shutdown
│   ├── runtime.ts        # Central Runtime class — wires all subsystems together
│   ├── config.ts         # Config loader (env vars, YAML, JSON)
│   ├── logger.ts         # Structured logger
│   ├── types.ts          # Shared TypeScript types and interfaces
│   │
│   ├── api/              # HTTP / WebSocket server
│   │   ├── server.ts     # Express app, REST routes, WS server
│   │   └── ...
│   │
│   ├── core/             # Agent runtime and supporting services
│   │   ├── agent-runner.ts      # Per-agent LLM loop + tool execution
│   │   ├── auto-approve.ts      # Tool call approval gate
│   │   ├── browser.ts           # Puppeteer/CDP browser service
│   │   ├── decision-engine.ts   # Decision explanation + daily reports
│   │   ├── event-bus.ts         # In-process event bus + history
│   │   ├── job-manager.ts       # Background job scheduler
│   │   ├── market-state.ts      # Market context snapshot builder
│   │   ├── mcp-client.ts        # MCP (Model Context Protocol) client
│   │   ├── metrics.ts           # Metrics collection + backup management
│   │   ├── multi-agent.ts       # Multi-agent coordinator
│   │   ├── news-processor.ts    # News ingestion and enrichment
│   │   ├── news-scheduler.ts    # Periodic news fetch scheduler
│   │   ├── news-signals.ts      # News → trading signal conversion
│   │   ├── oauth-manager.ts     # OAuth device-flow token management
│   │   ├── privacy-guard.ts     # Scrubs secrets from LLM prompts
│   │   ├── risk-manager.ts      # Hard trade limits and emergency stop
│   │   ├── scheduler.ts         # General-purpose task scheduler
│   │   ├── shared-terminal.ts   # Shared PTY terminal sessions
│   │   ├── skill-loader.ts      # Skill plugin loader
│   │   ├── sniper-job.ts        # Graduation sniper background job
│   │   ├── sniper-prompt.ts     # Prompt builder for sniper agent
│   │   ├── sol-price.ts         # SOL/USD price feed
│   │   ├── strategy.ts          # Strategy engine (YAML strategies)
│   │   └── trend-context.ts     # Token trend context builder
│   │
│   ├── llm/              # LLM provider abstraction layer
│   │   ├── index.ts             # Provider factory + fallback logic
│   │   ├── providers.ts         # Provider registry and OAuth integration
│   │   └── ...                  # Per-provider implementations
│   │
│   ├── memory/           # Persistence layer (SQLite)
│   │   ├── index.ts             # Memory facade + DB init
│   │   ├── database.ts          # SQLite schema and migrations
│   │   ├── token-store.ts       # Token data persistence
│   │   ├── trade-log.ts         # Trade history
│   │   ├── news-store.ts        # News article store
│   │   └── contextual-memory.ts # AI working memory (notes, analyses)
│   │
│   ├── skills/           # Skill plugin modules
│   │   ├── index.ts             # Skill registry
│   │   ├── shit-trader.ts
│   │   ├── token-analyzer.ts
│   │   └── ... (29 total)
│   │
│   ├── lib/              # Low-level libraries
│   │   ├── pump-sdk/            # pump.fun SDK wrapper
│   │   └── cabalspy/            # On-chain intelligence utilities
│   │
│   └── wallet/           # Solana wallet layer
│       ├── solana.ts            # Single-wallet keypair management
│       └── multi-wallet.ts      # Multi-wallet + multisig (Squads)
│
├── public/               # Static dashboard frontend
│   ├── index.html        # Single-page application shell
│   └── ...               # CSS, JS, SVG assets
│
├── data/                 # Runtime data (git-ignored)
│   ├── whiteowl.db       # SQLite database
│   ├── rpc-config.json
│   ├── model-config.json
│   └── api-keys.enc
│
├── strategies/           # Optional YAML strategy files (git-ignored by default)
├── .env                  # Secrets (git-ignored)
├── .env.example          # Template
├── package.json
└── tsconfig.json
```

---

## Runtime Startup Sequence

1. Load `.env` file into `process.env`
2. Initialise `OAuthManager` (restore saved tokens)
3. Load `AppConfig` (from env, persisted RPC config, or YAML file)
4. Initialise SQLite database engine (`initDatabaseEngine`)
5. Construct `Runtime` instance (wires EventBus, SkillLoader, RiskManager, etc.)
6. Load YAML strategy files from `./strategies/`
7. Boot Runtime: init wallet, load skills, create agents, start schedulers
8. Start Express API server on configured port (default: 3377)
9. Enter selected run mode (server / monitor / autopilot / interactive)

---

## Key Subsystems

### EventBus
In-process pub/sub bus. All components emit and subscribe to typed events. History of last N events is kept in memory and served via `GET /api/events` and the WebSocket stream.

### SkillLoader
Dynamically loads all skill modules from `src/skills/`. Each module exports a `SkillManifest` with a list of `ToolDefinition` objects. The loader makes all tools available to `AgentRunner` via a single `executeTool(name, args)` interface.

### AgentRunner
Core LLM loop for a single agent:
1. Build system prompt (role + context + available tools)
2. Call LLM with the current conversation history
3. If response contains tool calls → execute via SkillLoader → append results → repeat
4. When response is final → return to caller

### RiskManager
Stateful guard that tracks current positions, daily P&L, and loss streaks. Every trade passes through `checkTrade()` before execution.

### Memory (SQLite)
All persistent state is stored in a single `data/whiteowl.db` SQLite file:
- **tokens** — Token metadata and snapshots
- **trades** — Trade history with P&L
- **sessions** — Trading session records
- **news** — Aggregated news articles
- **memory** — AI working memory (notes, analyses)
- **jobs** — Background job history

### BrowserService
Manages a Puppeteer/CDP connection to a Chromium browser. Used by the `browser-eye` skill for autonomous web navigation. Supports both bundled Chromium and an external browser connected via CDP URL.

---

## Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript 5.x |
| Runtime | Node.js ≥ 18 (ESM modules) |
| Web Framework | Express 4 |
| WebSocket | `ws` library |
| Database | SQLite via `better-sqlite3` |
| Blockchain | `@solana/web3.js`, `@pump-fun/pump-sdk`, `@sqds/multisig` |
| Browser Automation | Puppeteer + puppeteer-extra-plugin-stealth |
| Terminal | `node-pty` |
| Config | YAML via `yaml`, env via `dotenv` |
| Validation | Zod |
| Build | `tsc` + `tsx` (no bundler needed) |
