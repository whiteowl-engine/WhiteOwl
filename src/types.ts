import { EventEmitter } from 'events';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  returns?: Record<string, any>;
  requiresApproval?: boolean;
  riskLevel: 'read' | 'write' | 'financial';
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];
}

export interface SkillContext {
  eventBus: EventBusInterface;
  memory: MemoryInterface;
  logger: LoggerInterface;
  config: Record<string, any>;
  wallet: WalletInterface;
  browser?: any;
}

export interface Skill {
  manifest: SkillManifest;
  initialize(ctx: SkillContext): Promise<void>;
  execute(tool: string, params: Record<string, any>): Promise<any>;
  shutdown(): Promise<void>;
}

export type AutonomyLevel = 'autopilot' | 'advisor' | 'monitor' | 'manual';

export interface AgentRiskLimits {
  maxPositionSol: number;
  maxOpenPositions: number;
  maxDailyLossSol: number;
  maxDrawdownPercent: number;
  cooldownAfterLossStreak?: number;
  lossStreakThreshold?: number;
}

export type LLMProviderName =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'groq'
  | 'deepseek'
  | 'openrouter'
  | 'mistral'
  | 'google'
  | 'xai'
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'perplexity'
  | 'huggingface'
  | 'azure'
  | 'amazon-bedrock'
  | 'google-vertex'
  | 'github'
  | 'minimax'
  | 'moonshot'
  | 'sambanova'
  | 'hyperbolic'
  | 'cohere'
  | 'lepton'
  | 'copilot'
  | 'google-oauth'
  | 'azure-oauth';

export interface ModelConfig {
  provider: LLMProviderName;
  model: string;
  apiKey?: string;
  apiKeys?: string[];
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  region?: string;
  oauthProvider?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  model: ModelConfig;
  fallbackModels?: ModelConfig[];
  skills: string[];
  autonomy: AutonomyLevel;
  riskLimits: AgentRiskLimits;
  triggers?: TriggerBinding[];
}

export interface TriggerBinding {
  event: string;
  action: string;
  filter?: Record<string, any>;
}

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: 'idle' | 'thinking' | 'executing' | 'error' | 'paused';
  lastAction?: string;
  lastActionAt?: number;
  totalDecisions: number;
  totalTrades: number;
  consecutiveLosses: number;
  cooldownUntil?: number;
}

export interface TradingSession {
  id: string;
  mode: AutonomyLevel;
  strategy?: string;
  agents: string[];
  startedAt: number;
  endsAt?: number;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  reportInterval: number;
  stats: SessionStats;
}

export interface SessionStats {
  tokensScanned: number;
  signalsGenerated: number;
  tradesExecuted: number;
  tradesWon: number;
  tradesLost: number;
  totalPnlSol: number;
  peakPnlSol: number;
  worstDrawdownSol: number;
  winRate?: number;
}

export interface TradeIntent {
  id: string;
  agentId: string;
  action: 'buy' | 'sell';
  mint: string;
  symbol?: string;
  amountSol?: number;
  amountPercent?: number;
  slippageBps: number;
  priorityFeeSol: number;
  reason: string;
  timestamp: number;
}

export interface TradeResult {
  intentId: string;
  success: boolean;
  txHash?: string;
  price?: number;
  amountSol?: number;
  amountTokens?: number;
  error?: string;
  timestamp: number;
}

export interface Position {
  mint: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  amountTokens: number;
  amountSolInvested: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  openedAt: number;
  lastUpdated: number;
}

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  dev: string;
  createdAt: number;
  bondingCurveProgress: number;
  marketCap: number;
  volume24h: number;
  holders: number;
  price: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
}

export interface TokenAnalysis {
  mint: string;
  score: number;
  rugScore: number;
  signals: string[];
  recommendation: 'strong_buy' | 'buy' | 'watch' | 'skip' | 'avoid';
  reasoning: string;
  analyzedAt: number;
}

export interface HolderData {
  mint: string;
  totalHolders: number;
  top10Percent: number;
  top20Percent: number;
  devHoldingPercent: number;
  isBundled: boolean;
  suspiciousWallets: string[];
  checkedAt: number;

  lpPercent?: number;
  burnedPercent?: number;
  lpPools?: { name: string; percent: number }[];
  topHolders?: { address: string; percent: number; label?: string }[];
}

export interface TokenSnapshot {
  mint: string;
  price: number;
  mcap: number;
  volume5m: number;
  volume1h: number;
  volume24h: number;
  holders: number;
  bondingProgress: number;
  timestamp: number;
}

export interface EventMap {
  'token:new': { mint: string; name: string; symbol: string; dev: string; timestamp: number };
  'token:graduated': { mint: string; dex: string; timestamp: number };
  'token:update': TokenSnapshot;
  'token:trade': {
    mint: string;
    txType: 'buy' | 'sell';
    solAmount: number;
    tokenAmount: number;
    wallet: string;
    price: number;
    mcap: number;
    bondingProgress: number;
    timestamp: number;
  };

