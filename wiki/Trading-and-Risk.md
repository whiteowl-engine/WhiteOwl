# Trading & Risk Management

> ⚠️ **Disclaimer** — Trading memecoins is extremely risky. You can lose all invested funds. WhiteOwl is for educational and research purposes. Use at your own risk.

---

## Session Modes

A **trading session** is the top-level runtime context. Start one with `npm run autopilot`, `npm run monitor`, or `start <mode>` in the interactive CLI.

| Mode | Description |
|---|---|
| `autopilot` | Full autonomous trading. AI agents decide what to buy, when to sell, and execute trades automatically. Default duration: 24 hours. |
| `advisor` | AI analyses the market and suggests trades, but executions require manual confirmation. |
| `monitor` | Watch-only. All scans and analysis run normally; no trades are executed. |
| `manual` | Session context is active but agents are passive — operator drives all actions. |

---

## Paper vs. Live Trading

The **Shit Trader** surface has a **Paper / Live toggle**:

| Mode | Behaviour |
|---|---|
| **Paper** | Trades are simulated. P&L is tracked in the local database. No SOL is spent. |
| **Live** | Trades are executed on-chain. Real SOL is spent. |

Paper mode is recommended for strategy testing and new setups.

---

## Execution Profile

Configurable in the Shit Trader page:

| Setting | Description |
|---|---|
| **Strategy** | Active YAML strategy file to use for signals |
| **Trade Size** | SOL amount per trade |
| **Max Position** | Maximum SOL in a single position |
| **Slippage** | Allowed price slippage percentage |
| **Priority Fee** | Solana transaction priority fee (lamports) |
| **Take Profit** | Automatic TP levels (e.g., 2x, 5x, 10x) |
| **Stop Loss** | Automatic SL percentage from entry |

---

## Risk Engine

The `RiskManager` (`src/core/risk-manager.ts`) enforces hard limits that **no AI agent can bypass**.

### Hard Limits

| Limit | Description |
|---|---|
| **Position Size** | Maximum SOL per single trade |
| **Open Positions** | Maximum number of concurrent open positions |
| **Daily Loss** | Trading pauses automatically after hitting the daily loss cap |
| **Total Exposure** | Sum of all position sizes is capped at a configured maximum |
| **Emergency Stop** | All trading is killed if total cumulative loss exceeds this threshold |
| **Loss Streak Cooldown** | Automatic pause after N consecutive losing trades |

Configure all limits in the **Risk Engine** panel on the Shit Trader page.

### How It Works

Every trade request — whether from an agent tool call or a manual action — passes through `RiskManager.checkTrade()` before execution. If any limit would be breached, the trade is blocked and an event is emitted:

```
RISK_BLOCKED: position size 0.5 SOL exceeds max 0.2 SOL
```

The risk manager state is visible in real time on the Shit Trader page.

---

## Trade Execution

Trades are executed through two routes:

### Jupiter (Swaps)
For tokens that have migrated to Raydium liquidity pools, trades use the **Jupiter aggregator** for best-price routing.

### Pump SDK
For tokens still on the pump.fun bonding curve, trades use `@pump-fun/pump-sdk` directly.

The `shit-trader` skill automatically selects the correct route based on the token's current state.

---

## Copy Trading

The `copy-trade` skill mirrors trades from a tracked smart money wallet:

1. Add a wallet address to track via the **wallet-tracker** skill or the Portfolio page
2. Activate the `copy-trade` skill for the Shit Trader agent
3. When the tracked wallet buys or sells a token, a copy signal is generated
4. The agent executes the trade (subject to risk manager approval) with configurable size scaling

---

## Advanced Order Types

Available via the `advanced-trader` skill:

| Order Type | Description |
|---|---|
| **DCA** | Buy a fixed SOL amount on a schedule regardless of price |
| **Trailing Stop-Loss** | Stop loss that moves up with price; triggers on reversal |
| **Grid Trading** | Place a grid of buy/sell orders at price intervals |
| **Graduation Sniping** | Automatically buy when a pump.fun token migrates to Raydium |

---

## Exit Optimizer

The `exit-optimizer` skill applies AI-driven exit logic:

- **Profit-taking levels** — Sell a portion of position at each TP milestone
- **Trailing stops** — Adjust SL dynamically as price moves in favour
- **Volume decay detection** — Exit early if volume drops sharply (sign of dying interest)
- **Time-based exits** — Force exit after a hold duration if price hasn't moved

---

## Strategy Files

Strategies are YAML files placed in `./strategies/`. A strategy defines:

- Entry conditions (volume spike, social signal, curve progress, etc.)
- Exit conditions (TP levels, SL, trailing stop)
- Risk parameters (overrides the global risk manager limits)
- Which agents to activate

Load a specific strategy with:

```bash
npm run autopilot -- --strategy=conservative
```

Or select it in the Shit Trader page **Execution Profile** panel.
