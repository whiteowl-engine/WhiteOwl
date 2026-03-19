# WhiteOwl

AI-powered trading shell for Solana memecoins. Autonomous monitoring, analysis and execution on pump.fun with full plugin architecture.

## Features

- **Multi-Agent System** — Specialized agents for scanning, trading, and portfolio management
- **Plugin Skills** — Modular architecture. Add new data sources, exchanges, strategies without touching core code
- **Multi-LLM Support** — OpenAI, Anthropic Claude, Ollama (local), Groq, DeepSeek
- **Autonomous Modes** — Run unattended for 24h+ with configurable risk limits
- **Live Monitoring** — REST API + WebSocket for real-time event streaming
- **Risk Management** — Hard limits on position size, daily loss, exposure. Emergency stop. AI cannot bypass
- **YAML Strategies** — Define entry/exit rules, take-profit levels, stop-loss, filters in simple YAML
- **Copy Trading** — Mirror trades from tracked smart money wallets
- **Token Analysis** — Holder distribution, dev wallet checks, rug detection, social scoring
- **DexScreener Integration** — Price data, liquidity, trending tokens
- **SQLite Memory** — All tokens, trades, snapshots, analysis persisted locally

## Quick Start

```bash
# Clone
git clone https://github.com/yourname/WhiteOwl.git
cd WhiteOwl

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your keys (at minimum: one LLM key + Solana RPC)

# Run interactive mode
npm start

# Or specific modes
npm run monitor          # Watch-only, no trades
npm run autopilot        # Full autonomous trading
npm run report           # Print 24h report and exit
```

## Configuration

### Environment Variables (.env)

```bash
# LLM Providers (at least one required)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OLLAMA_BASE_URL=http://localhost:11434

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=your-helius-key        # Optional, enables enriched data
WALLET_PRIVATE_KEY=your-bs58-key      # Or path to keypair JSON

# Risk Limits
MAX_POSITION_SOL=0.5
MAX_OPEN_POSITIONS=5
MAX_DAILY_LOSS_SOL=2
EMERGENCY_STOP_LOSS_SOL=5

# API
API_PORT=3377
API_KEY=                              # Optional, for API auth

# Notifications (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### YAML Config

For full control, create `config.yaml`:

```yaml
rpc:
  solana: "https://api.mainnet-beta.solana.com"
  helius: "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"

api:
  port: 3377
  key: "your-api-key"

risk:
  maxPositionSol: 0.5
  maxOpenPositions: 5
  maxDailyLossSol: 2
  maxDrawdownPercent: 50
  emergencyStopLossSol: 5

memory:
  dbPath: "./data/WhiteOwl.db"
```

## Modes

| Mode | Description |
|------|-------------|
| `monitor` | Watch token launches and analyze. No trades executed |
| `advisor` | Analyze and recommend, but require manual approval |
| `autopilot` | Fully autonomous trading within risk limits |
| `manual` | CLI-driven, agents only respond to direct commands |

## Strategies

Strategies are YAML files in `./strategies/`. Four built-in strategies included:

### degen-sniper

Early entry on new launches. High risk, high reward. Enters low on bonding curve, exits at 2-5x.

### smart-money-follow

Follow smart money wallet trades with conservative sizing. Requires wallet tracking setup.

### graduated-only

Conservative. Only trades tokens that graduated to DEX with established volume and holders.

### scalper

Ultra-fast flips targeting 20-50% gains in under 10 minutes.

### Custom Strategies

```yaml
name: my-strategy
description: Custom entry/exit rules

entry:
  conditions:
    - bondingCurveProgress < 20
    - holders >= 10
    - score >= 60
  buy:
    amount_sol: 0.1
    slippage_bps: 1500
    priority_fee_sol: 0.005

exit:
  take_profit:
    - at: 2.0        # 2x
      sell_percent: 50
    - at: 5.0        # 5x
      sell_percent: 100
  stop_loss_percent: 40
  timeout_minutes: 60
  timeout_action: sell

filters:
  blacklist_patterns: ["test", "scam"]
  min_score: 60
