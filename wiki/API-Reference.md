# API Reference

WhiteOwl exposes a **REST API** and a **WebSocket** stream, both on port **3377** (configurable).

---

## Base URL

```
http://localhost:3377
```

---

## REST Endpoints

### System

#### `GET /api/status`
Returns system status and wallet balance.

**Response:**
```json
{
  "ready": true,
  "uptime": 3600000,
  "wallet": "7xKX...abcd",
  "balance": 1.2345,
  "agents": ["scanner", "trader", "coder"],
  "skills": ["shit-trader", "token-analyzer", "..."],
  "session": {
    "id": "sess_abc123",
    "mode": "monitor",
    "status": "running"
  }
}
```

#### `GET /api/stats`
Returns statistics for the current trading session.

**Response:**
```json
{
  "tradesExecuted": 12,
  "tradesWon": 8,
  "tradesLost": 4,
  "totalPnlSol": 0.3412,
  "tokensScanned": 450,
  "signalsGenerated": 23
}
```

---

### Trading

#### `GET /api/trades`
Returns trade history from the local SQLite database.

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |
| `token` | string | Filter by token mint address |

**Response:** Array of trade objects.

---

### Tokens

#### `GET /api/tokens/:mint`
Returns token details and the latest analysis for the given mint address.

**Response:**
```json
{
  "mint": "...",
  "symbol": "DOGE2",
  "name": "Doge 2.0",
  "marketCap": 125000,
  "price": 0.00000042,
  "volume24h": 85000,
  "holders": 412,
  "security": { "mintAuthority": false, "freezeAuthority": false },
  "analysis": { ... }
}
```

---

### Events

#### `GET /api/events`
Returns the most recent system events.

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `limit` | number | Max results (default: 50) |
| `type` | string | Filter by event type |

---

### Skills

#### `GET /api/skills`
Returns all loaded skills and their tool definitions.

**Response:**
```json
[
  {
    "name": "shit-trader",
    "version": "1.0.0",
    "description": "...",
    "tools": [
      { "name": "buy_token", "description": "...", "parameters": { ... } }
    ]
  }
]
```

---

### Chat

#### `POST /api/chat`
Send a message to an AI agent.

**Request Body:**
```json
{
  "agentId": "scanner",
  "message": "What are the hottest tokens right now?",
  "sessionId": "optional-session-id-for-history"
}
```

**Response:**
```json
{
  "response": "Based on recent pump.fun data, here are the top 5 trending tokens...",
  "sessionId": "sess_xyz789",
  "tokensUsed": 842
}
```

---

## WebSocket Stream

#### `ws://localhost:3377/ws`

Connect to receive a real-time stream of all system events.

**Message format:**
```json
{
  "event": "TRADE_EXECUTED",
  "timestamp": 1712345678901,
  "data": {
    "token": "...",
    "side": "buy",
    "amountSol": 0.1,
    "txHash": "..."
  }
}
```

**Common event types:**

| Event | Description |
|---|---|
| `TRADE_EXECUTED` | A trade was executed on-chain |
| `TRADE_SIGNAL` | An agent generated a buy/sell signal |
| `RISK_BLOCKED` | Risk manager blocked a trade |
| `AGENT_DECISION` | An agent made a decision |
| `TOOL_CALL` | An agent called a skill tool |
| `TOKEN_DISCOVERED` | New token detected |
| `SESSION_STARTED` | Trading session started |
| `SESSION_STOPPED` | Trading session stopped |
| `JOB_COMPLETED` | Background job finished |
| `NEWS_ITEM` | New news article ingested |

---

## Authentication

By default the API is unauthenticated (local-only). If you set `API_KEY` in your environment or config, all requests must include:

```
Authorization: Bearer <your-api-key>
```

---

## Rate Limiting

The server uses `express-rate-limit`. Default: **100 requests per minute** per IP. This limit only applies when the server is exposed beyond localhost.
