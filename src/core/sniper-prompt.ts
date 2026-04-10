
import { TrendContext } from './trend-context.ts';

export interface SniperState {
  walletBalance: number;
  openPositions: number;
  totalInvested: number;
  maxNewPosition: number;
  availableForTrading: number;
  consecutiveLosses: number;
  positions: Array<{
    mint: string;
    symbol: string;
    pnlPercent: number;
    holdMinutes: number;
    invested: number;
  }>;
}

export interface SniperStrategy {
  buyAmountSol: number;
  slippageBps: number;
  priorityFeeSol: number;
  maxConcurrentPositions: number;
  maxPortfolioPercent: number;
  minBalanceSol: number;
  stopLossPercent: number;
  takeProfitLevels: Array<{ at: number; sellPercent: number }>;
  trailingStopPercent: number;
  timeoutMinutes: number;
  minScore: number;
  narrativeBoost: number;
  newsBoost: number;
  blacklistPatterns: string[];
}

export function buildSniperSystemPrompt(strategy: SniperStrategy): string {
  const tp = strategy.takeProfitLevels
    .map(l => `${l.at}x→sell ${l.sellPercent}%`)
    .join(', ');

  return `You are a Solana pump.fun sniper bot. Make fast BUY/SELL/SKIP decisions.

RULES:
- Buy new tokens on pump.fun bonding curve (pre-graduation)
- Max ${strategy.maxConcurrentPositions} concurrent positions
- Max ${strategy.maxPortfolioPercent}% of balance per trade
- Stop if balance < ${strategy.minBalanceSol} SOL
- Stop-loss: -${strategy.stopLossPercent}%
- Take-profit: ${tp}
- Timeout: ${strategy.timeoutMinutes}min → force sell
- Blacklist: ${strategy.blacklistPatterns.join(', ')}
- Prefer tokens matching hot narratives (+${strategy.narrativeBoost} score)
- Prefer tokens with bullish news (+${strategy.newsBoost} score)
- Buy amount: ${strategy.buyAmountSol} SOL (hard minimum — do NOT go below this)
- Slippage: ${strategy.slippageBps} bps

OUTPUT FORMAT (strict):
BUY <mint> <sol_amount> <reason_10_words_max>
SELL <mint> <percent> <reason_10_words_max>
SKIP <reason_10_words_max>
WAIT (no action needed)

Only output ONE line. No explanation, no markdown, no code blocks.`;
}

export function buildSniperUserPrompt(
  state: SniperState,
  trendContext: TrendContext,
  candidates: Array<{
    mint: string;
    symbol: string;
    name: string;
    bondingProgress: number;
    mcap: number;
    holders: number;
    score: number;
    hasSocials: boolean;
    ageSeconds: number;
  }>,
  learningContext?: string,
): string {
  const parts: string[] = [];


  parts.push(`[WALLET] ${state.walletBalance.toFixed(3)} SOL | open: ${state.openPositions} | invested: ${state.totalInvested.toFixed(3)} | available: ${state.availableForTrading.toFixed(3)} | max_new: ${state.maxNewPosition.toFixed(3)}`);

  if (state.consecutiveLosses >= 2) {
    parts.push(`⚠️ ${state.consecutiveLosses} consecutive losses — trade cautiously`);
  }


  if (learningContext) {
    parts.push('\n' + learningContext);
  }


  if (state.positions.length > 0) {
    parts.push('\n[POSITIONS]');
    for (const p of state.positions) {
      const sign = p.pnlPercent >= 0 ? '+' : '';
      parts.push(`${p.symbol} ${p.mint.slice(0, 8)} | ${sign}${p.pnlPercent.toFixed(1)}% | ${p.holdMinutes}min | ${p.invested.toFixed(3)} SOL`);
    }
  }


  const trends = trendContext.buildPromptSection();
  if (trends) parts.push('\n' + trends);


  if (candidates.length > 0) {
    parts.push(`\n[CANDIDATES (${candidates.length})]`);
    for (const c of candidates) {
      const social = c.hasSocials ? '✓soc' : '✗soc';
      parts.push(`${c.symbol} ${c.mint.slice(0, 12)} | bc=${c.bondingProgress.toFixed(0)}% mc=$${c.mcap.toFixed(0)} h=${c.holders} score=${c.score} ${social} ${c.ageSeconds}s`);
    }
  } else {
    parts.push('\n[NO NEW CANDIDATES]');
  }

  return parts.join('\n');
}

export function parseSniperDecision(response: string): SniperDecision {
  const line = response.trim().split('\n')[0].trim();

  if (line.startsWith('BUY ')) {
    const parts = line.slice(4).trim().split(/\s+/);
    const mint = parts[0] || '';
    const amount = parseFloat(parts[1]) || 0;
    const reason = parts.slice(2).join(' ');
    if (mint && amount > 0) {
      return { action: 'buy', mint, amount, reason };
    }
  }

  if (line.startsWith('SELL ')) {
    const parts = line.slice(5).trim().split(/\s+/);
    const mint = parts[0] || '';
    const percent = parseFloat(parts[1]) || 100;
    const reason = parts.slice(2).join(' ');
    if (mint) {
      return { action: 'sell', mint, percent, reason };
    }
  }

  if (line.startsWith('SKIP')) {
    return { action: 'skip', reason: line.slice(4).trim() };
  }

  return { action: 'wait' };
}

export type SniperDecision =
  | { action: 'buy'; mint: string; amount: number; reason: string }
  | { action: 'sell'; mint: string; percent: number; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'wait' };
