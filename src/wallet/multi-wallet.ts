/**
 * Multi-Wallet Manager — Phase 6
 *
 * Manages multiple Solana wallets for parallel trading:
 * - Round-robin or strategy-based wallet selection
 * - Per-wallet balance tracking and risk limits
 * - Automatic wallet rotation to avoid detection
 */

import { SolanaWallet } from './solana';
import { LoggerInterface } from '../types';

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

  /**
   * Add a wallet from private key (base58 or JSON array).
   */
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

  /**
   * Remove a wallet by ID.
   */
  removeWallet(id: string): boolean {
    return this.wallets.delete(id);
  }

  /**
   * Enable/disable a wallet.
   */
  setEnabled(id: string, enabled: boolean): void {
    const entry = this.wallets.get(id);
    if (entry) entry.enabled = enabled;
  }

  /**
   * Set wallet selection strategy.
   */
  setStrategy(strategy: WalletSelectionStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Select next wallet for trading based on strategy.
   */
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

  /**
   * Get a specific wallet.
   */
  getWallet(id: string): WalletEntry | undefined {
    return this.wallets.get(id);
  }

  /**
   * Record a trade on a wallet.
   */
  recordTrade(id: string, pnl: number): void {
    const entry = this.wallets.get(id);
    if (entry) {
      entry.totalTrades++;
      entry.totalPnl += pnl;
      entry.lastUsed = Date.now();
    }
  }

  /**
   * Refresh all wallet balances.
   */
  async refreshBalances(): Promise<void> {
    for (const [, entry] of this.wallets) {
      try {
        entry.balance = await entry.wallet.getBalance();
      } catch {
        entry.balance = 0;
      }
    }
  }

  /**
   * Get all wallets with status.
   */
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

  /**
   * Total balance across all wallets.
   */
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
