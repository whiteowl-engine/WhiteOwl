import {
  AgentConfig,
  AgentState,
  LLMMessage,
  LLMProvider,
  LLMToolCall,
  LoggerInterface,
  EventBusInterface,
  AutonomyLevel,
} from '../types';
import { SkillLoader } from './skill-loader';
import { MarketStateBuilder } from './market-state';

interface AgentRunnerOpts {
  config: AgentConfig;
  llm: LLMProvider;
  skills: SkillLoader;
  eventBus: EventBusInterface;
  logger: LoggerInterface;
  marketState?: MarketStateBuilder;
}

type EfficiencyMode = 'economy' | 'balanced' | 'max';

/**
 * AgentRunner — Two-mode AI agent.
 *
 * Mode 1 (Event-driven): Reacts to individual events via triggers.
 *   - Used for position management and signal review.
 *   - Events queue while AI is thinking; processed on next cycle.
 *
 * Mode 2 (Periodic/Commander): Gets market state briefings on interval.
 *   - Used for strategic decisions (adjust pipeline, portfolio review).
 *   - AI sees a compact snapshot of all activity, not individual events.
 *   - Interval configurable (default 5s for fast, 15s for smart).
 *
 * Both modes: Events that arrive while AI is busy are queued (max 20)
 * and batched into the next decision cycle. This prevents blocking
 * and ensures no events are lost.
 */
export class AgentRunner {
  private config: AgentConfig;
  private llm: LLMProvider;
  private skills: SkillLoader;
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private marketState: MarketStateBuilder | null;
  private conversationHistory: LLMMessage[] = [];
  private state: AgentState;
  private running = false;
  private _pendingImage?: string; // base64 image for next LLM call
  private efficiencyMode: EfficiencyMode = 'balanced';
  private llmMaxTokens: number = 3200;
  private maxRounds: number = 14;
  private maxHistoryMessages: number = 44;
  private toolResultCharLimit: number = 4000;
  private maxContextChars: number = 22000;

  // Event queue for batching
  private eventQueue: Array<{ action: string; data: any; timestamp: number }> = [];
  private maxQueue = 20;

  // Periodic mode
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private periodicIntervalMs: number;

  constructor(opts: AgentRunnerOpts) {
    this.config = opts.config;
    this.llm = opts.llm;
    this.skills = opts.skills;
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.marketState = opts.marketState || null;
    this.efficiencyMode = this.resolveEfficiencyMode();
    this.applyEfficiencyTuning();

    // Agents with periodic_interval trigger property run in periodic mode
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
    const raw = String(process.env.AI_EFFICIENCY_MODE || 'economy').toLowerCase();
    if (raw === 'economy') return 'economy';
    if (raw === 'max' || raw === 'max-capability') return 'max';
    return 'balanced';
  }

  private applyEfficiencyTuning(): void {
    if (this.efficiencyMode === 'economy') {
      this.maxQueue = 10;
      this.llmMaxTokens = 1600;
      this.maxRounds = 8;
      this.maxHistoryMessages = 26;
      this.toolResultCharLimit = 1800;
      this.maxContextChars = 12000;
      return;
    }
    if (this.efficiencyMode === 'max') {
      this.maxQueue = 30;
      this.llmMaxTokens = 6000;
      this.maxRounds = 25;
      this.maxHistoryMessages = 80;
      this.toolResultCharLimit = 8000;
      this.maxContextChars = 42000;
      return;
    }
    this.maxQueue = 20;
    this.llmMaxTokens = 3200;
    this.maxRounds = 14;
    this.maxHistoryMessages = 44;
    this.toolResultCharLimit = 4000;
    this.maxContextChars = 22000;
  }

