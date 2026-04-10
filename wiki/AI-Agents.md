# AI Agents

WhiteOwl uses a **multi-agent architecture** — multiple AI agents run concurrently, each with a distinct role, model, autonomy level, and skill set.

---

## Default Agents

### Strategy Commander
- **Role** — High-level strategic decision making
- **Default Model** — GPT-4o / Claude Sonnet (configurable)
- **Key Skills** — `token-analyzer`, `portfolio`, `alpha-scanner`, `social-monitor`, `news-search`
- **Responsibility** — Evaluates market context and signals; directs the trading agent

### Shit Trader
- **Role** — Trade execution
- **Default Model** — GPT-4o-mini / Claude Haiku (fast/cheap model recommended)
- **Key Skills** — `shit-trader`, `advanced-trader`, `exit-optimizer`, `copy-trade`, `curve-analyzer`, `pump-monitor`
- **Responsibility** — Executes buy/sell orders, manages positions, applies exit logic

### Coder
- **Role** — Development and automation
- **Default Model** — GPT-4o / Claude Sonnet
- **Key Skills** — `projects`, `terminal`, `web-search`, `skill-builder`, `browser-eye`
- **Responsibility** — AI-assisted code generation, script automation, local file management

Custom agents can be added through the **Agent** page in the dashboard.

---

## Autonomy Levels

Each agent has a configurable **Auto-Approve Level** that controls how many tool calls are executed automatically without operator confirmation:

| Level | Behaviour |
|---|---|
| **Off** | Every tool call requires manual approval |
| **Low** | Read-only tools approved automatically; write/trade tools require confirmation |
| **Medium** | Non-financial tools auto-approved; trade executions require confirmation |
| **High** | All tools auto-approved except irreversible actions (e.g., live trades above a threshold) |
| **Full** | All tool calls executed immediately with no confirmation |

Set the level per-agent in the **AI Chat** surface or on the **Agent** page.

> ⚠️ **Full autonomy** means the agent can execute real trades without any human confirmation. Only enable this if you trust your risk limits and strategy.

---

## Multi-Agent Coordination

The `MultiAgentCoordinator` (`src/core/multi-agent.ts`) allows agents to collaborate:

- **Delegation** — Strategy Commander can assign subtasks to Shit Trader or Coder
- **Shared Context** — All agents read from the same `MarketState` and event bus
- **Result Aggregation** — Coordinator merges agent outputs into a unified decision

---

## Agent Runner

Each agent is managed by an `AgentRunner` instance (`src/core/agent-runner.ts`):

- Maintains conversation history for the session
- Handles tool execution loop (call → result → next call)
- Enforces autonomy level gates
- Tracks decision count, token usage, and errors
- Emits events to the `EventBus` on every decision

---

## Auto-Approve Manager

`AutoApproveManager` (`src/core/auto-approve.ts`) is a centralised gate that all tool calls pass through before execution. It enforces autonomy level rules and can be updated at runtime without restarting the agent.

---

## Decision Engine

`DecisionExplainer` (`src/core/decision-engine.ts`) generates plain-language explanations of agent decisions, visible in the **Dashboard** surface and the **AI Activity** log.

`DailyReportGenerator` produces end-of-session trading summaries.

---

## Privacy Guard

`PrivacyGuard` (`src/core/privacy-guard.ts`) scrubs sensitive data (private keys, seed phrases, API keys) from all LLM prompts before they leave the local machine. This runs on every message regardless of autonomy level.

---

## Context Memory

`ContextualMemory` provides each agent with a rolling window of relevant context:

- Recent token analyses
- Past trade outcomes for the same token
- Stored AI memory notes
- Current market state snapshot

This context is injected automatically into each agent prompt to reduce hallucinations and improve decision quality.

---

## Adding Custom Agents

1. Go to the **Agent** page in the dashboard
2. Click **Add Agent**
3. Set: name, role description, model, autonomy level, and skill assignments
4. The agent is immediately available in **AI Chat** and via the API (`POST /api/chat`)

Custom agents can also be defined in a YAML config file — see [Configuration](Configuration.md).
