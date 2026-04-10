
import { SolanaWallet } from './solana.ts';
import { LoggerInterface } from '../types.ts';

export interface WalletEntry {
  id: string;
  wallet: SolanaWallet;
  label: string;
  enabled: boolean;
  balance: number;
  totalTrades: number;
  totalPnl: number;
  lastUsed: number;
}

export type WalletSelectionStrategy = 'round-robin' | 'highest-balance' | 'least-used' | 'random';

export class MultiWalletManager {
  private wallets = new Map<string, WalletEntry>();
  private logger: LoggerInterface;
  private rpcUrl: string;
  private strategy: WalletSelectionStrategy = 'round-robin';
  private roundRobinIndex = 0;

  constructor(rpcUrl: string, logger: LoggerInterface) {
    this.rpcUrl = rpcUrl;
    this.logger = logger;
  }

  addWallet(id: string, privateKey: string, label: string = ''): void {
    const wallet = new SolanaWallet(this.rpcUrl, this.logger, privateKey);
    this.wallets.set(id, {
      id,
      wallet,
      label: label || `Wallet ${this.wallets.size + 1}`,
      enabled: true,
      balance: 0,
      totalTrades: 0,
      totalPnl: 0,
      lastUsed: 0,
    });
    this.logger.info(`Multi-wallet: added ${id} (${wallet.getAddress().slice(0, 8)}...)`);
  }

removeWallet(id: string): boolean {
    return this.wallets.delete(id);
  }

setEnabled(id: string, enabled: boolean): void {
    const entry = this.wallets.get(id);
    if (entry) entry.enabled = enabled;
  }

setStrategy(strategy: WalletSelectionStrategy): void {
    this.strategy = strategy;
  }

selectWallet(): WalletEntry | null {
    const available = Array.from(this.wallets.values()).filter(w => w.enabled && w.balance > 0.01);
    if (available.length === 0) return null;

    switch (this.strategy) {
      case 'round-robin': {
        this.roundRobinIndex = this.roundRobinIndex % available.length;
        const entry = available[this.roundRobinIndex];
        this.roundRobinIndex++;
        return entry;
      }
      case 'highest-balance': {
        return available.sort((a, b) => b.balance - a.balance)[0];
      }
      case 'least-used': {
        return available.sort((a, b) => a.totalTrades - b.totalTrades)[0];
      }
      case 'random': {
        return available[Math.floor(Math.random() * available.length)];
      }
      default:
        return available[0];
    }
  }

getWallet(id: string): WalletEntry | undefined {
    return this.wallets.get(id);
  }

recordTrade(id: string, pnl: number): void {
    const entry = this.wallets.get(id);
    if (entry) {
      entry.totalTrades++;
      entry.totalPnl += pnl;
      entry.lastUsed = Date.now();
    }
  }

async refreshBalances(): Promise<void> {
    for (const [, entry] of this.wallets) {
      try {
        entry.balance = await entry.wallet.getBalance();
      } catch {
        entry.balance = 0;
      }
    }
  }

getAllWallets(): Array<{
    id: string;
    address: string;
    label: string;
    enabled: boolean;
    balance: number;
    totalTrades: number;
    totalPnl: number;
  }> {
    return Array.from(this.wallets.values()).map(w => ({
      id: w.id,
      address: w.wallet.getAddress(),
      label: w.label,
      enabled: w.enabled,
      balance: w.balance,
      totalTrades: w.totalTrades,
      totalPnl: w.totalPnl,
    }));
  }

getTotalBalance(): number {
    let total = 0;
    for (const [, entry] of this.wallets) {
      total += entry.balance;
    }
    return total;
  }

  getCount(): number {
    return this.wallets.size;
  }
}
