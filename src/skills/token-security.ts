import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface } from '../types.ts';

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
  securityScore: number;
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
  private readonly CACHE_TTL = 5 * 60_000;
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


  private async fullSecurityCheck(mint: string): Promise<SecurityAudit> {
    const cached = this.getCached(mint);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }

    this.stats.totalChecks++;

    const rpcUrl = this.getRpcUrl();
    const flags: string[] = [];
    let securityScore = 100;


    const mintInfo = await this.fetchMintInfo(rpcUrl, mint);
    if (!mintInfo) {
      return this.buildAudit(mint, {
        securityScore: 30,
        flags: ['mint_info_unavailable'],
      });
    }


    const mintAuthorityRevoked = mintInfo.mintAuthority === null;
    const mintAuthority = mintInfo.mintAuthority;
    if (!mintAuthorityRevoked) {
      securityScore -= 35;
      flags.push('mint_authority_active');
      this.stats.mintAuthorityActive++;
    }


    const freezeAuthorityRevoked = mintInfo.freezeAuthority === null;
    const freezeAuthority = mintInfo.freezeAuthority;
    if (!freezeAuthorityRevoked) {
      securityScore -= 30;
      flags.push('freeze_authority_active');
      this.stats.freezeAuthorityActive++;
    }


    let metadataMutable = false;
    try {
      metadataMutable = await this.checkMetadataMutability(rpcUrl, mint);
      if (metadataMutable) {
        securityScore -= 10;
        flags.push('metadata_mutable');
        this.stats.metadataMutable++;
      }
    } catch {

    }


    let lpLocked = false;
    let lpLockDurationDays = 0;
    try {
      const lpResult = await this.checkLpLockStatus(rpcUrl, mint);
      lpLocked = lpResult.locked;
      lpLockDurationDays = lpResult.durationDays;
      if (lpLocked) {
        securityScore += 10;
        flags.push(`lp_locked_${lpLockDurationDays}d`);
        this.stats.lpLocked++;
      }
    } catch {

    }


    const totalSupply = mintInfo.supply;
    const decimals = mintInfo.decimals;

    securityScore = Math.max(0, Math.min(100, securityScore));


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


    const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

    try {


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


      const buffer = Buffer.from(accountData, 'base64');


      if (buffer.length > 300) {


        for (let offset = Math.min(buffer.length - 1, 350); offset >= 300; offset--) {

          if (buffer[offset] === 1 || buffer[offset] === 0) {
            return buffer[offset] === 1;
          }
        }
      }

      return false;
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

    try {

            const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
      });

      if (!res.ok) return { graduated: false, locked: false, durationDays: 0, platform: null };

      const json = await res.json() as any;
      const t = json?.data?.token;

      if (!t || !t.pool_address) {
        return { graduated: false, locked: false, durationDays: 0, platform: null };
      }

      const liquidity = t.liquidity || 0;
      const launchpad = t.launchpad || '';

      if (launchpad === 'pump.fun' && liquidity > 0) {
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
