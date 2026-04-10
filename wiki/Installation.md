# Installation

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| npm | bundled with Node.js |
| Git | any recent version |

A Solana RPC endpoint and a Helius API key are the only **required** runtime values. Everything else (LLM keys, Telegram, etc.) is optional and can be configured later through the Settings page.

---

## Quick Start

### Windows (PowerShell)

```powershell
git clone https://github.com/whiteowl-engine/WhiteOwl.git
cd WhiteOwl
npm install
Copy-Item .env.example .env
# Edit .env — add SOLANA_RPC_URL and HELIUS_API_KEY at minimum
npm start
```

### macOS / Linux

```bash
git clone https://github.com/whiteowl-engine/WhiteOwl.git
cd WhiteOwl
npm install
cp .env.example .env
# Edit .env — add SOLANA_RPC_URL and HELIUS_API_KEY at minimum
npm start
```

The dashboard will be available at **http://localhost:3377**.

---

## Startup Commands

| Command | Description |
|---|---|
| `npm start` | Start the panel in server mode (dashboard at http://localhost:3377) |
| `npm run dev` | Development mode with hot reload |
| `npm run autopilot` | Full autonomous trading (24 h default session) |
| `npm run monitor` | Watch-only monitoring, no trades executed |
| `npm run report` | Print a 24 h trading report to the terminal |
| `npm run build` | Compile TypeScript to JavaScript |

---

## Interactive CLI

Running `npm start` (without specifying `server`) drops you into an interactive REPL:

```
whiteowl> help
```

Available CLI commands:

| Command | Usage | Description |
|---|---|---|
| `help` | `help` | Show all available commands |
| `status` | `status` | System status, wallet balance, active session |
| `balance` | `balance` | Current SOL wallet balance |
| `start` | `start <mode> [strategy] [minutes]` | Start a session (`autopilot`, `advisor`, `monitor`, `manual`) |
| `stop` | `stop` | Stop the current session |
| `pause` | `pause` | Pause the current session |
| `resume` | `resume` | Resume a paused session |
| `report` | `report` | Print session P&L stats |
| `chat` | `chat <agentId> <message>` | Send a message to a specific agent |
| `agents` | `agents` | List active agents |
| `skills` | `skills` | List loaded skill plugins |
| `strategies` | `strategies` | List available strategy files |
| `events` | `events` | Show recent system events |
| `trending` | `trending` | Show trending tokens from local store |
| `quit` / `exit` | `quit` | Graceful shutdown |

Any unrecognised input is forwarded directly to the `scanner` agent as a chat message.

---

## Runtime Data

All runtime data is stored locally in the `data/` directory (git-ignored):

```
data/
├── whiteowl.db      # SQLite database (tokens, trades, sessions, news, memory)
├── rpc-config.json  # Persisted RPC endpoint settings
├── model-config.json
├── api-keys.enc     # Encrypted API key store
└── oauth/           # OAuth tokens (GitHub Copilot, Google, Azure)
```

---

## Updating

```bash
git pull origin main
npm install
npm start
```

There is no migration step — the SQLite schema is managed automatically on boot.
