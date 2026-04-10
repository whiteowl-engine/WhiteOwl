import WebSocket from 'ws';
import { Skill, SkillManifest, SkillContext, TokenInfo, EventBusInterface, LoggerInterface } from '../types.ts';
import { TrendContext } from '../core/trend-context.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import { getSolPriceUsd } from '../core/sol-price.ts';
import {
  OnlinePumpSdk,
  bondingCurvePda,
  bondingCurveMarketCap,
  type BondingCurve,
} from '../lib/pump-sdk.ts';

const PUMP_API_URL = 'https://frontend-api-v3.pump.fun';
const SWAP_API_URL = 'https://swap-api.pump.fun';
const ADVANCED_API_URL = 'https://advanced-api-v2.pump.fun';

const NATS_CORE = {
  url: 'wss://prod-v2.nats.realtime.pump.fun',
  user: 'subscriber',
  pass: 'lW5a9y20NceF6AE9',
};
const NATS_UNIFIED = {
  url: 'wss://unified-prod.nats.realtime.pump.fun',
  user: 'subscriber',
  pass: 'OX745xvUbNQMuFqV',
};
const SUBJECT_COIN_LIFECYCLE = 'coinLifecycle.prod';
const SUBJECT_TRADE = 'unifiedTradeEvent';

interface NatsConn {
  ws: WebSocket | null;
  name: string;
  config: { url: string; user: string; pass: string };
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  nextSid: number;
  subs: Map<number, string>;
  buffer: string;
}

interface PumpToken {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  image_uri: string;
  twitter: string;
  telegram: string;
  website: string;
  creator: string;
  created_timestamp: number;
  market_cap: number;
  usd_market_cap: number;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  real_sol_reserves: number;
  real_token_reserves: number;
  bonding_curve: string;
  complete: boolean;
  pool_address: string | null;
  ath_market_cap?: number;
  ath_market_cap_timestamp?: number;
  reply_count?: number;
  program?: string;
  token_program?: string;
  total_supply?: number;
  last_trade_timestamp?: number;
}

interface PumpTrade {
  signature: string;
  mint: string;
  sol_amount: number;
  token_amount: number;
  is_buy: boolean;
  user: string;
  timestamp: number;
  slot: number;
}

interface PumpComment {
  id: string;
  text: string;
  user: string;
  timestamp: number;
  mint: string;
}

interface TrenchesConfig {
  mode: 'alert' | 'auto_buy';

  metaKeywords: string[];

  minScore: number;

  requireSocials: boolean;

  buyAmountSol: number;
  slippageBps: number;
  priorityFeeSol: number;

  minBuyers5m: number;
  minVolume5m: number;

  evalIntervalMs: number;

  maxTokenAgeMs: number;
}

interface TrenchesQueueItem {
  mint: string;
  name: string;
  symbol: string;
  dev: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  addedAt: number;
}