```

Available condition fields: `bondingCurveProgress`, `holders`, `marketCap`, `volume24h`, `price`, `priceChange5m`, `priceChange1h`, `priceChange24h`, `score`, `rugScore`.

## Skills

| Skill | Tools | Description |
|-------|-------|-------------|
| pump-monitor | 5 | WebSocket monitoring of pump.fun launches |
| token-analyzer | 5 | Token scoring, holder analysis, rug detection |
| pump-trader | 4 | Buy/sell via Jupiter aggregator |
| portfolio | 8 | Position tracking, P&L, health checks, reports |
| wallet-tracker | 8 | Smart money tracking, Helius integration |
| social-monitor | 6 | Social media mentions, sentiment, KOL tracking |
| dex-screener | 6 | DexScreener price data, liquidity, trending |
| copy-trade | 4 | Automated copy trading from tracked wallets |

Total: **46 tools** available to AI agents.

## Architecture

```
┌─────────────────────────────────────────────┐
│                   CLI / REPL                 │
├─────────────────────────────────────────────┤
│              Runtime Orchestrator            │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Agents  │ │ Strategy │ │ Risk Manager │ │
│  │ Scanner │ │  Engine   │ │  (Hard Wall) │ │
│  │ Trader  │ │           │ │              │ │
│  │ Manager │ │           │ │              │ │
│  └────┬────┘ └──────────┘ └──────────────┘ │
│       │                                      │
│  ┌────▼──────────────────────────────────┐  │
│  │            Event Bus                   │  │
│  └────┬──────────────────────────────────┘  │
│       │                                      │
│  ┌────▼──────────────────────────────────┐  │
│  │           Skill Layer                  │  │
│  │  pump-monitor │ token-analyzer │ ...   │  │
│  └────┬──────────────────────────────────┘  │
│       │                                      │
│  ┌────▼─────┐  ┌──────────┐  ┌──────────┐  │
│  │  LLM     │  │  Memory  │  │  Wallet  │  │
│  │ Adapters │  │  SQLite  │  │  Solana  │  │
│  └──────────┘  └──────────┘  └──────────┘  │
├─────────────────────────────────────────────┤
│           API Server (REST + WS)            │
└─────────────────────────────────────────────┘
```

### Event Flow

1. **pump-monitor** detects new token → emits `token:new`
2. **Scanner agent** triggered → calls token-analyzer tools → emits `signal:buy` (score > 70)
3. **Trader agent** triggered → checks strategy → creates `trade:intent`
4. **Risk Manager** validates → emits `trade:approved` or `trade:rejected`
5. **pump-trader** executes swap → emits `trade:executed`
6. **Portfolio Manager** tracks position → periodic `position:updated`
7. On exit signal → partial/full sell → `position:closed`

## API

### REST Endpoints

```
GET  /api/status              System status + wallet balance
GET  /api/stats               Current session stats
GET  /api/stats/:period       Stats for period (1h, 4h, 24h, 7d, all)
GET  /api/trades              Trade history
GET  /api/tokens/trending     Trending tokens
GET  /api/tokens/top/:period  Top tokens by volume/mcap/holders
GET  /api/tokens/:mint        Token details + analysis
GET  /api/events              Recent event log
GET  /api/strategies          Loaded strategies
GET  /api/skills              Available skills + tools
GET  /api/sessions            Session history
POST /api/session/start       Start trading session
POST /api/session/stop        Stop session
POST /api/session/pause       Pause session
POST /api/session/resume      Resume session
POST /api/chat                Chat with agent
```

### WebSocket

Connect to `ws://localhost:3377/ws` for live events:

```json
// Subscribe to events
{"type": "subscribe", "event": "*"}
{"type": "subscribe", "event": "trade:executed"}

// Incoming events
{"event": "token:new", "data": {...}, "timestamp": 1700000000000}
{"event": "signal:buy", "data": {...}, "timestamp": 1700000000001}
```

## CLI Commands

