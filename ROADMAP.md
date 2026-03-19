# WhiteOwl — Roadmap

## Идея проекта

WhiteOwl — автономный AI торговый шелл для мемкоинов на Solana (pump.fun). Система работает в двух режимах одновременно:

1. **Fast Path (Pipeline)** — 5-стадийный фильтр оценивает каждый новый токен за <200мс БЕЗ участия LLM. Мгновенные решения: скам-паттерн → анализ названия → быстрый скоринг → глубокая проверка (dev wallet, холдеры) → вход в позицию.

2. **Smart Path (AI Commander)** — LLM-агент получает агрегированный market state каждые 10 секунд и принимает стратегические решения: корректирует пороги пайплайна, фиксирует убытки, блэклистит dev-кошельки, управляет портфелем.

Суть: AI не тормозит торговлю (пайплайн работает без него), но управляет СТРАТЕГИЕЙ в реальном времени. Токены появляются каждую секунду — пайплайн фильтрует. AI думает 3-5 секунд — и его решения влияют на следующий цикл.

**Стек:** TypeScript, Node.js, @solana/web3.js, SQLite (better-sqlite3), 24+ LLM провайдера, WebSocket, Express

---

## Что уже сделано

### Ядро (Core) — ✅ 100%

| Компонент | Файл | Статус | Описание |
|-----------|------|--------|----------|
| Event Bus | `src/core/event-bus.ts` | ✅ Готов | Типизированный pub/sub, история (1000 событий), wildcard handlers, `pipeline:learn` event |
| Pipeline | `src/core/pipeline.ts` | ✅ Готов | 5-стадийный фильтр, worker pool (8), LRU кэш (10k), priority queue, трекинг латенси, **self-learning weights**, **DevBehaviorTracker (anti-gaming)**, **trend boost**, **security weight** |
| Agent Runner | `src/core/agent-runner.ts` | ✅ Готов | Два режима (event-driven + periodic), очередь событий (20), batch-обработка, tool call loop (макс 5 раундов) |
| Market State | `src/core/market-state.ts` | ✅ Готов | Агрегатор событий → компактный контекст для AI (токены, позиции, сигналы, статистика) |
| Risk Manager | `src/core/risk-manager.ts` | ✅ Готов | Лимиты на агента, дневные потери, cooldown, emergency stop, **per-position stop-loss, time-based exit** |
| Strategy Engine | `src/core/strategy.ts` | ✅ Готов | Загрузка YAML стратегий, оценка условий входа/выхода |
| Scheduler | `src/core/scheduler.ts` | ✅ Готов | Периодические задачи по ID |
| Skill Loader | `src/core/skill-loader.ts` | ✅ Готов | Регистрация скиллов, индекс инструментов, диспатчинг |
| Multi-Agent | `src/core/multi-agent.ts` | ✅ Готов | **НОВЫЙ.** 4 специализированных агента (Scanner, Risk, Sentiment, Commander), типизированные сообщения, маршрутизация |
| Decision Engine | `src/core/decision-engine.ts` | ✅ Готов | **НОВЫЙ.** DecisionExplainer (факторный анализ каждой сделки), DailyReportGenerator (LLM + structured отчёты) |
| Metrics | `src/core/metrics.ts` | ✅ Готов | **НОВЫЙ.** Prometheus /metrics endpoint, BackupManager (авто-бэкап каждые 6ч, ротация), health checks |
| Privacy Guard | `src/core/privacy-guard.ts` | ✅ Готов | **НОВЫЙ (Ф9).** Sanitizes all LLM data: wallet/mint masking, RPC URL stripping, private key detection, bidirectional mapping, per-session cache |
| Auto-Approve | `src/core/auto-approve.ts` | ✅ Готов | **НОВЫЙ (Ф9).** 5 уровней (off/conservative/moderate/aggressive/full), rule-based, security+risk check integration, audit trail, daily limits |

### Скиллы — ✅ 100%

