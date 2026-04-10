import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types.ts';

const INSIGHTX_BASE = 'https://api.insightx.network';
const NETWORK = 'sol';

const KNOWN_PROGRAMS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'PumpFunAMMVyBmGAKgG3ksqyzVPBaQ5MqMk5MtKoFPu',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  '11111111111111111111111111111111',
]);
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111',
  '1111111111111111111111111111111111111111111',
]);

export interface BotPatternResult {
  detected: boolean;
  confidence: number;
  uniformGroups: UniformGroup[];
  totalBotPct: number;
  totalBotWallets: number;
  summary: string;
}

export interface UniformGroup {
  pct: number;
  count: number;
  addresses: string[];
  deviation: number;
  totalPct: number;
}

export interface InsightXOverview {
  cluster_pct: number;
  snipers_pct: number;
  bundlers_pct: number;
  dev_pct: number;
  insiders_pct: number;
  top10_pct: number;
}

export interface InsightXDistribution {
  gini: number;
  hhi: number;
  nakamoto: number;
  top_10_holder_concentration: number;
}

export interface InsightXClusterAddress {
  address: string;
  balance: number;
  percentage: number;
  tags: string[];
}

export interface InsightXCluster {
  pct: number;
  tags: string[];
  cluster_addresses: InsightXClusterAddress[];
}

export interface InsightXClusters {
  total_cluster_pct: number;
  clusters: InsightXCluster[];
}

export interface InsightXSniper {
  address: string;
  balance: number;
  percentage: number;
}

export interface InsightXSnipers {
  total_sniper_pct: number;
  count: {
    total: number;
    sold_partially: number;
    sold_fully: number;
    bought_more: number;
  };
  snipers: InsightXSniper[];
}

export interface InsightXBundler {
  address: string;
  balance: number;
  percentage: number;
  reasons: string[] | null;
  slot: number | null;
}

export interface InsightXBundlers {
  total_bundlers_pct: number;
  bundlers: InsightXBundler[];
}

export interface InsightXInsider {
  address: string;
  balance: number;
  percentage: number;
}

export interface InsightXInsiders {
  total_insiders_pct: number;
  insiders: InsightXInsider[];
}

export interface InsightXScanResult {
  results?: {
    score?: number;
    advanced?: {
      honeypot?: { score: number; message: string };
      renounced?: boolean;
      mintable?: boolean;
      freezable?: boolean;
      drainable?: boolean;
      creator?: { address: string; balance: number };
      holder_count?: number;
      top_holders?: { address: string; token_account: string; balance: number }[];
      locked_liquidity_weighted?: number;
    };
  };
}

export interface InsightXFullAnalysis {
  mint: string;
  overview: InsightXOverview | null;
  distribution: InsightXDistribution | null;
  clusters: InsightXClusters | null;
  snipers: InsightXSnipers | null;
  bundlers: InsightXBundlers | null;
  insiders: InsightXInsiders | null;
  scanner: InsightXScanResult | null;
  botPattern: BotPatternResult;
  riskSummary: string;
  riskScore: number;
  fetchedAt: number;
}

export class InsightXClient {
  private apiKey: string;
  private logger: LoggerInterface;

  constructor(apiKey: string, logger: LoggerInterface) {
    this.apiKey = apiKey;
    this.logger = logger;
  }

  private async fetch<T>(path: string): Promise<T | null> {
    const url = `${INSIGHTX_BASE}${path}`;
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': this.apiKey },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          this.logger.warn(`InsightX rate limited on ${path}`);
        } else {
          this.logger.warn(`InsightX ${res.status} on ${path}`);
        }
        return null;
      }
      return await res.json() as T;
    } catch (err: any) {
      this.logger.error(`InsightX fetch error (${path}): ${err.message}`);
      return null;
    }
  }

  async getOverview(mint: string): Promise<InsightXOverview | null> {
    return this.fetch<InsightXOverview>(`/dex-metrics/v1/${NETWORK}/${mint}`);
  }

  async getDistribution(mint: string): Promise<InsightXDistribution | null> {
    return this.fetch<InsightXDistribution>(`/dex-metrics/v1/${NETWORK}/${mint}/distribution`);
  }

  async getClusters(mint: string): Promise<InsightXClusters | null> {
    return this.fetch<InsightXClusters>(`/dex-metrics/v1/${NETWORK}/${mint}/clusters`);
  }

  async getSnipers(mint: string): Promise<InsightXSnipers | null> {
    return this.fetch<InsightXSnipers>(`/dex-metrics/v1/${NETWORK}/${mint}/snipers`);
  }

  async getBundlers(mint: string): Promise<InsightXBundlers | null> {
    return this.fetch<InsightXBundlers>(`/dex-metrics/v1/${NETWORK}/${mint}/bundlers`);
  }

  async getInsiders(mint: string): Promise<InsightXInsiders | null> {
    return this.fetch<InsightXInsiders>(`/dex-metrics/v1/${NETWORK}/${mint}/insiders`);
  }

  async scanToken(mint: string): Promise<InsightXScanResult | null> {
    return this.fetch<InsightXScanResult>(`/scanner/v1/tokens/${NETWORK}/${mint}`);
  }

