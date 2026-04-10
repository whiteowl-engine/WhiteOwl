import {
  AgentConfig,
  AgentState,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  LLMToolCall,
  LoggerInterface,
  EventBusInterface,
  AutonomyLevel,
  WalletInterface,
} from '../types.ts';
import * as pathMod from 'path';
import * as fsMod from 'fs';
import * as osMod from 'os';
import { SkillLoader } from './skill-loader.ts';
import { MarketStateBuilder } from './market-state.ts';
import { createLLMProvider } from '../llm/index.ts';
import { StructuredMemorySkill } from '../skills/structured-memory.ts';
import { getSolPriceUsd, getSolPriceReliable } from './sol-price.ts';

interface SubAgentProfile {
  role: string;
  skills: string[];
  promptMode: 'full' | 'minimal' | 'none';
  efficiencyMode: EfficiencyMode;
}

const SUB_AGENT_PROFILES: Record<string, SubAgentProfile> = {
  researcher: {
    role: 'You are a research agent. Find information using search tools and return concise findings. Do NOT write code — only gather facts, URLs, and data. Summarize results in under 500 chars.',
    skills: ['web-search'],
    promptMode: 'minimal',
    efficiencyMode: 'economy',
  },
  coder: {
    role: 'You are a coding agent. Write, edit, create, and FIX files. For NEW projects: plan TODOs, create files with project_write, install deps, test. For BUG FIXES: read the existing code with project_read first, identify the problem, then fix with project_str_replace (small targeted edits, NOT full rewrites). Use terminal for npm install, builds, tests. Act immediately — do NOT research or search unless you truly lack information. If an API is down, add fallback/error handling in code instead of searching for alternatives.',
    skills: ['projects', 'terminal'],
    promptMode: 'minimal',
    efficiencyMode: 'balanced',
  },
  tester: {
    role: 'You are a testing agent. Run commands, verify builds, check for errors, and report results. Do NOT write new features — only test and validate existing code.',
    skills: ['projects', 'terminal'],
    promptMode: 'minimal',
    efficiencyMode: 'economy',
  },
  generic: {
    role: 'You are a focused sub-agent. Complete the assigned task efficiently using available tools. Be concise.',
    skills: ['projects', 'web-search'],
    promptMode: 'minimal',
    efficiencyMode: 'economy',
  },
};

interface AgentRunnerOpts {
  config: AgentConfig;
  llm: LLMProvider;
  skills: SkillLoader;
  eventBus: EventBusInterface;
  logger: LoggerInterface;
  marketState?: MarketStateBuilder;
  wallet?: WalletInterface;
}

type EfficiencyMode = 'economy' | 'balanced' | 'max';

export interface AgentHooks {
  beforeToolCall?: (toolName: string, params: Record<string, any>) => Promise<{ skip?: boolean; params?: Record<string, any> } | void>;
  afterToolCall?: (toolName: string, params: Record<string, any>, result: any) => Promise<any>;
  beforeLLMCall?: (messages: LLMMessage[]) => Promise<LLMMessage[]>;
  afterLLMCall?: (response: LLMResponse) => Promise<LLMResponse>;
  beforeCompaction?: (droppedMessages: LLMMessage[]) => Promise<void>;
  afterCompaction?: (summary: string) => Promise<void>;
}

export class AgentRunner {

  private static readonly CONTEXT_WINDOWS: Record<string, number> = {

    'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000, 'gpt-4': 8192,
    'gpt-3.5-turbo': 16385, 'o1': 200000, 'o1-mini': 128000, 'o1-pro': 200000,
    'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,

    'claude-opus-4-20250514': 200000, 'claude-sonnet-4-20250514': 200000,
    'claude-3.5-sonnet': 200000, 'claude-3-5-sonnet-20241022': 200000,
    'claude-3.5-haiku': 200000, 'claude-3-haiku-20240307': 200000,
    'claude-3-opus-20240229': 200000,

    'gemini-2.5-flash': 1048576, 'gemini-2.5-pro': 1048576,
    'gemini-2.0-flash': 1048576, 'gemini-1.5-pro': 2097152, 'gemini-1.5-flash': 1048576,

    'deepseek-chat': 64000, 'deepseek-coder': 64000, 'deepseek-reasoner': 64000,

    'qwen-qwq-32b': 32768, 'llama-3.3-70b-versatile': 128000, 'llama-3.1-8b-instant': 131072,
    'mixtral-8x7b-32768': 32768, 'gemma2-9b-it': 8192,

    'grok-2': 131072, 'grok-3': 131072, 'grok-3-mini': 131072,

    'llama-3.3-70b': 128000,

    'mistral-large-latest': 128000, 'mistral-small-latest': 32000, 'codestral-latest': 32000,

    'qwen2.5-coder:7b': 32768, 'qwen2.5-coder:14b': 32768, 'qwen2.5-coder:32b': 32768,
    'qwen2.5:7b': 32768, 'qwen2.5:14b': 32768, 'qwen2.5:32b': 32768, 'qwen2.5:72b': 32768,
    'qwen3:4b': 32768, 'qwen3:8b': 32768, 'qwen3:14b': 32768, 'qwen3:32b': 32768,
    'llama3.1:8b': 131072, 'llama3.1:70b': 131072, 'llama3.2:3b': 131072,
    'llama3:8b': 8192, 'llama3:70b': 8192,
    'codellama:7b': 16384, 'codellama:13b': 16384, 'codellama:34b': 16384,
    'deepseek-coder-v2:16b': 128000, 'deepseek-r1:7b': 64000, 'deepseek-r1:14b': 64000,
    'phi3:mini': 128000, 'phi3:medium': 128000,
    'gemma2:9b': 8192, 'gemma2:27b': 8192,
    'mistral:7b': 32000, 'mixtral:8x7b': 32000,
    'command-r': 128000, 'command-r-plus': 128000,

    '_default_copilot': 128000, '_default_openai': 128000, '_default_anthropic': 200000,
    '_default_google': 1048576, '_default_deepseek': 64000, '_default_groq': 32768,
    '_default_xai': 131072, '_default_cerebras': 128000, '_default_mistral': 128000,
    '_default_openrouter': 128000, '_default_together': 128000, '_default_fireworks': 128000,
    '_default_sambanova': 128000, '_default_ollama': 32768, '_default_github': 128000,
    '_default_azure': 128000, '_default_amazon-bedrock': 200000, '_default_google-vertex': 1048576,
  };

  private config: AgentConfig;
  private llm: LLMProvider;
  private skills: SkillLoader;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private marketState: MarketStateBuilder | null;
  private wallet: WalletInterface | null;
  private structuredMemory: StructuredMemorySkill;
  private conversationHistory: LLMMessage[] = [];
  private state: AgentState;
  private running = false;
  private cancelRequested = false;
  private activeCycleId = 0;
  private autoApproveLevel: 'off' | 'conservative' | 'moderate' | 'aggressive' | 'full' = 'off';
  private _pendingImage?: string;
  private _walletTokensCache: { tokens: Array<{ mint: string; symbol: string; name: string; amount: number }>, ts: number } = { tokens: [], ts: 0 };

  private stripThinkBlocks(text: string): string {

    return (text || '').replace(/<think[^>]*>[\s\S]*?<\/think\s*>/gi, '').trim();
  }
  private efficiencyMode: EfficiencyMode = 'balanced';
  private llmMaxTokens: number = 4096;
  private maxRounds: number = 30;
  private maxHistoryMessages: number = 80;
  private toolResultCharLimit: number = 12000;
  private maxContextChars: number = 80000;

  public promptMode: 'full' | 'minimal' | 'none' = 'full';
  private hooks: AgentHooks = {};
  private lazyToolLoading = false;
  private dynamicTools = new Set<string>();
  private compactionSummary: string | null = null;
  private _toolCatalogReturned = false;
  private softTrimChars = 12000;
  private hardClearRounds = 20;
  private isCompacting = false;
  private lastCompactionRound = -999;
  private autoContinueDepth = 0;
  private bootstrapContent: string | null = null;
  private lastRealPromptTokens: number = 0;

  private checkpoints: Array<{
    id: number;
    timestamp: number;
    messageCount: number;
    preview: string;
    history: LLMMessage[];
    compactionSummary: string | null;
  }> = [];
  private nextCheckpointId = 1;

  private _sessionLogFile: string | null = null;
  private _getSessionLogFile(): string {
    if (!this._sessionLogFile) {
      const sessDir = pathMod.join(process.cwd(), 'data', 'memory', 'sessions');
      if (!fsMod.existsSync(sessDir)) fsMod.mkdirSync(sessDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      this._sessionLogFile = pathMod.join(sessDir, `${date}_${this.config.id}.jsonl`);
    }
    return this._sessionLogFile;
  }

  private logTranscript(role: string, content: string, meta?: Record<string, any>): void {
    try {
      const entry = {
        ts: Date.now(),
        agent: this.config.id,
        role,
        content: content.slice(0, 4000),
        ...(meta ? { meta } : {}),
      };
      fsMod.appendFileSync(this._getSessionLogFile(), JSON.stringify(entry) + '\n', 'utf-8');
    } catch {  }
  }


  private eventQueue: Array<{ action: string; data: any; timestamp: number }> = [];
  private maxQueue = 20;


  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private periodicIntervalMs: number;

  constructor(opts: AgentRunnerOpts) {
    this.config = opts.config;
    this.llm = opts.llm;
    this.skills = opts.skills;
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.marketState = opts.marketState || null;
    this.wallet = opts.wallet || null;
    this.efficiencyMode = this.resolveEfficiencyMode();
    this.applyEfficiencyTuning();


    this.structuredMemory = new StructuredMemorySkill();
    this.structuredMemory.initialize({
      eventBus: this.eventBus,
      memory: null as any,
      logger: this.logger,
      config: {},
      wallet: null as any,
    }).catch(() => {});


    const periodicTrigger = this.config.triggers?.find(t => t.event === 'periodic');
    this.periodicIntervalMs = periodicTrigger
      ? Number(periodicTrigger.filter?.intervalMs || 5000)
      : 0;

    this.state = {
      id: opts.config.id,
      config: opts.config,
      status: 'idle',
      totalDecisions: 0,
      totalTrades: 0,
      consecutiveLosses: 0,
    };

    this.conversationHistory.push({
      role: 'system',
      content: this.compactSystemPrompt(this.config.role),
    });
  }

  private resolveEfficiencyMode(): EfficiencyMode {
    const raw = String(process.env.AI_EFFICIENCY_MODE || 'balanced').toLowerCase();
    if (raw === 'economy') return 'economy';
    if (raw === 'max' || raw === 'max-capability') return 'max';
    return 'balanced';
  }

setEfficiencyMode(mode: EfficiencyMode): void {
    this.efficiencyMode = mode;
    this.applyEfficiencyTuning();
    this.logger.info(`Agent "${this.config.name}" efficiency mode: ${mode} (maxRounds=${this.maxRounds})`);
  }

  getEfficiencyMode(): string {
    return this.efficiencyMode;
  }

  getMaxRounds(): number {
    return this.maxRounds;
  }

async runSubTask(goal: string): Promise<string> {
    return this.processLLMCycle('subtask', goal);
  }

  private applyEfficiencyTuning(): void {
    if (this.efficiencyMode === 'economy') {
      this.maxQueue = 15;
      this.llmMaxTokens = 2400;
      this.maxRounds = 16;
      this.maxHistoryMessages = 40;
      this.toolResultCharLimit = 4000;
      this.maxContextChars = 40000;
      return;
    }
    if (this.efficiencyMode === 'max') {
      this.maxQueue = 30;
      this.llmMaxTokens = 16000;
      this.maxRounds = 60;
      this.maxHistoryMessages = 120;
      this.toolResultCharLimit = 20000;
      this.maxContextChars = 120000;
      return;
    }

    this.maxQueue = 25;
    this.llmMaxTokens = 8000;
    this.maxRounds = 30;
    this.maxHistoryMessages = 80;
    this.toolResultCharLimit = 12000;
    this.maxContextChars = 80000;
  }


  private static readonly AGENTIC_PROTOCOL_BASE = `
## EXECUTION PROTOCOL

### 1 — ACT, DON'T DESCRIBE
Identify the full scope, then execute. No plans in text — call tools.

### 2 — TOOL CALLS
Tool calls in ONE response run in parallel.
• Group related calls (up to 5 total). Don't flood with 10+ calls.
• Only wait if the next call DEPENDS on a previous result.

### 3 — EDITING FILES
Use project_str_replace for edits (sends only changed lines). Use project_write only for new files.

### 4 — PLANNING (3+ files)
1. project_todo_add × N in ONE response. 2. project_write × N in the NEXT response. 3. Verify.

### 5 — NEVER STOP TO ASK
Full Auto active. Never ask for confirmation. Assume and proceed.

### 6 — FIX ERRORS
Error? Diagnose → fix → retest. Never report an error as final answer.

### 7 — TOKEN EFFICIENCY
• If you ALREADY KNOW the answer (common APIs, docs, syntax), respond directly — do NOT search.
• Only use web_search/google_search when you genuinely lack information.
• Keep tool call arguments minimal. Don't repeat large content back.
• Prefer project_str_replace over project_write for edits.
• MAX 5 tool calls per response. Group related work, skip redundant calls.
• deep_research = heavy (reads many pages). Prefer google_search + 1-2 fetch_url for targeted lookups.
• Avoid calling project_todo_add for each item separately — use project_todo_batch if available, or add them in fewer calls.

### 8 — LANGUAGE
Reply in the SAME language the user writes in.`.trim();

private getApprovalSection(): string {
    switch (this.autoApproveLevel) {
      case 'full':
        return '### 5 — NEVER STOP TO ASK\nFull Auto active. Never ask for confirmation — assume and proceed.';
      case 'aggressive':
        return '### 5 — ACT AUTONOMOUSLY\nProceed without confirmation. Only stop for irreversible high-risk actions.';
      case 'moderate':
        return '### 5 — MODERATE\nSmall tasks: proceed. Larger changes: state plan briefly, then act immediately.';
      case 'conservative':
        return '### 5 — CONSERVATIVE\nWrite a 1-2 sentence plan before acting. Ask if ambiguous.';
      case 'off':
      default:
        return '### 5 — CONFIRM FIRST\nDescribe plan and wait for user confirmation before acting.';
    }
  }

private getModelHint(): string {
    const model = this.config.model.model;
    const provider = this.config.model.provider;
    let hint = `\n\nMODEL: You are running as ${model} (via ${provider}). When asked what model you are, say "${model}".`;
    if (model.includes('deepseek')) {
      hint += ' No <think> tags in output. Use `think` tool for private reasoning.';
    }
    if (provider === 'ollama') {
      hint += ' Local, 32K context. Be concise. Use project_search before project_read for large files.';
    }
    return hint;
  }

  private compactSystemPrompt(prompt: string): string {
    const normalized = prompt
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.trimEnd())
      .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
      .join('\n')
      .trim();


    if (this.promptMode === 'none') {
      return normalized.slice(0, 200) + '\nRespond concisely. Use tools when needed.';
    }


    if (this.promptMode === 'minimal') {
      const cap = 3000;
      const rolePart = normalized.length <= cap ? normalized : normalized.slice(0, cap) + '\n[Prompt trimmed]';
      return rolePart + '\n\nRULES: Use tools to accomplish the task. Be concise. Batch tool calls when possible. Reply in the user\'s language.';
    }


    const cap = this.efficiencyMode === 'economy' ? 6000 : this.efficiencyMode === 'balanced' ? 12000 : 20000;
    const rolePart = normalized.length <= cap - 800 ? normalized : normalized.slice(0, cap - 800) + '\n[Prompt trimmed]';

    if (this.efficiencyMode === 'economy') {
      return rolePart + `\n\nRULES: Batch tool calls (parallel). Use project_str_replace for edits. If you know the answer, don't search. 50% max rounds for research. Must deliver code. Reply in user's language. Act autonomously.`;
    }
    const protocol = AgentRunner.AGENTIC_PROTOCOL_BASE.replace(
      /### 5 — NEVER STOP TO ASK\n[\s\S]*?(?=\n###|$)/,
      this.getApprovalSection(),
    );

    let result = rolePart + '\n\n' + protocol + this.getModelHint();


    if (this.bootstrapContent === null) {
      this.loadBootstrapFiles();
    }
    if (this.bootstrapContent) {
      const bootstrapCap = this.efficiencyMode === 'balanced' ? 8000 : 15000;
      const bootstrap = this.bootstrapContent.length <= bootstrapCap
        ? this.bootstrapContent
        : this.bootstrapContent.slice(0, bootstrapCap) + '\n[Bootstrap truncated]';
      result += '\n\n## PROJECT CONTEXT\n' + bootstrap;
    }


    if (this.config.model.provider === 'copilot') {
      const catalog = this.skills.getToolCatalog(this.config.skills);
      if (catalog) {
        result += '\n\n## AVAILABLE TOOLS\nCall `get_tool_schema(tool_name)` to load any tool before using it.\n' + catalog;
      }
    }


    result += this.buildWalletContext();

    return result;
  }