  'signal:buy': { mint: string; score: number; reason: string; agentId: string };
  'signal:sell': { mint: string; reason: string; urgency: 'low' | 'medium' | 'high'; agentId: string };
  'signal:watch': { mint: string; reason: string; agentId: string };
  'signal:rug': { mint: string; indicators: string[]; confidence: number };

  'security:alert': { mint: string; flags: string[]; score: number; timestamp: number };
  'curve:update': { mint: string; progressPct: number; velocity1m: number; entryZone: string; timestamp: number };
  'volume:anomaly': { mint: string; type: 'wash_trading' | 'volume_spike' | 'coordinated_pump'; details: string; timestamp: number };
  'holder:alert': { mint: string; type: 'dev_selling' | 'whale_dump' | 'insider_exit' | 'cluster_detected'; details: string; timestamp: number };

  'trade:intent': TradeIntent;
  'trade:approved': { intentId: string };
  'trade:rejected': { intentId: string; reason: string };
  'trade:executed': TradeResult;

  'position:opened': Position;
  'position:updated': Position;
  'position:closed': { mint: string; pnl: number; pnlPercent: number; duration: number };

  'risk:limit': { type: string; current: number; max: number };
  'risk:cooldown': { until: number; reason: string };
  'risk:emergency': { reason: string };

  'session:started': { sessionId: string; mode: AutonomyLevel };
  'session:paused': { sessionId: string };
  'session:stopped': { sessionId: string; stats: SessionStats };
  'session:report': { sessionId: string; report: string; stats: SessionStats };

  'agent:thinking': { agentId: string; context: string };
  'agent:decided': { agentId: string; action: string; reason: string };
  'agent:error': { agentId: string; error: string };
  'agent:tool_call': { agentId: string; tool: string; params: Record<string, any>; round: number };
  'agent:tool_result': { agentId: string; tool: string; result: any; durationMs: number };
  'agent:llm_response': { agentId: string; content: string; toolCallsCount: number; round: number; usage?: { promptTokens: number; completionTokens: number } };
  'agent:chat_request': { agentId: string; message: string };
  'agent:token': { agentId: string; token: string; final?: boolean };
  'agent:file_change': { agentId: string; path: string; diff: string; tool: string };
  'agent:cycle_usage': { agentId: string; promptTokens: number; completionTokens: number; totalTokens: number };

  'system:ready': { timestamp: number };
  'system:health': { uptime: number; agents: AgentState[]; positions: Position[] };
  'system:error': { error: string; fatal: boolean };

  'trenches:alert': {
    mint: string; name: string; symbol: string; score: number;
    matchedMetas: string[]; activity: any; reason: string; timestamp: number;
    mcap?: number; bondingProgress?: number; holders?: number;
    description?: string; twitter?: string; telegram?: string; website?: string;
  };
  'trenches:buy': {
    mint: string; name: string; symbol: string; score: number;
    amountSol: number; reason: string; timestamp: number;
  };
  'trenches:ai_pick': {
    analysis: string; tokens: Array<{ mint: string; name: string; symbol: string; score: number }>;
    batchSize: number; timestamp: number;
  };

  'news:headline': { item: NewsItem; timestamp: number };
  'news:batch': { items: NewsItem[]; source: string; count: number; timestamp: number };
  'news:sentiment_update': NewsSentimentSummary;
}

export type EventName = keyof EventMap;

export interface EventBusInterface {
  emit<K extends EventName>(event: K, data: EventMap[K]): void;
  on<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void;
  off<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void;
  once<K extends EventName>(event: K, handler: (data: EventMap[K]) => void): void;
  history(event?: EventName, limit?: number): Array<{ event: EventName; data: any; timestamp: number }>;
}

export interface WalletInterface {
  getAddress(): string;
  getBalance(): Promise<number>;
  hasWallet(): boolean;
  getStoredWallets(): Array<{ name: string; address: string; privateKey: string; createdAt: number; isBurn?: boolean }>;
  sign(transaction: any): Promise<any>;
  signAndSend(transaction: any): Promise<string>;
}

export interface MemoryInterface {
  recordTrade(trade: TradeResult & { intent: TradeIntent }): void;
  getTradeHistory(opts?: { limit?: number; mint?: string; since?: number }): any[];
  getStats(period?: '1h' | '4h' | '24h' | '7d' | 'all'): SessionStats;

  storeToken(token: TokenInfo): void;
  getToken(mint: string): TokenInfo | null;
  getTopTokens(period: '1h' | '4h' | '24h', by: 'volume' | 'mcap' | 'holders' | 'mentions', limit?: number): TokenInfo[];
  storeSnapshot(snapshot: TokenSnapshot): void;
  getSnapshots(mint: string, since?: number): TokenSnapshot[];