async fullAnalysis(mint: string): Promise<InsightXFullAnalysis> {
    const [overview, distribution, clusters, snipers, bundlers, insiders, scanner] = await Promise.all([
      this.getOverview(mint),
      this.getDistribution(mint),
      this.getClusters(mint),
      this.getSnipers(mint),
      this.getBundlers(mint),
      this.getInsiders(mint),
      this.scanToken(mint),
    ]);


    const botPattern = detectBotPattern(clusters, snipers, bundlers);
    const riskScore = computeRiskScore(overview, distribution, clusters, snipers, bundlers, insiders, scanner, botPattern);
    const riskSummary = buildRiskSummary(overview, distribution, clusters, snipers, bundlers, insiders, botPattern, riskScore);

    return {
      mint,
      overview,
      distribution,
      clusters,
      snipers,
      bundlers,
      insiders,
      scanner,
      botPattern,
      riskSummary,
      riskScore,
      fetchedAt: Date.now(),
    };
  }
}


const INX_PORTAL_BASE = 'https://app.insightx.network';
const KNOWN_INFRA_RE = /binance|okx|coinbase|bybit|bitget|revolut|moonpay|kraken|kucoin|gate\.io|huobi|mexc|raydium|jupiter|meteora|orca|pumpswap|phantom fee/i;

export interface BubblemapsResult {
  bundlerPct: number;
  bundlerCount: number;
  clusterPct: number;
  clusterCount: number;
  top10Pct: number;
  top10Holders: Array<{ address: string; pct: number }>;
  dexPct: number;
  holders: number;
  summary: string;
}

