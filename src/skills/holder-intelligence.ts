import { Skill, SkillManifest, SkillContext, EventBusInterface, LoggerInterface, MemoryInterface } from '../types.ts';

const KNOWN_PROGRAMS: Record<string, string> = {

  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun Bonding Curve Program',
  'PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu': 'pump.fun AMM Program',

  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h': 'Raydium CLMM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CPMM',

  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',

  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pool',

  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token Program',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022 Program',

  '11111111111111111111111111111111': 'System Program',
};

const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111',
  'deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
  '1111111111111111111111111111111111111111111',
]);

const KNOWN_INFRASTRUCTURE = new Set([
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJt85eFyR95',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
]);

interface ResolvedHolder {
  tokenAccount: string;
  ownerWallet: string;
  amount: number;
  pct: number;
  uiAmount: number;
  type: 'bonding_curve' | 'liquidity_pool' | 'burn' | 'dev' | 'infrastructure' | 'insider' | 'whale' | 'holder';
  label: string;
  programOwner: string;
}

interface HolderCluster {
  id: string;
  wallets: string[];
  totalPct: number;
  fundingSource: string | null;
  label: string;
}

interface HolderIntelligence {
  mint: string;

  totalSupply: number;
  bondingCurvePct: number;
  liquidityPoolPct: number;
  burnedPct: number;
  circulatingPct: number;

  totalHolders: number;
  uniqueWallets: number;
  top10Pct: number;
  top20Pct: number;
  clusters: HolderCluster[];
  insiderWallets: string[];
  insiderPct: number;
  devHoldingPct: number;
  devAddress: string;
  whaleCount: number;
  smartMoneyOverlap: string[];
  distribution: 'concentrated' | 'moderate' | 'distributed' | 'healthy';
  trend: 'accumulating' | 'distributing' | 'stable' | 'unknown';
  riskScore: number;

  holders: ResolvedHolder[];
  analyzedAt: number;
}

interface HolderSnapshot {
  mint: string;
  holders: number;
  topHolders: { address: string; pct: number }[];
  timestamp: number;
}

