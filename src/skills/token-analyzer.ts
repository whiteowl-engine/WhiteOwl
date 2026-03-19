import { Skill, SkillManifest, SkillContext, TokenInfo, TokenAnalysis, HolderData, LoggerInterface, EventBusInterface } from '../types';

const HELIUS_RPC = 'https://mainnet.helius-rpc.com';

// Known DEX / AMM program IDs — accounts OWNED by these programs are liquidity pools
const DEX_PROGRAM_IDS = new Map<string, string>([
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  'pump.fun Bonding Curve'],
  ['PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu',  'pump.fun AMM'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM v4'],
  ['5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', 'Raydium CLMM'],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CPMM'],
  ['routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',  'Raydium Router'],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   'Orca Whirlpool'],
  ['9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', 'Orca v2'],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',   'Meteora DLMM'],
  ['Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',  'Meteora Pool'],
  ['M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K',   'M2/Tensor AMM'],
  ['SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr',   'Saros'],
  ['DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', 'Aldrin AMM'],
  ['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',   'Serum DEX v3'],
  ['opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQMQo8',   'Openbook v2'],
]);

// Known pool authority / vault addresses (direct match)
const KNOWN_POOL_AUTHORITIES = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority V4
  'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ', // Meteora Vault Authority
]);

// Legacy: direct match set for backward compat during owner resolution
const POOL_PROGRAMS = new Set([...DEX_PROGRAM_IDS.keys(), ...KNOWN_POOL_AUTHORITIES]);

const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111',
  'deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
  '1111111111111111111111111111111111111111111',
]);

// Token Program IDs — ATA accounts are always owned by one of these
const TOKEN_PROGRAMS = new Set([
  'TokenkegQvGj58wGBgs73xPopGXNqirbyS2qb9hXV',      // Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',    // Token-2022
]);

