import { Skill, SkillManifest, SkillContext, TradeIntent, TradeResult, LoggerInterface, EventBusInterface, WalletInterface } from '../types';
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, Connection, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
} from '@pump-fun/pump-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';

const JUPITER_API = 'https://quote-api.jup.ag/v6';
const JITO_BUNDLE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Retry wrapper with exponential backoff for RPC/network calls.
 */
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

export class PumpTraderSkill implements Skill {
  manifest: SkillManifest = {
    name: 'pump-trader',
    version: '2.0.0',
    description: 'Execute buy/sell trades via official pump.fun SDK (on-chain) and Jupiter (for graduated tokens)',
    tools: [
      {
        name: 'buy_token',
        description: 'Buy a token using SOL. Uses pump.fun for bonding curve tokens or Jupiter for graduated tokens.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            amountSol: { type: 'number', description: 'Amount of SOL to spend' },
            slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 1500)' },
          },
          required: ['mint', 'amountSol'],
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
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private wallet!: WalletInterface;
  private pumpSdk!: OnlinePumpSdk;
  private pumpGlobal: Global | null = null;
  private pumpFeeConfig: FeeConfig | null = null;
  private globalCacheTime = 0;
  private readonly GLOBAL_CACHE_TTL = 60_000; // cache global config 60s

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.wallet = ctx.wallet;

    // Initialize pump SDK with our RPC connection
    const rpcUrl = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    this.pumpSdk = new OnlinePumpSdk(connection);
    this.logger.info('Pump SDK initialized (official @pump-fun/pump-sdk)');
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
      case 'buy_token':
        return this.buyToken(params.mint, params.amountSol, params.slippageBps);
      case 'sell_token':
        return this.sellToken(params.mint, params.percent || 100, params.slippageBps);
      case 'get_quote':
        return this.getQuote(params.inputMint, params.outputMint, params.amount);
      case 'get_balance':
        return this.getBalance();
      case 'fast_buy':
        return this.fastBuy(params.mint, params.amountSol, params.slippageBps, params.useJito, params.jitoTipLamports);
      case 'fast_sell':
        return this.fastSell(params.mint, params.percent || 100, params.slippageBps, params.useJito);
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

  private async buyToken(
    mint: string,
    amountSol: number,
    slippageBps: number = 1500
  ): Promise<TradeResult> {
    const intentId = `buy_${Date.now()}_${mint.slice(0, 8)}`;

    const intent: TradeIntent = {
      id: intentId,
      agentId: 'pump-trader',
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
      // Try Jupiter first for graduated tokens
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
      // Get token balance
      const balRes = await this.getTokenBalance(mint);
      if (!balRes || balRes.amount <= 0) {
        return { intentId, success: false, error: 'No token balance', timestamp: Date.now() };
      }

      const sellAmount = Math.floor(balRes.rawAmount * (percent / 100));

      const intent: TradeIntent = {
        id: intentId,
        agentId: 'pump-trader',
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
    // 1) Get quote (with retry)
    const quote = await rpcRetry(async () => {
      const quoteUrl = new URL(`${JUPITER_API}/quote`);
      quoteUrl.searchParams.set('inputMint', inputMint);
      quoteUrl.searchParams.set('outputMint', outputMint);
      quoteUrl.searchParams.set('amount', String(amount));
      quoteUrl.searchParams.set('slippageBps', String(slippageBps));

      const quoteRes = await fetch(quoteUrl.toString());
      if (!quoteRes.ok) {
        throw new Error(`Jupiter quote failed: ${await quoteRes.text()}`);
      }
      return quoteRes.json() as any;
    });

    // 2) Get swap transaction (with retry)
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

    // 3) Deserialize, sign, and send (with retry)
    const tx = VersionedTransaction.deserialize(txBuf);
    const txHash = await rpcRetry(() => this.wallet.signAndSend(tx));

    return txHash;
  }

  private async getQuote(inputMint: string, outputMint: string, amount: number): Promise<any> {
    const url = new URL(`${JUPITER_API}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', String(amount));
    url.searchParams.set('slippageBps', '100');

    const res = await fetch(url.toString());
    if (!res.ok) return { error: `Quote request failed: ${res.status}` };
    return res.json();
  }

  private async getTokenBalance(mint: string): Promise<{ amount: number; rawAmount: number; decimals: number } | null> {
    try {
      return await rpcRetry(async () => {
        const walletAddr = this.wallet.getAddress();
        const res = await fetch(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccountsByOwner',
            params: [
              walletAddr,
              { mint },
              { encoding: 'jsonParsed' },
            ],
          }),
        });

        const data = await res.json() as any;
        const accounts = data.result?.value || [];
        if (accounts.length === 0) return null;

        const info = accounts[0].account.data.parsed.info.tokenAmount;
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

  // ===========================================
  // Fast path: Direct pump.fun bonding curve
  // Bypasses Jupiter for pre-graduation tokens
  // Typical speed gain: 500-1500ms faster
  // ===========================================

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
      agentId: 'pump-trader',
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

      // Fetch on-chain state via official SDK
      const { global, feeConfig } = await this.getGlobalConfig();
      const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
        await this.pumpSdk.fetchBuyState(mintPk, userPk);

      if (bondingCurve.complete) {
        this.logger.debug('Token graduated, falling back to Jupiter');
        return this.buyToken(mint, amountSol, slippageBps);
      }

      // Calculate exact token amount using SDK math
      const tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: solAmountBN,
      });

      // Build buy instructions via official SDK
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
        tokenProgram: TOKEN_PROGRAM_ID,
      });

      // Build transaction with compute budget
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
      // Fallback to Jupiter if SDK fails
      this.logger.debug(`Pump SDK buy failed (${err.message}), falling back to Jupiter`);
      return this.buyToken(mint, amountSol, slippageBps);
    }
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
        agentId: 'pump-trader',
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

      // Fetch on-chain state via official SDK
      const { global, feeConfig } = await this.getGlobalConfig();
      const { bondingCurveAccountInfo, bondingCurve } =
        await this.pumpSdk.fetchSellState(mintPk, userPk);

      if (bondingCurve.complete) {
        this.logger.debug('Token graduated, falling back to Jupiter for sell');
        return this.sellToken(mint, percent, slippageBps);
      }

      // Calculate SOL amount using SDK math
      const solAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: tokenAmountBN,
      });

      // Build sell instructions via official SDK
      const ixs = await PUMP_SDK.sellInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        mint: mintPk,
        user: userPk,
        amount: tokenAmountBN,
        solAmount,
        slippage: slippageBps / 100,
        tokenProgram: TOKEN_PROGRAM_ID,
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
      // Fallback to Jupiter if SDK fails
      this.logger.debug(`Pump SDK sell failed (${err.message}), falling back to Jupiter`);
      return this.sellToken(mint, percent, slippageBps);
    }
  }

  /**
   * Send transaction via Jito bundle for MEV protection and faster inclusion.
   * Adds a tip to a random Jito tip account.
   */
  private async sendViaJito(tx: VersionedTransaction, tipLamports: number): Promise<string> {
    // Sign the transaction (wallet.sign returns the signed tx without sending)
    const signed = await this.wallet.sign(tx) as VersionedTransaction;
    const serialized = Buffer.from(signed.serialize()).toString('base64');

    // Send exclusively via Jito bundle for MEV protection
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
      // Fallback: send normally if Jito fails
      return this.wallet.signAndSend(tx);
    }

    const bundleData = await bundleRes.json() as any;
    if (bundleData.result) {
      this.logger.debug(`Jito bundle accepted: ${bundleData.result}`);
    }

    // Return the tx signature encoded as base58 (Solana standard)
    const sig = bs58.encode(Buffer.from(signed.signatures[0]));

    // Poll Jito bundle status for confirmation
    this.pollBundleStatus(bundleData.result, sig).catch((err) => {
      this.logger.debug(`Jito bundle status polling failed: ${err.message}`);
    });

    return sig;
  }

  /**
   * Poll Jito getBundleStatuses for confirmation after sending a bundle.
   */
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
        // Continue polling
      }
    }

    this.logger.warn(`Jito bundle ${bundleId.slice(0, 8)} status unknown after ${maxAttempts} polls`);
  }
}