  private clipContext(text: string): string {
    if (text.length <= this.maxContextChars) return text;
    return text.slice(0, this.maxContextChars) + '\n\n[Context trimmed for token efficiency]';
  }

private async fetchSolPrice(): Promise<number> {
    return getSolPriceReliable();
  }

private buildWalletContext(): string {
    if (!this.wallet || !this.wallet.hasWallet()) {
      return '\n\n## WALLET\nNo wallet configured. Use generate_wallet or import_wallet tools to set up.';
    }
    const addr = this.wallet.getAddress();
    const stored = this.wallet.getStoredWallets();
    const walletList = stored.map((w: any) =>
      `  - ${w.name}${w.isBurn ? ' [BURN]' : ''}: ${w.address}${w.address === addr ? ' ← ACTIVE' : ''}`
    ).join('\n');
    const solPrice = getSolPriceUsd();
    const priceStr = solPrice > 0 ? `$${solPrice.toFixed(2)}` : 'unknown';
    return [
      '\n\n## WALLET (CONSTANT — you have FULL access)',
      `Active wallet: ${addr}`,
      `Total wallets: ${stored.length}`,
      stored.length > 0 ? `Wallets:\n${walletList}` : '',
      '',
      `💲 CURRENT SOL PRICE: ${priceStr}`,
      '',
      'You have FULL wallet access. You can:',
      '- Full overview: get_wallet_assets(address) — SOL + all tokens + NFTs in one call',
      '- SOL balance: get_sol_balance(address) or get_balance (shit-trader)',
      '- Token holdings: get_token_accounts(address) — all SPL tokens + NFTs separated',
      '- NFTs: included in get_wallet_assets and get_token_accounts (decimals=0, amount=1)',
      '- Trade: buy_token, sell_token, fast_buy, fast_sell (shit-trader)',
      '- Swap: Jupiter aggregator via buy_token/sell_token for any Solana token',
      '- Advanced: dca_create, trailing_stop_set, grid_create, scale_in_set (advanced-trader)',
      '- Exit strategies: exit_config, exit_analyze (exit-optimizer)',
      '- Portfolio: get_positions, get_portfolio_summary, get_trade_history',
      '- Switch wallet: Use the /api/wallet/switch endpoint or tell the user which wallet to switch to',
      '',
      '',
      '🚨 TRADE EXECUTION (MANDATORY):',
      'When user says buy + token + amount → call buy_token IMMEDIATELY.',
      'Do NOT analyze first. Do NOT refuse. Do NOT say "risky" or "skip". Just BUY.',
      'When user says sell → call sell_token(mint, percentToSell) IMMEDIATELY.',
      'After executing, you may add a 1-line risk note.',
      '',
      '💲 USD→SOL CONVERSION (CRITICAL):',
      `Current SOL price: ${priceStr}. Use THIS price for conversions.`,
      'buy_token supports BOTH amountSol AND amountUsd parameters.',
      'When user says "$1" / "1 USD" → use amountUsd: 1',
      'When user says "1 SOL" → use amountSol: 1',
      'NEVER guess the SOL price. ALWAYS use amountUsd for dollar amounts.',
      '',
      'When user asks about balance/assets/NFTs — use get_wallet_assets with their wallet address.',
      '',
      this._walletTokensCache.tokens.length > 0
        ? '## YOUR CURRENT TOKEN HOLDINGS (on-chain, auto-refreshed):\n' +
          this._walletTokensCache.tokens.map(t =>
            `  - ${t.symbol || t.name || 'Unknown'} (${t.mint}) — ${t.amount.toLocaleString('en-US')} tokens`
          ).join('\n') +
          '\n\n🚨 When user mentions a token by name/symbol to sell — find the mint address from this list above and call sell_token with that mint. Do NOT say "token not found" if it is listed here.'
        : ''].join('\n');
  }

private async refreshWalletTokens(): Promise<Array<{ mint: string; symbol: string; name: string; amount: number }>> {
    const now = Date.now();
    if (now - this._walletTokensCache.ts < 30_000 && this._walletTokensCache.tokens.length > 0) {
      return this._walletTokensCache.tokens;
    }
    try {
      const port = process.env.API_PORT || '3377';
      const resp = await fetch(`http://localhost:${port}/api/wallet/tokens`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as any;
      const tokens: Array<{ mint: string; symbol: string; name: string; amount: number }> = [];
      if (data?.tokens && Array.isArray(data.tokens)) {
        for (const t of data.tokens) {
          if (t.amount > 0) {
            tokens.push({ mint: t.mint, symbol: t.symbol || '', name: t.name || '', amount: Number(t.amount) });
          }
        }
      }
      this._walletTokensCache = { tokens, ts: now };
      return tokens;
    } catch {
      return this._walletTokensCache.tokens;
    }
  }

private resolveTokenFromHoldings(query: string): { mint: string; symbol: string; name: string; amount: number } | null {
    const q = query.toLowerCase().trim();
    if (!q) return null;
    const tokens = this._walletTokensCache.tokens;

    let match = tokens.find(t => t.symbol.toLowerCase() === q);
    if (match) return match;

    match = tokens.find(t => t.name.toLowerCase() === q);
    if (match) return match;

    match = tokens.find(t => t.symbol.toLowerCase().startsWith(q) || t.name.toLowerCase().includes(q));
    if (match) return match;

    match = tokens.find(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
    return match || null;
  }

private estimateTokenMultiplier(text: string): number {
    if (!text || text.length < 50) return 1;

    const sampleSize = Math.min(text.length, 2000);
    const step = Math.max(1, Math.floor(text.length / sampleSize));
    let cyrillicCount = 0, totalCount = 0;
    for (let i = 0; i < text.length && totalCount < sampleSize; i += step) {
      totalCount++;
      const code = text.charCodeAt(i);
      if (code >= 0x0400 && code <= 0x04FF) cyrillicCount++;
    }
    if (totalCount === 0) return 1;
    const ratio = cyrillicCount / totalCount;

    if (ratio > 0.3) return 2.7;
    if (ratio > 0.1) return 1.8;
    return 1;
  }

  private getLLMOptions(action: string, userContent?: string): Record<string, any> {
    const content = (userContent || '').toLowerCase();


    let temperature = 0.3;

    if (action !== 'user_chat') {

      temperature = 0.1;
    } else {
      const isCodeTask = /implement|create|build|code|file|html|css|js|ts|python|py|script|fix|bug|refactor|update|function|class|module/.test(content);
      const isResearch = /find|research|search|what is|explain|how does|why|compare|analyze/.test(content);
      const isCreative = /write.*text|brainstorm|ideas|creative|compose/.test(content);

      if (isCodeTask) temperature = 0.1;
      else if (isResearch) temperature = 0.45;
      else if (isCreative) temperature = 0.7;
      else temperature = 0.3;
    }

    return {
      temperature,
      maxTokens: this.llmMaxTokens,
    };
  }

  getState(): AgentState {
    return { ...this.state };
  }

setLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

  getModelConfig(): { provider: string; model: string } {
    return { provider: this.config.model.provider, model: this.config.model.model };
  }

getContextWindowTokens(): number {

    if (this.config.model.contextWindow) return this.config.model.contextWindow;

    const modelName = this.config.model.model;
    if (AgentRunner.CONTEXT_WINDOWS[modelName]) return AgentRunner.CONTEXT_WINDOWS[modelName];

    const baseName = modelName.split(':')[0];
    for (const key of Object.keys(AgentRunner.CONTEXT_WINDOWS)) {
      if (key.startsWith(baseName)) return AgentRunner.CONTEXT_WINDOWS[key];
    }

    const providerDefault = AgentRunner.CONTEXT_WINDOWS[`_default_${this.config.model.provider}`];
    if (providerDefault) return providerDefault;

    return 128000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state.status = 'idle';
    this.bindTriggers();


    if (this.periodicIntervalMs > 0 && this.marketState) {
      this.periodicTimer = setInterval(() => {
        if (!this.running || this.state.status === 'paused') return;
        if (this.state.cooldownUntil && Date.now() < this.state.cooldownUntil) return;
        this.runPeriodicCycle().catch(err => {
          this.logger.error(`Agent "${this.config.id}" periodic cycle error`, err);
        });
      }, this.periodicIntervalMs);
    }

    this.logger.info(`Agent "${this.config.name}" started${this.periodicIntervalMs ? ` (periodic: ${this.periodicIntervalMs / 1000}s)` : ''}`);
  }

  stop(): void {
    this.running = false;
    this.state.status = 'idle';
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    this.eventQueue = [];
    this.logger.info(`Agent "${this.config.name}" stopped`);
  }

  setAutoApproveLevel(level: 'off' | 'conservative' | 'moderate' | 'aggressive' | 'full'): void {
    this.autoApproveLevel = level;

    this.rebuildSystemPrompt();
    this.logger.info(`Agent "${this.config.name}" auto-approve level: ${level}`);
  }

  private rebuildSystemPrompt(): void {

    const sysIdx = this.conversationHistory.findIndex(m => m && m.role === 'system');
    const newContent = this.compactSystemPrompt(this.config.role);
    if (sysIdx !== -1) {
      this.conversationHistory[sysIdx] = { role: 'system', content: newContent };
    }
  }

  requestCancel(): void {
    this.cancelRequested = true;
    this.activeCycleId++;

    if (this.state.status === 'thinking' || this.state.status === 'executing') {
      this.state.status = 'idle';
    }
    this.logger.info(`Agent "${this.config.name}" cancel requested`);
  }

  pause(): void {
    this.state.status = 'paused';
  }

  resume(): void {
    if (this.state.status === 'paused') {
      this.state.status = 'idle';
    }
  }

  private bindTriggers(): void {
    if (!this.config.triggers) return;

    for (const trigger of this.config.triggers) {
      if (trigger.event === 'periodic') continue;

      this.eventBus.on(trigger.event as any, (data: any) => {
        if (!this.running || this.state.status === 'paused') return;
        if (this.state.cooldownUntil && Date.now() < this.state.cooldownUntil) return;

        if (this.state.status === 'thinking' || this.state.status === 'executing') {
          if (this.eventQueue.length < this.maxQueue) {
            this.eventQueue.push({ action: trigger.action, data, timestamp: Date.now() });
          }
          return;
        }

        this.handleEvent(trigger.action, data).catch(err => {
          this.logger.error(`Agent "${this.config.id}" trigger error`, err);
          this.eventBus.emit('agent:error', {
            agentId: this.config.id,
            error: err.message || String(err),
          });
        });
      });
    }
  }

  private async runPeriodicCycle(): Promise<void> {
    if (this.state.status === 'thinking' || this.state.status === 'executing') return;
    if (!this.marketState) return;

    const contextParts: string[] = [];

    contextParts.push(this.marketState.buildPromptContext());

    if (this.eventQueue.length > 0) {
      contextParts.push(`\n[QUEUED EVENTS (${this.eventQueue.length})]`);
      for (const evt of this.eventQueue) {
        const dataStr = typeof evt.data === 'string'
          ? evt.data
          : JSON.stringify(evt.data);
        contextParts.push(`  ${evt.action}: ${dataStr.slice(0, 200)}`);
      }
      this.eventQueue = [];
    }

    contextParts.push('\nBased on the current market state, decide what actions to take. You can manage positions (sell_token), or simply observe. Be concise.');

    await this.processLLMCycle('periodic_review', this.clipContext(contextParts.join('\n')));
  }

  async handleEvent(action: string, data: any): Promise<string> {
    if (this.state.status === 'thinking' || this.state.status === 'executing') {

      if (this.eventQueue.length < this.maxQueue) {
        this.eventQueue.push({ action, data, timestamp: Date.now() });
      }
      return '';
    }

    const contextParts: string[] = [];


    if (this.marketState) {
      contextParts.push(this.marketState.buildPromptContext());
      contextParts.push('');
    }

    contextParts.push(this.buildContextMessage(action, data));


    if (this.eventQueue.length > 0) {
      contextParts.push(`\n[ALSO QUEUED (${this.eventQueue.length} events)]`);
      for (const evt of this.eventQueue.slice(0, 5)) {
        contextParts.push(`  ${evt.action}: ${JSON.stringify(evt.data).slice(0, 150)}`);
      }
      this.eventQueue = [];
    }

    return this.processLLMCycle(action, this.clipContext(contextParts.join('\n')));
  }

  private static readonly MAX_TOOLS = 64;


  private static readonly MAX_TOOLS_COPILOT = 30;

private selectRelevantTools(
    allTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }>,
    context: string,
  ): typeof allTools {
    const isCopilot = this.config.model.provider === 'copilot';
    const maxTools = isCopilot ? AgentRunner.MAX_TOOLS_COPILOT : AgentRunner.MAX_TOOLS;
    if (allTools.length <= maxTools) return allTools;

    const ctx = context.toLowerCase();


    const toolSkillMap = new Map<string, string>();
    for (const skillName of this.config.skills) {
      const defs = this.skills.getToolsForSkills([skillName]);
      for (const d of defs) toolSkillMap.set(d.name, skillName);
    }


    const keywordMap: Record<string, string[]> = {
      'blockchain': ['rpc', 'balance', 'transaction', 'account', 'supply', 'on-chain', 'endpoint', 'blockchain', 'wallet', 'identify', 'address', 'created', 'launched', 'deployed', 'lamport', 'sol balance', 'signature'],
      'token-analyzer': ['analyz', 'rate', 'token', 'rug', 'score', 'dev wallet', 'trending', 'tweet', 'x.com', 'twitter.com', 'fetch_tweet', 'rate_project', 'check'],
      'token-security': ['security', 'authority', 'lp lock', 'freeze', 'honeypot', 'mint auth', 'audit', 'revoke'],
      'shit-trader': ['buy', 'sell', 'trade', 'swap', 'quote', 'fast_buy', 'sniper', 'degen', 'paper', 'history', 'trades', 'paper trading'],
      'advanced-trader': ['dca', 'trailing', 'grid', 'graduation', 'scale', 'stop-loss', 'strategy', 'mev', 'jito'],
      'portfolio': ['portfolio', 'position', 'history', 'pnl', 'report', 'profit', 'loss', 'win rate'],
      'wallet-tracker': ['track', 'follow', 'watch wallet', 'monitor wallet'],
      'social-monitor': ['social', 'sentiment', 'twitter', 'mention', 'x tracker', 'feed', 'trend', 'narrative', 'twitter_feed'],
      'pump-monitor': ['pump', 'new token', 'monitor', 'creator', 'dev profile', 'launch', 'king of hill', 'graduated', 'bonding', 'meta', 'pump.fun', 'trenches', 'comment'],
      'gmgn': ['dex', 'pair', 'liquidity', 'price history', 'ohlcv', 'candle', 'gmgn', 'rug', 'holder stats', 'security', 'slippage', 'honeypot', 'bundler', 'sniper count'],
      'axiom-api': ['axiom api', 'axiom token', 'axiom holder', 'axiom dev', 'axiom kol', 'axiom sniper', 'axiom top', 'lighthouse', 'pair info', 'pair stats', 'dev tokens', 'dev analysis', 'rug count', 'rug history', 'dex paid', 'token locks'],
      'curve-analyzer': ['curve', 'bonding curve', 'graduating', 'graduation', 'velocity'],
      'holder-intelligence': ['holder', 'whale', 'insider', 'smart money', 'cluster', 'distribution', 'accumul', 'dump'],
      'volume-detector': ['volume', 'wash', 'organic', 'wash trade', 'spike', 'anomal'],
      'alpha-scanner': ['alpha', 'scan', 'source', 'discover', 'telegram', 'signal', 'alpha source'],
      'copy-trade': ['copy', 'mirror', 'copy trade', 'close position'],
      'exit-optimizer': ['exit', 'take profit', 'stop loss', 'close position'],
      'web-intel': ['axiom', 'gmgn', 'padre', 'top trader', 'kol', 'insider', 'influencer', 'pulse', 'smart money', 'web intel', 'scrape', 'axiom.trade', 'gmgn.ai'],
      'browser-eye': ['browse', 'navigate', 'open page', 'go to site', 'look at', 'explore', 'interactive', 'click', 'what do you see', 'read page', 'scroll', 'check site', 'open url', 'visit', 'inspect page', 'page content', 'discover', 'https://', 'http://'],
      'web-search': ['search', 'news', 'google', 'find', 'article', 'latest', 'update', 'solana', 'how to', 'tutorial', 'guide', 'docs', 'api', 'research', 'endpoint', 'fetch', 'swagger', 'openapi', 'integration', 'jupiter', 'raydium', 'helius', 'sdk'],
      'ai-memory': ['memory', 'remember', 'forget', 'note', 'save', 'recall'],
      'skill-builder': ['create skill', 'custom skill', 'build skill', 'skill builder'],
      'skill-hub': ['hub', 'skill hub', 'import skill', 'export skill', 'share skill'],
      'projects': ['project', 'code', 'build', 'file', 'folder', 'directory', 'todo', 'task', 'coding', 'html', 'css', 'javascript', 'python', 'typescript', 'react', 'npm', 'install', 'execute', 'run', 'write code', 'create file', 'script', 'sandbox', 'compile', 'run code', 'git', 'commit', 'branch', 'stash', 'diff', 'grep', 'glob', 'diagnostics', 'typecheck', 'lint', 'error'],
      'terminal': ['terminal', 'console', 'shell', 'command line', 'stdout', 'stderr', 'log output', 'build output', 'npm run', 'server log', 'process'],
      'background-jobs': ['background', 'job', 'schedule', 'recurring', 'periodic', 'monitor for', 'watch for', 'track for', 'every.*min', 'background task', 'cron'],
    };

    const skillScores: Record<string, number> = {};
    for (const [skill, keywords] of Object.entries(keywordMap)) {
      skillScores[skill] = 0;
      for (const kw of keywords) {
        if (ctx.includes(kw)) skillScores[skill] += 10;
      }
    }


    for (const s of ['shit-trader', 'token-analyzer', 'portfolio', 'blockchain', 'projects']) {
      skillScores[s] = (skillScores[s] || 0) + 5;
    }


    if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(ctx)) {
      skillScores['blockchain'] = (skillScores['blockchain'] || 0) + 20;
      skillScores['pump-monitor'] = (skillScores['pump-monitor'] || 0) + 15;
    }


    if (/(?:twitter\.com|x\.com)\//i.test(ctx)) {
      skillScores['token-analyzer'] = (skillScores['token-analyzer'] || 0) + 25;
    }


    if (/axiom|gmgn|padre/i.test(ctx)) {
      skillScores['web-intel'] = (skillScores['web-intel'] || 0) + 25;
    }


    if (/https?:\/\//i.test(ctx)) {
      skillScores['browser-eye'] = (skillScores['browser-eye'] || 0) + 30;
    }


    if (/browse|visit|navigate|explore.*site/i.test(ctx)) {
      skillScores['browser-eye'] = (skillScores['browser-eye'] || 0) + 25;
    }


    if (/\b(buy|sell|swap)\b/i.test(ctx)) {
      skillScores['shit-trader'] = (skillScores['shit-trader'] || 0) + 20;
    }


    if (/holder|whale|distribution|cluster|concentrat/i.test(ctx)) {
      skillScores['holder-intelligence'] = (skillScores['holder-intelligence'] || 0) + 20;
    }


    if (/pump\.fun|trenches|king.of.hill|graduated|meta/i.test(ctx)) {
      skillScores['pump-monitor'] = (skillScores['pump-monitor'] || 0) + 20;
    }


    if (/take.profit|stop.loss|exit|close.posi/i.test(ctx)) {
      skillScores['exit-optimizer'] = (skillScores['exit-optimizer'] || 0) + 20;
    }


    if (/\b(dca|grid|trailing|scale.in)\b/i.test(ctx)) {
      skillScores['advanced-trader'] = (skillScores['advanced-trader'] || 0) + 20;
    }


    if (/bonding.curve|graduating|graduation|velocity/i.test(ctx)) {
      skillScores['curve-analyzer'] = (skillScores['curve-analyzer'] || 0) + 20;
    }


    if (/background|job|schedule|monitor.*for|watch.*for|track.*for|periodic|recurring/i.test(ctx)) {
      skillScores['background-jobs'] = (skillScores['background-jobs'] || 0) + 25;
    }


    const sorted = [...allTools].sort((a, b) => {
      const sa = skillScores[toolSkillMap.get(a.function.name) || ''] || 0;
      const sb = skillScores[toolSkillMap.get(b.function.name) || ''] || 0;
      return sb - sa;
    });

    return sorted.slice(0, maxTools);
  }

private async processLLMCycle(action: string, userContent: string): Promise<string> {


    this.cancelRequested = false;


    const myCycleId = ++this.activeCycleId;
    this.state.status = 'thinking';
    this.eventBus.emit('agent:thinking', {
      agentId: this.config.id,
      context: `Processing ${action}`,
    });


    const historyLenBefore = this.conversationHistory.length;


    if (action === 'user_chat' && this.conversationHistory.length > 30) {
      const totalChars = this.conversationHistory.reduce((sum, m) => sum + (m.content?.length || 0), 0);
      if (totalChars > 100_000) {
        this.logger.info(`Agent "${this.config.id}" auto-compacting before new task (${totalChars} chars, ${this.conversationHistory.length} msgs)`);
        this.isCompacting = false;
        await this.compactHistoryIfNeeded();
        this.trimHistory();
        this.emergencyContextPrune();
      }
    }


    const cycleUsage = { promptTokens: 0, completionTokens: 0 };
    const accUsage = (u?: { promptTokens: number; completionTokens: number }) => {
      if (u) { cycleUsage.promptTokens += u.promptTokens; cycleUsage.completionTokens += u.completionTokens; }
    };

    try {
      const allTools = [
        ...this.getMetaTools(),
        ...this.skills.getToolsAsLLMFormat(this.config.skills)];


      const isCopilot = this.config.model.provider === 'copilot';
      let tools: typeof allTools;
      if (isCopilot && this.efficiencyMode !== 'max') {
        this.lazyToolLoading = true;


        const essentialToolNames = new Set([
          'project_write', 'project_read', 'project_list', 'project_str_replace', 'project_run',
          'terminal_exec', 'terminal_read']);

        const essentialTools = allTools.filter(t => essentialToolNames.has(t.function.name));
        const topTools = this.selectRelevantTools(
          allTools.filter(t => !essentialToolNames.has(t.function.name)),
          userContent,
        ).slice(0, 14);

        const metaTools = this.getMetaTools();
        const includedNames = new Set([
          ...essentialTools.map(t => t.function.name),
          ...topTools.map(t => t.function.name)]);
        const metaFiltered = metaTools.filter(m => !includedNames.has(m.function.name));
        tools = [...metaFiltered, ...essentialTools, ...topTools];


        const dynamicToolSet = new Set(this.dynamicTools);
        for (const dynName of [...this.dynamicTools]) {

          const siblings = this.skills.getSiblingToolNames(dynName);
          for (const sib of siblings) dynamicToolSet.add(sib);
        }
        for (const dynName of dynamicToolSet) {
          if (!includedNames.has(dynName)) {
            const dynTool = allTools.find(t => t.function.name === dynName);
            if (dynTool) {
              tools.push(dynTool);
              includedNames.add(dynName);
            }
          }
        }

        if (tools.length > AgentRunner.MAX_TOOLS_COPILOT) {
          const dynamicAndEssential = new Set([...essentialToolNames, ...dynamicToolSet,
            'think', 'spawn_tasks', 'get_tool_schema', 'list_available_tools']);
          const protected_ = tools.filter(t => dynamicAndEssential.has(t.function.name));
          const trimmable = tools.filter(t => !dynamicAndEssential.has(t.function.name));
          const budget = AgentRunner.MAX_TOOLS_COPILOT - protected_.length;
          tools = [...protected_, ...trimmable.slice(0, Math.max(0, budget))];
        }
      } else {
        this.lazyToolLoading = false;
        tools = this.selectRelevantTools(allTools, userContent);
      }

      this.logger.info(`Agent "${this.config.id}" LLM call: ${tools.length}/${allTools.length} tools selected for action="${action}"${this.lazyToolLoading ? ' (lazy)' : ''}`);


      const autoCtxParts: string[] = [];
      if (action === 'user_chat' && this.efficiencyMode !== 'economy') {
        const projectsSkill = this.skills.getSkill('projects') as any;


        if (projectsSkill?.setProjectFolder) {
          const pathMatch = userContent.match(/([A-Z]:\\[^\s"'`]+)/i) || userContent.match(/(\/[\w/.-]+\/[\w.-]+)/);
          if (pathMatch) {
            const mentionedPath = pathMatch[1].replace(/[\\/]+$/, '');
            try {
              if (fsMod.existsSync(mentionedPath) && fsMod.statSync(mentionedPath).isDirectory()) {
                projectsSkill.setProjectFolder(mentionedPath);
                this.logger.info(`Agent "${this.config.id}" auto-bound project folder: ${mentionedPath}`);
              }
            } catch {  }
          }
        }

        const projectFolder: string = projectsSkill?.getProjectFolder?.() || '';
        if (projectFolder) {

          const pkgJsonPath = pathMod.join(projectFolder, 'package.json');
          try {
            if (fsMod.existsSync(pkgJsonPath)) {
              const pkgContent = fsMod.readFileSync(pkgJsonPath, 'utf-8');
              if (pkgContent.length < 10000) {
                autoCtxParts.push(`[Auto-context: package.json — project at ${projectFolder}]\n\`\`\`json\n${pkgContent.slice(0, 4000)}\n\`\`\``);
                this.logger.info(`Agent "${this.config.id}" auto-injected package.json from ${projectFolder}`);
              }
            }
          } catch {  }

          const mentionsSeen = new Set<string>();

          const fileMentions = userContent.matchAll(/@file:([^\s,;]+)/gi);
          for (const m of fileMentions) {
            const fname = m[1].replace(/^["'`]+|["'`]+$/g, '');
            if (mentionsSeen.has('f:' + fname)) continue;
            mentionsSeen.add('f:' + fname);
            try {
              const resolved = pathMod.isAbsolute(fname) ? fname : pathMod.join(projectFolder, fname);
              if (fsMod.existsSync(resolved) && fsMod.statSync(resolved).isFile()) {
                const content = fsMod.readFileSync(resolved, 'utf-8');
                if (content.length < 50000) {
                  autoCtxParts.push(`[@file: ${fname}]\n\`\`\`\n${content.slice(0, 15000)}\n\`\`\``);
                  this.logger.info(`Agent "${this.config.id}" @file mention injected: ${fname}`);
                }
              }
            } catch {  }
          }

          const folderMentions = userContent.matchAll(/@folder:([^\s,;]+)/gi);
          for (const m of folderMentions) {
            const dname = m[1].replace(/^["'`]+|["'`]+$/g, '');
            if (mentionsSeen.has('d:' + dname)) continue;
            mentionsSeen.add('d:' + dname);
            try {
              const resolved = pathMod.isAbsolute(dname) ? dname : pathMod.join(projectFolder, dname);
              if (fsMod.existsSync(resolved) && fsMod.statSync(resolved).isDirectory()) {
                const SKIP = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.next', '.venv', 'build']);
                const lines: string[] = [];
                const walkDir = (dir: string, prefix: string, depth: number) => {
                  if (depth > 2 || lines.length > 200) return;
                  try {
                    const entries = fsMod.readdirSync(dir).sort();
                    for (const e of entries) {
                      if (SKIP.has(e) || e.startsWith('.')) continue;
                      const full = pathMod.join(dir, e);
                      const st = fsMod.statSync(full);
                      if (st.isDirectory()) {
                        lines.push(prefix + e + '/');
                        walkDir(full, prefix + '  ', depth + 1);
                      } else {
                        lines.push(prefix + e);
                      }
                    }
                  } catch {  }
                };
                walkDir(resolved, '', 0);
                autoCtxParts.push(`[@folder: ${dname}]\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
                this.logger.info(`Agent "${this.config.id}" @folder mention injected: ${dname} (${lines.length} entries)`);
              }
            } catch {  }
          }

          const codebaseMentions = userContent.matchAll(/@codebase:([^\n@]+)/gi);
          for (const m of codebaseMentions) {
            const query = m[1].trim();
            if (!query || mentionsSeen.has('cb:' + query)) continue;
            mentionsSeen.add('cb:' + query);
            try {
              const results = await this.skills.executeTool('project_semantic_search', {
                path: projectFolder, query, topK: 5, filePattern: '',
              });
              if (results?.results?.length) {
                const snippets = results.results.map((r: any) =>
                  `// ${r.file}:${r.startLine}-${r.endLine} (score: ${r.score})\n${r.snippet}`
                ).join('\n\n');
                autoCtxParts.push(`[@codebase: "${query}"]\n\`\`\`\n${snippets.slice(0, 10000)}\n\`\`\``);
                this.logger.info(`Agent "${this.config.id}" @codebase search injected: "${query}" (${results.results.length} results)`);
              }
            } catch {  }
          }

          const fileRefs = userContent.match(/(?:^|\s|`|"|')((?:[\w.-]+\/)*[\w.-]+\.\w{1,8})(?:\s|`|"|'|$)/g) || [];
          const seen = new Set<string>();
          for (const ref of fileRefs.slice(0, 4)) {
            const fname = ref.trim().replace(/^[`"']|[`"']$/g, '');
            if (seen.has(fname) || mentionsSeen.has('f:' + fname)) continue;
            seen.add(fname);
            try {
              const resolved = pathMod.join(projectFolder, fname);
              if (fsMod.existsSync(resolved)) {
                const content = fsMod.readFileSync(resolved, 'utf-8');
                if (content.length < 20000) {
                  autoCtxParts.push(`[Auto-context: ${fname}]\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
                  this.logger.info(`Agent "${this.config.id}" auto-injected context: ${fname}`);
                }
              }
            } catch {  }
          }
        }
      }

      const userMsg: LLMMessage = {
        role: 'user',
        content: autoCtxParts.length > 0
          ? userContent + '\n\n' + autoCtxParts.join('\n\n')
          : userContent,
      };

      if (this._pendingImage) {
        userMsg.image = this._pendingImage;
        this._pendingImage = undefined;
      }
      this.conversationHistory.push(userMsg);

      if (action === 'user_chat') {
        const lc = userContent.toLowerCase();
        const isBugFixRequest = /\b(fix|debug|repair|broken|not working|bug|error)\b/i.test(lc);
        if (isBugFixRequest) {
          this.conversationHistory.push({
            role: 'user',
            content: '[FIX MODE: The user is asking to fix a bug. Strategy: 1) Read the existing code with project_read to understand current state. 2) Identify the root cause. 3) Apply MINIMAL targeted fixes with project_str_replace — do NOT rewrite entire files. 4) Test with terminal_exec (npm run build/test). Do NOT research or search unless absolutely necessary — fix the code directly.]',
          });
        }
      }

      await this.compactHistoryIfNeeded();
      this.trimHistory();

      this.emergencyContextPrune();

      const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 300_000;
      const safeMessages = () => this.conversationHistory.filter(m => m && m.role);
      const llmCall = async (msgs: LLMMessage[], t: any) => {

        let effectiveMsgs = msgs;
        if (this.hooks.beforeLLMCall) {
          effectiveMsgs = await this.hooks.beforeLLMCall(msgs);
        }
        const timeoutSec = Math.round(LLM_TIMEOUT_MS / 1000);
        let resp = await Promise.race([
          this.llm.chat(effectiveMsgs, t, this.getLLMOptions(action, userContent)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutSec}s`)), LLM_TIMEOUT_MS)
          )]);

        if (this.hooks.afterLLMCall) {
          resp = await this.hooks.afterLLMCall(resp);
        }

        if (resp.usage?.promptTokens) {
          this.lastRealPromptTokens = resp.usage.promptTokens;


          if (resp.usage.promptTokens > 60_000) {
            this.logger.warn(`Agent "${this.config.id}" real promptTokens=${resp.usage.promptTokens} > 60K — reactive prune triggered`);
            this.reactiveContextPrune(resp.usage.promptTokens);
          }
        }
        return resp;
      };


      const maxRounds = this.maxRounds;
      const MAX_TOTAL_LLM_CALLS = maxRounds + 6;
      const cycleStart = Date.now();
      const TOTAL_TIMEOUT_MS = 600_000;
      let totalLLMCalls = 0;
      const canCallLLM = () => totalLLMCalls < MAX_TOTAL_LLM_CALLS && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS);

      let response = await llmCall(safeMessages(), tools);
      accUsage(response.usage);
      totalLLMCalls++;


      if (this.activeCycleId !== myCycleId) {

        if (this.conversationHistory.length > historyLenBefore) {
          this.conversationHistory.length = historyLenBefore;
        }
        this.conversationHistory = this.conversationHistory.filter(m => m && m.role);
        return '⏹ Stopped by user.';
      }

      this.eventBus.emit('agent:llm_response', {
        agentId: this.config.id,
        content: this.stripThinkBlocks(response.content).slice(0, 300),
        fullContent: this.stripThinkBlocks(response.content),
        toolCallsCount: response.toolCalls?.length || 0,
        round: 0,
        usage: response.usage,
      });


      if ((!response.toolCalls || response.toolCalls.length === 0)
        && tools.length > 0
        && action === 'user_chat') {
        const ctx = userContent.toLowerCase();
        const needsTools = /find|search|fetch|browse|research|api|docs|check|analyze|scan|create|build|write|implement|scrape|download|monitor|fix|debug|repair|update|install|run|test|deploy/.test(ctx);
        if (needsTools) {
          const nudgeCount = this.efficiencyMode === 'economy' ? 1 : 2;

          const isBugFix = /fix|debug|repair|error|bug|broken/.test(ctx);
          const nudgeMessages = isBugFix
            ? [
                '[Use tools NOW. Read the existing code with project_read FIRST, then fix with project_str_replace. Do NOT rewrite entire files.]',
                '[CRITICAL: Call project_read RIGHT NOW to see the current code, then fix the bug.]']
            : [
                '[Use tools NOW. Don\'t describe — execute. Call project_write/terminal_exec/etc.]',
                '[CRITICAL: Call a tool RIGHT NOW or the task fails.]'];

          for (let nudgeAttempt = 0; nudgeAttempt < nudgeCount; nudgeAttempt++) {
            if (response.toolCalls && response.toolCalls.length > 0) break;

            this.logger.info(`Agent "${this.config.id}" nudge attempt ${nudgeAttempt + 1}/3: model responded without tools, retrying`);
            this.conversationHistory.push({
              role: 'assistant',
              content: response.content || '',
            });
            this.conversationHistory.push({
              role: 'user',
              content: nudgeMessages[nudgeAttempt],
            });
            response = await llmCall(safeMessages(), tools);
            accUsage(response.usage);
            totalLLMCalls++;
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: this.stripThinkBlocks(response.content).slice(0, 300),
              fullContent: this.stripThinkBlocks(response.content),
              toolCallsCount: response.toolCalls?.length || 0,
              round: 0,
              usage: response.usage,
            });
          }
        }
      }


      let toolCallRounds = 0;

      const usedToolCalls: { tool: string; args: string }[] = [];
      const terminalReadHashes: string[] = [];
      let consecutiveExecTimeouts = 0;
      let planningNudgeInjected = false;

      while (response.toolCalls && response.toolCalls.length > 0 && toolCallRounds < maxRounds && canCallLLM()) {
        if (this.cancelRequested || this.activeCycleId !== myCycleId) {
          this.logger.info(`Agent "${this.config.id}" cycle cancelled by user`);
          return '⏹ Stopped by user.';
        }
        if (Date.now() - cycleStart > TOTAL_TIMEOUT_MS) {
          this.logger.warn(`Agent "${this.config.id}" total cycle timeout (${TOTAL_TIMEOUT_MS}ms) at round ${toolCallRounds}`);
          this.conversationHistory.push({
            role: 'user' as const,
            content: '[Cycle timeout reached — work paused. Summarize what was completed and what remains.]',
          });
          break;
        }
        this.state.status = 'executing';
        toolCallRounds++;


        const MAX_CALLS_PER_ROUND = 6;
        let roundToolCalls = response.toolCalls;
        if (roundToolCalls.length > MAX_CALLS_PER_ROUND) {
          this.logger.warn(`Agent "${this.config.id}" capped tool calls: ${roundToolCalls.length} → ${MAX_CALLS_PER_ROUND}`);
          roundToolCalls = roundToolCalls.slice(0, MAX_CALLS_PER_ROUND);
        }


        {
          const META_DEDUP_BY_NAME = new Set(['list_available_tools']);
          const seen = new Set<string>();
          const deduped: typeof roundToolCalls = [];
          for (const tc of roundToolCalls) {
            let normArgs = '{}';
            try {
              const raw = tc.function.arguments;
              const parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
              normArgs = JSON.stringify(parsed);
            } catch { normArgs = tc.function.arguments || '{}'; }
            const key = META_DEDUP_BY_NAME.has(tc.function.name)
              ? tc.function.name
              : `${tc.function.name}::${normArgs}`;
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(tc);
            } else {
              this.logger.warn(`Agent "${this.config.id}" dedup: skipping duplicate call to ${tc.function.name}`);
            }
          }
          if (deduped.length < roundToolCalls.length) {
            this.logger.info(`Agent "${this.config.id}" deduped ${roundToolCalls.length} → ${deduped.length} tool calls`);
          }
          roundToolCalls = deduped;
        }

        this.conversationHistory.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: roundToolCalls,
        });


        for (const tc of roundToolCalls) {
          usedToolCalls.push({ tool: tc.function.name, args: tc.function.arguments });
        }
        const toolResults = await Promise.all(
          roundToolCalls.map(async (toolCall) => {
            this.eventBus.emit('agent:tool_call', {
              agentId: this.config.id,
              tool: toolCall.function.name,
              params: (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })(),
              round: toolCallRounds,
            });

            const toolStart = Date.now();
            const result = await this.executeToolCall(toolCall);

            this.eventBus.emit('agent:tool_result', {
              agentId: this.config.id,
              tool: toolCall.function.name,
              result: typeof result === 'string' ? result.slice(0, 300) : JSON.stringify(result).slice(0, 300),
              fullResult: typeof result === 'string' ? result : JSON.stringify(result),
              durationMs: Date.now() - toolStart,
            });

            return { toolCall, result };
          })
        );

        for (const { toolCall, result } of toolResults) {
          let content = typeof result === 'string' ? result : JSON.stringify(result);

          const cap = this.toolResultCharLimit;
          if (content.length > cap) {
            const keepHead = Math.floor(cap * 0.8);
            const keepTail = Math.max(200, Math.floor(cap * 0.15));
            content = content.slice(0, keepHead) + '\n...[trimmed ' + ((content.length / 1024) | 0) + 'KB→' + ((cap / 1024) | 0) + 'KB]...' + content.slice(-keepTail);
          }
          this.conversationHistory.push({
            role: 'tool',
            content,
            toolCallId: toolCall.id,
          });
        }


        if (this._toolCatalogReturned) {
          tools = tools.filter(t => t.function.name !== 'list_available_tools');
        }


        const allFailed = toolResults.every(({ result }) => {
          const s = typeof result === 'string' ? result : JSON.stringify(result);
          return s.includes('"error"') || s.includes('Error:') || s.includes('failed') || s.includes('unavailable');
        });
        if (allFailed && toolCallRounds > 1) {
          toolCallRounds -= 0.5;
          this.logger.info(`Agent "${this.config.id}" round ${toolCallRounds}: all tool calls failed — refunding 0.5 round`);
        }


        const failSearchTools = ['google_search', 'web_search', 'deep_research'];
        const recentSearchFails = usedToolCalls.slice(-6).filter(c => {
          return failSearchTools.includes(c.tool);
        });
        if (recentSearchFails.length >= 3) {
          const allSearchesFailed = toolResults
            .filter(({ toolCall: tc }) => failSearchTools.includes(tc.function.name))
            .every(({ result }) => {
              const s = typeof result === 'string' ? result : JSON.stringify(result);
              return s.includes('unavailable') || s.includes('failed') || s.includes('"error"');
            });
          if (allSearchesFailed) {
            this.conversationHistory.push({
              role: 'user',
              content: '[Search providers are DOWN. Stop calling google_search/web_search. Use browser_fetch to visit docs URLs directly, or use fetch_url. Work with what you have.]',
            });
          }
        }


        {
          const callCounts = new Map<string, number>();
          for (const c of usedToolCalls) {
            let normArgs: string;
            try { normArgs = JSON.stringify(JSON.parse(c.args || '{}')); } catch { normArgs = c.args || '{}'; }
            const key = `${c.tool}::${normArgs}`;
            callCounts.set(key, (callCounts.get(key) || 0) + 1);
          }
          const loopingTools = [...callCounts.entries()]
            .filter(([_, count]) => count >= 3)
            .map(([key]) => key.split('::')[0]);
          if (loopingTools.length > 0) {
            const unique = [...new Set(loopingTools)];
            this.logger.warn(`Agent "${this.config.id}" loop detected: ${unique.join(', ')} called 3+ times with same args`);
            this.conversationHistory.push({
              role: 'user',
              content: `[LOOP DETECTED: You called ${unique.join(', ')} 3+ times with identical arguments. You are going in circles. STOP repeating the same actions. Try a completely different approach, or report what is done and what is blocking you.]`,
            });
          }
        }


        {
          const errorsByTool = new Map<string, number>();
          for (const { toolCall: tc, result } of toolResults) {
            const res = typeof result === 'string' ? result : JSON.stringify(result);
            if (res.includes('Access denied') || res.includes('ENOENT') || res.includes('Error:')) {
              const nm = tc.function.name;
              errorsByTool.set(nm, (errorsByTool.get(nm) || 0) + 1);
            }
          }

          const recentHistory = this.conversationHistory.slice(-20);
          for (const msg of recentHistory) {
            if (msg.role === 'tool' && typeof msg.content === 'string' &&
                (msg.content.includes('Access denied') || msg.content.includes('ENOENT'))) {

              const toolName = (msg as any).name || '';
              if (toolName) errorsByTool.set(toolName, (errorsByTool.get(toolName) || 0) + 1);
            }
          }
          for (const [toolName, count] of errorsByTool) {
            if (count >= 3) {
              this.logger.warn(`Agent "${this.config.id}" error-loop: ${toolName} failed ${count} times`);
              this.conversationHistory.push({
                role: 'user',
                content: `[ERROR LOOP: ${toolName} has failed ${count} times. STOP calling it with bad paths. ALL file/folder paths MUST be inside ${pathMod.join(osMod.homedir(), 'Desktop', 'Projects')}. Example: ${pathMod.join(osMod.homedir(), 'Desktop', 'Projects', 'my_project', 'src', 'index.ts')}. Do NOT use /d prefix, do NOT use cd commands in paths. If you already created the project folder, use project_list to see what exists, then proceed from there.]`,
              });
            }
          }
        }


        {
          const readResults = toolResults.filter(({ toolCall: tc }) => tc.function.name === 'terminal_read');
          for (const { result } of readResults) {
            const s = (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 500);
            const hash = s.length + ':' + s.slice(0, 80);
            terminalReadHashes.push(hash);
          }
          if (terminalReadHashes.length >= 3) {
            const last3 = terminalReadHashes.slice(-3);
            if (last3[0] === last3[1] && last3[1] === last3[2]) {
              this.logger.warn(`Agent "${this.config.id}" stagnation: terminal_read returned same output 3 times`);
              this.conversationHistory.push({
                role: 'user',
                content: '[STAGNATION: terminal_read is returning the same output repeatedly. The terminal state has NOT changed. Do NOT call terminal_read again until you make a change (edit a file, run a different command). Analyze what you already know and take a different action.]',
              });
            }
          }
        }


        {
          const execResults = toolResults.filter(({ toolCall: tc }) => tc.function.name === 'terminal_exec');
          let anyExecTimedOut = false;
          for (const { result } of execResults) {
            const s = typeof result === 'string' ? result : JSON.stringify(result);
            if (s.includes('"completed":false') && (s.includes('"output":""') || s.includes('timed out') || s.includes('TERMINAL STUCK'))) {
              anyExecTimedOut = true;
            }
          }
          if (anyExecTimedOut) {
            consecutiveExecTimeouts++;
          } else if (execResults.length > 0) {
            consecutiveExecTimeouts = 0;
          }
          if (consecutiveExecTimeouts >= 2) {
            this.logger.warn(`Agent "${this.config.id}" terminal stuck: ${consecutiveExecTimeouts} consecutive rounds with exec timeouts`);
            this.conversationHistory.push({
              role: 'user',
              content: `[TERMINAL IS BROKEN: ${consecutiveExecTimeouts} consecutive rounds of terminal_exec timeouts. The terminal is occupied by a running process or is unresponsive. ABANDON terminal_exec entirely. Use project_write to create/edit files and project_serve to preview. Do NOT waste more rounds on terminal commands.]`,
            });
          }
        }


        {
          const writtenPaths = new Set<string>();
          for (const c of usedToolCalls) {
            if (c.tool === 'project_write' || c.tool === 'project_create' || c.tool === 'project_edit') {
              try {
                const args = JSON.parse(c.args || '{}');
                if (args.path) writtenPaths.add(args.path);
                if (args.filePath) writtenPaths.add(args.filePath);
              } catch {}
            }
          }
          if (writtenPaths.size > 0) {
            const recentReads = toolResults.filter(({ toolCall: tc }) => tc.function.name === 'project_read');
            const redundantReads: string[] = [];
            for (const { toolCall: tc } of recentReads) {
              try {
                const args = JSON.parse(tc.function.arguments || '{}');
                const readPath = args.path || args.filePath || '';
                if (readPath && writtenPaths.has(readPath)) {
                  redundantReads.push(readPath);
                }
              } catch {}
            }
            if (redundantReads.length > 0) {
              this.logger.warn(`Agent "${this.config.id}" re-reading ${redundantReads.length} files it just wrote: ${redundantReads.join(', ')}`);
              this.conversationHistory.push({
                role: 'user',
                content: `[WASTE: You are re-reading files you already wrote (${redundantReads.join(', ')}). You know their contents — you created them. Stop reading and move to the NEXT uncompleted task. Check your TODOs with project_todo_list.]`,
              });
            }
          }
        }


        {
          const writeCountByPath = new Map<string, number>();
          for (const c of usedToolCalls) {
            if (c.tool === 'project_write' || c.tool === 'project_create') {
              try {
                const args = JSON.parse(c.args || '{}');
                const p = args.path || args.filePath || '';
                if (p) writeCountByPath.set(p, (writeCountByPath.get(p) || 0) + 1);
              } catch {}
            }
          }
          const duplicateWrites = [...writeCountByPath.entries()].filter(([_, count]) => count >= 2);
          if (duplicateWrites.length > 0) {
            const fileNames = duplicateWrites.map(([p, c]) => `${p.split(/[\/\\]/).pop()} (${c}x)`).join(', ');
            this.logger.warn(`Agent "${this.config.id}" duplicate writes: ${fileNames}`);
            this.conversationHistory.push({
              role: 'user',
              content: `[DUPLICATE WRITES: You wrote the same files multiple times: ${fileNames}. Each file should only be written ONCE. If you need to modify, use project_str_replace. Move on to the NEXT task.]`,
            });
          }
        }


        if (this.lazyToolLoading) {
          const newDynamic = new Set<string>();
          for (const { toolCall: tc } of toolResults) {
            if (tc.function.name === 'get_tool_schema') {
              const reqName = (() => { try { return JSON.parse(tc.function.arguments).tool_name; } catch { return ''; } })();
              if (reqName && this.dynamicTools.has(reqName)) {
                newDynamic.add(reqName);

                const siblings = this.skills.getSiblingToolNames(reqName);
                for (const sib of siblings) {
                  this.dynamicTools.add(sib);
                  newDynamic.add(sib);
                }
              }
            }
          }

          for (const dynName of newDynamic) {
            if (!tools.some(t => t.function.name === dynName)) {
              const newTool = allTools.find(t => t.function.name === dynName);
              if (newTool) {
                tools.push(newTool);
                this.logger.info(`Agent "${this.config.id}" lazy-loaded tool: ${dynName}`);
              }
            }
          }

          if (tools.length > AgentRunner.MAX_TOOLS_COPILOT) {
            const keepNames = new Set([...this.dynamicTools,
              'think', 'spawn_tasks', 'get_tool_schema', 'list_available_tools',
              'project_write', 'project_read', 'project_list', 'project_str_replace', 'project_run']);
            const kept = tools.filter(t => keepNames.has(t.function.name));
            const rest = tools.filter(t => !keepNames.has(t.function.name));
            const budget = AgentRunner.MAX_TOOLS_COPILOT - kept.length;
            tools = [...kept, ...rest.slice(0, Math.max(0, budget))];
          }
        }


        const researchBudget = Math.ceil(maxRounds * 0.4);
        if (toolCallRounds >= researchBudget && !planningNudgeInjected) {
          const searchToolNames = ['google_search', 'web_search', 'browser_fetch', 'fetch_url', 'deep_research', 'extract_api_docs'];
          const implToolNames = ['project_write', 'project_str_replace', 'project_mkdir', 'project_run', 'project_execute'];
          const totalSearches = usedToolCalls.filter(c => searchToolNames.includes(c.tool)).length;
          const totalTerminal = usedToolCalls.filter(c => c.tool === 'terminal_exec' || c.tool === 'terminal_read' || c.tool === 'terminal_write').length;
          const hasWritten = usedToolCalls.some(c => implToolNames.includes(c.tool));

          if ((totalSearches >= 3 || totalTerminal >= 5) && !hasWritten) {
            planningNudgeInjected = true;
            this.logger.warn(`Agent "${this.config.id}" spent ${toolCallRounds}/${maxRounds} rounds on non-coding (searches=${totalSearches}, terminal=${totalTerminal}), 0 code written`);
            this.conversationHistory.push({
              role: 'user',
              content: `[${toolCallRounds}/${maxRounds} rounds used, 0 files written. STOP terminal/search side-quests. Start coding NOW with project_write. Create ALL project files immediately.]`,
            });
          }
        }


        {
          const searchToolNames = ['google_search', 'web_search', 'browser_fetch', 'fetch_url', 'deep_research', 'extract_api_docs'];
          const recentCalls = usedToolCalls.slice(-5);
          if (recentCalls.length >= 5) {
            const allResearch = recentCalls.every(c => searchToolNames.includes(c.tool));
            if (allResearch) {
              this.logger.warn(`Agent "${this.config.id}" post-write research loop: last 5 tool calls are all search/fetch`);
              this.conversationHistory.push({
                role: 'user',
                content: '[RESEARCH LOOP: Last 5 tool calls were all searches/fetches with no code written. STOP exploring. If the API is not available, implement fallback logic (demo data, error handling). Write code NOW with project_write.]',
              });
            }
          }
        }


        {
          const fetchTools = ['browser_fetch', 'fetch_url'];
          const recentFetches = toolResults.filter(({ toolCall: tc }) => fetchTools.includes(tc.function.name));
          let consecutiveErrors = 0;
          for (const { result } of recentFetches) {
            const s = typeof result === 'string' ? result : JSON.stringify(result);
            if (s.includes('"error"') || s.includes('HTTP 4') || s.includes('HTTP 5') || s.includes('fetch failed')) {
              consecutiveErrors++;
            } else {
              consecutiveErrors = 0;
            }
          }
          if (consecutiveErrors >= 3) {
            this.logger.warn(`Agent "${this.config.id}" ${consecutiveErrors} consecutive fetch errors — API exploration is failing`);
            this.conversationHistory.push({
              role: 'user',
              content: `[API UNREACHABLE: ${consecutiveErrors} consecutive HTTP errors from browser_fetch. The API endpoint does NOT exist or is down. STOP guessing URLs. Implement the feature with available data, mock/demo data, or report that the API is unavailable. Do NOT make more fetch calls to the same domain.]`,
            });
          }
        }


        if (toolCallRounds >= Math.ceil(maxRounds * 0.75)) {
          const recentWrites = usedToolCalls.slice(-5).filter(c =>
            ['project_write', 'project_str_replace', 'project_create', 'project_edit'].includes(c.tool));
          if (recentWrites.length === 0) {

            let todoReminder = '';
            try {
              const todoResult = await this.skills.executeTool('project_todo_list', {});
              const todos = (todoResult as any)?.todos || [];
              const pending = todos.filter((t: any) => t.status !== 'done');
              if (pending.length > 0) {
                todoReminder = ` PENDING TODOs (${pending.length}): ${pending.map((t: any) => t.text).join('; ')}.`;
              }
            } catch {  }
            this.logger.warn(`Agent "${this.config.id}" budget exhaustion: ${toolCallRounds}/${maxRounds} rounds, no writes in last 5 rounds`);
            this.conversationHistory.push({
              role: 'user',
              content: `[CRITICAL: ${toolCallRounds}/${maxRounds} rounds used with no file changes in last 5 rounds.${todoReminder} You MUST either: 1) Make the fix NOW with project_write/project_str_replace, or 2) Report what is blocking you. Do NOT read more files or run more searches.]`,
            });
          }
        }


        await this.compactHistoryIfNeeded();
        this.trimHistory();
        this.emergencyContextPrune();


        if (this.lastRealPromptTokens > 45_000) {
          this.logger.warn(`Agent "${this.config.id}" pre-call prune: last call used ${this.lastRealPromptTokens} prompt tokens`);
          this.reactiveContextPrune(this.lastRealPromptTokens);
        }

        response = await llmCall(safeMessages(), tools);
        accUsage(response.usage);
        totalLLMCalls++;

        this.eventBus.emit('agent:llm_response', {
          agentId: this.config.id,
          content: this.stripThinkBlocks(response.content).slice(0, 300),
          fullContent: this.stripThinkBlocks(response.content),
          toolCallsCount: response.toolCalls?.length || 0,
          round: toolCallRounds,
          usage: response.usage,
        });
      }


      if (action === 'user_chat' && tools.length > 0 && canCallLLM()) {
        const totalTodosCreated = usedToolCalls.filter(c => c.tool === 'project_todo_add').length;
        const totalWrites = usedToolCalls.filter(c => c.tool === 'project_write' || c.tool === 'project_str_replace').length;
        const hasNoToolsNow = !response.toolCalls || response.toolCalls.length === 0;
        const totalResearch = usedToolCalls.filter(c =>
          ['google_search', 'web_search', 'browser_fetch', 'fetch_url', 'deep_research', 'extract_api_docs'].includes(c.tool)
        ).length;
        if ((totalTodosCreated >= 2 || totalResearch >= 3) && totalWrites === 0 && hasNoToolsNow) {
          const reason = totalTodosCreated >= 2
            ? `planned ${totalTodosCreated} todos`
            : `${totalResearch} research calls`;
          this.logger.info(`Agent "${this.config.id}" ${reason} but wrote 0 files — forcing implementation`);
          this.conversationHistory.push({ role: 'assistant', content: response.content || '' });
          this.conversationHistory.push({
            role: 'user',
            content: `[IMPLEMENT NOW: ${reason}, 0 files written. Call project_write for ALL files in parallel NOW. No more research.]`,
          });
          response = await llmCall(safeMessages(), tools);
          accUsage(response.usage);
          totalLLMCalls++;
          this.eventBus.emit('agent:llm_response', {
            agentId: this.config.id,
            content: this.stripThinkBlocks(response.content).slice(0, 300),
            fullContent: this.stripThinkBlocks(response.content),
            toolCallsCount: response.toolCalls?.length || 0,
            round: toolCallRounds + 1,
            usage: response.usage,
          });

          let implRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && implRounds < 4 && canCallLLM()) {
            implRounds++;
            this.conversationHistory.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });
            for (const tc of response.toolCalls) {
              usedToolCalls.push({ tool: tc.function.name, args: tc.function.arguments });
            }
            const implResults = await Promise.all(
              response.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function.name;
                this.eventBus.emit('agent:tool_call', {
                  agentId: this.config.id,
                  tool: toolName,
                  params: (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })(),
                  round: toolCallRounds + implRounds,
                });
                const startTs = Date.now();
                const result = await this.executeToolCall(toolCall);
                this.eventBus.emit('agent:tool_result', {
                  agentId: this.config.id,
                  tool: toolName,
                  result: typeof result === 'string' ? result.slice(0, 300) : JSON.stringify(result).slice(0, 300),
                  fullResult: typeof result === 'string' ? result : JSON.stringify(result),
                  durationMs: Date.now() - startTs,
                });
                return { toolCall, result };
              })
            );
            for (const { toolCall, result } of implResults) {
              let content = typeof result === 'string' ? result : JSON.stringify(result);
              const cap = this.toolResultCharLimit;
              if (content.length > cap) {
                content = content.slice(0, Math.floor(cap * 0.8)) + '\n...[trimmed]...' + content.slice(-Math.min(200, Math.floor(cap * 0.15)));
              }
              this.conversationHistory.push({
                role: 'tool',
                content,
                toolCallId: toolCall.id,
              });
            }
            await this.compactHistoryIfNeeded();
            this.trimHistory();
            this.emergencyContextPrune();
            response = await llmCall(safeMessages(), tools);
            accUsage(response.usage);
            totalLLMCalls++;
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: this.stripThinkBlocks(response.content).slice(0, 300),
              fullContent: this.stripThinkBlocks(response.content),
              toolCallsCount: response.toolCalls?.length || 0,
              round: toolCallRounds + implRounds,
              usage: response.usage,
            });
          }
        }
      }


      const antiQuestionEnabled = this.efficiencyMode !== 'economy'
        && this.autoApproveLevel !== 'off'
        && this.autoApproveLevel !== 'conservative';
      if (antiQuestionEnabled && action === 'user_chat' && tools.length > 0) {
        const questionPatterns = /(?:want me to|shall i|should i|do you want|would you like|how would you like|how do you want|can i|may i|let me know|confirm|clarify|suggest you|are you ready|if you have|if you can provide|could you provide|can you provide|do you know|do you have)\b/i;
        let antiQuestionRounds = 0;
        const MAX_ANTI_QUESTION = 1;

        while (antiQuestionRounds < MAX_ANTI_QUESTION && canCallLLM()) {
          const finalText = (response.content || '').toLowerCase();

          const hasQuestionMark = questionPatterns.test(finalText) && finalText.includes('?');
          const hesitationPatterns = /(?:if you have|if you can provide|could you provide|let me know|could not find .{0,30} via available|i can try|want me to continue)/i;
          const hasHesitation = hesitationPatterns.test(finalText);
          const hasQuestion = hasQuestionMark || hasHesitation;
          const hasNoTools = !response.toolCalls || response.toolCalls.length === 0;

          if (!hasQuestion || !hasNoTools) break;

          antiQuestionRounds++;
          this.logger.info(`Agent "${this.config.id}" anti-question round ${antiQuestionRounds}: model asked a question instead of acting, forcing continuation`);

          this.conversationHistory.push({
            role: 'assistant',
            content: response.content || '',
          });
          this.conversationHistory.push({
            role: 'user',
            content: '[System: YES — act NOW. No permission needed. Use tools immediately.]',
          });

          response = await llmCall(safeMessages(), tools);
          accUsage(response.usage);
          totalLLMCalls++;


          let extraRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && extraRounds < 3 && canCallLLM()) {
            extraRounds++;
            this.conversationHistory.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });
            const toolResults = await Promise.all(
              response.toolCalls.map(async (toolCall) => {
                this.eventBus.emit('agent:tool_call', {
                  agentId: this.config.id,
                  tool: toolCall.function.name,
                  params: (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })(),
                  round: toolCallRounds + extraRounds,
                });
                const result = await this.executeToolCall(toolCall);
                return { toolCall, result };
              })
            );
            for (const { toolCall, result } of toolResults) {
              let content = typeof result === 'string' ? result : JSON.stringify(result);
              const cap = this.toolResultCharLimit;
              if (content.length > cap) {
                content = content.slice(0, Math.floor(cap * 0.8)) + '\n...[trimmed]...' + content.slice(-Math.min(200, Math.floor(cap * 0.15)));
              }
              this.conversationHistory.push({
                role: 'tool',
                content,
                toolCallId: toolCall.id,
              });
            }
            await this.compactHistoryIfNeeded();
            this.trimHistory();
            this.emergencyContextPrune();
            response = await llmCall(safeMessages(), tools);
            accUsage(response.usage);
            totalLLMCalls++;
          }
        }
      }


      if (this.efficiencyMode !== 'economy' && action === 'user_chat' && tools.length > 0 && canCallLLM()) {
        const wroteFiles = usedToolCalls.some(c => c.tool === 'project_write');
        const ranTests = usedToolCalls.some(c => c.tool === 'project_execute' || c.tool === 'project_run');
        const readBackFiles = usedToolCalls.filter(c => c.tool === 'project_read').length;
        const writeCount = usedToolCalls.filter(c => c.tool === 'project_write').length;

        if (wroteFiles && !ranTests && writeCount >= 2) {
          this.logger.info(`Agent "${this.config.id}" wrote ${writeCount} files without testing — nudging to verify`);

          this.conversationHistory.push({
            role: 'assistant',
            content: response.content || '',
          });
          this.conversationHistory.push({
            role: 'user',
            content: '[System: You wrote files but never tested. project_read to review, then project_run to verify. Fix errors if any. Do it NOW.]',
          });

          response = await llmCall(safeMessages(), tools);
          accUsage(response.usage);
          totalLLMCalls++;


          let verifyRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && verifyRounds < 3 && canCallLLM()) {
            verifyRounds++;
            this.conversationHistory.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });
            const toolResults = await Promise.all(
              response.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function.name;
                usedToolCalls.push({ tool: toolName, args: toolCall.function.arguments });
                this.eventBus.emit('agent:tool_call', {
                  agentId: this.config.id,
                  tool: toolName,
                  params: (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })(),
                  round: toolCallRounds + verifyRounds,
                });
                const startTs = Date.now();
                const result = await this.executeToolCall(toolCall);
                this.eventBus.emit('agent:tool_result', {
                  agentId: this.config.id,
                  tool: toolName,
                  result,
                  durationMs: Date.now() - startTs,
                });
                return { toolCall, result };
              })
            );
            for (const { toolCall, result } of toolResults) {
              let content = typeof result === 'string' ? result : JSON.stringify(result);
              const cap = this.toolResultCharLimit;
              if (content.length > cap) {
                content = content.slice(0, Math.floor(cap * 0.8)) + '\n...[trimmed]...' + content.slice(-Math.min(200, Math.floor(cap * 0.15)));
              }
              this.conversationHistory.push({
                role: 'tool',
                content,
                toolCallId: toolCall.id,
              });
            }
            await this.compactHistoryIfNeeded();
            this.trimHistory();
            this.emergencyContextPrune();
            response = await llmCall(safeMessages(), tools);
            accUsage(response.usage);
            totalLLMCalls++;
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: this.stripThinkBlocks(response.content).slice(0, 300),
              fullContent: this.stripThinkBlocks(response.content),
              toolCallsCount: response.toolCalls?.length || 0,
              round: toolCallRounds + verifyRounds,
              usage: response.usage,
            });
          }
        }
      }


      if (this.efficiencyMode !== 'economy' && action === 'user_chat' && tools.length > 0 && canCallLLM()) {
        const finalText = (response.content || '').toLowerCase();
        const errorGiveUpPatterns = /(?:failed to|error occurred|need to check|need to verify|authorization.*required|an error|encountered.*error|issue with)/i;
        const hasErrorGiveUp = errorGiveUpPatterns.test(finalText);
        const hasNoTools = !response.toolCalls || response.toolCalls.length === 0;
        const wroteCode = usedToolCalls.some(c => c.tool === 'project_write');

        if (hasErrorGiveUp && hasNoTools && wroteCode) {
          this.logger.info(`Agent "${this.config.id}" gave up after encountering an error — forcing continuation`);

          this.conversationHistory.push({
            role: 'assistant',
            content: response.content || '',
          });
          this.conversationHistory.push({
            role: 'user',
            content: '[System: You reported an error but stopped. Read the error, fix the code, test again. Do NOT give up — fix it NOW.]',
          });

          response = await llmCall(safeMessages(), tools);
          accUsage(response.usage);
          totalLLMCalls++;


          let fixRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && fixRounds < 3 && canCallLLM()) {
            fixRounds++;
            this.conversationHistory.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });
            const toolResults = await Promise.all(
              response.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function.name;
                usedToolCalls.push({ tool: toolName, args: toolCall.function.arguments });
                this.eventBus.emit('agent:tool_call', {
                  agentId: this.config.id,
                  tool: toolName,
                  params: (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return {}; } })(),
                  round: toolCallRounds + fixRounds,
                });
                const startTs = Date.now();
                const result = await this.executeToolCall(toolCall);
                this.eventBus.emit('agent:tool_result', {
                  agentId: this.config.id,
                  tool: toolName,
                  result,
                  durationMs: Date.now() - startTs,
                });
                return { toolCall, result };
              })
            );
            for (const { toolCall, result } of toolResults) {
              let content = typeof result === 'string' ? result : JSON.stringify(result);
              const cap = this.toolResultCharLimit;
              if (content.length > cap) {
                content = content.slice(0, Math.floor(cap * 0.8)) + '\n...[trimmed]...' + content.slice(-Math.min(200, Math.floor(cap * 0.15)));
              }
              this.conversationHistory.push({
                role: 'tool',
                content,
                toolCallId: toolCall.id,
              });
            }
            await this.compactHistoryIfNeeded();
            this.trimHistory();
            this.emergencyContextPrune();
            response = await llmCall(safeMessages(), tools);
            accUsage(response.usage);
            totalLLMCalls++;
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: this.stripThinkBlocks(response.content).slice(0, 300),
              fullContent: this.stripThinkBlocks(response.content),
              toolCallsCount: response.toolCalls?.length || 0,
              round: toolCallRounds + fixRounds,
              usage: response.usage,
            });
          }
        }
      }


      let decision = response.content || '';
      let didStreamFinal = false;

      if (
        this.efficiencyMode !== 'economy' &&
        action === 'user_chat' &&
        !response.toolCalls?.length &&
        this.llm.stream &&
        decision.length === 0
      ) {
        try {
          let streamedContent = '';
          const streamOpts = this.getLLMOptions(action, userContent);
          const STREAM_TIMEOUT_MS = 60_000;
          const streamStart = Date.now();
          const finalStream = this.llm.stream(safeMessages(), [], streamOpts);
          for await (const chunk of finalStream) {
            if (Date.now() - streamStart > STREAM_TIMEOUT_MS) {
              this.logger.warn(`Agent "${this.config.id}" streaming timeout (${STREAM_TIMEOUT_MS}ms)`);
              break;
            }
            if (chunk.content) {
              streamedContent += chunk.content;
              this.eventBus.emit('agent:token', {
                agentId: this.config.id,
                token: chunk.content,
              });
            }
            if (chunk.done) break;
            if (chunk.toolCalls?.length) {

              streamedContent = '';
              break;
            }
          }
          if (streamedContent) {
            decision = streamedContent;
            didStreamFinal = true;
          }
        } catch {


          decision = response.content || '';
        }
      }


      if (decision && !didStreamFinal) {
        this.eventBus.emit('agent:token', { agentId: this.config.id, token: decision, final: true });
      }

      this.conversationHistory.push({
        role: 'assistant',
        content: decision,
      });


      if (action === 'user_chat') {
        this.logTranscript('assistant', decision);
      }

      this.state.totalDecisions++;
      this.state.lastAction = action;
      this.state.lastActionAt = Date.now();
      this.state.status = 'idle';

      this.eventBus.emit('agent:decided', {
        agentId: this.config.id,
        action,
        reason: decision.slice(0, 200),
        fullReason: decision,
      });


      if (cycleUsage.promptTokens > 0 || cycleUsage.completionTokens > 0) {
        this.eventBus.emit('agent:cycle_usage', {
          agentId: this.config.id,
          promptTokens: cycleUsage.promptTokens,
          completionTokens: cycleUsage.completionTokens,
          totalTokens: cycleUsage.promptTokens + cycleUsage.completionTokens,
          contextWindowTokens: this.getContextWindowTokens(),
        });
      }

      this.logger.info(`Agent "${this.config.name}": ${decision.slice(0, 150)}`);
      if (cycleUsage.promptTokens > 0) {
        this.logger.info(`Token usage: ${cycleUsage.promptTokens} prompt + ${cycleUsage.completionTokens} completion = ${cycleUsage.promptTokens + cycleUsage.completionTokens} total`);
      }


      if (
        action === 'user_chat' &&
        toolCallRounds > 2 &&
        canCallLLM() &&
        !this.cancelRequested &&
        this.activeCycleId === myCycleId &&
        this.autoContinueDepth < 2
      ) {
        const codingTools = ['project_write', 'project_edit', 'project_create', 'terminal_exec'];
        const usedCodingTools = usedToolCalls.filter(tc => codingTools.includes(tc.tool));


        const completionPatterns = /\b(all done|completed|finished|ready to use|successfully|all files (have been |are )?(created|written)|implementation is complete|project is ready|you can now)\b/i;
        const looksComplete = completionPatterns.test(decision);


        const incompletionPatterns = /\b(need to (still |also )?(create|write|add|fix|update|install|implement)|still need|remaining (steps|files|tasks)|todo:?\s|let me (continue|proceed|create|write|add|fix)|i'll (now |next )?(create|write|add|fix|implement|set up))\b/i;
        const looksIncomplete = incompletionPatterns.test(decision);


        let hasPendingTodos = false;
        let pendingTodoTexts: string[] = [];
        try {
          const todoResult = await this.skills.executeTool('project_todo_list', {});
          const todos = (todoResult as any)?.todos || [];
          const pending = todos.filter((t: any) => t.status !== 'done');
          if (pending.length > 0) {
            hasPendingTodos = true;
            pendingTodoTexts = pending.map((t: any) => t.text);
          }
        } catch {  }

        const shouldContinue =
          (usedCodingTools.length > 0 && !looksComplete && looksIncomplete) ||
          (hasPendingTodos && usedCodingTools.length > 0);


        const productiveTools = ['project_write', 'project_edit', 'project_create', 'project_str_replace', 'project_todo_update'];
        const hadProductiveWork = usedToolCalls.some(tc => productiveTools.includes(tc.tool));
        const terminalTimeoutsInCycle = consecutiveExecTimeouts;
        const wastedCycle = !hadProductiveWork && terminalTimeoutsInCycle >= 2;

        if (shouldContinue && wastedCycle) {
          this.logger.warn(`Agent "${this.config.id}" skipping auto-continue: last cycle was wasted (${terminalTimeoutsInCycle} exec timeouts, no productive work)`);
        } else if (shouldContinue) {
          const todoCtx = hasPendingTodos
            ? ` PENDING TODOs (${pendingTodoTexts.length}): ${pendingTodoTexts.join('; ')}.`
            : '';
          this.logger.info(`Agent "${this.config.id}" auto-continue (depth ${this.autoContinueDepth}): coding work incomplete (pendingTodos=${pendingTodoTexts.length}), continuing`);
          this.conversationHistory.push({
            role: 'user',
            content: `[Continue with the remaining work.${todoCtx} IMPORTANT: Call project_todo_update to mark completed items as "done" BEFORE moving on. Then work on the NEXT pending TODO. Use project_write for files, terminal_exec for commands. Do NOT declare "done" until ALL TODOs show status "done".]`,
          });
          this.autoContinueDepth++;
          try {
            const continuation = await this.processLLMCycle(action, '[auto-continue from previous incomplete work]');
            return decision + '\n\n' + continuation;
          } catch {
            return decision;
          } finally {
            this.autoContinueDepth--;
          }
        }
      }

      return decision;
    } catch (err: any) {
      this.state.status = 'error';

      if (this.conversationHistory.length > historyLenBefore) {
        this.conversationHistory.length = historyLenBefore;
      }
      this.conversationHistory = this.conversationHistory.filter(m => m && m.role);

      setTimeout(() => {
        if (this.state.status === 'error') this.state.status = 'idle';
      }, 2000);
      const errMsg = err.message || String(err);
      this.logger.error(`Agent "${this.config.id}" error`, err);
      this.eventBus.emit('agent:error', {
        agentId: this.config.id,
        error: errMsg,
      });

      if (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('Unauthorized')) {
        return 'LLM authentication failed. Please check your OAuth connection in Settings → OAuth / Free AI, or verify your API keys in `.env`.';
      }
      if (errMsg.includes('timed out')) {
        return 'The AI model took too long to respond. Please try again.';
      }
      return errMsg ? `Error: ${errMsg}` : 'An unknown error occurred. Please try again.';
    }
  }

  async chat(userMessage: string, image?: string): Promise<string> {

    await this.fetchSolPrice().catch(() => {});

    if (this.conversationHistory.length > 0 && this.conversationHistory[0].role === 'system') {
      this.conversationHistory[0].content = this.compactSystemPrompt(this.config.role);
    }


    if (this.state.status === 'thinking' || this.state.status === 'executing') {
      return 'I\'m currently processing another request. Please wait a moment and try again.';
    }


    this.dynamicTools.clear();


    if (userMessage.trim().toLowerCase() === '/compact') {
      const result = await this.compactNow();
      this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: result, final: true });
      return result;
    }


    if (userMessage.trim().toLowerCase() === '/new' || userMessage.trim().toLowerCase() === '/reset') {
      this.clearSession();
      const result = '✅ New session started. All previous context cleared.';
      this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: result, final: true });
      return result;
    }

    this.eventBus.emit('agent:chat_request', {
      agentId: this.config.id,
      message: userMessage.slice(0, 200),
    });


    this.logTranscript('user', userMessage);


    this._pendingImage = image || undefined;

    const contextParts: string[] = [];


    const trimmed = userMessage.trim();


    await this.refreshWalletTokens().catch(() => {});


    const addressInMsg = trimmed.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    const isBuyCmd = /\b(buy)\b/i.test(trimmed);
    const isSellCmd = /\b(sell|dump)\b/i.test(trimmed);

    if (addressInMsg && (isBuyCmd || isSellCmd)) {
      const mint = addressInMsg[1];

      if (isBuyCmd) {

        const usdMatch = trimmed.match(/(\d+(?:[.]\d+)?)\s*(?:\$|usd)/i)
          || trimmed.match(/\$\s*(\d+(?:[.]\d+)?)/i);
        const solMatch = trimmed.match(/(\d+(?:[.]\d+)?)\s*(?:sol)\b/i);

        const buyParams: Record<string, any> = { mint, slippageBps: 1500 };
        if (usdMatch) {
          buyParams.amountUsd = parseFloat(usdMatch[1].replace(',', '.'));
        } else if (solMatch) {
          buyParams.amountSol = parseFloat(solMatch[1].replace(',', '.'));
        } else {

          buyParams.amountUsd = 1;
        }

        this.logger.info(`[auto-route] BUY detected: mint=${mint}, ${buyParams.amountUsd ? '$' + buyParams.amountUsd : buyParams.amountSol + ' SOL'}`);


        this.conversationHistory.push({ role: 'user', content: userMessage });

        try {
          const result = await this.skills.executeTool('buy_token', buyParams);
          const response = result?.success
            ? `✅ Purchase completed!\n\n` +
              `**Token:** \`${mint.slice(0, 8)}...${mint.slice(-4)}\`\n` +
              `**Spent:** ${buyParams.amountUsd ? '$' + buyParams.amountUsd : buyParams.amountSol + ' SOL'}\n` +
              (result.amountSol ? `**SOL:** ${result.amountSol.toFixed(6)} SOL\n` : '') +
              (result.txHash ? `**TX:** \`${result.txHash}\`` : '')
            : `❌ Purchase error: ${result?.error || 'Unknown error'}\n\nMint: \`${mint}\``;

          this.conversationHistory.push({ role: 'assistant', content: response });
          this.logTranscript('assistant', response);
          this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: response, final: true });
          return response;
        } catch (err: any) {
          const errMsg = `❌ Failed to buy: ${err.message}`;
          this.conversationHistory.push({ role: 'assistant', content: errMsg });
          this.logTranscript('assistant', errMsg);
          this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: errMsg, final: true });
          return errMsg;
        }
      }

      if (isSellCmd) {
        const pctMatch = trimmed.match(/(\d+)\s*%/);
        const percent = pctMatch ? parseInt(pctMatch[1]) : 100;

        this.logger.info(`[auto-route] SELL detected: mint=${mint}, percent=${percent}%`);

        this.conversationHistory.push({ role: 'user', content: userMessage });

        try {
          const result = await this.skills.executeTool('sell_token', { mint, percent, slippageBps: 1500 });
          const response = result?.success
            ? `✅ Sale completed!\n\n` +
              `**Token:** \`${mint.slice(0, 8)}...${mint.slice(-4)}\`\n` +
              `**Sold:** ${percent}%\n` +
              (result.txHash ? `**TX:** \`${result.txHash}\`` : '')
            : `❌ Sale error: ${result?.error || 'Unknown error'}`;

          this.conversationHistory.push({ role: 'assistant', content: response });
          this.logTranscript('assistant', response);
          this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: response, final: true });
          return response;
        } catch (err: any) {
          const errMsg = `❌ Failed to sell: ${err.message}`;
          this.conversationHistory.push({ role: 'assistant', content: errMsg });
          this.logTranscript('assistant', errMsg);
          this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: errMsg, final: true });
          return errMsg;
        }
      }
    }


    if (!addressInMsg && isSellCmd) {
      const tokenQuery = trimmed
        .replace(/\b(sell|dump|all)\b/gi, '')
        .replace(/\d+\s*%/, '')
        .trim();

      if (tokenQuery) {
        const resolved = this.resolveTokenFromHoldings(tokenQuery);
        if (resolved) {
          const pctMatch = trimmed.match(/(\d+)\s*%/);
          const percent = pctMatch ? parseInt(pctMatch[1]) : 100;
          const mint = resolved.mint;

          this.logger.info(`[auto-route] SELL by symbol: "${tokenQuery}" → ${resolved.symbol} (${mint}), percent=${percent}%`);
          this.conversationHistory.push({ role: 'user', content: userMessage });

          try {
            const result = await this.skills.executeTool('sell_token', { mint, percent, slippageBps: 1500 });
            const response = result?.success
              ? `✅ Sale completed!\n\n` +
                `**Token:** ${resolved.symbol || resolved.name} (\`${mint.slice(0, 8)}...${mint.slice(-4)}\`)\n` +
                `**Sold:** ${percent}%\n` +
                (result.txHash ? `**TX:** \`${result.txHash}\`` : '')
              : `❌ Sale error: ${result?.error || 'Unknown error'}`;

            this.conversationHistory.push({ role: 'assistant', content: response });
            this.logTranscript('assistant', response);
            this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: response, final: true });
            return response;
          } catch (err: any) {
            const errMsg = `❌ Failed to sell ${resolved.symbol}: ${err.message}`;
            this.conversationHistory.push({ role: 'assistant', content: errMsg });
            this.logTranscript('assistant', errMsg);
            this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: errMsg, final: true });
            return errMsg;
          }
        }
      }
    }


    const _isJobSession = this.config.id.startsWith('_job_');

    if (!_isJobSession && trimmed.length > 5) {
      try {

        const classifyPrompt = `Classify this user message. Does the user want to create a background monitoring/tracking job or task that should run for some period of time?

User message: "${trimmed.slice(0, 500)}"

Reply ONLY with valid JSON, nothing else:
{"is_job": true/false, "duration_minutes": NUMBER_OR_NULL, "interval_minutes": NUMBER_OR_NULL, "continuous": true/false, "job_name": "SHORT_NAME", "task_description": "WHAT_TO_DO"}

Rules:
- is_job=true ONLY if user explicitly asks to monitor/watch/track/observe something over time, OR explicitly asks to create a job/task/work
- duration_minutes: extract the EXACT number of minutes the user specified. "10 min" all = 10. If not specified = null
- interval_minutes: ONLY if user says "every N min". Otherwise = null
- continuous: true if NO explicit interval (user wants non-stop monitoring), false if interval specified
- job_name: 2-5 word short name of what to monitor
- task_description: the full task description (what to analyze/watch/check)
- If user just asks a question or wants regular chat = is_job: false

JSON:`;

        const classifyResp = await this.llm.chat(
          [{ role: 'user', content: classifyPrompt }],
          [],
          { maxTokens: 300, temperature: 0 }
        );

        const raw = classifyResp.content || '';
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');

        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const parsed = JSON.parse(raw.substring(jsonStart, jsonEnd + 1));

          if (parsed.is_job === true) {
            const durationMin = parsed.duration_minutes
              ? Math.max(1, Math.min(1440, Number(parsed.duration_minutes)))
              : 30;
            const isContinuous = parsed.interval_minutes ? false : true;
            const intervalMin = parsed.interval_minutes
              ? Math.max(1, Math.min(60, Number(parsed.interval_minutes)))
              : 3;
            const jobName = String(parsed.job_name || 'Monitoring Task').slice(0, 60);
            const jobPrompt = String(parsed.task_description || trimmed).slice(0, 5000);

            this.logger.info(`[auto-route] LLM classified JOB: name="${jobName}", duration=${durationMin}min, continuous=${isContinuous}`);


            const allTools = this.skills.getToolsForSkills(this.config.skills);
            const allToolNames = allTools.map(t => t.name);


            const DANGEROUS_TOOLS = new Set([
              'buy_token', 'sell_token', 'send_sol', 'send_token',
              'copy_execute_now',
              'create_background_job', 'cancel_background_job',
              'pump_buy', 'pump_sell', 'pump_create_token']);


            const SAFE_TEST_PARAMS: Record<string, Record<string, any>> = {
              twitter_feed_read: { limit: 1 },
              twitter_feed_stats: { period: 'all' },
              twitter_feed_analyze: { limit: 1 },
              fetch_tweet: {},
              list_tracked_wallets: {},
              get_wallet_activity: {},
              get_portfolio_summary: {},
              get_positions: {},
              pump_get_trending: { limit: 1 },
              pump_get_token_info: {},
              web_intel_check_status: {},
              security_check: {},
              job_list: {},
            };


            const toolListFormatted = allToolNames.map(n => {
              const t = allTools.find(x => x.name === n);
              return `- ${n}: ${(t?.description || '').slice(0, 80)}`;
            }).join('\n');

            const preflightPrompt = `You are planning a background job. Which tools will be needed to execute this task?

Available tools:
${toolListFormatted}

Task: "${jobPrompt.slice(0, 400)}"

Pick ONLY tools that are REQUIRED for this specific task. Be precise — don't pick trading tools for a monitoring job.
Reply ONLY with JSON: {"tools": ["tool_name_1", "tool_name_2"]}`;

            let neededTools: string[] = [];
            try {
              const pfResp = await this.llm.chat(
                [{ role: 'user', content: preflightPrompt }],
                [],
                { maxTokens: 300, temperature: 0 }
              );
              const pfRaw = pfResp.content || '';
              const pfS = pfRaw.indexOf('{');
              const pfE = pfRaw.lastIndexOf('}');
              if (pfS >= 0 && pfE > pfS) {
                const pfParsed = JSON.parse(pfRaw.substring(pfS, pfE + 1));
                const arr = pfParsed.tools || pfParsed.needed_tools;
                if (Array.isArray(arr)) {
                  neededTools = arr.filter((t: any) => typeof t === 'string' && allToolNames.includes(t));
                }
              }
            } catch (e: any) {
              this.logger.warn(`[preflight] LLM tool selection failed: ${e.message}`);
            }

            this.logger.info(`[preflight] Tools selected for "${jobName}": [${neededTools.join(', ')}]`);


            if (neededTools.length === 0) {
              const errResponse = `⚠️ **Failed to determine required tools for job "${jobName}".**\n\nPlease try again or clarify the task.`;
              this.conversationHistory.push({ role: 'user', content: userMessage });
              this.conversationHistory.push({ role: 'assistant', content: errResponse });
              this.logTranscript('assistant', errResponse);
              this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: errResponse, final: true });
              return errResponse;
            }


            const missingTools = neededTools.filter(t => !allToolNames.includes(t));


            const toolErrors: string[] = [];
            for (const toolName of neededTools) {
              if (DANGEROUS_TOOLS.has(toolName)) continue;
              if (missingTools.includes(toolName)) {
                toolErrors.push(`**${toolName}**: tool not found in system`);
                continue;
              }


              const testParams = SAFE_TEST_PARAMS[toolName] || {};


              if (toolName === 'fetch_tweet' || toolName === 'pump_get_token_info' ||
                  toolName === 'security_check' || toolName === 'get_wallet_activity' ||
                  toolName === 'browser_fetch' || toolName === 'browser_navigate' ||
                  toolName === 'browser_click' || toolName === 'browser_type' ||
                  toolName === 'browser_eval' || toolName === 'browser_set_value' ||
                  toolName === 'browser_select' || toolName === 'browser_wait_for' ||
                  toolName === 'browser_find_text' || toolName === 'browser_get_html' ||
                  toolName === 'browser_hover' || toolName === 'browser_click_xy' ||
                  toolName === 'browser_focus' || toolName === 'browser_key' ||
                  toolName === 'browser_network' ||
                  toolName === 'google_search' || toolName === 'web_search' ||
                  toolName === 'fetch_url' || toolName === 'deep_research' ||
                  toolName === 'rate_project' || toolName === 'analyze_token' ||
                  toolName === 'identify_address' || toolName === 'check_dev_wallet') {
                continue;
              }

              try {
                this.logger.info(`[preflight] Testing tool: ${toolName}`);
                const testResult = await this.skills.executeTool(toolName, testParams);


                if (testResult && typeof testResult === 'object' && testResult.error) {
                  const errMsg = String(testResult.error);
                  const hint = testResult.hint ? ` → ${testResult.hint}` : '';
                  toolErrors.push(`**${toolName}**: ${errMsg}${hint}`);
                }
              } catch (e: any) {
                toolErrors.push(`**${toolName}**: ${e.message}`);
              }
            }


            if (toolErrors.length > 0) {
              this.logger.warn(`[preflight] ${toolErrors.length} tool(s) had warnings (non-blocking): ${toolErrors.join('; ')}`);
            }

            this.logger.info(`[preflight] Proceeding with job creation (${neededTools.length} tools selected, ${toolErrors.length} warnings)`);
            this.conversationHistory.push({ role: 'user', content: userMessage });

            try {
              const result = await this.skills.executeTool('create_background_job', {
                name: jobName,
                prompt: jobPrompt,
                duration_minutes: durationMin,
                continuous: isContinuous,
                ...(isContinuous ? {} : { interval_minutes: intervalMin }),
              });

              const response = result?.success
                ? `✅ **Job created!**\n\n` +
                  `**Name:** ${result.name}\n` +
                  `**ID:** \`${result.job_id}\`\n` +
                  `**Mode:** ${result.schedule}\n` +
                  `**Start:** ${result.starts_at}\n` +
                  `**Expires:** ${result.expires_at}\n\n` +
                  (isContinuous
                    ? `Continuous monitoring for ${durationMin} min. Final report will be at the end.`
                    : `Execution logs will appear directly in chat.`)
                : `❌ Job creation error: ${result?.error || 'Unknown error'}`;

              this.conversationHistory.push({ role: 'assistant', content: response });
              this.logTranscript('assistant', response);
              this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: response, final: true });
              return response;
            } catch (err: any) {
              const errMsg = `❌ Failed to create job: ${err.message}`;
              this.conversationHistory.push({ role: 'assistant', content: errMsg });
              this.logTranscript('assistant', errMsg);
              this.eventBus.emit('agent:token' as any, { agentId: this.config.id, token: errMsg, final: true });
              return errMsg;
            }
          }
        }
      } catch (classifyErr: any) {
        this.logger.warn(`[auto-route] LLM classify failed: ${classifyErr.message}`);
      }
    }


    const quoteLines: string[] = [];
    const nonQuoteLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('> ')) {
        quoteLines.push(line.slice(2));
      } else {
        nonQuoteLines.push(line);
      }
    }
    const hasQuote = quoteLines.length > 0;
    const quotedText = quoteLines.join('\n').trim();
    const userText = nonQuoteLines.join('\n').trim();

    if (hasQuote) {
      contextParts.push(
        `[System: The user is QUOTING a part of YOUR previous response:\n` +
        `"${quotedText}"\n\n` +
        `The user's comment/question about that quote: "${userText || '(no additional text)'}"\n` +
        `Focus your answer on the specific quoted part. The user is referencing something you said earlier.]`
      );
    }

    const detectTarget = hasQuote ? userText : trimmed;
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(detectTarget);
    const containsAddress = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(detectTarget);
    const isRpcQuery = /\b(rpc|endpoint)\b/i.test(detectTarget);

    const tweetUrlMatch = trimmed.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([^\/\s]+)\/status\/(\d+)/i);
    const twitterProfileMatch = !tweetUrlMatch && trimmed.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([^\/\s?#]+)\/?(?:\s|$)/i);

    if (isSolanaAddress) {

      contextParts.push(
        `The user sent a Solana address: ${trimmed}\n\n` +
        `STEP 1: Call identify_address with address="${trimmed}" to determine if it's a wallet, token mint, token account, or program.\n` +
        `STEP 2: Based on the result:\n` +
        `  - If type="wallet" → call ALL of these: get_sol_balance, get_token_accounts, get_recent_transactions, AND search_tokens_by_creator (pump.fun created coins) + get_dev_profile (dev reputation). ALWAYS show which tokens this wallet has created.\n` +
        `  - If type="token_mint" → call analyze_token with mint="${trimmed}" (this already includes creator info, their other coins, and top holders), then security_check, check_holders. Also call get_market_activity and get_token_ath for trading stats. The analyze_token response contains creatorInfo and topHoldersInfo sections. To check dev wallet, use check_dev_wallet with the mint address — it auto-resolves to the creator wallet.\n` +
        `  - If type="token_account" → report the owner wallet and token mint from the result\n` +
        `  - If type="program" → describe what you know about this program\n` +
        `DO NOT assume it's a token. ALWAYS identify first.`
      );
    } else if (containsAddress && !isRpcQuery) {

      contextParts.push(
        userMessage + '\n\n' +
        `[System: The message contains a Solana address. Use identify_address first to determine its type before calling other tools. Adapt your tool chain based on the address type AND the user's question. ` +
        `IMPORTANT: If the user asks about a dev wallet / creator for a TOKEN MINT, use check_dev_wallet (it accepts token mints and auto-resolves to the creator wallet), or use analyze_token which returns creatorInfo. NEVER tell the user "this is a token not a wallet" — just resolve the dev wallet automatically. ` +
        `SOCIAL LINKS: When checking social links, ALWAYS pass the token mint to fetch_project_links — it resolves links from on-chain metadata. Do NOT use links from the user's message as the token's official social links. Token metadata is the source of truth.]`
      );
    } else if (isRpcQuery) {
      contextParts.push(userMessage + '\n\n[System hint: Use get_rpc_status tool to check current RPC configuration and connectivity.]');
    } else if (tweetUrlMatch) {

      const tweetUrl = tweetUrlMatch[0];
      const tweetAuthor = tweetUrlMatch[1];
      const tweetId = tweetUrlMatch[2];
      const extraText = trimmed.replace(tweetUrl, '').trim();
      this.logger.info(`[chat] Tweet URL detected: ${tweetUrl} (author: @${tweetAuthor}, id: ${tweetId}). Calling fetch_tweet directly...`);


      let tweetContent = '';
      try {
        const tweetData = await this.skills.executeTool('fetch_tweet', { url: tweetUrl });
        this.logger.info(`[chat] fetch_tweet result: ${tweetData?.error ? 'ERROR: ' + tweetData.error : 'OK, got data'}`);
        if (tweetData && !tweetData.error) {
          tweetContent = `\n\n--- FETCHED TWEET DATA ---\n${JSON.stringify(tweetData, null, 2)}\n--- END TWEET DATA ---`;
        } else {
          tweetContent = `\n\n[fetch_tweet returned error: ${tweetData?.error || 'unknown error'}. You still have the fetch_tweet tool available if you want to retry.]`;
        }
      } catch (err: any) {
        tweetContent = `\n\n[fetch_tweet call failed: ${err.message}. You still have the fetch_tweet tool available if you want to retry.]`;
      }

      contextParts.push(
        userMessage + '\n\n' +
        `[System: The user shared a tweet URL: ${tweetUrl} (author: @${tweetAuthor}, tweet ID: ${tweetId}).` +
        tweetContent + '\n' +
        `Analyze and present the tweet content to the user in a readable format. ` +
        (extraText ? `The user also said: "${extraText}" — address their question about the tweet. ` : '') +
        `If the tweet mentions any token/coin with a Solana address or ticker, offer to analyze it. ` +
        `If the tweet contains links to other tweets or projects, mention them.]`
      );
    } else if (twitterProfileMatch) {

      const profileUsername = twitterProfileMatch[1];
      if (!['home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings'].includes(profileUsername.toLowerCase())) {
        let profileContent = '';
        try {
          const profileData = await this.skills.executeTool('fetch_twitter_profile', { username: profileUsername });
          if (profileData && !profileData.error) {
            profileContent = `\n\n--- FETCHED PROFILE DATA ---\n${JSON.stringify(profileData, null, 2)}\n--- END PROFILE DATA ---`;
          } else {
            profileContent = `\n\n[fetch_twitter_profile returned error: ${profileData?.error || 'unknown error'}.]`;
          }
        } catch (err: any) {
          profileContent = `\n\n[fetch_twitter_profile call failed: ${err.message}.]`;
        }

        contextParts.push(
          userMessage + '\n\n' +
          `[System: The user shared a Twitter profile URL for @${profileUsername}.` +
          profileContent + '\n' +
          `Present the profile information and highlight any crypto/Solana-related activity from their recent tweets.]`
        );
      } else {
        contextParts.push(userMessage);
      }
    } else {
      contextParts.push(userMessage);
    }


    if (this.marketState) {
      const state = this.marketState.getState();

      const hasActivity = state.positions.length > 0 || state.recentTrades.length > 0 || (state.sessionStats?.tradesExecuted ?? 0) > 0;
      if (hasActivity) {
        contextParts.push('\n---\n[System: current market snapshot for reference only — prioritize answering the user\'s question]');
        contextParts.push(this.marketState.buildPromptContext());
      }
    }


    try {
      const addressMatch = trimmed.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      const searchQuery = addressMatch ? addressMatch[0] : trimmed.split(/\s+/).slice(0, 3).join(' ');
      if (searchQuery.length > 2) {
        const memories = await this.skills.executeTool('ai_memory_search', { query: searchQuery, limit: 5 });
        if (memories?.results?.length > 0) {
          const memoryContext = memories.results.map((m: any) =>
            `[${m.category}] ${m.subject ? m.subject + ': ' : ''}${m.content}`
          ).join('\n');
          contextParts.push(`\n---\n[AI Memory — past notes relevant to this query:]\n${memoryContext}`);
        }
      }
    } catch {  }


    const checkpoint = this.createCheckpoint();
    this.eventBus.emit('agent:checkpoint' as any, { agentId: this.config.id, ...checkpoint });

    return this.processLLMCycle('user_chat', this.clipContext(contextParts.join('\n')));
  }

  private buildContextMessage(action: string, data: any): string {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    const parts = [
      `Event: ${action}`,
      `Timestamp: ${new Date().toISOString()}`,
      `Data:\n${dataStr}`];

    if (this.config.autonomy === 'monitor') {
      parts.push('\nMODE: Monitor only. Analyze and report, do NOT execute trades.');
    } else if (this.config.autonomy === 'advisor') {
      parts.push('\nMODE: Advisory. Provide recommendations but do NOT execute trades automatically.');
    } else if (this.config.autonomy === 'autopilot') {
      parts.push('\nMODE: Autopilot. You may execute trades using available tools within your risk limits.');
    }

    return parts.join('\n');
  }

  private async executeToolCall(toolCall: LLMToolCall): Promise<any> {
    const { name, arguments: argsStr } = toolCall.function;

    try {
      const params = JSON.parse(argsStr);
      this.logger.debug(`Agent "${this.config.id}" calling tool: ${name}`, params);


      if (name === 'think') {
        const thought = (params.thought || params.reasoning || params.plan || '').slice(0, 2000);
        this.logger.info(`Agent "${this.config.id}" [think]: ${thought.slice(0, 120)}…`);
        return 'Thought recorded. Continue with your plan.';
      }


      if (name === 'get_tool_schema') {
        const toolName = params.tool_name || params.name || '';
        const details = this.skills.getToolDetails(toolName);
        if (details) {
          this.dynamicTools.add(toolName);

          const siblings = this.skills.getSiblingToolNames(toolName);
          for (const sib of siblings) this.dynamicTools.add(sib);
          const siblingNames = siblings.filter(s => s !== toolName);
          const result: any = { name: details.name, description: details.description, parameters: details.parameters };
          if (siblingNames.length > 0) {
            result._note = `Also loaded ${siblingNames.length} sibling tools from same skill: ${siblingNames.join(', ')}. You can call them directly now.`;
          }
          return result;
        }
        return { error: `Tool "${toolName}" not found. Use list_available_tools to see all tools.` };
      }


      if (name === 'list_available_tools') {
        if (this._toolCatalogReturned) {
          return '[STOP] Tool catalog was already returned earlier. Do NOT call list_available_tools again. Call tools directly: project_write, project_read, project_list, web_search, etc.';
        }
        this._toolCatalogReturned = true;
        const catalog = this.skills.getToolCatalog(this.config.skills);
        return catalog || 'No tools available.';
      }


      if (name === 'spawn_tasks') {
        const tasks: Array<{ id: string; goal: string; profile?: string }> = params.tasks || [];
        if (!tasks.length) return 'No tasks provided.';
        this.logger.info(`Agent "${this.config.id}" spawning ${tasks.length} multi-context subtasks`);

        const subtaskResults = await Promise.all(
          tasks.map(async (task) => {
            try {
              const profileName = task.profile && SUB_AGENT_PROFILES[task.profile] ? task.profile : 'generic';
              const profile = SUB_AGENT_PROFILES[profileName];


              const freshLlm = createLLMProvider(this.config.model);

              const subConfig: AgentConfig = {
                id: `${this.config.id}_sub_${task.id}`,
                name: `${this.config.name} → ${profileName}:${task.id}`,
                role: profile.role,
                model: this.config.model,
                skills: profile.skills,
                autonomy: 'autopilot',
                riskLimits: this.config.riskLimits,
              };

              const subAgent = new AgentRunner({
                config: subConfig,
                llm: freshLlm,
                skills: this.skills,
                eventBus: this.eventBus,
                logger: this.logger,
              });
              subAgent.setEfficiencyMode(profile.efficiencyMode);
              subAgent.promptMode = profile.promptMode;

              const result = await subAgent.runSubTask(task.goal);
              return `[${task.id}] (${profileName}): ${result.slice(0, 500)}`;
            } catch (err: any) {
              return `[${task.id}]: ERROR — ${err.message}`;
            }
          })
        );

        return subtaskResults.join('\n\n');
      }


      if (name === 'memory_read_topic' || name === 'memory_write_topic' ||
          name === 'memory_update_index' || name === 'memory_search_sessions' ||
          name === 'memory_list_topics' || name === 'memory_read_index' ||
          name === 'memory_list_sessions' || name === 'memory_delete_topic' ||
          name === 'memory_dream') {
        return this.structuredMemory.execute(name, params);
      }


      if (this.hooks.beforeToolCall) {
        const hookResult = await this.hooks.beforeToolCall(name, params);
        if (hookResult?.skip) return { skipped: true, reason: 'Hook skipped tool call' };
        if (hookResult?.params) Object.assign(params, hookResult.params);
      }

      const result = await this.skills.executeTool(name, params);


      if (this.hooks.afterToolCall) {
        const modified = await this.hooks.afterToolCall(name, params, result);
        if (modified !== undefined) return modified;
      }

      if (name.includes('buy') || name.includes('sell') || name.includes('swap')) {
        this.state.totalTrades++;
      }

      return result;
    } catch (err: any) {
      this.logger.error(`Tool "${name}" failed`, err);
      return { error: err.message || String(err) };
    }
  }

getMetaTools(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }> {
    return [
      {
        type: 'function',
        function: {
          name: 'think',
          description: 'Private scratchpad for reasoning. Never shown to user.',
          parameters: {
            type: 'object',
            properties: {
              thought: { type: 'string', description: 'Your reasoning or plan.' },
            },
            required: ['thought'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'spawn_tasks',
          description: 'Run subtasks in parallel, each in a FRESH context with its own conversation history. Use profiles: "researcher" (search only), "coder" (file operations), "tester" (run & verify), "generic" (both).',
          parameters: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                description: 'Independent tasks to run in parallel.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Short task ID.' },
                    goal: { type: 'string', description: 'What this subtask should accomplish. Include all needed context — sub-agent has NO access to parent conversation.' },
                    profile: { type: 'string', enum: ['researcher', 'coder', 'tester', 'generic'], description: 'Sub-agent role. Default: generic.' },
                  },
                  required: ['id', 'goal'],
                },
              },
            },
            required: ['tasks'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_tool_schema',
          description: 'Get full parameter schema for a tool. Call this before using a tool not in your current toolset.',
          parameters: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: 'Name of the tool to load.' },
            },
            required: ['tool_name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_available_tools',
          description: 'List all tools. Call ONCE only, then use get_tool_schema or call tools directly.',
          parameters: { type: 'object', properties: {} },
        },
      },

      {
        type: 'function',
        function: {
          name: 'memory_read_topic',
          description: 'Read a topic file from long-term memory. Use when MEMORY INDEX suggests a relevant topic.',
          parameters: {
            type: 'object',
            properties: {
              topic: { type: 'string', description: 'Topic filename (without .md). E.g. "serial-ruggers", "user-prefs"' },
            },
            required: ['topic'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_write_topic',
          description: 'Save knowledge to a topic file. Write here FIRST, then update index via memory_update_index. Include timestamps.',
          parameters: {
            type: 'object',
            properties: {
              topic: { type: 'string', description: 'Topic filename (without .md)' },
              content: { type: 'string', description: 'Content to write (markdown). Include timestamps for facts.' },
              mode: { type: 'string', enum: ['overwrite', 'append'], description: 'append (default) or overwrite' },
            },
            required: ['topic', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_update_index',
          description: 'Add/update a ≤150-char pointer in MEMORY.md index. ALWAYS call memory_write_topic FIRST.',
          parameters: {
            type: 'object',
            properties: {
              section: { type: 'string', description: 'Section: "Trading Patterns", "Dev Wallets", "Market Insights", "User Preferences", "Session History"' },
              entry: { type: 'string', description: 'Index line ≤150 chars. Format: [topic-name] summary' },
              oldEntry: { type: 'string', description: 'Old line to replace (omit for new entries)' },
            },
            required: ['section', 'entry'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_search_sessions',
          description: 'Search past session transcripts by keyword. Returns matching JSONL entries from conversation logs.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keyword (case-insensitive)' },
              limit: { type: 'number', description: 'Max results (default: 20)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'memory_list_topics',
          description: 'List all topic files in long-term memory with sizes and dates.',
          parameters: { type: 'object', properties: {} },
        },
      }];
  }

  private trimHistory(): void {
    const maxMessages = this.maxHistoryMessages;
    this.conversationHistory = this.conversationHistory.filter(m => m && m.role);
    if (this.conversationHistory.length > maxMessages) {
      const system = this.conversationHistory[0];
      const dropped = this.conversationHistory.slice(1, -(maxMessages - 2));
      let kept = this.conversationHistory.slice(-(maxMessages - 2));

      while (kept.length > 0 && kept[0].role === 'tool') {
        kept.shift();
      }


      const droppedToolCalls = dropped.filter(m => m.role === 'assistant' && m.toolCalls?.length);
      const toolSummary = droppedToolCalls.flatMap(m => m.toolCalls!.map(tc => tc.function.name));
      const uniqueTools = [...new Set(toolSummary)];
      const summaryMsg = {
        role: 'user' as const,
        content: `[Context trimmed: ${dropped.length} older messages removed. Tools previously used: ${uniqueTools.slice(0, 10).join(', ') || 'none'}. Continue from current state.]`,
      };


      const totalKept = kept.length;

      const fullText = kept.map(m => m.content || '').join('');
      const tokenMul = this.estimateTokenMultiplier(fullText);

      const effectiveSoftTrim = Math.floor(this.softTrimChars / tokenMul);
      kept = kept.map((msg, idx) => {
        if (msg.role === 'tool' && msg.content) {
          const age = totalKept - idx;


          if (age > this.hardClearRounds && msg.content.length > 200) {
            return { ...msg, content: '[Old tool result cleared — see context summary above]' };
          }


          if (msg.content.length > effectiveSoftTrim) {
            const limit = effectiveSoftTrim;
            const headSize = Math.floor(limit * 0.45);
            const tailSize = Math.floor(limit * 0.45);
            return { ...msg, content: msg.content.slice(0, headSize) + '\n...[trimmed]...\n' + msg.content.slice(-tailSize) };
          }
        }

        if (msg.role === 'user' && msg.content && msg.content.startsWith('[') && msg.content.length > 150) {
          return { ...msg, content: msg.content.slice(0, 100) + '...]' };
        }

        if (msg.role === 'assistant' && (!msg.content || msg.content.trim() === '') && !msg.toolCalls?.length) {
          return { ...msg, content: '' };
        }
        return msg;
      });
      this.conversationHistory = [system, summaryMsg, ...kept];
    }
  }

private emergencyContextPrune(): void {

    this.conversationHistory = this.conversationHistory.filter(m => m && m.role);
    const MAX_ESTIMATED_TOKENS = 80_000;
    const estimateTokens = () => {
      let tokens = 0;
      for (const m of this.conversationHistory) {
        const len = m.content?.length || 0;

        const mul = this.estimateTokenMultiplier(m.content || '');
        tokens += Math.ceil(len * mul / 4);

        if (m.toolCalls?.length) tokens += m.toolCalls.length * 50;
      }
      return tokens;
    };

    const estTokens = estimateTokens();
    if (estTokens <= MAX_ESTIMATED_TOKENS) return;

    this.logger.warn(`Agent "${this.config.id}" emergency prune: ~${estTokens} estimated tokens exceeds ${MAX_ESTIMATED_TOKENS} ceiling`);


    const safeZone = 6;
    for (let i = 0; i < this.conversationHistory.length - safeZone; i++) {
      const msg = this.conversationHistory[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > 300) {
        this.conversationHistory[i] = { ...msg, content: msg.content.slice(0, 150) + '\n[emergency-trimmed]' };
      }

      if (msg.role === 'user' && msg.content && msg.content.length > 500 && msg.content.startsWith('[')) {
        this.conversationHistory[i] = { ...msg, content: msg.content.slice(0, 200) + '...]' };
      }
    }

    if (estimateTokens() <= MAX_ESTIMATED_TOKENS) return;


    const keepLast = Math.max(6, Math.floor(this.conversationHistory.length * 0.25));
    const system = this.conversationHistory[0];
    const recent = this.conversationHistory.slice(-keepLast);

    while (recent.length > 0 && (recent[0].role === 'tool' || (recent[0].role === 'assistant' && recent.length > 1 && recent[1]?.role !== 'user'))) {
      recent.shift();
    }

    if (recent.length > 0 && recent[0].role === 'assistant') recent.shift();
    const summaryNote: LLMMessage = {
      role: 'user' as const,
      content: `[Emergency context prune: older messages dropped to fit context window. Continue from current state.]`,
    };
    this.conversationHistory = [system, summaryNote, ...recent];


    if (estimateTokens() > MAX_ESTIMATED_TOKENS) {
      for (let i = 0; i < this.conversationHistory.length - 4; i++) {
        const msg = this.conversationHistory[i];
        if (msg.role === 'tool' && msg.content && msg.content.length > 100) {
          this.conversationHistory[i] = { ...msg, content: '[pruned]' };
        }
      }
    }

    this.logger.warn(`Agent "${this.config.id}" emergency prune complete: ~${estimateTokens()} tokens, ${this.conversationHistory.length} messages`);
  }

private reactiveContextPrune(realPromptTokens: number): void {

    this.conversationHistory = this.conversationHistory.filter(m => m && m.role);


    const TARGET_PROMPT_TOKENS = 50_000;
    const overheadTokens = 8_000;
    const historyBudgetTokens = TARGET_PROMPT_TOKENS - overheadTokens;
    const historyBudgetChars = historyBudgetTokens * 4;

    const totalChars = () => this.conversationHistory.reduce((sum, m) => {
      let chars = m.content?.length || 0;

      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          chars += (tc.function.arguments || '').length;
        }
      }
      return sum + chars;
    }, 0);

    this.logger.warn(`Agent "${this.config.id}" reactive prune: real=${realPromptTokens} tokens, history=${totalChars()} chars, target=${historyBudgetChars} chars`);


    const safeZone = 4;
    for (let i = 1; i < this.conversationHistory.length - safeZone; i++) {
      const msg = this.conversationHistory[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > 200) {
        this.conversationHistory[i] = { ...msg, content: msg.content.slice(0, 100) + '\n[trimmed]' };
      }
      if (msg.role === 'user' && msg.content && msg.content.length > 300 && msg.content.startsWith('[')) {
        this.conversationHistory[i] = { ...msg, content: msg.content.slice(0, 150) + '...]' };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        this.conversationHistory[i] = {
          ...msg,
          toolCalls: msg.toolCalls.map(tc => ({
            ...tc,
            function: {
              ...tc.function,
              arguments: tc.function.arguments && tc.function.arguments.length > 200
                ? tc.function.arguments.slice(0, 150) + '...}'
                : tc.function.arguments,
            },
          })),
        };
      }
    }

    if (totalChars() <= historyBudgetChars) return;


    const keepLast = Math.min(8, Math.max(4, Math.floor(this.conversationHistory.length * 0.2)));
    const system = this.conversationHistory[0];
    const recent = this.conversationHistory.slice(-keepLast);
    while (recent.length > 0 && recent[0].role === 'tool') recent.shift();
    this.conversationHistory = [
      system,
      { role: 'user' as const, content: '[Context pruned to fit token budget. Continue from current state.]' },
      ...recent];

    if (totalChars() <= historyBudgetChars) return;


    const last2 = this.conversationHistory.slice(-2);
    while (last2.length > 0 && last2[0].role === 'tool') last2.shift();
    this.conversationHistory = [
      system,
      { role: 'user' as const, content: '[Context fully pruned. Previous work completed. Continue with next step.]' },
      ...last2];

    this.logger.warn(`Agent "${this.config.id}" reactive prune done: ${totalChars()} chars, ${this.conversationHistory.length} messages`);
  }


async compactHistoryIfNeeded(): Promise<boolean> {
    if (this.isCompacting) return false;
    const threshold = Math.floor(this.maxHistoryMessages * 0.85);
    if (this.conversationHistory.length <= threshold) return false;


    const currentMsgCount = this.state.totalDecisions + this.conversationHistory.length;
    if (currentMsgCount - this.lastCompactionRound < 25) return false;
    this.lastCompactionRound = currentMsgCount;

    this.isCompacting = true;
    try {
      const keepRecent = Math.floor(this.maxHistoryMessages * 0.5);
      const system = this.conversationHistory[0];
      const toCompact = this.conversationHistory.slice(1, -keepRecent);
      const recent = this.conversationHistory.slice(-keepRecent);

      if (toCompact.length < 4) return false;


      await this.preCompactionMemoryFlush(toCompact);


      if (this.hooks.beforeCompaction) {
        await this.hooks.beforeCompaction(toCompact);
      }


      const conversationText = toCompact.filter(m => m && m.role)
        .map(m => {
          const prefix = m.role === 'tool' ? '[tool_result]' : `[${m.role}]`;
          const body = (m.content || '').slice(0, 1200);
          const toolInfo = m.toolCalls?.length ? ` (called: ${m.toolCalls.map(tc => tc.function.name).join(', ')})` : '';
          return `${prefix}${toolInfo}: ${body}`;
        })
        .join('\n');


      const prevSummary = this.compactionSummary ? `\nPrevious summary to incorporate:\n${this.compactionSummary}` : '';
      const summaryMessages: LLMMessage[] = [
        {
          role: 'system',
          content: 'You are a context summarizer. Condense the conversation history into a structured factual recap. Use this format:\nDONE: (files created/modified with full paths, commands run and their result, fixes applied)\nREMAINING: (tasks not yet started, pending fixes, next steps)\nERRORS: (specific errors encountered, whether fixed or still open)\nCONTEXT: (Solana addresses, URLs, tokens, key decisions)\nIntegrate any previous summary. Max 2000 chars. No opinions, just facts.',
        },
        {
          role: 'user',
          content: `Summarize this conversation (focus on what was DONE vs what REMAINS):\n${conversationText.slice(0, 24000)}${prevSummary}`,
        }];

      try {

        const COMPACTION_TIMEOUT_MS = 60_000;
        const summaryResponse = await Promise.race([
          this.llm.chat(summaryMessages, [], { maxTokens: 1600, temperature: 0.1 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Compaction LLM call timed out after 60s')), COMPACTION_TIMEOUT_MS)
          )]);
        let summary = (summaryResponse.content || '').slice(0, 2000);


        if (summary.length < 80) {
          const toolNames = toCompact
            .filter(m => m.role === 'assistant' && m.toolCalls?.length)
            .flatMap(m => m.toolCalls!.map(tc => tc.function.name));
          const uniqueTools = [...new Set(toolNames)].slice(0, 8);
          const addresses = (conversationText.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []).slice(0, 3);
          summary = `Compacted ${toCompact.length} msgs. Tools: ${uniqueTools.join(', ') || 'none'}. Addresses: ${addresses.join(', ') || 'none'}. ${summary}`.slice(0, 2000);
          this.logger.warn(`Agent "${this.config.id}" compaction LLM returned short summary (${summaryResponse.content?.length || 0} chars), using mechanical fallback`);
        }

        this.compactionSummary = summary;

        const compactMsg: LLMMessage = {
          role: 'user',
          content: `[Compacted context — ${toCompact.length} messages summarized:]\n${summary}`,
        };


        while (recent.length > 0 && recent[0].role === 'tool') {
          recent.shift();
        }

        this.conversationHistory = [system, compactMsg, ...recent];


        if (this.hooks.afterCompaction) {
          await this.hooks.afterCompaction(summary);
        }

        this.logger.info(`Agent "${this.config.id}" compacted ${toCompact.length} messages into LLM summary`);
        this.eventBus.emit('agent:compaction' as any, {
          agentId: this.config.id,
          droppedCount: toCompact.length,
          summaryLength: summary.length,
        });
        return true;
      } catch (err: any) {
        this.logger.warn(`Agent "${this.config.id}" compaction LLM call failed: ${err.message} — falling back to basic trim`);
        return false;
      }
    } finally {
      this.isCompacting = false;
    }
  }

async compactNow(): Promise<string> {
    if (this.conversationHistory.length < 4) {
      return 'Nothing to compact — history is too short.';
    }
    this.isCompacting = false;
    const keepRecent = Math.min(6, Math.floor(this.conversationHistory.length * 0.3));
    const system = this.conversationHistory[0];
    const toCompact = this.conversationHistory.slice(1, -keepRecent);
    const recent = this.conversationHistory.slice(-keepRecent);

    if (toCompact.length < 2) return 'Nothing to compact.';

    await this.preCompactionMemoryFlush(toCompact);

    const conversationText = toCompact.filter(m => m && m.role)
      .map(m => {
        const prefix = m.role === 'tool' ? '[tool]' : `[${m.role}]`;
        return `${prefix}: ${(m.content || '').slice(0, 200)}`;
      })
      .join('\n');

    try {
      const resp = await this.llm.chat(
        [
          { role: 'system', content: 'Condense this conversation into a dense factual recap (max 600 chars). Include addresses, decisions, errors, task state.' },
          { role: 'user', content: conversationText.slice(0, 4000) }] as LLMMessage[],
        [],
        { maxTokens: 400, temperature: 0.1 },
      );

      const summary = (resp.content || 'Compacted.').slice(0, 800);
      while (recent.length > 0 && recent[0].role === 'tool') recent.shift();
      this.conversationHistory = [
        system,
        { role: 'user', content: `[Compacted context — ${toCompact.length} msgs:]\n${summary}` },
        ...recent];
      this.compactionSummary = summary;
      this.logger.info(`Agent "${this.config.id}" manual compaction: ${toCompact.length} messages → summary`);
      return `✅ Compacted ${toCompact.length} messages. History: ${this.conversationHistory.length} items.`;
    } catch (err: any) {
      this.logger.error(`Manual compaction failed: ${err.message}`);

      this.trimHistory();
      return `⚠️ LLM compaction failed (${err.message}). Used basic trim instead.`;
    }
  }

private async preCompactionMemoryFlush(messages: LLMMessage[]): Promise<void> {
    try {
      const allContent = messages.map(m => m.content || '').join('\n');


      const addresses = [...new Set((allContent.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || []))];

      const toolCalls = messages
        .filter(m => m.role === 'assistant' && m.toolCalls?.length)
        .flatMap(m => m.toolCalls!.map(tc => tc.function.name));
      const uniqueTools = [...new Set(toolCalls)];

      const errors = messages
        .filter(m => m.role === 'tool' && m.content?.toLowerCase().includes('error'))
        .map(m => (m.content || '').slice(0, 100));


      const filePaths: string[] = [];
      for (const m of messages) {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          for (const tc of m.toolCalls!) {
            const name = tc.function.name;
            if (name === 'project_write' || name === 'project_edit' || name === 'project_create') {
              try {
                const rawArgs = tc.function.arguments;
                const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
                if (args?.path) filePaths.push(args.path);
                if (args?.filePath) filePaths.push(args.filePath);
              } catch {

                const rawStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : '';
                const pathMatch = rawStr.match(/["'](?:path|filePath)["']\s*:\s*["']([^"']+)["']/);
                if (pathMatch?.[1]) filePaths.push(pathMatch[1]);
              }
            }
          }
        }
      }
      const uniqueFiles = [...new Set(filePaths)];

      if (addresses.length > 0 || uniqueTools.length > 0 || uniqueFiles.length > 0) {
        const flushParts: string[] = [];
        if (addresses.length > 0) flushParts.push(`Addresses: ${addresses.slice(0, 8).join(', ')}`);
        if (uniqueTools.length > 0) flushParts.push(`Tools: ${uniqueTools.join(', ')}`);
        if (uniqueFiles.length > 0) flushParts.push(`Files created/modified: ${uniqueFiles.slice(0, 20).join(', ')}`);
        if (errors.length > 0) flushParts.push(`Errors: ${errors.slice(0, 3).join('; ')}`);

        await this.skills.executeTool('ai_memory_save', {
          category: 'context_compaction',
          content: flushParts.join('\n'),
          subject: `Compaction ${new Date().toISOString().slice(0, 16)}`,
        });
      }


      try {
        await this.structuredMemory.execute('memory_dream', { dryRun: false });
      } catch {  }
    } catch {  }
  }

private bootstrapMtimes: Record<string, number> = {};

  private loadBootstrapFiles(): void {
    const bootstrapFiles = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'CONTEXT.md', 'PROJECT.md'];
    const parts: string[] = [];
    const maxPerFile = 15000;
    const maxTotal = 40000;
    let totalChars = 0;


    try {
      const memoryIndexPath = pathMod.join(process.cwd(), 'data', 'memory', 'MEMORY.md');
      if (fsMod.existsSync(memoryIndexPath)) {
        const stat = fsMod.statSync(memoryIndexPath);
        const mtime = stat.mtimeMs;
        if (this.bootstrapMtimes['MEMORY.md'] !== mtime) {
          this.bootstrapMtimes['MEMORY.md'] = mtime;
        }
        let content = fsMod.readFileSync(memoryIndexPath, 'utf-8');

        if (content.length > 5000) content = content.slice(0, 5000) + '\n[Memory index truncated]';
        if (content.trim().length > 50) {
          parts.push(`--- MEMORY INDEX (always loaded) ---\n${content}\n\nTo load details: call memory_read_topic(topic_name). To save: memory_write_topic first, then memory_update_index.`);
          totalChars += content.length + 120;
          this.logger.info(`MEMORY.md loaded into prompt (${content.length} chars)`);
        }
      }
    } catch {  }
    let changed = false;

    for (const fileName of bootstrapFiles) {
      try {
        const filePath = pathMod.join(process.cwd(), fileName);
        if (fsMod.existsSync(filePath)) {
          const stat = fsMod.statSync(filePath);
          const mtime = stat.mtimeMs;
          if (this.bootstrapMtimes[fileName] !== mtime) {
            changed = true;
            this.bootstrapMtimes[fileName] = mtime;
          }
          let content = fsMod.readFileSync(filePath, 'utf-8');
          if (content.length > maxPerFile) content = content.slice(0, maxPerFile) + '\n[Truncated]';
          if (totalChars + content.length > maxTotal) break;
          parts.push(`--- ${fileName} ---\n${content}`);
          totalChars += content.length;
          this.logger.info(`Bootstrap file loaded: ${fileName} (${content.length} chars)`);
        }
      } catch {  }
    }


    if (changed || this.bootstrapContent === null) {
      this.bootstrapContent = parts.length > 0 ? parts.join('\n\n') : null;
    }
  }

setHooks(hooks: AgentHooks): void {
    this.hooks = hooks;
  }

setPromptMode(mode: 'full' | 'minimal' | 'none'): void {
    this.promptMode = mode;
    this.rebuildSystemPrompt();
  }


createCheckpoint(): { id: number; timestamp: number; messageCount: number; preview: string } {
    const lastUserMsg = [...this.conversationHistory]
      .reverse()
      .find(m => m.role === 'user');
    const preview = lastUserMsg
      ? (lastUserMsg.content || '').slice(0, 80)
      : `Checkpoint #${this.nextCheckpointId}`;

    const cp = {
      id: this.nextCheckpointId++,
      timestamp: Date.now(),
      messageCount: this.conversationHistory.length,
      preview,
      history: this.conversationHistory.filter(m => m && m.role).map(m => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ? JSON.parse(JSON.stringify(m.toolCalls)) : undefined,
        toolCallId: m.toolCallId,
      })),
      compactionSummary: this.compactionSummary,
    };
    this.checkpoints.push(cp);


    if (this.checkpoints.length > 50) this.checkpoints.shift();

    this.logger.info(`Checkpoint #${cp.id} created (${cp.messageCount} messages)`);
    return { id: cp.id, timestamp: cp.timestamp, messageCount: cp.messageCount, preview: cp.preview };
  }

getCheckpoints(): Array<{ id: number; timestamp: number; messageCount: number; preview: string }> {
    return this.checkpoints.map(cp => ({
      id: cp.id,
      timestamp: cp.timestamp,
      messageCount: cp.messageCount,
      preview: cp.preview,
    }));
  }

restoreCheckpoint(checkpointId: number): { ok: boolean; messageCount: number; removedMessages: number } {
    const cpIdx = this.checkpoints.findIndex(cp => cp.id === checkpointId);
    if (cpIdx === -1) return { ok: false, messageCount: 0, removedMessages: 0 };

    const cp = this.checkpoints[cpIdx];
    const removedMessages = this.conversationHistory.length - cp.messageCount;


    this.conversationHistory = cp.history.map(m => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.parse(JSON.stringify(m.toolCalls)) : undefined,
      toolCallId: m.toolCallId,
    }));
    this.compactionSummary = cp.compactionSummary;


    this.checkpoints = this.checkpoints.slice(0, cpIdx + 1);

    this.saveSession();
    this.logger.info(`Restored to checkpoint #${cp.id} (${cp.messageCount} messages, removed ${removedMessages})`);
    return { ok: true, messageCount: cp.messageCount, removedMessages };
  }

