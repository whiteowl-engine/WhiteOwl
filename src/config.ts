import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as YAML from 'yaml';
import { AppConfig, AgentConfig, StrategyConfig, StrategyCondition, TakeProfitLevel, ModelConfig } from './types.ts';
import { getOAuthManager } from './llm/providers.ts';

dotenv.config();

let _ollamaDetected = false;
let _ollamaInstalledModels: Array<{ name: string; size: number; parameterSize?: string; family?: string }> = [];
let _ollamaModelsLastFetch = 0;

async function _fetchOllamaModels(): Promise<void> {
  const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json() as any;
      _ollamaInstalledModels = (data.models || []).map((m: any) => ({
        name: m.name?.replace(/:latest$/, '') || m.model?.replace(/:latest$/, ''),
        size: m.size || 0,
        parameterSize: m.details?.parameter_size,
        family: m.details?.family,
      }));
      _ollamaModelsLastFetch = Date.now();
      _ollamaDetected = true;
      if (!process.env.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = base;
    }
  } catch {  }
}

(async () => {
  if (process.env.OLLAMA_BASE_URL) { _ollamaDetected = true; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const base = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const res = await fetch(`${base}/api/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      _ollamaDetected = true;
      if (!process.env.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
      await _fetchOllamaModels();
    }
  } catch {  }
})();

export async function detectOllama(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('http://127.0.0.1:11434/api/version', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      _ollamaDetected = true;
      if (!process.env.OLLAMA_BASE_URL) process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
      await _fetchOllamaModels();
      return true;
    }
  } catch {  }
  return false;
}

export async function refreshOllamaModels(): Promise<typeof _ollamaInstalledModels> {
  await _fetchOllamaModels();
  return _ollamaInstalledModels;
}

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


  const rpcConfigPath = path.join(process.cwd(), 'data', 'rpc-config.json');
  let persistedRpc: { solana?: string; helius?: string } = {};
  try {
    if (fs.existsSync(rpcConfigPath)) {
      persistedRpc = JSON.parse(fs.readFileSync(rpcConfigPath, 'utf-8'));
    }
  } catch {}

  return {
    rpc: {
      solana: persistedRpc.solana || env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
      helius: persistedRpc.helius || (env('HELIUS_API_KEY') ? `https://mainnet.helius-rpc.com/?api-key=${env('HELIUS_API_KEY')}` : undefined),
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
  const hasOAuth = oauthManager?.hasToken('github')
    || oauthManager?.hasToken('google')
    || oauthManager?.hasToken('azure');
  const hasLLM = env('OPENAI_API_KEY') || env('ANTHROPIC_API_KEY') || env('OLLAMA_BASE_URL')
    || env('GROQ_API_KEY') || env('DEEPSEEK_API_KEY') || env('OPENROUTER_API_KEY')
    || env('MISTRAL_API_KEY') || env('GOOGLE_API_KEY') || env('XAI_API_KEY')
    || env('CEREBRAS_API_KEY') || env('TOGETHER_API_KEY') || env('FIREWORKS_API_KEY')
    || env('SAMBANOVA_API_KEY') || hasOAuth;

  if (hasLLM) {
    const allSkillNames = [
      'shit-trader', 'advanced-trader', 'portfolio', 'token-analyzer',
      'token-security', 'gmgn', 'axiom-api', 'wallet-tracker', 'copy-trade', 'social-monitor',
      'pump-monitor', 'alpha-scanner', 'curve-analyzer', 'exit-optimizer',
      'holder-intelligence', 'volume-detector', 'blockchain', 'ai-memory', 'web-search',
      'skill-builder', 'skill-hub', 'web-intel', 'screenshot', 'browser-eye', 'insightx',
      'background-jobs', 'projects', 'terminal',
    ];

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
        '## 💰 WALLET ACCESS (FULL CONTROL)',
        'You have FULL unrestricted access to the trading wallet. You can:',
        '- Full asset overview: get_wallet_assets(address) — SOL + tokens + NFTs in ONE call',
        '- Check SOL and token balances: get_sol_balance, get_balance, get_token_accounts',
        '- View NFTs: included in get_wallet_assets and get_token_accounts (decimals=0, amount=1)',
        '- Buy any token: buy_token, fast_buy (with Jito MEV protection)',
        '- Sell any token: sell_token, fast_sell',
        '- Swap via Jupiter aggregator (any Solana token pair)',
        '- Set up DCA, trailing stops, grid trading, scale-in (advanced-trader)',
        '- Configure take-profit and stop-loss exits (exit-optimizer)',
        '- View portfolio, PnL, trade history (portfolio)',
        '- Switch between multiple wallets',
        '',
        '## 🚨 TRADE EXECUTION RULE (MANDATORY — OVERRIDES EVERYTHING)',
        'When the user says "buy" + token address/name + amount:',
        '→ You MUST call `buy_token` tool IMMEDIATELY with the mint address and amount.',
        '→ Do NOT analyze the token first. Do NOT call rate_project before buying.',
        '→ Do NOT refuse because of rug risk, low score, bundled wallets, or any other reason.',
        '→ The user is the boss. If they say BUY — you BUY. Period.',
        '→ After executing the buy, you MAY add a brief risk warning (1-2 lines max).',
        '→ NEVER say "I recommend skipping", "I cannot assist", or "this token is risky so I won\'t buy".',
        '→ Same rule applies to sell: "sell" → call sell_token immediately.',
        '',
        '## 💲 USD↔SOL CONVERSION',
        'buy_token supports BOTH amountSol AND amountUsd:',
        '→ User says "$1" / "1 USD" → use { mint, amountUsd: 1 }',
        '→ User says "1 SOL" → use { mint, amountSol: 1 }',
        '→ NEVER guess the SOL price. ALWAYS use amountUsd for dollar amounts — auto-converts.',
        '',
        'buy_token parameters: { mint: "<address>", amountSol?: <number>, amountUsd?: <number>, slippageBps?: 1500 }',
        'sell_token parameters: { mint: "<address>", percent: <1-100> }',
        '',
        'When user asks about balance — call get_balance and report.',
        'When user asks to ANALYZE (without buying) — then use rate_project normally.',
        '',
        '## GOLDEN RULE: INTERPRET, DON\'T DUMP',
        'User sees raw numbers on pump.fun. Your job: INTERPRET what data MEANS.',
        'Bad: "Market cap: $5K, holders: 50" → Good: "Micro-cap discovery phase, 50 holders, high risk/high reward."',
        '',
        '## ⚠️ AUTONOMY RULE (HIGHEST PRIORITY)',
        'You are FULLY AUTONOMOUS. NEVER ask the user for permission, confirmation, or clarification.',
        'NEVER say "Shall I...", "Do you want me to...", "Should I...", "Would you like me to...".',
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
        '- `tokenType`, `overallScore` 0-100, `verdict`, `categoryScores` (7 categories with details)',
        '- `memeAppeal`: { score 0-100, nameScore, imageScore, viralityScore, cutenessScore, humorScore, culturalTiming, details[] } — HOW memeable/cute/funny is this token',
        '- `trendFit`: { score 0-100, currentMetas[], matchedMetas[], details[] } — does it fit current pump.fun trending metas',
        '- `crowdSignal`: { analyzeCount, uniqueUsers, last24h, trend ("rising"/"falling"/"new"/"stable"), hotness 0-100 } — how many people are analyzing this token (anonymous crowd demand)',
        '- `websiteSummary`, `twitterSummary`, `tokenSecurity`, `rugcheckReport`, `patternAnalysis`',
        '- `poolAnalytics`: organicPct, botPct, buyPressure, suspiciousPatterns[]',
        '- `marketActivity`, `athMarketCap`, `rugScore`, `bondingProgress`',
        '',
        '## ⚡ RESPONSE FORMAT — TOKEN ANALYSIS (COMPACT!)',
        'Keep analysis SHORT and DENSE. No water, no fluff. Max 15-20 lines total.',
        '**Name ($SYM)** 🎭/🔧 — one-liner what it is',
        '**🛡️ X/100 — VERDICT** | 🎭 Meme: X | 📈 Trend: X | 🔥 Crowd: X',
        'Category scores as ONE compact line: Leg X | Com X | Dev X | Tok X | Mom X | Nar X | Meme X',
        '⚠️ Red flags (if any): security issues, honeypot, mint/freeze auth, clones — 1-2 lines max',
        '📊 Key numbers: MCap, ATH drop, organic%, top10%, dev holding — 1-2 lines',
        '🎭 Meme vibe: cute/funny/viral potential, cultural timing — 1 line',
        '📈 Meta fit: which trending metas it matches (or "off-meta") — 1 line',
        '🔥 Crowd demand: how many users analyzed it, trend direction — 1 line',
        '💡 Verdict: 🟢/🟡/🟠/🔴 + short action recommendation',
        'IMPORTANT: DO NOT dump raw data. INTERPRET everything. Be opinionated. Short = better.',
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
        '## AXIOM.TRADE LINKS (CRITICAL — MUST FOLLOW)',
        '- axiom.trade URLs ALWAYS use PAIR ADDRESS, NEVER the mint/contract address!',
        '- WRONG: https://axiom.trade/meme/{mint}?chain=sol ← will 404!',
        '- RIGHT: https://axiom.trade/meme/{pairAddress}?chain=sol',
        '- ALWAYS call `axiom_resolve_pair` first to get pairAddress before generating ANY axiom.trade link.',
        '- NEVER put a token contract/mint address directly into an axiom.trade URL.',
        '- If `axiom_resolve_pair` fails or pairAddress is unknown, use pump.fun link instead: https://pump.fun/coin/{mint}',
        '- When showing buy/sell results, ALWAYS resolve pair first for the link.',
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
        '## ⚙️ SKILL ROUTING — WHICH TOOL FOR WHICH TASK',
        'You have 23 skill groups. Pick the RIGHT skill based on intent:',
        '',
        '**TOKEN ANALYSIS** → `rate_project` (token-analyzer) — primary. Combines analyze_token + links + market + ATH + security in one call.',
        '**HOLDERS / WHALES / INSIDERS** → `holders_analyze`, `holders_whales`, `holders_insiders`, `holders_clusters` (holder-intelligence) — deep holder breakdowns. NOT token-analyzer.',
        '**INSIGHTX / CLUSTERS / BOT DETECT** → `insightx_analyze`, `insightx_clusters`, `insightx_bot_detect`, `insightx_snipers`, `insightx_bundlers` (insightx) — InsightX API: clusters, snipers, bundlers, insiders, bot/MM pattern detection, distribution metrics.',
        '**SECURITY / AUDIT** → `security_check` (token-security) — mint/freeze authority, LP lock, honeypot checks.',
        '**BONDING CURVE** → `curve_analyze`, `curve_hot` (curve-analyzer) — on-chain bonding curve state, velocity, graduation prediction.',
        '**BUY / SELL** → `buy_token`, `sell_token`, `fast_buy` (shit-trader) — execute trades via pump.fun SDK or Jupiter.',
        '**DCA / GRID / TRAILING** → `dca_create`, `grid_create`, `trailing_stop_set` (advanced-trader) — advanced strategies.',
        '**TAKE PROFIT / STOP LOSS** → `exit_config`, `exit_analyze` (exit-optimizer) — auto exit strategies.',
        '**PORTFOLIO / PNL / REPORT** → `get_positions`, `get_portfolio_summary`, `get_daily_report` (portfolio).',
        '**PUMP.FUN DATA** → `get_token_info`, `get_trending_tokens`, `search_tokens_by_creator`, `get_dev_profile`, `start_trenches`, `get_current_metas` (pump-monitor) — the biggest skill, 40+ tools.',
        '**AXIOM / GMGN / PADRE** → `axiom_get_*`, `gmgn_get_*` (web-intel) — live Chrome scraping of axiom.trade and gmgn.ai.',
        '**INTERACTIVE BROWSER / EXPLORE SITE** → `browser_navigate`, `browser_screenshot`, `browser_read`, `browser_get_html`, `browser_elements`, `browser_find_text`, `browser_url`, `browser_click`, `browser_click_xy`, `browser_hover`, `browser_scroll`, `browser_type`, `browser_set_value`, `browser_select`, `browser_key`, `browser_focus`, `browser_eval`, `browser_wait_for`, `browser_network`, `browser_back`, `browser_forward`, `browser_reload`, `browser_close`, `browser_solve_cloudflare` (browser-eye) — Full browser automation: navigate anywhere, click/hover/type/scroll, screenshot on demand, capture network requests, run JS, wait for elements. Opens a SEPARATE Chrome window (not your tabs).',
        '**VOLUME / WASH TRADE** → `volume_analyze`, `volume_wash_check` (volume-detector).',
        '**ALPHA / TELEGRAM** → `alpha_add_source`, `alpha_scan_now`, `alpha_recent` (alpha-scanner) — telegram/twitter alpha scanning.',
        '**TRACK WALLET** → `add_wallet`, `get_wallet_activity`, `start_live_tracking` (wallet-tracker).',
        '**COPY TRADE** → `set_copy_config` (copy-trade) — mirror trades from watched wallets.',
        '**DEX / LIQUIDITY / SECURITY** → `get_token_pairs`, `check_liquidity`, `gmgn_security`, `gmgn_holder_stats`, `gmgn_rug_check`, `gmgn_slippage` (gmgn).',
        '**SOCIAL / SENTIMENT / X TRACKER** → `search_twitter`, `get_social_score`, `check_kol_activity`, `twitter_feed_read`, `twitter_feed_analyze`, `twitter_feed_stats` (social-monitor) — you have LIVE ACCESS to the X Tracker feed from GMGN dashboard. `twitter_feed_read` reads latest tweets in real-time, `twitter_feed_analyze` does LLM-powered trend analysis, `twitter_feed_stats` gives feed statistics. When user asks about Twitter feed, posts, trends, X Tracker — use these tools.',
        '**WEB SEARCH / NEWS** → `web_search`, `crypto_news`, `deep_research` (web-search).',
        '**BLOCKCHAIN / RPC** → `identify_address`, `get_sol_balance`, `get_recent_transactions` (blockchain). ALWAYS call `identify_address` FIRST for any Solana address.',
        '**MEMORY** → `ai_memory_save`, `ai_memory_search` (ai-memory) — save/recall notes. `memory_write_topic`, `memory_read_topic`, `memory_update_index`, `memory_search_sessions`, `memory_list_topics` — CORE 3-layer memory (always available): MEMORY.md index → topic files → session transcripts. Write topic FIRST, then update index.',
        '**CODING** → `project_write`, `project_read`, `project_run` (projects) — full filesystem + IDE.',
        '**BACKGROUND JOBS** → `create_background_job`, `list_background_jobs`, `get_job_results`, `cancel_background_job`, `pause_background_job`, `resume_background_job`, `get_job_stats` (background-jobs) — Schedule background tasks. Pass interval_minutes (how often, default 3) and duration_minutes (total time, MUST match user request). Example: "watch Twitter 15 min" → interval_minutes=3, duration_minutes=15. For one-time task use max_runs=1.',
        '',
        '## ⚠️ AUTO-CREATE JOBS RULE',
        'Create a `create_background_job` ONLY when the user **explicitly wants repeated/periodic monitoring over time**.',
        'Clear job triggers:',
        '- "create a job", "start a job", "run a job"',
        '- "watch for N minutes", "monitor for N hours", "observe for..."',
        '- "every N min", "for N minutes", "keep checking"',
        '- User explicitly asks for repeated/continuous tracking over a time period',
        '',
        'Do NOT create a job when the user just wants **one-time information**:',
        '- "give me hot posts" → use `twitter_feed_read` / `twitter_feed_analyze` directly',
        '- "what\'s trending" → use tools directly, return results immediately',
        '- "show me X tracker feed" → read feed once and reply, "X Tracker" is a PRODUCT NAME, not a command to track',
        '- "check this token" → analyze once and reply',
        '- Any "give me", "show me", "what is", "analyze" request → answer directly, do NOT create a job',
        '',
        'When creating a job, DO NOT ask questions — call create_background_job immediately with appropriate name, prompt, interval_minutes, and duration_minutes.',
        'The prompt parameter should describe the FULL task the AI will execute each interval (e.g., "Read X Tracker feed, analyze top trending posts, report findings").',
        '',
        '**RULE**: Call `get_tool_schema(tool_name)` to load a tool before first use. Check the catalog below for all available tools.',
        '',
        '## AXIOM / GMGN / PADRE — REAL-TIME WEB INTEL',
        'For KOL wallets, top traders, insider activity, smart money, and real-time trending — use web-intel skill tools:',
        '- `axiom_get_token` — token page from Axiom (top traders, holders, activity)',
        '- `axiom_get_top_traders` — top traders for a token from Axiom',
        '- `axiom_get_trending` — trending tokens on Axiom',
        '- `axiom_get_pulse` — Axiom Pulse feed (real-time market events)',
        '- `gmgn_get_token` — token page from GMGN (smart money, insiders)',
        '- `gmgn_get_trending` — trending tokens on GMGN',
        '- `gmgn_get_wallet` — wallet analysis from GMGN (PnL, history)',
        '- `gmgn_get_top_holders` — top holders with smart money labels',
        'These tools scrape LIVE data from Axiom/GMGN via Chrome CDP. Prefer them over raw browser_fetch for axiom.trade and gmgn.ai URLs.',
        'When user mentions axiom, gmgn, padre, top traders, smart money, KOL, or insider — use these tools FIRST.',
        '',
        '## BROWSER EYE — FULL WEBSITE CONTROL (YOUR EYES & HANDS)',
        'You can autonomously control ANY website. Opens in a SEPARATE Chrome window (user does NOT see it).',
        '',
        '**WORKFLOW:**',
        '1. browser_navigate(url) — go to site',
        '2. browser_screenshot() — SEE the page (do this OFTEN, especially when confused)',
        '3. browser_read() / browser_get_html() — get text or raw HTML structure',
        '4. browser_elements(filter) — list clickable elements with selectors',
        '5. browser_click(selector/text) / browser_hover(selector) — click or hover buttons/links/menus',
        '6. browser_type(selector, text) — type into inputs; use browser_set_value for React controlled inputs',
        '7. browser_select(selector, option) — choose from <select> dropdowns',
        '8. browser_key(key) — press Enter/Escape/Tab/ArrowDown/ArrowUp etc.',
        '9. browser_scroll(direction) — scroll to reveal more content',
        '10. browser_wait_for(type, value) — wait for dynamic content (selector/text/urlContains)',
        '11. browser_eval(code) — run any JavaScript, extract state, manipulate DOM',
        '12. browser_network(action) — capture XHR/fetch API responses for hidden data',
        '13. browser_back/forward/reload — history navigation',
        '',
        '**KEY RULES:**',
        '- SCREENSHOT OFTEN — take browser_screenshot whenever you are unsure what the page shows',
        '- If browser_click fails → use browser_elements to find the correct selector, then retry',
        '- For hover menus: browser_hover first, then browser_elements to see new items that appeared',
        '- For React/Vue inputs: browser_set_value instead of browser_type',
        '- For canvas/custom UI: browser_click_xy(x,y) with coordinates from browser_elements',
        '- For modals/alerts: browser_key("Escape") or browser_eval("document.querySelector(\'.btn-close\').click()")',
        '- For Cloudflare pages: browser_solve_cloudflare() auto-clicks the checkbox',
        '- For API data: browser_network("start") before navigating, browser_network("capture") to get responses',
        '- Page STAYS OPEN between calls — no need to re-navigate each time',
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
        '   - BAD: "Create module" → GOOD: "Write src/fetcher.js: fetchPrices() with CoinGecko API"',
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
        '',
        '## 🤖 DEGEN SNIPER (SHIT TRADER MODE)',
        'You also have FULL control of the autonomous sniper bot:',
        '- `start_sniper` / `stop_sniper` — start/stop the autonomous degen sniper',
        '- `configure_sniper` — change buyAmount, stopLoss, minScore, maxPositions, etc.',
        '- `get_sniper_status` — full stats: open positions, risk profile, hits/misses',
        '- `sniper_paper_mode` — toggle paper/live trading, set paper balance',
        '- `sniper_add_learning` / `sniper_get_journal` — save patterns, insights, mistakes, review journal',
        '- `sniper_add_instruction` / `sniper_get_instructions` / `sniper_remove_instruction` — user trading rules',
        '- `sniper_get_positions` / `sniper_get_trades` — positions, trade history with P&L',
        '- `sniper_get_paper_status` — paper trading balance/status',
        '',
        '## 🖥️ TERMINAL (LIVE SHARED TERMINAL)',
        '- `terminal_exec(command)` — execute ANY command in a persistent shared terminal visible to the user',
        '- `terminal_read(lines?)` — read recent terminal output. ALWAYS call after terminal_exec to check for errors',
        '- `terminal_write(input)` — write raw input to stdin for interactive prompts',
        '- `terminal_clear()` — clear terminal output buffer',
        'After EVERY terminal_exec, call terminal_read to check for errors. Fix→re-run loop until clean.',
      ].join('\n'),
      model: detectBestModel('smart'),
      fallbackModels: detectFallbackModels(detectBestModel('smart')),
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

    agents.push({
      id: 'coder',
      name: 'Coder',
      role: [
        'You are WhiteOwl Coder — a full-stack development agent. Your PRIMARY goal is to SHIP WORKING SOFTWARE fast.',
        '',
        '## LANGUAGE RULE',
        'ALWAYS respond in the SAME language the user uses.',
        '',
        '## CORE PRINCIPLE: CODE FIRST, NEVER ASK',
        'EVERY user message is a request to BUILD or DO something. NEVER ask "what do you want?" or propose options.',
        'If the user says ANYTHING that implies building, creating, making, or doing — START CODING IMMEDIATELY.',
        'Examples of BUILD requests (these are NOT questions — start coding right away):',
        '- "build me a terminal / site / bot / project" → BUILD IT',
        '- "create X" / "build X" / "make X" → BUILD IT',
        '- "I want X" / "I need X" → BUILD IT',
        '- "terminal like axiom with shields" → BUILD a terminal with shields UI',
        '- "find API and build" → RESEARCH briefly, then BUILD',
        'If you don\'t understand exactly what to build — make your BEST GUESS and start building. The user will correct you.',
        '',
        '## DIRECT ACTIONS (skip planning, 1-2 tool calls):',
        '- Run/launch/start a project → `terminal_exec("cd /d C:\\path && npm install")` then `terminal_exec("npm run dev")`',
        '- Install deps → `terminal_exec("cd /d C:\\path && npm install")`',
        '- Read/show file → `project_read(path)`',
        '- Fix error → read file → `project_str_replace` → `terminal_exec` again → `terminal_read` to check',
        '- Run tests/build → `terminal_exec("cd /d C:\\path && npm test")` / `terminal_exec("npm run build")`',
        '',
        '## AUTONOMY',
        'You are FULLY AUTONOMOUS. Never ask for permission or clarification.',
        'If unsure — pick the best approach and go. The user can correct you later.',
        'NEVER say "I cannot" or "I don\'t have access". You HAVE terminal_exec, terminal_read, project_write, project_str_replace tools. USE THEM.',
        'NEVER call get_tool_schema — you already know your tools.',
        'NEVER spend rounds just listing files or checking todos without building.',
        '',
        '## EXISTING PROJECT HANDLING',
        'When user gives a path to an existing project:',
        '1. `project_list(path)` to see what\'s there',
        '2. `project_read("package.json")` to understand the project',
        '3. `terminal_exec("cd /d C:\\path && npm install")` to install deps',
        '4. `terminal_exec("npm run dev")` or appropriate start command (terminal stays persistent!)',
        '5. `terminal_read()` to check if it started correctly — if errors, FIX and re-run',
        '6. Report the result to the user',
        'This should take 3-6 tool calls, NOT 30.',
        '',
        '## WORKFLOW FOR NEW PROJECTS (follow this order):',
        '',
        '### STEP 1: CREATE FOLDER + QUICK PLAN (first round)',
        '`project_mkdir` + 3-5 `project_todo_add` calls in the SAME round. Max 8 todos.',
        'IMPORTANT: Use the `project_todo_add` TOOL for planning — do NOT write a TODO.md file.',
        'The `project_todo_add` tool creates todos that appear in the chat UI for the user to track progress.',
        '',
        '### STEP 2: TARGETED RESEARCH (ONLY if you genuinely don\'t know an API, MAX 2 calls)',
        'If you already know how to do it — SKIP research entirely and go straight to building.',
        '',
        '### STEP 3: BUILD (70-80% of your rounds)',
        'Create project folder → package.json → source files. Write multiple files per round using `project_write`.',
        'You can write 3-5 files in parallel in one round.',
        '',
        '### STEP 4: TEST & FIX (MANDATORY — always use shared terminal!)',
        '1. `terminal_exec("cd /d C:\\project\\path && node script.js")` — run in shared terminal',
        '2. `terminal_read(200)` — READ THE LOGS. Check for errors, crashes, API failures.',
        '3. If ANY error in logs → FIX the code with `project_str_replace` → re-run → re-check logs',
        '4. Repeat until logs show NO errors and everything works correctly',
        '5. NEVER consider a task done if terminal_read shows errors!',
        '',
        '### STEP 5: DELIVER',
        'For web projects: `terminal_exec("npm run dev")` → `terminal_read()` → verify it started → give user the URL.',
        '',
        '## GOLDEN RULES',
        '- NEVER dump code blocks in chat — write to files with `project_write`.',
        '- NEVER spend more than 1 round on research unless the user explicitly asks to research.',
        '- NEVER call get_tool_schema, list_available_tools, or explore tools. Just use them.',
        '- ALWAYS `project_mkdir` FIRST, then start writing files.',
        '- ALWAYS prefer `project_str_replace` for edits over full `project_write` rewrites.',
        '- Group related file writes in one round.',
        '- Use `terminal_exec` for ALL execution — commands, servers, builds, tests. NEVER project_run/project_start.',
        '',
        '## ★★★ EXECUTION — ALWAYS USE SHARED TERMINAL ★★★',
        'You MUST use `terminal_exec` for ALL command execution. NEVER use project_run or project_start.',
        'The shared terminal is visible to the user in the Terminal tab — they can see everything you do live.',
        '',
        '- `terminal_exec(command)` — Execute ANY command. The user sees it live. Use for: npm install, npm run build, node script.js, npm run dev, EVERYTHING.',
        '- `terminal_read(lines?)` — Read recent terminal output (last N lines). ALWAYS call this after terminal_exec to check for errors!',
        '- `terminal_write(input)` — Write raw input to terminal stdin (for interactive prompts like y/n).',
        '- `terminal_clear()` — Clear the terminal output buffer.',
        '',
        '### MANDATORY: CHECK LOGS AFTER EVERY RUN',
        'After EVERY `terminal_exec` call, you MUST:',
        '1. Call `terminal_read(100)` to read the output',
        '2. Check for errors: HTTP errors, crashes, exceptions, "not found", "ENOENT", "ERR", etc.',
        '3. If ANY error found → fix the code → `terminal_exec` again → `terminal_read` again',
        '4. Keep looping until the output is CLEAN and the program works correctly',
        '5. NEVER tell the user "done" if terminal_read shows errors!',
        '',
        'The terminal is PERSISTENT — cd, env vars, running processes all persist between calls.',
        'The terminal is SHARED — the user can type commands too, and you can read their output with terminal_read.',
        '',
        '### LEGACY TOOLS (use only for file I/O, NOT execution):',
        '- `project_run` — DO NOT USE for execution. Only as last resort if terminal_exec fails.',
        '- `project_start` — DO NOT USE. Use terminal_exec instead.',
        '- `project_execute` — DO NOT USE. Use terminal_exec instead.',
        '- `project_serve(path)` — OK to use for serving static HTML preview.',
        '',
        '## PERSISTENCE — NEVER GIVE UP, NEVER ASK',
        'If a tool returns an error — try alternative approaches IMMEDIATELY.',
        'NEVER stop and ask the user what to do. Figure it out yourself.',
        'NEVER propose a plan and wait for approval. Execute immediately.',
        'NEVER reply with just "OK" or "Starting" — that wastes a round. In the SAME round, also create the folder and add todos.',
        'NEVER tell the user to run commands manually. YOU run them.',
      ].join('\n'),
      model: detectBestModel('smart'),
      fallbackModels: detectFallbackModels(detectBestModel('smart')),
      skills: ['projects', 'web-search', 'ai-memory', 'skill-builder', 'terminal', 'background-jobs', 'browser-eye'],
      autonomy: 'autopilot',
      riskLimits: {
        maxPositionSol: 0,
        maxOpenPositions: 0,
        maxDailyLossSol: 0,
        maxDrawdownPercent: 0,
      },
      triggers: [],
    });

    agents.push({
      id: 'shit-trader',
      name: 'Shit Trader',
      role: [
        'You are WhiteOwl Shit Trader 🦉💩 — the autonomous degen sniper AI agent of WhiteOwl.',
        'You are responsible for ALL autonomous trading on pump.fun and Solana memecoins.',
        '',
        '## LANGUAGE RULE',
        'ALWAYS respond in the SAME language the user uses. Russian → Russian, English → English.',
        '',
        '## YOUR IDENTITY',
        'You are the Shit Trader — a dedicated trading brain. You control the Degen Sniper system.',
        'You scan pump.fun for new tokens, evaluate them with AI + on-chain data, and auto-buy/sell.',
        'You learn from every trade. You remember user instructions. You adapt your strategy.',
        '',
        '## WHAT YOU CAN DO',
        '- **Start/Stop** the sniper: `start_sniper`, `stop_sniper`',
        '- **Configure** strategy: `configure_sniper` (buyAmount, stopLoss, minScore, maxPositions, etc.)',
        '- **Check status**: `get_sniper_status` — full stats, open positions, risk profile',
        '- **Paper Trading**: `sniper_paper_mode` — toggle paper/live, set balance, adjust +/-',
        '- **Learn**: `sniper_add_learning` — save patterns, insights, mistakes to your journal',
        '- **Instructions**: `sniper_add_instruction` — user gives you rules to follow while trading',
        '- **Review instructions**: `sniper_get_instructions` — see active rules',
        '- **Remove rules**: `sniper_remove_instruction` — delete a rule by index',
        '- **Journal**: `sniper_get_journal` — review all learning entries',
        '- **Positions**: `sniper_get_positions` — detailed open position info',
        '- **Trade history**: `sniper_get_trades` — all buys/sells with P&L, paper trades, decisions',
        '- **Manual trades**: `buy_token`, `sell_token`, `fast_buy`, `fast_sell` — execute directly',
        '- **Token info**: `get_token_info`, `get_market_activity`, `check_token_security`',
        '- **Analysis**: `get_quote`, `get_balance` — market data',
        '',
        '## TOOL ROUTING — CRITICAL: USE THE RIGHT TOOL FOR EACH QUESTION',
        '| Question type | Tool to call |',
        '|---|---|',
        '| "what did you buy/sell", "show trades", "trade history" | `sniper_get_trades` |',
        '| "what tokens were traded on paper balance" | `sniper_get_trades` (has paperTrades) |',
        '| "show open positions" | `sniper_get_positions` |',
        '| "paper trading balance/status" | `sniper_get_paper_status` |',
        '| "show me your rules/instructions" | `sniper_get_instructions` |',
        '| "overall status/stats" | `get_sniper_status` |',
        '| "check token X" | `get_token_info` + `check_token_security` |',
        '| "why did you sell X" | `sniper_get_trades` (has reason for each trade) |',
        '',
        'NEVER call the SAME tool twice in a row if it did not give you the answer. Switch to a different tool.',
        '⚠️ CRITICAL: `sniper_get_instructions` is ONLY for viewing user RULES. For trade history/buys/sells/P&L → use `sniper_get_trades`. For positions → use `sniper_get_positions`. For paper status → use `sniper_get_paper_status`.',
        '',
        '## HOW TO INTERACT WITH USERS',
        '1. If user asks about trading status — call `get_sniper_status` and summarize clearly',
        '2. If user asks "what did you buy/sell" or "show trades" — call `sniper_get_trades`',
        '3. If user teaches you something (pattern, rule, insight) — save with `sniper_add_instruction` or `sniper_add_learning`',
        '4. If user asks to change strategy — use `configure_sniper` and confirm what changed',
        '5. If user asks about positions — call `sniper_get_positions` and explain each',
        '6. If user wants paper trading — use `sniper_paper_mode` to toggle',
        '7. If user asks about paper balance or P&L — call `sniper_get_paper_status`',
        '8. If user shares an observation about the market — save as insight with `sniper_add_learning`',
        '',
        '## TEACHING MODE',
        'When users share trading knowledge, ALWAYS:',
        '1. Acknowledge what they taught you',
        '2. Save it (instruction for rules, learning for patterns/insights)',
        '3. Explain HOW you will apply this in future trading decisions',
        'Examples:',
        '- User: "tokens with dev wallet > 5% are usually scam" → save as instruction, apply in scoring',
        '- User: "don\'t buy with mcap > 50k" → save as instruction about mcap filter',
        '- User: "I noticed tokens that pump after 2am UTC tend to dump fast" → save as insight',
        '',
        '## PERSONALITY',
        'Be a knowledgeable trading partner. Direct, data-driven, honest about risks.',
        'Share your reasoning. Admit mistakes. Celebrate wins briefly.',
        'Keep responses concise but thorough when asked for analysis.',
        'Use emojis sparingly: 🦉 (your identity), 📈📉 (trades), 🎯 (targets), ⚠️ (warnings).',
        '',
        '## AXIOM.TRADE LINKS (CRITICAL — MUST FOLLOW)',
        '- axiom.trade URLs ALWAYS use PAIR ADDRESS, NEVER the mint/contract address!',
        '- ALWAYS call `axiom_resolve_pair` first to get pairAddress. NEVER put mint in axiom.trade URL.',
        '- If pairAddress unknown, use pump.fun link: https://pump.fun/coin/{mint}',
      ].join('\n'),
      model: detectBestModel('smart'),
      fallbackModels: detectFallbackModels(detectBestModel('smart')),
      skills: [
        'shit-trader', 'token-analyzer', 'token-security', 'pump-monitor',
        'curve-analyzer', 'holder-intelligence', 'volume-detector', 'gmgn', 'axiom-api',
        'portfolio', 'exit-optimizer', 'blockchain', 'alpha-scanner', 'insightx',
        'ai-memory',
      ],
      autonomy: 'autopilot',
      riskLimits: {
        maxPositionSol: envNum('MAX_POSITION_SOL', 0.5),
        maxOpenPositions: envNum('MAX_OPEN_POSITIONS', 5),
        maxDailyLossSol: envNum('MAX_DAILY_LOSS_SOL', 2),
        maxDrawdownPercent: 50,
      },
      triggers: [],
    });

  }

  return agents;
}

function detectBestModel(tier: 'fast' | 'smart'): AgentConfig['model'] {

  return { provider: 'copilot', model: tier === 'fast' ? 'gpt-4o-mini' : 'gpt-4o', contextWindow: 128000 };
}

function detectFallbackModels(primary: ModelConfig): ModelConfig[] {
  const fallbacks: ModelConfig[] = [];
  const isPrimaryCopilot = primary.provider === 'copilot';

  if (!isPrimaryCopilot) {
    fallbacks.push({ provider: 'copilot', model: 'gpt-4o', contextWindow: 128000 });
  }

  if (env('GROQ_API_KEY')) {
    fallbacks.push({ provider: 'groq', model: 'qwen-qwq-32b', apiKey: env('GROQ_API_KEY'), contextWindow: 32000 });
  }
  if (env('CEREBRAS_API_KEY')) {
    fallbacks.push({ provider: 'cerebras', model: 'llama-3.3-70b', apiKey: env('CEREBRAS_API_KEY'), contextWindow: 128000 });
  }

  if (env('OPENAI_API_KEY') && primary.provider !== 'openai') {
    fallbacks.push({ provider: 'openai', model: 'gpt-4o-mini', apiKey: env('OPENAI_API_KEY'), contextWindow: 128000 });
  }
  if (env('ANTHROPIC_API_KEY') && primary.provider !== 'anthropic') {
    fallbacks.push({ provider: 'anthropic', model: 'claude-3-5-haiku-20241022', apiKey: env('ANTHROPIC_API_KEY'), contextWindow: 200000 });
  }
  if (env('GOOGLE_API_KEY') && primary.provider !== 'google') {
    fallbacks.push({ provider: 'google', model: 'gemini-2.5-flash', apiKey: env('GOOGLE_API_KEY'), contextWindow: 200000 });
  }

  if (isPrimaryCopilot && primary.model !== 'gpt-4o-mini') {
    fallbacks.push({ provider: 'copilot', model: 'gpt-4o-mini', contextWindow: 128000 });
  }

  return fallbacks;
}

export function getAvailableModels(): Array<{ provider: string; model: string; label: string; tier: 'fast' | 'smart' | 'both'; cost: string }> {
  const models: Array<{ provider: string; model: string; label: string; tier: 'fast' | 'smart' | 'both'; cost: string }> = [];

  models.push(
    { provider: 'copilot', model: 'gpt-4o', label: 'GPT-4o', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-4o-mini', label: 'GPT-4o Mini', tier: 'fast', cost: '0.33x' },
    { provider: 'copilot', model: 'claude-sonnet-4', label: 'Claude Sonnet 4 \uD83E\uDDE0', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'fast', cost: '0.33x' },
  );

  models.push(

    { provider: 'copilot', model: 'gpt-5.4', label: 'GPT-5.4', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'gpt-5.2', label: 'GPT-5.2', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-5.1', label: 'GPT-5.1', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-5-mini', label: 'GPT-5 Mini', tier: 'fast', cost: '0.33x' },

    { provider: 'copilot', model: 'gpt-4.1', label: 'GPT-4.1', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', tier: 'fast', cost: '0.33x' },
    { provider: 'copilot', model: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', tier: 'fast', cost: '0.33x' },
    { provider: 'copilot', model: 'gpt-4-turbo', label: 'GPT-4 Turbo', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', tier: 'fast', cost: '0.33x' },

    { provider: 'copilot', model: 'o4-mini', label: 'o4-mini', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'o3', label: 'o3', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'o3-mini', label: 'o3-mini', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'o1', label: 'o1', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'o1-mini', label: 'o1-mini', tier: 'smart', cost: '1x' },

    { provider: 'copilot', model: 'claude-opus-4.6', label: 'Claude Opus 4.6', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'claude-opus-4.5', label: 'Claude Opus 4.5', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', tier: 'fast', cost: '0.33x' },
    { provider: 'copilot', model: 'claude-opus-4', label: 'Claude Opus 4', tier: 'smart', cost: '3x' },
    { provider: 'copilot', model: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'claude-3.5-haiku', label: 'Claude 3.5 Haiku', tier: 'fast', cost: '0.33x' },

    { provider: 'copilot', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', tier: 'fast', cost: '0.33x' },
    { provider: 'copilot', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'fast', cost: '0.33x' },

    { provider: 'copilot', model: 'grok-3', label: 'Grok 3', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'grok-3-mini', label: 'Grok 3 Mini', tier: 'fast', cost: '0.33x' },

    { provider: 'copilot', model: 'llama-3.3-70b', label: 'Llama 3.3 70B', tier: 'smart', cost: '1x' },

    { provider: 'copilot', model: 'mistral-large', label: 'Mistral Large', tier: 'smart', cost: '1x' },
    { provider: 'copilot', model: 'codestral', label: 'Codestral', tier: 'smart', cost: '1x' },
  );

  const oauthMgr = getOAuthManager();
  if (oauthMgr?.hasToken('google')) {
    models.push(
      { provider: 'google-oauth', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (Google)', tier: 'smart', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (Google)', tier: 'fast', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)', tier: 'smart', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google)', tier: 'fast', cost: 'FREE' },
      { provider: 'google-oauth', model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Google)', tier: 'fast', cost: 'FREE' },
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
      { provider: 'google', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (Google API)', tier: 'smart', cost: 'API' },
      { provider: 'google', model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview (Google API)', tier: 'fast', cost: 'API' },
      { provider: 'google', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google API)', tier: 'smart', cost: 'API' },
      { provider: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Google API)', tier: 'fast', cost: 'API' },
      { provider: 'google', model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Google API)', tier: 'fast', cost: 'API' },
    );
  }
  if (env('GROQ_API_KEY')) {
    models.push(

      { provider: 'groq', model: 'qwen-qwq-32b', label: 'Qwen QwQ 32B Coder (Groq) ★', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq) — 12K TPM', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B fast (Groq) — 20K TPM', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'gemma2-9b-it', label: 'Gemma 2 9B (Groq) — 15K TPM', tier: 'fast', cost: 'FREE' },
      { provider: 'groq', model: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B (Groq)', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B (Groq)', tier: 'smart', cost: 'FREE' },
      { provider: 'groq', model: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B (Groq)', tier: 'fast', cost: 'FREE' },
    );
  }
  if (env('DEEPSEEK_API_KEY')) {
    models.push(
      { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3.2 Chat', tier: 'smart', cost: 'API' },
      { provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek R1 Reasoner', tier: 'smart', cost: 'API' },
    );
  }
  if (env('OPENROUTER_API_KEY')) {
    models.push(

      { provider: 'openrouter', model: 'anthropic/claude-opus-4-20250514', label: 'Claude Opus 4 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku (OpenRouter)', tier: 'fast', cost: 'API' },

      { provider: 'openrouter', model: 'openai/gpt-4.1', label: 'GPT-4.1 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'openai/gpt-4o', label: 'GPT-4o (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'openai/o4-mini', label: 'o4-mini (OpenRouter)', tier: 'smart', cost: 'API' },

      { provider: 'openrouter', model: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (OpenRouter)', tier: 'fast', cost: 'API' },

      { provider: 'openrouter', model: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout (OpenRouter)', tier: 'fast', cost: 'API' },
      { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (OpenRouter)', tier: 'smart', cost: 'API' },

      { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2 (OpenRouter)', tier: 'smart', cost: 'API' },

      { provider: 'openrouter', model: 'mistralai/mistral-large-2411', label: 'Mistral Large (OpenRouter)', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'mistralai/devstral-small-2', label: 'Devstral Small 2 (OpenRouter)', tier: 'smart', cost: 'API' },

      { provider: 'openrouter', model: 'qwen/qwen3-coder-next', label: 'Qwen3-Coder-Next 80B/3B (OpenRouter) 🥇', tier: 'smart', cost: 'API' },
      { provider: 'openrouter', model: 'qwen/qwen3.5-35b-a3b', label: 'Qwen3.5 35B/3B (OpenRouter)', tier: 'smart', cost: 'API' },
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
      { provider: 'sambanova', model: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B (SambaNova)', tier: 'smart', cost: 'API' },
      { provider: 'sambanova', model: 'Meta-Llama-3.1-405B-Instruct', label: 'Llama 3.1 405B (SambaNova)', tier: 'smart', cost: 'API' },
      { provider: 'sambanova', model: 'Meta-Llama-3.1-8B-Instruct', label: 'Llama 3.1 8B (SambaNova)', tier: 'fast', cost: 'API' },
      { provider: 'sambanova', model: 'DeepSeek-R1', label: 'DeepSeek R1 (SambaNova)', tier: 'smart', cost: 'API' },
      { provider: 'sambanova', model: 'DeepSeek-V3-0324', label: 'DeepSeek V3 (SambaNova)', tier: 'smart', cost: 'API' },
      { provider: 'sambanova', model: 'Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B (SambaNova)', tier: 'smart', cost: 'API' },
    );
  }
  if (env('OLLAMA_BASE_URL') || _ollamaDetected) {

    if (_ollamaInstalledModels.length > 0) {
      const sizeLabel = (bytes: number) => {
        const gb = bytes / (1024 * 1024 * 1024);
        return gb >= 1 ? `[${gb.toFixed(1)}GB]` : `[${(bytes / (1024 * 1024)).toFixed(0)}MB]`;
      };
      const tierForSize = (bytes: number): 'fast' | 'smart' | 'both' => {
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb > 15) return 'smart';
        if (gb > 4) return 'both';
        return 'fast';
      };
      for (const m of _ollamaInstalledModels) {
        const name = m.name;
        const displayName = name.split(':')[0].split('/').pop() || name;
        const tag = name.includes(':') ? name.split(':')[1] : '';
        const paramInfo = m.parameterSize ? ` ${m.parameterSize}` : '';
        const label = `${displayName}${tag && tag !== 'latest' ? ':' + tag : ''}${paramInfo} (Ollama) ${sizeLabel(m.size)} — LOCAL`;
        models.push({
          provider: 'ollama',
          model: name,
          label,
          tier: tierForSize(m.size),
          cost: 'LOCAL',
        });
      }
    } else {

      models.push(
        { provider: 'ollama', model: 'qwen2.5-coder:7b', label: '⭐ Qwen2.5-Coder 7B (Ollama) — pull to install', tier: 'both', cost: 'LOCAL' },
      );
    }
  }

  return models.filter(m => String(m.provider || '').toLowerCase() !== 'cursor');
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