  private compactSystemPrompt(prompt: string): string {
    const normalized = prompt
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.trimEnd())
      .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
      .join('\n')
      .trim();
    const cap = this.efficiencyMode === 'economy' ? 6000 : this.efficiencyMode === 'balanced' ? 12000 : 20000;
    if (normalized.length <= cap) return normalized;
    return normalized.slice(0, cap) + '\n\n[Prompt trimmed for token efficiency]';
  }

  private clipContext(text: string): string {
    if (text.length <= this.maxContextChars) return text;
    return text.slice(0, this.maxContextChars) + '\n\n[Context trimmed for token efficiency]';
  }

  private getLLMOptions(action: string): Record<string, any> {
    const isChat = action === 'user_chat';
    return {
      temperature: isChat ? 0.35 : 0.25,
      maxTokens: this.llmMaxTokens,
    };
  }

  getState(): AgentState {
    return { ...this.state };
  }

  /** Hot-swap the LLM provider (e.g. when user changes the model). */
  setLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

  getModelConfig(): { provider: string; model: string } {
    return { provider: this.config.model.provider, model: this.config.model.model };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.state.status = 'idle';
    this.bindTriggers();

    // Start periodic mode if configured
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
      if (trigger.event === 'periodic') continue; // Handled by timer

      this.eventBus.on(trigger.event as any, (data: any) => {
        if (!this.running || this.state.status === 'paused') return;
        if (this.state.cooldownUntil && Date.now() < this.state.cooldownUntil) return;

        // If AI is busy, queue the event for next cycle
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

  /**
   * Periodic decision cycle — the "commander" mode.
   * AI receives full market state + any queued events.
   */
  private async runPeriodicCycle(): Promise<void> {
    if (this.state.status === 'thinking' || this.state.status === 'executing') return;
    if (!this.marketState) return;

    const contextParts: string[] = [];

    // Full market state
    contextParts.push(this.marketState.buildPromptContext());

    // Drain queued events into this cycle
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

    contextParts.push('\nBased on the current market state, decide what actions to take. You can adjust the pipeline (sniper_config), manage positions (sell_token), blacklist devs (sniper_blacklist), or simply observe. Be concise.');

    await this.processLLMCycle('periodic_review', this.clipContext(contextParts.join('\n')));
  }

  async handleEvent(action: string, data: any): Promise<string> {
    if (this.state.status === 'thinking' || this.state.status === 'executing') {
      // Queue event for next cycle
      if (this.eventQueue.length < this.maxQueue) {
        this.eventQueue.push({ action, data, timestamp: Date.now() });
      }
      return '';
    }

    const contextParts: string[] = [];

    // Include market state if available (gives AI full picture)
    if (this.marketState) {
      contextParts.push(this.marketState.buildPromptContext());
      contextParts.push('');
    }

    contextParts.push(this.buildContextMessage(action, data));

    // Append any queued events
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

  /**
   * Smart tool selector — picks the most relevant tools for the current context,
   * staying within LLM provider limits (e.g. Copilot max 128 tools).
   */
  private selectRelevantTools(
    allTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }>,
    context: string,
  ): typeof allTools {
    if (allTools.length <= AgentRunner.MAX_TOOLS) return allTools;

    const ctx = context.toLowerCase();

    // Build tool→skill mapping
    const toolSkillMap = new Map<string, string>();
    for (const skillName of this.config.skills) {
      const defs = this.skills.getToolsForSkills([skillName]);
      for (const d of defs) toolSkillMap.set(d.name, skillName);
    }

    // Skill relevance scoring based on message keywords
    const keywordMap: Record<string, string[]> = {
      'blockchain': ['rpc', 'рпс', 'рпц', 'balance', 'баланс', 'transaction', 'транзакци', 'account', 'аккаунт', 'supply', 'on-chain', 'ончейн', 'нод', 'endpoint', 'блокчейн', 'кошел', 'wallet', 'identify', 'address', 'адрес', 'created', 'создал', 'создан', 'launched', 'deployed'],
      'token-analyzer': ['analyz', 'анализ', 'token', 'токен', 'rug', 'score', 'holder', 'dev wallet', 'trending', 'tweet', 'твит', 'x.com', 'twitter.com', 'fetch_tweet'],
      'token-security': ['security', 'безопасн', 'authority', 'lp lock', 'freeze'],
      'pump-trader': ['buy', 'sell', 'куп', 'прод', 'trade', 'swap', 'quote', 'fast_buy'],
      'advanced-trader': ['dca', 'trailing', 'grid', 'graduation', 'scale'],
      'portfolio': ['portfolio', 'портфел', 'position', 'позиц', 'history', 'истор', 'pnl', 'report'],
      'wallet-tracker': ['track', 'трек', 'follow', 'watch wallet'],
      'social-monitor': ['social', 'sentiment', 'kol'],
      'pump-monitor': ['pump', 'new token', 'новы', 'monitor', 'creator', 'создал', 'создатель', 'dev', 'profile', 'launched'],
      'fast-sniper': ['sniper', 'снайпер', 'pipeline', 'filter'],
      'dex-screener': ['dex', 'pair', 'liquidity', 'ликвидн', 'price', 'цен'],
      'curve-analyzer': ['curve', 'bonding', 'graduating'],
      'holder-intelligence': ['holder', 'холдер', 'whale', 'кит', 'insider', 'smart money'],
      'volume-detector': ['volume', 'объем', 'wash', 'organic'],
      'trend-sniper': ['trend', 'тренд', 'narrative', 'нарратив'],
      'alpha-scanner': ['alpha', 'scan', 'source', 'discover'],
      'copy-trade': ['copy', 'копи', 'mirror'],
      'exit-optimizer': ['exit', 'выход', 'take profit', 'stop loss'],
      'web-search': ['search', 'поиск', 'news', 'новост', 'google', 'найди', 'find', 'article', 'статья', 'latest', 'последн', 'update', 'обновлен', 'build', 'билд', 'develop', 'разработ', 'solana', 'how to', 'как ', 'tutorial', 'guide', 'гайд', 'docs', 'документац', 'api', 'апи', 'research', 'ресёрч', 'ресерч', 'документ', 'endpoint', 'fetch', 'browse', 'browser', 'chrome', 'хром', 'сайт', 'website', 'swagger', 'openapi', 'integration', 'интеграц', 'pump.fun', 'jupiter', 'raydium', 'helius', 'sdk'],
      'ai-memory': ['memory', 'помн', 'запомн', 'remember', 'forget', 'забуд'],
      'skill-builder': ['create skill', 'custom skill', 'build skill', 'создай скилл', 'новый скилл', 'skill builder'],
      'projects': ['project', 'проект', 'код', 'code', 'build', 'билд', 'файл', 'file', 'создай', 'напиши', 'папк', 'folder', 'directory', 'todo', 'задач', 'task', 'coding', 'программ', 'html', 'css', 'javascript', 'python', 'typescript', 'react', 'npm', 'install', 'запусти', 'execute', 'run', 'search', 'поиск', 'write code', 'create file', 'script', 'скрипт', 'сайт', 'sandbox', 'песочниц', 'compile', 'run code'],
    };

    const skillScores: Record<string, number> = {};
    for (const [skill, keywords] of Object.entries(keywordMap)) {
      skillScores[skill] = 0;
      for (const kw of keywords) {
        if (ctx.includes(kw)) skillScores[skill] += 10;
      }
    }

    // Core tools always prioritized
    for (const s of ['pump-trader', 'token-analyzer', 'portfolio', 'blockchain', 'projects']) {
      skillScores[s] = (skillScores[s] || 0) + 5;
    }

    // If context contains a Solana address, strongly boost blockchain + pump-monitor (identify + creator info needed)
    if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(ctx)) {
      skillScores['blockchain'] = (skillScores['blockchain'] || 0) + 20;
      skillScores['pump-monitor'] = (skillScores['pump-monitor'] || 0) + 15;
    }

    // If context contains a Twitter/X URL, strongly boost token-analyzer (has fetch_tweet + fetch_twitter_profile)
    if (/(?:twitter\.com|x\.com)\//i.test(ctx)) {
      skillScores['token-analyzer'] = (skillScores['token-analyzer'] || 0) + 25;
    }

    // Sort tools by skill priority (higher score = included first)
    const sorted = [...allTools].sort((a, b) => {
      const sa = skillScores[toolSkillMap.get(a.function.name) || ''] || 0;
      const sb = skillScores[toolSkillMap.get(b.function.name) || ''] || 0;
      return sb - sa;
    });

    return sorted.slice(0, AgentRunner.MAX_TOOLS);
  }

  /**
   * Core LLM interaction loop — shared by event-driven and periodic modes.
   */
  private async processLLMCycle(action: string, userContent: string): Promise<string> {
    this.state.status = 'thinking';
    this.eventBus.emit('agent:thinking', {
      agentId: this.config.id,
      context: `Processing ${action}`,
    });

    // Remember history length to rollback on error
    const historyLenBefore = this.conversationHistory.length;

    try {
      const allTools = this.skills.getToolsAsLLMFormat(this.config.skills);
      const tools = this.selectRelevantTools(allTools, userContent);

      this.logger.info(`Agent "${this.config.id}" LLM call: ${tools.length}/${allTools.length} tools selected for action="${action}"`);

      const userMsg: LLMMessage = {
        role: 'user',
        content: userContent,
      };
      // Attach pending image (chart screenshot etc.) to this message
      if (this._pendingImage) {
        userMsg.image = this._pendingImage;
        this._pendingImage = undefined;
      }
      this.conversationHistory.push(userMsg);

      this.trimHistory();

      const LLM_TIMEOUT_MS = 60_000;
      const safeMessages = () => this.conversationHistory.filter(m => m && m.role);
      const llmCall = (msgs: LLMMessage[], t: any) =>
        Promise.race([
          this.llm.chat(msgs, t, this.getLLMOptions(action)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('LLM call timed out after 60s')), LLM_TIMEOUT_MS)
          ),
        ]);

      let response = await llmCall(safeMessages(), tools);

      this.eventBus.emit('agent:llm_response', {
        agentId: this.config.id,
        content: (response.content || '').slice(0, 300),
        toolCallsCount: response.toolCalls?.length || 0,
        round: 0,
      });

      // Nudge: if the model responded with text but no tool calls on the first round,
      // and the message context suggests tools should have been used, retry with escalating urgency (up to 3 attempts)
      if (this.efficiencyMode !== 'economy'
        && (!response.toolCalls || response.toolCalls.length === 0)
        && tools.length > 0
        && action === 'user_chat') {
        const ctx = userContent.toLowerCase();
        const needsTools = /найди|find|search|поиск|fetch|загрузи|скачай|покажи|открой|browse|research|ресёрч|ресерч|api|апи|docs|документ|check|проверь|analyze|анализ|scan|сканир|сделай|создай|create|build|write|напиши|implement|реализуй|исследуй|узнай|парс|scrape|спарси|download/.test(ctx);
        if (needsTools) {
          const nudgeMessages = [
            '[System: You MUST use your available tools (like deep_research, google_search, browser_fetch, web_search, project_write, etc.) to fulfill this request. Do NOT just describe what you will do — actually call the tools NOW. The user is waiting for real results, not promises or questions.]',
            '[System: CRITICAL — You are STILL not using tools. The user needs ACTION, not text. Call a tool RIGHT NOW. Pick the most relevant tool and execute it immediately. Do NOT ask the user anything — just act.]',
            '[System: FINAL WARNING — You MUST call at least one tool in your next response. If you respond with only text again, you are failing your task. The user explicitly asked you to DO something. USE YOUR TOOLS NOW.]',
          ];
          
          for (let nudgeAttempt = 0; nudgeAttempt < 3; nudgeAttempt++) {
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
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: (response.content || '').slice(0, 300),
              toolCallsCount: response.toolCalls?.length || 0,
              round: 0,
            });
          }
        }
      }

      // Tool call loop — keeps executing until the model stops requesting tools
      let toolCallRounds = 0;
      const maxRounds = this.maxRounds;
      const cycleStart = Date.now();
      const TOTAL_TIMEOUT_MS = 300_000; // 300s (5min) total for entire cycle
      // Track all tool calls to detect repetition and inject dedup hints
      const usedToolCalls: { tool: string; args: string }[] = [];
      let planningNudgeInjected = false; // Track if we already nudged for upfront planning

      while (response.toolCalls && response.toolCalls.length > 0 && toolCallRounds < maxRounds) {
        if (Date.now() - cycleStart > TOTAL_TIMEOUT_MS) {
          this.logger.warn(`Agent "${this.config.id}" total cycle timeout (${TOTAL_TIMEOUT_MS}ms)`);
          break;
        }
        this.state.status = 'executing';
        toolCallRounds++;

        this.conversationHistory.push({
          role: 'assistant',
          content: response.content || '',
          toolCalls: response.toolCalls,
        });

        // Execute all tool calls in parallel for speed
        // But first, track them for dedup
        for (const tc of response.toolCalls) {
          usedToolCalls.push({ tool: tc.function.name, args: tc.function.arguments });
        }
        const toolResults = await Promise.all(
          response.toolCalls.map(async (toolCall) => {
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
              durationMs: Date.now() - toolStart,
            });

            return { toolCall, result };
          })
        );

        for (const { toolCall, result } of toolResults) {
          this.conversationHistory.push({
            role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result),
            toolCallId: toolCall.id,
          });
        }

        // Before next LLM call, inject dedup hint if there are repeated search/research tools
        const searchTools = ['google_search', 'web_search', 'browser_fetch', 'fetch_url', 'deep_research', 'extract_api_docs'];
        const usedSearchCalls = usedToolCalls.filter(c => searchTools.includes(c.tool));
        if (usedSearchCalls.length >= 2 && toolCallRounds >= 2) {
          const usedSummary = usedSearchCalls.map(c => {
            try {
              const parsed = JSON.parse(c.args);
              const key = parsed.query || parsed.url || parsed.topic || Object.values(parsed)[0] || '';
              const start = parsed.start ? `, start:${parsed.start}` : '';
              return `${c.tool}("${String(key).slice(0, 80)}"${start})`;
            } catch { return `${c.tool}(?)`; }
          }).join(', ');
          
          // Count how many google_search calls used different start values
          const googleCalls = usedSearchCalls.filter(c => c.tool === 'google_search');
          const usedStarts = new Set(googleCalls.map(c => {
            try { return JSON.parse(c.args).start || 0; } catch { return 0; }
          }));
          const paginationHint = usedStarts.size < 3 && googleCalls.length > 0
            ? ' TIP: Use google_search with start:10, start:20, start:30 etc. to see deeper pages — don\'t stay on page 1!'
            : '';
          
          this.conversationHistory.push({
            role: 'user',
            content: `[System dedup: You already used these searches: ${usedSummary}. RULES: 1) Do NOT repeat the same query+tool. 2) ADAPT your query — use different keywords, synonyms, add "github"/"reddit"/"example"/"tutorial". 3) Try pages 2-5 of Google with start:10/20/30. 4) Search BEYOND official sites — check GitHub issues, repos, StackOverflow, Reddit, Medium, blogs. 5) If you found a URL in results — fetch_url or browser_fetch it to read the actual content.${paginationHint}]`,
          });
        }

        // Planning enforcement: if AI started coding (project_write, project_mkdir, project_run)
        // but never created a todo plan first (project_todo_add), force it to plan BEFORE continuing
        if (!planningNudgeInjected && toolCallRounds >= 1) {
          const codingTools = ['project_write', 'project_mkdir', 'project_run', 'project_execute'];
          const startedCoding = usedToolCalls.some(c => codingTools.includes(c.tool));
          const createdTodos = usedToolCalls.filter(c => c.tool === 'project_todo_add').length;
          
          if (startedCoding && createdTodos < 3) {
            planningNudgeInjected = true;
            this.logger.info(`Agent "${this.config.id}" started coding with only ${createdTodos} todos — forcing upfront planning`);
            this.conversationHistory.push({
              role: 'user',
              content: '[System: STOP — You started coding without creating a proper TODO plan first. Your workflow REQUIRES you to create ALL todos UPFRONT before writing any code. Do this NOW:\n1. Call project_todo_add 8-15 times with your FULL detailed plan\n2. Each todo = VERB + SPECIFIC FILE/FUNCTION (e.g. "Write src/fetcher.js: fetchData() function")\n3. Include test and fix todos after every 2-3 implementation steps\n4. ONLY AFTER creating all todos, continue coding one todo at a time\nCreate your complete todo plan NOW before writing any more code.]',
            });
          }
        }

        response = await llmCall(safeMessages(), tools);

        this.eventBus.emit('agent:llm_response', {
          agentId: this.config.id,
          content: (response.content || '').slice(0, 300),
          toolCallsCount: response.toolCalls?.length || 0,
          round: toolCallRounds,
        });
      }

      // Anti-question loop: if the model's final response asks the user for permission/confirmation
      // instead of acting, auto-inject "YES, do it" and force continuation (up to 2 times)
      if (this.efficiencyMode !== 'economy' && action === 'user_chat' && tools.length > 0) {
        const questionPatterns = /(?:хотите|хочешь|скажите|скажи|подскажите|как вы хотите|как именно|want me to|shall i|should i|do you want|would you like|how would you like|how do you want|can i|may i|let me know|дать мне знать|подтвердите|confirm|уточните|clarify|предлагаю вам|suggest you|готовы ли|are you ready|нужно ли|стоит ли|могу ли|можно ли|если у вас есть|могу продолжить|if you have|if you can provide|could you provide|can you provide|есть ли у вас|знаете ли вы|do you know|do you have)\b/i;
        let antiQuestionRounds = 0;
        const MAX_ANTI_QUESTION = 2;
        
        while (antiQuestionRounds < MAX_ANTI_QUESTION && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
          const finalText = (response.content || '').toLowerCase();
          // Detect either: question mark + question pattern, OR hesitation phrases (even without ?)
          const hasQuestionMark = questionPatterns.test(finalText) && finalText.includes('?');
          const hesitationPatterns = /(?:если у вас есть|могу продолжить|if you have|if you can provide|could you provide|дайте знать|let me know|не удалось найти .{0,30} через доступные|я могу попробовать|i can try|хотите чтобы я продолжил|want me to continue)/i;
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
            content: '[System: YES — do it NOW. Do NOT ask for permission or confirmation. Execute your plan immediately using tools. The user has already approved everything by asking you. Act autonomously.]',
          });
          
          response = await llmCall(safeMessages(), tools);
          
          // If this triggered tool calls, run them through the tool loop
          let extraRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && extraRounds < maxRounds && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
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
              this.conversationHistory.push({
                role: 'tool',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                toolCallId: toolCall.id,
              });
            }
            response = await llmCall(safeMessages(), tools);
          }
        }
      }

      // Code verification nudge: if the model wrote files (project_write) but never tested
      // (project_execute, project_run), force it to verify its work
      if (this.efficiencyMode !== 'economy' && action === 'user_chat' && tools.length > 0 && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
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
            content: '[System: STOP — you wrote code files but NEVER tested them. Your code quality rule REQUIRES you to verify your work before reporting done. Do these steps NOW:\n1. project_read your main files to review for bugs (missing imports, typos, wrong API URLs)\n2. project_run or project_execute to actually RUN the code and check for errors\n3. If errors → fix them → test again\n4. Only THEN give your final report.\nDo NOT skip verification. The user expects WORKING code, not untested drafts.]',
          });
          
          response = await llmCall(safeMessages(), tools);
          
          // Run tool calls from verification
          let verifyRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && verifyRounds < 10 && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
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
              this.conversationHistory.push({
                role: 'tool',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                toolCallId: toolCall.id,
              });
            }
            response = await llmCall(safeMessages(), tools);
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: (response.content || '').slice(0, 300),
              toolCallsCount: response.toolCalls?.length || 0,
              round: toolCallRounds + verifyRounds,
            });
          }
        }
      }

      // Error give-up detection: if the AI's final response mentions an error/problem
      // but doesn't continue fixing it (no tool calls), force it to keep working
      if (this.efficiencyMode !== 'economy' && action === 'user_chat' && tools.length > 0 && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
        const finalText = (response.content || '').toLowerCase();
        const errorGiveUpPatterns = /(?:необходимо проверить|нужно уточнить|нужно проверить|возникла ошибка|ошибка при|ошибка связана|проблема связана|не удалось выполнить|не удалось подключиться|failed to|error occurred|need to check|need to verify|authorization.*required|авторизаци|проблема с авторизацией|далее я уточню|далее я проверю|дальше нужно|требуется.*авторизация|an error|encountered.*error|issue with)/i;
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
            content: '[System: You reported an error but STOPPED working. This is NOT acceptable. Your rules say: NEVER give up on errors. NEVER report a bug as your final answer. Do this NOW:\n1. READ the error message — what exactly went wrong?\n2. RESEARCH the fix — google_search the error message or API documentation\n3. FIX your code — project_read the broken file → fix the issue → project_write\n4. TEST again — project_execute or project_run to verify your fix\n5. Repeat until it WORKS.\nThe user expects WORKING code, not error reports. Fix it NOW.]',
          });
          
          response = await llmCall(safeMessages(), tools);
          
          // Run tool calls from error fixing
          let fixRounds = 0;
          while (response.toolCalls && response.toolCalls.length > 0 && fixRounds < 15 && (Date.now() - cycleStart < TOTAL_TIMEOUT_MS)) {
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
              this.conversationHistory.push({
                role: 'tool',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                toolCallId: toolCall.id,
              });
            }
            response = await llmCall(safeMessages(), tools);
            this.eventBus.emit('agent:llm_response', {
              agentId: this.config.id,
              content: (response.content || '').slice(0, 300),
              toolCallsCount: response.toolCalls?.length || 0,
              round: toolCallRounds + fixRounds,
            });
          }
        }
      }

      const decision = response.content || '';

      this.conversationHistory.push({
        role: 'assistant',
        content: decision,
      });

      this.state.totalDecisions++;
      this.state.lastAction = action;
      this.state.lastActionAt = Date.now();
      this.state.status = 'idle';

      this.eventBus.emit('agent:decided', {
        agentId: this.config.id,
        action,
        reason: decision.slice(0, 200),
      });

      this.logger.info(`Agent "${this.config.name}": ${decision.slice(0, 150)}`);

      return decision;
    } catch (err: any) {
      this.state.status = 'error';
      // Rollback conversation history to state before this cycle
      this.conversationHistory.length = historyLenBefore;
      // Auto-recover to idle after error
      setTimeout(() => {
        if (this.state.status === 'error') this.state.status = 'idle';
      }, 2000);
      const errMsg = err.message || String(err);
      this.logger.error(`Agent "${this.config.id}" error`, err);
      this.eventBus.emit('agent:error', {
        agentId: this.config.id,
        error: errMsg,
      });
      // Return meaningful error for chat context
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
    // For user chat, pass the message directly — no event wrapping.
    // This gives the AI the raw user message so it can respond naturally.
    if (this.state.status === 'thinking' || this.state.status === 'executing') {
      return 'I\'m currently processing another request. Please wait a moment and try again.';
    }

    this.eventBus.emit('agent:chat_request', {
      agentId: this.config.id,
      message: userMessage.slice(0, 200),
    });

    // Store image for inclusion in the LLM message
    this._pendingImage = image || undefined;

    const contextParts: string[] = [];

    // Detect if message is a raw Solana address (base58, 32-44 chars) and augment with instruction
    const trimmed = userMessage.trim();
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
    const containsAddress = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(trimmed);
    const isRpcQuery = /\b(rpc|рпс|рпц|ноду|нода|эндпоинт|endpoint)\b/i.test(trimmed);

    // Detect tweet/X.com URLs
    const tweetUrlMatch = trimmed.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([^\/\s]+)\/status\/(\d+)/i);
    const twitterProfileMatch = !tweetUrlMatch && trimmed.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([^\/\s?#]+)\/?(?:\s|$)/i);

    if (isSolanaAddress) {
      // User sent ONLY an address — must identify first
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
      // User sent a message containing an address + context — let the prompt guide routing
      contextParts.push(
        userMessage + '\n\n' +
        `[System: The message contains a Solana address. Use identify_address first to determine its type before calling other tools. Adapt your tool chain based on the address type AND the user's question. ` +
        `IMPORTANT: If the user asks about a dev wallet / creator for a TOKEN MINT, use check_dev_wallet (it accepts token mints and auto-resolves to the creator wallet), or use analyze_token which returns creatorInfo. NEVER tell the user "this is a token not a wallet" — just resolve the dev wallet automatically. ` +
        `SOCIAL LINKS: When checking social links, ALWAYS pass the token mint to fetch_project_links — it resolves links from on-chain metadata. Do NOT use links from the user's message as the token's official social links. Token metadata is the source of truth.]`
      );
    } else if (isRpcQuery) {
      contextParts.push(userMessage + '\n\n[System hint: Use get_rpc_status tool to check current RPC configuration and connectivity.]');
    } else if (tweetUrlMatch) {
      // User sent a tweet URL — fetch directly, then give LLM the content to analyze
      const tweetUrl = tweetUrlMatch[0];
      const tweetAuthor = tweetUrlMatch[1];
      const tweetId = tweetUrlMatch[2];
      const extraText = trimmed.replace(tweetUrl, '').trim();
      this.logger.info(`[chat] Tweet URL detected: ${tweetUrl} (author: @${tweetAuthor}, id: ${tweetId}). Calling fetch_tweet directly...`);

      // Directly call fetch_tweet instead of hoping the LLM will do it
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
      // User sent a Twitter profile URL — fetch directly
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

    // Only append minimal market context if relevant (not for conversational questions)
    if (this.marketState) {
      const state = this.marketState.getState();
      // Only include context if there's actual trading activity
      const hasActivity = state.positions.length > 0 || state.recentTrades.length > 0 || (state.sessionStats?.tradesExecuted ?? 0) > 0;
      if (hasActivity) {
        contextParts.push('\n---\n[System: current market snapshot for reference only — prioritize answering the user\'s question]');
        contextParts.push(this.marketState.buildPromptContext());
      }
    }

    // Inject relevant AI memories as context
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
    } catch { /* memory search is non-critical */ }

    return this.processLLMCycle('user_chat', this.clipContext(contextParts.join('\n')));
  }

  private buildContextMessage(action: string, data: any): string {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    const parts = [
      `Event: ${action}`,
      `Timestamp: ${new Date().toISOString()}`,
      `Data:\n${dataStr}`,
    ];

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

      const result = await this.skills.executeTool(name, params);

      if (name.includes('buy') || name.includes('sell') || name.includes('swap')) {
        this.state.totalTrades++;
      }

      return result;
    } catch (err: any) {
      this.logger.error(`Tool "${name}" failed`, err);
      return { error: err.message || String(err) };
    }
  }

  private trimHistory(): void {
    const maxMessages = this.maxHistoryMessages;
    // Filter out any undefined/null entries that might have crept in
    this.conversationHistory = this.conversationHistory.filter(m => m && m.role);
    if (this.conversationHistory.length > maxMessages) {
      const system = this.conversationHistory[0];
      // Keep system + most recent messages, summarize old tool results to save tokens
      let kept = this.conversationHistory.slice(-(maxMessages - 1));
      // Make sure we don't start with an orphan tool result (needs assistant with toolCalls before it)
      while (kept.length > 0 && kept[0].role === 'tool') {
        kept.shift();
      }
      // Truncate old tool results to save context window
      for (const msg of kept) {
        if (msg.role === 'tool' && msg.content && msg.content.length > this.toolResultCharLimit) {
          msg.content = msg.content.slice(0, this.toolResultCharLimit) + '\n... [truncated]';
        }
      }
      this.conversationHistory = [system, ...kept];
    }
  }
}