| Скилл | Файл | Готовность | Детали |
|-------|------|-----------|--------|
| pump-monitor | `src/skills/pump-monitor.ts` | ✅ 95% | WebSocket к pumpportal.fun, парсинг новых токенов, reconnect с backoff, фильтрация по соцсетям/паттернам, **token:trade event forwarding** |
| token-analyzer | `src/skills/token-analyzer.ts` | ✅ 85% | Анализ метаданных, холдеры (Helius + RPC fallback), dev wallet (возраст, баланс, tx count), bundling detection, rug score |
| pump-trader | `src/skills/pump-trader.ts` | ✅ 95% | 3 маршрута: Jupiter v6, pump.fun bonding curve, Jito bundles. **Jito base58 fix, RPC retry с backoff, bundle confirmation polling** |
| fast-sniper | `src/skills/fast-sniper.ts` | ✅ 90% | Обёртка над Pipeline — 6 инструментов (enable, disable, status, evaluate, config, blacklist) |
| portfolio | `src/skills/portfolio.ts` | ✅ 80% | Позиции, P&L, отчёты, здоровье портфеля. syncPositions из trade history |
| wallet-tracker | `src/skills/wallet-tracker.ts` | ✅ 75% | Трекинг кошельков, Helius enriched parsing, определение buy/sell, common buys |
| dex-screener | `src/skills/dex-screener.ts` | ✅ 90% | DexScreener API — цены, объёмы, ликвидность, пары, кэширование |
| copy-trade | `src/skills/copy-trade.ts` | ✅ 90% | Копирование buy-сигналов. **sizeMode (fixed/proportional/percentage) реализован. Auto-sell по signal:sell реализован** |
| trend-sniper | `src/skills/trend-sniper.ts` | ✅ 85% | **НОВЫЙ.** AI trend intelligence: DexScreener trending/boosts → narrative clustering → авто-подача ключевых слов в Pipeline |
| alpha-scanner | `src/skills/alpha-scanner.ts` | ✅ 95% | **РАСШИРЕН.** 12 инструментов, семантический narrative engine (LLM анализ новостей → ключевые слова → авто-сниппинг первого совпадающего токена), Telegram + Twitter + сайты |
| social-monitor | `src/skills/social-monitor.ts` | ✅ 95% | **v2.0 ПЕРЕПИСАН.** 12 инструментов, KOL tracking DB (influence weights, win rate), LLM-based NLP sentiment, 5 дефолтных KOL, авто-корректировка влияния по результатам |
| advanced-trader | `src/skills/advanced-trader.ts` | ✅ 95% | **НОВЫЙ.** 16 инструментов: DCA, trailing stop-loss, grid trading, graduation sniping, MEV protection, multi-DEX routing (Jupiter+Raydium), position scaling |
| token-security | `src/skills/token-security.ts` | ✅ 95% | **НОВЫЙ (Ф8).** 5 инструментов: on-chain проверка mint/freeze authority, metadata mutability (Metaplex PDA), LP lock (DexScreener), batch-аудит, SecurityAudit scoring (0-100), `signal:rug` эмит, кэш 5мин |
| curve-analyzer | `src/skills/curve-analyzer.ts` | ✅ 95% | **НОВЫЙ (Ф8).** 8 инструментов: bonding curve state, velocity (1m/5m), graduation prediction, buy/sell pressure, entry zone classification (early/sweet/late/danger/graduated), auto-watch token:new, polling pump.fun API |
| exit-optimizer | `src/skills/exit-optimizer.ts` | ✅ 95% | **НОВЫЙ (Ф8).** 7 инструментов: AI exit strategy — stop-loss, trailing stop, partial take-profit (2 уровня), time decay, volume decay, holder exodus, momentum reversal, urgency classification, auto trade:intent |
| holder-intelligence | `src/skills/holder-intelligence.ts` | ✅ 95% | **НОВЫЙ (Ф8).** 8 инструментов: cluster detection (similar amounts), insider detection (early buyers), whale tracking, smart money overlap, accumulation/distribution trend, dev wallet monitoring, risk scoring |
| volume-detector | `src/skills/volume-detector.ts` | ✅ 95% | **НОВЫЙ (Ф8).** 8 инструментов: wash trading detection, volume spikes (3x+ baseline), organic score (unique wallets), coordinated pump detection, volume trend, auto-track on position:opened |

### LLM провайдеры — ✅ 100%

