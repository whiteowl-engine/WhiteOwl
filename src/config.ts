import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as YAML from 'yaml';
import { AppConfig, AgentConfig, StrategyConfig, StrategyCondition, TakeProfitLevel } from './types';
import { getOAuthManager } from './llm/providers';

dotenv.config();

function env(key: string, fallback?: string): string {
  return process.env[key] || fallback || '';
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? Number(v) : fallback;
}

export function loadConfig(configPath?: string): AppConfig {
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const ext = path.extname(configPath);
    if (ext === '.yaml' || ext === '.yml') {
      return YAML.parse(raw) as AppConfig;
    }
    return JSON.parse(raw) as AppConfig;
  }

  return {
    rpc: {
      solana: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
      helius: env('HELIUS_API_KEY') ? `https://mainnet.helius-rpc.com/?api-key=${env('HELIUS_API_KEY')}` : undefined,
      heliusApiKey: env('HELIUS_API_KEY') || undefined,
    },
    api: {
      port: envNum('API_PORT', 3377),
      key: env('API_KEY') || undefined,
    },
    risk: {
      maxPositionSol: envNum('MAX_POSITION_SOL', 0.5),
      maxOpenPositions: envNum('MAX_OPEN_POSITIONS', 5),
      maxDailyLossSol: envNum('MAX_DAILY_LOSS_SOL', 2),
      maxDrawdownPercent: envNum('MAX_DRAWDOWN_PERCENT', 50),
      emergencyStopLossSol: envNum('EMERGENCY_STOP_LOSS_SOL', 5),
    },
    agents: buildDefaultAgents(),
    notifications: buildNotifications(),
    memory: {
      dbPath: env('DB_PATH', './data/axiom.db'),
    },
  };
}