  storeAnalysis(analysis: TokenAnalysis): void;
  getAnalysis(mint: string): TokenAnalysis | null;

  storeHolderData(data: HolderData): void;
  getHolderData(mint: string): HolderData | null;

  addRugAddress(address: string, reason: string): void;
  isKnownRug(address: string): boolean;

  saveAIMemory(category: string, content: string, subject?: string, tags?: string[]): number;
  searchAIMemory(query: string, limit?: number): any[];
  getAIMemoryByCategory(category: string, subject?: string, limit?: number): any[];
  getRecentAIMemories(limit?: number): any[];
  deleteAIMemory(id: number): boolean;

  storeTokenPattern(pattern: {
    mint: string;
    dev?: string;
    name?: string;
    symbol?: string;
    descriptionWords?: string[];
    twitterHandle?: string;
    telegramHandle?: string;
    websiteDomain?: string;
    websiteContentHash?: string;
    namePattern?: string;
    narrativeTags?: string[];
    score?: number;
    rugScore?: number;
  }): void;
  findPatternsByDev(dev: string, excludeMint?: string): any[];
  findPatternsByTwitter(handle: string, excludeMint?: string): any[];
  findPatternsByTelegram(handle: string, excludeMint?: string): any[];
  findPatternsByWebsite(domain: string, excludeMint?: string): any[];
  findPatternsByContentHash(hash: string, excludeMint?: string): any[];
  findPatternsByNamePattern(pattern: string, excludeMint?: string): any[];
  getAllPatternsWithDescriptions(excludeMint?: string, limit?: number): any[];
  updatePatternOutcome(mint: string, outcome: string): void;
}

export interface LoggerInterface {
  info(msg: string, data?: any): void;
  warn(msg: string, data?: any): void;
  error(msg: string, data?: any): void;
  debug(msg: string, data?: any): void;
  trade(msg: string, data?: any): void;
}

export interface AppConfig {
  rpc: {
    solana: string;
    helius?: string;
    heliusApiKey?: string;
  };
  api: {
    port: number;
    key?: string;
  };
  risk: AgentRiskLimits & {
    emergencyStopLossSol: number;
  };
  agents: AgentConfig[];
  notifications?: {
    telegram?: { botToken: string; chatId: string };
    webhook?: string;
  };
  memory: {
    dbPath: string;
  };
  autoApproveLevel?: 'off' | 'conservative' | 'moderate' | 'aggressive' | 'full';
  privacy?: {
    enabled?: boolean;
    maskWallets?: boolean;
    maskTokenMints?: boolean;
    maskAmounts?: boolean;
    maskRpcUrls?: boolean;
    stripPrivateKeys?: boolean;
    auditLog?: boolean;
  };
}

export interface StrategyCondition {
  field: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'matches' | 'in' | 'not_in';
  value: any;
}

export interface TakeProfitLevel {
  at: number;
  sellPercent: number;
}

export interface StrategyConfig {
  name: string;
  description: string;
  entry: {
    conditions: StrategyCondition[];
    buy: {
      amountSol: number;
      slippageBps: number;
      priorityFeeSol: number;
    };
  };
  exit: {
    takeProfit: TakeProfitLevel[];
    stopLossPercent: number;
    timeoutMinutes?: number;
    timeoutAction?: 'sell' | 'hold';
  };
  filters?: {
    blacklistPatterns?: string[];
    blacklistWallets?: string[];
    minScore?: number;
  };
}

export type NewsCategory = 'solana' | 'defi' | 'macro' | 'regulation' | 'memes' | 'hack' | 'general'
  | 'politics' | 'sports' | 'tech' | 'business' | 'world' | 'science' | 'entertainment' | 'conflict' | 'elections' | 'weather' | 'crypto';
export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  summary_ru?: string;
  url?: string;
  source: string;
  published_at: number;
  category: NewsCategory;
  sentiment: NewsSentiment;
  relevance_score: number;
  mentioned_tokens: string[];
  priority: number;
  votes?: { bullish: number; bearish: number; important: number };
  created_at: number;
}

export interface NewsSentimentSummary {
  bullish: number;
  bearish: number;
  neutral: number;
  trend: 'bullish' | 'bearish' | 'mixed' | 'neutral';
  updated_at: number;
}

export interface NewsSourceStatus {
  id: string;
  name: string;
  type: 'cryptopanic' | 'rss' | 'macro' | 'gdelt' | 'hackernews' | 'telegram';
  enabled: boolean;
  last_fetch: number;
  error_count: number;
  last_error?: string;
  items_fetched: number;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  image?: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMStreamChunk {
  content?: string;
  toolCalls?: LLMToolCall[];
  done: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): Promise<LLMResponse>;
  stream?(messages: LLMMessage[], tools?: LLMTool[], options?: Record<string, any>): AsyncGenerator<LLMStreamChunk>;
}
