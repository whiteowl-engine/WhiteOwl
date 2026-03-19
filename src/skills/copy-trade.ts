import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, WalletInterface,
} from '../types';

export class CopyTradeSkill implements Skill {
  manifest: SkillManifest = {
    name: 'copy-trade',
    version: '1.0.0',
    description: 'Copy trading: automatically mirror trades from watched wallets with configurable rules',
    tools: [
      {
        name: 'set_copy_config',
        description: 'Configure copy trade rules: which wallets, position sizing, max trades',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable/disable copy trading' },
            wallets: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of wallet addresses to copy (must be tracked in wallet-tracker)',
            },
            sizeMode: {
              type: 'string',
              enum: ['fixed', 'proportional', 'percentage'],
              description: 'How to size copy positions',
            },
            fixedAmountSol: { type: 'number', description: 'Fixed SOL per trade (for "fixed" mode)' },
            percentageOfOriginal: { type: 'number', description: 'Percentage of original trade to copy (for "percentage" mode)' },
            maxCopySol: { type: 'number', description: 'Maximum SOL for a single copy trade' },
            maxConcurrentCopies: { type: 'number', description: 'Maximum number of active copy positions' },
            minWalletsToBuy: { type: 'number', description: 'Only copy if N+ tracked wallets buy the same token (default: 1)' },
            autoSell: { type: 'boolean', description: 'Automatically sell when the copied wallet sells' },
            delay: { type: 'number', description: 'Delay in seconds before executing copy trade (to verify)' },
          },
        },
        riskLevel: 'write',
      },
      {
        name: 'get_copy_config',
        description: 'Get current copy trade configuration',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_copy_history',
        description: 'Get history of copy trades executed',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'get_copy_stats',
        description: 'Get performance stats of copy trading per wallet',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private wallet!: WalletInterface;

  private config = {
    enabled: false,
    wallets: [] as string[],
    sizeMode: 'fixed' as 'fixed' | 'proportional' | 'percentage',
    fixedAmountSol: 0.1,
    percentageOfOriginal: 50,
    maxCopySol: 0.5,
    maxConcurrentCopies: 3,
    minWalletsToBuy: 1,
    autoSell: true,
    delay: 5,
  };

  private copyHistory: Array<{
    sourceWallet: string;
    mint: string;
    action: 'buy' | 'sell';
    amountSol: number;
    timestamp: number;
    success: boolean;
    reason?: string;
  }> = [];

  private activeCopies = new Set<string>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.wallet = ctx.wallet;

    // Listen for wallet tracker buy signals
    this.eventBus.on('signal:buy', (data) => {
      if (!this.config.enabled) return;
      if (data.agentId === 'wallet-tracker' && data.reason.includes('Smart money')) {
        this.handleCopySignal(data.mint, 'buy', data.reason, (data as any).amountSol);
      }
    });

    // Listen for wallet tracker sell signals (autoSell)
    this.eventBus.on('signal:sell', (data) => {
      if (!this.config.enabled) return;
      if (!this.config.autoSell) return;
      if (data.agentId === 'wallet-tracker' && this.activeCopies.has(data.mint)) {
        this.handleCopySignal(data.mint, 'sell', data.reason);
      }
    });
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'set_copy_config': return this.setCopyConfig(params);
      case 'get_copy_config': return this.config;
      case 'get_copy_history': return this.getCopyHistory(params.limit);
      case 'get_copy_stats': return this.getCopyStats();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

  private setCopyConfig(params: Record<string, any>): any {
    if (params.enabled !== undefined) this.config.enabled = params.enabled;
    if (params.wallets) this.config.wallets = params.wallets;
    if (params.sizeMode) this.config.sizeMode = params.sizeMode;
    if (params.fixedAmountSol !== undefined) this.config.fixedAmountSol = params.fixedAmountSol;
    if (params.percentageOfOriginal !== undefined) this.config.percentageOfOriginal = params.percentageOfOriginal;
    if (params.maxCopySol !== undefined) this.config.maxCopySol = params.maxCopySol;
    if (params.maxConcurrentCopies !== undefined) this.config.maxConcurrentCopies = params.maxConcurrentCopies;
    if (params.minWalletsToBuy !== undefined) this.config.minWalletsToBuy = params.minWalletsToBuy;
    if (params.autoSell !== undefined) this.config.autoSell = params.autoSell;
    if (params.delay !== undefined) this.config.delay = params.delay;

    this.logger.info(`Copy trade config updated: enabled=${this.config.enabled}, wallets=${this.config.wallets.length}`);
    return { status: 'updated', config: this.config };
  }

  private handleCopySignal(mint: string, action: 'buy' | 'sell', reason: string, sourceAmountSol?: number): void {
    if (this.activeCopies.size >= this.config.maxConcurrentCopies && action === 'buy') {
      this.logger.debug(`Copy trade skipped: max concurrent copies reached`);
      return;
    }

    if (this.activeCopies.has(mint) && action === 'buy') {
      this.logger.debug(`Copy trade skipped: already have copy position in ${mint.slice(0, 8)}`);
      return;
    }

    const delaySec = Math.max(0, this.config.delay);

    setTimeout(async () => {
      let amountSol: number;

      if (action === 'sell') {
        // For sell, we sell 100% of the copied position
        amountSol = 0; // Not used for sell intent — percent-based
      } else {
        amountSol = await this.calculateCopyAmount(sourceAmountSol);
      }

      this.eventBus.emit('trade:intent', {
        id: `copy_${Date.now()}_${mint.slice(0, 8)}`,
        agentId: 'copy-trade',
        action,
        mint,
        amountSol: action === 'buy' ? amountSol : undefined,
        amountPercent: action === 'sell' ? 100 : undefined,
        slippageBps: 1500,
        priorityFeeSol: 0.005,
        reason: `Copy trade: ${reason}`,
        timestamp: Date.now(),
      });

      if (action === 'buy') {
        this.activeCopies.add(mint);
      } else {
        this.activeCopies.delete(mint);
      }

      this.copyHistory.push({
        sourceWallet: reason,
        mint,
        action,
        amountSol: action === 'buy' ? amountSol : 0,
        timestamp: Date.now(),
        success: true,
      });

      this.logger.trade(`COPY ${action.toUpperCase()} ${action === 'buy' ? amountSol + ' SOL → ' : ''}${mint.slice(0, 8)}...`);
    }, delaySec * 1000);
  }

  /**
   * Calculate copy trade amount based on sizeMode configuration.
   */
  private async calculateCopyAmount(sourceAmountSol?: number): Promise<number> {
    let amountSol: number;

    switch (this.config.sizeMode) {
      case 'percentage': {
        // Use percentage of the original (source wallet) trade amount
        if (sourceAmountSol && sourceAmountSol > 0) {
          amountSol = sourceAmountSol * (this.config.percentageOfOriginal / 100);
        } else {
          // Fallback to fixed if source amount unknown
          amountSol = this.config.fixedAmountSol;
          this.logger.debug('Copy trade: source amount unknown, falling back to fixed size');
        }
        break;
      }
      case 'proportional': {
        // Proportional to our wallet balance vs source wallet
        try {
          const balance = await this.wallet.getBalance();
          // Use a reasonable proportion: spend same % of our balance
          // Default: spend fixedAmountSol as base, scaled to balance
          amountSol = Math.max(this.config.fixedAmountSol, balance * 0.05);
        } catch {
          amountSol = this.config.fixedAmountSol;
        }
        break;
      }
      case 'fixed':
      default:
        amountSol = this.config.fixedAmountSol;
        break;
    }

    return Math.min(amountSol, this.config.maxCopySol);
  }

  private getCopyHistory(limit?: number): any[] {
    return this.copyHistory.slice(-(limit || 50));
  }

  private getCopyStats(): any {
    const buys = this.copyHistory.filter(h => h.action === 'buy');
    const sells = this.copyHistory.filter(h => h.action === 'sell');

    return {
      totalCopyTrades: this.copyHistory.length,
      buys: buys.length,
      sells: sells.length,
      activeCopies: this.activeCopies.size,
      totalSolDeployed: buys.reduce((s, h) => s + h.amountSol, 0),
    };
  }
}
