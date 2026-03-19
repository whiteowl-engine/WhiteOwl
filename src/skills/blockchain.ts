import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

export class BlockchainSkill implements Skill {
  manifest: SkillManifest = {
    name: 'blockchain',
    version: '2.0.0',
    description: 'Solana on-chain intelligence: address identification, wallet profiling, token creation detection, RPC management',
    tools: [
      {
        name: 'identify_address',
        description: 'ALWAYS call this FIRST when you receive any Solana address. Identifies whether the address is a WALLET, TOKEN MINT, PROGRAM, or TOKEN ACCOUNT. Returns type + key details so you know which tools to call next.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Any Solana address (base58)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_rpc_status',
        description: 'Show current RPC configuration and test connectivity.',
        parameters: { type: 'object', properties: {}, required: [] },
        riskLevel: 'read',
      },
      {
        name: 'get_sol_balance',
        description: 'Get SOL balance of any wallet address on Solana',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Solana wallet address (base58)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_account_info',
        description: 'Get raw on-chain account info: owner program, data size, lamports',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Solana account address' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_transaction',
        description: 'Get details of a Solana transaction by signature',
        parameters: {
          type: 'object',
          properties: {
            signature: { type: 'string', description: 'Transaction signature (base58)' },
          },
          required: ['signature'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_token_supply',
        description: 'Get total and circulating supply of an SPL token by mint address',
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
        name: 'get_recent_transactions',
        description: 'Get recent transactions for any address with decoded instructions',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Any Solana address' },
            limit: { type: 'number', description: 'Number of transactions (max 20, default 5)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_token_accounts',
        description: 'Get all SPL token holdings of a wallet address',
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
        name: 'get_created_tokens',
        description: 'Find tokens CREATED (deployed) by a wallet address. Scans transaction history for InitializeMint instructions. Shows which tokens this wallet has launched.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Creator wallet address' },
            limit: { type: 'number', description: 'Max transactions to scan (default 50, max 200)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'test_rpc_url',
        description: 'Test connectivity and latency of a Solana RPC URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'RPC URL to test' },
          },
          required: ['url'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private solanaRpc = '';
  private heliusRpc = '';

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.solanaRpc = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const heliusKey = ctx.config.rpc?.heliusApiKey || process.env.HELIUS_API_KEY || '';
    this.heliusRpc = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : '';
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'identify_address': return this.identifyAddress(params.address);
      case 'get_rpc_status': return this.getRpcStatus();
      case 'test_rpc_url': return this.testRpcUrl(params.url);
      case 'get_sol_balance': return this.getSolBalance(params.address);
      case 'get_account_info': return this.getAccountInfo(params.address);
      case 'get_transaction': return this.getTransaction(params.signature);
      case 'get_token_supply': return this.getTokenSupply(params.mint);
      case 'get_recent_transactions': return this.getRecentTransactions(params.address, params.limit);
      case 'get_token_accounts': return this.getTokenAccounts(params.address);
      case 'get_created_tokens': return this.getCreatedTokens(params.address, params.limit);
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

  // Expose for runtime hot-reload
  updateRpc(solanaRpc: string, heliusRpc?: string): void {
    this.solanaRpc = solanaRpc;
    if (heliusRpc !== undefined) this.heliusRpc = heliusRpc;
  }

  private getRpcUrl(): string {
    return this.heliusRpc || this.solanaRpc;
  }

  private async rpcCall(method: string, params: any[], rpcUrl?: string): Promise<any> {
    const url = rpcUrl || this.getRpcUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const data = await res.json() as any;
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  private async getRpcStatus(): Promise<any> {
    const status: any = {
      solanaRpc: this.solanaRpc,
      heliusConfigured: !!this.heliusRpc,
      activeRpc: this.getRpcUrl().substring(0, 50) + '...',
    };

    // Test connectivity
    try {
      const start = Date.now();
      const health = await this.rpcCall('getHealth', [], this.solanaRpc);
      status.solanaLatency = Date.now() - start;
      status.solanaStatus = health === 'ok' ? 'connected' : health;
    } catch (err: any) {
      status.solanaStatus = `error: ${err.message}`;
    }

    if (this.heliusRpc) {
      try {
        const start = Date.now();
        await this.rpcCall('getHealth', [], this.heliusRpc);
        status.heliusLatency = Date.now() - start;
        status.heliusStatus = 'connected';
      } catch (err: any) {
        status.heliusStatus = `error: ${err.message}`;
      }
    }

    // Get slot to verify chain health
    try {
      status.currentSlot = await this.rpcCall('getSlot', []);
    } catch {}

    return status;
  }

  private async testRpcUrl(url: string): Promise<any> {
    try {
      new URL(url);
    } catch {
      return { success: false, error: 'Invalid URL format' };
    }
    try {
      const start = Date.now();
      const health = await this.rpcCall('getHealth', [], url);
      const latency = Date.now() - start;
      const slot = await this.rpcCall('getSlot', [], url);
      return { success: true, latency, health, currentSlot: slot };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async getSolBalance(address: string): Promise<any> {
    const lamports = await this.rpcCall('getBalance', [address]);
    const sol = (lamports?.value ?? lamports) / 1_000_000_000;
    return { address, balanceSol: sol, balanceLamports: lamports?.value ?? lamports };
  }

  private async getAccountInfo(address: string): Promise<any> {
    const info = await this.rpcCall('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
    if (!info?.value) return { address, exists: false };
    const v = info.value;
    return {
      address,
      exists: true,
      lamports: v.lamports,
      solBalance: v.lamports / 1_000_000_000,
      owner: v.owner,
      executable: v.executable,
      dataSize: v.data?.length || (v.data?.parsed ? 'parsed' : 0),
      rentEpoch: v.rentEpoch,
    };
  }

  private async getTransaction(signature: string): Promise<any> {
    const tx = await this.rpcCall('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) return { signature, found: false };
    return {
      signature,
      found: true,
      slot: tx.slot,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
      fee: tx.meta?.fee ? tx.meta.fee / 1_000_000_000 : 0,
      status: tx.meta?.err ? 'failed' : 'success',
      error: tx.meta?.err || null,
      programIds: tx.transaction?.message?.accountKeys?.filter((k: any) => k.signer === false && k.writable === false).map((k: any) => k.pubkey).slice(0, 5) || [],
      logMessages: tx.meta?.logMessages?.slice(0, 10) || [],
    };
  }

  private async getTokenSupply(mint: string): Promise<any> {
    const result = await this.rpcCall('getTokenSupply', [mint]);
    if (!result?.value) return { mint, error: 'Token not found' };
    return {
      mint,
      amount: result.value.amount,
      decimals: result.value.decimals,
      uiAmount: result.value.uiAmount,
    };
  }

  private async getRecentTransactions(address: string, limit?: number): Promise<any> {
    const n = Math.min(limit || 5, 20);
    const sigs = await this.rpcCall('getSignaturesForAddress', [address, { limit: n }]);
    if (!sigs || sigs.length === 0) return { address, transactions: [], count: 0 };
    return {
      address,
      count: sigs.length,
      transactions: sigs.map((s: any) => ({
        signature: s.signature,
        slot: s.slot,
        time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
        status: s.err ? 'failed' : 'success',
        memo: s.memo || null,
      })),
    };
  }

  private async getTokenAccounts(address: string): Promise<any> {
    const result = await this.rpcCall('getTokenAccountsByOwner', [
      address,
      { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed' },
    ]);
    if (!result?.value) return { address, tokens: [], count: 0 };
    const tokens = result.value
      .map((a: any) => {
        const info = a.account?.data?.parsed?.info;
        if (!info) return null;
        return {
          mint: info.mint,
          balance: info.tokenAmount?.uiAmount || 0,
          decimals: info.tokenAmount?.decimals || 0,
        };
      })
      .filter((t: any) => t && t.balance > 0)
      .sort((a: any, b: any) => b.balance - a.balance)
      .slice(0, 30);
    return { address, count: tokens.length, tokens };
  }

  private async identifyAddress(address: string): Promise<any> {
    try {
      const info = await this.rpcCall('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
      if (!info?.value) {
        return { address, type: 'unknown', exists: false, hint: 'Account does not exist on-chain or has never been funded.' };
      }

      const v = info.value;
      const owner = v.owner;
      const solBalance = v.lamports / 1_000_000_000;

      // Executable = on-chain program
      if (v.executable) {
        return { address, type: 'program', owner, solBalance, hint: 'This is a deployed Solana program. Use get_account_info for details.' };
      }

      // Token mint or token account (SPL Token Program)
      if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
        const parsed = v.data?.parsed;
        if (parsed?.type === 'mint') {
          const mintInfo = parsed.info || {};
          return {
            address,
            type: 'token_mint',
            owner,
            supply: mintInfo.supply,
            decimals: mintInfo.decimals,
            mintAuthority: mintInfo.mintAuthority || null,
            freezeAuthority: mintInfo.freezeAuthority || null,
            hint: 'This is a TOKEN MINT. Use analyze_token, security_check, check_holders, get_token_supply for analysis. To find the dev/creator wallet, use analyze_token (returns dev field) or check_dev_wallet (auto-resolves mint to dev wallet).',
          };
        }
        if (parsed?.type === 'account') {
          const accInfo = parsed.info || {};
          return {
            address,
            type: 'token_account',
            owner,
            tokenMint: accInfo.mint,
            accountOwner: accInfo.owner,
            balance: accInfo.tokenAmount?.uiAmount || 0,
            hint: 'This is a TOKEN ACCOUNT (holds tokens). The wallet that owns it: ' + (accInfo.owner || 'unknown'),
          };
        }
        return { address, type: 'token_related', owner, hint: 'Owned by Token Program but type unclear.' };
      }

      // System Program = regular wallet
      if (owner === SYSTEM_PROGRAM) {
        return {
          address,
          type: 'wallet',
          owner,
          solBalance,
          hint: 'This is a WALLET address. Use get_sol_balance, get_token_accounts, get_recent_transactions, get_created_tokens for full profile.',
        };
      }

      // Other program-owned account (e.g., stake, vote, etc.)
      return {
        address,
        type: 'program_account',
        owner,
        solBalance,
        dataSize: v.data?.length || (v.data?.parsed ? 'parsed' : 0),
        hint: `Account owned by program ${owner}. Could be a PDA, stake account, or protocol account.`,
      };
    } catch (err: any) {
      return { address, type: 'error', error: err.message };
    }
  }

  private async getCreatedTokens(address: string, limit?: number): Promise<any> {
    const scanLimit = Math.min(limit || 50, 200);
    const createdTokens: any[] = [];

    try {
      // Get transaction signatures for this address
      const sigs = await this.rpcCall('getSignaturesForAddress', [address, { limit: scanLimit }]);
      if (!sigs || sigs.length === 0) {
        return { address, createdTokens: [], count: 0, scanned: 0, note: 'No transactions found for this address.' };
      }

      // Fetch transactions in batches of 5
      for (let i = 0; i < sigs.length; i += 5) {
        const batch = sigs.slice(i, i + 5);
        const txPromises = batch.map((s: any) =>
          this.rpcCall('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).catch(() => null)
        );
        const txResults = await Promise.all(txPromises);

        for (const tx of txResults) {
          if (!tx?.meta || tx.meta.err) continue;

          // Check inner instructions and main instructions for token creation
          const allInstructions = [
            ...(tx.transaction?.message?.instructions || []),
            ...(tx.meta?.innerInstructions?.flatMap((ii: any) => ii.instructions) || []),
          ];

          for (const ix of allInstructions) {
            const parsed = ix.parsed;
            if (!parsed) continue;

            // InitializeMint or InitializeMint2 from Token Program
            if (
              (parsed.type === 'initializeMint' || parsed.type === 'initializeMint2') &&
              (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM || ix.program === 'spl-token')
            ) {
              const mint = parsed.info?.mint;
              const authority = parsed.info?.mintAuthority;
              if (mint && !createdTokens.find((t) => t.mint === mint)) {
                createdTokens.push({
                  mint,
                  mintAuthority: authority || null,
                  freezeAuthority: parsed.info?.freezeAuthority || null,
                  decimals: parsed.info?.decimals,
                  txSignature: tx.transaction?.signatures?.[0] || null,
                  blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
                });
              }
            }

            // Also detect createAccount for mints (system instruction pairing)
            if (parsed.type === 'create' && ix.program === 'system' && parsed.info?.owner === TOKEN_PROGRAM) {
              // This is a system create for a token — the InitializeMint will be in another instruction
              // Already handled above
            }
          }
        }
      }

      return {
        address,
        count: createdTokens.length,
        scanned: sigs.length,
        createdTokens,
        hint: createdTokens.length > 0
          ? `Found ${createdTokens.length} tokens created by this wallet. Use analyze_token on each mint for details.`
          : `No token creations found in the last ${sigs.length} transactions. Try increasing the limit.`,
      };
    } catch (err: any) {
      return { address, createdTokens: [], count: 0, error: err.message };
    }
  }
}