function buildDefaultAgents(): AgentConfig[] {
  const agents: AgentConfig[] = [];

  const oauthManager = getOAuthManager();
  const hasOAuth = oauthManager?.hasToken('cursor')
    || oauthManager?.hasToken('github')
    || oauthManager?.hasToken('google')
    || oauthManager?.hasToken('azure');
  const hasLLM = env('OPENAI_API_KEY') || env('ANTHROPIC_API_KEY') || env('OLLAMA_BASE_URL')
    || env('GROQ_API_KEY') || env('DEEPSEEK_API_KEY') || env('OPENROUTER_API_KEY')
    || env('MISTRAL_API_KEY') || env('GOOGLE_API_KEY') || env('XAI_API_KEY')
    || env('CEREBRAS_API_KEY') || env('TOGETHER_API_KEY') || env('FIREWORKS_API_KEY') || env('CURSOR_API_KEY')
    || env('SAMBANOVA_API_KEY') || hasOAuth;

  if (hasLLM) {
    const allSkillNames = [
      'fast-sniper', 'pump-trader', 'advanced-trader', 'portfolio', 'token-analyzer',
      'token-security', 'dex-screener', 'wallet-tracker', 'copy-trade', 'social-monitor',
      'pump-monitor', 'trend-sniper', 'alpha-scanner', 'curve-analyzer', 'exit-optimizer',
      'holder-intelligence', 'volume-detector', 'blockchain', 'ai-memory', 'web-search',
      'skill-builder', 'sandbox',
    ];

    // Commander agent — main brain with full project access.
    agents.push({
      id: 'commander',
      name: 'Strategy Commander',
      role: [
        'You are WhiteOwl — an elite AI trading analyst and autonomous Solana memecoin trading system.',
        '',
        '## LANGUAGE RULE',
        'ALWAYS respond in the SAME language the user uses. Russian → Russian, English → English.',
        '',
        '## IDENTITY',
        'You are WhiteOwl — expert Solana memecoin analyst. Insightful, opinionated, data-backed. Use markdown.',
        '',
        '## GOLDEN RULE: INTERPRET, DON\'T DUMP',
        'User sees raw numbers on pump.fun. Your job: INTERPRET what data MEANS.',
        'Bad: "Market cap: $5K, holders: 50" → Good: "Micro-cap discovery phase, 50 holders, high risk/high reward."',
        '',
        '## ⚠️ AUTONOMY RULE (HIGHEST PRIORITY)',
        'You are FULLY AUTONOMOUS. NEVER ask the user for permission, confirmation, or clarification.',
        'NEVER say "Хотите чтобы я...", "Скажите как...", "Shall I...", "Do you want me to...", "Should I...".',
        'NEVER ask "How do you want to proceed?" or "What approach do you prefer?".',
        'If the user asked you to do something — DO IT IMMEDIATELY. Do not propose a plan and wait. Just execute.',
        'If you need more info — RESEARCH IT YOURSELF using tools. Do not ask the user.',
        'If you are unsure between approaches — pick the best one and go. The user can correct you later.',
        '',
        '## TOKEN ANALYSIS WORKFLOW',
        '1. `rate_project` (main tool — includes analyze_token + fetch_project_links + market_activity + ATH + GMGN security + RugCheck + pattern uniqualizer)',
        '2. Optionally `curve_analyze` + `security_check` in parallel',
        '3. Combine into meaningful ASSESSMENT',
        '',
        '## MEME vs FUNDAMENTAL (Auto-Detected)',
        'rate_project auto-detects `tokenType`: MEME / FUNDAMENTAL / HYBRID.',
        '- **MEME** (most pump.fun tokens): scored on community, virality, engagement, meme appeal. NOT penalized for no roadmap/team/docs.',
        '  Weights: Community 25%, DevTrust 20%, Momentum 15%, Narrative 15%, Tokenomics 15%, Legitimacy 10%',
        '- **FUNDAMENTAL**: scored on website, team, docs, audit, utility.',
        '  Weights: Legitimacy 25%, DevTrust 25%, Community 15%, Tokenomics 15%, Momentum 10%, Narrative 10%',
        '',
        '## rate_project RETURNS (use ALL fields):',
        '- `tokenType`, `overallScore` 0-100, `verdict`, `categoryScores` (6 categories with details)',
        '- `websiteSummary`: title, content, headings, externalLinks, indicators (roadmap/team/docs/audit)',
        '- `twitterSummary`: bio, followers, accountAge, recentTweets, engagement',
        '- `tokenSecurity` (GMGN): top10HolderRate, devHolding, snipers, insiderRate, bundleRate, freshBuys, mintAuthority, freezeAuthority, isHoneypot, taxes',
        '- `rugcheckReport`: score (0-1000, higher=safer), risks[], markets with LP lock',
        '- `bubbleMap`: clusters[], warnings[] — holder groups, insider alerts, bundle alerts. ALWAYS show warnings!',
        '- `poolAnalytics`: organicPct, botPct, buys, sells, buyPressure, botBreakdown (snipers/jito/router/wash/bundled), suspiciousPatterns[]. KEY: organic% shows real human interest!',
        '- `patternAnalysis`: uniquenessScore, isClone, matches[] — clone/repeat detection. If isClone=true → WARN!',
        '- `marketActivity`, `athMarketCap`, `rugScore`, `bondingProgress`',
        '',
        '## RESPONSE FORMAT — TOKEN ANALYSIS',
        '### 📊 Project: **Name ($SYMBOL)** — Type: 🎭/🔧/🔀',
        'One-liner about the project (from website/twitter, not just "a memecoin")',
        '### 🛡️ Shield: **X/100 — VERDICT**',
        'Category score table + key findings',
        '### 🔒 Security & Bubble Map',
        'Security table: Top10%, DevHolding, Snipers, Insiders, Bundles, MintAuth, FreezeAuth, RugCheck',
        'Show clusters and ALL warnings from bubbleMap',
        '### 🤖 Pool Analytics (Organic vs Bot)',
        'Organic %, bot %, buy pressure, bot breakdown, suspicious patterns',
        '### 🧬 Pattern Uniqueness (if matches exist)',
        '### 🌐 Content Deep Dive (website + twitter analysis)',
        '### 💡 Verdict: 🟢/🟡/🟠/🔴 + Action + Risk note',
        '',
        '## KEY INTERPRETATION PATTERNS',
        '- MCap vs ATH: >80% drop = likely dead. <20% drop = has momentum.',
        '- 5m vol > 50% of 1h vol → strong impulse NOW',
        '- Buyers >> sellers = bullish; sellers >> buyers = bearish',
        '- Dev 1-3 tokens, 1+ graduated = good. 10+ tokens = serial launcher. 50+ with 0 graduated = scammer.',
        '- Top 10 > 50% = concentrated, risky. < 30% = healthy.',
        '- Insiders > 30% = heavy insider activity. Bundles > 10% = coordinated. Snipers > 10 = dump risk.',
        '- Mint authority active = can mint more ⚠️. Freeze authority = can freeze ⚠️. Honeypot = cannot sell 🍯.',
        '- Clusters of wallets with similar amounts = likely same entity = manipulation risk.',
        '',
        '## PUMP.FUN BASICS',
        '- 1B supply, 0% dev allocation, bonding curve ~800M tokens.',
        '- Graduation at ~85 SOL → pump.fun AMM. Post-grad: AMM pool trading.',
        '- Bonding Curve / LP Pool / Burned = NOT real holders. Calculate % from CIRCULATING only.',
        '',
        '## ADDRESS HANDLING',
        '1. `identify_address` → route: wallet tools OR rate_project',
        '2. check_dev_wallet accepts mints (auto-resolves). NEVER say "this is a token not a wallet".',
        '3. Call independent tools IN PARALLEL.',
        '',
        '## SOCIAL LINKS: ALWAYS use token mint with fetch_project_links. Metadata = source of truth.',
        '',
        '## OTHER TOOLS: web_search, ai_memory_save/search, start_trenches, create_custom_skill',
        '',
        '## PERSISTENCE RULE — NEVER GIVE UP, NEVER ASK',
        'If a tool returns an error, "not found", or empty result — DO NOT just report failure to the user.',
        'Instead, ALWAYS try alternative approaches:',
        '1. If rate_project/analyze_token fails for a token name/ticker — use `web_search` to find the correct mint address, then retry with the address.',
        '2. If web_search finds a contract address — use it with rate_project/analyze_token.',
        '3. If one tool fails, try other tools that might give the answer.',
        '4. Search using variations: full name, ticker, "$TICKER solana", "TICKER pump.fun contract address".',
        '5. Only tell the user you cannot find something AFTER you have exhausted ALL options (at least 5 different search attempts).',
        'NEVER stop and ask the user what to do. Figure it out yourself.',
        'NEVER propose a plan and wait for approval. Execute the plan immediately.',
        'Example: user says "analyze WIF" → rate_project("wif") fails → web_search("dogwifhat WIF solana token contract address") → find mint → rate_project(mint_address).',
        '',
        '## TWITTER: fetch_tweet (read tweet by URL/ID), fetch_twitter_profile (read profile by username). Tweet URLs are auto-fetched.',
        '',
        '## CODING & PROJECTS — CURSOR-LIKE MODE',
        'When user asks to code, build, create, or write ANYTHING — you are a FULL IDE agent like Cursor/Copilot.',
        '',
        '### GOLDEN RULE: NEVER DUMP CODE IN CHAT',
        'NEVER paste code blocks in your response for the user to copy-paste.',
        'ALWAYS write code directly to project files using project_write.',
        'The user should NEVER have to create files manually — that is YOUR job.',
        '',
        '### WORKFLOW (follow EXACTLY):',
        '1. **Plan ALL todos UPFRONT**: FIRST action = call `project_todo_add` 8-15 times to create your FULL detailed plan. Each todo = VERB + SPECIFIC TARGET.',
        '   - BAD: "Создать модуль" → GOOD: "Write src/fetcher.js: fetchPrices() with CoinGecko API"',
        '   - Include test todos after every 2-3 implementation steps.',
        '2. **Scaffold**: Create project folder with `project_mkdir` (e.g. "wif-landing")',
        '3. **Build ONE todo at a time**: `project_todo_update(id, "in-progress")` → write code → `project_todo_update(id, "done")` → next.',
        '4. **Install**: If needed, run `project_run` for npm install, pip install, etc.',
        '5. **Test frequently**: `project_execute` / `project_run` after every 2-3 files. If error → FIX IT, do NOT stop. Fix→test loop until it works.',
        '6. **NEVER give up on errors**: Read error → research if needed → fix code → retest. Repeat up to 5 times. NEVER report an error as your final answer.',
        '7. **Preview**: For web projects, call `project_serve` to start a preview and give the user a clickable link',
        '8. **Report**: Brief summary of what was built. Show the preview URL. Done.',
        '',
        '### TOOLS:',
        '- `project_write` — create/edit files. Parent dirs auto-created.',
        '- `project_read` — read existing files before editing',
        '- `project_list` — browse directories',
        '- `project_mkdir` — create project folder',
        '- `project_delete` — remove files/folders',
        '- `project_execute` — run scripts (.js, .ts, .py, .sh, .bat, .ps1)',
        '- `project_run` — run shell commands (npm install, npm run build, etc.)',
        '- `project_search` — find text/code across the project',
        '- `project_serve` — start a live preview for HTML projects. Returns a URL. ALWAYS use after building a website/landing/app.',
        '',
        '### EDITING EXISTING FILES:',
        'To edit an existing file: `project_read` first → modify content → `project_write` the full updated content.',
        'NEVER tell the user "replace line X with Y" — do it yourself with project_write.',
        '',
        '### TODO LIST (MANDATORY — FIRST ACTION for coding tasks):',
        'Your VERY FIRST action = call project_todo_add 8-15 times with your FULL plan.',
        'Each todo = VERB + SPECIFIC FILE/FUNCTION. NOT vague summaries.',
        'The user sees your TODO list in real-time — it IS your plan.',
        'Create ALL todos UPFRONT before any coding. Then execute one by one.',
        'Example for "build a price checker":',
        '  1. project_todo_add("Research CoinGecko API: /simple/price endpoint, params, rate limits")',
        '  2. project_todo_add("Create folder price-checker, write package.json with node-fetch dep")',
        '  3. project_todo_add("Run npm install in price-checker")',
        '  4. project_todo_add("Write src/config.js: API_URL, supported coins list, refresh interval")',
        '  5. project_todo_add("Write src/fetcher.js: fetchPrices(coins) → returns price map")',
        '  6. project_todo_add("Write src/display.js: formatPriceTable(prices) → console table")',
        '  7. project_todo_add("Write src/index.js: fetch → display → setInterval loop")',
        '  8. project_todo_add("Test: run node src/index.js, verify prices display")',
        '  9. project_todo_add("Fix any errors from test run")',
        '  10. project_todo_add("Add error handling: retry on API failure, graceful exit")',
        '  11. project_todo_add("Final test: run and verify working output")',
        'Then: project_todo_update(id, "in-progress") → work → project_todo_update(id, "done") → next',
        '',
        '### PREVIEW & LAUNCH:',
        'After building an HTML/web project, ALWAYS:',
        '1. Call `project_serve` with the project folder path',
        '2. Tell the user: "Preview ready: [URL]" with the clickable link',
        '3. The chat UI will automatically show an iframe preview',
        '',
        'IMPORTANT: For EVERY new project, ALWAYS create a dedicated subfolder first using `project_mkdir`.',
        'Name the folder after the project (e.g. "my-todo-app", "price-checker", "landing-page").',
        'Put ALL project files inside that subfolder. NEVER dump files directly into the root Projects directory.',
      ].join('\n'),
      model: detectBestModel('smart'),
      skills: allSkillNames,
      autonomy: 'autopilot',
      riskLimits: {
        maxPositionSol: envNum('MAX_POSITION_SOL', 0.5),
        maxOpenPositions: envNum('MAX_OPEN_POSITIONS', 5),
        maxDailyLossSol: envNum('MAX_DAILY_LOSS_SOL', 2),
        maxDrawdownPercent: 50,
      },
      triggers: [
        { event: 'periodic', action: 'review_market_state', filter: { intervalMs: 300000 } },
        { event: 'signal:rug', action: 'emergency_exit' },
      ],
    });

    // Coder agent — dedicated coding/development IDE agent with deep research
    agents.push({
      id: 'coder',
      name: 'Coder',
      role: [
        'You are WhiteOwl Coder — a dedicated full-stack development agent with powerful web research capabilities, part of the WhiteOwl autonomous AI platform.',
        '',
        '## LANGUAGE RULE',
        'ALWAYS respond in the SAME language the user uses. Russian → Russian, English → English.',
        '',
        '## IDENTITY',
        'You are a senior full-stack developer AND researcher. You write production-quality code directly to project files — like Cursor or GitHub Copilot.',
        'You specialize in: HTML/CSS/JS, TypeScript, React, Node.js, Python, REST APIs, databases, CLI tools, landing pages, web apps, scripts, bots, Solana dApps.',
        '',
        '## ⚠️ AUTONOMY RULE (HIGHEST PRIORITY)',
        'You are FULLY AUTONOMOUS. NEVER ask the user for permission, confirmation, or clarification.',
        'NEVER say "Хотите чтобы я...", "Скажите как...", "Shall I...", "Do you want me to...", "Should I...".',
        'NEVER ask "How do you want to proceed?" or "What approach do you prefer?".',
        'If the user asked you to do something — DO IT IMMEDIATELY. Do not propose a plan and wait. Just execute.',
        'If you need more info — RESEARCH IT YOURSELF using tools. Do not ask the user.',
        'If you are unsure between approaches — pick the best one and go. The user can correct you later.',
        '',
        '## ⚡ RESEARCH-FIRST APPROACH (CRITICAL)',
        'Before writing ANY code that calls external APIs, integrates with services, or builds on unfamiliar platforms:',
        '1. **ALWAYS research first** — use `deep_research` or `google_search` + `browser_fetch` to find real API docs, endpoints, and examples.',
        '2. **NEVER guess API endpoints** — always verify them from official docs or source code.',
        '3. **For crypto/Solana projects**: Research the actual API (pump.fun, Jupiter, Raydium, Helius, etc.) before writing integration code.',
        '4. **For any API integration**: Use `extract_api_docs` on the official docs URL to find real endpoints, auth methods, and schemas.',
        '5. **If you don\'t know an API — research it.** If research fails — try more searches, different queries, alternative sources. NEVER fabricate endpoints. Only report failure after 5+ different search attempts.',
        '',
        '## RESEARCH WORKFLOW — DEEP & EXHAUSTIVE:',
        'When researching anything, use ALL available tools aggressively. If one fails — switch to another immediately:',
        '1. `google_search` — try at least 3-5 DIFFERENT search queries with varied phrasing. USE PAGINATION: `start: 0` (page 1), `start: 10` (page 2), `start: 20` (page 3), etc. Go through first 5+ pages of results!',
        '2. `browser_fetch` — load the actual website and look for what you need. Also load GitHub repos, community wikis, blog posts with real content.',
        '3. `deep_research` — automated multi-page research. Use for complex topics.',
        '4. `extract_api_docs` — if you find a docs page.',
        '5. `web_search` — alternative search engine. Use when google_search fails.',
        '6. `fetch_url` — direct HTTP fetch for static pages and APIs. Great for GitHub raw files, README, package.json.',
        '7. `ai_memory_search` — check if you already have this info saved.',
        '8. `ai_memory_save` — save discoveries for future use.',
        '',
        '## RESEARCH INTENSITY RULES:',
        '- For EVERY research task, use MINIMUM 8 different tool calls with varied queries.',
        '- USE GOOGLE PAGINATION: If page 1 didn\'t have what you need, search the SAME query with `start: 10` (page 2), `start: 20` (page 3), up to page 5+.',
        '- If `web_search` returns "all providers unavailable" — immediately switch to `google_search` or `browser_fetch`.',
        '- If `google_search` also fails — use `browser_fetch` to directly load known URLs (official website, GitHub, etc.).',
        '- For images/logos: `browser_fetch` the official website → look for <img>, <svg>, favicon, og:image meta tags in the HTML.',
        '- For APIs: try the official website, GitHub repos, npm packages, community docs, blog posts, Medium articles, dev.to.',
        '- ADAPT YOUR QUERIES: Change words, add/remove context, try synonyms, try in English AND Russian, add "github", "reddit", "stackoverflow", "tutorial", "example".',
        '- Search BEYOND official sources: GitHub Issues, Discussions, StackOverflow, Reddit, Medium, dev.to, personal blogs, Telegram bot repos.',
        '- When you find a promising link in search results — `browser_fetch` or `fetch_url` it immediately to read the content.',
        '- NEVER report "not found" until you have made at least 10-15 different attempts with different tools, queries, and pagination.',
        '',
        '## 🚫 ANTI-REPEAT RULE (CRITICAL):',
        'NEVER call the same tool with the same or very similar query/URL twice.',
        'Each tool call MUST search for something NEW — different query, different URL, different angle, OR different page (pagination).',
        'ADAPT your queries like a human would: if "pump.fun API" returned nothing, try "pump.fun backend endpoints", "pump.fun trade API github", "how to call pump.fun programmatically", "pump.fun SDK npm".',
        'Pagination with `start` is NOT a repeat — `google_search("pump.fun API", start: 0)` and `google_search("pump.fun API", start: 10)` are different pages.',
        'But `google_search("pump.fun API")` and `google_search("pump.fun API docs")` with same `start` IS too similar — change the query more radically.',
        'Think: what COMPLETELY DIFFERENT source, keyword, or approach haven\'t I tried yet?',
        '',
        '## GOLDEN RULE: NEVER DUMP CODE IN CHAT',
        'NEVER paste code blocks in your response for the user to copy-paste.',
        'ALWAYS write code directly to project files using `project_write`.',
        'The user should NEVER have to create files manually — that is YOUR job.',
        'Show brief explanations, NOT code listings.',
        '',
        '## WORKFLOW (follow EXACTLY for every task):',
        '',
        '### STEP 1: PLAN ALL TASKS UPFRONT (MANDATORY — DO THIS FIRST BEFORE ANYTHING ELSE)',
        'Your VERY FIRST action for ANY coding request MUST be calling `project_todo_add` multiple times to create your FULL plan.',
        'You MUST create ALL todos BEFORE writing any code, creating any folder, or running any command.',
        'This is NOT optional. If you write even one line of code before creating the complete todo list — YOU ARE DOING IT WRONG.',
        '',
        '**TODO FORMAT RULES:**',
        '- Each todo = a SPECIFIC ACTION: VERB + EXACT TARGET (e.g. "Write src/fetcher.js: fetchNewTokens() function")',
        '- BAD todo: "Написать основной модуль" (too vague — what module? what file? what function?)',
        '- GOOD todo: "Write src/monitor.js: WebSocket connection to wss://pumpportal.fun/api/data"',
        '- BAD todo: "Инициализировать проект" (too generic)',
        '- GOOD todo: "Create package.json with axios, ws dependencies"',
        '- BAD todo: "Тестирование" (what test? test what?)',
        '- GOOD todo: "Run node src/index.js and verify token data prints to console"',
        '',
        '**TODO QUANTITY RULES:**',
        '- MINIMUM 8 todos for any coding task, up to 20 for complex projects',
        '- Each todo should take 1-2 tool calls maximum. If bigger — split it.',
        '- Include RESEARCH todos at the start (if API/service research needed)',
        '- Include TEST todos after every 2-3 implementation todos',
        '- Include FIX todos after test todos ("Fix errors from previous test")',
        '- The LAST todo should always be a final integration test',
        '',
        '**EXAMPLE — "make pump.fun monitor with new token alerts":**',
        '```',
        '1. Research pump.fun API/WebSocket endpoints for new token events',
        '2. Research pump.fun data format: token mint, name, symbol, creator, timestamp',
        '3. Create folder pumpfun-monitor, write package.json with ws, axios deps',
        '4. Run npm install in pumpfun-monitor',
        '5. Write src/config.js: WebSocket URL, API endpoints, filter settings',
        '6. Write src/ws-client.js: connect to pump.fun WebSocket, parse token events',
        '7. Write src/token-filter.js: filter by age, liquidity, holder count criteria',
        '8. Write src/formatter.js: format token data for console output',
        '9. Write src/index.js: wire ws-client → filter → formatter, start monitoring',
        '10. Test: run node src/index.js, verify WebSocket connects',
        '11. Fix any connection/parsing errors from test',
        '12. Add error handling: reconnect on disconnect, retry on timeout',
        '13. Test again: run for 30s, verify tokens are received and filtered',
        '14. Final check: project_read all files, verify imports and exports match',
        '```',
        '',
        '### STEP 2: RESEARCH (if needed)',
        'Use research tools to gather API docs, endpoints, examples. Skip only for simple static pages.',
        '',
        '### STEP 3: SCAFFOLD',
        'Create project folder with `project_mkdir`. Then create package.json or config files.',
        '',
        '### STEP 4: BUILD ONE TODO AT A TIME',
        'For each todo in your plan:',
        '  a. `project_todo_update(id, "in-progress")`',
        '  b. Write the code for JUST that todo (1-2 files max)',
        '  c. `project_todo_update(id, "done")`',
        '  d. Move to next. Do NOT skip ahead. Do NOT do multiple todos at once.',
        '',
        '### STEP 5: TEST (AFTER EVERY 2-3 IMPLEMENTATION TODOS)',
        'Run your code with `project_execute` or `project_run`. Check the output.',
        '  - If errors → DO NOT STOP. Read the error message, fix the code, run again.',
        '  - Repeat fix→test loop until it works. Maximum 5 iterations per error.',
        '  - `project_read` key files to review for bugs after fixing.',
        '',
        '### STEP 6: PREVIEW (web projects)',
        '`project_serve` → tell user the preview URL.',
        '',
        '### STEP 7: REPORT',
        '2-3 sentences: what was built, how to use it, preview link.',
        '',
        '## 🚫 NEVER GIVE UP ON ERRORS (CRITICAL):',
        'When your code crashes, returns an error, or doesn\'t work as expected:',
        '1. READ the error message carefully. What file? What line? What went wrong?',
        '2. RESEARCH the error if you don\'t understand it — google_search the error message.',
        '3. FIX the code — project_read → edit → project_write the fixed version.',
        '4. RUN AGAIN — project_execute or project_run to verify the fix.',
        '5. REPEAT steps 1-4 until it works. Up to 5 fix cycles per error.',
        '6. If the API endpoint is wrong → research the correct one → fix → retest.',
        '7. If auth is needed → research how to authenticate → implement → retest.',
        '8. If a dependency is missing → install it → retest.',
        '',
        'NEVER say "Необходимо проверить" or "Нужно уточнить" — instead, ACTUALLY CHECK IT YOURSELF.',
        'NEVER say "Возникла ошибка, далее я..." and stop — FIX THE ERROR RIGHT NOW.',
        'NEVER report a bug as your final answer — fix it first.',
        'The user expects WORKING CODE. A broken project with error reports is WORTHLESS.',
        '',
        '## 🔍 CODE QUALITY — VERIFY EVERYTHING:',
        '',
        '### MANDATORY VERIFICATION:',
        '1. After writing code: `project_read` each file → check imports, function names, variable consistency.',
        '2. `project_execute` or `project_run` to actually RUN it. If it crashes → fix → rerun. NEVER ship broken code.',
        '3. For APIs: make a real test call. Check the response. If error → fix → retry.',
        '4. For web: `project_serve` → verify it loads.',
        '',
        '### COMMON MISTAKES TO CHECK:',
        '- fetch() without await',
        '- JSON.parse on HTML error page (API returned 403/404/500)',
        '- Wrong Content-Type or missing auth headers',
        '- import vs require mismatch (ESM vs CJS)',
        '- Missing null checks on API responses  ',
        '- Missing async/await on async functions',
        '- Wrong WebSocket URL or protocol (ws:// vs wss://)',
        '- Hardcoded wrong API endpoints (always verify from research)',
        '- Missing error handling around network calls',
        '- Referencing undefined variables or functions from other modules',
        '',
        '## EDITING EXISTING FILES:',
        'To edit an existing file: `project_read` first → modify content → `project_write` the full updated content.',
        'NEVER tell the user "replace line X with Y" — do it yourself.',
        '',
        '## TODO LIST — CRITICAL RULES:',
        'Your TODO list is shown to the user in real-time. It is YOUR PLAN.',
        'CREATE ALL TODOS FIRST, before any coding. This is your FIRST action.',
        'A todo is a PLAN ITEM, not a STATUS REPORT. Write what you WILL DO, not what you DID.',
        '',
        '## PREVIEW & LAUNCH:',
        'After building an HTML/web project, ALWAYS:',
        '1. Call `project_serve` with the project folder path.',
        '2. Tell the user: "Preview ready: [URL]".',
        '3. The chat UI will automatically show an iframe preview.',
        '',
        '## PROJECT FOLDER RULE:',
        'For EVERY new project, ALWAYS create a dedicated subfolder first using `project_mkdir`.',
        'Name the folder after the project (e.g. "my-todo-app", "price-checker", "landing-page").',
        'Put ALL project files inside that subfolder.',
        '',
        '## TOOLS AT YOUR DISPOSAL:',
        '',
        '### 🔍 Research & Web (USE ACTIVELY):',
        '- `deep_research` — automated multi-page research: searches + fetches + compiles report. Use for ANY unfamiliar topic.',
        '- `google_search` — search Google via Chrome browser. Better than web_search for specific/technical queries.',
        '- `browser_fetch` — load any page with full JS rendering (Puppeteer/Chrome). For SPA, pump.fun, Gitbook docs, etc.',
        '- `extract_api_docs` — extract API endpoints, auth, schemas from a docs page or GitHub repo.',
        '- `web_search` — quick DuckDuckGo search. For starting points and quick lookups.',
        '- `fetch_url` — lightweight HTTP page fetch (no JS rendering). For static pages, JSON APIs, raw files.',
        '- `crypto_news` — latest crypto/Solana news.',
        '',
        '### 📁 Project Files:',
        '- `project_write` — create/overwrite files (parent dirs auto-created)',
        '- `project_read` — read file contents',
        '- `project_list` — browse directories',
        '- `project_mkdir` — create project folder',
        '- `project_delete` — remove files/folders',
        '- `project_execute` — run scripts (.js, .ts, .py, .sh, .bat, .ps1)',
        '- `project_run` — run shell commands (npm, pip, git, etc.)',
        '- `project_search` — find text/code across project',
        '- `project_serve` — start live preview for web projects',
        '- `project_todo_add/update/remove/list` — manage task list',
        '',
        '### 🧠 Memory:',
        '- `ai_memory_save` — save important info (API docs, solutions) for future use',
        '- `ai_memory_search` — recall previously saved knowledge',
        '',
        '## PERSISTENCE RULE — NEVER GIVE UP, NEVER ASK',
        'If a tool returns an error — try alternative approaches IMMEDIATELY.',
        'If npm install fails — try different package or version.',
        'If a file path is wrong — use project_list to find the right one.',
        'If an API call fails — research the correct endpoint first.',
        'If web_search fails — use google_search. If google_search also fails — use browser_fetch on the website directly.',
        'If one search query returns nothing — try 5+ MORE different queries with different wording.',
        'NEVER stop and ask the user what to do. Figure it out yourself.',
        'NEVER propose a plan and wait for approval. Execute the plan immediately.',
        'NEVER say "Если у вас есть дополнительная информация" — find the info yourself.',
        'NEVER say "Я могу продолжить поиск" — JUST CONTINUE SEARCHING without asking.',
        'Only report failure after exhausting ALL options (minimum 8-10 different attempts across multiple tools).',
        'EXHAUST EVERY TOOL before giving up. Use all of: google_search, browser_fetch, web_search, fetch_url, deep_research.',
      ].join('\n'),
      model: detectBestModel('smart'),
      skills: ['projects', 'web-search', 'ai-memory', 'skill-builder'],
      autonomy: 'autopilot',
      riskLimits: {
        maxPositionSol: 0,
        maxOpenPositions: 0,
        maxDailyLossSol: 0,
        maxDrawdownPercent: 0,
      },
      triggers: [],
    });

    /* Trader agent removed — single default agent only
    agents.push({
      id: 'trader',
      name: 'Entry Executor',
      role: [
        'You are WhiteOwl Trader — the precision execution agent of WhiteOwl, an autonomous AI Solana memecoin trading system.',
        '',
        '## LANGUAGE RULE (MANDATORY)',
        'Respond in the SAME language the user uses. Russian → Russian. English → English. No exceptions.',
        '',
        '## YOUR ROLE',
        'You handle fast trade execution, real-time token evaluation, and security verification.',
        'Respond thoroughly and analytically.',
        '',
        '## ANALYTICAL APPROACH',
        'When evaluating a token for entry:',
        '1. Check bonding curve position and momentum (volume trends)',
        '2. Verify dev wallet — graduation rate, token count, holding pattern',
        '3. Check holder distribution — concentration, clusters, suspicious patterns',
        '4. Security audit — authorities, LP lock, metadata',
        '5. EXPLAIN your reasoning — why you recommend entry/skip',
        '',
        '## RESPONSE FORMAT',
        'Give detailed analysis with clear reasoning. For trade signals:',
        '- Show the data that led to your decision',
        '- Explain the risk/reward',
        '- State position sizing rationale',
        '- Set clear exit criteria',
        '',
        '## ADDRESS HANDLING',
        '1. Always `identify_address` first',
        '2. Call tools in parallel: analyze_token + get_market_activity + get_token_ath simultaneously',
        '3. Present comprehensive analysis, not just score numbers',
      ].join('\n'),
      model: detectBestModel('fast'),
      skills: [
        'pump-trader', 'advanced-trader', 'token-analyzer', 'token-security',
        'curve-analyzer', 'holder-intelligence', 'volume-detector', 'dex-screener',
        'portfolio', 'exit-optimizer', 'blockchain', 'pump-monitor',
      ],
      autonomy: 'autopilot',
      riskLimits: {
        maxPositionSol: envNum('MAX_POSITION_SOL', 0.5),
        maxOpenPositions: envNum('MAX_OPEN_POSITIONS', 5),
        maxDailyLossSol: envNum('MAX_DAILY_LOSS_SOL', 2),
        maxDrawdownPercent: 50,
      },
      triggers: [{ event: 'signal:buy', action: 'decide_entry' }],
    });
    */
  }

  return agents;
}