export class TokenAnalyzerSkill implements Skill {
  manifest: SkillManifest = {
    name: 'token-analyzer',
    version: '1.0.0',
    description: 'Comprehensive token analysis: metadata, holder distribution, rug detection, social signals',
    tools: [
      {
        name: 'analyze_token',
        description: 'Run full analysis on a token: metadata, holders, dev wallet, rug score. Returns a composite score 0-100.',
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
        name: 'check_holders',
        description: 'Get holder distribution for a token. Automatically identifies and separates liquidity pool accounts (Raydium, Orca, Meteora, pump.fun bonding curve, etc.) from real holders. Returns LP %, burned %, top holders with labels, and circulating supply metrics. IMPORTANT: large holders owned by DEX programs are liquidity pools, NOT real whale holders.',
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
        name: 'check_dev_wallet',
        description: 'Analyze developer wallet: balance, age, transaction count, known rug associations. Accepts EITHER a wallet address OR a token mint address — if a token mint is given, automatically resolves the creator/dev wallet from pump.fun API.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Developer wallet address OR token mint address (auto-resolves to dev wallet)' },
          },
          required: ['address'],
        },
        riskLevel: 'read',
      },
      {
        name: 'get_rug_score',
        description: 'Calculate rug pull risk score 0-100 (higher = more risky)',
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
        name: 'get_trending',
        description: 'Get trending tokens by volume, market cap, or holder growth over a period',
        parameters: {
          type: 'object',
          properties: {
            period: { type: 'string', enum: ['1h', '4h', '24h'], description: 'Time period' },
            by: { type: 'string', enum: ['volume', 'mcap', 'holders'], description: 'Sort metric' },
            limit: { type: 'number', description: 'Number of results' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'fetch_project_links',
        description: 'Deep content analysis of a token project\'s website, Twitter/X, and Telegram links. For Twitter: fetches full profile (bio, followers, account age, verified status, recent 10 tweets with engagement stats, media, quoted tweets). If the link is to a specific tweet — fetches the full tweet content, engagement, links, quoted content, and author profile. For website: extracts up to 10K chars of content, all headings, external links, roadmap/team/tokenomics/docs/audit indicators. For Telegram: title, description, subscriber count. ALWAYS pass the mint address to auto-resolve links from on-chain metadata.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address — will auto-resolve website/twitter/telegram links from on-chain metadata' },
            website: { type: 'string', description: 'Direct website URL (optional, overrides auto-resolve)' },
            twitter: { type: 'string', description: 'Direct Twitter/X URL (optional, overrides auto-resolve)' },
            telegram: { type: 'string', description: 'Direct Telegram URL (optional, overrides auto-resolve)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'fetch_tweet',
        description: 'Fetch a specific tweet/post from Twitter/X by URL or tweet ID. Returns full text, author info, engagement stats (likes, retweets, replies, views), media, links, quoted tweets, and reply context. Requires Twitter cookies to be configured. Use this when the user shares a tweet URL (x.com or twitter.com) or asks about a specific tweet.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Tweet URL (e.g. https://x.com/user/status/123456) or just the tweet ID' },
          },
          required: ['url'],
        },
        riskLevel: 'read',
      },
      {
        name: 'fetch_twitter_profile',
        description: 'Fetch a Twitter/X user profile with bio, followers, following, verified status, account age, and their recent 10 tweets with engagement stats. Requires Twitter cookies to be configured.',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Twitter username (without @) or profile URL' },
          },
          required: ['username'],
        },
        riskLevel: 'read',
      },
      {
        name: 'rate_project',
        description: 'Generate a comprehensive PROJECT RATING / SHIELD (щиток) — a holistic assessment combining on-chain data, social presence, dev reputation, community signals, website quality, and narrative fit. Returns a structured verdict with category scores, NOT just raw stats.',
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
        name: 'search_twitter_token',
        description: 'Search Twitter/X for mentions of a token by ticker ($SYMBOL), name, or contract address. Returns tweets with full text, engagement stats, author info, and links. Use this to find community sentiment, shilling, and organic discussion about a token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query — ticker (e.g. $BONK), token name, or contract address' },
            limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private heliusKey: string = '';
  private solanaRpc: string = '';
  private metadataCache = new Map<string, { data: TokenInfo; expiresAt: number }>();

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.heliusKey = ctx.config.rpc?.heliusApiKey || process.env.HELIUS_API_KEY || '';
    this.solanaRpc = ctx.config.rpc?.solana || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'analyze_token':
        return this.analyzeToken(params.mint);
      case 'check_holders':
        return this.checkHolders(params.mint);
      case 'check_dev_wallet':
        return this.checkDevWallet(params.address);
      case 'get_rug_score':
        return this.getRugScore(params.mint);
      case 'get_trending':
        return this.getTrending(params.period || '24h', params.by || 'volume', params.limit || 10);
      case 'fetch_project_links':
        return this.fetchProjectLinks(params.mint, params.website, params.twitter, params.telegram);
      case 'fetch_tweet':
        return this.handleFetchTweet(params.url);
      case 'fetch_twitter_profile':
        return this.handleFetchTwitterProfile(params.username);
      case 'rate_project':
        return this.rateProject(params.mint);

      case 'search_twitter_token':
        return this.searchTwitterForToken(params.query, params.limit || 20);
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}

  private async analyzeToken(mint: string, cachedTokenInfo?: TokenInfo | null, skipHolders: boolean = false): Promise<TokenAnalysis> {
    const signals: string[] = [];
    let score = 50;
    let rugScore = 50;

    // Use cached tokenInfo if available, otherwise fetch fresh
    let tokenInfo = cachedTokenInfo || await this.fetchTokenMetadata(mint);
    if (!tokenInfo) {
      tokenInfo = this.ctx.memory.getToken(mint);
    }

    if (!tokenInfo) {
      return {
        mint,
        score: 0,
        rugScore: 100,
        signals: ['Token not found'],
        recommendation: 'avoid',
        reasoning: 'Token metadata could not be fetched',
        analyzedAt: Date.now(),
      };
    }

    // Social presence check
    if (tokenInfo.twitter) {
      score += 10;
      signals.push('Has Twitter');
    } else {
      score -= 5;
      rugScore += 5;
    }

    if (tokenInfo.telegram) {
      score += 5;
      signals.push('Has Telegram');
    }

    if (tokenInfo.website) {
      score += 5;
      signals.push('Has Website');
    }

    // Run dev wallet + holder analysis in PARALLEL for speed
    // skipHolders=true when called from rateProject (GMGN provides holder metrics, saves 3 RPC calls)
    const [devInfo, holders] = await Promise.all([
      tokenInfo.dev ? this.checkDevWallet(tokenInfo.dev, true) : Promise.resolve(null),
      skipHolders ? Promise.resolve(null) : this.checkHolders(mint),
    ]);

    // Dev wallet analysis
    if (tokenInfo.dev && devInfo) {
      if (this.ctx.memory.isKnownRug(tokenInfo.dev)) {
        rugScore = 95;
        score = 5;
        signals.push('DEV IS KNOWN RUGGER');
      }

      if (devInfo.balanceSol > 2) {
        score += 5;
        signals.push(`Dev balance: ${devInfo.balanceSol.toFixed(2)} SOL`);
      }

      if (devInfo.accountAge > 30) {
        score += 10;
        signals.push(`Dev wallet age: ${devInfo.accountAge}d`);
      } else if (devInfo.accountAge < 1) {
        score -= 10;
        rugScore += 15;
        signals.push('Dev wallet is brand new');
      }
    }

    // Holder analysis
    if (holders && !('error' in holders)) {
      if (holders.top10Percent > 80) {
        score -= 20;
        rugScore += 20;
        signals.push(`High concentration: top10 own ${holders.top10Percent.toFixed(0)}%`);
      } else if (holders.top10Percent < 40) {
        score += 10;
        signals.push(`Good distribution: top10 own ${holders.top10Percent.toFixed(0)}%`);
      }

      if (holders.isBundled) {
        score -= 15;
        rugScore += 25;
        signals.push('Bundled wallets detected');
      }

      if (holders.totalHolders > 100) {
        score += 10;
        signals.push(`${holders.totalHolders} holders`);
      }
    }

    // Bonding curve position
    if (tokenInfo.bondingCurveProgress < 10) {
      score += 5;
      signals.push(`Early bonding: ${tokenInfo.bondingCurveProgress.toFixed(1)}%`);
    } else if (tokenInfo.bondingCurveProgress > 80) {
      score -= 5;
      signals.push('Near graduation — higher risk entry');
    }

    // Pattern uniqueness check — penalize repeated patterns
    const patternCheck = this.checkPatternUniqueness(mint, tokenInfo, null);
    if (patternCheck.penalty > 0) {
      score -= patternCheck.penalty;
      rugScore += Math.round(patternCheck.penalty * 0.5);
      for (const m of patternCheck.matches) {
        signals.push(`⚠️ PATTERN: ${m.details}`);
      }
      if (patternCheck.isClone) {
        signals.push('🚨 TOKEN IS A CLONE/REPEAT — score heavily penalized');
      }
    }

    // Clamp scores
    score = Math.max(0, Math.min(100, score));
    rugScore = Math.max(0, Math.min(100, rugScore));

    let recommendation: TokenAnalysis['recommendation'];
    if (score >= 80 && rugScore < 30) recommendation = 'strong_buy';
    else if (score >= 65 && rugScore < 50) recommendation = 'buy';
    else if (score >= 45) recommendation = 'watch';
    else if (score >= 25) recommendation = 'skip';
    else recommendation = 'avoid';

    const analysis: TokenAnalysis = {
      mint,
      score,
      rugScore,
      signals,
      recommendation,
      reasoning: `Score: ${score}/100, Rug risk: ${rugScore}/100. ${signals.join('. ')}.`,
      analyzedAt: Date.now(),
    };

    this.ctx.memory.storeAnalysis(analysis);

    // Record pattern fingerprint for the uniqualizer (self-learning)
    try {
      this.ctx.memory.storeTokenPattern({
        mint,
        dev: tokenInfo.dev || undefined,
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        descriptionWords: this.extractDescriptionWords(tokenInfo.description || ''),
        twitterHandle: this.extractHandle(tokenInfo.twitter || '') || undefined,
        telegramHandle: this.extractHandle(tokenInfo.telegram || '') || undefined,
        websiteDomain: this.extractDomain(tokenInfo.website || '') || undefined,
        namePattern: this.extractNamePattern(tokenInfo.name) || undefined,
        score,
        rugScore,
      });
    } catch { /* non-critical */ }

    // Enrich with creator info + top holders + GMGN market data in parallel
    let creatorInfo: any = undefined;
    let topHoldersInfo: any = undefined;
    let gmgnMarketData: any = undefined;
    const enrichPromises: Promise<void>[] = [];

    if (tokenInfo.dev) {
      enrichPromises.push((async () => {
        try {
          const creatorRes = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/user-created-coins/${tokenInfo.dev}?offset=0&limit=50&includeNsfw=true`, {
            headers: { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
          });
          if (creatorRes.ok) {
            const creatorBody = await creatorRes.json() as any;
            const creatorTokens: any[] = creatorBody.coins ?? creatorBody;
            creatorInfo = {
              creatorWallet: tokenInfo.dev,
              totalCoinsCreated: creatorTokens.length,
              coins: creatorTokens.map((t: any) => ({
                mint: t.mint,
                name: t.name,
                symbol: t.symbol,
                marketCapUsd: t.usd_market_cap || 0,
                graduated: t.complete || !!t.pool_address,
                createdAt: t.created_timestamp ? new Date(t.created_timestamp).toISOString() : null,
              })),
              graduated: creatorTokens.filter((t: any) => t.complete || t.pool_address).length,
              graduationRate: creatorTokens.length > 0
                ? `${((creatorTokens.filter((t: any) => t.complete || t.pool_address).length / creatorTokens.length) * 100).toFixed(0)}%`
                : '0%',
            };
          }
        } catch { /* non-critical */ }
      })());
    }

    // Top holders from advanced-api
    enrichPromises.push((async () => {
      try {
        const holdersRes = await fetch(`https://advanced-api-v2.pump.fun/coins/top-holders-and-sol-balance/${mint}`, {
          headers: { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
        });
        if (holdersRes.ok) {
          const holdersData = await holdersRes.json() as any;
          topHoldersInfo = {
            totalHolders: (holdersData.totalHolders || []).length,
            topHolders: (holdersData.topHolders || []).map((h: any) => ({
              address: h.address,
              tokenAmount: h.amount,
              solBalance: h.solBalance,
            })),
          };
        }
      } catch { /* non-critical */ }
    })());

    // GMGN market data (volume, price changes)
    enrichPromises.push((async () => {
      try {
        const gmgn = await this.fetchGmgnSecurity(mint);
        if (gmgn && !gmgn.error) {
          gmgnMarketData = {
            volume24h: gmgn.volume24h ?? null,
            priceChange5m: gmgn.priceChange5m ?? null,
            priceChange1h: gmgn.priceChange1h ?? null,
            priceChange24h: gmgn.priceChange24h ?? null,
            holderCount: gmgn.holderCount ?? null,
            sniperCount: gmgn.sniperCount ?? null,
            insiderRate: gmgn.insiderRate ?? null,
            bundleRate: gmgn.bundleRate ?? null,
            freshWalletCount: gmgn.freshWalletCount ?? null,
          };
        }
      } catch { /* non-critical */ }
    })());

    await Promise.allSettled(enrichPromises);

    if (score >= 70) {
      this.eventBus.emit('signal:buy', {
        mint,
        score,
        reason: analysis.reasoning,
        agentId: 'token-analyzer',
      });
    }

    if (rugScore >= 80) {
      this.eventBus.emit('signal:rug', {
        mint,
        indicators: signals,
        confidence: rugScore,
      });
    }

    return {
      ...analysis,
      // Token metadata
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      description: tokenInfo.description,
      image: tokenInfo.image,
      dev: tokenInfo.dev,
      marketCap: tokenInfo.marketCap,
      bondingCurveProgress: tokenInfo.bondingCurveProgress,
      price: (tokenInfo as any).price || 0,
      // On-chain curve data
      curveData: (tokenInfo as any)._extra ? {
        realSolReserves: (tokenInfo as any)._extra.realSolReserves,
        virtualSolReserves: (tokenInfo as any)._extra.virtualSolReserves,
        complete: (tokenInfo as any)._extra.complete,
        poolAddress: (tokenInfo as any)._extra.poolAddress,
        replyCount: (tokenInfo as any)._extra.replyCount,
        athMarketCap: (tokenInfo as any)._extra.athMarketCap || null,
      } : undefined,
      // Social links
      twitter: tokenInfo.twitter || null,
      telegram: tokenInfo.telegram || null,
      website: tokenInfo.website || null,
      // Enrichments
      creatorInfo,
      topHoldersInfo,
      // GMGN market data
      gmgnMarketData,
      // Holder on-chain data
      holderAnalysis: holders && !('error' in holders) ? holders : undefined,
    } as any;
  }

  private async checkHolders(mint: string): Promise<HolderData | { error: string }> {
    try {
      // Try Helius enriched data first
      if (this.heliusKey) {
        return await this.getHoldersViaHelius(mint);
      }

      // Fallback: basic RPC call
      return await this.getHoldersViaRpc(mint);
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async getHoldersViaHelius(mint: string): Promise<HolderData> {
    const rpcUrl = `${HELIUS_RPC}/?api-key=${this.heliusKey}`;
    return this.getHoldersResolved(rpcUrl, mint);
  }

  private async getHoldersViaRpc(mint: string): Promise<HolderData> {
    return this.getHoldersResolved(this.solanaRpc, mint);
  }

  /**
   * Proper holder analysis:
   * 1. getTokenLargestAccounts → returns ATA addresses (NOT wallets!)
   * 2. getMultipleAccounts(jsonParsed) → resolve ATAs to owner wallets
   * 3. Classify each: bonding_curve / liquidity_pool / burn / real_holder
   * 4. Calculate metrics on CIRCULATING supply only
   */
  private async getHoldersResolved(rpcUrl: string, mint: string): Promise<HolderData> {
    // Step 1: Get top token accounts (ATAs)
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint],
      }),
    });

    const data = await res.json() as any;
    const accounts = data.result?.value || [];
    if (accounts.length === 0) {
      return { mint, totalHolders: 0, top10Percent: 100, top20Percent: 100, devHoldingPercent: 0, isBundled: false, suspiciousWallets: [], checkedAt: Date.now() };
    }

    const totalSupply = accounts.reduce((s: number, a: any) => s + Number(a.amount || 0), 0);

    // Step 2: Resolve ATAs → owner wallets
    const ataAddresses = accounts.map((a: any) => a.address);
    let ownerMap = new Map<string, string>(); // ATA → owner wallet
    let programMap = new Map<string, string>(); // ATA → owner program

    try {
      const resolveRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2,
          method: 'getMultipleAccounts',
          params: [ataAddresses, { encoding: 'jsonParsed' }],
        }),
      });

      const resolveData = await resolveRes.json() as any;
      const values = resolveData.result?.value || [];

      for (let i = 0; i < ataAddresses.length; i++) {
        const val = values[i];
        if (val) {
          programMap.set(ataAddresses[i], val.owner || '');
          const parsed = val.data?.parsed;
          if (parsed?.type === 'account' && parsed.info?.owner) {
            ownerMap.set(ataAddresses[i], parsed.info.owner);
          }
        }
      }
    } catch {
      // If resolution fails, fall back to basic analysis
    }

    // Step 3: First pass — direct match against known programs/authorities
    const token = this.ctx.memory.getToken(mint);
    const devAddress = token?.dev || '';

    const lpPools: { name: string; amount: number }[] = [];
    let burnedAmount = 0;
    const pendingClassify: { ata: string; owner: string; amount: number }[] = [];

    for (const acct of accounts) {
      const ata = acct.address;
      const amount = Number(acct.amount || 0);
      const owner = ownerMap.get(ata) || ata;

      // Direct match: owner is a known pool program or authority
      if (POOL_PROGRAMS.has(owner)) {
        const poolName = DEX_PROGRAM_IDS.get(owner) || 'LP Pool';
        lpPools.push({ name: poolName, amount });
        continue;
      }
      if (BURN_ADDRESSES.has(owner)) {
        burnedAmount += amount;
        continue;
      }
      pendingClassify.push({ ata, owner, amount });
    }

    // Step 3b: Second lookup — resolve owner wallets to find which PROGRAM owns them.
    // This catches LP PDAs: the owner wallet is a PDA, and that PDA's owner is a DEX program.
    const ownerProgramMap = new Map<string, string>(); // owner wallet → program that owns it
    const uniqueOwners = [...new Set(pendingClassify.map(h => h.owner))];

    if (uniqueOwners.length > 0) {
      try {
        // Batch in chunks of 100
        for (let i = 0; i < uniqueOwners.length; i += 100) {
          const batch = uniqueOwners.slice(i, i + 100);
          const ownerRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 3,
              method: 'getMultipleAccounts',
              params: [batch, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
            }),
          });
          const ownerData = await ownerRes.json() as any;
          const ownerValues = ownerData.result?.value || [];
          for (let j = 0; j < batch.length; j++) {
            const val = ownerValues[j];
            if (val && val.owner) {
              ownerProgramMap.set(batch[j], val.owner);
            }
          }
        }
      } catch {
        // If second lookup fails, continue with what we have
      }
    }

    // Step 3c: Classify remaining holders using the owner-program map
    const realHolders: { ata: string; owner: string; amount: number }[] = [];

    for (const item of pendingClassify) {
      const ownerProgram = ownerProgramMap.get(item.owner) || '';

      // If the owner wallet is owned by a known DEX program → it's an LP PDA
      if (DEX_PROGRAM_IDS.has(ownerProgram)) {
        const poolName = DEX_PROGRAM_IDS.get(ownerProgram)!;
        lpPools.push({ name: poolName, amount: item.amount });
        continue;
      }

      // If the owner wallet is owned by a known pool authority
      if (KNOWN_POOL_AUTHORITIES.has(item.owner) || KNOWN_POOL_AUTHORITIES.has(ownerProgram)) {
        lpPools.push({ name: 'LP Pool', amount: item.amount });
        continue;
      }

      // If ownerProgram is NOT system program or token program, it's likely a protocol PDA
      // System program = 11111111111111111111111111111111 (regular wallets)
      const isRegularWallet = ownerProgram === '11111111111111111111111111111111' || ownerProgram === '';
      if (!isRegularWallet && !TOKEN_PROGRAMS.has(ownerProgram) && item.amount > 0) {
        // Unknown program owns this wallet — likely a pool or protocol
        lpPools.push({ name: `Unknown LP (${ownerProgram.slice(0, 8)}…)`, amount: item.amount });
        continue;
      }

      realHolders.push(item);
    }

    // Step 4: Calculate metrics on CIRCULATING supply
    const poolAmount = lpPools.reduce((s, p) => s + p.amount, 0);
    const circulatingSupply = totalSupply - poolAmount - burnedAmount;
    const sorted = realHolders.sort((a, b) => b.amount - a.amount);

    const top10Amount = sorted.slice(0, 10).reduce((s, a) => s + a.amount, 0);
    const top20Amount = sorted.slice(0, 20).reduce((s, a) => s + a.amount, 0);

    // Dev holding
    const devHolding = sorted.filter(h => h.owner === devAddress).reduce((s, h) => s + h.amount, 0);

    // Aggregate LP pools by name
    const lpByName = new Map<string, number>();
    for (const lp of lpPools) {
      lpByName.set(lp.name, (lpByName.get(lp.name) || 0) + lp.amount);
    }
    const lpPoolsSummary = [...lpByName.entries()].map(([name, amt]) => ({
      name,
      percent: totalSupply > 0 ? (amt / totalSupply) * 100 : 0,
    }));

    // Top holders with labels
    const topHoldersList = sorted.slice(0, 10).map(h => {
      const pct = circulatingSupply > 0 ? (h.amount / circulatingSupply) * 100 : 0;
      let label: string | undefined;
      if (h.owner === devAddress) label = 'Dev';
      return { address: h.owner, percent: +pct.toFixed(2), label };
    });

    const holderData: HolderData = {
      mint,
      totalHolders: sorted.length,
      top10Percent: circulatingSupply > 0 ? (top10Amount / circulatingSupply) * 100 : 0,
      top20Percent: circulatingSupply > 0 ? (top20Amount / circulatingSupply) * 100 : 0,
      devHoldingPercent: circulatingSupply > 0 ? (devHolding / circulatingSupply) * 100 : 0,
      isBundled: this.detectBundling(sorted.map(h => ({ amount: String(h.amount) }))),
      suspiciousWallets: [],
      checkedAt: Date.now(),
      lpPercent: totalSupply > 0 ? (poolAmount / totalSupply) * 100 : 0,
      burnedPercent: totalSupply > 0 ? (burnedAmount / totalSupply) * 100 : 0,
      lpPools: lpPoolsSummary,
      topHolders: topHoldersList,
    };

    this.ctx.memory.storeHolderData(holderData);
    return holderData;
  }

  private async checkDevWallet(address: string, skipResolve: boolean = false): Promise<{
    address: string;
    resolvedFrom?: string;
    balanceSol: number;
    accountAge: number;
    txCount: number;
    isKnownRug: boolean;
  }> {
    // Auto-resolve: if this looks like a token mint, fetch the creator wallet from pump.fun
    // Skip when called from analyzeToken/rateProject where dev address is already known
    let resolvedFrom: string | undefined;
    if (!skipResolve) {
      try {
        const tokenInfo = await this.fetchTokenMetadata(address);
        if (tokenInfo && tokenInfo.dev && tokenInfo.dev !== address) {
          resolvedFrom = address;
          address = tokenInfo.dev;
        }
      } catch { /* not a token mint — treat as wallet */ }
    }

    const rpcUrl = this.heliusKey ? `${HELIUS_RPC}/?api-key=${this.heliusKey}` : this.solanaRpc;

    try {
      // First batch: getBalance + first page of signatures
      const [balRes, sigRes] = await Promise.all([
        fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
        }),
        fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress', params: [address, { limit: 1000 }] }),
        }),
      ]);
      const balData = await balRes.json() as any;
      const sigData = await sigRes.json() as any;
      const balanceSol = (balData.result?.value || 0) / 1e9;
      let sigs: any[] = sigData.result || [];

      // Paginate to get total tx count (up to 5000 max to avoid excessive RPC calls)
      const MAX_TX_PAGES = 4;
      for (let page = 0; page < MAX_TX_PAGES && sigs.length > 0 && sigs.length % 1000 === 0; page++) {
        const lastSig = sigs[sigs.length - 1].signature;
        try {
          const nextRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 3 + page, method: 'getSignaturesForAddress', params: [address, { limit: 1000, before: lastSig }] }),
          });
          const nextData = await nextRes.json() as any;
          const nextSigs = nextData.result || [];
          if (nextSigs.length === 0) break;
          sigs = sigs.concat(nextSigs);
        } catch { break; }
      }

      const txCount = sigs.length;

      // Use the oldest fetched signature for age estimate
      const oldestBlock = sigs.length > 0 ? sigs[sigs.length - 1].blockTime : 0;
      const accountAge = oldestBlock > 0
        ? (Date.now() / 1000 - oldestBlock) / 86400
        : 0;

      return {
        address,
        ...(resolvedFrom ? { resolvedFrom, note: `Auto-resolved dev wallet from token mint ${resolvedFrom}` } : {}),
        balanceSol,
        accountAge: Math.round(accountAge),
        txCount,
        isKnownRug: this.ctx.memory.isKnownRug(address),
      };
    } catch (err: any) {
      this.logger.warn(`[checkDevWallet] RPC error for ${address}: ${err.message}`);
      return { address, ...(resolvedFrom ? { resolvedFrom } : {}), balanceSol: 0, accountAge: 0, txCount: 0, isKnownRug: false };
    }
  }

  private async getRugScore(mint: string): Promise<{ mint: string; rugScore: number; flags: string[] }> {
    const analysis = await this.analyzeToken(mint);
    return {
      mint,
      rugScore: analysis.rugScore,
      flags: analysis.signals.filter(s =>
        s.includes('rug') || s.includes('new') || s.includes('concentration') || s.includes('bundled')
      ),
    };
  }

  private async getTrending(period: '1h' | '4h' | '24h', by: 'volume' | 'mcap' | 'holders', limit: number): Promise<any> {
    return this.ctx.memory.getTopTokens(period, by, limit);
  }

  private detectBundling(sortedAccounts: { amount: string }[]): boolean {
    if (sortedAccounts.length < 5) return false;

    const amounts = sortedAccounts.slice(0, 20).map((a) => Number(a.amount));
    // Look for consecutive wallets with nearly identical amounts (>99% match)
    // This is a stronger signal than just any similar pairs
    let consecutiveSimilar = 0;
    let maxConsecutive = 0;
    let similarPairs = 0;

    for (let i = 0; i < amounts.length - 1; i++) {
      const ratio = Math.min(amounts[i], amounts[i + 1]) / Math.max(amounts[i], amounts[i + 1]);
      if (ratio > 0.99 && amounts[i] > 0) {
        consecutiveSimilar++;
        maxConsecutive = Math.max(maxConsecutive, consecutiveSimilar);
      } else {
        consecutiveSimilar = 0;
      }
    }

    // Also check all pairs with strict ratio (>0.99)
    for (let i = 0; i < amounts.length - 1; i++) {
      for (let j = i + 1; j < amounts.length; j++) {
        const ratio = Math.min(amounts[i], amounts[j]) / Math.max(amounts[i], amounts[j]);
        if (ratio > 0.99 && amounts[i] > 0) {
          similarPairs++;
        }
      }
    }

    // Need 4+ consecutive similar OR 6+ similar pairs to flag as bundled
    return maxConsecutive >= 4 || similarPairs >= 6;
  }

  // =====================================================
  // Fetch project links — website & twitter content
  // =====================================================

  private async fetchProjectLinks(mint?: string, websiteUrl?: string, twitterUrl?: string, telegramUrl?: string, cachedTokenInfo?: any): Promise<any> {
    const result: any = { mint: mint || null, website: null, twitter: null, telegram: null };

    // ALWAYS resolve URLs from token metadata first — metadata is the source of truth
    if (mint) {
      const tokenInfo = cachedTokenInfo || await this.fetchTokenMetadata(mint) || this.ctx.memory.getToken(mint);
      if (tokenInfo) {
        result.tokenName = tokenInfo.name;
        result.tokenSymbol = tokenInfo.symbol;
        result.metadataLinks = {
          website: tokenInfo.website || null,
          twitter: tokenInfo.twitter || null,
          telegram: tokenInfo.telegram || null,
        };

        // Track user-provided links that differ from metadata for the report
        const userProvided: any = {};
        if (websiteUrl && websiteUrl !== tokenInfo.website) userProvided.website = websiteUrl;
        if (twitterUrl && twitterUrl !== tokenInfo.twitter) userProvided.twitter = twitterUrl;
        if (telegramUrl && telegramUrl !== tokenInfo.telegram) userProvided.telegram = telegramUrl;
        if (Object.keys(userProvided).length > 0) {
          result.userProvidedLinks = userProvided;
          result.warning = 'User-provided links differ from on-chain token metadata. Only metadata links are official.';
        }

        // STRICT: only use metadata links when mint is provided
        websiteUrl = tokenInfo.website || undefined;
        twitterUrl = tokenInfo.twitter || undefined;
        telegramUrl = tokenInfo.telegram || undefined;
      }
    }

    const promises: Promise<void>[] = [];

    // Fetch website content
    if (websiteUrl) {
      promises.push((async () => {
        try {
          // Validate URL — must be http/https
          const parsed = new URL(websiteUrl!);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            result.website = { url: websiteUrl, error: 'Invalid protocol' };
            return;
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(websiteUrl!, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timeout);
          if (!res.ok) {
            result.website = { url: websiteUrl, status: res.status, error: `HTTP ${res.status}` };
            return;
          }
          const html = await res.text();
          // Extract meaningful content from HTML
          const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
          const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
          const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
          const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
          const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';

          // Extract visible text (strip tags, scripts, styles)
          const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          let bodyText = bodyMatch ? bodyMatch[1] : html;
          bodyText = bodyText
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
            .replace(/<svg[\s\S]*?<\/svg>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#\d+;/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10000);

          // Extract all links from the page
          const linkMatches = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi)];
          const externalLinks = linkMatches
            .map(m => ({ url: m[1], text: m[2]?.trim() }))
            .filter(l => l.url.startsWith('http') && !l.url.includes(parsed.hostname))
            .slice(0, 30);

          // Extract headings for structure understanding
          const headings = [...html.matchAll(/<h[1-4][^>]*>([^<]*(?:<[^>]+>[^<]*)*)<\/h[1-4]>/gi)]
            .map(m => m[1].replace(/<[^>]+>/g, '').trim())
            .filter(h => h.length > 2)
            .slice(0, 25);

          // Check for important indicators
          const htmlLower = html.toLowerCase();
          const hasRoadmap = /roadmap|phases?\s|milestone/i.test(html);
          const hasTeam = /team|founders?|about\s+us|who\s+we\s+are/i.test(html);
          const hasTokenomics = /tokenomics|supply|distribution|allocation/i.test(html);
          const hasDocs = /whitepaper|docs|documentation|litepaper/i.test(html);
          const hasAudit = /audit|certik|hacken|slowmist|peckshield/i.test(html);
          const hasSocialLinks = /twitter\.com|x\.com|t\.me|discord\.gg|telegram/i.test(html);
          const hasBuyButton = /buy now|buy token|swap|trade now|get started/i.test(html);
          const hasContract = /contract|address|0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/i.test(html);

          // Detect tech stack / framework hints
          const isReact = /react|__next|_next/i.test(html);
          const isWordpress = /wp-content|wordpress/i.test(html);

          // Detect if it's just a placeholder/parked domain
          const isPlaceholder = bodyText.length < 100 || /coming\s+soon|under\s+construction|parked|domain\s+for\s+sale/i.test(bodyText);

          result.website = {
            url: websiteUrl,
            status: res.status,
            title: title || ogTitle,
            description: metaDesc || ogDesc,
            ogImage,
            contentPreview: bodyText.slice(0, 3000),
            fullContent: bodyText,
            contentLength: bodyText.length,
            headings,
            externalLinks,
            indicators: {
              hasRoadmap,
              hasTeam,
              hasTokenomics,
              hasDocs,
              hasAudit,
              hasSocialLinks,
              hasBuyButton,
              hasContract,
              isPlaceholder,
              isReact,
              isWordpress,
            },
          };
        } catch (err: any) {
          result.website = { url: websiteUrl, error: err.message };
        }
      })());
    }

    // Fetch Twitter/X profile
    if (twitterUrl) {
      promises.push((async () => {
        try {
          // Normalize Twitter URL to get username
          let username = twitterUrl!;
          // Handle various formats: https://x.com/user, https://twitter.com/user, @user
          username = username.replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\/?/i, '').replace(/^@/, '');
          // Handle paths like /i/communities/XXX or /user/status/123
          if (username.startsWith('i/') || username.includes('/status/')) {
            const isTweet = username.includes('/status/');
            const tweetId = isTweet ? username.match(/status\/(\d+)/)?.[1] : null;
            const tweetAuthor = isTweet ? username.split('/status/')[0].split('/').pop() : null;

            result.twitter = {
              url: twitterUrl,
              type: username.startsWith('i/communities') ? 'community' : 'tweet',
              note: isTweet ? 'This is a link to a specific tweet/post' : 'This is a community link',
              communityOrTweetId: username.split('/').pop(),
            };

            // Try authenticated deep fetch for tweet links
            const twCookies = process.env.TWITTER_COOKIES || '';
            if (isTweet && tweetId && twCookies) {
              // Fetch tweet + author profile in PARALLEL for speed
              const [tweetData, authorProfile] = await Promise.all([
                this.fetchTweetAuthenticated(tweetId, twCookies),
                tweetAuthor ? this.fetchTwitterAuthenticated(tweetAuthor, twCookies) : Promise.resolve(null),
              ]);
              if (tweetData && !tweetData.error) {
                result.twitter = { url: twitterUrl, type: 'tweet', ...tweetData };
                if (authorProfile && !authorProfile.error) {
                    result.twitter.authorProfile = {
                      username: authorProfile.username,
                      displayName: authorProfile.displayName,
                      bio: authorProfile.bio,
                      followers: authorProfile.followers,
                      following: authorProfile.following,
                      verified: authorProfile.verified,
                      accountAgeDays: authorProfile.accountAgeDays,
                      createdAt: authorProfile.createdAt,
                    };
                }
                return;
              }
            }

            // Fallback: OG scraping for tweet/community links
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 8000);
              const res = await fetch(twitterUrl!, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
                signal: controller.signal,
                redirect: 'follow',
              });
              clearTimeout(timeout);
              if (res.ok) {
                const html = await res.text();
                const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] || '';
                const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '';
                if (ogTitle) result.twitter.title = ogTitle;
                if (ogDesc) result.twitter.description = ogDesc;
              }
            } catch {}
            return;
          }

          username = username.split('/')[0].split('?')[0]; // Clean trailing paths/params
          if (!username || username.length > 50) {
            result.twitter = { url: twitterUrl, error: 'Could not parse username' };
            return;
          }

          // Try authenticated Twitter API if cookies are configured
          const twCookies = process.env.TWITTER_COOKIES || '';
          if (twCookies) {
            const authResult = await this.fetchTwitterAuthenticated(username, twCookies);
            if (authResult && !authResult.error) {
              result.twitter = { url: twitterUrl, ...authResult };
              return;
            }
            // Fall through if auth fails
          }

          // Without cookies, we can't get real Twitter data (X blocks all public scraping)
          // Just record the link exists — scoring will handle this via tokenInfo.twitter check
          result.twitter = {
            url: twitterUrl,
            username,
            displayName: username,
            note: 'Twitter data requires cookies. Configure TWITTER_COOKIES env variable for full profile analysis.',
            profileExists: true, // We know the link was set by the dev
          };
        } catch (err: any) {
          result.twitter = { url: twitterUrl, error: err.message };
        }
      })());
    }

    // Fetch Telegram group/channel info
    if (telegramUrl) {
      promises.push((async () => {
        try {
          let tgHandle = telegramUrl!;
          // Normalize: https://t.me/group → group
          tgHandle = tgHandle.replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\/?/i, '');
          tgHandle = tgHandle.split('/')[0].split('?')[0].replace(/^@/, '');
          if (!tgHandle || tgHandle.length > 100) {
            result.telegram = { url: telegramUrl, error: 'Could not parse Telegram handle' };
            return;
          }

          // Fetch the t.me page preview (works without auth)
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(`https://t.me/${tgHandle}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timeout);

          if (!res.ok) {
            result.telegram = { url: telegramUrl, handle: tgHandle, error: `HTTP ${res.status}` };
            return;
          }

          const html = await res.text();
          const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
          const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
          const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';

          // Extract subscriber/member count from page
          const membersMatch = html.match(/<div[^>]*class="[^"]*tgme_page_extra[^"]*"[^>]*>([^<]*)<\/div>/i)?.[1]?.trim() || '';
          const subCount = membersMatch.match(/([\d\s,.]+)\s*(members?|subscribers?|подписчик)/i)?.[1]?.replace(/\s/g, '') || null;

          // Check if it's a channel, group, or bot
          const isChannel = /channel/i.test(html);
          const isGroup = /group|chat/i.test(membersMatch);
          const isBot = /bot$/i.test(tgHandle);

          result.telegram = {
            url: telegramUrl,
            handle: tgHandle,
            title: ogTitle,
            description: ogDesc,
            image: ogImage,
            membersText: membersMatch || null,
            subscriberCount: subCount ? parseInt(subCount.replace(/[,.\s]/g, ''), 10) : null,
            type: isBot ? 'bot' : isChannel ? 'channel' : isGroup ? 'group' : 'unknown',
          };
        } catch (err: any) {
          result.telegram = { url: telegramUrl, error: err.message };
        }
      })());
    }

    await Promise.allSettled(promises);

    if (!websiteUrl && !twitterUrl && !telegramUrl) {
      result.note = 'No website, twitter, or telegram links found for this token';
    }

    return result;
  }

  // Authenticated Twitter profile fetch using cookies (auth_token + ct0)
  private async fetchTwitterAuthenticated(username: string, cookies: string): Promise<any> {
    try {
      // Extract ct0 from cookies for CSRF header
      const ct0Match = cookies.match(/ct0=([^;]+)/);
      const ct0 = ct0Match?.[1] || '';
      if (!ct0) return { error: 'ct0 cookie not found' };

      // Twitter's internal GraphQL API for UserByScreenName
      const variables = JSON.stringify({ screen_name: username, withSafetyModeUserFields: true });
      const features = JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        subscriptions_verification_info_is_identity_verified_enabled: true,
        subscriptions_verification_info_verified_since_enabled: true,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      });

      const params = new URLSearchParams({ variables, features });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(
        `https://x.com/i/api/graphql/xc8f1g7BYqr6VTzTbvNlGw/UserByScreenName?${params}`,
        {
          headers: {
            'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
            'Cookie': cookies,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (!res.ok) {
        return { error: `Twitter API HTTP ${res.status}` };
      }

      const data = await res.json() as any;
      const user = data?.data?.user?.result;
      if (!user || user.__typename === 'UserUnavailable') {
        return { error: 'User not found or suspended' };
      }

      const legacy = user.legacy || {};
      const createdAt = legacy.created_at ? new Date(legacy.created_at) : null;
      const accountAgeDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : null;

      // Fetch recent tweets
      let recentTweets: any[] = [];
      try {
        const tweetsVars = JSON.stringify({
          userId: user.rest_id,
          count: 10,
          includePromotedContent: false,
          withQuickPromoteEligibilityTweetFields: false,
          withVoice: false,
          withV2Timeline: true,
        });
        const tweetsFeatures = JSON.stringify({
          rweb_tipjar_consumption_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_timeline_navigation_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          communities_web_enable_tweet_community_results_fetch: true,
          c9s_tweet_anatomy_moderator_badge_enabled: true,
          articles_preview_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
          view_counts_everywhere_api_enabled: true,
          longform_notetweets_consumption_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: true,
          tweet_awards_web_tipping_enabled: false,
          creator_subscriptions_quote_tweet_preview_enabled: false,
          freedom_of_speech_not_reach_fetch_enabled: true,
          standardized_nudges_misinfo: true,
          tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
          rweb_video_timestamps_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          responsive_web_enhance_cards_enabled: false,
        });
        const tweetsParams = new URLSearchParams({ variables: tweetsVars, features: tweetsFeatures });
        const tweetsController = new AbortController();
        const tweetsTimeout = setTimeout(() => tweetsController.abort(), 8000);
        const tweetsRes = await fetch(
          `https://x.com/i/api/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets?${tweetsParams}`,
          {
            headers: {
              'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
              'Cookie': cookies,
              'X-Csrf-Token': ct0,
              'X-Twitter-Auth-Type': 'OAuth2Session',
              'X-Twitter-Active-User': 'yes',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            signal: tweetsController.signal,
          }
        );
        clearTimeout(tweetsTimeout);
        if (tweetsRes.ok) {
          const tweetsData = await tweetsRes.json() as any;
          const entries = tweetsData?.data?.user?.result?.timeline_v2?.timeline?.instructions
            ?.find((i: any) => i.type === 'TimelineAddEntries')?.entries || [];
          for (const entry of entries) {
            const tweet = entry?.content?.itemContent?.tweet_results?.result;
            if (!tweet?.legacy) continue;
            const tl = tweet.legacy;
            const tweetEntry: any = {
              tweetId: tweet.rest_id || tl.id_str || null,
              text: tl.full_text?.slice(0, 1500),
              date: tl.created_at,
              likes: tl.favorite_count || 0,
              retweets: tl.retweet_count || 0,
              replies: tl.reply_count || 0,
              views: tweet.views?.count || null,
              bookmarks: tl.bookmark_count || 0,
            };
            // Extract links from tweet entities
            const tweetUrls = tl.entities?.urls || [];
            if (tweetUrls.length > 0) {
              tweetEntry.links = tweetUrls.map((u: any) => ({ displayUrl: u.display_url, expandedUrl: u.expanded_url }));
            }
            // Include quoted tweet content if present
            const quoted = tweet.quoted_status_result?.result?.legacy;
            if (quoted?.full_text) {
              tweetEntry.quotedTweet = {
                text: quoted.full_text.slice(0, 800),
                author: quoted.user_id_str || null,
                likes: quoted.favorite_count || 0,
              };
            }
            // Include media types
            const media = tl.entities?.media || tl.extended_entities?.media || [];
            if (media.length > 0) {
              tweetEntry.media = media.map((m: any) => m.type).filter(Boolean);
            }
            recentTweets.push(tweetEntry);
            if (recentTweets.length >= 10) break;
          }
        }
      } catch { /* non-critical */ }

      return {
        username,
        displayName: legacy.name || username,
        bio: legacy.description || '',
        profileImage: (legacy.profile_image_url_https || '').replace('_normal', '_400x400'),
        bannerImage: legacy.profile_banner_url || null,
        followers: legacy.followers_count || 0,
        following: legacy.friends_count || 0,
        tweets: legacy.statuses_count || 0,
        likes: legacy.favourites_count || 0,
        listed: legacy.listed_count || 0,
        verified: user.is_blue_verified || legacy.verified || false,
        createdAt: legacy.created_at || null,
        accountAgeDays,
        location: legacy.location || null,
        pinnedTweet: legacy.pinned_tweet_ids_str?.[0] || null,
        recentTweets,
        source: 'authenticated',
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Public handler for fetch_tweet tool — browser-first, API fallback.
   */
  private async handleFetchTweet(urlOrId: string): Promise<any> {
    // Extract tweet ID
    let tweetUrl = urlOrId.trim();
    let tweetId = tweetUrl;
    const statusMatch = tweetUrl.match(/\/status\/(\d+)/);
    if (statusMatch) {
      tweetId = statusMatch[1];
    } else if (/^\d+$/.test(tweetUrl)) {
      tweetUrl = `https://x.com/i/status/${tweetUrl}`;
    } else {
      return { error: `Could not extract tweet ID from: ${urlOrId}` };
    }
    if (!tweetUrl.startsWith('http')) {
      tweetUrl = `https://x.com/i/status/${tweetId}`;
    }

    // 1) Primary: API fetch (vxtwitter first, then GraphQL with cookies)
    const cookies = process.env.TWITTER_COOKIES || '';
    const authorMatch = urlOrId.match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\//i);
    const authorUsername = authorMatch?.[1] || '_';
    // Store author hint for vxtwitter URL construction
    (this as any)._lastTweetAuthor = authorUsername;

    {
      const [tweetData, authorProfile] = await Promise.all([
        this.fetchTweetAuthenticated(tweetId, cookies),
        (authorUsername && authorUsername !== '_' && cookies) ? this.fetchTwitterAuthenticated(authorUsername, cookies).catch(() => null) : Promise.resolve(null),
      ]);

      if (tweetData && !tweetData.error) {
        if (authorProfile && !authorProfile.error) {
          tweetData.authorProfile = {
            username: authorProfile.username,
            displayName: authorProfile.displayName,
            bio: authorProfile.bio,
            followers: authorProfile.followers,
            following: authorProfile.following,
            verified: authorProfile.verified,
            accountAgeDays: authorProfile.accountAgeDays,
            createdAt: authorProfile.createdAt,
          };
        }
        // Follow links found in tweet text
        await this.followTweetLinks(tweetData);
        return tweetData;
      }
      this.logger.info(`[fetch_tweet] API FAILED: ${JSON.stringify(tweetData?.error || tweetData)}, trying browser...`);
    }

    // 2) Fallback: browser-based fetch
    this.logger.info(`[fetch_tweet] Browser fallback available: ${!!this.ctx.browser}`);
    if (this.ctx.browser) {
      try {
        const browserResult = await this.ctx.browser.fetchTweet(tweetUrl);
        this.logger.info(`[fetch_tweet] Browser result: error=${browserResult?.error}, hasText=${!!browserResult?.fullText}`);
        if (browserResult && !browserResult.error && browserResult.fullText) {
          await this.followTweetLinks(browserResult);
          return browserResult;
        }
      } catch (err: any) {
        this.logger.info(`[fetch_tweet] Browser EXCEPTION: ${err.message}`);
      }
    }

    return { error: 'All methods to fetch tweet failed (syndication + GraphQL + browser). Check Twitter cookies in Settings.' };
  }

  /**
   * Search Twitter/X for token mentions by ticker, name, or contract address.
   * Uses GraphQL SearchTimeline with cookies, falls back to vxtwitter scraping.
   */
  private async searchTwitterForToken(query: string, limit: number = 20): Promise<any> {
    limit = Math.min(limit, 50);
    const cookies = process.env.TWITTER_COOKIES || '';

    // Try authenticated GraphQL search first
    if (cookies) {
      try {
        const ct0Match = cookies.match(/ct0=([^;]+)/);
        const ct0 = ct0Match?.[1] || '';
        if (ct0) {
          const variables = JSON.stringify({
            rawQuery: query,
            count: limit,
            querySource: 'typed_query',
            product: 'Latest',
          });
          const features = JSON.stringify({
            creator_subscriptions_tweet_preview_api_enabled: true,
            communities_web_enable_tweet_community_results_fetch: true,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            articles_preview_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            creator_subscriptions_quote_tweet_preview_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            rweb_video_timestamps_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_enhance_cards_enabled: false,
          });
          const params = new URLSearchParams({ variables, features });

          const searchQueryIds = ['MjnRHMPnLNDKnQr9j0wP4A', 'gkjsKepM6gl_HmFWoWKfgg'];
          for (const qid of searchQueryIds) {
            try {
              const res = await fetch(`https://x.com/i/api/graphql/${qid}/SearchTimeline?${params}`, {
                headers: {
                  'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
                  'Cookie': cookies,
                  'X-Csrf-Token': ct0,
                  'X-Twitter-Auth-Type': 'OAuth2Session',
                  'X-Twitter-Active-User': 'yes',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                signal: AbortSignal.timeout(15000),
              });

              if (!res.ok) continue;
              const data = await res.json() as any;
              const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
              const entries = instructions.find((i: any) => i.type === 'TimelineAddEntries')?.entries || [];

              const tweets: any[] = [];
              for (const entry of entries) {
                const tweet = entry?.content?.itemContent?.tweet_results?.result;
                if (!tweet?.legacy) continue;
                const tl = tweet.legacy;
                const core = tweet.core?.user_results?.result?.legacy || {};
                const noteText = tweet.note_tweet?.note_tweet_results?.result?.text || '';

                const tweetEntry: any = {
                  tweetId: tweet.rest_id || tl.id_str || null,
                  text: (noteText || tl.full_text || '').slice(0, 1500),
                  author: {
                    username: core.screen_name || '',
                    displayName: core.name || '',
                    followers: core.followers_count || 0,
                    verified: tweet.core?.user_results?.result?.is_blue_verified || false,
                  },
                  date: tl.created_at || null,
                  engagement: {
                    likes: tl.favorite_count || 0,
                    retweets: tl.retweet_count || 0,
                    replies: tl.reply_count || 0,
                    views: tweet.views?.count || null,
                  },
                };

                // Extract links from entities
                const urls = tl.entities?.urls || [];
                if (urls.length > 0) {
                  tweetEntry.links = urls.map((u: any) => ({ displayUrl: u.display_url, expandedUrl: u.expanded_url }));
                }

                tweets.push(tweetEntry);
                if (tweets.length >= limit) break;
              }

              if (tweets.length > 0) {
                // Compute summary stats
                const totalLikes = tweets.reduce((s, t) => s + (t.engagement?.likes || 0), 0);
                const totalRetweets = tweets.reduce((s, t) => s + (t.engagement?.retweets || 0), 0);
                const uniqueAuthors = new Set(tweets.map(t => t.author?.username)).size;
                const verifiedCount = tweets.filter(t => t.author?.verified).length;
                const avgFollowers = tweets.reduce((s, t) => s + (t.author?.followers || 0), 0) / tweets.length;

                return {
                  query,
                  source: 'twitter_graphql',
                  totalResults: tweets.length,
                  summary: {
                    uniqueAuthors,
                    verifiedAuthors: verifiedCount,
                    avgFollowers: Math.round(avgFollowers),
                    totalLikes,
                    totalRetweets,
                    sentiment: totalLikes > 50 ? 'positive' : totalLikes > 10 ? 'neutral' : 'low_engagement',
                  },
                  tweets,
                };
              }
            } catch { continue; }
          }
        }
      } catch (err: any) {
        this.logger.debug(`[searchTwitterForToken] GraphQL search error: ${err.message}`);
      }
    }

    // Fallback: use Nitter search instances
    const nitterInstances = ['nitter.net', 'nitter.cz', 'xcancel.com'];
    for (const instance of nitterInstances) {
      try {
        const res = await fetch(`https://${instance}/search?q=${encodeURIComponent(query)}&f=tweets`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const html = await res.text();

        // Parse Nitter search results
        const tweetMatches = [...html.matchAll(/<div class="timeline-item[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi)];
        if (tweetMatches.length === 0) continue;

        const tweets: any[] = [];
        for (const m of tweetMatches.slice(0, limit)) {
          const block = m[0];
          const author = block.match(/class="username"[^>]*>@?([^<]+)/i)?.[1]?.trim() || '';
          const text = block.match(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
            ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
          const likes = parseInt(block.match(/icon-heart[^<]*<\/span>\s*(\d+)/i)?.[1] || '0');
          const retweets = parseInt(block.match(/icon-retweet[^<]*<\/span>\s*(\d+)/i)?.[1] || '0');

          if (text) {
            tweets.push({
              text: text.slice(0, 1500),
              author: { username: author },
              engagement: { likes, retweets },
            });
          }
        }

        if (tweets.length > 0) {
          return {
            query,
            source: `nitter_${instance}`,
            totalResults: tweets.length,
            tweets,
          };
        }
      } catch { continue; }
    }

    return {
      query,
      source: 'none',
      totalResults: 0,
      tweets: [],
      error: 'Twitter search requires cookies. Configure them in Settings \u2192 Twitter.',
    };
  }

  /**
   * Follow URLs found in a tweet — fetch page content for GitHub repos, YouTube, websites etc.
   * Mutates tweetData by adding `linkedContent` array.
   */
  private async followTweetLinks(tweetData: any): Promise<void> {
    // Collect URLs from links array (GraphQL) and from tweet text
    const urls = new Set<string>();
    if (tweetData.links?.length) {
      for (const l of tweetData.links) {
        const url = l.expandedUrl || l.url || l.displayUrl;
        if (url && url.startsWith('http')) urls.add(url);
      }
    }
    // Also extract URLs from fullText
    if (tweetData.fullText) {
      const urlRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
      const textUrls = tweetData.fullText.match(urlRegex) || [];
      for (const u of textUrls) {
        // Skip twitter/x.com links (self-referencing)
        if (!/(?:twitter\.com|x\.com|t\.co)\//i.test(u)) urls.add(u);
      }
    }
    if (urls.size === 0) return;

    // Fetch up to 5 links in parallel with timeout
    const linkResults: any[] = [];
    const fetchPromises = [...urls].slice(0, 5).map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        // GitHub API for repos
        const ghMatch = url.match(/github\.com\/([^\/]+\/[^\/\s?#]+)/i);
        if (ghMatch) {
          const repoPath = ghMatch[1].replace(/\.git$/, '');
          try {
            const apiRes = await fetch(`https://api.github.com/repos/${repoPath}`, {
              headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AXIOM/1.0' },
              signal: controller.signal,
            });
            clearTimeout(timeout);
            if (apiRes.ok) {
              const repo = await apiRes.json() as any;
              linkResults.push({
                url,
                type: 'github',
                name: repo.full_name,
                description: repo.description || '',
                stars: repo.stargazers_count || 0,
                forks: repo.forks_count || 0,
                language: repo.language || null,
                openIssues: repo.open_issues_count || 0,
                createdAt: repo.created_at,
                updatedAt: repo.updated_at,
                pushedAt: repo.pushed_at,
                license: repo.license?.spdx_id || null,
                topics: repo.topics || [],
                defaultBranch: repo.default_branch,
              });
              // Also fetch README
              try {
                const readmeRes = await fetch(`https://api.github.com/repos/${repoPath}/readme`, {
                  headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'AXIOM/1.0' },
                  signal: AbortSignal.timeout(8000),
                });
                if (readmeRes.ok) {
                  const readmeData = await readmeRes.json() as any;
                  if (readmeData.content) {
                    const readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
                    linkResults[linkResults.length - 1].readme = readme.slice(0, 5000);
                  }
                }
              } catch { /* non-critical */ }
              return;
            }
          } catch { /* fall through to generic fetch */ }
        }

        // Generic page fetch
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timeout);
        if (!res.ok) {
          linkResults.push({ url, error: `HTTP ${res.status}` });
          return;
        }
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
          linkResults.push({ url, type: 'file', contentType: contentType.split(';')[0] });
          return;
        }
        const html = await res.text();
        const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '';
        const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';
        const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() || '';

        // Extract visible text
        let bodyText = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || html)
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);

        linkResults.push({
          url,
          type: /youtube\.com|youtu\.be/i.test(url) ? 'youtube' : 'webpage',
          title,
          description: metaDesc || ogDesc,
          contentPreview: bodyText,
        });
      } catch (err: any) {
        linkResults.push({ url, error: err.message });
      }
    });

    await Promise.allSettled(fetchPromises);
    if (linkResults.length > 0) {
      tweetData.linkedContent = linkResults;
    }
  }

  /**
   * Public handler for fetch_twitter_profile tool — browser-first, API fallback.
   */
  private async handleFetchTwitterProfile(usernameOrUrl: string): Promise<any> {
    // Normalize username
    let username = usernameOrUrl.trim().replace(/^@/, '');
    username = username.replace(/^https?:\/\/(www\.)?(twitter\.com|x\.com)\/?/i, '');
    username = username.split('/')[0];

    if (!username) {
      return { error: 'Could not extract username from input' };
    }

    const profileUrl = `https://x.com/${username}`;

    // 1) Primary: API fetch with cookies (auto-captured by extension)
    const cookies = process.env.TWITTER_COOKIES || '';
    if (cookies) {
      const result = await this.fetchTwitterAuthenticated(username, cookies);
      if (result && !result.error) return result;
      this.logger.debug(`[fetch_twitter_profile] API failed: ${result?.error}, trying browser...`);
    }

    // 2) Fallback: browser-based fetch
    if (this.ctx.browser) {
      try {
        const browserResult = await this.ctx.browser.fetchTwitterProfile(profileUrl);
        if (browserResult && !browserResult.error && (browserResult.username || browserResult.displayName)) {
          return browserResult;
        }
      } catch (err: any) {
        this.logger.debug(`[fetch_twitter_profile] Browser error: ${err.message}`);
      }
    }

    return { error: 'Twitter cookies not configured. Install the browser extension or add cookies manually in Settings → Twitter.' };
  }

  /**
   * Fetch a specific tweet by ID.
   * Priority: 1) vxtwitter public API (no auth needed) 2) GraphQL with cookies
   */
  private async fetchTweetAuthenticated(tweetId: string, cookies: string): Promise<any> {
    // Extract author from URL if available (stored on class temporarily)
    const authorHint = (this as any)._lastTweetAuthor || '_';

    // 1) vxtwitter API — public, stable, no auth needed
    try {
      const vxRes = await fetch(
        `https://api.vxtwitter.com/${authorHint}/status/${tweetId}`,
        { headers: { 'User-Agent': 'AXIOM/1.0' }, signal: AbortSignal.timeout(10000) }
      );
      if (vxRes.ok) {
        const vx = await vxRes.json() as any;
        if (vx?.text) {
          this.logger.info(`[fetch_tweet] vxtwitter API success for ${tweetId}`);
          const result: any = {
            tweetId,
            type: 'tweet',
            fullText: vx.text || '',
            author: {
              username: vx.user_screen_name || '',
              displayName: vx.user_name || '',
              followers: vx.user_followers || 0,
              verified: false,
            },
            date: vx.date || null,
            engagement: {
              likes: vx.likes || 0,
              retweets: vx.retweets || 0,
              replies: vx.replies || 0,
              quotes: vx.quote_count || 0,
              bookmarks: vx.bookmark_count || 0,
              views: vx.views || null,
            },
            language: vx.lang || null,
            source: 'vxtwitter',
          };
          if (vx.media_extended?.length > 0) {
            result.media = vx.media_extended.map((m: any) => ({
              type: m.type,
              url: m.url,
              ...(m.duration_millis ? { durationMs: m.duration_millis } : {}),
            }));
          }
          if (vx.qrt) {
            result.quotedTweet = {
              fullText: vx.qrt.text || '',
              author: vx.qrt.user_screen_name || '',
              authorDisplayName: vx.qrt.user_name || '',
              likes: vx.qrt.likes || 0,
              retweets: vx.qrt.retweets || 0,
            };
          }
          if (vx.communityNote) {
            result.communityNote = vx.communityNote;
          }
          // Extract links from tweet text for vxtwitter (GraphQL path uses entities.urls)
          if (result.fullText) {
            const urlRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
            const textUrls = (result.fullText.match(urlRegex) || [])
              .filter((u: string) => !/(?:twitter\.com|x\.com|t\.co)\//i.test(u));
            if (textUrls.length > 0) {
              result.links = textUrls.map((u: string) => ({ expandedUrl: u, displayUrl: u.replace(/^https?:\/\//, '') }));
            }
          }
          return result;
        }
      }
      this.logger.info(`[fetch_tweet] vxtwitter: status=${vxRes.status}, trying GraphQL...`);
    } catch (vxErr: any) {
      this.logger.info(`[fetch_tweet] vxtwitter error: ${vxErr.message}, trying GraphQL...`);
    }

    // 2) GraphQL with cookies (fallback — needs valid cookies + queryId)
    try {
      const ct0Match = cookies.match(/ct0=([^;]+)/);
      const ct0 = ct0Match?.[1] || '';
      if (!ct0) return { error: 'vxtwitter failed and ct0 cookie not found for GraphQL fallback' };

      const queryIds = ['B9_KmbkLhXt6jRwGjJrweg', 'xOhkmRac04YFZmOzU9PJHg', 'zJvfJs3gSbrVhFEkKBDevQ'];
      const variables = JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false });
      const features = JSON.stringify({
        creator_subscriptions_tweet_preview_api_enabled: true,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        articles_preview_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        tweet_awards_web_tipping_enabled: false,
        creator_subscriptions_quote_tweet_preview_enabled: false,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        rweb_video_timestamps_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      });
      const fieldToggles = JSON.stringify({ withArticleRichContentState: true, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false });
      const params = new URLSearchParams({ variables, features, fieldToggles });

      for (const qid of queryIds) {
        try {
          const res = await fetch(`https://x.com/i/api/graphql/${qid}/TweetResultByRestId?${params}`, {
            headers: {
              'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
              'Cookie': cookies, 'X-Csrf-Token': ct0,
              'X-Twitter-Auth-Type': 'OAuth2Session', 'X-Twitter-Active-User': 'yes',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            signal: AbortSignal.timeout(10000),
          });
          this.logger.info(`[fetch_tweet] GraphQL qid=${qid}: status=${res.status}`);
          if (!res.ok) continue;

          const data = await res.json() as any;
          const tweet = data?.data?.tweetResult?.result;
          if (!tweet) continue;
          if (tweet.__typename === 'TweetUnavailable' || tweet.__typename === 'TweetTombstone') {
            return { error: 'Tweet unavailable or deleted' };
          }

          const core = tweet.core?.user_results?.result?.legacy || {};
          const legacy = tweet.legacy || {};
          const noteText = tweet.note_tweet?.note_tweet_results?.result?.text || '';
          const result: any = {
            tweetId, type: 'tweet',
            fullText: noteText || legacy.full_text || '',
            author: { username: core.screen_name || '', displayName: core.name || '', followers: core.followers_count || 0, verified: tweet.core?.user_results?.result?.is_blue_verified || false },
            date: legacy.created_at || null,
            engagement: { likes: legacy.favorite_count || 0, retweets: legacy.retweet_count || 0, replies: legacy.reply_count || 0, quotes: legacy.quote_count || 0, bookmarks: legacy.bookmark_count || 0, views: tweet.views?.count || null },
            language: legacy.lang || null, source: 'graphql',
          };
          const media = legacy.extended_entities?.media || legacy.entities?.media || [];
          if (media.length > 0) result.media = media.map((m: any) => ({ type: m.type, url: m.media_url_https || m.url }));
          const urls = legacy.entities?.urls || [];
          if (urls.length > 0) result.links = urls.map((u: any) => ({ displayUrl: u.display_url, expandedUrl: u.expanded_url }));
          return result;
        } catch { continue; }
      }
    } catch (err: any) {
      this.logger.info(`[fetch_tweet] GraphQL fallback error: ${err.message}`);
    }

    return { error: 'All Twitter API methods failed (vxtwitter + GraphQL)' };
  }

  // =====================================================
  // Rate Project — comprehensive shield/rating
  // =====================================================

  private async rateProject(mint: string): Promise<any> {
    // Gather all data in parallel — prefer fresh API data over stale memory cache
    const tokenInfo = await this.fetchTokenMetadata(mint) || this.ctx.memory.getToken(mint);
    if (!tokenInfo) {
      return { error: 'Token not found', mint };
    }

    const [analysis, projectLinks, marketActivity, ath, gmgnSecurity, rugcheckReport, twitterSearchByTicker, twitterSearchByContract] = await Promise.allSettled([
      this.analyzeToken(mint, tokenInfo, true),
      this.fetchProjectLinks(mint, undefined, undefined, undefined, tokenInfo),
      this.fetchMarketActivity(mint),
      this.fetchTokenAth(mint),
      this.fetchGmgnSecurity(mint),
      this.fetchRugCheck(mint),
      // Twitter search by ticker ($SYMBOL + token name)
      this.searchTwitterForToken(`$${tokenInfo.symbol || ''} ${tokenInfo.name || ''}`.trim(), 15),
      // Twitter search by contract address
      this.searchTwitterForToken(mint, 10),
    ]);

    const analysisData = analysis.status === 'fulfilled' ? analysis.value : null;
    const linksData = projectLinks.status === 'fulfilled' ? projectLinks.value : null;
    const marketData = marketActivity.status === 'fulfilled' ? (marketActivity as any).value : null;
    const athData = ath.status === 'fulfilled' ? (ath as any).value : null;
    const gmgnData = gmgnSecurity.status === 'fulfilled' ? gmgnSecurity.value : null;
    const rugcheckData = rugcheckReport.status === 'fulfilled' ? rugcheckReport.value : null;
    const tickerSearchData = twitterSearchByTicker.status === 'fulfilled' ? twitterSearchByTicker.value : null;
    const contractSearchData = twitterSearchByContract.status === 'fulfilled' ? twitterSearchByContract.value : null;

    // ── Category scoring (each 0-100) ──
    const categories: Record<string, { score: number; maxScore: number; details: string[] }> = {
      legitimacy: { score: 0, maxScore: 100, details: [] },
      community: { score: 0, maxScore: 100, details: [] },
      devTrust: { score: 0, maxScore: 100, details: [] },
      tokenomics: { score: 0, maxScore: 100, details: [] },
      momentum: { score: 0, maxScore: 100, details: [] },
      narrative: { score: 0, maxScore: 100, details: [] },
    };

    // ── TOKEN TYPE DETECTION: MEME vs FUNDAMENTAL ──
    const ws = linksData?.website;
    const tw = linksData?.twitter;

    const typeText = [
      tokenInfo.name, tokenInfo.symbol, tokenInfo.description,
      ws && !ws.error ? [ws.title, ws.description, ws.contentPreview].join(' ') : '',
      tw && !tw.error ? tw.bio : '',
    ].filter(Boolean).join(' ').toLowerCase();

    const memeWords = ['meme', 'doge', 'pepe', 'wojak', 'chad', 'based', 'moon', 'frog', 'cat', 'dog',
      'inu', 'shib', 'floki', 'elon', 'baby', 'bonk', 'boden', 'trump', 'biden', 'lol', 'kek', 'cope',
      'wagmi', 'ngmi', 'wen', 'lambo', 'ape', 'monkey', 'degen',
      'yolo', 'stonk', 'rocket', 'diamond', 'hands',
      'wif', 'hat', 'neiro', 'popcat', 'goat', 'pnut', 'hawk', 'tuah',
      'funny', 'joke', 'lmao', 'bruh', 'sir', 'king', 'queen', 'lord',
      'peepo', 'ascii', 'pixel', 'troll', 'mog', 'gigachad', 'sigma'];
    const memeHits = memeWords.filter(w => typeText.includes(w));

    // Fundamental signals from website structure
    const fundIndicators: string[] = [];
    if (ws && !ws.error) {
      if (ws.indicators?.hasRoadmap) fundIndicators.push('roadmap');
      if (ws.indicators?.hasTeam) fundIndicators.push('team');
      if (ws.indicators?.hasDocs) fundIndicators.push('docs');
      if (ws.indicators?.hasAudit) fundIndicators.push('audit');
      if (ws.indicators?.hasTokenomics) fundIndicators.push('tokenomics');
    }
    const fundWords = ['protocol', 'platform', 'ecosystem', 'infrastructure', 'defi', 'yield', 'staking',
      'liquidity', 'swap', 'lending', 'oracle', 'bridge', 'sdk', 'api', 'dao', 'governance',
      'utility', 'launchpad', 'dapp', 'whitepaper'];
    const fundHits = fundWords.filter(w => typeText.includes(w));

    const memeStrength = memeHits.length * 2;
    const fundStrength = fundIndicators.length * 3 + fundHits.length * 2;
    // Default to MEME — most pump.fun tokens are memes unless strong fundamental signals
    const tokenType: 'MEME' | 'FUNDAMENTAL' | 'HYBRID' =
      fundStrength >= 6 && fundStrength > memeStrength ? 'FUNDAMENTAL' :
      fundStrength >= 4 && memeStrength >= 4 ? 'HYBRID' : 'MEME';
    const isMeme = tokenType === 'MEME' || tokenType === 'HYBRID';

    // ── LEGITIMACY (adaptive: meme vs fundamental) ──
    if (isMeme) {
      // Memes: social presence + meme appeal + community traction (NOT roadmap/team/docs/audit)
      if (ws && !ws.error) {
        categories.legitimacy.score += 20;
        categories.legitimacy.details.push('Website exists');
        if (ws.indicators?.isPlaceholder) { categories.legitimacy.score -= 10; categories.legitimacy.details.push('Website is placeholder'); }
      }
      if (tw && !tw.error) {
        categories.legitimacy.score += 20;
        categories.legitimacy.details.push('Twitter/X profile exists');
        if (tw.followers) {
          const followerStr = String(tw.followers).replace(/,/g, '');
          let followerNum = parseFloat(followerStr) || 0;
          if (/k/i.test(followerStr)) followerNum *= 1000;
          if (/m/i.test(followerStr)) followerNum *= 1_000_000;
          if (followerNum > 5000) { categories.legitimacy.score += 20; categories.legitimacy.details.push(`Strong meme following: ${tw.followers}`); }
          else if (followerNum > 500) { categories.legitimacy.score += 15; categories.legitimacy.details.push(`Growing following: ${tw.followers}`); }
          else if (followerNum > 50) { categories.legitimacy.score += 10; categories.legitimacy.details.push(`Some followers: ${tw.followers}`); }
        }
      } else if (tokenInfo.twitter) {
        // Twitter link exists in metadata — give credit for having it set up, even if we can't scrape it
        categories.legitimacy.score += 15;
        categories.legitimacy.details.push('Twitter link set up (profile data unavailable — configure cookies for full analysis)');
      }
      if (tokenInfo.telegram) { categories.legitimacy.score += 15; categories.legitimacy.details.push('Has Telegram community'); }
      if (tokenInfo.description && tokenInfo.description.length > 10) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has description'); }
      if (tokenInfo.image) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has token image/branding'); }
    } else {
      // Fundamental tokens: website quality, team, docs, audit matter
      if (ws && !ws.error) {
        categories.legitimacy.score += 15;
        categories.legitimacy.details.push('Website exists and loads');
        if (ws.indicators?.hasRoadmap) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has roadmap'); }
        if (ws.indicators?.hasTeam) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has team info'); }
        if (ws.indicators?.hasTokenomics) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has tokenomics page'); }
        if (ws.indicators?.hasDocs) { categories.legitimacy.score += 10; categories.legitimacy.details.push('Has documentation/whitepaper'); }
        if (ws.indicators?.hasAudit) { categories.legitimacy.score += 15; categories.legitimacy.details.push('Mentions audit'); }
        if (ws.indicators?.isPlaceholder) { categories.legitimacy.score -= 20; categories.legitimacy.details.push('Website is a placeholder/coming soon'); }
      } else if (tokenInfo.website) {
        categories.legitimacy.score += 5;
        categories.legitimacy.details.push('Website URL exists but failed to load');
      } else {
        categories.legitimacy.details.push('No website');
      }
      if (tw && !tw.error) {
        categories.legitimacy.score += 15;
        categories.legitimacy.details.push('Twitter/X profile exists');
        if (tw.followers) {
          const followerStr = String(tw.followers).replace(/,/g, '');
          let followerNum = parseFloat(followerStr);
          if (/k/i.test(followerStr)) followerNum *= 1000;
          if (/m/i.test(followerStr)) followerNum *= 1_000_000;
          if (followerNum > 10000) { categories.legitimacy.score += 15; categories.legitimacy.details.push(`Strong following: ${tw.followers}`); }
          else if (followerNum > 1000) { categories.legitimacy.score += 10; categories.legitimacy.details.push(`Decent following: ${tw.followers}`); }
          else if (followerNum > 100) { categories.legitimacy.score += 5; categories.legitimacy.details.push(`Small following: ${tw.followers}`); }
          else { categories.legitimacy.details.push(`Very few followers: ${tw.followers}`); }
        }
      } else if (tokenInfo.twitter) {
        categories.legitimacy.score += 10;
        categories.legitimacy.details.push('Twitter link set up (profile data unavailable — configure cookies for full analysis)');
      }
      if (tokenInfo.telegram) { categories.legitimacy.score += 5; categories.legitimacy.details.push('Has Telegram'); }
    }
    categories.legitimacy.score = Math.min(100, Math.max(0, categories.legitimacy.score));

    // ── COMMUNITY: holders, comments, social activity ──
    const analysisAny = analysisData as any;
    const totalHolders = analysisAny?.topHoldersInfo?.totalHolders || 0;
    if (totalHolders > 500) { categories.community.score += 30; categories.community.details.push(`${totalHolders} holders — strong community`); }
    else if (totalHolders > 100) { categories.community.score += 20; categories.community.details.push(`${totalHolders} holders — growing`); }
    else if (totalHolders > 20) { categories.community.score += 10; categories.community.details.push(`${totalHolders} holders — early`); }
    else { categories.community.details.push(`Only ${totalHolders} holders`); }

    if (tokenInfo.description && tokenInfo.description.length > 50) {
      categories.community.score += 10;
      categories.community.details.push('Has detailed description');
    }
    if (tw?.bio && tw.bio.length > 20) {
      categories.community.score += 10;
      categories.community.details.push('Twitter bio present');
    }
    // Activity proxied from market data
    if (marketData && !marketData.error) {
      const m5Txns = (marketData.m5?.buys || 0) + (marketData.m5?.sells || 0);
      if (m5Txns > 20) { categories.community.score += 30; categories.community.details.push(`Very active: ${m5Txns} txns in 5m`); }
      else if (m5Txns > 5) { categories.community.score += 20; categories.community.details.push(`Active: ${m5Txns} txns in 5m`); }
      else if (m5Txns > 0) { categories.community.score += 10; categories.community.details.push(`Some activity: ${m5Txns} txns in 5m`); }
      else { categories.community.details.push('No recent transactions'); }
    }
    // Twitter search — external community discussion
    // Only score if at least one search actually succeeded (not errored)
    const tickerTweets = tickerSearchData?.totalResults || 0;
    const contractTweets = contractSearchData?.totalResults || 0;
    const totalSearchTweets = tickerTweets + contractTweets;
    const tickerSearchWorked = tickerSearchData && !tickerSearchData.error;
    const contractSearchWorked = contractSearchData && !contractSearchData.error;
    if (tickerSearchWorked || contractSearchWorked) {
      if (totalSearchTweets > 20) { categories.community.score += 25; categories.community.details.push(`Strong Twitter buzz: ${totalSearchTweets} mentions found`); }
      else if (totalSearchTweets > 10) { categories.community.score += 15; categories.community.details.push(`Some Twitter discussion: ${totalSearchTweets} mentions`); }
      else if (totalSearchTweets > 3) { categories.community.score += 10; categories.community.details.push(`Low Twitter presence: ${totalSearchTweets} mentions`); }
      else if (totalSearchTweets === 0) { categories.community.details.push('No Twitter mentions found in search'); }
    } else {
      categories.community.details.push('Twitter search unavailable (no cookies configured)');
    }
    categories.community.score = Math.min(100, Math.max(0, categories.community.score));

    // ── DEV TRUST: dev wallet reputation ──
    if (analysisAny?.creatorInfo) {
      const ci = analysisAny.creatorInfo;
      const gradRate = ci.graduated / Math.max(ci.totalCoinsCreated, 1);
      if (ci.totalCoinsCreated <= 3) { categories.devTrust.score += 30; categories.devTrust.details.push(`Few coins created (${ci.totalCoinsCreated}) — focused dev`); }
      else if (ci.totalCoinsCreated <= 10) { categories.devTrust.score += 15; categories.devTrust.details.push(`${ci.totalCoinsCreated} coins — moderate`); }
      else { categories.devTrust.score -= 10; categories.devTrust.details.push(`${ci.totalCoinsCreated} coins — serial launcher`); }

      if (gradRate > 0.3) { categories.devTrust.score += 30; categories.devTrust.details.push(`High graduation rate: ${(gradRate * 100).toFixed(0)}%`); }
      else if (gradRate > 0.1) { categories.devTrust.score += 15; categories.devTrust.details.push(`Moderate graduation rate: ${(gradRate * 100).toFixed(0)}%`); }
      else if (ci.totalCoinsCreated > 5) { categories.devTrust.details.push(`Low graduation rate: ${(gradRate * 100).toFixed(0)}%`); }

      if (ci.graduated > 0) { categories.devTrust.score += 20; categories.devTrust.details.push(`${ci.graduated} graduated tokens — proven`); }
    }
    if (analysisData) {
      if (analysisData.rugScore < 30) { categories.devTrust.score += 20; categories.devTrust.details.push('Low rug risk'); }
      else if (analysisData.rugScore > 70) { categories.devTrust.score -= 20; categories.devTrust.details.push('HIGH rug risk!'); }
    }
    // GMGN security signals for devTrust
    if (gmgnData && !gmgnData.error) {
      if (gmgnData.creatorPercentage === 0) { categories.devTrust.score += 10; categories.devTrust.details.push('Dev sold all tokens — no dump risk'); }
      if (gmgnData.mintAuthority) { categories.devTrust.score -= 20; categories.devTrust.details.push('⚠️ Mint authority NOT revoked!'); }
      if (gmgnData.freezeAuthority) { categories.devTrust.score -= 15; categories.devTrust.details.push('⚠️ Freeze authority NOT revoked!'); }
      if (gmgnData.isHoneypot) { categories.devTrust.score -= 40; categories.devTrust.details.push('🍯 HONEYPOT — cannot sell!'); }
    }
    // RugCheck risk score
    if (rugcheckData && !rugcheckData.error && rugcheckData.score != null) {
      if (rugcheckData.score > 700) { categories.devTrust.score += 10; categories.devTrust.details.push(`RugCheck: GOOD (${rugcheckData.score})`); }
      else if (rugcheckData.score < 300) { categories.devTrust.score -= 15; categories.devTrust.details.push(`RugCheck: DANGER (${rugcheckData.score})`); }
    }
    categories.devTrust.score = Math.min(100, Math.max(0, categories.devTrust.score));

    // ── TOKENOMICS: holder distribution, supply, curve ──
    if (analysisData) {
      const signals = analysisData.signals;
      if (signals.some((s: string) => /good distribution/i.test(s))) { categories.tokenomics.score += 30; categories.tokenomics.details.push('Good holder distribution'); }
      if (signals.some((s: string) => /high concentration/i.test(s))) { categories.tokenomics.score -= 10; categories.tokenomics.details.push('Concentrated holdings — risky'); }
      if (signals.some((s: string) => /bundled/i.test(s))) { categories.tokenomics.score -= 20; categories.tokenomics.details.push('Bundled wallets detected!'); }
    }
    if (tokenInfo.bondingCurveProgress >= 100) {
      categories.tokenomics.score += 30;
      categories.tokenomics.details.push('Graduated — bonding curve complete');
    } else if (tokenInfo.bondingCurveProgress > 50) {
      categories.tokenomics.score += 20;
      categories.tokenomics.details.push(`Bonding at ${tokenInfo.bondingCurveProgress.toFixed(0)}% — good progress`);
    } else {
      categories.tokenomics.score += 10;
      categories.tokenomics.details.push(`Bonding at ${tokenInfo.bondingCurveProgress.toFixed(0)}% — early stage`);
    }
    // Standard pump.fun supply = 1B, all identical — no extra scoring needed
    categories.tokenomics.score += 20; // Baseline: pump.fun standard supply
    categories.tokenomics.details.push('Standard 1B supply (pump.fun)');
    // GMGN security data for tokenomics scoring
    if (gmgnData && !gmgnData.error) {
      if (gmgnData.insiderRate != null && gmgnData.insiderRate > 0.3) { categories.tokenomics.score -= 20; categories.tokenomics.details.push(`🕵️ Insiders hold ${(gmgnData.insiderRate * 100).toFixed(1)}% — heavy insider activity`); }
      else if (gmgnData.insiderRate != null && gmgnData.insiderRate > 0.1) { categories.tokenomics.score -= 10; categories.tokenomics.details.push(`Insiders hold ${(gmgnData.insiderRate * 100).toFixed(1)}%`); }
      if (gmgnData.bundleRate != null && gmgnData.bundleRate > 0.1) { categories.tokenomics.score -= 15; categories.tokenomics.details.push(`📦 Bundled buys: ${(gmgnData.bundleRate * 100).toFixed(1)}% — coordinated accumulation`); }
      else if (gmgnData.bundleRate != null && gmgnData.bundleRate > 0.02) { categories.tokenomics.score -= 5; categories.tokenomics.details.push(`Bundles: ${(gmgnData.bundleRate * 100).toFixed(1)}%`); }
      if (gmgnData.sniperCount != null && gmgnData.sniperCount > 10) { categories.tokenomics.score -= 10; categories.tokenomics.details.push(`🎯 ${gmgnData.sniperCount} snipers at launch — early dump risk`); }
      else if (gmgnData.sniperCount != null && gmgnData.sniperCount > 3) { categories.tokenomics.details.push(`${gmgnData.sniperCount} snipers at launch`); }
      if (gmgnData.top10HolderRate != null) {
        if (gmgnData.top10HolderRate > 0.5) { categories.tokenomics.score -= 15; categories.tokenomics.details.push(`Top 10 hold ${(gmgnData.top10HolderRate * 100).toFixed(1)}% — very concentrated`); }
        else if (gmgnData.top10HolderRate > 0.3) { categories.tokenomics.score -= 5; categories.tokenomics.details.push(`Top 10 hold ${(gmgnData.top10HolderRate * 100).toFixed(1)}%`); }
        else { categories.tokenomics.score += 10; categories.tokenomics.details.push(`Top 10 hold ${(gmgnData.top10HolderRate * 100).toFixed(1)}% — well distributed`); }
      }
    }
    categories.tokenomics.score = Math.min(100, Math.max(0, categories.tokenomics.score));

    // ── MOMENTUM: price action, volume, ATH proximity ──
    // Use pump.fun market data first, fall back to GMGN data for graduated tokens
    const hasMarketData = marketData && !marketData.error;
    const hasGmgnMomentum = gmgnData && !gmgnData.error && (gmgnData.volume24h || gmgnData.priceChange5m != null);

    if (hasMarketData || hasGmgnMomentum) {
      // Volume (prefer pump.fun, fallback GMGN 24h volume)
      const h1Vol = hasMarketData ? (marketData.h1?.volume || 0) : 0;
      const vol24h = gmgnData?.volume24h || 0;
      if (h1Vol > 50000) { categories.momentum.score += 30; categories.momentum.details.push(`High 1h volume: $${(h1Vol / 1000).toFixed(1)}K`); }
      else if (h1Vol > 10000) { categories.momentum.score += 20; categories.momentum.details.push(`Moderate 1h volume: $${(h1Vol / 1000).toFixed(1)}K`); }
      else if (h1Vol > 1000) { categories.momentum.score += 10; categories.momentum.details.push(`Low 1h volume: $${h1Vol.toFixed(0)}`); }
      else if (vol24h > 100000) { categories.momentum.score += 25; categories.momentum.details.push(`High 24h volume: $${(vol24h / 1000).toFixed(1)}K (GMGN)`); }
      else if (vol24h > 20000) { categories.momentum.score += 15; categories.momentum.details.push(`Moderate 24h volume: $${(vol24h / 1000).toFixed(1)}K (GMGN)`); }
      else if (vol24h > 1000) { categories.momentum.score += 5; categories.momentum.details.push(`Low 24h volume: $${vol24h.toFixed(0)} (GMGN)`); }
      else { categories.momentum.details.push('Very low volume'); }

      // Price changes (prefer pump.fun 5m, fallback GMGN)
      const m5Change = hasMarketData ? (marketData.m5?.priceChangePercent || 0) : (gmgnData?.priceChange5m || 0);
      const h1Change = hasMarketData ? (marketData.h1?.priceChangePercent || 0) : (gmgnData?.priceChange1h || 0);

      if (m5Change > 10) { categories.momentum.score += 20; categories.momentum.details.push(`Strong 5m pump: +${m5Change.toFixed(1)}%`); }
      else if (m5Change > 0) { categories.momentum.score += 10; categories.momentum.details.push(`5m up: +${m5Change.toFixed(1)}%`); }
      else if (m5Change < -10) { categories.momentum.details.push(`5m dump: ${m5Change.toFixed(1)}%`); }

      if (h1Change > 20) { categories.momentum.score += 20; categories.momentum.details.push(`1h pumping: +${h1Change.toFixed(1)}%`); }
      else if (h1Change > 0) { categories.momentum.score += 10; }
      else if (h1Change < -20) { categories.momentum.score -= 10; categories.momentum.details.push(`1h bleeding: ${h1Change.toFixed(1)}%`); }
    }
    if (tokenInfo.marketCap > 0) {
      const athMcap = (athData && !athData.error ? (athData.ath_usd_market_cap || athData.athMarketCap || athData.ath_market_cap || 0) : 0)
        || (gmgnData && !gmgnData.error ? gmgnData.athMarketCap : 0)
        || (tokenInfo as any)?._extra?.athMarketCap || 0;
      if (athMcap > 0) {
        const athDrop = ((athMcap - tokenInfo.marketCap) / athMcap) * 100;
        if (athDrop < 20) { categories.momentum.score += 20; categories.momentum.details.push(`Near ATH (-${athDrop.toFixed(0)}%)`); }
        else if (athDrop < 50) { categories.momentum.score += 10; categories.momentum.details.push(`Moderate ATH drop: -${athDrop.toFixed(0)}%`); }
        else { categories.momentum.details.push(`Far from ATH: -${athDrop.toFixed(0)}%`); }
      }
    }
    categories.momentum.score = Math.min(100, Math.max(0, categories.momentum.score));

    // ── NARRATIVE: meta fit, website theme, description keywords ──
    const allText = [
      tokenInfo.name, tokenInfo.symbol, tokenInfo.description,
      ws?.title, ws?.description, ws?.contentPreview,
      tw?.bio,
    ].filter(Boolean).join(' ').toLowerCase();

    const narrativeKeywords: Record<string, string[]> = {
      'AI/Tech': ['ai', 'artificial intel', 'machine learning', 'gpt', 'neural', 'bot', 'agent', 'autonomous'],
      'Meme/Culture': ['meme', 'doge', 'pepe', 'wojak', 'chad', 'based', 'moon', 'frog', 'cat', 'dog'],
      'DeFi': ['defi', 'yield', 'staking', 'liquidity', 'swap', 'lending', 'protocol'],
      'Gaming': ['game', 'play', 'nft', 'metaverse', 'p2e', 'gaming', 'quest'],
      'Political': ['trump', 'biden', 'politics', 'election', 'president', 'maga'],
      'Utility': ['utility', 'platform', 'ecosystem', 'tools', 'protocol', 'infra'],
    };

    const detectedNarratives: string[] = [];
    for (const [narrative, keywords] of Object.entries(narrativeKeywords)) {
      if (keywords.some(k => allText.includes(k))) {
        detectedNarratives.push(narrative);
      }
    }

    if (detectedNarratives.length > 0) {
      categories.narrative.score += 30;
      categories.narrative.details.push(`Fits narratives: ${detectedNarratives.join(', ')}`);
    }
    if (isMeme) {
      // Meme-specific narrative scoring: virality, meme appeal, cultural relevance
      if (memeHits.length >= 3) { categories.narrative.score += 25; categories.narrative.details.push(`Strong meme identity (${memeHits.join(', ')})`); }
      else if (memeHits.length >= 1) { categories.narrative.score += 15; categories.narrative.details.push(`Meme references: ${memeHits.join(', ')}`); }
      if (tokenInfo.description && tokenInfo.description.length > 20) {
        categories.narrative.score += 10;
        categories.narrative.details.push('Has meme narrative/description');
      }
      if (tw && !tw.error && tw.bio) { categories.narrative.score += 10; categories.narrative.details.push('Twitter bio supports narrative'); }
    } else {
      if (tokenInfo.description && tokenInfo.description.length > 100) {
        categories.narrative.score += 20;
        categories.narrative.details.push('Detailed project description');
      } else if (tokenInfo.description && tokenInfo.description.length > 20) {
        categories.narrative.score += 10;
      }
      if (ws?.indicators?.hasRoadmap) { categories.narrative.score += 20; categories.narrative.details.push('Has clear roadmap/vision'); }
    }
    if (ws?.title && ws.title.length > 5) { categories.narrative.score += 10; }
    categories.narrative.score = Math.min(100, Math.max(0, categories.narrative.score));

    // ── Overall score (weighted average — adaptive by token type) ──
    const weights = isMeme
      ? { legitimacy: 0.10, community: 0.25, devTrust: 0.20, tokenomics: 0.15, momentum: 0.15, narrative: 0.15 }
      : { legitimacy: 0.25, community: 0.15, devTrust: 0.25, tokenomics: 0.15, momentum: 0.10, narrative: 0.10 };
    let overallScore = 0;
    for (const [cat, w] of Object.entries(weights)) {
      overallScore += categories[cat].score * w;
    }
    overallScore = Math.round(overallScore);

    // ── PATTERN UNIQUALIZER: check for repeated patterns ──
    const patternResult = this.checkPatternUniqueness(mint, tokenInfo, linksData);
    
    // Apply penalty to overall score
    if (patternResult.penalty > 0) {
      overallScore = Math.max(0, overallScore - patternResult.penalty);
    }

    // Record this token's pattern fingerprint for future comparisons
    this.recordPattern(mint, tokenInfo, linksData, analysisData, detectedNarratives);

    // ── Follow links from recent tweets (GitHub repos, websites, etc.) ──
    let tweetLinkedContent: any[] | undefined;
    if (tw && !tw.error && tw.recentTweets?.length) {
      const allTweetUrls = new Set<string>();
      for (const t of tw.recentTweets) {
        if (t.links?.length) {
          for (const l of t.links) {
            const url = l.expandedUrl || l.url || l.displayUrl;
            if (url && url.startsWith('http') && !/(?:twitter\.com|x\.com|t\.co)\//i.test(url)) {
              allTweetUrls.add(url);
            }
          }
        }
        // Also extract from tweet text
        if (t.text) {
          const textUrls = t.text.match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
          for (const u of textUrls) {
            if (!/(?:twitter\.com|x\.com|t\.co)\//i.test(u)) allTweetUrls.add(u);
          }
        }
      }
      if (allTweetUrls.size > 0) {
        // Follow up to 5 links — reuse followTweetLinks logic
        const pseudoTweet: {
          fullText: string;
          links: { expandedUrl: string }[];
          linkedContent?: any[];
        } = { fullText: '', links: [...allTweetUrls].slice(0, 5).map(u => ({ expandedUrl: u })) };
        await this.followTweetLinks(pseudoTweet);
        tweetLinkedContent = pseudoTweet.linkedContent;
      }
    }

    let verdict: string;
    let emoji: string;
    if (patternResult.isClone) { verdict = 'CLONE/REPEAT — AVOID'; emoji = '🔴'; }
    else if (overallScore >= 75) { verdict = 'STRONG PROJECT'; emoji = '🟢'; }
    else if (overallScore >= 55) { verdict = 'PROMISING'; emoji = '🟡'; }
    else if (overallScore >= 35) { verdict = 'RISKY'; emoji = '🟠'; }
    else { verdict = 'AVOID'; emoji = '🔴'; }

    return {
      mint,
      name: tokenInfo.name,
      symbol: tokenInfo.symbol,
      tokenType,
      overallScore,
      verdict: `${emoji} ${verdict}`,
      categoryScores: Object.fromEntries(
        Object.entries(categories).map(([k, v]) => [k, { score: v.score, details: v.details }])
      ),
      detectedNarratives,
      websiteSummary: ws && !ws.error ? {
        title: ws.title,
        description: ws.description,
        headings: (ws.headings || []).slice(0, 5),
        fullContent: (ws.fullContent || ws.contentPreview || '').slice(0, 1500),
        externalLinks: (ws.externalLinks || []).slice(0, 5),
        hasRoadmap: ws.indicators?.hasRoadmap,
        hasTeam: ws.indicators?.hasTeam,
        hasTokenomics: ws.indicators?.hasTokenomics,
        hasDocs: ws.indicators?.hasDocs,
        hasBuyButton: ws.indicators?.hasBuyButton,
        isPlaceholder: ws.indicators?.isPlaceholder,
      } : null,
      twitterSummary: tw && !tw.error ? {
        username: tw.username,
        displayName: tw.displayName,
        bio: tw.bio,
        followers: tw.followers,
        following: tw.following,
        verified: tw.verified,
        accountAgeDays: tw.accountAgeDays,
        createdAt: tw.createdAt,
        tweetCount: tw.tweets,
        recentTweets: (tw.recentTweets || []).slice(0, 5),
        // Include tweet-specific data if the link was to a specific tweet
        ...(tw.type === 'tweet' ? {
          type: 'tweet',
          tweetContent: tw.fullText,
          tweetEngagement: tw.engagement,
          tweetMedia: tw.media,
          tweetLinks: tw.links,
          quotedTweet: tw.quotedTweet,
          authorProfile: tw.authorProfile,
        } : {}),
        // Fetched content from links found in tweets
        ...(tweetLinkedContent?.length ? { linkedContent: tweetLinkedContent } : {}),
      } : null,
      rugScore: analysisData?.rugScore ?? null,
      marketCap: tokenInfo.marketCap,
      bondingProgress: tokenInfo.bondingCurveProgress,
      // Include market activity data for AI to interpret
      marketActivity: marketData && !marketData.error ? marketData : null,
      athMarketCap: (athData && !athData.error ? (athData.ath_usd_market_cap || athData.athMarketCap || athData.ath_market_cap || null) : null)
        || (gmgnData && !gmgnData.error ? gmgnData.athMarketCap : null)
        || (tokenInfo as any)?._extra?.athMarketCap || null,
      // Pattern uniqueness (self-learning clone/scam detection)
      patternAnalysis: {
        uniquenessScore: patternResult.uniquenessScore,
        penalty: patternResult.penalty,
        isClone: patternResult.isClone,
        matches: patternResult.matches,
      },
      // Volume & price data from GMGN
      volume24h: gmgnData?.volume24h ?? null,
      priceChange5m: gmgnData?.priceChange5m ?? null,
      priceChange1h: gmgnData?.priceChange1h ?? null,
      priceChange24h: gmgnData?.priceChange24h ?? null,
      // GMGN Token Security Data
      tokenSecurity: gmgnData && !gmgnData.error ? {
        top10HolderRate: gmgnData.top10HolderRate,
        devHolding: gmgnData.devHoldingRate,
        snipers: gmgnData.sniperCount,
        insiderRate: gmgnData.insiderRate,
        bundleRate: gmgnData.bundleRate,
        freshBuys: gmgnData.freshWalletCount,
        freshHoldingRate: gmgnData.freshWalletRate,
        mintAuthority: gmgnData.mintAuthority,
        freezeAuthority: gmgnData.freezeAuthority,
        isHoneypot: gmgnData.isHoneypot,
        buyTax: gmgnData.buyTax,
        sellTax: gmgnData.sellTax,
      } : null,
      // RugCheck report
      rugcheckReport: rugcheckData && !rugcheckData.error ? {
        score: rugcheckData.score,
        risks: rugcheckData.risks,
        liquidity: rugcheckData.totalMarketLiquidity,
        markets: rugcheckData.markets,
      } : null,

      // Twitter Search Intelligence (by ticker & contract)
      twitterSearch: (tickerSearchData || contractSearchData) ? {
        byTicker: tickerSearchData ? {
          totalResults: tickerSearchData.totalResults,
          uniqueAuthors: tickerSearchData.summary?.uniqueAuthors,
          verifiedAuthors: tickerSearchData.summary?.verifiedAuthors,
          avgFollowers: tickerSearchData.summary?.avgFollowers,
          totalLikes: tickerSearchData.summary?.totalLikes,
          totalRetweets: tickerSearchData.summary?.totalRetweets,
          sentiment: tickerSearchData.summary?.sentiment,
          topTweets: (tickerSearchData.tweets || []).slice(0, 5).map((t: any) => ({
            text: t.text?.slice(0, 280),
            author: t.author,
            followers: t.authorFollowers,
            verified: t.authorVerified,
            likes: t.likes,
            retweets: t.retweets,
            date: t.createdAt,
          })),
        } : null,
        byContract: contractSearchData ? {
          totalResults: contractSearchData.totalResults,
          uniqueAuthors: contractSearchData.summary?.uniqueAuthors,
          verifiedAuthors: contractSearchData.summary?.verifiedAuthors,
          avgFollowers: contractSearchData.summary?.avgFollowers,
          totalLikes: contractSearchData.summary?.totalLikes,
          totalRetweets: contractSearchData.summary?.totalRetweets,
          sentiment: contractSearchData.summary?.sentiment,
          topTweets: (contractSearchData.tweets || []).slice(0, 3).map((t: any) => ({
            text: t.text?.slice(0, 280),
            author: t.author,
            followers: t.authorFollowers,
            verified: t.authorVerified,
            likes: t.likes,
            retweets: t.retweets,
            date: t.createdAt,
          })),
        } : null,
      } : null,
    };
  }

  // ===== PATTERN UNIQUALIZER — Self-learning scam/clone detection =====

  /**
   * Extract significant words from a text for fingerprinting.
   * Normalizes, removes stopwords & short words, sorts for stable hashing.
   */
  private extractDescriptionWords(text: string): string[] {
    if (!text) return [];
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
      'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
      'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'this', 'that',
      'these', 'those', 'it', 'its', 'we', 'our', 'you', 'your', 'they',
      'their', 'my', 'i', 'me', 'he', 'she', 'him', 'her', 'us', 'them',
      'token', 'coin', 'crypto', 'solana', 'sol', 'pump', 'fun', 'meme',
      'about', 'just', 'more', 'most', 'very', 'all', 'any', 'each', 'every',
      'no', 'new', 'first', 'last', 'get', 'got', 'one', 'two', 'also',
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w))
      .sort();
  }

  /**
   * Simple hash of sorted word array for fast content comparison.
   */
  private hashWords(words: string[]): string {
    if (words.length === 0) return '';
    // Simple deterministic hash 
    let hash = 0;
    const str = words.join('|');
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Extract a name pattern — normalize common prefixes/suffixes (Baby X, X Inu, X Moon, etc.)
   */
  private extractNamePattern(name: string): string | null {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    const patterns = [
      /^(baby|mini|micro|nano|little|tiny|super|mega|ultra|giga)\s+/i,
      /\s+(inu|doge|moon|rocket|elon|trump|pepe|cat|dog|coin|swap|fi|verse|chain|ai|bot|agent)$/i,
    ];
    for (const pat of patterns) {
      const m = lower.match(pat);
      if (m) {
        // Return the template pattern (e.g., "baby *" or "* inu")
        if (pat.source.startsWith('^')) {
          return m[1].toLowerCase() + ' *';
        } else {
          return '* ' + m[1].toLowerCase();
        }
      }
    }
    return null;
  }

  /**
   * Extract domain from URL for fingerprinting.
   */
  private extractDomain(url: string): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /**
   * Extract Twitter/Telegram handle from URL.
   */
  private extractHandle(url: string): string | null {
    if (!url) return null;
    // Twitter: x.com/handle or twitter.com/handle
    const twMatch = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/i);
    if (twMatch) return twMatch[1].toLowerCase();
    // Telegram: t.me/handle
    const tgMatch = url.match(/t\.me\/([a-zA-Z0-9_]+)/i);
    if (tgMatch) return tgMatch[1].toLowerCase();
    return null;
  }

  /**
   * Calculate word overlap percentage between two word arrays.
   * Returns 0-1 (0 = no overlap, 1 = identical).
   */
  private wordOverlap(words1: string[], words2: string[]): number {
    if (words1.length === 0 || words2.length === 0) return 0;
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    let overlap = 0;
    for (const w of set1) {
      if (set2.has(w)) overlap++;
    }
    const unionSize = new Set([...words1, ...words2]).size;
    return unionSize > 0 ? overlap / unionSize : 0;
  }

  /**
   * Record a token's pattern fingerprint after analysis.
   */
  private recordPattern(mint: string, tokenInfo: TokenInfo, linksData: any, analysisData: any, detectedNarratives: string[]): void {
    try {
      const descWords = this.extractDescriptionWords(tokenInfo.description || '');
      const websiteContent = linksData?.website?.fullContent || linksData?.website?.contentPreview || '';
      const websiteWords = this.extractDescriptionWords(websiteContent);

      this.ctx.memory.storeTokenPattern({
        mint,
        dev: tokenInfo.dev || undefined,
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        descriptionWords: descWords.length > 0 ? descWords : undefined,
        twitterHandle: this.extractHandle(tokenInfo.twitter || '') || undefined,
        telegramHandle: this.extractHandle(tokenInfo.telegram || '') || undefined,
        websiteDomain: this.extractDomain(tokenInfo.website || '') || undefined,
        websiteContentHash: websiteWords.length > 3 ? this.hashWords(websiteWords) : undefined,
        namePattern: this.extractNamePattern(tokenInfo.name) || undefined,
        narrativeTags: detectedNarratives.length > 0 ? detectedNarratives : undefined,
        score: analysisData?.score,
        rugScore: analysisData?.rugScore,
      });
    } catch (err) {
      this.logger.warn('Failed to record token pattern', err);
    }
  }

  /**
   * Check how unique this token is against all stored patterns.
   * Returns a uniqueness report with penalty score and matched patterns.
   */
  private checkPatternUniqueness(mint: string, tokenInfo: TokenInfo, linksData: any): {
    uniquenessScore: number; // 0-100 (100 = fully unique, 0 = total clone)
    penalty: number; // Points to subtract from overall score
    matches: { type: string; count: number; details: string; severity: 'low' | 'medium' | 'high' }[];
    isClone: boolean;
  } {
    const matches: { type: string; count: number; details: string; severity: 'low' | 'medium' | 'high' }[] = [];
    let penalty = 0;

    try {
      // 1. Same dev launched other tokens
      if (tokenInfo.dev) {
        const devMatches = this.ctx.memory.findPatternsByDev(tokenInfo.dev, mint);
        if (devMatches.length > 0) {
          // Check how many were recent (last 24h)
          const recent = devMatches.filter((m: any) => Date.now() - m.created_at < 86_400_000);
          const recentBadOutcome = devMatches.filter((m: any) => m.outcome === 'loss' || m.outcome === 'rug');

          if (recent.length >= 3) {
            penalty += 25;
            matches.push({
              type: 'serial_dev',
              count: recent.length,
              details: `Dev launched ${recent.length} tokens in last 24h: ${recent.map((m: any) => m.symbol || m.name).join(', ')}`,
              severity: 'high',
            });
          } else if (devMatches.length >= 5) {
            penalty += 15;
            matches.push({
              type: 'prolific_dev',
              count: devMatches.length,
              details: `Dev has ${devMatches.length} analyzed tokens total`,
              severity: 'medium',
            });
          } else if (devMatches.length > 0) {
            penalty += 5;
            matches.push({
              type: 'known_dev',
              count: devMatches.length,
              details: `Dev launched ${devMatches.length} other token(s): ${devMatches.map((m: any) => m.symbol || m.name).join(', ')}`,
              severity: 'low',
            });
          }

          // If dev's previous tokens had bad outcomes, heavier penalty
          if (recentBadOutcome.length >= 2) {
            penalty += 20;
            matches.push({
              type: 'dev_bad_history',
              count: recentBadOutcome.length,
              details: `${recentBadOutcome.length} of dev's tokens ended in loss/rug`,
              severity: 'high',
            });
          }
        }
      }

      // 2. Same Twitter account used for multiple tokens
      const twHandle = this.extractHandle(tokenInfo.twitter || '');
      if (twHandle) {
        const twMatches = this.ctx.memory.findPatternsByTwitter(twHandle, mint);
        if (twMatches.length > 0) {
          penalty += 15;
          matches.push({
            type: 'reused_twitter',
            count: twMatches.length,
            details: `Twitter @${twHandle} linked to ${twMatches.length} other token(s): ${twMatches.map((m: any) => m.symbol || m.name).join(', ')}`,
            severity: 'high',
          });
        }
      }

      // 3. Same Telegram group
      const tgHandle = this.extractHandle(tokenInfo.telegram || '');
      if (tgHandle) {
        const tgMatches = this.ctx.memory.findPatternsByTelegram(tgHandle, mint);
        if (tgMatches.length > 0) {
          penalty += 15;
          matches.push({
            type: 'reused_telegram',
            count: tgMatches.length,
            details: `Telegram t.me/${tgHandle} linked to ${tgMatches.length} other token(s): ${tgMatches.map((m: any) => m.symbol || m.name).join(', ')}`,
            severity: 'high',
          });
        }
      }

      // 4. Same website domain
      const domain = this.extractDomain(tokenInfo.website || '');
      if (domain) {
        const domainMatches = this.ctx.memory.findPatternsByWebsite(domain, mint);
        if (domainMatches.length > 0) {
          penalty += 10;
          matches.push({
            type: 'reused_website',
            count: domainMatches.length,
            details: `Domain ${domain} used by ${domainMatches.length} other token(s)`,
            severity: 'medium',
          });
        }
      }

      // 5. Same website content (template site)
      const websiteContent = linksData?.website?.fullContent || linksData?.website?.contentPreview || '';
      const websiteWords = this.extractDescriptionWords(websiteContent);
      if (websiteWords.length > 3) {
        const contentHash = this.hashWords(websiteWords);
        const hashMatches = this.ctx.memory.findPatternsByContentHash(contentHash, mint);
        if (hashMatches.length > 0) {
          penalty += 20;
          matches.push({
            type: 'template_website',
            count: hashMatches.length,
            details: `Website content matches ${hashMatches.length} other project(s) — template/clone site`,
            severity: 'high',
          });
        }
      }

      // 6. Same name pattern (Baby X, X Inu, etc.)
      const namePattern = this.extractNamePattern(tokenInfo.name);
      if (namePattern) {
        const nameMatches = this.ctx.memory.findPatternsByNamePattern(namePattern, mint);
        if (nameMatches.length >= 3) {
          penalty += 10;
          matches.push({
            type: 'common_name_pattern',
            count: nameMatches.length,
            details: `Name pattern "${namePattern}" seen in ${nameMatches.length} other tokens`,
            severity: 'medium',
          });
        } else if (nameMatches.length > 0) {
          penalty += 3;
          matches.push({
            type: 'name_pattern',
            count: nameMatches.length,
            details: `Name pattern "${namePattern}" seen in ${nameMatches.length} other token(s)`,
            severity: 'low',
          });
        }
      }

      // 7. Description similarity check (word overlap with recent tokens)
      const descWords = this.extractDescriptionWords(tokenInfo.description || '');
      if (descWords.length > 3) {
        const allPatterns = this.ctx.memory.getAllPatternsWithDescriptions(mint, 200);
        let bestOverlap = 0;
        let bestMatch: any = null;
        for (const p of allPatterns) {
          try {
            const pWords = JSON.parse(p.description_words);
            const overlap = this.wordOverlap(descWords, pWords);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestMatch = p;
            }
          } catch { /* skip bad data */ }
        }

        if (bestOverlap > 0.7) {
          penalty += 20;
          matches.push({
            type: 'clone_description',
            count: 1,
            details: `Description ${Math.round(bestOverlap * 100)}% similar to ${bestMatch.symbol || bestMatch.name} (${bestMatch.mint.slice(0, 8)}...)`,
            severity: 'high',
          });
        } else if (bestOverlap > 0.4) {
          penalty += 8;
          matches.push({
            type: 'similar_description',
            count: 1,
            details: `Description ${Math.round(bestOverlap * 100)}% similar to ${bestMatch.symbol || bestMatch.name}`,
            severity: 'medium',
          });
        }
      }
    } catch (err) {
      this.logger.warn('Pattern uniqueness check error', err);
    }

    // Cap penalty
    penalty = Math.min(penalty, 50);
    const uniquenessScore = Math.max(0, 100 - penalty * 2);
    const isClone = penalty >= 30;

    return { uniquenessScore, penalty, matches, isClone };
  }

  // Helper: fetch market activity from swap-api
  private async fetchMarketActivity(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://swap-api.pump.fun/v2/coins/${mint}/market-activity`, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    } catch (err: any) {
      return { error: err.message };
    }
  }

  // Helper: fetch ATH from swap-api
  private async fetchTokenAth(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://swap-api.pump.fun/v2/coins/${mint}/ath`, {
        headers: { 'Accept': 'application/json', 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const data = await res.json() as any;
      this.logger.debug(`[fetchTokenAth] Raw response keys: ${Object.keys(data).join(', ')} values: ath_market_cap=${data.ath_market_cap}, ath_usd_market_cap=${data.ath_usd_market_cap}, usd_market_cap=${data.usd_market_cap}`);
      return data;
    } catch (err: any) {
      return { error: err.message };
    }
  }

  // ===== GMGN + RUGCHECK — External security data + similar tokens =====

  /** Fetch comprehensive token security data from GMGN.ai */
  private async fetchGmgnSecurity(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://gmgn.ai/',
          'Origin': 'https://gmgn.ai',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const json = await res.json() as any;
      if (json.code !== 0 || !json.data?.token) return { error: 'No data' };
      const t = json.data.token;
      return {
        top10HolderRate: t.top_10_holder_rate ?? null,
        devHoldingRate: t.dev_holding_rate ?? null,
        sniperCount: t.sniper_count ?? null,
        insiderRate: t.insider_rate ?? null,
        bundleRate: t.bundle_rate ?? null,
        dexBoost: t.dex_boost ?? t.open_timestamp ? null : null,
        freshWalletCount: t.fresh_wallet_count ?? null,
        freshWalletRate: t.fresh_wallet_24h_rate ?? t.fresh_wallet_rate ?? null,
        mintAuthority: t.mint_authority ?? null,
        freezeAuthority: t.freeze_authority ?? null,
        holderCount: t.holder_count ?? null,
        creatorClose: t.creator_close ?? null,
        creatorPercentage: t.creator_token_status === 'sell_all' ? 0 : (t.creator_percentage ?? null),
        launchpad: t.launchpad ?? null,
        openTimestamp: t.open_timestamp ?? null,
        // Price & market data enrichment
        price: t.price ?? null,
        marketCap: t.market_cap ?? null,
        volume24h: t.volume_24h ?? null,
        priceChange5m: t.price_change_percent?.m5 ?? null,
        priceChange1h: t.price_change_percent?.h1 ?? null,
        priceChange24h: t.price_change_percent?.h24 ?? null,
        buyTax: t.buy_tax ?? null,
        sellTax: t.sell_tax ?? null,
        isHoneypot: t.is_honeypot ?? null,
        // ATH data from GMGN
        athPrice: t.ath ?? t.highest_price ?? null,
        athMarketCap: t.ath_market_cap ?? t.high_market_cap ?? null,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /** Fetch token security report from RugCheck */
  private async fetchRugCheck(mint: string): Promise<any> {
    try {
      const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const data = await res.json() as any;
      const risks = (data.risks || []).map((r: any) => ({
        name: r.name,
        level: r.level,
        description: r.description,
        score: r.score,
      }));
      const topHolders = (data.topHolders || []).slice(0, 15).map((h: any) => ({
        address: h.address,
        pct: h.pct,
        isInsider: h.insider ?? false,
      }));
      return {
        score: data.score ?? null,
        risks,
        topHolders,
        totalMarketLiquidity: data.totalMarketLiquidity ?? null,
        markets: (data.markets || []).map((m: any) => ({
          marketType: m.marketType,
          lpLockedPct: m.lp?.lpLockedPct,
          lpLockedUSD: m.lp?.lpLockedUSD,
        })),
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /** Build a text-based bubble map showing holder clusters and concentration */
  private buildBubbleMap(
    holderData: any,
    gmgnData: any,
    rugcheckData: any,
  ): any {
    const clusters: any[] = [];
    const warnings: string[] = [];

    // ── Cluster detection from holder data ──
    const holders = holderData?.topHolders || rugcheckData?.topHolders || [];
    if (holders.length >= 2) {
      // Group by similar holdings (within 10% of each other) — likely same entity/bundler
      const amounts = holders.map((h: any) => ({
        address: h.address,
        pct: h.pct ?? h.percent ?? 0,
        label: h.label || '',
        isInsider: h.isInsider ?? false,
      }));
      const visited = new Set<number>();

      for (let i = 0; i < amounts.length; i++) {
        if (visited.has(i) || amounts[i].pct < 0.3) continue;
        const cluster: any[] = [amounts[i]];
        visited.add(i);
        for (let j = i + 1; j < amounts.length; j++) {
          if (visited.has(j) || amounts[j].pct < 0.3) continue;
          const max = Math.max(amounts[i].pct, amounts[j].pct);
          const min = Math.min(amounts[i].pct, amounts[j].pct);
          if (max > 0 && min / max > 0.85) {
            cluster.push(amounts[j]);
            visited.add(j);
          }
        }
        if (cluster.length >= 2) {
          const totalPct = cluster.reduce((s: number, c: any) => s + c.pct, 0);
          clusters.push({
            wallets: cluster.length,
            totalPercent: Math.round(totalPct * 100) / 100,
            addresses: cluster.map((c: any) => c.address?.slice(0, 8) + '...'),
            type: cluster.length >= 5 ? 'bundled_group' : cluster.length >= 3 ? 'likely_coordinated' : 'suspicious_pair',
          });
          if (cluster.length >= 3) {
            warnings.push(`⚠️ Cluster of ${cluster.length} wallets holding similar amounts (~${(cluster[0].pct).toFixed(1)}% each) — likely same entity: ${totalPct.toFixed(1)}% total`);
          }
        }
      }

      // Detect insider wallets from RugCheck data
      const insiders = amounts.filter((a: any) => a.isInsider);
      if (insiders.length > 0) {
        const insiderPct = insiders.reduce((s: number, a: any) => s + a.pct, 0);
        warnings.push(`🕵️ ${insiders.length} insider wallets detected holding ${insiderPct.toFixed(1)}%`);
      }
    }

    // ── GMGN security signals ──
    if (gmgnData && !gmgnData.error) {
      if (gmgnData.bundleRate > 0) warnings.push(`📦 Bundle rate: ${(gmgnData.bundleRate * 100).toFixed(1)}% of supply from bundled buys`);
      if (gmgnData.insiderRate > 0.1) warnings.push(`🕵️ Insider holding: ${(gmgnData.insiderRate * 100).toFixed(1)}%`);
      if (gmgnData.sniperCount > 5) warnings.push(`🎯 ${gmgnData.sniperCount} snipers detected at launch`);
      if (gmgnData.freshWalletCount > 100 && gmgnData.freshWalletRate < 0.01) warnings.push(`🆕 ${gmgnData.freshWalletCount} fresh wallets bought but hold <1% — wash trading signals`);
      if (gmgnData.isHoneypot) warnings.push(`🍯 HONEYPOT DETECTED — cannot sell!`);
      if (gmgnData.buyTax > 0 || gmgnData.sellTax > 0) warnings.push(`💸 Tax: buy ${gmgnData.buyTax}%, sell ${gmgnData.sellTax}%`);
    }

    // ── RugCheck risk flags ──
    if (rugcheckData && !rugcheckData.error) {
      for (const risk of (rugcheckData.risks || [])) {
        if (risk.level === 'danger' || risk.level === 'critical') {
          warnings.push(`🚨 RugCheck: ${risk.name} — ${risk.description}`);
        } else if (risk.level === 'warn') {
          warnings.push(`⚠️ RugCheck: ${risk.name} — ${risk.description}`);
        }
      }
    }

    // ── Summary metrics ──
    const top10Pct = gmgnData?.top10HolderRate != null
      ? (gmgnData.top10HolderRate * 100).toFixed(1) + '%'
      : holderData?.top10Percent != null
        ? holderData.top10Percent + '%'
        : 'N/A';

    return {
      top10HolderPercent: top10Pct,
      devHolding: gmgnData?.devHoldingRate != null ? (gmgnData.devHoldingRate * 100).toFixed(1) + '%' : (holderData?.devHoldingPercent ?? 'N/A') + '%',
      snipers: gmgnData?.sniperCount ?? 'N/A',
      insiderHolding: gmgnData?.insiderRate != null ? (gmgnData.insiderRate * 100).toFixed(1) + '%' : 'N/A',
      bundleHolding: gmgnData?.bundleRate != null ? (gmgnData.bundleRate * 100).toFixed(1) + '%' : 'N/A',
      freshBuys: gmgnData?.freshWalletCount ?? 'N/A',
      freshHolding: gmgnData?.freshWalletRate != null ? (gmgnData.freshWalletRate * 100).toFixed(1) + '%' : 'N/A',
      mintAuthority: gmgnData?.mintAuthority != null ? (gmgnData.mintAuthority ? 'YES ⚠️' : 'Revoked ✅') : 'N/A',
      freezeAuthority: gmgnData?.freezeAuthority != null ? (gmgnData.freezeAuthority ? 'YES ⚠️' : 'Revoked ✅') : 'N/A',
      rugcheckScore: rugcheckData?.score ?? 'N/A',
      rugcheckRisks: rugcheckData?.risks || [],
      clusters,
      warnings,
      holderCount: gmgnData?.holderCount ?? holderData?.totalHolders ?? 'N/A',
    };
  }

  private async fetchTokenMetadata(mint: string): Promise<TokenInfo | null> {
    // Check cache first (30s TTL)
    const cached = this.metadataCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    try {
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, {
        headers: { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
      });
      if (!res.ok) return null;
      const data = await res.json() as any;

      // Compute bonding curve progress from on-chain reserves
      const realSol = (data.real_sol_reserves || 0) / 1e9;
      const virtualSol = (data.virtual_sol_reserves || 0) / 1e9;
      const virtualTokens = (data.virtual_token_reserves || 0) / 1e6;
      // Only mark complete if BOTH flags set AND reserves actually confirm graduation (~85 SOL)
      const isComplete = !!data.complete && !!data.pool_address && realSol >= 79;
      // Always compute progress from realSol reserves — most accurate
      const bondingCurveProgress = isComplete ? 100 : (realSol > 0 ? Math.min((realSol / 85) * 100, 99.9) : 0);

      this.logger.debug(`[fetchTokenMetadata] ${mint.slice(0,8)}.. complete=${data.complete} pool=${!!data.pool_address} realSol=${realSol.toFixed(4)} isComplete=${isComplete} bonding=${bondingCurveProgress.toFixed(2)}% ath=${data.ath_market_cap}`);

      // Compute price from reserves
      const price = virtualTokens > 0 ? virtualSol / virtualTokens : 0;

      const result = {
        mint: data.mint,
        name: data.name,
        symbol: data.symbol,
        description: data.description,
        image: data.image_uri,
        twitter: data.twitter,
        telegram: data.telegram,
        website: data.website,
        dev: data.creator,
        createdAt: data.created_timestamp,
        bondingCurveProgress,
        marketCap: data.usd_market_cap || data.market_cap || 0,
        volume24h: 0,
        holders: 0,
        price,
        // Store extra fields for richer AI context
        _extra: {
          realSolReserves: realSol,
          virtualSolReserves: virtualSol,
          virtualTokenReserves: virtualTokens,
          complete: isComplete,
          bondingCurveAddress: data.bonding_curve || null,
          poolAddress: data.pool_address || null,
          replyCount: data.reply_count || 0,
          lastTradeTimestamp: data.last_trade_timestamp || null,
          athMarketCap: data.ath_market_cap || null,
        },
      } as any;

      // Cache for 30s
      this.metadataCache.set(mint, { data: result, expiresAt: Date.now() + 30_000 });
      return result;
    } catch {
      return null;
    }
  }
}
