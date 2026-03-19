import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { WalletInterface, LoggerInterface } from '../types';

interface StoredWallet {
  name: string;
  address: string;
  privateKey: string;   // base58-encoded
  createdAt: number;
}

interface WalletStore {
  activeAddress: string;
  wallets: StoredWallet[];
}

const WALLETS_FILE = path.join('./data', 'wallets.json');

function loadStore(): WalletStore {
  try {
    if (fs.existsSync(WALLETS_FILE)) {
      return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    }
  } catch {}
  return { activeAddress: '', wallets: [] };
}

function saveStore(store: WalletStore): void {
  const dir = path.dirname(WALLETS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export class SolanaWallet implements WalletInterface {
  private connection: Connection;
  private keypair: Keypair | null = null;
  private logger: LoggerInterface;

  constructor(rpcUrl: string, logger: LoggerInterface, privateKeyOrPath?: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.logger = logger;

    // 1) If explicit key from env — use it
    if (privateKeyOrPath) {
      if (fs.existsSync(privateKeyOrPath)) {
        const raw = fs.readFileSync(privateKeyOrPath, 'utf-8');
        const bytes = JSON.parse(raw);
        this.keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
      } else {
        const decoded = bs58.decode(privateKeyOrPath);
        this.keypair = Keypair.fromSecretKey(decoded);
      }
      this.logger.info(`Wallet loaded: ${this.getAddress()}`);
      return;
    }

    // 2) Try loading the active wallet from persistent store
    const store = loadStore();
    if (store.activeAddress && store.wallets.length > 0) {
      const active = store.wallets.find(w => w.address === store.activeAddress) || store.wallets[0];
      try {
        const decoded = bs58.decode(active.privateKey);
        this.keypair = Keypair.fromSecretKey(decoded);
        this.logger.info(`Wallet restored from storage: ${active.name} (${this.getAddress()})`);
        return;
      } catch {
        this.logger.warn('Failed to restore wallet from storage — corrupted entry.');
      }
    }

    // 3) No wallet at all
    this.keypair = null;
    this.logger.warn('No wallet configured — waiting for user to generate or import.');
  }

  hasWallet(): boolean {
    return this.keypair !== null;
  }

  private requireKeypair(): Keypair {
    if (!this.keypair) throw new Error('No wallet configured. Generate or import a wallet first.');
    return this.keypair;
  }

  // ======= Multi-wallet store methods =======

  getStoredWallets(): StoredWallet[] {
    return loadStore().wallets.map(w => ({ ...w, privateKey: '' })); // don't leak keys
  }

  addCurrentToStore(name: string): void {
    const kp = this.requireKeypair();
    const store = loadStore();
    const address = kp.publicKey.toBase58();
    // Don't add duplicates
    if (store.wallets.some(w => w.address === address)) {
      // Just update name & set active
      store.wallets = store.wallets.map(w => w.address === address ? { ...w, name } : w);
    } else {
      store.wallets.push({
        name,
        address,
        privateKey: bs58.encode(kp.secretKey),
        createdAt: Date.now(),
      });
    }
    store.activeAddress = address;
    saveStore(store);
  }

  switchToWallet(address: string): boolean {
    const store = loadStore();
    const entry = store.wallets.find(w => w.address === address);
    if (!entry) return false;
    try {
      const decoded = bs58.decode(entry.privateKey);
      this.keypair = Keypair.fromSecretKey(decoded);
      store.activeAddress = address;
      saveStore(store);
      this.logger.info(`Switched to wallet: ${entry.name} (${address})`);
      return true;
    } catch {
      return false;
    }
  }

  removeFromStore(address: string): boolean {
    const store = loadStore();
    const idx = store.wallets.findIndex(w => w.address === address);
    if (idx === -1) return false;
    store.wallets.splice(idx, 1);
    // If we removed the active wallet, switch to the first remaining one or clear
    if (store.activeAddress === address) {
      if (store.wallets.length > 0) {
        const next = store.wallets[0];
        store.activeAddress = next.address;
        saveStore(store);
        // Load the keypair directly
        try {
          const decoded = bs58.decode(next.privateKey);
          this.keypair = Keypair.fromSecretKey(decoded);
          this.logger.info(`Switched to wallet: ${next.name} (${next.address})`);
        } catch {
          this.keypair = null;
        }
      } else {
        store.activeAddress = '';
        this.keypair = null;
        saveStore(store);
      }
    } else {
      saveStore(store);
    }
    return true;
  }

  renameInStore(address: string, newName: string): boolean {
    const store = loadStore();
    const entry = store.wallets.find(w => w.address === address);
    if (!entry) return false;
    entry.name = newName;
    saveStore(store);
    return true;
  }

  getAddress(): string {
    return this.keypair ? this.keypair.publicKey.toBase58() : '';
  }

  getPublicKey(): PublicKey {
    return this.requireKeypair().publicKey;
  }

  getConnection(): Connection {
    return this.connection;
  }

  updateRpc(rpcUrl: string): void {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.logger.info(`Wallet RPC updated: ${rpcUrl.substring(0, 40)}...`);
  }

  async getBalance(): Promise<number> {
    const kp = this.requireKeypair();
    const lamports = await this.connection.getBalance(kp.publicKey);
    return lamports / 1_000_000_000;
  }

  async getTokenBalance(mint: string): Promise<number> {
    try {
      const kp = this.requireKeypair();
      const mintPubkey = new PublicKey(mint);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        kp.publicKey,
        { mint: mintPubkey }
      );

      if (accounts.value.length === 0) return 0;

      const amount = accounts.value[0].account.data.parsed.info.tokenAmount;
      return Number(amount.uiAmount || 0);
    } catch {
      return 0;
    }
  }

  async sign(transaction: Transaction | VersionedTransaction): Promise<Transaction | VersionedTransaction> {
    const kp = this.requireKeypair();
    if (transaction instanceof Transaction) {
      transaction.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = kp.publicKey;
      transaction.sign(kp);
      return transaction;
    }

    (transaction as VersionedTransaction).sign([kp]);
    return transaction;
  }

  async signAndSend(transaction: Transaction | VersionedTransaction): Promise<string> {
    const kp = this.requireKeypair();
    if (transaction instanceof Transaction) {
      transaction.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = kp.publicKey;

      const txHash = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [kp],
        { commitment: 'confirmed' }
      );
      return txHash;
    }

    // VersionedTransaction
    (transaction as VersionedTransaction).sign([kp]);
    const raw = (transaction as VersionedTransaction).serialize();
    const txHash = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(txHash, 'confirmed');
    return txHash;
  }

  exportPrivateKey(): string {
    return bs58.encode(this.requireKeypair().secretKey);
  }

  importFromKey(privateKey: string, name?: string): void {
    const decoded = bs58.decode(privateKey);
    this.keypair = Keypair.fromSecretKey(decoded);
    this.logger.info(`Wallet imported: ${this.getAddress()}`);
    this.addCurrentToStore(name || 'Imported ' + this.getAddress().substring(0, 6));
  }

  generateNew(name?: string): { address: string; privateKey: string } {
    this.keypair = Keypair.generate();
    this.logger.info(`New wallet generated: ${this.getAddress()}`);
    this.addCurrentToStore(name || 'Wallet ' + this.getAddress().substring(0, 6));
    return { address: this.getAddress(), privateKey: this.exportPrivateKey() };
  }

  async simulateTransaction(transaction: Transaction): Promise<{ success: boolean; error?: string }> {
    try {
      const kp = this.requireKeypair();
      transaction.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = kp.publicKey;

      const result = await this.connection.simulateTransaction(transaction);
      if (result.value.err) {
        return { success: false, error: JSON.stringify(result.value.err) };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