| Провайдер | Статус |
|-----------|--------|
| OpenAI (GPT-4o, GPT-4o-mini) | ✅ Реализован |
| Anthropic (Claude) | ✅ Нативный Messages API |
| Google Gemini | ✅ Нативный REST API |
| Groq | ✅ OpenAI-совместимый |
| DeepSeek | ✅ OpenAI-совместимый |
| Cerebras | ✅ OpenAI-совместимый |
| SambaNova | ✅ OpenAI-совместимый |
| Together AI | ✅ OpenAI-совместимый |
| Fireworks AI | ✅ OpenAI-совместимый |
| Mistral | ✅ OpenAI-совместимый |
| OpenRouter | ✅ OpenAI-совместимый |
| xAI (Grok) | ✅ OpenAI-совместимый |
| Azure OpenAI | ✅ Deployments API |
| AWS Bedrock | ✅ Custom SigV4 signing |
| Google Vertex AI | ✅ REST API |
| Ollama (локальный) | ✅ OpenAI-совместимый |
| + ещё 8 провайдеров | ✅ Через OpenAI-совместимый класс |
| **Fallback chain** | ✅ `FallbackLLMProvider` — авто-переключение между провайдерами |
| **Streaming** | ✅ SSE streaming для OpenAI-compatible + Anthropic |

### Инфраструктура — ✅ 100%

| Компонент | Статус | Описание |
|-----------|--------|----------|
| Runtime | ✅ Готов | Центральный оркестратор: boot → skills → agents → events → risk. **Self-learning loop (30мин), trade outcome recording, weight persistence, decision explainer, daily report, metrics, backup** |
| CLI | ✅ Готов | 4 режима (interactive/monitor/autopilot/report), 20+ команд |
| SQLite Memory | ✅ Готов | **14 таблиц** (токены, снэпшоты, анализы, холдеры, сделки, сессии, позиции, rug wallets, pipeline_learning, pipeline_weights, dev_wallet_memory, hourly_performance, pattern_memory, narrative_outcomes) |
| PostgreSQL | ✅ Готов | **НОВЫЙ.** `pg-adapter.ts` — drop-in замена SQLite для продакшн, полная миграция схемы |
| Wallet | ✅ Готов | @solana/web3.js, sign/signAndSend, bs58/JSON ключ |
| Multi-Wallet | ✅ Новый | **НОВЫЙ.** Параллельная торговля с нескольких кошельков (round-robin, highest-balance, least-used, random) |
| API Server | ✅ Готов | **22+ REST эндпоинта** + WebSocket, API key auth, CORS, rate limiting, /metrics (Prometheus), /health, /dashboard |
| Web Dashboard | ✅ Новый | **НОВЫЙ.** HTML+CSS+JS: позиции, P&L графики, решения AI, live events, mobile-friendly |
| Telegram Bot | ✅ Новый | **НОВЫЙ.** /start /stop /status /report /portfolio /pause /resume /help + алерты (сделки, rug, emergency) |
| Notifications | ✅ Новый | **НОВЫЙ.** Unified alerts: Telegram, Discord (webhook), generic webhook; rate limiting, severity filter |
| Docker | ✅ Новый | **НОВЫЙ.** Dockerfile + docker-compose.yml (с volume, healthcheck) |
| VPS Deploy | ✅ Новый | **НОВЫЙ.** deploy.sh: Node.js 20, PM2, build, .env, ecosystem.config.js, logrotate, firewall |
| Metrics | ✅ Новый | **НОВЫЙ.** Prometheus-compatible /metrics (trades, P&L, pipeline, RPC, memory, LLM), health checks |
| Backup | ✅ Новый | **НОВЫЙ.** BackupManager: авто-бэкап каждые 6ч, ротация (7 бэкапов), restore |
| Cross-Chain | ✅ Новый | **НОВЫЙ.** CrossChainManager: EVM адаптеры (Base, Ethereum, Abstract, Monad), кросс-чейн narrative мониторинг |
| Стратегии | ✅ 4 шт. | degen-sniper, graduated-only, scalper, smart-money-follow |
| Config | ✅ Готов | .env + YAML/JSON, авто-детект лучшей LLM модели, fallbackModels support |

---

## Известные баги 🐛

Все критические баги фиксированы в Фазе 1.

| # | Компонент | Баг | Статус |
|---|-----------|-----|--------|
| 1 | pump-trader | Jito: `signed.signatures[0]` возвращает base64, Solana ожидает base58 | ✅ Исправлен — `bs58.encode()` |
| 2 | copy-trade | `sizeMode` (proportional/percentage) игнорируется — всегда используется `fixedAmountSol` | ✅ Исправлен — `calculateCopyAmount()` |
| 3 | copy-trade | `autoSell` настроен, но sell-when-source-sells логика не реализована | ✅ Исправлен — подписка на `signal:sell` |
| 4 | api/server | Нет CORS — запросы из браузера не пройдут | ✅ Исправлен — `cors()` middleware |
| 5 | api/server | Нет rate limiting — уязвимость к DDoS | ✅ Исправлен — `express-rate-limit` (100 req/min) |
| 6 | pump-trader | Нет retry логики при RPC ошибках | ✅ Исправлен — `rpcRetry()` exponential backoff |
| 7 | pump-trader | Нет polling подтверждения после Jito bundle | ✅ Исправлен — `pollBundleStatus()` |

