import { Skill, SkillManifest, SkillContext, TradeIntent, TradeResult, LoggerInterface, EventBusInterface, WalletInterface } from '../types.ts';
import { getSolPriceUsd, getSolPriceReliable } from '../core/sol-price.ts';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, Connection, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  bondingCurvePda,
  bondingCurveMarketCap,
  type Global,
  type FeeConfig,
  type BondingCurve,
} from '../lib/pump-sdk.ts';
import BN from 'bn.js';
import bs58 from 'bs58';

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const JITO_BUNDLE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function rpcRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 500,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiCKtU5Ow',
  'ADaUMid9yfUytqMBgopwjb2DTLSLJQCLuOiv7BmfFT94',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'A77HErLNTKzx3xbSFqhE1uePDP6TgAYBniKdGMCpS5Dp',
];

export class ShitTraderSkill implements Skill {
  manifest: SkillManifest = {
    name: 'shit-trader',
    version: '3.0.0',
    description: 'Unified shitcoin trading skill: manual buy/sell via pump.fun SDK + Jupiter, and autonomous Degen Sniper mode with AI-configurable parameters',
    tools: [
      {
        name: 'buy_token',
        description: 'Buy a token using SOL. Accepts amount in SOL or USD (auto-converts via live price). Uses pump.fun for bonding curve tokens or Jupiter for graduated tokens.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            amountSol: { type: 'number', description: 'Amount of SOL to spend (use this OR amountUsd, not both)' },
            amountUsd: { type: 'number', description: 'Amount in USD to spend — auto-converts to SOL using live price' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 1500)' },
          },
          required: ['mint'],
        },
        requiresApproval: false,
        riskLevel: 'financial',
      },
      {
        name: 'sell_token',
        description: 'Sell a token for SOL. Supports partial sells by percentage.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            percent: { type: 'number', description: 'Percentage of holdings to sell (1-100)' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 1500)' },
          },
          required: ['mint'],
        },
        requiresApproval: false,
        riskLevel: 'financial',
      },
      {
        name: 'get_quote',
        description: 'Get a price quote for a swap without executing it',
        parameters: {
          type: 'object',
          properties: {
            inputMint: { type: 'string', description: 'Input token mint' },
            outputMint: { type: 'string', description: 'Output token mint' },
            amount: { type: 'number', description: 'Amount in base units' },
          },
          required: ['inputMint', 'outputMint', 'amount'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_balance',
        description: 'Get SOL balance and token holdings for the configured wallet',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'fast_buy',
        description: 'Buy a token directly via pump.fun bonding curve (faster than Jupiter for pre-graduation). Optionally uses Jito bundles for MEV protection.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            amountSol: { type: 'number', description: 'Amount of SOL to spend' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 2000)' },
            useJito: { type: 'boolean', description: 'Use Jito bundle for MEV protection (default: false)' },
            jitoTipLamports: { type: 'number', description: 'Jito tip in lamports (default: 10000)' },
          },
          required: ['mint', 'amountSol'],
        },
        requiresApproval: false,
        riskLevel: 'financial',
      },
      {
        name: 'fast_sell',
        description: 'Sell a token directly via pump.fun bonding curve (faster than Jupiter for pre-graduation).',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            percent: { type: 'number', description: 'Percentage of holdings to sell (1-100)' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 2000)' },
            useJito: { type: 'boolean', description: 'Use Jito bundle for MEV protection (default: false)' },
          },
          required: ['mint'],
        },
        requiresApproval: false,
        riskLevel: 'financial',
      },

      {
        name: 'start_sniper',
        description: 'Start the Degen Sniper — autonomous shitcoin trading bot. Monitors pump.fun launches, cross-references with news/X trends, and executes fast buy/sell flips.',
        parameters: {
          type: 'object',
          properties: {
            buyAmountSol: { type: 'number', description: 'SOL per trade (default from strategy YAML)' },
            minScore: { type: 'number', description: 'Minimum score threshold 0-100 (default from strategy)' },
            maxConcurrentPositions: { type: 'number', description: 'Max open positions (default from strategy)' },
            stopLossPercent: { type: 'number', description: 'Stop-loss percentage (default from strategy)' },
            takeProfitPercent: { type: 'number', description: 'Take-profit percentage (default from strategy)' },
          },
        },
        riskLevel: 'financial',
      },
      {
        name: 'stop_sniper',
        description: 'Stop the Degen Sniper. All open positions remain but no new trades will be executed.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'write',
      },
      {
        name: 'configure_sniper',
        description: 'Update Degen Sniper strategy parameters on the fly without restarting. Pass only the fields you want to change.',
        parameters: {
          type: 'object',
          properties: {
            buyAmountSol: { type: 'number', description: 'SOL per trade' },
            slippageBps: { type: 'number', description: 'Slippage in basis points' },
            minScore: { type: 'number', description: 'Minimum score threshold 0-100' },
            maxConcurrentPositions: { type: 'number', description: 'Max simultaneous open positions' },
            stopLossPercent: { type: 'number', description: 'Stop-loss percentage' },
            takeProfitPercent: { type: 'number', description: 'Take-profit percentage' },
            maxPositionAgeSec: { type: 'number', description: 'Max seconds to hold a position' },
            cooldownOnLossStreak: { type: 'number', description: 'Pause minutes after N consecutive losses' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'get_sniper_status',
        description: 'Get Degen Sniper status: running state, stats (buys/sells/cycles), current strategy config, recent decisions, risk profile, open positions.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_paper_mode',
        description: 'Toggle paper trading mode on/off, set/adjust balance, sync with real wallet, or reset paper stats.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'Set mode: "paper" or "live"' },
            balance: { type: 'number', description: 'Set exact paper balance in SOL' },
            adjust: { type: 'number', description: 'Adjust paper balance by delta (+/- SOL)' },
            sync: { type: 'boolean', description: 'Sync paper balance with real wallet' },
            reset: { type: 'boolean', description: 'Reset paper stats and trade history' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'sniper_add_instruction',
        description: 'Add a trading instruction/rule/pattern that the sniper AI will follow during autonomous trading. User teachings, strategies, observations.',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'The instruction/rule/pattern to add' },
          },
          required: ['instruction'],
        },
        riskLevel: 'write',
      },
      {
        name: 'sniper_remove_instruction',
        description: 'Remove a trading instruction by index (0-based).',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'Index of instruction to remove (0-based)' },
          },
          required: ['index'],
        },
        riskLevel: 'write',
      },
      {
        name: 'sniper_get_instructions',
        description: 'Get the list of user-defined RULES that the sniper follows (NOT trades or positions). Only for viewing custom trading rules.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_get_journal',
        description: 'Get the learning journal — all patterns, mistakes, insights, and user instructions logged by the sniper.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Filter by type: "pattern", "mistake", "insight", "user_instruction", or omit for all' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'sniper_add_learning',
        description: 'Add a learning entry (insight, pattern, or observation) to the sniper journal. Use for user-contributed knowledge.',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Entry type: "insight", "pattern", "mistake", or "observation"' },
            message: { type: 'string', description: 'The learning/pattern/observation text' },
            context: { type: 'string', description: 'Optional context (e.g. token, mcap range, conditions)' },
          },
          required: ['type', 'message'],
        },
        riskLevel: 'write',
      },
      {
        name: 'sniper_get_positions',
        description: 'Get detailed info about all currently open sniper positions with P&L, hold time, stop-loss levels.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_get_paper_status',
        description: 'Get paper trading status: enabled/disabled, balance, P&L, win/loss stats, recent paper trades with profit/loss for each.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'sniper_get_trades',
        description: 'MAIN tool for trade history. Returns all buy/sell decisions, paper trades with P&L, open positions, and summary stats. Use for ANY question about trades, buys, sells, paper balance, P&L, tokens bought/sold.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max trades to return (default: 30)' },
          },
        },
        riskLevel: 'read',
      },
    ],
  };

  private sniperJob: any = null;

  setSniperJob(sj: any): void {
    this.sniperJob = sj;
  }

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private wallet!: WalletInterface;
  private pumpSdk!: OnlinePumpSdk;
  private connection!: Connection;
  private pumpGlobal: Global | null = null;
  private pumpFeeConfig: FeeConfig | null = null;
  private globalCacheTime = 0;
  private readonly GLOBAL_CACHE_TTL = 60_000;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.wallet = ctx.wallet;

    const walletAny = ctx.wallet as any;
    if (walletAny.getConnection) {
      this.connection = walletAny.getConnection();
    } else {
      const rpcUrl = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, 'confirmed');
    }
    this.pumpSdk = new OnlinePumpSdk(this.connection);
    this.logger.info(`Pump SDK initialized (RPC: ${this.connection.rpcEndpoint.substring(0, 40)}...)`);
  }

  private async getGlobalConfig(): Promise<{ global: Global; feeConfig: FeeConfig | null }> {
    const now = Date.now();
    if (this.pumpGlobal && now - this.globalCacheTime < this.GLOBAL_CACHE_TTL) {
      return { global: this.pumpGlobal, feeConfig: this.pumpFeeConfig };
    }
    this.pumpGlobal = await this.pumpSdk.fetchGlobal();
    try { this.pumpFeeConfig = await this.pumpSdk.fetchFeeConfig(); } catch { this.pumpFeeConfig = null; }
    this.globalCacheTime = now;
    return { global: this.pumpGlobal, feeConfig: this.pumpFeeConfig };
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'buy_token': {
        let solAmt = params.amountSol;
        if (!solAmt && params.amountUsd) {
          const price = await this.getSolPrice();
          if (!price || price <= 0) return { success: false, error: 'Could not fetch SOL price for USD conversion' };
          solAmt = params.amountUsd / price;
          this.logger.info(`USD→SOL conversion: $${params.amountUsd} ÷ $${price.toFixed(2)} = ${solAmt.toFixed(6)} SOL`);
        }
        if (!solAmt || solAmt <= 0) return { success: false, error: 'Specify amountSol or amountUsd' };
        return this.buyToken(params.mint, solAmt, params.slippageBps);
      }
      case 'sell_token':
        return this.sellToken(params.mint, params.percent || 100, params.slippageBps);
      case 'get_quote':
        return this.getQuote(params.inputMint, params.outputMint, params.amount);
      case 'get_balance':
        return this.getBalance();
      case 'fast_buy':
        return this.fastBuy(
          params.mint,
          params.solAmount ?? params.amountSol ?? params.amount_sol,
          params.slippageBps ?? params.slippage_bps,
          params.useJito ?? params.use_jito,
          params.jitoTipLamports ?? params.jito_tip_lamports,
        );
      case 'fast_sell':
        return this.fastSell(
          params.mint,
          params.percent || 100,
          params.slippageBps ?? params.slippage_bps,
          params.useJito ?? params.use_jito,
        );


      case 'start_sniper': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired — restart required' };
        if (params.buyAmountSol || params.minScore || params.maxConcurrentPositions || params.stopLossPercent || params.takeProfitPercent) {
          this.sniperJob.updateStrategy({
            ...(params.buyAmountSol != null && { buyAmountSol: params.buyAmountSol }),
            ...(params.minScore != null && { minScore: params.minScore }),
            ...(params.maxConcurrentPositions != null && { maxConcurrentPositions: params.maxConcurrentPositions }),
            ...(params.stopLossPercent != null && { stopLossPercent: params.stopLossPercent }),
            ...(params.takeProfitPercent != null && { takeProfitPercent: params.takeProfitPercent }),
          });
        }
        this.sniperJob.start();
        return { success: true, status: 'started', strategy: this.sniperJob.getStrategy() };
      }
      case 'stop_sniper': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        this.sniperJob.stop();
        return { success: true, status: 'stopped', stats: this.sniperJob.getStats() };
      }
      case 'configure_sniper': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        this.sniperJob.updateStrategy(params);
        return { success: true, strategy: this.sniperJob.getStrategy() };
      }
      case 'get_sniper_status': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        const stats = this.sniperJob.getStats();
        const strategy = this.sniperJob.getStrategy();
        const paperStatus = this.sniperJob.getPaperStatus();
        const instructions = this.sniperJob.getUserInstructions();
        const learningStats = this.sniperJob.getLearningStats();
        return { success: true, stats, strategy, paperMode: paperStatus.enabled, paperStatus, instructions, learningStats };
      }
      case 'sniper_paper_mode': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        if (params.mode === 'paper' || params.mode === 'demo') this.sniperJob.setPaperMode(true);
        else if (params.mode === 'live' || params.mode === 'real') this.sniperJob.setPaperMode(false);
        if (params.balance !== undefined) this.sniperJob.setPaperBalance(Number(params.balance));
        if (params.adjust !== undefined) this.sniperJob.adjustPaperBalance(Number(params.adjust));
        if (params.sync) this.sniperJob.syncPaperWithReal();
        if (params.reset) this.sniperJob.resetPaper();
        return { success: true, paper: this.sniperJob.getPaperStatus() };
      }
      case 'sniper_add_instruction': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        const instr = params.instruction?.trim();
        if (!instr) return { success: false, error: 'Empty instruction' };

        const currentInstructions = this.sniperJob.getUserInstructions();

        if (typeof this.sniperJob.addInstruction === 'function') {
          this.sniperJob.addInstruction(instr);
        } else {

          await this.sniperJob.chatWithAI('! ' + instr);
        }
        return { success: true, instruction: instr, totalInstructions: this.sniperJob.getUserInstructions().length };
      }
      case 'sniper_remove_instruction': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        const removed = this.sniperJob.removeInstruction(Number(params.index));
        return { success: removed, instructions: this.sniperJob.getUserInstructions() };
      }
      case 'sniper_get_instructions': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        return { success: true, instructions: this.sniperJob.getUserInstructions() };
      }
      case 'sniper_get_journal': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        let journal = this.sniperJob.getLearningJournal();
        if (params.type) journal = journal.filter((e: any) => e.type === params.type);
        return { success: true, entries: journal, stats: this.sniperJob.getLearningStats() };
      }
      case 'sniper_add_learning': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        if (typeof this.sniperJob.addLearningEntryPublic === 'function') {
          this.sniperJob.addLearningEntryPublic(params.type || 'insight', params.message, params.context);
        } else if (typeof this.sniperJob.addInstruction === 'function') {

          await this.sniperJob.chatWithAI(`! Remember: [${params.type}] ${params.message}${params.context ? ' | ' + params.context : ''}`);
        }
        return { success: true, journal: this.sniperJob.getLearningStats() };
      }
      case 'sniper_get_positions': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        const allStats = this.sniperJob.getStats();
        return { success: true, positions: allStats.trackedPositions || [] };
      }
      case 'sniper_get_paper_status': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        return { success: true, paper: this.sniperJob.getPaperStatus() };
      }
      case 'sniper_get_trades': {
        if (!this.sniperJob) return { success: false, error: 'Sniper not wired' };
        const limit = params.limit || 30;
        const stats = this.sniperJob.getStats();
        const paperStatus = this.sniperJob.getPaperStatus();
        return {
          success: true,
          paperMode: paperStatus.enabled,
          recentDecisions: (stats.recentDecisions || []).slice(-limit),
          paperTrades: (paperStatus.recentTrades || []).slice(-limit),
          paperStats: paperStatus.stats,
          openPositions: stats.trackedPositions || [],
          summary: {
            buys: stats.buys,
            sells: stats.sells,
            cycles: stats.cycles,
            winRate: paperStatus.stats ? `${paperStatus.stats.wins}W / ${paperStatus.stats.losses}L` : 'N/A',
            totalPnl: paperStatus.stats?.totalPnl?.toFixed(4) + ' SOL',
          },
        };
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

private async getSolPrice(): Promise<number> {
    return getSolPriceReliable();
  }

  private async buyToken(
    mint: string,
    amountSol: number,
    slippageBps: number = 1500
  ): Promise<TradeResult> {
    const intentId = `buy_${Date.now()}_${mint.slice(0, 8)}`;

    const intent: TradeIntent = {
      id: intentId,
      agentId: 'shit-trader',
      action: 'buy',
      mint,
      amountSol,
      slippageBps,
      priorityFeeSol: 0.005,
      reason: 'Manual or agent buy order',
      timestamp: Date.now(),
    };

    this.eventBus.emit('trade:intent', intent);

    try {

      const txHash = await this.executeJupiterSwap(
        SOL_MINT,
        mint,
        Math.floor(amountSol * LAMPORTS_PER_SOL),
        slippageBps
      );

      const result: TradeResult = {
        intentId,
        success: true,
        txHash,
        amountSol,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.trade(`BUY ${amountSol} SOL → ${mint.slice(0, 8)}... tx: ${txHash}`);
      return result;
    } catch (err: any) {
      const result: TradeResult = {
        intentId,
        success: false,
        error: err.message,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.error(`Buy failed for ${mint.slice(0, 8)}`, err.message);
      return result;
    }
  }

  private async sellToken(
    mint: string,
    percent: number = 100,
    slippageBps: number = 1500
  ): Promise<TradeResult> {
    const intentId = `sell_${Date.now()}_${mint.slice(0, 8)}`;

    try {

      const balRes = await this.getTokenBalance(mint);
      if (!balRes || balRes.amount <= 0) {
        return { intentId, success: false, error: 'No token balance', timestamp: Date.now() };
      }

      const sellAmount = Math.floor(balRes.rawAmount * (percent / 100));

      const intent: TradeIntent = {
        id: intentId,
        agentId: 'shit-trader',
        action: 'sell',
        mint,
        amountPercent: percent,
        slippageBps,
        priorityFeeSol: 0.005,
        reason: `Sell ${percent}% of position`,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:intent', intent);

      const txHash = await this.executeJupiterSwap(
        mint,
        SOL_MINT,
        sellAmount,
        slippageBps
      );

      const result: TradeResult = {
        intentId,
        success: true,
        txHash,
        amountTokens: sellAmount,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.trade(`SELL ${percent}% of ${mint.slice(0, 8)}... tx: ${txHash}`);
      return result;
    } catch (err: any) {
      const result: TradeResult = {
        intentId,
        success: false,
        error: err.message,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.error(`Sell failed for ${mint.slice(0, 8)}`, err.message);
      return result;
    }
  }

  private async executeJupiterSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number
  ): Promise<string> {

    const quote = await rpcRetry(async () => {
      const quoteUrl = new URL(`${JUPITER_API}/quote`);
      quoteUrl.searchParams.set('inputMint', inputMint);
      quoteUrl.searchParams.set('outputMint', outputMint);
      quoteUrl.searchParams.set('amount', String(Math.floor(amount)));
      quoteUrl.searchParams.set('slippageBps', String(Math.floor(slippageBps)));

      const quoteRes = await fetch(quoteUrl.toString());
      if (!quoteRes.ok) {
        throw new Error(`Jupiter quote failed: ${await quoteRes.text()}`);
      }
      return quoteRes.json() as any;
    });


    const swapData = await rpcRetry(async () => {
            const swapRes = await fetch(`${JUPITER_API}/swap`, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.getAddress(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      });

      if (!swapRes.ok) {
        throw new Error(`Jupiter swap failed: ${await swapRes.text()}`);
      }
      return swapRes.json() as any;
    });

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');


    const tx = VersionedTransaction.deserialize(txBuf);
    const txHash = await rpcRetry(() => this.wallet.signAndSend(tx));

    return txHash;
  }

  private async getQuote(inputMint: string, outputMint: string, amount: number): Promise<any> {
    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', String(Math.floor(amount)));
    url.searchParams.set('slippageBps', '100');

    const res = await fetch(url.toString());
    if (!res.ok) return { error: `Quote request failed: ${res.status}` };
    return res.json();
  }

  updateRpc(rpcUrl: string): void {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.pumpSdk = new OnlinePumpSdk(this.connection);
    this.logger.info(`Shit-trader RPC updated: ${rpcUrl.substring(0, 40)}...`);
  }

  private async getTokenBalance(mint: string): Promise<{ amount: number; rawAmount: number; decimals: number } | null> {
    try {
      return await rpcRetry(async () => {
        const walletAddr = this.wallet.getAddress();
        const mintPk = new PublicKey(mint);
        const userPk = new PublicKey(walletAddr);
        const accounts = await this.connection.getParsedTokenAccountsByOwner(userPk, { mint: mintPk });
        if (accounts.value.length === 0) return null;

        const info = accounts.value[0].account.data.parsed.info.tokenAmount;
        return {
          amount: Number(info.uiAmount || 0),
          rawAmount: Number(info.amount || 0),
          decimals: info.decimals,
        };
      });
    } catch {
      return null;
    }
  }

  private async getBalance(): Promise<{ sol: number; address: string }> {
    const sol = await this.wallet.getBalance();
    return { sol, address: this.wallet.getAddress() };
  }


private computeBuyTokensManual(
    solLamports: BN,
    virtualSolReserves: BN,
    virtualTokenReserves: BN,
    realTokenReserves: BN,
    feeBps: number,
  ): BN {
    if (solLamports.isZero() || virtualTokenReserves.isZero()) return new BN(0);

    const inputAmount = solLamports.muln(10000).div(new BN(feeBps + 10000));

    const tokensReceived = inputAmount.mul(virtualTokenReserves).div(virtualSolReserves.add(inputAmount));

    return BN.min(tokensReceived, realTokenReserves);
  }

private async buyViaPumpPortal(
    mint: string,
    amountSol: number,
    slippagePct: number,
  ): Promise<string> {
    const userAddress = this.wallet.getAddress();
        const res = await fetch('https://pumpportal.fun/api/trade-local', {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: userAddress,
        action: 'buy',
        mint,
        amount: amountSol,
        denominatedInSol: 'true',
        slippage: slippagePct,
        priorityFee: 0.005,
        pool: 'auto',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PumpPortal API ${res.status}: ${body}`);
    }


    const txBuf = Buffer.from(await res.arrayBuffer());
    const tx = VersionedTransaction.deserialize(txBuf);
    return await this.wallet.signAndSend(tx);
  }

  private async fastBuy(
    mint: string,
    amountSol: number,
    slippageBps: number = 2000,
    useJito: boolean = false,
    jitoTipLamports: number = 10000
  ): Promise<TradeResult> {
    const intentId = `fastbuy_${Date.now()}_${mint.slice(0, 8)}`;
    const startTime = performance.now();

    const intent: TradeIntent = {
      id: intentId,
      agentId: 'shit-trader',
      action: 'buy',
      mint,
      amountSol,
      slippageBps,
      priorityFeeSol: useJito ? jitoTipLamports / LAMPORTS_PER_SOL : 0.005,
      reason: `Fast buy via pump.fun SDK${useJito ? ' (Jito)' : ''}`,
      timestamp: Date.now(),
    };

    this.eventBus.emit('trade:intent', intent);

    try {
      const mintPk = new PublicKey(mint);
      const userPk = new PublicKey(this.wallet.getAddress());
      const solAmountBN = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));


      const mintAccountInfo = await this.connection.getAccountInfo(mintPk);
      const tokenProgram = mintAccountInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;


      const { global, feeConfig } = await this.getGlobalConfig();
      let bondingCurveAccountInfo: any;
      let bondingCurve: any;
      let associatedUserAccountInfo: any;
      try {
        const state = await this.pumpSdk.fetchBuyState(mintPk, userPk, tokenProgram);
        bondingCurveAccountInfo = state.bondingCurveAccountInfo;
        bondingCurve = state.bondingCurve;
        associatedUserAccountInfo = state.associatedUserAccountInfo;
      } catch (fetchErr: any) {

        this.logger.warn(`[fastBuy] Bonding curve not found (${fetchErr.message}) — using PumpPortal auto`);
        const txHash = await this.buyViaPumpPortal(mint, amountSol, slippageBps / 100);
        const elapsed = performance.now() - startTime;
        const result: TradeResult = { intentId, success: true, txHash, amountSol, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST BUY (PumpPortal auto) ${amountSol} SOL → ${mint.slice(0, 8)}... tx: ${txHash} (${elapsed.toFixed(0)}ms)`);
        return result;
      }

      if (bondingCurve.complete || bondingCurve.realTokenReserves?.isZero?.()) {

        this.logger.info(`[fastBuy] Token graduated (complete=${bondingCurve.complete}, realTokens=${bondingCurve.realTokenReserves?.toString()}) — using PumpPortal auto`);
        const txHash = await this.buyViaPumpPortal(mint, amountSol, slippageBps / 100);
        const elapsed = performance.now() - startTime;
        const result: TradeResult = { intentId, success: true, txHash, amountSol, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST BUY (PumpPortal auto) ${amountSol} SOL → ${mint.slice(0, 8)}... tx: ${txHash} (${elapsed.toFixed(0)}ms)`);
        return result;
      }


      this.logger.debug(`[fastBuy] mint=${mint}, solAmount=${solAmountBN.toString()}`);
      this.logger.debug(`[fastBuy] virtualSolReserves=${bondingCurve.virtualSolReserves?.toString()}, virtualTokenReserves=${bondingCurve.virtualTokenReserves?.toString()}`);
      this.logger.debug(`[fastBuy] realTokenReserves=${bondingCurve.realTokenReserves?.toString()}, tokenTotalSupply=${bondingCurve.tokenTotalSupply?.toString()}`);
      this.logger.debug(`[fastBuy] complete=${bondingCurve.complete}, feeConfig=${feeConfig ? 'present' : 'null'}`);


      let tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: solAmountBN,
      });

      this.logger.debug(`[fastBuy] SDK tokenAmount=${tokenAmount.toString()}`);


      if (tokenAmount.isZero()) {
        this.logger.warn(`[fastBuy] SDK returned 0 tokens — computing manually from bonding curve`);
        const feeBps = feeConfig
          ? Number(feeConfig.feeTiers?.[0]?.fees?.protocolFeeBps?.toString() || '100') +
            Number(feeConfig.feeTiers?.[0]?.fees?.creatorFeeBps?.toString() || '0')
          : Number(global.feeBasisPoints?.toString() || '100') +
            Number(global.creatorFeeBasisPoints?.toString() || '0');

        tokenAmount = this.computeBuyTokensManual(
          solAmountBN,
          bondingCurve.virtualSolReserves,
          bondingCurve.virtualTokenReserves,
          bondingCurve.realTokenReserves,
          feeBps,
        );
        this.logger.debug(`[fastBuy] Manual tokenAmount=${tokenAmount.toString()} (feeBps=${feeBps})`);
      }


      if (tokenAmount.isZero()) {
        this.logger.warn(`[fastBuy] Manual calc also 0 — falling back to PumpPortal API`);
        const txHash = await this.buyViaPumpPortal(mint, amountSol, slippageBps / 100);
        const elapsed = performance.now() - startTime;
        const result: TradeResult = { intentId, success: true, txHash, amountSol, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST BUY (PumpPortal) ${amountSol} SOL → ${mint.slice(0, 8)}... tx: ${txHash} (${elapsed.toFixed(0)}ms)`);
        return result;
      }


      const ixs = await PUMP_SDK.buyInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: mintPk,
        user: userPk,
        amount: tokenAmount,
        solAmount: solAmountBN,
        slippage: slippageBps / 100,
        tokenProgram,
      });


      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
      tx.add(...ixs);

      let txHash: string;
      if (useJito) {
        const signed = await this.wallet.sign(tx) as Transaction;
        const vtx = new VersionedTransaction(signed.compileMessage());
        txHash = await this.sendViaJito(vtx, jitoTipLamports);
      } else {
        txHash = await rpcRetry(() => this.wallet.signAndSend(tx));
      }

      const elapsed = performance.now() - startTime;

      const result: TradeResult = {
        intentId,
        success: true,
        txHash,
        amountSol,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.trade(`FAST BUY ${amountSol} SOL → ${mint.slice(0, 8)}... tokens: ${tokenAmount.toString()} tx: ${txHash} (${elapsed.toFixed(0)}ms)`);
      return result;
    } catch (err: any) {

      this.logger.error(`Pump SDK buy failed for ${mint.slice(0, 8)}: ${err.message}`);
      try {
        this.logger.info(`[fastBuy] Attempting PumpPortal API fallback...`);
        const txHash = await this.buyViaPumpPortal(mint, amountSol, slippageBps / 100);
        const elapsed = performance.now() - startTime;
        const result: TradeResult = { intentId, success: true, txHash, amountSol, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST BUY (PumpPortal fallback) ${amountSol} SOL → ${mint.slice(0, 8)}... tx: ${txHash} (${elapsed.toFixed(0)}ms)`);
        return result;
      } catch (fallbackErr: any) {
        this.logger.error(`PumpPortal fallback also failed: ${fallbackErr.message}`);
        const result: TradeResult = {
          intentId,
          success: false,
          error: `All buy methods failed. SDK: ${err.message} | PumpPortal: ${fallbackErr.message}`,
          timestamp: Date.now(),
        };
        this.eventBus.emit('trade:executed', result);
        return result;
      }
    }
  }

private async sellViaPumpPortal(
    mint: string,
    tokenAmount: number | string,
    slippagePct: number,
  ): Promise<string> {
    const userAddress = this.wallet.getAddress();
        const res = await fetch('https://pumpportal.fun/api/trade-local', {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: userAddress,
        action: 'sell',
        mint,
        amount: String(tokenAmount),
        denominatedInSol: 'false',
        slippage: slippagePct,
        priorityFee: 0.005,
        pool: 'auto',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PumpPortal sell API ${res.status}: ${body}`);
    }

    const txBuf = Buffer.from(await res.arrayBuffer());
    const tx = VersionedTransaction.deserialize(txBuf);
    return await this.wallet.signAndSend(tx);
  }

  private async fastSell(
    mint: string,
    percent: number = 100,
    slippageBps: number = 2000,
    useJito: boolean = false
  ): Promise<TradeResult> {
    const intentId = `fastsell_${Date.now()}_${mint.slice(0, 8)}`;

    try {
      const balRes = await this.getTokenBalance(mint);
      if (!balRes || balRes.amount <= 0) {
        return { intentId, success: false, error: 'No token balance', timestamp: Date.now() };
      }

      const sellTokenAmount = Math.floor(balRes.rawAmount * (percent / 100));

      const intent: TradeIntent = {
        id: intentId,
        agentId: 'shit-trader',
        action: 'sell',
        mint,
        amountPercent: percent,
        slippageBps,
        priorityFeeSol: 0.005,
        reason: `Fast sell ${percent}% via pump.fun SDK`,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:intent', intent);

      const mintPk = new PublicKey(mint);
      const userPk = new PublicKey(this.wallet.getAddress());
      const tokenAmountBN = new BN(sellTokenAmount);


      const mintAccountInfo = await this.connection.getAccountInfo(mintPk);
      const tokenProgram = mintAccountInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;


      const { global, feeConfig } = await this.getGlobalConfig();
      let bondingCurveAccountInfo: any;
      let bondingCurve: any;
      try {
        const state = await this.pumpSdk.fetchSellState(mintPk, userPk, tokenProgram);
        bondingCurveAccountInfo = state.bondingCurveAccountInfo;
        bondingCurve = state.bondingCurve;
      } catch (fetchErr: any) {

        this.logger.warn(`[fastSell] Bonding curve not found (${fetchErr.message}) — using PumpPortal auto`);
        const txHash = await this.sellViaPumpPortal(mint, sellTokenAmount, slippageBps / 100);
        const result: TradeResult = { intentId, success: true, txHash, amountTokens: sellTokenAmount, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST SELL (PumpPortal auto) ${percent}% of ${mint.slice(0, 8)}... tx: ${txHash}`);
        return result;
      }

      if (bondingCurve.complete || bondingCurve.realTokenReserves?.isZero?.()) {
        this.logger.debug('Token graduated, falling back to Jupiter for sell');
        return this.sellToken(mint, percent, slippageBps);
      }


      this.logger.debug(`[fastSell] mint=${mint}, tokenAmount=${sellTokenAmount}`);
      this.logger.debug(`[fastSell] virtualSolReserves=${bondingCurve.virtualSolReserves?.toString()}, virtualTokenReserves=${bondingCurve.virtualTokenReserves?.toString()}`);


      const solAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: tokenAmountBN,
      });

      this.logger.debug(`[fastSell] SDK solAmount=${solAmount.toString()}`);


      const ixs = await PUMP_SDK.sellInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        mint: mintPk,
        user: userPk,
        amount: tokenAmountBN,
        solAmount,
        slippage: slippageBps / 100,
        tokenProgram,
        mayhemMode: false,
      });

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
      tx.add(...ixs);

      let txHash: string;
      if (useJito) {
        const signed = await this.wallet.sign(tx) as Transaction;
        const vtx = new VersionedTransaction(signed.compileMessage());
        txHash = await this.sendViaJito(vtx, Number(process.env.JITO_TIP_LAMPORTS || 10000));
      } else {
        txHash = await rpcRetry(() => this.wallet.signAndSend(tx));
      }

      const result: TradeResult = {
        intentId,
        success: true,
        txHash,
        amountTokens: sellTokenAmount,
        timestamp: Date.now(),
      };

      this.eventBus.emit('trade:executed', result);
      this.logger.trade(`FAST SELL ${percent}% of ${mint.slice(0, 8)}... SOL: ${solAmount.toString()} tx: ${txHash}`);
      return result;
    } catch (err: any) {

      this.logger.warn(`Pump SDK sell failed (${err.message}), trying PumpPortal API`);
      try {
        const balRes = await this.getTokenBalance(mint);
        if (!balRes || balRes.amount <= 0) {
          return { intentId, success: false, error: 'No token balance', timestamp: Date.now() };
        }
        const sellAmount = Math.floor(balRes.rawAmount * (percent / 100));
        const txHash = await this.sellViaPumpPortal(mint, sellAmount, slippageBps / 100);
        const result: TradeResult = { intentId, success: true, txHash, amountTokens: sellAmount, timestamp: Date.now() };
        this.eventBus.emit('trade:executed', result);
        this.logger.trade(`FAST SELL (PumpPortal) ${percent}% of ${mint.slice(0, 8)}... tx: ${txHash}`);
        return result;
      } catch (fallbackErr: any) {
        this.logger.error(`PumpPortal sell also failed: ${fallbackErr.message}, trying Jupiter`);
        return this.sellToken(mint, percent, slippageBps);
      }
    }
  }

private async sendViaJito(tx: VersionedTransaction, tipLamports: number): Promise<string> {

    const signed = await this.wallet.sign(tx) as VersionedTransaction;
    const serialized = Buffer.from(signed.serialize()).toString('base64');


    const bundleRes = await fetch(JITO_BUNDLE_URL, {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[serialized]],
      }),
    });

    if (!bundleRes.ok) {

      return this.wallet.signAndSend(tx);
    }

    const bundleData = await bundleRes.json() as any;
    if (bundleData.result) {
      this.logger.debug(`Jito bundle accepted: ${bundleData.result}`);
    }


    const sig = bs58.encode(Buffer.from(signed.signatures[0]));


    this.pollBundleStatus(bundleData.result, sig).catch((err) => {
      this.logger.debug(`Jito bundle status polling failed: ${err.message}`);
    });

    return sig;
  }

private async pollBundleStatus(bundleId: string, txSig: string, maxAttempts: number = 10): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const res = await fetch(JITO_BUNDLE_URL, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        if (!res.ok) continue;

        const data = await res.json() as any;
        const statuses = data.result?.value;
        if (!statuses || statuses.length === 0) continue;

        const status = statuses[0];
        if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
          this.logger.info(`Jito bundle ${bundleId.slice(0, 8)} confirmed (${status.confirmation_status}), tx: ${txSig.slice(0, 8)}`);
          return;
        }

        if (status.err) {
          this.logger.warn(`Jito bundle ${bundleId.slice(0, 8)} failed: ${JSON.stringify(status.err)}`);
          return;
        }
      } catch {

      }
    }

    this.logger.warn(`Jito bundle ${bundleId.slice(0, 8)} status unknown after ${maxAttempts} polls`);
  }
}
