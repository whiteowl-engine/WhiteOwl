# WhiteOwl — Wiki

> **AI-powered trading panel for Solana memecoins**

WhiteOwl is a local-first dashboard that combines an AI agent layer, multi-LLM support, market scanners, wallet tooling, and automation primitives in a single Node.js runtime. Everything stays on your machine — secrets, runtime data, and trade history never leave your device.

---

## Quick Navigation

| Topic | Description |
|---|---|
| [Installation](Installation.md) | Clone, install, configure, and start |
| [Configuration](Configuration.md) | Environment variables and runtime config |
| [Dashboard](Dashboard.md) | All UI surfaces and what they do |
| [Skill System](Skill-System.md) | 29 skills, 208 tools — full reference |
| [AI Agents](AI-Agents.md) | Multi-agent system, roles, autonomy levels |
| [Trading & Risk](Trading-and-Risk.md) | Trading modes, execution profiles, risk engine |
| [API Reference](API-Reference.md) | REST endpoints and WebSocket stream |
| [LLM Providers](LLM-Providers.md) | Supported LLM providers and configuration |
| [Architecture](Architecture.md) | Project structure and core module overview |
| [FAQ](FAQ.md) | Troubleshooting and common questions |

---

## At a Glance

| Surface | What it does |
|---|---|
| **AI Chat** | Multi-agent operator console — model switching, auto-approve, streamed reasoning, persistent sessions |
| **Market Intel** | Live events, news aggregation, X/Twitter tracking, token discovery, holder analysis, pump.fun monitoring |
| **Trading Workflow** | Paper/live execution profiles, risk limits, copy trading, curve analysis, exit automation, wallet tools |
| **Local Ops** | Browser automation, terminal access, project workspace, SQLite-backed memory, background jobs |

---

## Key Stats

- **29** plugin skills  
- **208** tools available to AI agents  
- **17+** supported LLM providers (cloud and local)  
- Runs entirely on **localhost:3377**  
- Data stored in **SQLite** — no external database required  
- License: **MIT**
