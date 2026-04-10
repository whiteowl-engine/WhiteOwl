# Skill System

WhiteOwl exposes AI agent capabilities through a modular **skill** system. Each skill is a plugin (`src/skills/*.ts`) that exports a manifest containing one or more **tools**. Tools are the atomic functions that LLMs call via function-calling / tool-use APIs.

**29 skills · 208 tools**

---

## Trading Skills

### `shit-trader` — 19 tools
Unified shitcoin trading via Pump SDK and Jupiter aggregator.  
Covers manual buy/sell, slippage management, priority fee control, on-chain execution, and order tracking.

### `advanced-trader` — 15 tools
Advanced order types built on top of the base trader:
- DCA (Dollar-Cost Averaging) orders
- Trailing stop-loss
- Grid trading
- Graduation sniping (catch tokens migrating from pump.fun to Raydium)

### `exit-optimizer` — 7 tools
AI-driven exit strategy engine:
- Dynamic profit-taking levels
- Trailing stop adjustments based on momentum
- Volume decay detection for early exits

### `copy-trade` — 4 tools
Automated copy trading:
- Follow any on-chain wallet
- Mirror buy/sell actions with configurable size scaling
- Whitelist/blacklist tokens

---

## Analysis Skills

### `token-analyzer` — 10 tools
Comprehensive token analysis:
- Metadata fetch (name, symbol, description, socials)
- Holder distribution snapshot
- Dev wallet identification
- Rug detection heuristics
- Market cap and volume trends

### `token-security` — 5 tools
On-chain security auditor:
- Mint authority check (can new tokens be minted?)
- Freeze authority check
- Liquidity pool lock status
- Metadata immutability
- Creator wallet history

### `curve-analyzer` — 8 tools
Real-time bonding curve analysis via pump SDK:
- Current curve progress percentage
- Virtual SOL/token reserves
- Price impact simulation
- Buy/sell pressure analysis

### `holder-intelligence` — 8 tools
Deep on-chain holder analysis:
- Top holder wallets with percentage breakdown
- pump.fun tokenomics (team allocation, vesting)
- Insider vs. organic holder ratio
- Wallet age and activity scoring

### `volume-detector` — 8 tools
Volume anomaly detection:
- Wash trading identification
- Volume spike alerts
- Organic vs. artificial volume ratio
- Time-series volume analysis

---

## Market Intel Skills

### `pump-monitor` — 35 tools
Full pump.fun integration — the largest skill by tool count:
- Monitor new token launches in real time
- On-chain data: bonding curve state, creator info
- KOTH (King of the Hill) tracking
- Graduation event detection
- Token metadata enrichment
- WebSocket stream management

### `social-monitor` — 14 tools
Social media intelligence:
- Real KOL (Key Opinion Leader) tracking
- Twitter/X feed monitoring
- LLM-powered NLP for sentiment scoring
- Telegram channel monitoring
- Alert generation on keyword matches

### `alpha-scanner` — 12 tools
Early alpha detection across multiple sources:
- Telegram group scanning
- Twitter alpha account monitoring
- Secondary site scraping
- New token alert aggregation and deduplication

---

## Portfolio Skills

### `portfolio` — 9 tools
Position and P&L management:
- Current open positions with entry price
- Realised and unrealised P&L
- Portfolio allocation percentages
- Session and historical reports

### `wallet-tracker` — 8 tools
Smart money wallet tracking:
- Track any Solana wallet address
- Real-time trade monitoring
- Copy signal generation
- Wallet profiling (win rate, preferred tokens, average hold time)

---

## Other Skills

### `projects` — 28 tools
Local filesystem access — the largest "other" skill:
- Read and write files anywhere on the host machine
- Execute shell commands
- Directory listing and management
- AI-assisted code generation workflows

### `browser-eye` — 24 tools
Full autonomous browser control via Chrome DevTools Protocol (CDP):
- Navigate to any URL
- Click, type, scroll, screenshot
- Extract page content and DOM elements
- Works with Axiom, Twitter/X, GMGN, and any site

### `blockchain` — 11 tools
Solana on-chain intelligence:
- Address type identification (wallet, program, token mint, etc.)
- Wallet profiling and transaction history
- Balance lookups across multiple tokens
- Program interaction analysis

### `axiom-api` — 11 tools
Direct REST API integration with [axiom.trade](https://axiom.trade):
- Token search and discovery
- Price and volume data
- Trade execution via Axiom
- Trending and new listings

### `web-intel` — 9 tools
Scrape real-time token data from Axiom and GMGN:
- Token page extraction
- Price and holder data scraping
- Used as fallback when API rate limits hit

### `gmgn` — 8 tools
[GMGN.ai](https://gmgn.ai) integration:
- Token data and analytics
- Security scoring
- Holder intelligence
- Smart money tracking signals

### `web-search` — 7 tools
Web search and content fetching:
- General web search
- Page content extraction
- Used by agents for research and news gathering

### `skill-hub` — 7 tools
Community Skill Hub:
- Browse community-published skills
- Import skill packages
- Export and share custom skills

### `insightx` — 7 tools
Advanced holder analysis:
- Cluster detection (coordinated wallets)
- Sniper identification
- Bundler detection
- Insider wallet scoring

### `background-jobs` — 7 tools
Schedule and manage background jobs:
- Create recurring monitoring tasks
- Start/stop/list jobs
- View job results and history

### `ai-memory` — 5 tools
Persistent AI memory:
- Save notes, observations, and token analyses
- Recall stored memories by key or category
- Structured memory queries via SQLite

### `skill-builder` — 4 tools
Create and manage custom skills via AI:
- Generate a new skill scaffold from a description
- Hot-load skills at runtime without restart
- Edit and delete custom skills

### `terminal` — 4 tools
Persistent shared terminal sessions:
- `run` — Execute a command
- `read` — Read terminal output
- `write` — Send input to terminal
- `kill` — Terminate a session

### `news-search` — 3 tools
Search and browse aggregated crypto news:
- Full-text search across the local news store
- Category filtering
- Recent headlines summary

### `screenshot` — 1 tool
Take a screenshot of any web page URL and return it as an image.

---

## Skill Loading

Skills are loaded at runtime by `SkillLoader` (`src/core/skill-loader.ts`). Each skill module exports:

```typescript
export const manifest: SkillManifest = {
  name: 'skill-name',
  version: '1.0.0',
  description: '...',
  tools: [ /* ToolDefinition[] */ ],
};
```

Custom skills (created via `skill-builder`) are loaded dynamically and survive restarts if saved to the skills directory.

---

## Representative Runtime Skills

The following skills are always loaded by the default agent configurations: `pump-monitor`, `token-analyzer`, `shit-trader`, `portfolio`, `wallet-tracker`, `gmgn`, `browser-eye`, `projects`, `terminal`, `background-jobs`, `ai-memory`, `news-search`.