export async function fetchBubblemapsPortal(
  address: string,
  chain: string = 'solana',
  logger?: LoggerInterface,
): Promise<BubblemapsResult | null> {

  if (address.endsWith('pump')) {
    logger?.debug(`Bubblemaps: skipping pump.fun token ${address.slice(0, 12)}…`);
    return null;
  }
  try {
        const r = await fetch(`${INX_PORTAL_BASE}/api/portal/bubblemap/getBubblemap`, {
            method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Meta': 'MA==',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `${INX_PORTAL_BASE}/bubblemaps/${chain}/${address}`,
        'Origin': INX_PORTAL_BASE,
      },
      body: JSON.stringify({ searchAddress: address, chainId: chain, proxy: true, referrer: 'inx' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      logger?.warn(`Bubblemaps portal ${r.status} for ${address}`);
      return null;
    }
    const json = await r.json() as any;
    if (!json.data?.nodes) {
      logger?.debug(`Bubblemaps portal: no nodes for ${address} (status: ${json.status})`);
      return null;
    }
    const nodes: any[] = json.data.nodes;
    const links: any[] = json.data.links || [];
    const tokenLinks: any[] = json.data.token_links || [];


    const parent = nodes.map((_: any, i: number) => i);
    const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    const isVisible = (i: number) => {
      const n = nodes[i];
      return n && !n.is_contract && !n.is_exchange && !n.is_pair && !n.is_burn && !n.is_lock;
    };
    for (const link of links) {
      if (isVisible(link.source) && isVisible(link.target)) union(link.source, link.target);
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      if (!isVisible(i)) continue;
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(i);
    }
    let clusterCount = 0;
    let clusterPct = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      clusterCount++;
      clusterPct += members.reduce((s, i) => s + (nodes[i]?.percentage || 0), 0);
    }


    const isRealWallet = (i: number) => {
      const n = nodes[i];
      return n && !n.is_contract && !n.is_exchange && !n.is_pair && !n.is_burn && !n.is_lock && !KNOWN_INFRA_RE.test(n.name || '');
    };
    const fundedBy = new Map<number, Set<number>>();
    const processBundleLinks = (linkArr: any[]) => {
      for (const link of linkArr) {
        const src = nodes[link.source];
        if (!src || (!src.is_proxy && !src.name?.startsWith('Funding:'))) continue;
        if (!isRealWallet(link.target)) continue;
        if (!fundedBy.has(link.source)) fundedBy.set(link.source, new Set());
        fundedBy.get(link.source)!.add(link.target);
      }
    };
    processBundleLinks(links);
    for (const tl of tokenLinks) processBundleLinks(tl.links || []);

    let bundlerCount = 0;
    let bundlerPct = 0;
    for (const [srcIdx, targetSet] of fundedBy) {
      if (targetSet.size < 2) continue;
      if (KNOWN_INFRA_RE.test(nodes[srcIdx]?.name || '')) continue;
      bundlerCount++;
      bundlerPct += [...targetSet].reduce((s, i) => s + (nodes[i]?.percentage || 0), 0);
    }


    const visible = nodes.filter((n: any) => !n.is_pair && !n.is_burn && !n.is_lock);
    const holdersSorted = visible
      .filter((n: any) => !n.is_contract || n.is_team || n.is_presale)
      .sort((a: any, b: any) => b.percentage - a.percentage);
    const top10Slice = holdersSorted.slice(0, 10);
    const top10Pct = top10Slice.reduce((s: number, h: any) => s + h.percentage, 0);
    const top10Holders = top10Slice.map((h: any) => ({
      address: h.address ? `${h.address.slice(0, 4)}..${h.address.slice(-4)}` : '?',
      pct: Number(h.percentage?.toFixed(2) ?? 0),
    }));
    const dexPct = nodes.filter((n: any) => n.is_pair).reduce((s: number, n: any) => s + n.percentage, 0);

    const summary = `bundle=${bundlerCount}(${bundlerPct.toFixed(1)}%) cluster=${clusterCount}(${clusterPct.toFixed(1)}%) top10=${top10Pct.toFixed(1)}% dex=${dexPct.toFixed(1)}%`;

    return {
      bundlerPct: Number(bundlerPct.toFixed(2)),
      bundlerCount,
      clusterPct: Number(clusterPct.toFixed(2)),
      clusterCount,
      top10Pct: Number(top10Pct.toFixed(2)),
      top10Holders,
      dexPct: Number(dexPct.toFixed(2)),
      holders: visible.length,
      summary,
    };
  } catch (err: any) {
    logger?.debug(`Bubblemaps portal error: ${err.message}`);
    return null;
  }
}


export function detectBotPattern(
  clusters: InsightXClusters | null,
  snipers: InsightXSnipers | null,
  bundlers: InsightXBundlers | null,
): BotPatternResult {

  const holders: { address: string; pct: number }[] = [];


  if (clusters?.clusters) {
    for (const cluster of clusters.clusters) {
      for (const addr of cluster.cluster_addresses) {
        holders.push({ address: addr.address, pct: addr.percentage });
      }
    }
  }


  if (snipers?.snipers) {
    for (const s of snipers.snipers) {
      if (s.percentage > 0) {
        const existing = holders.find(h => h.address === s.address);
        if (!existing) {
          holders.push({ address: s.address, pct: s.percentage });
        }
      }
    }
  }


  if (bundlers?.bundlers) {
    for (const b of bundlers.bundlers) {
      if (b.percentage > 0) {
        const existing = holders.find(h => h.address === b.address);
        if (!existing) {
          holders.push({ address: b.address, pct: b.percentage });
        }
      }
    }
  }

  if (holders.length < 5) {
    return {
      detected: false,
      confidence: 0,
      uniformGroups: [],
      totalBotPct: 0,
      totalBotWallets: 0,
      summary: 'Not enough holder data to detect patterns',
    };
  }


  holders.sort((a, b) => b.pct - a.pct);


  const uniformGroups: UniformGroup[] = [];
  const TOLERANCE = 0.15;
  const MIN_GROUP_SIZE = 4;

  let i = 0;
  while (i < holders.length) {
    const group: typeof holders = [holders[i]];
    let j = i + 1;

    while (j < holders.length && Math.abs(holders[j].pct - holders[i].pct) <= TOLERANCE) {
      group.push(holders[j]);
      j++;
    }

    if (group.length >= MIN_GROUP_SIZE) {
      const pcts = group.map(g => g.pct);
      const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      const variance = pcts.reduce((s, p) => s + (p - mean) ** 2, 0) / pcts.length;
      const stdDev = Math.sqrt(variance);


      if (stdDev < 0.1) {
        uniformGroups.push({
          pct: Number(mean.toFixed(4)),
          count: group.length,
          addresses: group.map(g => g.address),
          deviation: Number(stdDev.toFixed(4)),
          totalPct: Number(pcts.reduce((a, b) => a + b, 0).toFixed(2)),
        });
      }
    }

    i = j > i + 1 ? j : i + 1;
  }


  const byPct = new Map<string, typeof holders>();
  for (const h of holders) {
    const key = h.pct.toFixed(2);
    if (!byPct.has(key)) byPct.set(key, []);
    byPct.get(key)!.push(h);
  }

  for (const [pctStr, group] of byPct) {
    if (group.length >= 3) {

      const alreadyCovered = uniformGroups.some(ug =>
        Math.abs(ug.pct - parseFloat(pctStr)) < 0.05 && ug.count >= group.length
      );
      if (!alreadyCovered) {
        uniformGroups.push({
          pct: parseFloat(pctStr),
          count: group.length,
          addresses: group.map(g => g.address),
          deviation: 0,
          totalPct: Number((group.length * parseFloat(pctStr)).toFixed(2)),
        });
      }
    }
  }

  const totalBotWallets = uniformGroups.reduce((s, g) => s + g.count, 0);
  const totalBotPct = Number(uniformGroups.reduce((s, g) => s + g.totalPct, 0).toFixed(2));


  let confidence = 0;
  if (uniformGroups.length > 0) {

    confidence = Math.min(90, totalBotWallets * 4);

    const avgDev = uniformGroups.reduce((s, g) => s + g.deviation, 0) / uniformGroups.length;
    if (avgDev < 0.02) confidence = Math.min(98, confidence + 20);

    if (totalBotPct > 20) confidence = Math.min(98, confidence + 15);
    if (totalBotPct > 40) confidence = Math.min(99, confidence + 10);
  }

  const detected = confidence >= 40;

  let summary = '';
  if (!detected) {
    summary = 'No significant bot/MM pattern detected in holder distribution';
  } else {
    const parts: string[] = [];
    for (const g of uniformGroups) {
      parts.push(`${g.count} wallets @ ~${g.pct.toFixed(2)}% each (total ${g.totalPct}%, σ=${g.deviation.toFixed(3)})`);
    }
    summary = `🤖 Bot/MM detected (${confidence}% conf): ${totalBotWallets} wallets hold ${totalBotPct}% of supply with uniform distribution.\n` +
      `Groups: ${parts.join('; ')}`;
  }

  return { detected, confidence, uniformGroups, totalBotPct, totalBotWallets, summary };
}


function computeRiskScore(
  overview: InsightXOverview | null,
  distribution: InsightXDistribution | null,
  clusters: InsightXClusters | null,
  snipers: InsightXSnipers | null,
  bundlers: InsightXBundlers | null,
  insiders: InsightXInsiders | null,
  scanner: InsightXScanResult | null,
  botPattern: BotPatternResult,
): number {
  let risk = 20;


  if (overview) {
    if (overview.cluster_pct > 50) risk += 25;
    else if (overview.cluster_pct > 30) risk += 15;
    else if (overview.cluster_pct > 15) risk += 8;

    if (overview.snipers_pct > 15) risk += 15;
    else if (overview.snipers_pct > 8) risk += 8;

    if (overview.bundlers_pct > 10) risk += 15;
    else if (overview.bundlers_pct > 5) risk += 8;

    if (overview.insiders_pct > 10) risk += 15;
    else if (overview.insiders_pct > 5) risk += 8;

    if (overview.top10_pct > 70) risk += 20;
    else if (overview.top10_pct > 50) risk += 10;
  }


  if (distribution) {
    if (distribution.gini > 0.9) risk += 15;
    else if (distribution.gini > 0.8) risk += 8;

    if (distribution.nakamoto <= 2) risk += 20;
    else if (distribution.nakamoto <= 5) risk += 10;

    if (distribution.hhi > 0.15) risk += 15;
    else if (distribution.hhi > 0.05) risk += 5;
  }


  if (botPattern.detected) {
    risk += Math.min(25, Math.round(botPattern.confidence * 0.25));
  }


  if (scanner?.results?.advanced) {
    const adv = scanner.results.advanced;
    if (adv.honeypot && adv.honeypot.score > 50) risk += 30;
    if (adv.mintable) risk += 10;
    if (adv.freezable) risk += 10;
    if (adv.drainable) risk += 20;
  }

  return Math.min(100, Math.max(0, risk));
}


function buildRiskSummary(
  overview: InsightXOverview | null,
  distribution: InsightXDistribution | null,
  clusters: InsightXClusters | null,
  snipers: InsightXSnipers | null,
  bundlers: InsightXBundlers | null,
  insiders: InsightXInsiders | null,
  botPattern: BotPatternResult,
  riskScore: number,
): string {
  const lines: string[] = [];
  const level = riskScore >= 70 ? '🔴 HIGH RISK' : riskScore >= 45 ? '🟡 MEDIUM RISK' : '🟢 LOW RISK';
  lines.push(`${level} (score: ${riskScore}/100)`);

  if (overview) {
    lines.push(`Clusters: ${overview.cluster_pct}% | Snipers: ${overview.snipers_pct}% | Bundlers: ${overview.bundlers_pct}%`);
    lines.push(`Insiders: ${overview.insiders_pct}% | Dev: ${overview.dev_pct}% | Top10: ${overview.top10_pct}%`);
  }

  if (distribution) {
    lines.push(`Gini: ${distribution.gini.toFixed(2)} | HHI: ${distribution.hhi.toFixed(3)} | Nakamoto: ${distribution.nakamoto} | Top10 conc: ${distribution.top_10_holder_concentration}%`);
  }

  if (clusters && clusters.clusters.length > 0) {
    lines.push(`${clusters.clusters.length} cluster(s), total ${clusters.total_cluster_pct}% of supply`);
    for (const c of clusters.clusters.slice(0, 3)) {
      const tags = c.tags.filter(t => t !== 'wallet').join(', ') || 'linked wallets';
      lines.push(`  ├ Cluster ${c.pct}%: ${c.cluster_addresses.length} wallets [${tags}]`);
    }
  }

  if (snipers && snipers.count.total > 0) {
    lines.push(`Snipers: ${snipers.count.total} detected, ${snipers.count.sold_fully} exited, ${snipers.count.bought_more} accumulated`);
  }

  if (bundlers && bundlers.bundlers.length > 0) {
    lines.push(`Bundlers: ${bundlers.bundlers.length} wallets, total ${bundlers.total_bundlers_pct}%`);
  }

  if (insiders && insiders.insiders.length > 0) {
    lines.push(`Insiders: ${insiders.insiders.length} wallets, total ${insiders.total_insiders_pct}%`);
  }

  if (botPattern.detected) {
    lines.push(botPattern.summary);
  }

  return lines.join('\n');
}


export function detectBotPatternFromHolders(
  holders: { address: string; pct: number }[],
): BotPatternResult {
  if (holders.length < 5) {
    return {
      detected: false,
      confidence: 0,
      uniformGroups: [],
      totalBotPct: 0,
      totalBotWallets: 0,
      summary: 'Not enough holder data to detect patterns',
    };
  }

  const sorted = [...holders].sort((a, b) => b.pct - a.pct);
  const uniformGroups: UniformGroup[] = [];
  const TOLERANCE = 0.15;
  const MIN_GROUP_SIZE = 4;

  let i = 0;
  while (i < sorted.length) {
    const group: typeof sorted = [sorted[i]];
    let j = i + 1;
    while (j < sorted.length && Math.abs(sorted[j].pct - sorted[i].pct) <= TOLERANCE) {
      group.push(sorted[j]);
      j++;
    }
    if (group.length >= MIN_GROUP_SIZE) {
      const pcts = group.map(g => g.pct);
      const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
      const variance = pcts.reduce((s, p) => s + (p - mean) ** 2, 0) / pcts.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev < 0.1) {
        uniformGroups.push({
          pct: Number(mean.toFixed(4)),
          count: group.length,
          addresses: group.map(g => g.address),
          deviation: Number(stdDev.toFixed(4)),
          totalPct: Number(pcts.reduce((a, b) => a + b, 0).toFixed(2)),
        });
      }
    }
    i = j > i + 1 ? j : i + 1;
  }


  const byPct = new Map<string, typeof sorted>();
  for (const h of sorted) {
    const key = h.pct.toFixed(2);
    if (!byPct.has(key)) byPct.set(key, []);
    byPct.get(key)!.push(h);
  }
  for (const [pctStr, group] of byPct) {
    if (group.length >= 3) {
      const alreadyCovered = uniformGroups.some(ug =>
        Math.abs(ug.pct - parseFloat(pctStr)) < 0.05 && ug.count >= group.length
      );
      if (!alreadyCovered) {
        uniformGroups.push({
          pct: parseFloat(pctStr),
          count: group.length,
          addresses: group.map(g => g.address),
          deviation: 0,
          totalPct: Number((group.length * parseFloat(pctStr)).toFixed(2)),
        });
      }
    }
  }

  const totalBotWallets = uniformGroups.reduce((s, g) => s + g.count, 0);
  const totalBotPct = Number(uniformGroups.reduce((s, g) => s + g.totalPct, 0).toFixed(2));

  let confidence = 0;
  if (uniformGroups.length > 0) {
    confidence = Math.min(90, totalBotWallets * 4);
    const avgDev = uniformGroups.reduce((s, g) => s + g.deviation, 0) / uniformGroups.length;
    if (avgDev < 0.02) confidence = Math.min(98, confidence + 20);
    if (totalBotPct > 20) confidence = Math.min(98, confidence + 15);
    if (totalBotPct > 40) confidence = Math.min(99, confidence + 10);
  }

  const detected = confidence >= 40;
  let summary = '';
  if (!detected) {
    summary = 'No significant bot/MM pattern detected in holder distribution';
  } else {
    const parts: string[] = [];
    for (const g of uniformGroups) {
      parts.push(`${g.count} wallets @ ~${g.pct.toFixed(2)}% each (total ${g.totalPct}%, σ=${g.deviation.toFixed(3)})`);
    }
    summary = `🤖 Bot/MM detected (${confidence}% conf): ${totalBotWallets} wallets hold ${totalBotPct}% of supply with uniform distribution.\n` +
      `Groups: ${parts.join('; ')}`;
  }

  return { detected, confidence, uniformGroups, totalBotPct, totalBotWallets, summary };
}