export class PumpMonitorSkill implements Skill {
  manifest: SkillManifest = {
    name: 'pump-monitor',
    version: '3.0.0',
    description: 'Full pump.fun integration with official SDK: monitor launches, on-chain bonding curve reads, search tokens, trending, trade history, comments, dev reputation, graduated tokens, real-time WebSocket',
    tools: [

      {
        name: 'start_monitoring',
        description: 'Start monitoring pump.fun for new token launches via WebSocket',
        parameters: {
          type: 'object',
          properties: {
            filters: {
              type: 'object',
              description: 'Optional filters for token monitoring',
              properties: {
                requireSocials: { type: 'boolean', description: 'Only emit tokens that have at least one social link' },
                nameBlacklist: { type: 'array', items: { type: 'string' }, description: 'Regex patterns to skip' },
              },
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'stop_monitoring',
        description: 'Stop the pump.fun monitoring WebSocket',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_token_info',
        description: 'Fetch detailed info about a specific token from pump.fun including bonding curve state and migration status',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_new_tokens',
        description: 'Get recently launched tokens from pump.fun',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of tokens to fetch (default 20, max 50)' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_monitor_status',
        description: 'Get the current monitoring statistics',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'search_tokens_by_creator',
        description: 'Find ALL tokens created by a specific wallet address on pump.fun. Useful to check a dev\'s history.',
        parameters: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'Creator wallet address (Solana pubkey)' },
            limit: { type: 'number', description: 'Max results (default 20)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: ['wallet'],
        },
        riskLevel: 'read',
      },

      {
        name: 'search_tokens_by_name',
        description: 'Search pump.fun tokens by name or ticker symbol. Returns matching tokens sorted by market cap.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term (token name or symbol)' },
            limit: { type: 'number', description: 'Max results (default 20)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_trending_tokens',
        description: 'Get trending tokens from pump.fun (King of the Hill). These are tokens gaining the most momentum right now.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default 20)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'get_token_trades',
        description: 'Get recent trade history for a specific token on pump.fun. Shows who bought/sold, amounts, and timestamps.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            limit: { type: 'number', description: 'Max trades to return (default 30)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_token_comments',
        description: 'Get comments/replies on a pump.fun token page. Shows community sentiment and discussion.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            limit: { type: 'number', description: 'Max comments to return (default 30)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_dev_profile',
        description: 'Analyze a token creator\'s reputation: how many tokens they launched, graduation rate, average mcap, rug patterns. Essential for risk assessment.',
        parameters: {
          type: 'object',
          properties: {
            wallet: { type: 'string', description: 'Creator/dev wallet address' },
          },
          required: ['wallet'],
        },
        riskLevel: 'read',
      },

      {
        name: 'subscribe_token_trades',
        description: 'Subscribe to real-time trade events for a specific token via WebSocket. Trades will be emitted as token:trade events.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address to track' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'search_tokens_by_mcap',
        description: 'Find pump.fun tokens within a specific market cap range (in USD). Useful for finding tokens at a target size.',
        parameters: {
          type: 'object',
          properties: {
            minMcap: { type: 'number', description: 'Minimum market cap in USD (default 0)' },
            maxMcap: { type: 'number', description: 'Maximum market cap in USD (default unlimited)' },
            limit: { type: 'number', description: 'Max results (default 20)' },
            sort: { type: 'string', description: 'Sort by: market_cap, created_timestamp, last_trade_timestamp (default: market_cap)' },
            order: { type: 'string', description: 'ASC or DESC (default: DESC)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'get_graduated_tokens',
        description: 'Get tokens that recently graduated from bonding curve and migrated to pump.fun AMM pools. These tokens have completed their bonding curve.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (default 20)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'get_top_holders',
        description: 'Get top token holders with their SOL balances. Essential for detecting whale concentration, dev holding, and sniper wallets.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_market_activity',
        description: 'Get real-time market activity for a token: number of txs, volume, buyers/sellers, price change % for 5m and 1h windows.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_token_ath',
        description: 'Get the all-time high market cap for a token. Shows the peak value the token reached.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_sol_price',
        description: 'Get the current SOL price in USD from pump.fun.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'get_token_candles',
        description: 'Get OHLCV price candle data for a token chart. Useful for technical analysis and price history.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            interval: { type: 'string', description: 'Candle interval: 1m, 5m, 15m, 1h (default: 5m)' },
            limit: { type: 'number', description: 'Number of candles (default: 60)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_king_of_the_hill',
        description: 'Get the current King of the Hill token on pump.fun — the coin with highest market cap approaching graduation.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'get_currently_live',
        description: 'Get tokens with active livestreams on pump.fun.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of results (default: 20)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'get_featured_tokens',
        description: 'Get featured/trending tokens from pump.fun for a given time window.',
        parameters: {
          type: 'object',
          properties: {
            timeWindow: { type: 'string', description: 'Time window: 1h, 6h, 24h (default: 1h)' },
            limit: { type: 'number', description: 'Number of results (default: 20)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'get_wallet_balances',
        description: 'Get pump.fun token balances for a wallet address. Shows all pump.fun tokens held by this wallet.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Solana wallet address' },
            limit: { type: 'number', description: 'Number of results (default: 50)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
            minBalance: { type: 'number', description: 'Minimum token balance filter (default: 0)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_current_metas',
        description: 'Get the currently trending metas/narratives on pump.fun. Shows what themes and categories are hot right now.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'search_by_meta',
        description: 'Search for pump.fun tokens belonging to a specific meta/narrative (e.g. "AI", "dog", "cat").',
        parameters: {
          type: 'object',
          properties: {
            meta: { type: 'string', description: 'Meta/narrative to search for' },
          },
          required: ['meta'],
        },
        riskLevel: 'read',
      },

      {
        name: 'get_kol_coins',
        description: 'Get coins tracked by KOLs (Key Opinion Leaders) on pump.fun. High-signal data for smart money following.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'batch_get_coins',
        description: 'Fetch multiple tokens at once by their mint addresses. Efficient for analyzing a watchlist or portfolio.',
        parameters: {
          type: 'object',
          properties: {
            mints: { type: 'array', items: { type: 'string' }, description: 'Array of token mint addresses (max 50)' },
          },
          required: ['mints'],
        },
        riskLevel: 'read',
      },

      {
        name: 'batch_get_market_activity',
        description: 'Fetch market activity (txs, volume, buyers, sellers, price change) for multiple tokens at once. Supports multiple time intervals.',
        parameters: {
          type: 'object',
          properties: {
            mints: { type: 'array', items: { type: 'string' }, description: 'Array of token mint addresses (max 50)' },
            intervals: { type: 'array', items: { type: 'string' }, description: 'Time intervals: 5m, 1h, 6h, 24h (default: ["5m","1h"])' },
          },
          required: ['mints'],
        },
        riskLevel: 'read',
      },

      {
        name: 'start_trenches',
        description: 'Start Trenches — real-time filter for newly created tokens. Monitors all new launches, evaluates them against current meta/narratives and market activity, then either alerts you or auto-buys matching tokens.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'Mode: "alert" (notify only) or "auto_buy" (execute trades). Default: alert' },
            metaKeywords: { type: 'array', items: { type: 'string' }, description: 'Narrative/meta keywords to match (e.g. ["AI", "dog", "trump"]). Empty = match all metas' },
            minScore: { type: 'number', description: 'Minimum Trenches score to pass (0-100, default: 50)' },
            requireSocials: { type: 'boolean', description: 'Require at least 1 social link (default: true)' },
            buyAmountSol: { type: 'number', description: 'SOL per auto-buy trade (default: 0.05)' },
            slippageBps: { type: 'number', description: 'Slippage in basis points (default: 2500)' },
            priorityFeeSol: { type: 'number', description: 'Priority fee in SOL (default: 0.001)' },
            minBuyers5m: { type: 'number', description: 'Min unique buyers in 5m to pass (default: 3)' },
            minVolume5m: { type: 'number', description: 'Min volume USD in 5m to pass (default: 100)' },
            evalIntervalMs: { type: 'number', description: 'Evaluation cycle interval in ms (default: 15000)' },
            maxTokenAgeMs: { type: 'number', description: 'Skip tokens older than this (default: 120000 = 2min)' },
          },
        },
        riskLevel: 'financial',
      },
      {
        name: 'stop_trenches',
        description: 'Stop the Trenches real-time filter. Clears the evaluation queue.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_trenches_status',
        description: 'Get Trenches filter status: active config, queue size, stats (scanned, passed, alerted, bought), recent alerts.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'configure_trenches',
        description: 'Update Trenches filter config on-the-fly without restarting. Pass only the fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: '"alert" or "auto_buy"' },
            metaKeywords: { type: 'array', items: { type: 'string' }, description: 'New meta keywords list' },
            minScore: { type: 'number', description: 'New minimum score' },
            requireSocials: { type: 'boolean' },
            buyAmountSol: { type: 'number' },
            slippageBps: { type: 'number' },
            priorityFeeSol: { type: 'number' },
            minBuyers5m: { type: 'number' },
            minVolume5m: { type: 'number' },
            evalIntervalMs: { type: 'number' },
            maxTokenAgeMs: { type: 'number' },
          },
        },
        riskLevel: 'write',
      },

      {
        name: 'start_auto_analysis',
        description: 'Start automatic AI batch analysis. Every N new tokens (default: 50), the system collects their market data and sends them to the AI for a deep-dive analysis to find potential moonshot tokens. Results are emitted as trenches:ai_pick events.',
        parameters: {
          type: 'object',
          properties: {
            batchSize: { type: 'number', description: 'Number of tokens to accumulate before running AI analysis (default: 50)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'stop_auto_analysis',
        description: 'Stop automatic AI batch analysis of new tokens.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_auto_analysis_status',
        description: 'Get auto-analysis status: enabled, buffer size, batches run, tokens analyzed, picks found.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private coreConn: NatsConn = this.makeNatsConn('core', NATS_CORE);
  private unifiedConn: NatsConn = this.makeNatsConn('unified', NATS_UNIFIED);
  private eventBus!: EventBusInterface;
  private logger!: LoggerInterface;
  private ctx!: SkillContext;
  private pumpSdk!: OnlinePumpSdk;
  private filters: { requireSocials?: boolean; nameBlacklist?: RegExp[] } = {};
  private stats = { tokensReceived: 0, tokensEmitted: 0, tokensFiltered: 0, tradeEventsReceived: 0 };

  private pumpApiStats = {
    totalRequests: 0,
    successCount: 0,
    failCount: 0,
    avgLatencyMs: 0,
    _latencySum: 0,
    _latencyCount: 0,
    lastError: '' as string,
    lastErrorTs: 0,
    natsConnected: false,
    natsReconnects: 0,
  };
  getPumpApiStats() { return { ...this.pumpApiStats, _latencySum: undefined, _latencyCount: undefined }; }
  private maxReconnects = 10;
  private subscribedTokens = new Set<string>();
  private monitoring = false;

  private trenchesActive = false;
  private trenchesConfig: TrenchesConfig = {
    mode: 'alert',
    metaKeywords: [],
    minScore: 50,
    requireSocials: true,
    buyAmountSol: 0.05,
    slippageBps: 2500,
    priorityFeeSol: 0.001,
    minBuyers5m: 3,
    minVolume5m: 100,
    evalIntervalMs: 15_000,
    maxTokenAgeMs: 120_000,
  };
  private trenchesQueue = new Map<string, TrenchesQueueItem>();
  private trenchesInterval: ReturnType<typeof setInterval> | null = null;
  private trenchesTokenNewHandler: ((data: any) => void) | null = null;
  private trenchesStats = { scanned: 0, queued: 0, evaluated: 0, passed: 0, alerted: 0, bought: 0 };
  private trenchesRecentAlerts: Array<{ mint: string; name: string; symbol: string; score: number; reason: string; timestamp: number }> = [];
  private cachedMetas: { data: any; fetchedAt: number } | null = null;

  private trendContext: TrendContext | null = null;

  setTrendContext(tc: TrendContext): void {
    this.trendContext = tc;
    this.logger?.info('[PumpMonitor] TrendContext attached for narrative scoring');
  }

  private autoAnalysisEnabled = false;
  private autoAnalysisBatchSize = 50;
  private autoAnalysisBuffer: Array<{ mint: string; name: string; symbol: string; dev: string; description?: string; twitter?: string; telegram?: string; website?: string; mcap: number; addedAt: number }> = [];
  private autoAnalysisHandler: ((data: any) => void) | null = null;
  private autoAnalysisStats = { batchesRun: 0, tokensAnalyzed: 0, picksFound: 0 };
  private autoAnalysisRunning = false;

  private makeNatsConn(name: string, config: { url: string; user: string; pass: string }): NatsConn {
    return { ws: null, name, config, reconnectTimer: null, reconnectAttempts: 0, nextSid: 1, subs: new Map(), buffer: '' };
  }

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;

    const rpcUrl = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    this.pumpSdk = new OnlinePumpSdk(connection);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'start_monitoring':
        return this.startMonitoring(params.filters);
      case 'stop_monitoring':
        return this.stopMonitoring();
      case 'get_token_info':
        return this.getTokenInfo(params.mint);
      case 'get_new_tokens':
        return this.getNewTokens(params.limit, params.offset);
      case 'get_monitor_status':
        return this.getStatus();
      case 'search_tokens_by_creator':
        return this.searchByCreator(params.wallet, params.limit, params.offset);
      case 'search_tokens_by_name':
        return this.searchByName(params.query, params.limit, params.offset);
      case 'get_trending_tokens':
        return this.getTrending(params.limit, params.offset);
      case 'get_token_trades':
        return this.getTokenTrades(params.mint, params.limit, params.offset);
      case 'get_token_comments':
        return this.getTokenComments(params.mint, params.limit, params.offset);
      case 'get_dev_profile':
        return this.getDevProfile(params.wallet);
      case 'subscribe_token_trades':
        return this.subscribeTokenTrades(params.mint);
      case 'search_tokens_by_mcap':
        return this.searchByMcap(params.minMcap, params.maxMcap, params.limit, params.sort, params.order);
      case 'get_graduated_tokens':
        return this.getGraduatedTokens(params.limit, params.offset);
      case 'get_top_holders':
        return this.getTopHolders(params.mint);
      case 'get_market_activity':
        return this.getMarketActivity(params.mint);
      case 'get_token_ath':
        return this.getTokenAth(params.mint);
      case 'get_sol_price':
        return this.getSolPrice();
      case 'get_token_candles':
        return this.getTokenCandles(params.mint, params.interval, params.limit);
      case 'get_king_of_the_hill':
        return this.getKingOfTheHill();
      case 'get_currently_live':
        return this.getCurrentlyLive(params.limit, params.offset);
      case 'get_featured_tokens':
        return this.getFeaturedTokens(params.timeWindow, params.limit, params.offset);
      case 'get_wallet_balances':
        return this.getWalletBalances(params.address, params.limit, params.offset, params.minBalance);
      case 'get_current_metas':
        return this.getCurrentMetas();
      case 'search_by_meta':
        return this.searchByMeta(params.meta);
      case 'get_kol_coins':
        return this.getKolCoins();
      case 'batch_get_coins':
        return this.batchGetCoins(params.mints);
      case 'batch_enrich_onchain':
        return this.batchEnrichOnChain(params.mints);
      case 'batch_get_market_activity':
        return this.batchGetMarketActivity(params.mints, params.intervals);
      case 'start_trenches':
        return this.startTrenches(params);
      case 'stop_trenches':
        return this.stopTrenches();
      case 'get_trenches_status':
        return this.getTrenchesStatus();
      case 'configure_trenches':
        return this.configureTrenches(params);
      case 'start_auto_analysis':
        return this.startAutoAnalysis(params.batchSize);
      case 'stop_auto_analysis':
        return this.stopAutoAnalysis();
      case 'get_auto_analysis_status':
        return this.getAutoAnalysisStatus();
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopAutoAnalysis();
    this.stopTrenches();
    this.stopMonitoring();
  }


  private startMonitoring(filters?: any): { status: string } {
    if (this.monitoring) {
      return { status: 'already_running' };
    }

    if (filters?.requireSocials) {
      this.filters.requireSocials = true;
    }
    if (filters?.nameBlacklist) {
      this.filters.nameBlacklist = filters.nameBlacklist.map((p: string) => new RegExp(p, 'i'));
    }

    this.monitoring = true;


    this.connectNats(this.coreConn, () => {
      this.natsSub(this.coreConn, SUBJECT_COIN_LIFECYCLE);
    });


    this.connectNats(this.unifiedConn, () => {
      this.natsSub(this.unifiedConn, `${SUBJECT_TRADE}.*`);

      for (const mint of this.subscribedTokens) {
        this.natsSub(this.unifiedConn, `${SUBJECT_TRADE}.${mint}`);
      }
    });

    return { status: 'started' };
  }


  private connectNats(conn: NatsConn, onReady: () => void): void {
    conn.ws = new WebSocket(conn.config.url, { headers: { Origin: 'https://pump.fun' } });
    conn.buffer = '';

    conn.ws.on('open', () => {
      conn.reconnectAttempts = 0;

      const connectPayload = JSON.stringify({
        verbose: false,
        pedantic: false,
        user: conn.config.user,
        pass: conn.config.pass,
        protocol: 1,
        name: `axiom-${conn.name}`,
      });
      conn.ws!.send(`CONNECT ${connectPayload}\r\n`);
      conn.ws!.send('PING\r\n');
      this.pumpApiStats.natsConnected = true;
      this.logger.info(`NATS [${conn.name}] connected`);
      onReady();
    });

    conn.ws.on('message', (data: Buffer) => {
      conn.buffer += data.toString();
      this.parseNatsBuffer(conn);
    });

    conn.ws.on('close', () => {
      this.pumpApiStats.natsConnected = false;
      this.logger.warn(`NATS [${conn.name}] disconnected`);
      this.scheduleNatsReconnect(conn, onReady);
    });

    conn.ws.on('error', (err) => {
      this.logger.error(`NATS [${conn.name}] error`, err.message);
    });
  }

  private natsSub(conn: NatsConn, subject: string): number {
    const sid = conn.nextSid++;
    conn.subs.set(sid, subject);
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(`SUB ${subject} ${sid}\r\n`);
    }
    return sid;
  }

  private parseNatsBuffer(conn: NatsConn): void {
    while (true) {
      const idx = conn.buffer.indexOf('\r\n');
      if (idx === -1) break;

      const line = conn.buffer.substring(0, idx);

      if (line.startsWith('MSG ')) {

        const parts = line.split(' ');
        const numBytes = parseInt(parts[parts.length - 1], 10);
        const payloadStart = idx + 2;
        const payloadEnd = payloadStart + numBytes;


        if (conn.buffer.length < payloadEnd + 2) break;

        const subject = parts[1];
        const payload = conn.buffer.substring(payloadStart, payloadEnd);
        conn.buffer = conn.buffer.substring(payloadEnd + 2);

        this.handleNatsMsg(conn.name, subject, payload);
        continue;
      }


      conn.buffer = conn.buffer.substring(idx + 2);

      if (line === 'PING') {
        conn.ws?.send('PONG\r\n');
      } else if (line.startsWith('-ERR')) {
        this.logger.error(`NATS [${conn.name}] server error: ${line}`);
      }
    }
  }

  private handleNatsMsg(server: string, subject: string, payload: string): void {
    try {
      if (subject === SUBJECT_COIN_LIFECYCLE) {
        const msg = JSON.parse(payload);
        this.handleCoinLifecycle(msg);
      } else if (subject.startsWith(SUBJECT_TRADE)) {

        let trade: any;
        try {
          const inner = JSON.parse(payload);
          trade = typeof inner === 'string' ? JSON.parse(inner) : inner;
        } catch {
          trade = JSON.parse(payload);
        }
        this.handleTradeEvent(subject, trade);
      }
    } catch (err) {
      this.logger.debug(`Failed to parse NATS msg on ${subject}`);
    }
  }


  private handleCoinLifecycle(msg: any): void {

    if (msg.event_type === 1 && msg.after) {
      const d = msg.after;
      this.stats.tokensReceived++;

      const hasSocials = !!(d.twitter || d.telegram || d.website);
      if (this.filters.requireSocials && !hasSocials) {
        this.stats.tokensFiltered++;
        return;
      }

      if (this.filters.nameBlacklist) {
        const name = `${d.name || ''} ${d.symbol || ''}`;
        for (const pattern of this.filters.nameBlacklist) {
          if (pattern.test(name)) {
            this.stats.tokensFiltered++;
            return;
          }
        }
      }

      this.stats.tokensEmitted++;


      const KNOWN_PROGRAMS = [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        '11111111111111111111111111111111',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      ];
      const rawCreator = d.creator || d.user || '';
      const devWallet = KNOWN_PROGRAMS.includes(rawCreator) ? (d.user || d.deployer || '') : rawCreator;

      const tokenInfo: TokenInfo = {
        mint: d.mint,
        name: d.name || 'Unknown',
        symbol: d.symbol || '???',
        description: d.description,
        image: d.image_uri,
        twitter: d.twitter,
        telegram: d.telegram,
        website: d.website,
        dev: devWallet,
        createdAt: d.created_timestamp || Date.now(),
        bondingCurveProgress: 0,
        marketCap: d.market_cap || 0,
        volume24h: 0,
        holders: 1,
        price: 0,
      };

      this.ctx.memory.storeToken(tokenInfo);

      this.eventBus.emit('token:new', {
        mint: d.mint,
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        dev: tokenInfo.dev,
        timestamp: Date.now(),
      });
    }


    if (msg.event_type === 4 && (msg.before || msg.after)) {
      const d = msg.before || msg.after;
      this.eventBus.emit('token:graduated', {
        mint: d.mint,
        dex: 'pump.fun',
        timestamp: Date.now(),
      });
    }
  }

  private handleTradeEvent(_subject: string, trade: any): void {
    const mint = trade.mintAddress || trade.mint;
    if (!mint) return;

    this.stats.tradeEventsReceived++;

    const isBuy = trade.type === 'buy' || trade.isBuy === true || (trade.tokenAmount && parseFloat(trade.tokenAmount) > 0 && !trade.type);
    const solAmount = trade.amountSol ? parseFloat(trade.amountSol) : (trade.solAmount ? parseFloat(trade.solAmount) / 1e9 : 0);
    const mcap = trade.marketCap ? parseFloat(trade.marketCap) : 0;
    const priceUsd = trade.priceUsd ? parseFloat(trade.priceUsd) : 0;

    this.ctx.memory.storeSnapshot({
      mint,
      price: priceUsd,
      mcap,
      volume5m: 0,
      volume1h: 0,
      volume24h: 0,
      holders: 0,
      bondingProgress: trade.isBondingCurve ? 50 : 100,
      timestamp: Date.now(),
    });

    this.eventBus.emit('token:trade', {
      mint,
      txType: isBuy ? 'buy' as const : 'sell' as const,
      solAmount,
      tokenAmount: trade.tokenAmount ? parseFloat(trade.tokenAmount) : 0,
      wallet: trade.traderPublicKey || trade.wallet || '',
      price: priceUsd,
      mcap,
      bondingProgress: trade.isBondingCurve ? 50 : 100,
      timestamp: Date.now(),
    });
  }

  private stopMonitoring(): { status: string } {
    this.monitoring = false;
    this.closeNats(this.coreConn);
    this.closeNats(this.unifiedConn);
    this.subscribedTokens.clear();
    this.logger.info('pump.fun NATS monitoring stopped');
    return { status: 'stopped' };
  }

  private closeNats(conn: NatsConn): void {
    if (conn.ws) {
      conn.ws.close();
      conn.ws = null;
    }
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    conn.subs.clear();
    conn.buffer = '';
  }

  private scheduleNatsReconnect(conn: NatsConn, onReady: () => void): void {
    if (!this.monitoring) return;
    if (conn.reconnectAttempts >= this.maxReconnects) {
      this.logger.error(`NATS [${conn.name}] max reconnect attempts reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30_000);
    conn.reconnectAttempts++;

    conn.reconnectTimer = setTimeout(() => {
      this.pumpApiStats.natsReconnects++;
      this.logger.info(`NATS [${conn.name}] reconnecting (attempt ${conn.reconnectAttempts})...`);
      this.connectNats(conn, onReady);
    }, delay);
  }


  private async pumpFetch(url: string, opts?: RequestInit): Promise<Response> {
    const endpoint = url.split('?')[0].replace(/https:\/\/[^/]+\//, '');
    this.pumpApiStats.totalRequests++;
    const t0 = Date.now();
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Origin': 'https://pump.fun',
      'Referer': 'https://pump.fun/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(opts?.headers as Record<string, string> || {}),
    };
    try {
      const res = await fetch(url, { ...opts, headers });
      const ms = Date.now() - t0;
      this.pumpApiStats._latencySum += ms; this.pumpApiStats._latencyCount++;
      this.pumpApiStats.avgLatencyMs = Math.round(this.pumpApiStats._latencySum / this.pumpApiStats._latencyCount);
      if (res.ok) {
        this.pumpApiStats.successCount++;
        this.logger?.debug(`[Pump] ✓ ${endpoint} ${res.status} ${ms}ms`);
      } else {
        this.pumpApiStats.failCount++;
        this.pumpApiStats.lastError = `${res.status} ${endpoint}`;
        this.pumpApiStats.lastErrorTs = Date.now();
        this.logger?.warn(`[Pump] ✗ ${endpoint} ${res.status} ${ms}ms`);
      }
      return res;
    } catch (err: any) {
      const ms = Date.now() - t0;
      this.pumpApiStats.failCount++;
      this.pumpApiStats.lastError = `${err.message} ${endpoint}`;
      this.pumpApiStats.lastErrorTs = Date.now();
      this.logger?.warn(`[Pump] ✗ ${endpoint} ERR ${ms}ms: ${err.message}`);
      throw err;
    }
  }


  private async getTokenInfo(mint: string): Promise<any> {
    try {

      const res = await this.pumpFetch(`${PUMP_API_URL}/coins-v2/${mint}`);
      if (!res.ok) {
        return { error: `Failed to fetch token info: ${res.status}` };
      }

      const data = await res.json() as PumpToken;
      const token = this.pumpTokenToInfo(data);


      let onChainData: any = {};
      try {
        const mintPk = new PublicKey(mint);
        const bc = await this.pumpSdk.fetchBondingCurve(mintPk);
        const virtualSolReserves = bc.virtualSolReserves.toNumber() / 1e9;
        const virtualTokenReserves = bc.virtualTokenReserves.toNumber() / 1e6;
        const realSolReserves = bc.realSolReserves.toNumber() / 1e9;
        const realTokenReserves = bc.realTokenReserves.toNumber() / 1e6;
        const totalSupply = bc.tokenTotalSupply.toNumber() / 1e6;
        const tokensInCurve = realTokenReserves;
        const tokensSold = totalSupply - tokensInCurve;

        const mcapLamports = bondingCurveMarketCap({
          mintSupply: bc.tokenTotalSupply,
          virtualSolReserves: bc.virtualSolReserves,
          virtualTokenReserves: bc.virtualTokenReserves,
        }).toNumber();

        onChainData = {
          onChain: {
            virtualSolReserves: +virtualSolReserves.toFixed(4),
            virtualTokenReserves: +virtualTokenReserves.toFixed(0),
            realSolReserves: +realSolReserves.toFixed(4),
            realTokenReserves: +realTokenReserves.toFixed(0),
            totalSupply: +totalSupply.toFixed(0),
            tokensSold: +tokensSold.toFixed(0),
            tokensSoldPct: +((tokensSold / totalSupply) * 100).toFixed(2),
            marketCapLamports: mcapLamports,
            marketCapSOL: +(mcapLamports / 1e9).toFixed(4),
            complete: bc.complete,
            creator: bc.creator.toBase58(),
            graduated: bc.complete,
            bondingCurveAddress: bondingCurvePda(mintPk).toBase58(),
          },
        };


        token.bondingCurveProgress = bc.complete ? 100 : Math.min((realSolReserves / 85) * 100, 100);
        token.price = virtualTokenReserves > 0 ? virtualSolReserves / virtualTokenReserves : 0;
      } catch {
      }

      this.ctx.memory.storeToken(token);


      let enrichment: any = {};
      try {
        const program = data.program || 'pump';
        const [athRes, activityRes, holdersRes] = await Promise.allSettled([
          this.pumpFetch(`${SWAP_API_URL}/v1/coins/${mint}/ath?currency=USD&program=${program}`),
          this.pumpFetch(`${SWAP_API_URL}/v1/coins/${mint}/market-activity?program=${program}`),
          this.pumpFetch(`${ADVANCED_API_URL}/coins/top-holders-and-sol-balance/${mint}`),
        ]);

        if (athRes.status === 'fulfilled' && athRes.value.ok) {
          const ath = await athRes.value.json() as any;
          enrichment.athMarketCap = ath.athMarketCap || data.ath_market_cap || 0;
        }

        if (activityRes.status === 'fulfilled' && activityRes.value.ok) {
          enrichment.marketActivity = await activityRes.value.json() as any;
        }

        if (holdersRes.status === 'fulfilled' && holdersRes.value.ok) {
          const holdersData = await holdersRes.value.json() as any;
          enrichment.topHolders = (holdersData.topHolders || []).map((h: any) => ({
            address: h.address,
            tokenAmount: h.amount,
            solBalance: h.solBalance,
            pctHeld: data.total_supply ? +((h.amount / (data.total_supply / 1e6)) * 100).toFixed(2) : 0,
          }));
          enrichment.totalHolders = (holdersData.totalHolders || []).length;
        }
      } catch {  }

      return { ...token, ...onChainData, ...enrichment };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async getNewTokens(limit: number = 20, offset: number = 0): Promise<TokenInfo[]> {
    try {
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins?offset=${offset}&limit=${Math.min(limit, 50)}&sort=created_timestamp&order=DESC&includeNsfw=false`
      );
      if (!res.ok) return [];

      const data = await res.json() as PumpToken[];
      return data.map(d => this.pumpTokenToInfo(d));
    } catch {
      return [];
    }
  }


  private async searchByCreator(wallet: string, limit: number = 20, offset: number = 0): Promise<any> {
    try {
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins-v2/user-created-coins/${wallet}?offset=${offset}&limit=${Math.min(limit, 50)}&includeNsfw=false`
      );
      if (!res.ok) {
        return { error: `Failed to fetch creator coins: ${res.status}`, wallet };
      }

      const body = await res.json() as any;
      const data: PumpToken[] = body.coins ?? body;
      const tokens = data.map(d => this.pumpTokenToInfo(d));

      return {
        wallet,
        totalFound: body.count ?? tokens.length,
        tokens,
      };
    } catch (err: any) {
      return { error: err.message, wallet };
    }
  }


  private async searchByName(query: string, limit: number = 20, offset: number = 0): Promise<any> {
    try {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(Math.min(limit, 50)),
        sort: 'market_cap',
        order: 'DESC',
        includeNsfw: 'false',
        searchTerm: query,
      });

      const res = await this.pumpFetch(`${PUMP_API_URL}/coins?${params}`);
      if (!res.ok) {
        return { error: `Search failed: ${res.status}`, query };
      }

      const data = await res.json() as PumpToken[];
      const tokens = data.map(d => this.pumpTokenToInfo(d));

      return {
        query,
        totalFound: tokens.length,
        tokens,
      };
    } catch (err: any) {
      return { error: err.message, query };
    }
  }


  private async getTrending(limit: number = 20, offset: number = 0): Promise<any> {
    try {
      const safeOffset = offset || 0;
      const safeLimit = limit || 20;

      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins/top-runners`
      );
      if (res.ok) {
        const data = await res.json() as any[];
        const items = data.slice(safeOffset, safeOffset + safeLimit);


        if (items.length > 0 && items[0].mint && !items[0].virtual_sol_reserves && !items[0].name) {
          const mints = items.map((item: any) => item.mint);
          try {
                        const batchRes = await this.pumpFetch(`${ADVANCED_API_URL}/coins/mints`, {
                            method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mints }),
            });
            if (batchRes.ok) {
              const fullCoins = await batchRes.json() as PumpToken[];
              return {
                source: 'top_runners',
                tokens: fullCoins.map(d => this.pumpTokenToInfo(d)),
              };
            }
          } catch {  }
        }

        const tokens = items.map((item: any) => {
          const d = item.coin || item;
          return this.pumpTokenToInfo(d);
        });
        return { source: 'top_runners', tokens };
      }


      const fallbackRes = await this.pumpFetch(
        `${PUMP_API_URL}/coins?offset=${offset}&limit=${Math.min(limit, 50)}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`
      );
      if (!fallbackRes.ok) return { error: `Trending fetch failed: ${res.status}`, tokens: [] };

      const fallbackData = await fallbackRes.json() as PumpToken[];
      return {
        source: 'last_trade',
        tokens: fallbackData.map(d => this.pumpTokenToInfo(d)),
      };
    } catch (err: any) {
      return { error: err.message, tokens: [] };
    }
  }


  private async getTokenTrades(mint: string, limit: number = 30, offset: number = 0): Promise<any> {
    try {

      const res = await this.pumpFetch(
        `${SWAP_API_URL}/v2/coins/${mint}/trades?limit=${Math.min(limit, 100)}&cursor=${offset}&minSolAmount=0&program=pump`
      );
      if (!res.ok) {
        return { error: `Failed to fetch trades: ${res.status}`, mint };
      }

      const body = await res.json() as any;
      const data = body.trades || body;

      const trades = (Array.isArray(data) ? data : []).map((t: any) => ({
        signature: t.tx || t.signature,
        type: t.type || (t.is_buy ? 'buy' : 'sell'),
        solAmount: t.amountSol ? parseFloat(t.amountSol) : (t.sol_amount || 0) / 1e9,
        usdAmount: t.amountUsd ? parseFloat(t.amountUsd) : 0,
        tokenAmount: t.baseAmount ? parseFloat(t.baseAmount) : (t.token_amount || 0),
        wallet: t.userAddress || t.user,
        timestamp: t.timestamp ? new Date(t.timestamp).getTime() : 0,
        priceUsd: t.priceUSD ? parseFloat(t.priceUSD) : 0,
        priceSol: t.priceSOL ? parseFloat(t.priceSOL) : 0,
      }));

      const buys = trades.filter(t => t.type === 'buy');
      const sells = trades.filter(t => t.type === 'sell');
      const totalBuyVolume = buys.reduce((s, t) => s + t.solAmount, 0);
      const totalSellVolume = sells.reduce((s, t) => s + t.solAmount, 0);

      return {
        mint,
        tradeCount: trades.length,
        buys: buys.length,
        sells: sells.length,
        buyVolumeSOL: +totalBuyVolume.toFixed(4),
        sellVolumeSOL: +totalSellVolume.toFixed(4),
        buyPressure: trades.length > 0 ? +(buys.length / trades.length).toFixed(3) : 0,
        uniqueWallets: new Set(trades.map(t => t.wallet)).size,
        trades,
      };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getTokenComments(mint: string, limit: number = 30, offset: number = 0): Promise<any> {
    try {
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/replies/${mint}?limit=${Math.min(limit, 100)}&offset=${offset}`
      );
      if (!res.ok) {
        return { error: `Failed to fetch comments: ${res.status}`, mint };
      }

      const data = await res.json() as PumpComment[];

      const comments = data.map(c => ({
        user: c.user,
        text: c.text,
        timestamp: c.timestamp,
      }));

      return {
        mint,
        commentCount: comments.length,
        comments,
      };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getDevProfile(wallet: string): Promise<any> {
    try {

      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins-v2/user-created-coins/${wallet}?offset=0&limit=50&includeNsfw=true`
      );
      if (!res.ok) {
        return { error: `Failed to fetch dev profile: ${res.status}`, wallet };
      }

      const body = await res.json() as any;
      const allTokens: PumpToken[] = body.coins ?? body;

      if (allTokens.length === 0) {
        return {
          wallet,
          totalTokensCreated: 0,
          reputation: 'unknown',
          warning: 'No tokens found for this wallet',
        };
      }


      let graduated = 0;
      let totalMcapUsd = 0;
      let hasPool = 0;
      const mcaps: number[] = [];
      const timestamps: number[] = [];

      for (const t of allTokens) {
        const mcap = t.usd_market_cap || t.market_cap || 0;
        totalMcapUsd += mcap;
        mcaps.push(mcap);
        timestamps.push(t.created_timestamp);

        if (t.complete || t.pool_address) {
          graduated++;
          hasPool++;
        }
      }

      mcaps.sort((a, b) => b - a);
      const avgMcap = totalMcapUsd / allTokens.length;
      const medianMcap = mcaps[Math.floor(mcaps.length / 2)] || 0;
      const graduationRate = allTokens.length > 0 ? graduated / allTokens.length : 0;


      const now = Date.now();
      const last24h = allTokens.filter(t => (now - t.created_timestamp) < 86400_000).length;
      const last7d = allTokens.filter(t => (now - t.created_timestamp) < 604800_000).length;


      let reputationScore = 50;
      if (allTokens.length > 20) reputationScore -= 15;
      if (allTokens.length > 50) reputationScore -= 20;
      if (graduationRate > 0.1) reputationScore += 20;
      if (graduationRate > 0.3) reputationScore += 15;
      if (avgMcap > 50_000) reputationScore += 10;
      if (last24h > 5) reputationScore -= 20;
      if (last24h > 10) reputationScore -= 15;
      reputationScore = Math.max(0, Math.min(100, reputationScore));

      let reputation: string;
      if (reputationScore >= 70) reputation = 'trusted';
      else if (reputationScore >= 50) reputation = 'neutral';
      else if (reputationScore >= 30) reputation = 'suspicious';
      else reputation = 'high_risk';

      const warnings: string[] = [];
      if (allTokens.length > 20) warnings.push(`Serial launcher: ${allTokens.length} tokens created`);
      if (last24h > 5) warnings.push(`${last24h} tokens in last 24h - spam pattern`);
      if (graduationRate < 0.05 && allTokens.length > 5) warnings.push('Very low graduation rate - possible rug pattern');

      return {
        wallet,
        totalTokensCreated: allTokens.length,
        graduated,
        graduationRate: +(graduationRate * 100).toFixed(1) + '%',
        avgMcapUsd: +avgMcap.toFixed(0),
        medianMcapUsd: +medianMcap.toFixed(0),
        topMcapUsd: mcaps[0] || 0,
        tokensLast24h: last24h,
        tokensLast7d: last7d,
        reputationScore,
        reputation,
        warnings,
        recentTokens: allTokens.slice(0, 5).map(t => ({
          mint: t.mint,
          name: t.name,
          symbol: t.symbol,
          mcap: t.usd_market_cap || t.market_cap || 0,
          graduated: !!(t.complete || t.pool_address),
          created: t.created_timestamp,
        })),
      };
    } catch (err: any) {
      return { error: err.message, wallet };
    }
  }


  private subscribeTokenTrades(mint: string): { status: string; mint: string } {
    this.subscribedTokens.add(mint);


    if (!this.unifiedConn.ws || this.unifiedConn.ws.readyState !== WebSocket.OPEN) {
      this.connectNats(this.unifiedConn, () => {
        this.natsSub(this.unifiedConn, `${SUBJECT_TRADE}.${mint}`);
      });
    } else {
      this.natsSub(this.unifiedConn, `${SUBJECT_TRADE}.${mint}`);
    }

    this.logger.info(`Subscribed to NATS trades for ${mint.slice(0, 8)}...`);
    return { status: 'subscribed', mint };
  }


  private async searchByMcap(
    minMcap: number = 0,
    maxMcap?: number,
    limit: number = 20,
    sort: string = 'market_cap',
    order: string = 'DESC'
  ): Promise<any> {
    try {
      const allowedSorts = ['market_cap', 'created_timestamp', 'last_trade_timestamp'];
      const safeSort = allowedSorts.includes(sort) ? sort : 'market_cap';
      const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';


      const fetchLimit = Math.min(Math.max(limit * 3, 50), 200);
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins?offset=0&limit=${fetchLimit}&sort=${safeSort}&order=${safeOrder}&includeNsfw=false`
      );
      if (!res.ok) {
        return { error: `Search failed: ${res.status}` };
      }

      const data = await res.json() as PumpToken[];

      const filtered = data.filter(d => {
        const mcap = d.usd_market_cap || d.market_cap || 0;
        if (mcap < minMcap) return false;
        if (maxMcap !== undefined && mcap > maxMcap) return false;
        return true;
      });

      const tokens = filtered.slice(0, limit).map(d => this.pumpTokenToInfo(d));

      return {
        minMcap,
        maxMcap: maxMcap ?? 'unlimited',
        totalFound: tokens.length,
        tokens,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getGraduatedTokens(limit: number = 20, offset: number = 0): Promise<any> {
    try {

      const res = await this.pumpFetch(`${ADVANCED_API_URL}/coins/graduated`);
      if (!res.ok) {

        const fallback = await this.pumpFetch(
          `${PUMP_API_URL}/coins?offset=${offset}&limit=${Math.min(limit, 50)}&sort=last_trade_timestamp&order=DESC&complete=true&includeNsfw=false`
        );
        if (!fallback.ok) return { error: `Failed to fetch graduated tokens: ${fallback.status}` };
        const data = await fallback.json() as PumpToken[];
        return {
          description: 'Tokens that graduated from bonding curve to pump.fun AMM pools',
          totalFound: data.length,
          tokens: data.filter(d => d.complete || d.pool_address).slice(0, limit).map(d => ({
            ...this.pumpTokenToInfo(d),
            graduated: true,
            poolAddress: d.pool_address || null,
          })),
        };
      }

      const data = await res.json() as any[];
      const tokens = data
        .filter(d => d.complete || d.pool_address)
        .map(d => ({
          ...this.pumpTokenToInfo(d),
          graduated: true,
          poolAddress: d.pool_address || null,
        }));

      return {
        description: 'Tokens that graduated from bonding curve to pump.fun AMM pools',
        totalFound: tokens.length,
        tokens,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getTopHolders(mint: string): Promise<any> {
    try {
      const res = await this.pumpFetch(`${ADVANCED_API_URL}/coins/top-holders-and-sol-balance/${mint}`);
      if (!res.ok) return { error: `Failed to fetch holders: ${res.status}`, mint };

      const data = await res.json() as any;
      const holders = (data.topHolders || []).map((h: any) => ({
        address: h.address,
        tokenAmount: h.amount,
        solBalance: h.solBalance,
      }));

      return {
        mint,
        totalHolderAddresses: (data.totalHolders || []).length,
        topHolders: holders,
      };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getMarketActivity(mint: string): Promise<any> {
    try {
      const res = await this.pumpFetch(`${SWAP_API_URL}/v1/coins/${mint}/market-activity?program=pump`);
      if (!res.ok) return { error: `Failed to fetch activity: ${res.status}`, mint };

      const data = await res.json() as any;
      return { mint, ...data };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getTokenAth(mint: string): Promise<any> {
    try {
      const res = await this.pumpFetch(`${SWAP_API_URL}/v1/coins/${mint}/ath?currency=USD&program=pump`);
      if (!res.ok) return { error: `Failed to fetch ATH: ${res.status}`, mint };

      const data = await res.json() as any;
      return { mint, athMarketCapUsd: data.athMarketCap || 0 };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getSolPrice(): Promise<any> {
    try {
      const res = await this.pumpFetch(`${PUMP_API_URL}/sol-price`);
      if (!res.ok) return { error: `Failed to fetch SOL price: ${res.status}` };

      const data = await res.json() as any;
      return { solPrice: data.solPrice || 0, source: 'pump.fun' };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getTokenCandles(mint: string, interval: string = '5m', limit: number = 60): Promise<any> {
    try {
      const allowed = ['1m', '5m', '15m', '1h'];
      const safeInterval = allowed.includes(interval) ? interval : '5m';
      const safeLimit = Math.min(Math.max(limit, 1), 1000);

      const res = await this.pumpFetch(
        `${SWAP_API_URL}/v2/coins/${mint}/candles?interval=${safeInterval}&limit=${safeLimit}&currency=USD&program=pump`
      );
      if (!res.ok) return { error: `Failed to fetch candles: ${res.status}`, mint };

      const candles = await res.json() as any[];

      return {
        mint,
        interval: safeInterval,
        candleCount: candles.length,
        candles: candles.slice(-limit),
      };
    } catch (err: any) {
      return { error: err.message, mint };
    }
  }


  private async getKingOfTheHill(): Promise<any> {
    try {
      const res = await this.pumpFetch(`${PUMP_API_URL}/coins/king-of-the-hill?includeNsfw=false`);
      if (!res.ok) return { error: `Failed to fetch king of the hill: ${res.status}` };

      const data = await res.json() as PumpToken;
      return {
        description: 'Current King of the Hill — highest mcap token approaching graduation',
        token: this.pumpTokenToInfo(data),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getCurrentlyLive(limit: number = 20, offset: number = 0): Promise<any> {
    try {
      const safeLimit = Math.min(Math.max(limit, 1), 50);
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins/currently-live?limit=${safeLimit}&offset=${offset}&includeNsfw=false`
      );
      if (!res.ok) return { error: `Failed to fetch currently live tokens: ${res.status}` };

      const data = await res.json() as PumpToken[];
      return {
        description: 'Tokens with active livestreams on pump.fun',
        totalFound: data.length,
        tokens: data.map(d => this.pumpTokenToInfo(d)),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getFeaturedTokens(timeWindow: string = '1h', limit: number = 20, offset: number = 0): Promise<any> {
    try {
      const allowed = ['1h', '6h', '24h'];
      const safeWindow = allowed.includes(timeWindow) ? timeWindow : '1h';
      const safeLimit = Math.min(Math.max(limit, 1), 50);


      const res = await this.pumpFetch(
        `${PUMP_API_URL}/coins/featured/${safeWindow}?limit=${safeLimit}&offset=${offset}&includeNsfw=false`
      );
      if (res.ok) {
        const data = await res.json() as PumpToken[];
        return {
          timeWindow: safeWindow,
          tokens: data.map(d => this.pumpTokenToInfo(d)),
        };
      }


      const sortMap: Record<string, string> = { '1h': 'last_trade_timestamp', '6h': 'last_trade_timestamp', '24h': 'market_cap' };
      const fallbackRes = await this.pumpFetch(
        `${PUMP_API_URL}/coins?offset=${offset}&limit=${safeLimit}&sort=${sortMap[safeWindow] || 'last_trade_timestamp'}&order=DESC&includeNsfw=false`
      );
      if (!fallbackRes.ok) return { error: `Featured fetch failed: ${res.status} / ${fallbackRes.status}`, tokens: [] };

      const fallbackData = await fallbackRes.json() as PumpToken[];
      return {
        timeWindow: safeWindow,
        tokens: fallbackData.map(d => this.pumpTokenToInfo(d)),
      };
    } catch (err: any) {
      return { error: err.message, tokens: [] };
    }
  }


  private async getWalletBalances(address: string, limit: number = 50, offset: number = 0, minBalance: number = 0): Promise<any> {
    try {
      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/balances/${address}?limit=${safeLimit}&offset=${offset}&minBalance=${minBalance}`
      );
      if (!res.ok) return { error: `Failed to fetch wallet balances: ${res.status}`, address };

      const data = await res.json() as any[];
      return {
        address,
        totalPositions: data.length,
        balances: data,
      };
    } catch (err: any) {
      return { error: err.message, address };
    }
  }


  private async getCurrentMetas(): Promise<any> {
    try {
      const res = await this.pumpFetch(`${PUMP_API_URL}/metas/current`);
      if (!res.ok) return { error: `Failed to fetch current metas: ${res.status}` };

      const data = await res.json() as any;
      return {
        description: 'Currently trending metas/narratives on pump.fun',
        metas: data,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async searchByMeta(meta: string): Promise<any> {
    try {
      const safeMeta = encodeURIComponent(meta.slice(0, 100));
      const res = await this.pumpFetch(
        `${PUMP_API_URL}/metas/search?meta=${safeMeta}&includeNsfw=false`
      );
      if (!res.ok) return { error: `Failed to search by meta: ${res.status}` };

      const data = await res.json() as any;
      return {
        meta,
        results: data,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async getKolCoins(): Promise<any> {
    try {
      const res = await this.pumpFetch(`${ADVANCED_API_URL}/coins/kolscan`);
      if (!res.ok) return { error: `Failed to fetch KOL coins: ${res.status}` };

      const data = await res.json() as any;
      return {
        description: 'Coins tracked by Key Opinion Leaders (KOLs) — high-signal smart money data',
        coins: data,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async batchGetCoins(mints: string[]): Promise<any> {
    try {
      if (!Array.isArray(mints) || mints.length === 0) {
        return { error: 'mints must be a non-empty array of mint addresses' };
      }
      const safeMints = mints.slice(0, 50);
            const res = await this.pumpFetch(`${ADVANCED_API_URL}/coins/mints`, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mints: safeMints }),
      });
      if (!res.ok) return { error: `Failed to batch fetch coins: ${res.status}` };

      const data = await res.json() as any[];
      return {
        requested: safeMints.length,
        found: data.length,
        coins: data,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async batchEnrichOnChain(mints: string[]): Promise<any> {
    if (!Array.isArray(mints) || mints.length === 0) {
      return { requested: 0, found: 0, coins: [] };
    }
    const safeMints = mints.slice(0, 15);
    const rpcUrl = this.ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const coins: any[] = [];

    const tasks = safeMints.map(async (mint) => {
      try {
        const mintPk = new PublicKey(mint);


        const bc = await this.pumpSdk.fetchBondingCurve(mintPk);
        const virtualSolReserves = bc.virtualSolReserves.toNumber() / 1e9;
        const virtualTokenReserves = bc.virtualTokenReserves.toNumber() / 1e6;
        const realSolReserves = bc.realSolReserves.toNumber() / 1e9;
        const totalSupply = bc.tokenTotalSupply.toNumber() / 1e6;

        const mcapLamports = bondingCurveMarketCap({
          mintSupply: bc.tokenTotalSupply,
          virtualSolReserves: bc.virtualSolReserves,
          virtualTokenReserves: bc.virtualTokenReserves,
        }).toNumber();
        const mcapSol = mcapLamports / 1e9;
        const solPrice = getSolPriceUsd() || 130;
        const mcapUsd = mcapSol * solPrice;

        const bondingProgress = bc.complete ? 100 : Math.min((realSolReserves / 85) * 100, 100);


        let numHolders = 0;
        try {
          const largestAccounts = await connection.getTokenLargestAccounts(mintPk);
          numHolders = largestAccounts.value.filter(a => a.uiAmount && a.uiAmount > 0).length;
        } catch {  }

        coins.push({
          mint,
          coinMint: mint,
          marketCap: mcapUsd,
          usd_market_cap: mcapUsd,
          bondingCurveProgress: bondingProgress,
          numHolders,
          holders: numHolders,
          complete: bc.complete,
          source: 'onchain',
        });
      } catch (err: any) {
        this.logger.debug(`[PumpMonitor] On-chain enrich failed for ${mint.slice(0, 8)}: ${err.message}`);
      }
    });


    for (let i = 0; i < tasks.length; i += 5) {
      await Promise.allSettled(tasks.slice(i, i + 5));
    }

    return { requested: safeMints.length, found: coins.length, coins };
  }


  private async batchGetMarketActivity(mints: string[], intervals?: string[]): Promise<any> {
    try {
      if (!Array.isArray(mints) || mints.length === 0) {
        return { error: 'mints must be a non-empty array of mint addresses' };
      }
      const safeMints = mints.slice(0, 50);
      const safeIntervals = (intervals || ['5m', '1h']).filter(i => ['5m', '1h', '6h', '24h'].includes(i));
      const metrics = [
        'numTxs', 'volumeUSD', 'numUsers', 'numBuys', 'numSells',
        'buyVolumeUSD', 'sellVolumeUSD', 'numBuyers', 'numSellers', 'priceChangePercent',
      ];

            const res = await this.pumpFetch(`${SWAP_API_URL}/v1/coins/market-activity/batch`, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: safeMints, intervals: safeIntervals, metrics }),
      });
      if (!res.ok) return { error: `Batch market activity failed: ${res.status}` };

      const data = await res.json() as any;
      return { requested: safeMints.length, intervals: safeIntervals, data };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private startTrenches(params: Record<string, any>): any {
    if (this.trenchesActive) {
      return { status: 'already_running', config: this.trenchesConfig, stats: this.trenchesStats };
    }


    if (params.mode === 'alert' || params.mode === 'auto_buy') this.trenchesConfig.mode = params.mode;
    if (Array.isArray(params.metaKeywords)) this.trenchesConfig.metaKeywords = params.metaKeywords.map((k: string) => k.toLowerCase());
    if (typeof params.minScore === 'number') this.trenchesConfig.minScore = Math.max(0, Math.min(100, params.minScore));
    if (typeof params.requireSocials === 'boolean') this.trenchesConfig.requireSocials = params.requireSocials;
    if (typeof params.buyAmountSol === 'number') this.trenchesConfig.buyAmountSol = params.buyAmountSol;
    if (typeof params.slippageBps === 'number') this.trenchesConfig.slippageBps = params.slippageBps;
    if (typeof params.priorityFeeSol === 'number') this.trenchesConfig.priorityFeeSol = params.priorityFeeSol;
    if (typeof params.minBuyers5m === 'number') this.trenchesConfig.minBuyers5m = params.minBuyers5m;
    if (typeof params.minVolume5m === 'number') this.trenchesConfig.minVolume5m = params.minVolume5m;
    if (typeof params.evalIntervalMs === 'number') this.trenchesConfig.evalIntervalMs = Math.max(5000, params.evalIntervalMs);
    if (typeof params.maxTokenAgeMs === 'number') this.trenchesConfig.maxTokenAgeMs = params.maxTokenAgeMs;


    if (!this.monitoring) {
      this.startMonitoring();
    }


    this.trenchesTokenNewHandler = (data: any) => {
      this.trenchesOnNewToken(data);
    };
    this.eventBus.on('token:new', this.trenchesTokenNewHandler);


    this.trenchesInterval = setInterval(() => {
      this.trenchesEvalCycle().catch(err => {
        this.logger.error('Trenches eval cycle error', err?.message);
      });
    }, this.trenchesConfig.evalIntervalMs);

    this.trenchesActive = true;
    this.trenchesStats = { scanned: 0, queued: 0, evaluated: 0, passed: 0, alerted: 0, bought: 0 };
    this.trenchesRecentAlerts = [];

    this.logger.info(`Trenches started [mode=${this.trenchesConfig.mode}, metas=${this.trenchesConfig.metaKeywords.join(',') || 'ALL'}]`);

    return {
            status: 'started',
      mode: this.trenchesConfig.mode,
      config: this.trenchesConfig,
    };
  }

  private stopTrenches(): any {
    if (!this.trenchesActive) {
      return { status: 'not_running' };
    }

    if (this.trenchesTokenNewHandler) {
      this.eventBus.off('token:new', this.trenchesTokenNewHandler);
      this.trenchesTokenNewHandler = null;
    }

    if (this.trenchesInterval) {
      clearInterval(this.trenchesInterval);
      this.trenchesInterval = null;
    }

    this.trenchesActive = false;
    this.trenchesQueue.clear();

    this.logger.info('Trenches stopped');

    return {
      status: 'stopped',
      stats: this.trenchesStats,
      recentAlerts: this.trenchesRecentAlerts.slice(-10),
    };
  }

  private getTrenchesStatus(): any {
    return {
      active: this.trenchesActive,
      config: this.trenchesConfig,
      queueSize: this.trenchesQueue.size,
      stats: this.trenchesStats,
      recentAlerts: this.trenchesRecentAlerts.slice(-20),
      monitoring: this.monitoring,
    };
  }

  private configureTrenches(params: Record<string, any>): any {
    if (params.mode === 'alert' || params.mode === 'auto_buy') this.trenchesConfig.mode = params.mode;
    if (Array.isArray(params.metaKeywords)) this.trenchesConfig.metaKeywords = params.metaKeywords.map((k: string) => k.toLowerCase());
    if (typeof params.minScore === 'number') this.trenchesConfig.minScore = Math.max(0, Math.min(100, params.minScore));
    if (typeof params.requireSocials === 'boolean') this.trenchesConfig.requireSocials = params.requireSocials;
    if (typeof params.buyAmountSol === 'number') this.trenchesConfig.buyAmountSol = params.buyAmountSol;
    if (typeof params.slippageBps === 'number') this.trenchesConfig.slippageBps = params.slippageBps;
    if (typeof params.priorityFeeSol === 'number') this.trenchesConfig.priorityFeeSol = params.priorityFeeSol;
    if (typeof params.minBuyers5m === 'number') this.trenchesConfig.minBuyers5m = params.minBuyers5m;
    if (typeof params.minVolume5m === 'number') this.trenchesConfig.minVolume5m = params.minVolume5m;
    if (typeof params.maxTokenAgeMs === 'number') this.trenchesConfig.maxTokenAgeMs = params.maxTokenAgeMs;


    if (typeof params.evalIntervalMs === 'number' && this.trenchesActive) {
      this.trenchesConfig.evalIntervalMs = Math.max(5000, params.evalIntervalMs);
      if (this.trenchesInterval) clearInterval(this.trenchesInterval);
      this.trenchesInterval = setInterval(() => {
        this.trenchesEvalCycle().catch(err => {
          this.logger.error('Trenches eval cycle error', err?.message);
        });
      }, this.trenchesConfig.evalIntervalMs);
    }

    return {
      status: 'updated',
      config: this.trenchesConfig,
    };
  }


  private trenchesOnNewToken(data: { mint: string; name: string; symbol: string; dev: string; timestamp: number }): void {
    this.trenchesStats.scanned++;


    const stored = this.ctx.memory.getToken(data.mint);
    const hasSocials = stored ? !!(stored.twitter || stored.telegram || stored.website) : false;
    if (this.trenchesConfig.requireSocials && !hasSocials) return;

    this.trenchesStats.queued++;
    this.trenchesQueue.set(data.mint, {
      mint: data.mint,
      name: data.name,
      symbol: data.symbol,
      dev: data.dev,
      description: stored?.description,
      twitter: stored?.twitter,
      telegram: stored?.telegram,
      website: stored?.website,
      addedAt: Date.now(),
    });
  }


  private async trenchesEvalCycle(): Promise<void> {
    if (this.trenchesQueue.size === 0) return;

    const now = Date.now();
    const batch: TrenchesQueueItem[] = [];


    for (const [mint, item] of this.trenchesQueue) {
      if (now - item.addedAt > this.trenchesConfig.maxTokenAgeMs) {
        this.trenchesQueue.delete(mint);
        continue;
      }
      batch.push(item);
    }

    if (batch.length === 0) return;


    for (const item of batch) {
      this.trenchesQueue.delete(item.mint);
    }

    const mints = batch.map(t => t.mint);


    const [activityResult, metasResult, coinsResult] = await Promise.allSettled([
      this.batchGetMarketActivity(mints, ['5m', '1h']),
      this.fetchCurrentMetasCached(),
      this.batchGetCoins(mints),
    ]);

    const activity: Record<string, any> = {};
    if (activityResult.status === 'fulfilled' && activityResult.value.data) {
      const raw = activityResult.value.data;

      if (typeof raw === 'object') {
        for (const [mint, data] of Object.entries(raw)) {
          activity[mint] = data;
        }
      }
    }

    const currentMetas: string[] = [];
    if (metasResult.status === 'fulfilled' && metasResult.value) {
      const metas = metasResult.value;
      if (Array.isArray(metas)) {
        for (const m of metas) {
          const name = typeof m === 'string' ? m : m?.name || m?.meta || '';
          if (name) currentMetas.push(name.toLowerCase());
        }
      }
    }


    const coinData: Record<string, any> = {};
    if (coinsResult.status === 'fulfilled') {
      const val = coinsResult.value;
      if (val?.coins && Array.isArray(val.coins)) {
        for (const coin of val.coins) {
          const key = coin?.coinMint || coin?.mint;
          if (key) coinData[key] = coin;
        }
        this.logger.debug(`[Trenches] batchGetCoins: ${Object.keys(coinData).length}/${mints.length} coins enriched`);
      } else {
        this.logger.warn(`[Trenches] batchGetCoins unexpected shape: ${JSON.stringify(val).slice(0, 200)}`);
      }
    } else {
      this.logger.warn(`[Trenches] batchGetCoins rejected: ${coinsResult.reason?.message || 'unknown'}`);
    }


    for (const item of batch) {
      this.trenchesStats.evaluated++;
      const tokenActivity = activity[item.mint] || {};
      const coin = coinData[item.mint];
      const score = this.trenchesScoreToken(item, tokenActivity, currentMetas, coin);

      if (score.total >= this.trenchesConfig.minScore) {
        this.trenchesStats.passed++;

        const reason = score.reasons.join('; ');

        if (this.trenchesConfig.mode === 'alert') {
          this.trenchesStats.alerted++;

          const coinMcap = coin?.marketCap || coin?.usd_market_cap || coin?.market_cap || 0;
          const coinBonding = coin?.bondingCurveProgress ?? (coin?.complete ? 100 : 0);
          const coinHolders = Number(coin?.numHolders || coin?.holders) || 0;
          const alert = {
            mint: item.mint,
            name: item.name,
            symbol: item.symbol,
            score: score.total,
            matchedMetas: score.matchedMetas,
            activity: tokenActivity,
            reason,
            timestamp: now,
            mcap: coinMcap,
            bondingProgress: coinBonding,
            holders: coinHolders,
            description: item.description || coin?.description || '',
            twitter: item.twitter || coin?.twitter || '',
            telegram: item.telegram || coin?.telegram || '',
            website: item.website || coin?.website || '',
          };
          this.eventBus.emit('trenches:alert', alert);
          this.trenchesRecentAlerts.push({ mint: item.mint, name: item.name, symbol: item.symbol, score: score.total, reason, timestamp: now });
          if (this.trenchesRecentAlerts.length > 50) this.trenchesRecentAlerts.shift();

          this.logger.info(`🔔 Trenches ALERT: ${item.symbol} (${item.mint.slice(0, 8)}...) score=${score.total} — ${reason}`);

        } else if (this.trenchesConfig.mode === 'auto_buy') {
          this.trenchesStats.bought++;

          this.eventBus.emit('trenches:buy', {
            mint: item.mint,
            name: item.name,
            symbol: item.symbol,
            score: score.total,
            amountSol: this.trenchesConfig.buyAmountSol,
            reason,
            timestamp: now,
          });


          this.eventBus.emit('signal:buy', {
            mint: item.mint,
            score: score.total,
            reason: `[Trenches auto_buy] ${reason}`,
            agentId: 'trenches',
          });

          this.trenchesRecentAlerts.push({ mint: item.mint, name: item.name, symbol: item.symbol, score: score.total, reason: `[AUTO_BUY] ${reason}`, timestamp: now });
          if (this.trenchesRecentAlerts.length > 50) this.trenchesRecentAlerts.shift();

          this.logger.info(`💰 Trenches AUTO-BUY: ${item.symbol} (${item.mint.slice(0, 8)}...) score=${score.total} amount=${this.trenchesConfig.buyAmountSol} SOL — ${reason}`);
        }
      }
    }
  }


  private trenchesScoreToken(
    item: TrenchesQueueItem,
    activity: any,
    currentMetas: string[],
    coin?: any,
  ): { total: number; matchedMetas: string[]; reasons: string[] } {
    let total = 0;
    const reasons: string[] = [];
    const matchedMetas: string[] = [];


    const nameDesc = `${item.name} ${item.symbol} ${item.description || ''}`.toLowerCase();
    if (this.trenchesConfig.metaKeywords.length === 0) {

      for (const meta of currentMetas) {
        if (nameDesc.includes(meta)) {
          matchedMetas.push(meta);
        }
      }
      if (matchedMetas.length > 0) {
        total += Math.min(30, matchedMetas.length * 15);
        reasons.push(`Matches trending metas: ${matchedMetas.join(', ')}`);
      }
    } else {

      for (const kw of this.trenchesConfig.metaKeywords) {
        if (nameDesc.includes(kw)) {
          matchedMetas.push(kw);
        }
      }
      if (matchedMetas.length > 0) {
        total += Math.min(30, matchedMetas.length * 15);
        reasons.push(`Matches keywords: ${matchedMetas.join(', ')}`);
      }
    }


    let socialScore = 0;
    const twitter = item.twitter || coin?.twitter || '';
    const telegram = item.telegram || coin?.telegram || '';
    const website = item.website || coin?.website || '';
    if (twitter) { socialScore += 8; reasons.push('Has Twitter'); }
    if (telegram) { socialScore += 6; reasons.push('Has Telegram'); }
    if (website) { socialScore += 6; reasons.push('Has Website'); }
    total += socialScore;


    const act5m = activity?.['5m'] || {};
    const numBuyers5m = act5m.numBuyers || 0;
    const volumeUSD5m = act5m.volumeUSD || 0;
    const numBuys5m = act5m.numBuys || 0;
    const numSells5m = act5m.numSells || 0;
    const priceChange5m = act5m.priceChangePercent || 0;

    if (numBuyers5m >= this.trenchesConfig.minBuyers5m) {
      total += Math.min(10, numBuyers5m * 2);
      reasons.push(`${numBuyers5m} buyers in 5m`);
    }

    if (volumeUSD5m >= this.trenchesConfig.minVolume5m) {
      total += Math.min(10, Math.floor(volumeUSD5m / 100) * 2);
      reasons.push(`$${volumeUSD5m.toFixed(0)} vol 5m`);
    }

    if (numBuys5m > numSells5m && numBuys5m > 0) {
      const buyPressure = numBuys5m / (numBuys5m + numSells5m);
      if (buyPressure > 0.6) {
        total += 5;
        reasons.push(`Buy pressure ${(buyPressure * 100).toFixed(0)}%`);
      }
    }

    if (priceChange5m > 0) {
      total += Math.min(5, Math.floor(priceChange5m / 10));
      if (priceChange5m > 20) reasons.push(`Price +${priceChange5m.toFixed(0)}% in 5m`);
    }


    const act1h = activity?.['1h'] || {};
    const numBuyers1h = act1h.numBuyers || 0;
    const volumeUSD1h = act1h.volumeUSD || 0;

    if (numBuyers1h > 10) {
      total += 5;
      reasons.push(`${numBuyers1h} buyers in 1h`);
    }
    if (volumeUSD1h > 1000) {
      total += 5;
      reasons.push(`$${volumeUSD1h.toFixed(0)} vol 1h`);
    }


    if (item.description && item.description.length > 20) {
      total += 5;
    }
    if (item.description && item.description.length > 100) {
      total += 5;
      reasons.push('Detailed description');
    }


    if (coin) {
      const mcap = coin.marketCap || coin.usd_market_cap || coin.market_cap || 0;
      const bondPct = coin.bondingCurveProgress ?? 0;
      const holders = Number(coin.numHolders || coin.holders) || 0;
      if (mcap > 10000) { total += 5; reasons.push(`mcap $${(mcap/1000).toFixed(0)}k`); }
      if (bondPct > 50) { total += 5; reasons.push(`bonding ${bondPct.toFixed(0)}%`); }
      else if (bondPct > 20) { total += 3; reasons.push(`bonding ${bondPct.toFixed(0)}%`); }
      if (holders > 50) { total += 5; reasons.push(`${holders} holders`); }
      else if (holders > 10) { total += 2; reasons.push(`${holders} holders`); }
    }


    if (this.trendContext) {
      const narrativeBonus = this.trendContext.scoreNarrativeMatch(
        item.name + ' ' + item.symbol,
        item.description,
      );
      if (narrativeBonus > 0) {
        total += narrativeBonus;
        reasons.push(`Narrative boost +${narrativeBonus} (news/X)`);
      }
      if (this.trendContext.isXTrackerMint(item.mint)) {
        total += 15;
        reasons.push('X Tracker callout +15');
      }
    }

    total = Math.min(100, total);
    return { total, matchedMetas, reasons };
  }


  private async fetchCurrentMetasCached(): Promise<any> {
    const now = Date.now();
    if (this.cachedMetas && now - this.cachedMetas.fetchedAt < 60_000) {
      return this.cachedMetas.data;
    }
    try {
      const res = await this.pumpFetch(`${PUMP_API_URL}/metas/current`);
      if (!res.ok) return this.cachedMetas?.data || [];
      const data = await res.json();
      this.cachedMetas = { data, fetchedAt: now };
      return data;
    } catch {
      return this.cachedMetas?.data || [];
    }
  }


  private startAutoAnalysis(batchSize?: number): any {
    if (this.autoAnalysisEnabled) {
      return { status: 'already_running', bufferSize: this.autoAnalysisBuffer.length, stats: this.autoAnalysisStats };
    }

    if (typeof batchSize === 'number' && batchSize >= 10) {
      this.autoAnalysisBatchSize = Math.min(batchSize, 200);
    }


    if (!this.monitoring) {
      this.startMonitoring();
    }

    this.autoAnalysisHandler = (data: any) => {
      this.autoAnalysisOnNewToken(data);
    };
    this.eventBus.on('token:new', this.autoAnalysisHandler);

    this.autoAnalysisEnabled = true;
    this.autoAnalysisStats = { batchesRun: 0, tokensAnalyzed: 0, picksFound: 0 };
    this.autoAnalysisBuffer = [];

    this.logger.info(`Auto-analysis started [batchSize=${this.autoAnalysisBatchSize}]`);
    return { status: 'started', batchSize: this.autoAnalysisBatchSize };
  }

  private stopAutoAnalysis(): any {
    if (!this.autoAnalysisEnabled) {
      return { status: 'not_running' };
    }

    if (this.autoAnalysisHandler) {
      this.eventBus.off('token:new', this.autoAnalysisHandler);
      this.autoAnalysisHandler = null;
    }

    this.autoAnalysisEnabled = false;
    this.autoAnalysisBuffer = [];

    this.logger.info('Auto-analysis stopped');
    return { status: 'stopped', stats: this.autoAnalysisStats };
  }

  private getAutoAnalysisStatus(): any {
    return {
      enabled: this.autoAnalysisEnabled,
      batchSize: this.autoAnalysisBatchSize,
      bufferSize: this.autoAnalysisBuffer.length,
      isRunning: this.autoAnalysisRunning,
      stats: this.autoAnalysisStats,
    };
  }

  private autoAnalysisOnNewToken(data: { mint: string; name: string; symbol: string; dev: string; timestamp: number }): void {
    const stored = this.ctx.memory.getToken(data.mint);
    this.autoAnalysisBuffer.push({
      mint: data.mint,
      name: data.name,
      symbol: data.symbol,
      dev: data.dev,
      description: stored?.description,
      twitter: stored?.twitter,
      telegram: stored?.telegram,
      website: stored?.website,
      mcap: stored?.marketCap || 0,
      addedAt: Date.now(),
    });

    if (this.autoAnalysisBuffer.length >= this.autoAnalysisBatchSize && !this.autoAnalysisRunning) {
      const batch = this.autoAnalysisBuffer.splice(0, this.autoAnalysisBatchSize);
      this.runAutoAnalysisBatch(batch).catch(err => {
        this.logger.error('Auto-analysis batch error', err?.message);
      });
    }
  }

  private async runAutoAnalysisBatch(batch: typeof this.autoAnalysisBuffer): Promise<void> {
    this.autoAnalysisRunning = true;
    this.autoAnalysisStats.batchesRun++;
    this.autoAnalysisStats.tokensAnalyzed += batch.length;

    try {
      const mints = batch.map(t => t.mint);


      const [activityResult, metasResult] = await Promise.allSettled([
        this.batchGetMarketActivity(mints, ['5m', '1h']),
        this.fetchCurrentMetasCached(),
      ]);

      const activity: Record<string, any> = {};
      if (activityResult.status === 'fulfilled' && activityResult.value.data) {
        const raw = activityResult.value.data;
        if (typeof raw === 'object') {
          for (const [mint, data] of Object.entries(raw)) {
            activity[mint] = data;
          }
        }
      }

      const currentMetas: string[] = [];
      if (metasResult.status === 'fulfilled' && metasResult.value) {
        const metas = metasResult.value;
        if (Array.isArray(metas)) {
          for (const m of metas) {
            const name = typeof m === 'string' ? m : m?.name || m?.meta || '';
            if (name) currentMetas.push(name);
          }
        }
      }


      const scored = batch.map(item => {
        const tokenActivity = activity[item.mint] || {};
        const score = this.trenchesScoreToken(
          { ...item, addedAt: item.addedAt },
          tokenActivity,
          currentMetas.map(m => m.toLowerCase()),
        );
        return { ...item, score: score.total, reasons: score.reasons, matchedMetas: score.matchedMetas, activity: tokenActivity };
      });


      scored.sort((a, b) => b.score - a.score);


      const topN = scored.filter(t => t.score > 20).slice(0, 15);

      if (topN.length === 0) {
        this.logger.info(`Auto-analysis batch #${this.autoAnalysisStats.batchesRun}: ${batch.length} tokens, no standouts`);
        this.autoAnalysisRunning = false;
        return;
      }


      const summary = topN.map((t, i) => {
        const act5m = t.activity?.['5m'] || {};
        const act1h = t.activity?.['1h'] || {};
        return [
          `#${i + 1} ${t.symbol} (${t.name}) — score: ${t.score}/100`,
          `  Mint: ${t.mint}`,
          `  Dev: ${t.dev?.slice(0, 12)}...`,
          `  Socials: ${[t.twitter ? 'Twitter' : '', t.telegram ? 'Telegram' : '', t.website ? 'Website' : ''].filter(Boolean).join(', ') || 'none'}`,
          `  Metas: ${t.matchedMetas.join(', ') || 'none'}`,
          `  5m: ${act5m.numBuyers || 0} buyers, $${(act5m.volumeUSD || 0).toFixed(0)} vol, ${(act5m.priceChangePercent || 0).toFixed(1)}% price`,
          `  1h: ${act1h.numBuyers || 0} buyers, $${(act1h.volumeUSD || 0).toFixed(0)} vol`,
          `  Signals: ${t.reasons.join('; ')}`,
        ].join('\n');
      }).join('\n\n');

      this.autoAnalysisStats.picksFound += topN.length;

      this.eventBus.emit('trenches:ai_pick', {
        analysis: `📊 BATCH ANALYSIS #${this.autoAnalysisStats.batchesRun} — ${batch.length} new tokens scanned\n\nCurrent trending metas: ${currentMetas.slice(0, 10).join(', ')}\n\nTOP CANDIDATES:\n\n${summary}`,
        tokens: topN.map(t => ({ mint: t.mint, name: t.name, symbol: t.symbol, score: t.score })),
        batchSize: batch.length,
        timestamp: Date.now(),
      });


      this.eventBus.emit('agent:chat_request', {
        agentId: 'commander',
        message: `[AUTO-ANALYSIS] Batch #${this.autoAnalysisStats.batchesRun}: ${batch.length} new tokens scanned. ${topN.length} candidates found. Review the trenches:ai_pick event for details. Which tokens look most promising and why?`,
      });

      this.logger.info(`🔎 Auto-analysis batch #${this.autoAnalysisStats.batchesRun}: ${batch.length} tokens → ${topN.length} candidates (top: ${topN[0]?.symbol} score=${topN[0]?.score})`);

    } finally {
      this.autoAnalysisRunning = false;
    }
  }


  private pumpTokenToInfo(data: PumpToken): TokenInfo {
    const solReserves = (data.virtual_sol_reserves || 0) / 1e9;
    const tokenReserves = (data.virtual_token_reserves || 0) / 1e6;
    const price = tokenReserves > 0 ? solReserves / tokenReserves : 0;
    const realSol = (data.real_sol_reserves || 0) / 1e9;
    const bondingProgress = data.complete ? 100 : (realSol > 0 ? Math.min((realSol / 85) * 100, 100) : Math.min((solReserves / 85) * 100, 100));

    return {
      mint: data.mint,
      name: data.name,
      symbol: data.symbol,
      description: data.description,
      image: data.image_uri,
      twitter: data.twitter,
      telegram: data.telegram,
      website: data.website,
      dev: data.creator,
      createdAt: data.created_timestamp,
      bondingCurveProgress: bondingProgress,
      marketCap: data.usd_market_cap || data.market_cap || 0,
      volume24h: 0,
      holders: 0,
      price,
    };
  }

  private getStatus(): any {
    return {
      monitoring: this.monitoring,
      nats: {
        core: {
          connected: this.coreConn.ws?.readyState === WebSocket.OPEN,
          reconnectAttempts: this.coreConn.reconnectAttempts,
          subscriptions: [...this.coreConn.subs.values()],
        },
        unified: {
          connected: this.unifiedConn.ws?.readyState === WebSocket.OPEN,
          reconnectAttempts: this.unifiedConn.reconnectAttempts,
          subscriptions: [...this.unifiedConn.subs.values()],
        },
      },
      subscribedTokens: this.subscribedTokens.size,
      subscribedTokenList: [...this.subscribedTokens],
      ...this.stats,
    };
  }
}
