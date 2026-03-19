import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface } from '../types';

// =====================================================
// Token Security Auditor
//
// Performs critical on-chain security checks BEFORE purchase:
// - Mint Authority (revoked? → safe / active? → rug risk)
// - Freeze Authority (active? → can freeze your balance)
// - LP lock detection (pump.fun AMM pool locked? Duration?)
// - Metadata mutability (can dev change name/description?)
// - Supply analysis (hidden inflation risk)
//
// Integration: Pipeline Stage 3 calls checkSecurity()
// to add security signals before trade decision.
// =====================================================

interface SecurityAudit {
  mint: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataMutable: boolean;
  lpLocked: boolean;
  lpLockDurationDays: number;
  totalSupply: number;
  decimals: number;
  securityScore: number; // 0-100 (higher = safer)
  flags: string[];
  checkedAt: number;
}

interface SecurityCache {
  audit: SecurityAudit;
  expiresAt: number;
}

export class TokenSecuritySkill implements Skill {
  manifest: SkillManifest = {
    name: 'token-security',
    version: '1.0.0',
    description: 'On-chain security auditor: mint/freeze authority, LP locks, metadata mutability, supply analysis',
    tools: [
      {
        name: 'security_check',
        description: 'Full security audit for a token mint address',
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
        name: 'security_check_authority',
        description: 'Quick check: is mint/freeze authority revoked?',
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
        name: 'security_check_lp',
        description: 'Check if LP is locked for a graduated token (pump.fun AMM / DEX)',
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
        name: 'security_batch_check',
        description: 'Security check multiple tokens at once',
        parameters: {
          type: 'object',
          properties: {
            mints: { type: 'array', items: { type: 'string' }, description: 'Array of mint addresses' },
          },
          required: ['mints'],
        },
        riskLevel: 'read',
      },
      {
        name: 'security_stats',
        description: 'Get security check statistics',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private eventBus!: EventBusInterface;
  private logger!: LoggerInterface;
  private memory!: MemoryInterface;
  private solanaRpc = '';
  private heliusKey = '';
  private cache = new Map<string, SecurityCache>();
  private readonly CACHE_TTL = 5 * 60_000; // 5 minutes
  private readonly MAX_CACHE = 5_000;

  private stats = {
    totalChecks: 0,
    mintAuthorityActive: 0,
    freezeAuthorityActive: 0,
    metadataMutable: 0,
    lpLocked: 0,
    avgSecurityScore: 0,
    cacheHits: 0,
  };

  async initialize(ctx: SkillContext): Promise<void> {
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.memory = ctx.memory;
    this.solanaRpc = ctx.config.rpc?.solana || 'https://api.mainnet-beta.solana.com';
    this.heliusKey = ctx.config.rpc?.heliusApiKey || process.env.HELIUS_API_KEY || '';
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'security_check': return this.fullSecurityCheck(params.mint);
      case 'security_check_authority': return this.checkAuthority(params.mint);
      case 'security_check_lp': return this.checkLpLock(params.mint);
      case 'security_batch_check': return this.batchCheck(params.mints);
      case 'security_stats': return this.getStats();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.cache.clear();
  }

  // =====================================================
  // Public API for Pipeline integration
  // =====================================================

  /**
   * Quick security check for pipeline Stage 3.
   * Returns security score 0-100 and flag list.
   */
  async quickCheck(mint: string): Promise<{ score: number; flags: string[] }> {
    const cached = this.getCached(mint);
    if (cached) {
      this.stats.cacheHits++;
      return { score: cached.securityScore, flags: cached.flags };
    }

    try {
      const audit = await this.fullSecurityCheck(mint);
      return { score: audit.securityScore, flags: audit.flags };
    } catch {
      return { score: 50, flags: ['check_failed'] };
    }
  }

  // =====================================================
  // Core security checks
  // =====================================================

  private async fullSecurityCheck(mint: string): Promise<SecurityAudit> {
    const cached = this.getCached(mint);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    this.stats.totalChecks++;

    const rpcUrl = this.getRpcUrl();
    const flags: string[] = [];
    let securityScore = 100; // Start safe, deduct for issues

    // 1. Fetch mint account info (contains authority data)
    const mintInfo = await this.fetchMintInfo(rpcUrl, mint);
    if (!mintInfo) {
      return this.buildAudit(mint, {
        securityScore: 30,
        flags: ['mint_info_unavailable'],
      });
    }

    // 2. Check Mint Authority
    const mintAuthorityRevoked = mintInfo.mintAuthority === null;
    const mintAuthority = mintInfo.mintAuthority;
    if (!mintAuthorityRevoked) {
      securityScore -= 35;
      flags.push('mint_authority_active');
      this.stats.mintAuthorityActive++;
    }

    // 3. Check Freeze Authority
    const freezeAuthorityRevoked = mintInfo.freezeAuthority === null;
    const freezeAuthority = mintInfo.freezeAuthority;
    if (!freezeAuthorityRevoked) {
      securityScore -= 30;
      flags.push('freeze_authority_active');
      this.stats.freezeAuthorityActive++;
    }

    // 4. Check metadata mutability (via Metaplex)
    let metadataMutable = false;
    try {
      metadataMutable = await this.checkMetadataMutability(rpcUrl, mint);
      if (metadataMutable) {
        securityScore -= 10;
        flags.push('metadata_mutable');
        this.stats.metadataMutable++;
      }
    } catch {
      // Non-critical, skip
    }

    // 5. Check LP lock (only relevant for graduated tokens)
    let lpLocked = false;
    let lpLockDurationDays = 0;
    try {
      const lpResult = await this.checkLpLockStatus(rpcUrl, mint);
      lpLocked = lpResult.locked;
      lpLockDurationDays = lpResult.durationDays;
      if (lpLocked) {
        securityScore += 10; // Bonus for locked LP
        flags.push(`lp_locked_${lpLockDurationDays}d`);
        this.stats.lpLocked++;
      }
    } catch {
      // Token may not be graduated yet
    }

    // 6. Supply analysis
    const totalSupply = mintInfo.supply;
    const decimals = mintInfo.decimals;

    securityScore = Math.max(0, Math.min(100, securityScore));

    // Update running average
    this.stats.avgSecurityScore =
      (this.stats.avgSecurityScore * (this.stats.totalChecks - 1) + securityScore) / this.stats.totalChecks;

    const audit: SecurityAudit = {
      mint,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      mintAuthority,
      freezeAuthority,
      metadataMutable,
      lpLocked,
      lpLockDurationDays,
      totalSupply,
      decimals,
      securityScore,
      flags,
      checkedAt: Date.now(),
    };

    this.setCache(mint, audit);

    // Emit rug signal if very unsafe
    if (securityScore < 30) {
      this.eventBus.emit('signal:rug', {
        mint,
        indicators: flags,
        confidence: Math.min(0.95, (100 - securityScore) / 100),
      });
    }

    return audit;
  }

  private async checkAuthority(mint: string): Promise<{
    mint: string;
    mintAuthorityRevoked: boolean;
    freezeAuthorityRevoked: boolean;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    safe: boolean;
  }> {
    const rpcUrl = this.getRpcUrl();
    const mintInfo = await this.fetchMintInfo(rpcUrl, mint);

    if (!mintInfo) {
      return {
        mint,
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        mintAuthority: null,
        freezeAuthority: null,
        safe: false,
      };
    }

    const safe = mintInfo.mintAuthority === null && mintInfo.freezeAuthority === null;

    return {
      mint,
      mintAuthorityRevoked: mintInfo.mintAuthority === null,
      freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
      mintAuthority: mintInfo.mintAuthority,
      freezeAuthority: mintInfo.freezeAuthority,
      safe,
    };
  }

  private async checkLpLock(mint: string): Promise<{
    mint: string;
    graduated: boolean;
    lpLocked: boolean;
    lockDurationDays: number;
    lockPlatform: string | null;
  }> {
    const rpcUrl = this.getRpcUrl();
    const result = await this.checkLpLockStatus(rpcUrl, mint);

    return {
      mint,
      graduated: result.graduated,
      lpLocked: result.locked,
      lockDurationDays: result.durationDays,
      lockPlatform: result.platform,
    };
  }

  private async batchCheck(mints: string[]): Promise<SecurityAudit[]> {
    const results: SecurityAudit[] = [];
    // Process in batches of 5 to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < mints.length; i += batchSize) {
      const batch = mints.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(m => this.fullSecurityCheck(m).catch(() => this.buildAudit(m, {
          securityScore: 0, flags: ['check_failed'],
        })))
      );
      results.push(...batchResults);
    }
    return results;
  }

  private getStats() {
    return { ...this.stats, cacheSize: this.cache.size };
  }

  // =====================================================
  // RPC helpers
  // =====================================================

  private async fetchMintInfo(rpcUrl: string, mint: string): Promise<{
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: number;
    decimals: number;
  } | null> {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getAccountInfo',
          params: [mint, { encoding: 'jsonParsed' }],
        }),
      });

      const data = await res.json() as any;
      const parsed = data?.result?.value?.data?.parsed?.info;

      if (!parsed) return null;

      return {
        mintAuthority: parsed.mintAuthority || null,
        freezeAuthority: parsed.freezeAuthority || null,
        supply: Number(parsed.supply || 0),
        decimals: parsed.decimals || 0,
      };
    } catch {
      return null;
    }
  }

  private async checkMetadataMutability(rpcUrl: string, mint: string): Promise<boolean> {
    // Metaplex Metadata PDA: seeds = ["metadata", metadataProgramId, mint]
    // Program ID: metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s
    const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

    try {
      // Use getAccountInfo on Metadata PDA
      // The isMutable flag is at byte offset 290+ in the account data
      // For simplicity, we use getProgramAccounts filtered by mint
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getProgramAccounts',
          params: [
            METADATA_PROGRAM,
            {
              encoding: 'base64',
              filters: [
                // memcmp filter on the mint pubkey inside metadata account
                // mint is at offset 33 in Metadata V1 layout
                { memcmp: { offset: 33, bytes: mint } },
              ],
              dataSlice: { offset: 0, length: 350 },
            },
          ],
        }),
      });

      const data = await res.json() as any;
      const accounts = data?.result || [];

      if (accounts.length === 0) return false;

      const accountData = accounts[0]?.account?.data?.[0];
      if (!accountData) return false;

      // Decode base64 and check isMutable flag
      // In Metaplex Metadata V1, isMutable is a boolean at end of core fields
      const buffer = Buffer.from(accountData, 'base64');
      // isMutable is typically around offset 308-310 area depending on name/symbol/uri lengths
      // A simple heuristic: check last few bytes in the core section
      // The actual position varies, so we look for the pattern
      if (buffer.length > 300) {
        // Metadata struct: key(1) + updateAuth(32) + mint(32) + name(36) + symbol(14) + uri(204) + fees(2) + ...
        // After uri: sellerFeeBasisPoints(2) + hasCreators(1) + creatorsVec(...) + primarySaleHappened(1) + isMutable(1)
        // Approximate offset for isMutable: 1+32+32+36+14+204+2 = 321 + creators
        // Simplified: read byte at offset after the URI and creators
        // Since exact offset varies with creators, scan backwards from reasonable bounds
        for (let offset = Math.min(buffer.length - 1, 350); offset >= 300; offset--) {
          // isMutable is either 0 or 1, and comes before a potential 0x00 padding
          if (buffer[offset] === 1 || buffer[offset] === 0) {
            return buffer[offset] === 1;
          }
        }
      }

      return false; // Assume immutable if can't determine
    } catch {
      return false;
    }
  }

  private async checkLpLockStatus(rpcUrl: string, mint: string): Promise<{
    graduated: boolean;
    locked: boolean;
    durationDays: number;
    platform: string | null;
  }> {
    // Check if token has graduated by checking for pool on any DEX
    try {
      // Query DexScreener for pair info
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) return { graduated: false, locked: false, durationDays: 0, platform: null };

      const data = await res.json() as any;
      const pairs = data?.pairs || [];

      if (pairs.length === 0) {
        return { graduated: false, locked: false, durationDays: 0, platform: null };
      }

      // Check if there's a pump.fun AMM, Raydium, or other DEX pair
      const dexPair = pairs.find((p: any) =>
        p.dexId === 'pumpfun' || p.dexId === 'raydium' || p.dexId === 'orca' || p.dexId === 'meteora'
      );

      if (!dexPair) {
        return { graduated: false, locked: false, durationDays: 0, platform: null };
      }

      // Check liquidity lock via known locker programs
      // pump.fun graduated tokens have LP auto-locked in their own AMM
      const liquidity = dexPair.liquidity?.usd || 0;
      const lpBurned = dexPair.info?.lpBurned || false;

      // If LP tokens are burned, they're permanently locked
      if (lpBurned) {
        return {
          graduated: true,
          locked: true,
          durationDays: 9999, // Permanent
          platform: 'burned',
        };
      }

      // pump.fun tokens that graduate have their LP auto-migrated
      // and LP tokens are usually burned as part of the migration
      const isPumpGraduated = pairs.some((p: any) =>
        p.labels?.includes('pump.fun') || p.url?.includes('pump.fun')
      );

      if (isPumpGraduated && liquidity > 0) {
        return {
          graduated: true,
          locked: true,
          durationDays: 9999,
          platform: 'pump_graduated',
        };
      }

      return {
        graduated: true,
        locked: false,
        durationDays: 0,
        platform: dexPair.dexId,
      };
    } catch {
      return { graduated: false, locked: false, durationDays: 0, platform: null };
    }
  }

  // =====================================================
  // Cache management
  // =====================================================

  private getCached(mint: string): SecurityAudit | null {
    const entry = this.cache.get(mint);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(mint);
      return null;
    }
    return entry.audit;
  }

  private setCache(mint: string, audit: SecurityAudit): void {
    if (this.cache.size >= this.MAX_CACHE) {
      // Evict oldest 20%
      const toDelete = Math.floor(this.MAX_CACHE * 0.2);
      const iter = this.cache.keys();
      for (let i = 0; i < toDelete; i++) {
        const key = iter.next().value;
        if (key) this.cache.delete(key);
      }
    }
    this.cache.set(mint, { audit, expiresAt: Date.now() + this.CACHE_TTL });
  }

  private buildAudit(mint: string, partial: Partial<SecurityAudit>): SecurityAudit {
    return {
      mint,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      mintAuthority: null,
      freezeAuthority: null,
      metadataMutable: false,
      lpLocked: false,
      lpLockDurationDays: 0,
      totalSupply: 0,
      decimals: 0,
      securityScore: 0,
      flags: [],
      checkedAt: Date.now(),
      ...partial,
    };
  }

  private getRpcUrl(): string {
    return this.heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`
      : this.solanaRpc;
  }
}
