# FAQ & Troubleshooting

---

## Setup

### The dashboard doesn't open at http://localhost:3377

- Make sure `npm start` (or `npm run dev`) is running without errors
- Check for port conflicts: `lsof -i :3377` (macOS/Linux) or `netstat -ano | findstr 3377` (Windows)
- If another service uses port 3377, change it in your config or by setting `API_PORT=XXXX` in `.env`

### `npm install` fails with native module errors

Some dependencies (`better-sqlite3`, `node-pty`) require native compilation.

- Make sure you have build tools installed:
  - **Windows:** `npm install --global windows-build-tools` (run as admin)
  - **macOS:** `xcode-select --install`
  - **Linux:** `sudo apt-get install build-essential python3`
- Ensure Node.js ≥ 18: `node --version`

### TypeScript errors on startup

WhiteOwl runs via `tsx` and does not need a build step for development. If you see type errors:

```bash
npx tsc --noEmit   # check types without building
npm run build      # compile to JS if needed
```

---

## Wallet & Solana

### "Low wallet balance" warning

Your connected wallet has less than 0.05 SOL. This is enough to start the panel but not enough for meaningful trading. Fund the wallet address shown in the terminal output or on the **Wallet** page.

### Transactions fail with "insufficient funds"

- Check your SOL balance on the **Wallet** page
- Factor in Solana transaction fees (~0.000005 SOL per transaction) and priority fees
- If using a priority fee, reduce it in the **Execution Profile** panel

### RPC rate limit errors

Free RPC endpoints (public Solana mainnet) have strict rate limits. Use a dedicated endpoint:

1. Get a free Helius API key at [helius.dev](https://www.helius.dev)
2. Set `SOLANA_RPC_URL` and `HELIUS_API_KEY` in your `.env`
3. Or update via **Settings → RPC Configuration** in the dashboard

---

## AI & LLM

### No models appear in the model selector

At least one of the following must be true:
- An API key for a supported provider is set in `.env`
- GitHub Copilot OAuth is connected (**Settings → AI Models → Connect GitHub Copilot**)
- Ollama is running locally (auto-detected at `http://127.0.0.1:11434`)

### GitHub Copilot OAuth fails

- Make sure you have an active GitHub Copilot subscription (Individual or Business)
- Try the flow again: **Settings → Disconnect → Connect GitHub Copilot**
- Check your system clock — OAuth tokens are time-sensitive

### Agent responses are slow

- Switch to a faster model (Groq with Llama 3.3-70B is typically the fastest cloud option)
- Local Ollama models depend entirely on your hardware; use a smaller model (7B–14B) if GPU VRAM is limited
- Reduce the agent context size by clearing conversation history

### Agent isn't calling tools / skills

- Verify the model supports tool calling (see [LLM Providers](LLM-Providers.md))
- Check that the relevant skill is assigned to the agent (Agent page)
- Some models require a specific system prompt style — try switching to GPT-4o or Claude Sonnet

---

## Browser Automation

### `browser-eye` skill fails

- The skill requires a running Chromium/Chrome instance with CDP enabled
- Start Chrome with: `chrome --remote-debugging-port=9222`
- Set the CDP URL in **Settings → Browser**: `http://localhost:9222`
- Alternatively, WhiteOwl can use its bundled Puppeteer Chromium — no external browser needed unless connecting to a real browser session (e.g., for Twitter authentication)

---

## Trading

### Trades are being blocked by the Risk Manager

Check the **Shit Trader → Risk Engine** panel. Common reasons:
- Position size exceeds `Max Position Size`
- Daily loss limit reached — trading resumes the next UTC day
- Emergency stop triggered — reset it manually in the Risk Engine panel
- Loss streak cooldown active — wait for the cooldown period

### Paper mode shows trades but Live mode doesn't execute

- Verify the **Paper / Live toggle** is set to **Live** in the Shit Trader surface
- Check your wallet balance (need SOL for gas + trade amount)
- Check the terminal / Live Events for specific error messages

### Copy trading isn't working

- Confirm the target wallet address is added and tracked in the **wallet-tracker** skill
- Make sure the `copy-trade` skill is assigned to the active trading agent
- The target wallet must execute a trade — the signal is only generated when a new on-chain transaction is detected

---

## Data & Storage

### Where is my data stored?

All runtime data is in `./data/` (relative to the project root). The main database is `data/whiteowl.db` (SQLite). This directory is git-ignored.

### How do I reset the database?

Stop the server, delete `data/whiteowl.db`, and restart. The schema is recreated automatically. **This will delete all trade history and AI memory.**

### How do I back up my data?

Copy the entire `data/` directory. The SQLite file can be opened with any SQLite viewer (e.g., [DB Browser for SQLite](https://sqlitebrowser.org/)).

---

## Performance

### High CPU usage

- Background jobs (Hot Posts Tracker, Live Monitoring) poll frequently — reduce their interval or pause them via the **Background Jobs** page
- Pump.fun WebSocket streams are always-on when the `pump-monitor` skill is active — this is expected behaviour

### Memory usage grows over time

- The event bus keeps a rolling in-memory history — this is bounded and will not grow indefinitely
- The SQLite database is on disk and does not affect RAM significantly
- If RAM is a concern, restart the server periodically (all data is persisted to SQLite)

---

## Getting Help

- Open an issue on [GitHub](https://github.com/whiteowl-engine/WhiteOwl/issues)
- Check the **AI Activity** page — it shows exactly what the AI is doing and why
- Check the **Live Events** page for real-time error events from all subsystems