---

## Что нужно сделать

### Фаза 1 — Баг-фиксы и стабилизация ✅ ЗАВЕРШЕНА

- [x] **Jito signature encoding** — конвертация base64 → base58 через `bs58.encode()` в `sendViaJito`
- [x] **Copy-trade sizeMode** — реализованы proportional и percentage режимы через `calculateCopyAmount()`
- [x] **Copy-trade autoSell** — подписка на `signal:sell` от wallet-tracker, авто-продажа скопированных позиций
- [x] **API CORS** — добавлен `cors()` middleware в server.ts
- [x] **API rate limiting** — `express-rate-limit` (100 req/min)
- [x] **RPC retry** — обёртка `rpcRetry()` с exponential backoff (3 попытки, 500ms base) для всех Solana RPC вызовов
- [x] **Jito bundle confirmation** — `pollBundleStatus()` с polling `getBundleStatuses` после отправки

### Фаза 2 — Social Intelligence ✅ ЗАВЕРШЕНА

- [x] **Alpha Scanner** — `AlphaScannerSkill`: сканирование Telegram, Twitter, вторичных сайтов (pump.fun, DexScreener) → извлечение CA/тикеров → авто-подача в pipeline → auto-buy. **12 инструментов, семантический narrative engine (LLM → ключевые слова → авто-сниппинг)**
- [x] **Twitter интеграция** — Twitter API v2 + Nitter RSS fallback, keyword search, авто-извлечение CA
- [x] **Telegram мониторинг** — Telegram Bot API polling + public scraping fallback, мониторинг каналов
- [x] **KOL трекинг** — `social-monitor.ts` v2.0: KOL DB с influence weights (0-10), win rate tracking, 5 дефолтных KOL, авто-корректировка влияния
- [x] **NLP сентимент** — LLM-based sentiment analysis через `analyzeSentimentLLM()` с keyword fallback
- [x] **Мониторинг Telegram каналов альфы** — парсинг CA из сообщений, narrative matching, авто-анализ и подача в pipeline

### Фаза 3 — Продвинутый трейдинг ✅ ЗАВЕРШЕНА

- [x] **DCA (Dollar Cost Averaging)** — `advanced-trader.ts`: dcaCreate/dcaCancel/dcaList, настраиваемые интервалы и chunk size
- [x] **Trailing stop-loss** — trailingStopSet/Cancel/List, динамический SL следует за ценой на X%
- [x] **Grid trading** — gridCreate/Cancel/List, сетка ордеров с настраиваемыми уровнями
- [x] **Snipe on graduation** — graduationWatch/List, авто-покупка при переходе bonding curve → Raydium
- [x] **MEV protection** — mevConfig: jitoTipSol, usePrivateTx, maxPriorityFee
- [x] **Multi-DEX routing** — routeBest: запрос Jupiter + Raydium, выбор лучшего price impact
- [x] **Position scaling** — scaleInSet/List: авто-увеличение позиции при улучшении условий (pyramid in)

### Фаза 4 — AI Commander v2 ✅ ЗАВЕРШЕНА