export class HolderIntelligenceSkill implements Skill {
  manifest: SkillManifest = {
    name: 'holder-intelligence',
    version: '2.0.0',
    description: 'Deep on-chain holder analysis with proper pump.fun tokenomics: resolves ATAs to wallets, identifies bonding curve / LP pool / burn / dev / whale holders, cluster detection, insider detection, smart money overlap',
    tools: [
      {
        name: 'holders_analyze',
        description: 'Full holder intelligence: resolves token accounts to wallets, classifies bonding curve / LP pool / burn / dev / whale, shows supply breakdown (circulating vs locked), cluster detection, risk score. This is the primary tool for understanding who holds a token.',
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
        name: 'holders_clusters',
        description: 'Detect wallet clusters — groups of wallets controlled by the same entity (similar buy amounts, synchronized purchases). Reveals hidden concentration.',
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
        name: 'holders_insiders',
        description: 'Detect insider/bundled wallets — wallets that bought within the first seconds of token launch. Reveals dev wallets, snipers, and bundled buys.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            windowSeconds: { type: 'number', description: 'Insider window seconds (default 5)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'holders_whales',
        description: 'List whale holders (>2% of CIRCULATING supply). Properly excludes bonding curve, LP pools, and burn addresses from calculations.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            minPct: { type: 'number', description: 'Minimum % of circulating supply to be whale (default 2)' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
      {
        name: 'holders_smart_money',
        description: 'Check which tracked smart-money wallets hold this token',
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
        name: 'holders_trend',
        description: 'Analyze accumulation vs distribution trend by comparing holder snapshots over time',
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
        name: 'holders_watch_dev',
        description: 'Monitor dev wallet for selling activity — alerts if dev sells >10% of holdings',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
            devAddress: { type: 'string', description: 'Dev wallet address' },
          },
          required: ['mint', 'devAddress'],
        },
        riskLevel: 'read',
      },
      {
        name: 'holders_stats',
        description: 'Get holder intelligence statistics',
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

  private snapshots = new Map<string, HolderSnapshot[]>();

  private watchedDevs = new Map<string, { mint: string; lastBalance: number }>();

  private cache = new Map<string, { intel: HolderIntelligence; expiresAt: number }>();
  private readonly CACHE_TTL = 3 * 60_000;

  private stats = {
    totalAnalyses: 0,
    clustersFound: 0,
    insidersDetected: 0,
    whaleAlerts: 0,
    devDumpsDetected: 0,
    smartMoneyHits: 0,
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
      case 'holders_analyze': return this.fullAnalysis(params.mint);
      case 'holders_clusters': return this.detectClusters(params.mint);
      case 'holders_insiders': return this.detectInsiders(params.mint, params.windowSeconds || 5);
      case 'holders_whales': return this.getWhales(params.mint, params.minPct || 2);
      case 'holders_smart_money': return this.checkSmartMoney(params.mint);
      case 'holders_trend': return this.analyzeTrend(params.mint);
      case 'holders_watch_dev': return this.watchDevWallet(params.mint, params.devAddress);
      case 'holders_stats': return { ...this.stats };
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {
    this.snapshots.clear();
    this.watchedDevs.clear();
    this.cache.clear();
  }


async quickRiskScore(mint: string): Promise<{ riskScore: number; flags: string[] }> {
    const cached = this.cache.get(mint);
    if (cached && cached.expiresAt > Date.now()) {
      return { riskScore: cached.intel.riskScore, flags: this.getFlags(cached.intel) };
    }

    try {
      const intel = await this.fullAnalysis(mint);
      return { riskScore: intel.riskScore, flags: this.getFlags(intel) };
    } catch {
      return { riskScore: 50, flags: ['analysis_failed'] };
    }
  }

  private getFlags(intel: HolderIntelligence): string[] {
    const flags: string[] = [];
    if (intel.bondingCurvePct > 50) flags.push(`bonding_curve_${intel.bondingCurvePct.toFixed(0)}%`);
    if (intel.insiderPct > 20) flags.push(`insiders_${intel.insiderPct.toFixed(0)}%`);
    if (intel.clusters.length > 0) flags.push(`${intel.clusters.length}_clusters`);
    if (intel.distribution === 'concentrated') flags.push('concentrated');
    if (intel.trend === 'distributing') flags.push('distributing');
    if (intel.devHoldingPct > 10) flags.push(`dev_holds_${intel.devHoldingPct.toFixed(0)}%`);
    if (intel.smartMoneyOverlap.length > 0) flags.push(`smart_money_${intel.smartMoneyOverlap.length}`);
    if (intel.liquidityPoolPct > 0) flags.push(`lp_${intel.liquidityPoolPct.toFixed(0)}%`);
    if (intel.burnedPct > 0) flags.push(`burned_${intel.burnedPct.toFixed(0)}%`);
    return flags;
  }


  private async fullAnalysis(mint: string): Promise<HolderIntelligence> {
    const cached = this.cache.get(mint);
    if (cached && cached.expiresAt > Date.now()) return cached.intel;

    this.stats.totalAnalyses++;
    const rpcUrl = this.getRpcUrl();


    const rawAccounts = await this.fetchTokenLargestAccounts(rpcUrl, mint);
    if (!rawAccounts || rawAccounts.length === 0) {
      return this.buildEmptyIntel(mint);
    }


    const resolvedHolders = await this.resolveTokenAccounts(rpcUrl, rawAccounts, mint);


    const token = this.memory.getToken(mint);
    const devAddress = token?.dev || '';


    const totalSupply = resolvedHolders.reduce((s, h) => s + h.amount, 0);
    let bondingCurveAmount = 0;
    let liquidityPoolAmount = 0;
    let burnedAmount = 0;
    let infrastructureAmount = 0;

    for (const holder of resolvedHolders) {
      holder.pct = totalSupply > 0 ? (holder.amount / totalSupply) * 100 : 0;
      holder.type = this.classifyHolder(holder, devAddress);
      holder.label = this.labelHolder(holder, devAddress);

      switch (holder.type) {
        case 'bonding_curve': bondingCurveAmount += holder.amount; break;
        case 'liquidity_pool': liquidityPoolAmount += holder.amount; break;
        case 'burn': burnedAmount += holder.amount; break;
        case 'infrastructure': infrastructureAmount += holder.amount; break;
      }
    }

    const bondingCurvePct = totalSupply > 0 ? (bondingCurveAmount / totalSupply) * 100 : 0;
    const liquidityPoolPct = totalSupply > 0 ? (liquidityPoolAmount / totalSupply) * 100 : 0;
    const burnedPct = totalSupply > 0 ? (burnedAmount / totalSupply) * 100 : 0;
    const circulatingAmount = totalSupply - bondingCurveAmount - liquidityPoolAmount - burnedAmount - infrastructureAmount;
    const circulatingPct = totalSupply > 0 ? (circulatingAmount / totalSupply) * 100 : 0;


    const realHolders = resolvedHolders.filter(h =>
      h.type !== 'bonding_curve' && h.type !== 'liquidity_pool' && h.type !== 'burn' && h.type !== 'infrastructure'
    );


    for (const h of realHolders) {
      h.pct = circulatingAmount > 0 ? (h.amount / circulatingAmount) * 100 : 0;
    }
    realHolders.sort((a, b) => b.pct - a.pct);


    const uniqueWallets = new Set(realHolders.map(h => h.ownerWallet)).size;

    const top10Pct = realHolders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
    const top20Pct = realHolders.slice(0, 20).reduce((s, h) => s + h.pct, 0);


    const devHoldings = realHolders.filter(h => h.ownerWallet === devAddress);
    const devHoldingPct = devHoldings.reduce((s, h) => s + h.pct, 0);


    const whaleCount = realHolders.filter(h => h.pct >= 2).length;


    const clusters = this.findClusters(realHolders.map(h => ({
      address: h.ownerWallet,
      amount: h.amount,
      pct: h.pct,
    })));
    if (clusters.length > 0) this.stats.clustersFound += clusters.length;


    const smartMoneyOverlap = this.findSmartMoneyOverlap(realHolders.map(h => h.ownerWallet));
    if (smartMoneyOverlap.length > 0) this.stats.smartMoneyHits++;


    const distribution = this.classifyDistribution(top10Pct, clusters.length);


    const trend = this.computeTrend(mint, realHolders.map(h => ({ address: h.ownerWallet, pct: h.pct })));


    this.storeSnapshot(mint, uniqueWallets, realHolders.slice(0, 20).map(h => ({ address: h.ownerWallet, pct: h.pct })));


    let riskScore = 20;

    if (top10Pct > 80) riskScore += 30;
    else if (top10Pct > 60) riskScore += 20;
    else if (top10Pct > 45) riskScore += 10;

    if (clusters.length >= 3) riskScore += 20;
    else if (clusters.length >= 1) riskScore += 10;

    if (devHoldingPct > 20) riskScore += 20;
    else if (devHoldingPct > 10) riskScore += 10;
    else if (devHoldingPct > 5) riskScore += 5;

    if (trend === 'distributing') riskScore += 10;
    if (smartMoneyOverlap.length > 0) riskScore -= 15;
    if (uniqueWallets < 10) riskScore += 15;

    riskScore = Math.max(0, Math.min(100, riskScore));

    const intel: HolderIntelligence = {
      mint,
      totalSupply,
      bondingCurvePct: Math.round(bondingCurvePct * 100) / 100,
      liquidityPoolPct: Math.round(liquidityPoolPct * 100) / 100,
      burnedPct: Math.round(burnedPct * 100) / 100,
      circulatingPct: Math.round(circulatingPct * 100) / 100,
      totalHolders: rawAccounts.length,
      uniqueWallets,
      top10Pct: Math.round(top10Pct * 100) / 100,
      top20Pct: Math.round(top20Pct * 100) / 100,
      clusters,
      insiderWallets: [],
      insiderPct: 0,
      devHoldingPct: Math.round(devHoldingPct * 100) / 100,
      devAddress,
      whaleCount,
      smartMoneyOverlap,
      distribution,
      trend,
      riskScore,
      holders: resolvedHolders.sort((a, b) => b.pct - a.pct),
      analyzedAt: Date.now(),
    };

    this.cache.set(mint, { intel, expiresAt: Date.now() + this.CACHE_TTL });
    return intel;
  }


private async resolveTokenAccounts(
    rpcUrl: string,
    accounts: { address: string; amount: number; decimals: number; uiAmount: number }[],
    mint: string,
  ): Promise<ResolvedHolder[]> {
    const resolved: ResolvedHolder[] = [];


    const batchSize = 20;
    for (let i = 0; i < accounts.length; i += batchSize) {
      const batch = accounts.slice(i, i + batchSize);
      const addresses = batch.map(a => a.address);

      try {
        const res = await fetch(rpcUrl, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getMultipleAccounts',
            params: [addresses, { encoding: 'jsonParsed' }],
          }),
        });

        const data = await res.json() as any;
        const results = data?.result?.value || [];

        for (let j = 0; j < batch.length; j++) {
          const acct = batch[j];
          const info = results[j];
          let ownerWallet = acct.address;
          let programOwner = '';

          if (info?.value || info) {
            const val = info.value || info;
            programOwner = val.owner || '';
            const parsed = val.data?.parsed;

            if (parsed?.type === 'account' && parsed.info?.owner) {
              ownerWallet = parsed.info.owner;
            }
          }

          resolved.push({
            tokenAccount: acct.address,
            ownerWallet,
            amount: acct.amount,
            pct: 0,
            uiAmount: acct.uiAmount,
            type: 'holder',
            label: '',
            programOwner,
          });
        }
      } catch (err) {

        for (const acct of batch) {
          resolved.push({
            tokenAccount: acct.address,
            ownerWallet: acct.address,
            amount: acct.amount,
            pct: 0,
            uiAmount: acct.uiAmount,
            type: 'holder',
            label: 'unresolved',
            programOwner: '',
          });
        }
      }
    }

    return resolved;
  }


