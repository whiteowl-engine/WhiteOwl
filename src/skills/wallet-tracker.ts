import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, MemoryInterface,
} from '../types.ts';

interface TrackedWallet {
  address: string;
  label: string;
  tags: string[];
  addedAt: number;
  lastActivity?: number;
  totalPnl?: number;
  winRate?: number;
}

interface WalletTransaction {
  signature: string;
  type: 'buy' | 'sell' | 'transfer' | 'unknown';
  mint?: string;
  tokenSymbol?: string;
  amountSol?: number;
  amountTokens?: number;
  timestamp: number;
}

export class WalletTrackerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'wallet-tracker',
    version: '1.0.0',
    description: 'Track smart money wallets on Solana. Monitor their trades and copy signals.',
    tools: [
      {
        name: 'add_wallet',
        description: 'Add a wallet to the tracking list',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Solana wallet address' },
            label: { type: 'string', description: 'Friendly name for this wallet (e.g., "whale_01")' },
            tags: {
              type: 'array', items: { type: 'string' },
              description: 'Tags like "smart_money", "insider", "kol", "degen"',
            },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'remove_wallet',
        description: 'Remove a wallet from the tracking list',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Wallet address to remove' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'list_tracked_wallets',
        description: 'List all tracked wallets with their labels, tags, and activity',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'get_wallet_activity',
        description: 'Get recent on-chain activity for a specific wallet',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Wallet address' },
            limit: { type: 'number', description: 'Number of recent transactions' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_wallet_holdings',
        description: 'Get current token holdings of a wallet',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Wallet address' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'find_common_buys',
        description: 'Find tokens that multiple tracked wallets have bought recently',
        parameters: {
          type: 'object',
          properties: {
            minWallets: { type: 'number', description: 'Min number of wallets that bought (default: 2)' },
            hoursBack: { type: 'number', description: 'Lookback window in hours (default: 24)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'start_live_tracking',
        description: 'Start real-time WebSocket tracking for all wallets. Emits events on new trades.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'stop_live_tracking',
        description: 'Stop real-time wallet tracking',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private memory!: MemoryInterface;
  private tracked = new Map<string, TrackedWallet>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeen = new Map<string, string>();
  private solanaRpc = '';
  private heliusKey = '';

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.memory = ctx.memory;
    this.solanaRpc = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.heliusKey = ctx.config.rpc?.heliusApiKey || process.env.HELIUS_API_KEY || '';
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'add_wallet': return this.addWallet(params.address, params.label, params.tags);
      case 'remove_wallet': return this.removeWallet(params.address);
      case 'list_tracked_wallets': return this.listWallets();
      case 'get_wallet_activity': return this.getWalletActivity(params.address, params.limit);
      case 'get_wallet_holdings': return this.getWalletHoldings(params.address);
      case 'find_common_buys': return this.findCommonBuys(params.minWallets, params.hoursBack);
      case 'start_live_tracking': return this.startTracking();
      case 'stop_live_tracking': return this.stopTracking();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopTracking();
  }

  private addWallet(address: string, label?: string, tags?: string[]): { status: string } {
    const wallet: TrackedWallet = {
      address,
      label: label || address.slice(0, 8),
      tags: tags || [],
      addedAt: Date.now(),
    };
    this.tracked.set(address, wallet);
    this.logger.info(`Tracking wallet: ${wallet.label} (${address.slice(0, 8)}...)`);
    return { status: 'added', ...wallet };
  }

  private removeWallet(address: string): { status: string } {
    this.tracked.delete(address);
    this.lastSeen.delete(address);
    return { status: 'removed' };
  }

  private listWallets(): TrackedWallet[] {
    return Array.from(this.tracked.values());
  }

  private async getWalletActivity(address: string, limit: number = 20): Promise<WalletTransaction[] | { error: string }> {
    try {
      if (this.heliusKey) {
        return this.getActivityViaHelius(address, limit);
      }

      const res = await fetch(this.solanaRpc, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit }],
        }),
      });

      const data = await res.json() as any;
      const sigs = data.result || [];

      return sigs.map((s: any) => ({
        signature: s.signature,
        type: 'unknown' as const,
        timestamp: s.blockTime ? s.blockTime * 1000 : 0,
      }));
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async getActivityViaHelius(address: string, limit: number): Promise<WalletTransaction[]> {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${this.heliusKey}&limit=${limit}`);
    if (!res.ok) return [];

    const txs = await res.json() as any[];
    return txs.map(tx => this.parseHeliusTransaction(tx)).filter(Boolean) as WalletTransaction[];
  }

  private parseHeliusTransaction(tx: any): WalletTransaction | null {
    const events = tx.events || {};
    const swap = events.swap;

    if (swap) {
      const nativeIn = swap.nativeInput;
      const nativeOut = swap.nativeOutput;
      const tokenIn = swap.tokenInputs?.[0];
      const tokenOut = swap.tokenOutputs?.[0];

      if (nativeIn && tokenOut) {
        return {
          signature: tx.signature,
          type: 'buy',
          mint: tokenOut.mint,
          tokenSymbol: tokenOut.tokenStandard,
          amountSol: nativeIn.amount / 1e9,
          amountTokens: Number(tokenOut.rawTokenAmount?.tokenAmount || 0),
          timestamp: tx.timestamp * 1000,
        };
      }

      if (tokenIn && nativeOut) {
        return {
          signature: tx.signature,
          type: 'sell',
          mint: tokenIn.mint,
          tokenSymbol: tokenIn.tokenStandard,
          amountSol: nativeOut.amount / 1e9,
          amountTokens: Number(tokenIn.rawTokenAmount?.tokenAmount || 0),
          timestamp: tx.timestamp * 1000,
        };
      }
    }

    return {
      signature: tx.signature,
      type: 'unknown',
      timestamp: tx.timestamp * 1000,
    };
  }

  private async getWalletHoldings(address: string): Promise<any> {
    try {
      const res = await fetch(this.solanaRpc, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenAccountsByOwner',
          params: [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }],
        }),
      });

      const data = await res.json() as any;
      const accounts = data.result?.value || [];

      return accounts
        .map((acct: any) => {
          const info = acct.account.data.parsed.info;
          const amount = Number(info.tokenAmount?.uiAmount || 0);
          return {
            mint: info.mint,
            amount,
            decimals: info.tokenAmount?.decimals || 0,
          };
        })
        .filter((a: any) => a.amount > 0)
        .sort((a: any, b: any) => b.amount - a.amount);
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async findCommonBuys(minWallets: number = 2, hoursBack: number = 24): Promise<any> {
    const sinceMs = Date.now() - hoursBack * 3_600_000;
    const tokenBuyers = new Map<string, Set<string>>();

    for (const [address] of this.tracked) {
      const activity = await this.getWalletActivity(address, 50);
      if (Array.isArray(activity)) {
        for (const tx of activity) {
          if (tx.type === 'buy' && tx.mint && tx.timestamp >= sinceMs) {
            const set = tokenBuyers.get(tx.mint) || new Set();
            set.add(address);
            tokenBuyers.set(tx.mint, set);
          }
        }
      }
    }

    const common: Array<{ mint: string; wallets: string[]; count: number }> = [];
    for (const [mint, buyers] of tokenBuyers) {
      if (buyers.size >= minWallets) {
        const labels = Array.from(buyers).map(addr => {
          const w = this.tracked.get(addr);
          return w?.label || addr.slice(0, 8);
        });
        common.push({ mint, wallets: labels, count: buyers.size });
      }
    }

    common.sort((a, b) => b.count - a.count);
    return common;
  }

  private startTracking(): { status: string } {
    if (this.pollingTimer) return { status: 'already_running' };

    const interval = this.heliusKey ? 15_000 : 30_000;

    this.pollingTimer = setInterval(() => this.pollAllWallets(), interval);
    this.pollAllWallets();
    this.logger.info(`Live wallet tracking started (${this.tracked.size} wallets, ${interval / 1000}s interval)`);
    return { status: 'started' };
  }

  private stopTracking(): { status: string } {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    return { status: 'stopped' };
  }

  private async pollAllWallets(): Promise<void> {
    for (const [address, wallet] of this.tracked) {
      try {
        const res = await fetch(this.solanaRpc, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getSignaturesForAddress',
            params: [address, { limit: 5 }],
          }),
        });

        const data = await res.json() as any;
        const sigs = data.result || [];
        if (sigs.length === 0) continue;

        const lastKnown = this.lastSeen.get(address);
        this.lastSeen.set(address, sigs[0].signature);

        if (!lastKnown) continue;


        const newSigs = [];
        for (const sig of sigs) {
          if (sig.signature === lastKnown) break;
          newSigs.push(sig);
        }

        if (newSigs.length > 0 && this.heliusKey) {

          const activity = await this.getActivityViaHelius(address, newSigs.length);
          const sigSet = new Set(newSigs.map((s: any) => s.signature));

          for (const tx of activity) {
            if (!sigSet.has(tx.signature)) continue;

            if ((tx.type === 'buy' || tx.type === 'sell') && tx.mint) {
              this.logger.info(`[Wallet ${wallet.label}] ${tx.type.toUpperCase()} ${tx.amountSol?.toFixed(3)} SOL ${tx.type === 'buy' ? '→' : '←'} ${tx.mint.slice(0, 8)}`);

              const eventType = tx.type === 'buy' ? 'signal:buy' : 'signal:sell';
              this.eventBus.emit(eventType as any, {
                mint: tx.mint,
                score: tx.type === 'buy' ? 60 : 0,
                reason: `Smart money (${wallet.label}) ${tx.type} detected`,
                agentId: 'wallet-tracker',
                amountSol: tx.amountSol,
              });
            }
          }
        }
      } catch (err: any) {
        this.logger.debug(`Wallet poll error for ${wallet.label}: ${err.message}`);
      }
    }
  }
}