- [x] **Обучаемый скоринг** — `SignalWeights` система: Pipeline записывает trade outcomes → `pipeline_learning` таблица → каждые 30мин `getLearningStats()` анализирует win/lose по сигналам → `applyLearning()` корректирует веса ±0.05 (min 0.3, max 2.0) → веса персистятся в `pipeline_weights`
- [x] **Anti-gaming анализ** — **НОВОЕ.** `DevBehaviorTracker`: on-chain поведенческие сигналы которые нельзя подделать (скорость создания токенов, кластеризация funding source, история lifetime токенов, возраст кошелька). Интегрирован в Stage 2 Pipeline
- [x] **Trend Intelligence** — **НОВОЕ.** `TrendSniperSkill`: DexScreener trending/boosts → narrative clustering → авто-подача trend keywords в Pipeline → boost score для совпадающих токенов
- [x] **Мультиагентная система** — `multi-agent.ts`: 4 агента (Scanner, Risk, Sentiment, Commander), типизированные AgentMessage, маршрутизация через event bus
- [x] **Контекстная память** — `context.ts`: 4 таблицы (dev_wallet_memory, hourly_performance, pattern_memory, narrative_outcomes), dev reputation, timing analysis
- [x] **Объяснения решений** — `decision-engine.ts`: DecisionExplainer слушает trade:intent → факторный анализ (pipeline score, dev rep, holders, liquidity) с confidence score
- [x] **Ежедневный стратегический отчёт** — DailyReportGenerator: LLM-powered или structured fallback, 24h/7d статистика, лучшие часы, паттерны, narratives
- [x] **Streaming LLM** — SSE streaming для OpenAI-compatible (18+ провайдеров) и Anthropic. `LLMStreamChunk` interface, `AsyncGenerator` API. `FallbackLLMProvider` поддерживает streaming с авто-переключением
- [x] **Provider fallback chain** — `FallbackLLMProvider`: массив провайдеров, пробует по порядку, запоминает последний успешный для hot-path. `fallbackModels` в `AgentConfig`, `getLLMProviderWithFallback()` factory

### Фаза 5 — UI и мониторинг ✅ ЗАВЕРШЕНА

- [x] **Web Dashboard** — `public/index.html`: HTML+CSS+JS дашборд (тёмная тема, позиции, P&L графики, решения AI, live WebSocket events, session controls)
- [x] **Realtime charts** — Canvas P&L chart с live обновлением через WebSocket
- [x] **Telegram бот управления** — `telegram-bot.ts`: /start, /stop, /status, /report, /portfolio, /pause, /resume, /help + alert system
- [x] **Алерты** — `notifications.ts`: Telegram + Discord webhook + generic webhook; severity filtering, rate limiting (30s per event)
- [x] **Mobile-friendly** — responsive CSS, мониторинг и управление с телефона

### Фаза 6 — Масштабирование и деплой ✅ ЗАВЕРШЕНА

- [x] **Docker** — `Dockerfile` (Node 20 Alpine, multi-stage) + `docker-compose.yml` (volumes, healthcheck, commented PG/Prometheus/Grafana)
- [x] **VPS деплой** — `deploy.sh`: Node.js 20, PM2, build, .env, ecosystem.config.js, logrotate, firewall (ufw)
- [x] **Multi-wallet** — `multi-wallet.ts`: 4 стратегии выбора (round-robin, highest-balance, least-used, random), per-wallet tracking
- [x] **PostgreSQL** — `pg-adapter.ts`: drop-in замена better-sqlite3, полная PG_SCHEMA миграция всех 14 таблиц
- [x] **Metrics** — `metrics.ts`: Prometheus /metrics (trades, P&L, pipeline, RPC, memory, LLM), isHealthy()
- [x] **Backup strategy** — BackupManager: авто-бэкап каждые 6ч, ротация (max 7), restore
- [x] **Health monitoring** — /health endpoint, PM2 watchdog, memory/error/activity checks

### Фаза 7 — Расширение блокчейнов ✅ ЗАВЕРШЕНА

- [x] **Base / Ethereum L2** — `cross-chain.ts`: EVMAdapter для Base и Ethereum через DexScreener API
- [x] **Abstract / Monad** — EVMAdapter поддерживает Abstract и Monad (настраиваемые RPC/chainId)
- [x] **Cross-chain** — CrossChainManager: кросс-чейн narrative scanning, поиск общих ключевых слов, эмит token:new с chain prefix

### Фаза 8 — Безопасность и глубокая аналитика ✅ ЗАВЕРШЕНА