export function computeDistributionMetrics(
  holders: { address: string; pct: number }[],
): InsightXDistribution {
  if (holders.length === 0) {
    return { gini: 0, hhi: 0, nakamoto: 0, top_10_holder_concentration: 0 };
  }

  const sorted = [...holders].sort((a, b) => a.pct - b.pct);
  const n = sorted.length;
  const totalPct = sorted.reduce((s, h) => s + h.pct, 0);


  let giniSum = 0;
  for (let i = 0; i < n; i++) {
    giniSum += (2 * (i + 1) - n - 1) * sorted[i].pct;
  }
  const gini = totalPct > 0 ? giniSum / (n * totalPct) : 0;


  const hhi = sorted.reduce((s, h) => {
    const share = totalPct > 0 ? h.pct / totalPct : 0;
    return s + share * share;
  }, 0);


  const descending = [...holders].sort((a, b) => b.pct - a.pct);
  let cumulative = 0;
  let nakamoto = 0;
  for (const h of descending) {
    cumulative += h.pct;
    nakamoto++;
    if (cumulative > totalPct / 2) break;
  }


  const top10pct = descending.slice(0, 10).reduce((s, h) => s + h.pct, 0);

  return {
    gini: Number(gini.toFixed(4)),
    hhi: Number(hhi.toFixed(6)),
    nakamoto,
    top_10_holder_concentration: Number(top10pct.toFixed(2)),
  };
}