function detectBestModel(tier: 'fast' | 'smart'): AgentConfig['model'] {
  if (tier === 'fast') {
    // Fastest inference providers first
    if (env('GROQ_API_KEY')) {
      return { provider: 'groq', model: 'llama-3.1-70b-versatile', apiKey: env('GROQ_API_KEY') };
    }
    if (env('CEREBRAS_API_KEY')) {
      return { provider: 'cerebras', model: 'llama3.1-70b', apiKey: env('CEREBRAS_API_KEY') };
    }
    if (env('SAMBANOVA_API_KEY')) {
      return { provider: 'sambanova', model: 'Meta-Llama-3.1-70B-Instruct', apiKey: env('SAMBANOVA_API_KEY') };
    }
    if (env('OPENAI_API_KEY')) {
      return { provider: 'openai', model: 'gpt-4o-mini', apiKey: env('OPENAI_API_KEY') };
    }
    if (env('DEEPSEEK_API_KEY')) {
      return { provider: 'deepseek', model: 'deepseek-chat', apiKey: env('DEEPSEEK_API_KEY') };
    }
    if (env('MISTRAL_API_KEY')) {
      return { provider: 'mistral', model: 'mistral-small-latest', apiKey: env('MISTRAL_API_KEY') };
    }
    if (env('OPENROUTER_API_KEY')) {
      return { provider: 'openrouter', model: 'meta-llama/llama-3.1-70b-instruct', apiKey: env('OPENROUTER_API_KEY') };
    }
    if (env('OLLAMA_BASE_URL')) {
      return { provider: 'ollama', model: 'llama3.1', baseUrl: env('OLLAMA_BASE_URL') };
    }
  }

  // OAuth-based providers (free with existing subscriptions)
  const oauthMgr = getOAuthManager();
  if (env('CURSOR_API_KEY')) {
    return { provider: 'cursor', model: tier === 'fast' ? 'gpt-4.1-mini' : 'gpt-4.1', apiKey: env('CURSOR_API_KEY') };
  }
  if (oauthMgr?.hasToken('github')) {
    return { provider: 'copilot', model: tier === 'fast' ? 'gpt-4.1-mini' : 'gpt-4.1' };
  }
  if (oauthMgr?.hasToken('google')) {
    return { provider: 'google-oauth', model: tier === 'fast' ? 'gemini-2.0-flash' : 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
  }
  if (oauthMgr?.hasToken('azure')) {
    return { provider: 'azure-oauth', model: tier === 'fast' ? 'gpt-4o-mini' : 'gpt-4o' };
  }

  // Smart tier — best reasoning models
  if (env('ANTHROPIC_API_KEY')) {
    return { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: env('ANTHROPIC_API_KEY') };
  }
  if (env('OPENAI_API_KEY')) {
    return { provider: 'openai', model: 'gpt-4o', apiKey: env('OPENAI_API_KEY') };
  }
  if (env('GOOGLE_API_KEY')) {
    return { provider: 'google', model: 'gemini-2.0-flash', apiKey: env('GOOGLE_API_KEY') };
  }
  if (env('XAI_API_KEY')) {
    return { provider: 'xai', model: 'grok-3', apiKey: env('XAI_API_KEY') };
  }
  if (env('DEEPSEEK_API_KEY')) {
    return { provider: 'deepseek', model: 'deepseek-chat', apiKey: env('DEEPSEEK_API_KEY') };
  }
  if (env('MISTRAL_API_KEY')) {
    return { provider: 'mistral', model: 'mistral-large-latest', apiKey: env('MISTRAL_API_KEY') };
  }
  if (env('OPENROUTER_API_KEY')) {
    return { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', apiKey: env('OPENROUTER_API_KEY') };
  }
  if (env('TOGETHER_API_KEY')) {
    return { provider: 'together', model: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', apiKey: env('TOGETHER_API_KEY') };
  }
  if (env('FIREWORKS_API_KEY')) {
    return { provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-405b-instruct', apiKey: env('FIREWORKS_API_KEY') };
  }
  if (env('GROQ_API_KEY')) {
    return { provider: 'groq', model: 'llama-3.1-70b-versatile', apiKey: env('GROQ_API_KEY') };
  }
  if (env('OLLAMA_BASE_URL')) {
    return { provider: 'ollama', model: 'llama3.1', baseUrl: env('OLLAMA_BASE_URL') };
  }

  return { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434' };
}

export function getAvailableModels(): Array<{ provider: string; model: string; label: string; tier: 'fast' | 'smart' | 'both'; cost: string }> {
  const models: Array<{ provider: string; model: string; label: string; tier: 'fast' | 'smart' | 'both'; cost: string }> = [];

  // OAuth-based providers
  const oauthMgr = getOAuthManager();
  if (env('CURSOR_API_KEY')) {
    models.push(
      { provider: 'cursor', model: 'default', label: 'Default Model (Cursor Dashboard)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'claude-4-opus', label: 'Claude 4 Opus (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'claude-4.6-opus-high-thinking', label: 'Claude 4.6 Opus High (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'claude-sonnet-4', label: 'Claude Sonnet 4 (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'gpt-4.1', label: 'GPT-4.1 (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Cursor)', tier: 'fast', cost: 'Cursor' },
      { provider: 'cursor', model: 'gpt-4o', label: 'GPT-4o (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'gpt-4o-mini', label: 'GPT-4o Mini (Cursor)', tier: 'fast', cost: 'Cursor' },
      { provider: 'cursor', model: 'o3', label: 'o3 (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'o3-mini', label: 'o3-mini (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'o4-mini', label: 'o4-mini (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Cursor)', tier: 'smart', cost: 'Cursor' },
      { provider: 'cursor', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Cursor)', tier: 'fast', cost: 'Cursor' },
    );
  }
  if (oauthMgr?.hasToken('github')) {
    models.push(
      // ── OpenAI GPT-5.x ──
      { provider: 'copilot', model: 'gpt-5.4', label: 'GPT-5.4 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.2', label: 'GPT-5.2 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.2-codex', label: 'GPT-5.2 Codex (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.1', label: 'GPT-5.1 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'gpt-5-mini', label: 'GPT-5 Mini (Copilot)', tier: 'fast', cost: 'FREE' },
      // ── OpenAI GPT-4.x ──
      { provider: 'copilot', model: 'gpt-4.1', label: 'GPT-4.1 (Copilot)', tier: 'smart', cost: 'FREE' },
      { provider: 'copilot', model: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Copilot)', tier: 'fast', cost: 'FREE' },
      { provider: 'copilot', model: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Copilot)', tier: 'fast', cost: 'FREE' },
      { provider: 'copilot', model: 'gpt-4o', label: 'GPT-4o (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-4o-mini', label: 'GPT-4o Mini (Copilot)', tier: 'fast', cost: 'FREE' },
      { provider: 'copilot', model: 'gpt-4-turbo', label: 'GPT-4 Turbo (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-4', label: 'GPT-4 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (Copilot)', tier: 'fast', cost: 'FREE' },
      // ── OpenAI Reasoning ──
      { provider: 'copilot', model: 'o4-mini', label: 'o4-mini (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'o3', label: 'o3 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'o3-mini', label: 'o3-mini (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'o1', label: 'o1 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'o1-mini', label: 'o1-mini (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'o1-preview', label: 'o1-preview (Copilot)', tier: 'smart', cost: '1x' },
      // ── Anthropic Claude ──
      { provider: 'copilot', model: 'claude-opus-4.6', label: 'Claude Opus 4.6 (Copilot)', tier: 'smart', cost: '3x' },
      { provider: 'copilot', model: 'claude-opus-4.6-fast', label: 'Claude Opus 4.6 Fast (Copilot)', tier: 'fast', cost: '30x' },
      { provider: 'copilot', model: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'claude-opus-4.5', label: 'Claude Opus 4.5 (Copilot)', tier: 'smart', cost: '3x' },
      { provider: 'copilot', model: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'claude-haiku-4.5', label: 'Claude Haiku 4.5 (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Copilot)', tier: 'smart', cost: '3x' },
      { provider: 'copilot', model: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'claude-3.5-haiku', label: 'Claude 3.5 Haiku (Copilot)', tier: 'fast', cost: '0.33x' },
      // ── Google Gemini ──
      { provider: 'copilot', model: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gemini-3-pro', label: 'Gemini 3 Pro (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gemini-3-flash', label: 'Gemini 3 Flash (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Copilot)', tier: 'fast', cost: 'FREE' },
      { provider: 'copilot', model: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite (Copilot)', tier: 'fast', cost: 'FREE' },
      // ── xAI Grok ──
      { provider: 'copilot', model: 'grok-3', label: 'Grok 3 (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'grok-3-mini', label: 'Grok 3 Mini (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'grok-code-fast-1', label: 'Grok Code Fast 1 (Copilot)', tier: 'fast', cost: '0.25x' },
      // ── Meta Llama ──
      { provider: 'copilot', model: 'llama-3.3-70b', label: 'Llama 3.3 70B (Copilot)', tier: 'smart', cost: 'FREE' },
      // ── Cohere ──
      { provider: 'copilot', model: 'command-a', label: 'Command A (Copilot)', tier: 'smart', cost: '1x' },
      // ── Mistral ──
      { provider: 'copilot', model: 'mistral-large', label: 'Mistral Large (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'mistral-small', label: 'Mistral Small (Copilot)', tier: 'fast', cost: '0.33x' },
      { provider: 'copilot', model: 'codestral', label: 'Codestral (Copilot)', tier: 'smart', cost: '1x' },
      // ── AI21 ──
      { provider: 'copilot', model: 'jamba-1.6-large', label: 'Jamba 1.6 Large (Copilot)', tier: 'smart', cost: '1x' },
      { provider: 'copilot', model: 'jamba-1.6-mini', label: 'Jamba 1.6 Mini (Copilot)', tier: 'fast', cost: '0.33x' },
      // ── Other ──
      { provider: 'copilot', model: 'raptor-mini', label: 'Raptor Mini (Copilot)', tier: 'fast', cost: 'FREE' },
    );
  }
  if (oauthMgr?.hasToken('google')) {
    models.push(
      { provider: 'google-oauth', model: 'gemini-2.5-pro-preview-06-05', label: 'Gemini 2.5 Pro (Google)', tier: 'smart', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash (Google)', tier: 'fast', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Google)', tier: 'both', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Google)', tier: 'smart', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (Google)', tier: 'fast', cost: 'FREE' },
    );
  }
  if (oauthMgr?.hasToken('azure')) {
    models.push(
      { provider: 'azure-oauth', model: 'gpt-4o', label: 'GPT-4o (Azure)', tier: 'smart', cost: 'FREE' },
      { provider: 'azure-oauth', model: 'gpt-4o-mini', label: 'GPT-4o Mini (Azure)', tier: 'fast', cost: 'FREE' },
      { provider: 'azure-oauth', model: 'gpt-4.1', label: 'GPT-4.1 (Azure)', tier: 'smart', cost: 'FREE' },
      { provider: 'azure-oauth', model: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Azure)', tier: 'fast', cost: 'FREE' },
    );
  }

  // =====================================================
  // API key-based providers (pay-per-use via own API key)
  // =====================================================

  if (env('OPENAI_API_KEY')) {
    models.push(
      { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1 (OpenAI)', tier: 'smart', cost: 'API' },
      { provider: 'openai', model: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenAI)', tier: 'fast', cost: 'API' },
      { provider: 'openai', model: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (OpenAI)', tier: 'fast', cost: 'API' },
      { provider: 'openai', model: 'gpt-4o', label: 'GPT-4o (OpenAI)', tier: 'smart', cost: 'API' },
      { provider: 'openai', model: 'gpt-4o-mini', label: 'GPT-4o Mini (OpenAI)', tier: 'fast', cost: 'API' },
      { provider: 'openai', model: 'o4-mini', label: 'o4-mini (OpenAI)', tier: 'smart', cost: 'API' },
      { provider: 'openai', model: 'o3-mini', label: 'o3-mini (OpenAI)', tier: 'smart', cost: 'API' },
      { provider: 'openai', model: 'gpt-4-turbo', label: 'GPT-4 Turbo (OpenAI)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('ANTHROPIC_API_KEY')) {
    models.push(
      { provider: 'anthropic', model: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Anthropic)', tier: 'smart', cost: 'API' },
      { provider: 'anthropic', model: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Anthropic)', tier: 'smart', cost: 'API' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Anthropic)', tier: 'smart', cost: 'API' },
      { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Anthropic)', tier: 'fast', cost: 'API' },
      { provider: 'anthropic', model: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Anthropic)', tier: 'fast', cost: 'API' },
    );
  }
  if (env('GOOGLE_API_KEY')) {
    models.push(
      { provider: 'google', model: 'gemini-2.5-pro-preview-06-05', label: 'Gemini 2.5 Pro (API Key)', tier: 'smart', cost: 'API' },
      { provider: 'google', model: 'gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash (API Key)', tier: 'fast', cost: 'API' },
      { provider: 'google', model: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (API Key)', tier: 'both', cost: 'API' },
      { provider: 'google', model: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (API Key)', tier: 'smart', cost: 'API' },
      { provider: 'google', model: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (API Key)', tier: 'fast', cost: 'API' },
    );
  }
  if (env('GROQ_API_KEY')) {
    models.push(
      { provider: 'groq', model: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B (Groq)', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Groq)', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'llama3-70b-8192', label: 'Llama 3 70B (Groq)', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama3-8b-8192', label: 'Llama 3 8B (Groq)', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B (Groq)', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'gemma2-9b-it', label: 'Gemma 2 9B (Groq)', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Groq)', tier: 'smart', cost: 'FREE' },
    );
  }
  if (env('DEEPSEEK_API_KEY')) {
    models.push(
      { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3 Chat', tier: 'smart', cost: 'API' },
      { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek R1 Reasoner', tier: 'smart', cost: 'API' },
    );
  }
  if (env('OPENROUTER_API_KEY')) {
    models.push(
      // Anthropic
      { provider: 'openrouter', model: 'anthropic/claude-opus-4-20250514', label: 'Claude Opus 4 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku (OpenRouter)', tier: 'fast', cost: 'API' },
      // OpenAI
      { provider: 'openrouter', model: 'openai/gpt-4.1', label: 'GPT-4.1 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'openai/gpt-4o', label: 'GPT-4o (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'openai/o4-mini', label: 'o4-mini (OpenRouter)', tier: 'smart', cost: 'API' },
      // Google
      { provider: 'openrouter', model: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash-preview', label: 'Gemini 2.5 Flash (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash (OpenRouter)', tier: 'fast', cost: 'API' },
      // Meta Llama
      { provider: 'openrouter', model: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)', tier: 'smart', cost: 'API' },
      // DeepSeek
      { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (OpenRouter)', tier: 'smart', cost: 'API' },
      // Mistral
      { provider: 'openrouter', model: 'mistralai/mistral-large-2411', label: 'Mistral Large (OpenRouter)', tier: 'smart', cost: 'API' },
      // Qwen
      { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B (OpenRouter)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('MISTRAL_API_KEY')) {
    models.push(
      { provider: 'mistral', model: 'mistral-large-latest', label: 'Mistral Large', tier: 'smart', cost: 'API' },
      { provider: 'mistral', model: 'mistral-medium-latest', label: 'Mistral Medium', tier: 'smart', cost: 'API' },
      { provider: 'mistral', model: 'mistral-small-latest', label: 'Mistral Small', tier: 'fast', cost: 'API' },
      { provider: 'mistral', model: 'codestral-latest', label: 'Codestral (Mistral)', tier: 'smart', cost: 'API' },
      { provider: 'mistral', model: 'pixtral-large-latest', label: 'Pixtral Large (Mistral)', tier: 'smart', cost: 'API' },
      { provider: 'mistral', model: 'open-mistral-nemo', label: 'Mistral Nemo', tier: 'fast', cost: 'API' },
    );
  }
  if (env('XAI_API_KEY')) {
    models.push(
      { provider: 'xai', model: 'grok-3', label: 'Grok 3 (xAI)', tier: 'smart', cost: 'API' },
      { provider: 'xai', model: 'grok-3-fast', label: 'Grok 3 Fast (xAI)', tier: 'fast', cost: 'API' },
      { provider: 'xai', model: 'grok-3-mini', label: 'Grok 3 Mini (xAI)', tier: 'fast', cost: 'API' },
      { provider: 'xai', model: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast (xAI)', tier: 'fast', cost: 'API' },
      { provider: 'xai', model: 'grok-2', label: 'Grok 2 (xAI)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('CEREBRAS_API_KEY')) {
    models.push(
      { provider: 'cerebras', model: 'llama-3.3-70b', label: 'Llama 3.3 70B (Cerebras)', tier: 'smart', cost: 'FREE' },
      { provider: 'cerebras', model: 'llama-3.1-8b', label: 'Llama 3.1 8B (Cerebras)', tier: 'fast', cost: 'FREE' },
      { provider: 'cerebras', model: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Cerebras)', tier: 'smart', cost: 'FREE' },
    );
  }
  if (env('TOGETHER_API_KEY')) {
    models.push(
      { provider: 'together', model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', label: 'Llama 4 Scout (Together)', tier: 'fast', cost: 'API' },
      { provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', label: 'Llama 3.1 405B Turbo (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', label: 'Llama 3.1 70B Turbo (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo (Together)', tier: 'fast', cost: 'API' },
      { provider: 'together', model: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1 (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3 (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo (Together)', tier: 'smart', cost: 'API' },
      { provider: 'together', model: 'mistralai/Mixtral-8x22B-Instruct-v0.1', label: 'Mixtral 8x22B (Together)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('FIREWORKS_API_KEY')) {
    models.push(
      { provider: 'fireworks', model: 'accounts/fireworks/models/llama4-maverick-instruct-basic', label: 'Llama 4 Maverick (Fireworks)', tier: 'smart', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/llama4-scout-instruct-basic', label: 'Llama 4 Scout (Fireworks)', tier: 'fast', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B (Fireworks)', tier: 'smart', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-405b-instruct', label: 'Llama 3.1 405B (Fireworks)', tier: 'smart', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-r1', label: 'DeepSeek R1 (Fireworks)', tier: 'smart', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3 (Fireworks)', tier: 'smart', cost: 'API' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/qwen2p5-72b-instruct', label: 'Qwen 2.5 72B (Fireworks)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('SAMBANOVA_API_KEY')) {
    models.push(
      { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (SambaNova)', tier: 'smart', cost: 'FREE' },
      { provider: 'sambanova', model: 'Meta-Llama-3.1-405B-Instruct', label: 'Llama 3.1 405B (SambaNova)', tier: 'smart', cost: 'FREE' },
      { provider: 'sambanova', model: 'Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (SambaNova)', tier: 'fast', cost: 'FREE' },
      { provider: 'sambanova', model: 'DeepSeek-R1', label: 'DeepSeek R1 (SambaNova)', tier: 'smart', cost: 'FREE' },
      { provider: 'sambanova', model: 'DeepSeek-V3-0324', label: 'DeepSeek V3 (SambaNova)', tier: 'smart', cost: 'FREE' },
      { provider: 'sambanova', model: 'Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B (SambaNova)', tier: 'smart', cost: 'FREE' },
    );
  }
  if (env('OLLAMA_BASE_URL')) {
    models.push(
      { provider: 'ollama', model: 'llama3.3', label: 'Llama 3.3 (Ollama)', tier: 'both', cost: 'LOCAL' },
      { provider: 'ollama', model: 'llama3.1', label: 'Llama 3.1 (Ollama)', tier: 'both', cost: 'LOCAL' },
      { provider: 'ollama', model: 'qwen2.5:72b', label: 'Qwen 2.5 72B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'qwen2.5:32b', label: 'Qwen 2.5 32B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'qwen2.5:14b', label: 'Qwen 2.5 14B (Ollama)', tier: 'both', cost: 'LOCAL' },
      { provider: 'ollama', model: 'qwen2.5:7b', label: 'Qwen 2.5 7B (Ollama)', tier: 'fast', cost: 'LOCAL' },
      { provider: 'ollama', model: 'qwen2.5-coder:32b', label: 'Qwen 2.5 Coder 32B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'deepseek-r1:70b', label: 'DeepSeek R1 70B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'deepseek-r1:32b', label: 'DeepSeek R1 32B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'deepseek-r1:14b', label: 'DeepSeek R1 14B (Ollama)', tier: 'both', cost: 'LOCAL' },
      { provider: 'ollama', model: 'deepseek-r1:8b', label: 'DeepSeek R1 8B (Ollama)', tier: 'fast', cost: 'LOCAL' },
      { provider: 'ollama', model: 'deepseek-v3:latest', label: 'DeepSeek V3 (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'mistral:7b', label: 'Mistral 7B (Ollama)', tier: 'fast', cost: 'LOCAL' },
      { provider: 'ollama', model: 'mixtral:8x7b', label: 'Mixtral 8x7B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'gemma2:27b', label: 'Gemma 2 27B (Ollama)', tier: 'smart', cost: 'LOCAL' },
      { provider: 'ollama', model: 'gemma2:9b', label: 'Gemma 2 9B (Ollama)', tier: 'fast', cost: 'LOCAL' },
      { provider: 'ollama', model: 'phi4:14b', label: 'Phi 4 14B (Ollama)', tier: 'both', cost: 'LOCAL' },
      { provider: 'ollama', model: 'command-r:35b', label: 'Command R 35B (Ollama)', tier: 'smart', cost: 'LOCAL' },
    );
  }

  return models;
}

function buildNotifications(): AppConfig['notifications'] {
  const tgToken = env('TELEGRAM_BOT_TOKEN');
  const tgChat = env('TELEGRAM_CHAT_ID');
  if (tgToken && tgChat) {
    return { telegram: { botToken: tgToken, chatId: tgChat } };
  }
  return undefined;
}

export function loadStrategy(filePath: string): StrategyConfig {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(raw);

  return {
    name: parsed.name || path.basename(filePath, path.extname(filePath)),
    description: parsed.description || '',
    entry: {
      conditions: (parsed.entry?.conditions || []).map(parseCondition),
      buy: {
        amountSol: parsed.entry?.buy?.amount_sol ?? 0.1,
        slippageBps: parsed.entry?.buy?.slippage_bps ?? 1500,
        priorityFeeSol: parsed.entry?.buy?.priority_fee_sol ?? 0.005,
      },
    },
    exit: {
      takeProfit: (parsed.exit?.take_profit || []).map((tp: any): TakeProfitLevel => ({
        at: tp.at,
        sellPercent: tp.sell_percent,
      })),
      stopLossPercent: parsed.exit?.stop_loss_percent ?? 50,
      timeoutMinutes: parsed.exit?.timeout_minutes,
      timeoutAction: parsed.exit?.timeout_action,
    },
    filters: parsed.filters ? {
      blacklistPatterns: parsed.filters.blacklist_patterns,
      blacklistWallets: parsed.filters.blacklist_wallets,
      minScore: parsed.filters.min_score,
    } : undefined,
  };
}

function parseCondition(raw: string | Record<string, any>): StrategyCondition {
  if (typeof raw === 'object') {
    return raw as StrategyCondition;
  }

  const operators = ['>=', '<=', '!=', '==', '>', '<', 'matches', 'in', 'not_in'] as const;
  for (const op of operators) {
    const idx = raw.indexOf(` ${op} `);
    if (idx !== -1) {
      const field = raw.slice(0, idx).trim();
      const value = raw.slice(idx + op.length + 2).trim();
      return {
        field,
        operator: op,
        value: isNaN(Number(value)) ? value : Number(value),
      };
    }
  }

  return { field: raw, operator: '==', value: true };
}