- [x] **Token Security Auditor** — `token-security.ts`: on-chain проверка mint/freeze authority через getAccountInfo (jsonParsed), metadata mutability через Metaplex PDA, LP lock через DexScreener API, SecurityAudit scoring (0-100), `signal:rug` при score < 30, кэш 5мин (5K записей). 5 инструментов
- [x] **Curve Analyzer** — `curve-analyzer.ts`: real-time bonding curve intelligence, CurveTracker с velocity (1m/5m), graduation prediction (ETA), buy/sell pressure ratio, entry zone classification (early/sweet/late/danger/graduated), GRADUATION_SOL=85, auto-watch на token:new (max 100), polling pump.fun API каждые 10с. 8 инструментов
- [x] **Exit Optimizer** — `exit-optimizer.ts`: AI exit strategy — PositionMonitor отслеживает peak price, 8 exit signals (stop_loss, trailing_stop, partial_take1/2, time_decay, volume_decay, holder_exodus, momentum_reversal), urgency classification (low/medium/high), авто trade:intent при high urgency, check interval 5с. 7 инструментов
- [x] **Holder Intelligence** — `holder-intelligence.ts`: глубокий on-chain анализ холдеров — cluster detection (кошельки с одинаковыми суммами), insider detection (первые N секунд), whale tracking, smart money overlap, accumulation/distribution trend, dev wallet monitoring (signal:sell при >10% decrease), risk scoring. 8 инструментов
- [x] **Volume Detector** — `volume-detector.ts`: детекция аномалий объёма — wash trading (buy+sell один кошелёк), volume spikes (3x+ от baseline), organic score (unikальные кошельки / total trades), coordinated pump detection (≥15 buys/min < 0.5 SOL avg), auto-track при position:opened. 8 инструментов
- [x] **Pipeline Security Weight** — добавлен `security: number` в SignalWeights, 4 security-сигнала в self-learning (mint_authority_active, freeze_authority_active, security_safe, security_risky)
- [x] **Per-Position Stop-Loss** — risk-manager: настраиваемый SL на позицию (-50% default), time-based exit (45мин без роста), signal:sell с urgency
- [x] **Trade Event Forwarding** — pump-monitor: `token:trade` event с полными данными (wallet, solAmount, tokenAmount, price, mcap) → curve-analyzer, volume-detector, exit-optimizer слушают
- [x] **Новые события EventMap** — 5 новых типизированных событий: `token:trade`, `security:alert`, `curve:update`, `volume:anomaly`, `holder:alert`

### Фаза 9 — Приватность AI и Auto-Approve ✅ ЗАВЕРШЕНА

- [x] **Privacy Guard** — `privacy-guard.ts`: прокси-обёртка вокруг ВСЕХ LLM провайдеров. Sanitizes все исходящие данные:
  - Замена wallet адресов → `WALLET_001`, `WALLET_002` (bidirectional mapping)
  - Замена token mint адресов → `TOKEN_MINT_001`, etc.
  - Удаление RPC URL → `[RPC_URL]`
  - Детект и удаление приватных ключей → `[PRIVATE_KEY_REMOVED]`
  - Опциональное округление SOL сумм
  - Allowed-list для системных программ (SPL Token, Jupiter, Raydium, Pump.fun)
  - Автоматическое восстановление реальных адресов в ответах LLM → tool calls работают с реальными данными
  - Per-session маппинг кэш, `registerWallet()` / `registerMint()` API
  - Audit log: статистика замен без реальных данных
- [x] **Auto-Approve Manager** — `auto-approve.ts`: 5 уровней как в GitHub Copilot:
  - `off` — каждая сделка требует ручного подтверждения
  - `conservative` — авто-одобрение только продаж (фиксация прибыли/убытка)
  - `moderate` — авто-одобрение покупок до 0.1 SOL, с security check, cooldown 30с, max 5 позиций
  - `aggressive` — авто-одобрение до 0.5 SOL, cooldown 10с
  - `full` — всё авто (с risk manager проверкой)
  - Каждый уровень с кастомными правилами: maxAmountSol, maxSlippageBps, maxOpenPositions, cooldownMs, allowedAgents, blockedMints
  - Глобальные дневные лимиты (количество + SOL)
  - Интеграция с SecurityChecker (token-security) и RiskManager
  - Полный audit trail (500 записей) с API доступом
  - `trade:approved` / `trade:rejected` автоматическая эмиссия
- [x] **Runtime интеграция** — PrivacyGuard оборачивает каждый LLM провайдер при создании агента. AutoApprove встроен в trade:intent pipeline. `MY_WALLET` зарегистрирован автоматически
- [x] **API endpoints** — `/api/auto-approve/status`, `/api/auto-approve/level` (POST), `/api/auto-approve/audit`, `/api/privacy/stats`, `/api/privacy/config` (POST)
- [x] **AppConfig** — добавлены `autoApproveLevel` и `privacy` секции в типизированный конфиг

---

### Фаза 10 — OAuth и бесплатный AI ✅ ЗАВЕРШЕНА