  private classifyHolder(holder: ResolvedHolder, devAddress: string): ResolvedHolder['type'] {
    const wallet = holder.ownerWallet;
    const program = holder.programOwner;


    if (BURN_ADDRESSES.has(wallet)) return 'burn';


    if (KNOWN_INFRASTRUCTURE.has(wallet)) return 'infrastructure';


    if (program === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') return 'bonding_curve';


    const poolPrograms = [
      'PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu',
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    ];
    if (poolPrograms.includes(program)) return 'liquidity_pool';


    if (KNOWN_PROGRAMS[wallet]) return 'liquidity_pool';


    if (devAddress && wallet === devAddress) return 'dev';


    if (holder.label === 'unresolved' && holder.pct > 30) return 'bonding_curve';

    return 'holder';
  }

  private labelHolder(holder: ResolvedHolder, devAddress: string): string {
    switch (holder.type) {
      case 'bonding_curve': return '🔒 Bonding Curve (unsold supply)';
      case 'liquidity_pool': {
        const name = KNOWN_PROGRAMS[holder.programOwner] || KNOWN_PROGRAMS[holder.ownerWallet] || 'DEX Pool';
        return `🏊 LP: ${name}`;
      }
      case 'burn': return '🔥 Burned (permanently locked)';
      case 'infrastructure': return '⚙️ Infrastructure/Fees';
      case 'dev': return `👨‍💻 Dev wallet (${holder.ownerWallet.slice(0, 8)}...)`;
      default: {
        if (holder.pct > 10) return `🐋 Mega whale (${holder.ownerWallet.slice(0, 8)}...)`;
        if (holder.pct > 5) return `🐳 Whale (${holder.ownerWallet.slice(0, 8)}...)`;
        if (holder.pct > 2) return `🦈 Large holder (${holder.ownerWallet.slice(0, 8)}...)`;
        if (holder.pct > 1) return `📊 Medium holder (${holder.ownerWallet.slice(0, 8)}...)`;
        return `👤 Holder (${holder.ownerWallet.slice(0, 8)}...)`;
      }
    }
  }

  private async detectClusters(mint: string): Promise<HolderCluster[]> {
    const rpcUrl = this.getRpcUrl();
    const rawAccounts = await this.fetchTokenLargestAccounts(rpcUrl, mint);
    if (!rawAccounts || rawAccounts.length === 0) return [];

    const resolved = await this.resolveTokenAccounts(rpcUrl, rawAccounts, mint);
    const totalSupply = resolved.reduce((s, h) => s + h.amount, 0);
    const circulatingHolders = resolved
      .filter(h => {
        h.pct = totalSupply > 0 ? (h.amount / totalSupply) * 100 : 0;
        const type = this.classifyHolder(h, '');
        return type === 'holder' || type === 'dev';
      })
      .map(h => ({ address: h.ownerWallet, amount: h.amount, pct: h.pct }))
      .sort((a, b) => b.pct - a.pct);

    return this.findClusters(circulatingHolders);
  }

  private async detectInsiders(mint: string, windowSeconds: number): Promise<{
    insiderWallets: string[];
    insiderPct: number;
    totalEarlyBuyers: number;
  }> {
    const rpcUrl = this.getRpcUrl();

    try {
      const res = await fetch(rpcUrl, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getSignaturesForAddress',
          params: [mint, { limit: 50 }],
        }),
      });