export class RpcHolderAnalyzer {
  private rpcUrl: string;
  private logger: LoggerInterface;

  constructor(rpcUrl: string, logger: LoggerInterface) {
    this.rpcUrl = rpcUrl;
    this.logger = logger;
  }

  private async rpcCall(method: string, params: any[]): Promise<any> {
    const res = await fetch(this.rpcUrl, {
            method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json() as any;
    if (data.error) {
      this.logger.warn(`RPC error (${method}): ${JSON.stringify(data.error)}`);
      return null;
    }
    return data.result;
  }

async getHolders(mint: string): Promise<{ address: string; pct: number; amount: number }[]> {

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      this.logger.warn(`[RPC] Invalid mint address: ${mint.slice(0, 20)}`);
      return [];
    }

    const result = await this.rpcCall('getTokenLargestAccounts', [mint]);
    const accounts = result?.value || [];
    if (accounts.length === 0) return [];


    const ataAddresses = accounts.map((a: any) => a.address);
    const resolved = await this.rpcCall('getMultipleAccounts', [ataAddresses, { encoding: 'jsonParsed' }]);
    const accountInfos = resolved?.value || [];

    const totalSupply = accounts.reduce((s: number, a: any) => s + parseFloat(a.uiAmount || a.amount || 0), 0);
    const holders: { address: string; pct: number; amount: number; owner: string }[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const acct = accounts[i];
      const info = accountInfos[i];
      const uiAmount = parseFloat(acct.uiAmount ?? acct.amount ?? 0);

      let ownerWallet = acct.address;
      let programOwner = '';
      if (info) {
        const val = info.value || info;
        programOwner = val?.owner || '';
        const parsed = val?.data?.parsed;
        if (parsed?.type === 'account' && parsed?.info?.owner) {
          ownerWallet = parsed.info.owner;
        }
      }


      if (KNOWN_PROGRAMS.has(programOwner) || KNOWN_PROGRAMS.has(ownerWallet)) continue;

      if (BURN_ADDRESSES.has(ownerWallet)) continue;

      holders.push({
        address: ownerWallet,
        amount: uiAmount,
        pct: totalSupply > 0 ? (uiAmount / totalSupply) * 100 : 0,
        owner: programOwner,
      });
    }


    const byWallet = new Map<string, { address: string; pct: number; amount: number }>();
    for (const h of holders) {
      const existing = byWallet.get(h.address);
      if (existing) {
        existing.pct += h.pct;
        existing.amount += h.amount;
      } else {
        byWallet.set(h.address, { address: h.address, pct: h.pct, amount: h.amount });
      }
    }

    return [...byWallet.values()].sort((a, b) => b.pct - a.pct);
  }

findClusters(holders: { address: string; pct: number; amount: number }[]): InsightXClusters {
    const significant = holders.filter(h => h.pct >= 0.3);
    const clusters: InsightXCluster[] = [];
    const used = new Set<string>();

    for (let i = 0; i < significant.length; i++) {
      if (used.has(significant[i].address)) continue;
      const group = [significant[i]];
      used.add(significant[i].address);

      for (let j = i + 1; j < significant.length; j++) {
        if (used.has(significant[j].address)) continue;
        const diff = Math.abs(significant[i].amount - significant[j].amount);
        const maxAmount = Math.max(significant[i].amount, significant[j].amount);
        if (maxAmount > 0 && diff / maxAmount < 0.05) {
          group.push(significant[j]);
          used.add(significant[j].address);
        }
      }

      if (group.length >= 2) {
        const clusterPct = group.reduce((s, g) => s + g.pct, 0);
        clusters.push({
          pct: Number(clusterPct.toFixed(2)),
          tags: group.length >= 5 ? ['bot_cluster'] : group.length >= 3 ? ['linked_wallets'] : ['pair'],
          cluster_addresses: group.map(g => ({
            address: g.address,
            balance: g.amount,
            percentage: g.pct,
            tags: [],
          })),
        });
      }
    }

    return {
      total_cluster_pct: Number(clusters.reduce((s, c) => s + c.pct, 0).toFixed(2)),
      clusters,
    };
  }

async fullAnalysis(mint: string): Promise<InsightXFullAnalysis> {
    const holders = await this.getHolders(mint);


    const distribution = computeDistributionMetrics(holders);
    const clusters = this.findClusters(holders as any);
    const botPattern = detectBotPatternFromHolders(holders);


    const top10pct = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
    const overview: InsightXOverview = {
      cluster_pct: clusters.total_cluster_pct,
      snipers_pct: 0,
      bundlers_pct: 0,
      dev_pct: 0,
      insiders_pct: 0,
      top10_pct: Number(top10pct.toFixed(2)),
    };

    const riskScore = computeRiskScore(overview, distribution, clusters, null, null, null, null, botPattern);
    const riskSummary = buildRiskSummary(overview, distribution, clusters, null, null, null, botPattern, riskScore);

    return {
      mint,
      overview,
      distribution,
      clusters,
      snipers: null,
      bundlers: null,
      insiders: null,
      scanner: null,
      botPattern,
      riskSummary: '[RPC mode — no InsightX API key]\n' + riskSummary,
      riskScore,
      fetchedAt: Date.now(),
    };
  }
}


export class InsightXSkill implements Skill {
  manifest: SkillManifest = {
    name: 'insightx',
    version: '2.0.0',
    description: 'Holder analysis: clusters, snipers, bundlers, insiders, distribution metrics, bot/MM pattern detection, security scanning. Uses InsightX API when key available, falls back to Solana RPC otherwise (free, no key needed).',
    tools: [
      {
        name: 'insightx_analyze',
        description: 'Full InsightX analysis for a Solana token: clusters, snipers, bundlers, insiders, distribution metrics (Gini/HHI/Nakamoto), bot/market-maker pattern detection, security scan. Returns comprehensive risk assessment.',
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
        name: 'insightx_clusters',
        description: 'Get cluster analysis from InsightX — groups of related wallets controlled by the same entity. Reveals hidden concentration, volume bots, team wallets, funding relationships.',
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
        name: 'insightx_snipers',
        description: 'Get sniper analysis — wallets that bought within first 3 slots of trading. Shows how many exited vs accumulated.',
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
        name: 'insightx_bundlers',
        description: 'Get bundler analysis — wallets doing coordinated multi-wallet swaps in single transactions to disguise accumulation.',
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
        name: 'insightx_bot_detect',
        description: 'Detect bot/market-maker patterns: finds groups of wallets holding nearly identical % of supply (uniform distribution that humans cannot produce). Identifies automated buying.',
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
        name: 'insightx_distribution',
        description: 'Get holder distribution metrics: Gini coefficient, HHI (Herfindahl-Hirschman), Nakamoto coefficient, top-10 concentration. Statistical measures of holder concentration.',
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
        name: 'insightx_scan',
        description: 'Security scan via InsightX: honeypot detection, authority checks (renounced, mintable, freezable, drainable), LP lock status, creator balance.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private ctx!: SkillContext;
  private client: InsightXClient | null = null;
  private rpcAnalyzer: RpcHolderAnalyzer | null = null;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    const apiKey = process.env.INSIGHTX_API_KEY || ctx.config?.insightxApiKey || '';
    if (apiKey) {
      this.client = new InsightXClient(apiKey, ctx.logger);
      ctx.logger.info('InsightX skill initialized with API key');
    } else {
      ctx.logger.info('InsightX skill: no API key — using Solana RPC fallback (free)');
    }

    const rpcUrl = ctx.config?.rpc?.helius || ctx.config?.rpc?.solana || 'https://api.mainnet-beta.solana.com';
    this.rpcAnalyzer = new RpcHolderAnalyzer(rpcUrl, ctx.logger);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    const mint = params.mint;
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return { error: 'Invalid mint address' };
    }


    if (this.client) {
      switch (tool) {
        case 'insightx_analyze':
          return this.client.fullAnalysis(mint);
        case 'insightx_clusters':
          return this.client.getClusters(mint);
        case 'insightx_snipers':
          return this.client.getSnipers(mint);
        case 'insightx_bundlers':
          return this.client.getBundlers(mint);
        case 'insightx_bot_detect': {
          const [clusters, snipers, bundlers] = await Promise.all([
            this.client.getClusters(mint),
            this.client.getSnipers(mint),
            this.client.getBundlers(mint),
          ]);
          return detectBotPattern(clusters, snipers, bundlers);
        }
        case 'insightx_distribution':
          return this.client.getDistribution(mint);
        case 'insightx_scan':
          return this.client.scanToken(mint);
        default:
          return { error: `Unknown tool: ${tool}` };
      }
    }


    if (!this.rpcAnalyzer) {
      return { error: 'No RPC or API key configured' };
    }

    switch (tool) {
      case 'insightx_analyze':
        return this.rpcAnalyzer.fullAnalysis(mint);

      case 'insightx_clusters': {
        const holders = await this.rpcAnalyzer.getHolders(mint);
        return this.rpcAnalyzer.findClusters(holders as any);
      }

      case 'insightx_bot_detect': {
        const holders = await this.rpcAnalyzer.getHolders(mint);
        return detectBotPatternFromHolders(holders);
      }

      case 'insightx_distribution': {
        const holders = await this.rpcAnalyzer.getHolders(mint);
        return computeDistributionMetrics(holders);
      }

      case 'insightx_top_holders': {
        const holders = await this.rpcAnalyzer.getHolders(mint);
        return { holders: holders.slice(0, 10) };
      }

      case 'insightx_snipers':
        return { note: 'Sniper detection requires InsightX API key. Set INSIGHTX_API_KEY for this feature.', total_sniper_pct: 0, count: { total: 0, sold_partially: 0, sold_fully: 0, bought_more: 0 }, snipers: [] };

      case 'insightx_bundlers': {

        const bm = await fetchBubblemapsPortal(mint, 'solana', this.ctx.logger);
        if (bm) {
          return { total_bundlers_pct: bm.bundlerPct, bundlers: [], _source: 'bubblemaps', bundlerCount: bm.bundlerCount, summary: bm.summary, top10Holders: bm.top10Holders };
        }

        let top10Holders: Array<{ address: string; pct: number }> = [];
        if (this.rpcAnalyzer) {
          try {
            const holders = await this.rpcAnalyzer.getHolders(mint);
            top10Holders = holders.slice(0, 10).map(h => ({
              address: `${h.address.slice(0, 4)}..${h.address.slice(-4)}`,
              pct: Number(h.pct.toFixed(2)),
            }));
          } catch {}
        }
        return { note: 'Bundler detection requires InsightX API key. Set INSIGHTX_API_KEY for this feature.', total_bundlers_pct: 0, bundlers: [], top10Holders };
      }

      case 'insightx_scan':
        return { note: 'Security scan requires InsightX API key. Set INSIGHTX_API_KEY for this feature.' };

      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}
}