- [x] **OAuth Manager** — `oauth-manager.ts`: полный Device Authorization Grant (RFC 8628) для CLI-авторизации:
  - GitHub Copilot OAuth — используется публичный клиент VS Code (`Iv1.b507a08c87ecfe98`)
  - Google Cloud OAuth — для Gemini/Vertex AI через OAuth2
  - Azure AD OAuth — для Azure OpenAI через OAuth2
  - Device Flow: user_code + verification_uri → пользователь вводит код в браузере
  - Автоматический refresh токенов (за 5 мин до истечения)
  - Зашифрованное хранение токенов: AES-256-CBC с machine-specific ключом
  - Токены сохраняются в `data/oauth-tokens.json`
- [x] **CopilotProvider** — `providers.ts`: LLM провайдер для GitHub Copilot:
  - Использует GitHub Models API (`models.inference.ai.azure.com`) — бесплатно с подпиской Copilot
  - Динамическое получение OAuth токена при каждом запросе
  - Полная поддержка chat() + stream() + tool_calls
  - Дефолтная модель: `gpt-4o` (доступна через GitHub Models)
- [x] **OAuthOpenAIProvider** — generic OAuth-based OpenAI-compatible провайдер для Google/Azure
- [x] **3 новых провайдера в types.ts** — `copilot`, `google-oauth`, `azure-oauth` в `LLMProviderName`
- [x] **Auto-detection в config.ts** — если есть OAuth токен, автоматически используется как LLM провайдер:
  - GitHub OAuth → `copilot` провайдер с `gpt-4o` / `gpt-4o-mini`
  - Google OAuth → `google-oauth` провайдер с Gemini
  - Azure OAuth → `azure-oauth` провайдер с GPT-4o
- [x] **Runtime интеграция** — OAuthManager создаётся в конструкторе Runtime ДО создания агентов
- [x] **API endpoints** — `/api/oauth/start/:provider` (POST), `/api/oauth/status` (GET), `/api/oauth/revoke/:provider` (DELETE)
- [x] **Shared OpenAI helpers** — вынесены `formatOpenAIMessage()`, `parseOpenAIResponse()`, `streamOpenAIResponse()` для переиспользования

---

## Приоритеты

```
✅ ГОТОВО (Фаза 1):   Баг-фиксы → стабильная торговля
✅ ГОТОВО (Фаза 2):   Social intelligence → narrative sniping, KOL tracking, NLP sentiment
✅ ГОТОВО (Фаза 3):   Продвинутый трейдинг → DCA, trailing SL, grid, MEV, multi-DEX
✅ ГОТОВО (Фаза 4):   AI v2 → multi-agent, contextual memory, decision explanations, daily reports
✅ ГОТОВО (Фаза 5):   UI → web dashboard, Telegram bot, notifications
✅ ГОТОВО (Фаза 6):   Масштабирование → Docker, VPS, multi-wallet, PostgreSQL, metrics, backup
✅ ГОТОВО (Фаза 7):   Cross-chain → Base, Ethereum, Abstract, Monad
✅ ГОТОВО (Фаза 8):   Безопасность → token security, curve analyzer, exit optimizer, holder intelligence, volume detector
✅ ГОТОВО (Фаза 9):   Приватность AI → privacy guard, auto-approve
✅ ГОТОВО (Фаза 10):  OAuth + бесплатный AI → GitHub Copilot, Google, Azure через OAuth
✅ ГОТОВО (Фаза 11):  Telegram AI-бот + Web UI Dashboard — полноценный чат и управление
```

---

### Фаза 11 — Telegram AI-бот и Web UI Dashboard ✅ ЗАВЕРШЕНА

- [x] **Telegram Bot полная переработка** — `telegram-bot.ts` (~600 строк):
  - AI-чат с любым агентом: Commander/Trader через `runtime.chat()`
  - Per-chat state management: `menu | chat | token_lookup | settings` режимы
  - Inline-клавиатура с 12 кнопками: Chat AI, Status, Portfolio, Trades, Trending, Token Lookup, Start/Pause/Stop, Settings, OAuth, Report, Help
  - Callback query handler с 30+ обработчиками
  - Поиск токенов по mint-адресу с отображением анализа и кнопкой "Ask AI"
  - Управление настройками: auto-approve уровень через inline-кнопки (Off/Conservative/Moderate/Aggressive/Full)
  - OAuth management: подключение/отключение GitHub/Google/Azure через device flow
  - Просмотр стратегий и скиллов
  - Real-time алерты: trade:executed, signal:rug, risk:emergency, position:closed, session:report
  - Сплит длинных сообщений (4000 символов chunks для Telegram лимита)
  - Markdown форматирование с fallback retry