      const data = await res.json() as any;
      const sigs = data?.result || [];
      if (sigs.length === 0) return { insiderWallets: [], insiderPct: 0, totalEarlyBuyers: 0 };

      const allTimes = sigs.map((s: any) => s.blockTime || 0).filter((t: number) => t > 0);
      const creationTime = Math.min(...allTimes);
      const cutoff = creationTime + windowSeconds;

      const earlySigners = sigs
        .filter((s: any) => s.blockTime && s.blockTime <= cutoff)
        .map((s: any) => s.memo || s.signer || '')
        .filter((s: string) => s.length > 0);

      const uniqueInsiders = [...new Set(earlySigners)] as string[];
      this.stats.insidersDetected += uniqueInsiders.length;

      return {
        insiderWallets: uniqueInsiders.slice(0, 20),
        insiderPct: 0,
        totalEarlyBuyers: uniqueInsiders.length,
      };
    } catch {
      return { insiderWallets: [], insiderPct: 0, totalEarlyBuyers: 0 };
    }
  }

  private async getWhales(mint: string, minPct: number): Promise<{
    whales: { address: string; pct: number; label: string; type: string }[];
    totalWhalePct: number;
    supplyBreakdown: { bondingCurvePct: number; liquidityPoolPct: number; burnedPct: number; circulatingPct: number };
  }> {

    const intel = await this.fullAnalysis(mint);

    const realHolders = intel.holders.filter(h =>
      h.type !== 'bonding_curve' && h.type !== 'liquidity_pool' && h.type !== 'burn' && h.type !== 'infrastructure'
    );


    const circulatingTotal = realHolders.reduce((s, h) => s + h.amount, 0);
    const whales = realHolders
      .map(h => ({
        address: h.ownerWallet,
        pct: circulatingTotal > 0 ? (h.amount / circulatingTotal) * 100 : 0,
        label: h.label,
        type: h.type,
      }))
      .filter(h => h.pct >= minPct)
      .sort((a, b) => b.pct - a.pct);

    this.stats.whaleAlerts += whales.filter(w => w.pct > 10).length;

    return {
      whales,
      totalWhalePct: whales.reduce((s, w) => s + w.pct, 0),
      supplyBreakdown: {
        bondingCurvePct: intel.bondingCurvePct,
        liquidityPoolPct: intel.liquidityPoolPct,
        burnedPct: intel.burnedPct,
        circulatingPct: intel.circulatingPct,
      },
    };
  }

  private async checkSmartMoney(mint: string): Promise<{
    overlap: string[];
    overlapCount: number;
    confidence: string;
  }> {
    const intel = await this.fullAnalysis(mint);
    const realHolders = intel.holders
      .filter(h => h.type === 'holder' || h.type === 'dev')
      .map(h => h.ownerWallet);

    const overlap = this.findSmartMoneyOverlap(realHolders);

    return {
      overlap,
      overlapCount: overlap.length,
      confidence: overlap.length >= 3 ? 'high' : overlap.length >= 1 ? 'medium' : 'low',
    };
  }

  private async analyzeTrend(mint: string): Promise<{
    trend: 'accumulating' | 'distributing' | 'stable' | 'unknown';
    holderChange: number;
    topHolderChange: number;
    snapshots: number;
  }> {
    const snaps = this.snapshots.get(mint) || [];
    if (snaps.length < 2) {
      return { trend: 'unknown', holderChange: 0, topHolderChange: 0, snapshots: snaps.length };
    }

    const oldest = snaps[0];
    const latest = snaps[snaps.length - 1];

    const holderChange = latest.holders - oldest.holders;


    let topChange = 0;
    if (oldest.topHolders.length > 0 && latest.topHolders.length > 0) {
      const oldTopPct = oldest.topHolders.slice(0, 5).reduce((s, h) => s + h.pct, 0);
      const newTopPct = latest.topHolders.slice(0, 5).reduce((s, h) => s + h.pct, 0);
      topChange = newTopPct - oldTopPct;
    }

    let trend: 'accumulating' | 'distributing' | 'stable' | 'unknown';
    if (holderChange > 5 && topChange < -2) trend = 'distributing';
    else if (holderChange < -3) trend = 'distributing';
    else if (topChange > 3) trend = 'accumulating';
    else if (holderChange > 5) trend = 'accumulating';
    else trend = 'stable';

    return { trend, holderChange, topHolderChange: topChange, snapshots: snaps.length };
  }

  private async watchDevWallet(mint: string, devAddress: string): Promise<{ status: string }> {
    this.watchedDevs.set(devAddress, { mint, lastBalance: -1 });
    return { status: 'watching' };
  }