getHistoryLength(): number {
    return this.conversationHistory.length;
  }

getCompactionSummary(): string | null {
    return this.compactionSummary;
  }

getPromptMode(): string {
    return this.promptMode;
  }

getContextBudget(): { historyChars: number; maxChars: number; pct: number; maxMessages: number; compactionThreshold: number; contextWindowTokens: number } {
    const historyChars = this.conversationHistory.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    return {
      historyChars,
      maxChars: this.maxContextChars,
      pct: Math.min(100, Math.round((this.conversationHistory.length / this.maxHistoryMessages) * 100)),
      maxMessages: this.maxHistoryMessages,
      compactionThreshold: Math.floor(this.maxHistoryMessages * 0.7),
      contextWindowTokens: this.getContextWindowTokens(),
    };
  }


  private static readonly SESSIONS_DIR = pathMod.join(process.cwd(), 'data', 'sessions');

saveSession(): void {
    try {
      if (!fsMod.existsSync(AgentRunner.SESSIONS_DIR)) {
        fsMod.mkdirSync(AgentRunner.SESSIONS_DIR, { recursive: true });
      }
      const filePath = pathMod.join(AgentRunner.SESSIONS_DIR, `${this.config.id}.jsonl`);
      const meta = {
        _meta: true,
        agentId: this.config.id,
        compactionSummary: this.compactionSummary,
        savedAt: Date.now(),
        messageCount: this.conversationHistory.length,
      };
      const lines = [JSON.stringify(meta)];
      for (const msg of this.conversationHistory) {
        if (!msg || !msg.role) continue;

        if (msg.role === 'system' && this.conversationHistory.indexOf(msg) === 0) continue;
        lines.push(JSON.stringify({
          role: msg.role,
          content: msg.content || '',
          toolCalls: msg.toolCalls || undefined,
          toolCallId: msg.toolCallId || undefined,
        }));
      }
      fsMod.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
      this.logger.info(`Agent "${this.config.id}" session saved (${this.conversationHistory.length} messages)`);
    } catch (err: any) {
      this.logger.warn(`Failed to save session for "${this.config.id}": ${err.message}`);
    }
  }