- [x] **Web UI Dashboard** — `public/index.html` (профессиональный SPA, ~600 строк):
  - **Sidebar** навигация с SVG иконками: Dashboard, AI Chat, Portfolio, Token Explorer, Live Feed, Agents, Session, Strategies, Settings
  - **Dashboard**: 4 stat-карды (P&L, Trades, Win Rate, Open Positions), сессия с контролами, P&L canvas-гистограмма с градиентами, таблица недавних трейдов с ценами, AI Decisions с confidence scoring и факторами
  - **AI Chat**: полноценная чат-панель с message bubbles (user=gradient blue/ai=тёмный/system), выбор агента (Commander/Trader/Scanner), typing indicator, авто-ресайз textarea, Enter-to-send
  - **Portfolio**: 4 stat-карды (24h/7d/All-time/Best), таблица открытых позиций (unrealized P&L), полная история трейдов с TX ссылками на Solscan
  - **Token Explorer**: поиск по mint, trending grid с price change badge, detail карточка (MCap/Volume/Holders/Bonding Curve/Score/Rug Score/Dev Wallet/Holder Distribution), социальные ссылки (Twitter/Telegram/Website), кнопка "Ask AI", recommendation badge
  - **Live Feed**: 6 табов (All/Trades/Signals/AI/Risk/Security) с real-time WebSocket, badge-счётчик непрочитанных событий в sidebar
  - **Agents**: карточки агентов (роль/модель/статус/решения/трейды/loss streak/skills), таблица inter-agent messages
  - **Session**: режим (Autopilot/Advisor/Monitor/Manual), стратегия, длительность, report interval, история сессий, генерация AI-отчёта
  - **Strategies & Skills**: таблицы стратегий (entry/exit параметры), таблицы скиллов (версия/tools count), Context Intelligence (лучшие часы/паттерны/нарративы)
  - **Settings**: auto-approve с детальной статистикой, OAuth connect/disconnect, Privacy Guard sanitization stats, Audit Trail с токенами, System Health
  - Toast notifications для real-time событий (трейды/руги/risk emergency)
  - WebSocket с auto-reconnect + ping/pong keepalive
  - Canvas-based P&L chart с gradient bars и DPR support
  - Респонсивный дизайн (mobile sidebar), тёмная тема с CSS variables
  - Root redirect: `GET /` → `/dashboard`
  - Авто-обновление Dashboard каждые 12 секунд

---

## Архитектура

```
  pump.fun WebSocket                  Binance / DexScreener
       │                                      │
       ▼                                      ▼
  ┌──────────┐    ┌──────────┐    ┌──────────────────┐
  │  Pump     │───▶│ Pipeline │───▶│   Risk Manager   │
  │  Monitor  │    │ (5 stage)│    │  (limits, SL/TP) │
  └──────────┘    └────┬─────┘    └────────┬─────────┘
                       │                    │
                  score > min          approved?
                       │                    │
                       ▼                    ▼
                ┌─────────────┐    ┌──────────────┐
                │  Signal:Buy │───▶│  Pump Trader  │
                │  Event      │    │  (Jupiter/Jito)│
                └─────────────┘    └──────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │ Market   │ │ AI       │ │ Portfolio │
     │ State    │ │ Commander│ │ Manager   │
     │ Builder  │─▶│ (LLM)   │─▶│          │
     └──────────┘ └──────────┘ └──────────┘
           │           │              │
           ▼           ▼              ▼
     ┌─────────────────────────────────────┐
     │            SQLite Memory            │
     │  tokens │ trades │ analysis │ pos.  │
     └─────────────────────────────────────┘
```

---

## Метрики готовности

| Область | Прогресс |
|---------|----------|
| Core Engine | ██████████ 100% |
| Trading Skills | ██████████ 100% |
| LLM Integration | ██████████ 100% |
| AI Self-Learning | ██████████ 100% |
| Social Intel | ██████████ 100% |
| Security & Analytics | ██████████ 100% |
| Infrastructure | ██████████ 100% |
| UI / Dashboard | ██████████ 100% |
| Cross-Chain | ██████████ 100% |
| Multi-Agent | ██████████ 100% |
| Documentation | ██████████ 100% |
| **ОБЩИЙ** | **██████████ 100%** |