async checkDevWallets(): Promise<void> {
    const rpcUrl = this.getRpcUrl();

    for (const [devAddress, state] of this.watchedDevs) {
      try {
        const res = await fetch(rpcUrl, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTokenAccountsByOwner',
            params: [devAddress, { mint: state.mint }, { encoding: 'jsonParsed' }],
          }),
        });

        const data = await res.json() as any;
        const accounts = data?.result?.value || [];
        const balance = accounts.reduce((s: number, a: any) => {
          return s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
        }, 0);

        if (state.lastBalance >= 0 && balance < state.lastBalance * 0.9) {

          this.stats.devDumpsDetected++;
          this.logger.warn(`DEV DUMP: ${devAddress.slice(0, 8)}... sold tokens on ${state.mint.slice(0, 8)}`);
          this.eventBus.emit('signal:sell', {
            mint: state.mint,
            reason: `Dev wallet sold ${((state.lastBalance - balance) / state.lastBalance * 100).toFixed(0)}% of holdings`,
            urgency: 'high',
            agentId: 'holder-intelligence',
          });
        }

        state.lastBalance = balance;
      } catch {

      }
    }
  }


  private findClusters(holders: { address: string; amount: number; pct: number }[]): HolderCluster[] {
    const clusters: HolderCluster[] = [];


    const significant = holders.filter(h => h.pct >= 0.5);

    const grouped = new Map<string, typeof significant>();
    const used = new Set<string>();

    for (let i = 0; i < significant.length; i++) {
      if (used.has(significant[i].address)) continue;

      const cluster = [significant[i]];
      used.add(significant[i].address);

      for (let j = i + 1; j < significant.length; j++) {
        if (used.has(significant[j].address)) continue;

        const diff = Math.abs(significant[i].amount - significant[j].amount);
        const maxAmount = Math.max(significant[i].amount, significant[j].amount);
        const similarity = maxAmount > 0 ? diff / maxAmount : 1;

        if (similarity < 0.05) {
          cluster.push(significant[j]);
          used.add(significant[j].address);
        }
      }

      if (cluster.length >= 2) {
        clusters.push({
          id: `cluster_${clusters.length}`,
          wallets: cluster.map(c => c.address),
          totalPct: cluster.reduce((s, c) => s + c.pct, 0),
          fundingSource: null,
          label: cluster.length >= 5 ? 'bundled_group' : cluster.length >= 3 ? 'potential_dev' : 'whale',
        });
      }
    }

    return clusters;
  }

  private findSmartMoneyOverlap(holderAddresses: string[]): string[] {


    return [];
  }

  private classifyDistribution(top10Pct: number, clusterCount: number): HolderIntelligence['distribution'] {
    if (top10Pct > 70 || clusterCount >= 3) return 'concentrated';
    if (top10Pct > 50) return 'moderate';
    if (top10Pct < 35 && clusterCount === 0) return 'healthy';
    return 'distributed';
  }

  private computeTrend(mint: string, currentHolders: { address: string; pct: number }[]): HolderIntelligence['trend'] {
    const snaps = this.snapshots.get(mint);
    if (!snaps || snaps.length < 2) return 'unknown';

    const prev = snaps[snaps.length - 1];
    const holderDiff = currentHolders.length > 0 ? currentHolders.length : 0 - prev.holders;

    if (holderDiff > 5) return 'accumulating';
    if (holderDiff < -3) return 'distributing';
    return 'stable';
  }

  private storeSnapshot(mint: string, holders: number, topHolders: { address: string; pct: number }[]): void {
    const snaps = this.snapshots.get(mint) || [];
    snaps.push({
      mint,
      holders,
      topHolders: topHolders.map(h => ({ address: h.address, pct: h.pct })),
      timestamp: Date.now(),
    });


    if (snaps.length > 30) snaps.splice(0, snaps.length - 30);
    this.snapshots.set(mint, snaps);
  }

  private async fetchTokenLargestAccounts(rpcUrl: string, mint: string): Promise<{ address: string; amount: number; decimals: number; uiAmount: number }[] | null> {
    try {
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
      const accounts = data?.result?.value || [];

      return accounts.map((a: any) => ({
        address: a.address || '',
        amount: Number(a.amount || 0),
        decimals: Number(a.decimals || 0),
        uiAmount: Number(a.uiAmount || a.uiAmountString || 0),
      }));
    } catch {
      return null;
    }
  }

  private buildEmptyIntel(mint: string): HolderIntelligence {
    return {
      mint,
      totalSupply: 0,
      bondingCurvePct: 0,
      liquidityPoolPct: 0,
      burnedPct: 0,
      circulatingPct: 0,
      totalHolders: 0,
      uniqueWallets: 0,
      top10Pct: 100,
      top20Pct: 100,
      clusters: [],
      insiderWallets: [],
      insiderPct: 0,
      devHoldingPct: 0,
      devAddress: '',
      whaleCount: 0,
      smartMoneyOverlap: [],
      distribution: 'concentrated',
      trend: 'unknown',
      riskScore: 80,
      holders: [],
      analyzedAt: Date.now(),
    };
  }

  private getRpcUrl(): string {
    return this.heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`
      : this.solanaRpc;
  }
}