loadSession(): boolean {
    try {
      const filePath = pathMod.join(AgentRunner.SESSIONS_DIR, `${this.config.id}.jsonl`);
      if (!fsMod.existsSync(filePath)) return false;

      const raw = fsMod.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return false;

      const lines = raw.split('\n').filter(l => l.trim());
      const parsed: any[] = [];
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch {  }
      }
      if (parsed.length < 2) return false;


      const meta = parsed[0];
      if (!meta?._meta) return false;


      if (meta.savedAt && Date.now() - meta.savedAt > 24 * 60 * 60 * 1000) {
        this.logger.info(`Agent "${this.config.id}" session too old (>24h), starting fresh`);
        return false;
      }


      if (meta.compactionSummary) {
        this.compactionSummary = meta.compactionSummary;
      }


      const system = this.conversationHistory[0];
      const messages: LLMMessage[] = [system];
      for (let i = 1; i < parsed.length; i++) {
        const m = parsed[i];
        if (!m.role) continue;
        messages.push({
          role: m.role,
          content: m.content || '',
          toolCalls: m.toolCalls,
          toolCallId: m.toolCallId,
        });
      }


      const idMap = new Map<string, string>();
      let idSeq = 0;
      const capId = (id: string | undefined): string | undefined => {
        if (!id || id.length <= 40) return id;
        if (idMap.has(id)) return idMap.get(id)!;
        const short = `tc_${idSeq++}_${id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}`;
        idMap.set(id, short);
        return short;
      };
      for (const m of messages) {
        if (m.toolCallId) m.toolCallId = capId(m.toolCallId);
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            if (tc.id) tc.id = capId(tc.id) || tc.id;
          }
        }
      }

      this.conversationHistory = messages;
      this.logger.info(`Agent "${this.config.id}" session restored (${messages.length} messages, compaction: ${!!this.compactionSummary})`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to load session for "${this.config.id}": ${err.message}`);
      return false;
    }
  }

clearSession(): void {
    try {
      const filePath = pathMod.join(AgentRunner.SESSIONS_DIR, `${this.config.id}.jsonl`);
      if (fsMod.existsSync(filePath)) {
        fsMod.unlinkSync(filePath);
      }
      this.compactionSummary = null;
      this._sessionLogFile = null;
      this.conversationHistory = [{
        role: 'system',
        content: this.compactSystemPrompt(this.config.role),
      }];
      this.logger.info(`Agent "${this.config.id}" session cleared`);
    } catch {  }
  }
}