```
help          Show available commands
status        Show system status
balance       Check wallet balance
start <mode>  Start session (monitor|advisor|autopilot|manual)
stop          Stop current session
pause/resume  Pause/resume session
report        Show session stats
chat <agent>  Chat with specific agent
agents        List active agents
skills        List loaded skills
strategies    List strategies
events        Recent event log
trending      Trending tokens
quit          Shutdown
```

Any unrecognized input is sent to the scanner agent as a chat message.

## Adding Custom Skills

```typescript
import { Skill, SkillManifest, SkillContext } from './types';

export class MySkill implements Skill {
  manifest: SkillManifest = {
    name: 'my-skill',
    version: '1.0.0',
    description: 'Description of what this skill does',
    tools: [
      {
        name: 'my_tool',
        description: 'What this tool does',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Tool input' },
          },
          required: ['input'],
        },
        riskLevel: 'read',
      },
    ],
  };

  async initialize(ctx: SkillContext): Promise<void> {
    // Access ctx.eventBus, ctx.memory, ctx.logger, ctx.wallet
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'my_tool':
        return { result: 'done' };
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}
}
```

Register in `src/skills/index.ts` and the agents will discover it automatically.

## Risk Management

The Risk Manager enforces hard limits that **no agent can bypass**:

- **Position Size**: Max SOL per single trade
- **Open Positions**: Max concurrent positions
- **Daily Loss**: Trading pauses after hitting daily loss limit
- **Total Exposure**: Sum of all position sizes capped
- **Emergency Stop**: Kills all trading if total loss exceeds threshold
- **Loss Streak Cooldown**: Automatic pause after consecutive losses

All trade intents go through the Risk Manager before execution. This is a hard wall between AI decisions and on-chain transactions.

## Development

```bash
# Build
npm run build

# Development mode with hot reload
npm run dev

# Type checking
npx tsc --noEmit
```

## Project Structure

```
WhiteOwl/
├── src/
│   ├── index.ts              Entry point + CLI
│   ├── runtime.ts            Orchestrator / session manager
│   ├── types.ts              Type definitions
│   ├── config.ts             Config loader
│   ├── logger.ts             Logger
│   ├── core/
│   │   ├── event-bus.ts      Typed event system
│   │   ├── skill-loader.ts   Skill registry
│   │   ├── agent-runner.ts   LLM agent with tool loop
│   │   ├── risk-manager.ts   Risk enforcement
│   │   ├── strategy.ts       Strategy evaluation
│   │   └── scheduler.ts      Task scheduler
│   ├── llm/
│   │   ├── index.ts          Provider factory
│   │   └── providers.ts      OpenAI, Anthropic, Ollama
│   ├── memory/
│   │   ├── index.ts          Memory interface
│   │   ├── store.ts          SQLite schema
│   │   ├── trades.ts         Trade log
│   │   └── tokens.ts         Token store
│   ├── wallet/
│   │   └── solana.ts         Solana wallet
│   ├── skills/
│   │   ├── index.ts          Skill registry
│   │   ├── pump-monitor.ts   Pump.fun WebSocket monitor
│   │   ├── token-analyzer.ts Token analysis + scoring
│   │   ├── pump-trader.ts    Jupiter swap execution
│   │   ├── portfolio.ts      Position management
│   │   ├── wallet-tracker.ts Smart money tracking
│   │   ├── social-monitor.ts Social media monitoring
│   │   ├── dex-screener.ts   DexScreener integration
│   │   └── copy-trade.ts     Copy trading
│   └── api/
│       └── server.ts         REST + WebSocket API
├── strategies/
│   ├── degen-sniper.yaml
│   ├── smart-money-follow.yaml
│   ├── graduated-only.yaml
│   └── scalper.yaml
├── config.example.yaml
├── .env.example
├── package.json
├── tsconfig.json
└── LICENSE
```

## Disclaimer

This software is for educational and research purposes. Trading memecoins is extremely risky. You can lose all invested funds. The authors are not responsible for any financial losses. Use at your own risk. Always start with small amounts and monitor actively.

## License

MIT
