
import {
  EventBusInterface, LoggerInterface, LLMProvider, LLMMessage,
  TradeIntent, SessionStats,
} from '../types.ts';
import { Memory } from '../memory/index.ts';
import { ContextualMemory } from '../memory/context.ts';
import { createLLMProvider } from '../llm/index.ts';

export interface TradeExplanation {
  intentId: string;
  mint: string;
  action: 'buy' | 'sell';
  factors: ExplanationFactor[];
  summary: string;
  confidence: number;
  timestamp: number;
}

export interface ExplanationFactor {
  name: string;
  value: string;
  impact: 'positive' | 'negative' | 'neutral';
  weight: number;
}

export class DecisionExplainer {
  private eventBus: EventBusInterface;
  private logger: LoggerInterface;
  private memory: Memory;
  private contextMemory: ContextualMemory;
  private explanations: TradeExplanation[] = [];
  private readonly MAX_EXPLANATIONS = 200;

  constructor(opts: {
    eventBus: EventBusInterface;
    logger: LoggerInterface;
    memory: Memory;
    contextMemory: ContextualMemory;
  }) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.memory = opts.memory;
    this.contextMemory = opts.contextMemory;
  }

  start(): void {
    this.eventBus.on('trade:intent', (intent) => {
      const explanation = this.explain(intent);
      this.explanations.push(explanation);
      if (this.explanations.length > this.MAX_EXPLANATIONS) {
        this.explanations = this.explanations.slice(-this.MAX_EXPLANATIONS);
      }
      this.logger.info(`[EXPLAIN] ${intent.action.toUpperCase()} ${intent.mint.slice(0, 8)}: ${explanation.summary}`);
    });


    this.eventBus.on('position:closed', (data) => {
      const isWin = data.pnl > 0;
      this.contextMemory.recordHourlyOutcome(data.pnl, isWin);


      const token = this.memory.getToken(data.mint);
      if (token) {
        const nameWords = token.name.toLowerCase().split(/\s+/);
        for (const word of nameWords) {
          if (word.length >= 3) {
            this.contextMemory.recordPattern(word, 'name', data.pnlPercent, isWin);
          }
        }


        if (token.dev) {
          this.contextMemory.recordDevLaunch(token.dev, {
            isRug: data.pnlPercent < -50,
            lifetimeMin: data.duration / 60_000,
            peakMcap: token.marketCap || 0,
          });
        }
      }
    });
  }

explain(intent: TradeIntent): TradeExplanation {
    const factors: ExplanationFactor[] = [];
    let confidence = 50;


    const analysis = this.memory.getAnalysis(intent.mint);
    if (analysis) {
      factors.push({
        name: 'Pipeline Score',
        value: `${analysis.score}/100`,
        impact: analysis.score >= 70 ? 'positive' : analysis.score >= 50 ? 'neutral' : 'negative',
        weight: 0.3,
      });
      confidence += (analysis.score - 50) * 0.3;

      factors.push({
        name: 'Recommendation',
        value: analysis.recommendation,
        impact: ['strong_buy', 'buy'].includes(analysis.recommendation) ? 'positive' : 'negative',
        weight: 0.2,
      });

      for (const sig of analysis.signals) {
        factors.push({
          name: 'Signal',
          value: sig,
          impact: sig.startsWith('good_') || sig.startsWith('high_') ? 'positive' : 'neutral',
          weight: 0.05,
        });
      }
    }


    const token = this.memory.getToken(intent.mint);
    if (token?.dev) {
      const devRep = this.contextMemory.getDevReputation(token.dev);
      if (devRep) {
        const repImpact = devRep.reputation === 'trusted' ? 'positive'
          : devRep.reputation === 'serial_rugger' ? 'negative'
          : 'neutral';
        factors.push({
          name: 'Dev Reputation',
          value: `${devRep.reputation} (${devRep.totalLaunches} launches, ${(devRep.rugRate * 100).toFixed(0)}% rug rate)`,
          impact: repImpact,
          weight: 0.2,
        });
        if (devRep.reputation === 'serial_rugger') confidence -= 30;
        else if (devRep.reputation === 'trusted') confidence += 15;
      }
    }


    const holders = this.memory.getHolderData(intent.mint);
    if (holders) {
      factors.push({
        name: 'Holders',
        value: `${holders.totalHolders} (top10: ${holders.top10Percent.toFixed(0)}%, bundled: ${holders.isBundled})`,
        impact: holders.isBundled ? 'negative' : holders.totalHolders > 50 ? 'positive' : 'neutral',
        weight: 0.15,
      });
      if (holders.isBundled) confidence -= 20;
    }


    factors.push({
      name: 'Position Size',
      value: `${intent.amountSol || 0} SOL`,
      impact: 'neutral',
      weight: 0.05,
    });


    if (intent.reason) {
      factors.push({
        name: 'Agent Reasoning',
        value: intent.reason,
        impact: 'neutral',
        weight: 0.05,
      });
    }

    confidence = Math.max(0, Math.min(100, Math.round(confidence)));

    const positiveCount = factors.filter(f => f.impact === 'positive').length;
    const negativeCount = factors.filter(f => f.impact === 'negative').length;

    const summary = `${intent.action.toUpperCase()} — confidence ${confidence}%, ` +
      `${positiveCount} positive / ${negativeCount} negative factors. ` +
      `${intent.reason?.slice(0, 100) || 'No reason provided'}`;

    return {
      intentId: intent.id,
      mint: intent.mint,
      action: intent.action,
      factors,
      summary,
      confidence,
      timestamp: Date.now(),
    };
  }

  getRecentExplanations(limit: number = 20): TradeExplanation[] {
    return this.explanations.slice(-limit);
  }

  getExplanation(intentId: string): TradeExplanation | undefined {
    return this.explanations.find(e => e.intentId === intentId);
  }
}


export class DailyReportGenerator {
  private memory: Memory;
  private contextMemory: ContextualMemory;
  private explainer: DecisionExplainer;
  private logger: LoggerInterface;
  private llm: LLMProvider | null = null;

  constructor(opts: {
    memory: Memory;
    contextMemory: ContextualMemory;
    explainer: DecisionExplainer;
    logger: LoggerInterface;
  }) {
    this.memory = opts.memory;
    this.contextMemory = opts.contextMemory;
    this.explainer = opts.explainer;
    this.logger = opts.logger;
  }

  setLLM(llm: LLMProvider): void {
    this.llm = llm;
  }

async generateReport(): Promise<string> {
    const stats24h = this.memory.getStats('24h');
    const stats7d = this.memory.getStats('7d');
    const recentTrades = this.memory.getTradeHistory({ limit: 50 });
    const bestHours = this.contextMemory.getBestTradingHours(3);
    const worstHours = this.contextMemory.getWorstTradingHours(3);
    const profitablePatterns = this.contextMemory.getProfitablePatterns('name', 2);
    const bestNarratives = this.contextMemory.getBestNarratives(5);
    const recentExplanations = this.explainer.getRecentExplanations(20);
    const learningStats = this.memory.getLearningStats(1);


    const dataContext = this.buildDataContext(
      stats24h, stats7d, recentTrades, bestHours, worstHours,
      profitablePatterns, bestNarratives, recentExplanations, learningStats,
    );


    if (this.llm) {
      try {
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: `You are a crypto trading analyst for an autonomous Solana memecoin trading bot.
Generate a daily strategic report based on the provided data. Include:
1. Performance Summary (P&L, win rate, key metrics)
2. What Worked (successful patterns, strategies, timing)
3. What Didn't Work (failed patterns, losses, mistakes)
4. Key Observations (market conditions, emerging narratives)
5. Recommendations for Tomorrow (adjust strategy, timing, risk)
Be concise, data-driven, and actionable. Use bullet points.`,
          },
          { role: 'user', content: dataContext },
        ];

        const response = await this.llm.chat(messages);
        return `# WhiteOwl Daily Report — ${new Date().toISOString().split('T')[0]}\n\n${response.content}\n\n---\n\n## Raw Data\n${dataContext}`;
      } catch (err: any) {
        this.logger.warn(`LLM report failed, using structured format: ${err.message}`);
      }
    }


    return this.buildStructuredReport(stats24h, stats7d, bestHours, profitablePatterns, bestNarratives, learningStats);
  }

  private buildDataContext(
    stats24h: SessionStats, stats7d: SessionStats,
    recentTrades: any[], bestHours: any[], worstHours: any[],
    patterns: any[], narratives: any[], explanations: any[], learning: any,
  ): string {
    const parts: string[] = [];

    parts.push(`[24h Performance]`);
    parts.push(`Trades: ${stats24h.tradesExecuted} (${stats24h.tradesWon}W / ${stats24h.tradesLost}L)`);
    parts.push(`Win Rate: ${stats24h.tradesExecuted > 0 ? ((stats24h.tradesWon / stats24h.tradesExecuted) * 100).toFixed(1) : 0}%`);
    parts.push(`P&L: ${stats24h.totalPnlSol.toFixed(4)} SOL`);
    parts.push(`Peak: ${stats24h.peakPnlSol.toFixed(4)} SOL | Drawdown: ${stats24h.worstDrawdownSol.toFixed(4)} SOL`);

    parts.push(`\n[7d Performance]`);
    parts.push(`Trades: ${stats7d.tradesExecuted} (${stats7d.tradesWon}W / ${stats7d.tradesLost}L)`);
    parts.push(`P&L: ${stats7d.totalPnlSol.toFixed(4)} SOL`);

    if (bestHours.length > 0) {
      parts.push(`\n[Best Trading Hours]`);
      for (const h of bestHours.slice(0, 3)) {
        parts.push(`  UTC ${h.hour}:00 Day${h.dayOfWeek}: ${(h.winRate * 100).toFixed(0)}% WR, avg ${h.avgPnl.toFixed(3)} SOL (${h.totalTrades} trades)`);
      }
    }

    if (worstHours.length > 0) {
      parts.push(`\n[Worst Trading Hours]`);
      for (const h of worstHours.slice(0, 3)) {
        parts.push(`  UTC ${h.hour}:00 Day${h.dayOfWeek}: ${(h.winRate * 100).toFixed(0)}% WR`);
      }
    }

    if (patterns.length > 0) {
      parts.push(`\n[Profitable Name Patterns]`);
      for (const p of patterns.slice(0, 5)) {
        parts.push(`  "${p.pattern}": ${(p.winRate * 100).toFixed(0)}% WR, avg ${p.avgPnl.toFixed(1)}%, ${p.occurrences} trades`);
      }
    }

    if (narratives.length > 0) {
      parts.push(`\n[Narrative Performance]`);
      for (const n of narratives) {
        parts.push(`  "${n.narrative}": ${n.wins}W/${n.losses}L, ${n.totalPnl.toFixed(3)} SOL`);
      }
    }

    if (learning.totalTrades > 0) {
      parts.push(`\n[Pipeline Learning]`);
      parts.push(`Total learned from: ${learning.totalTrades} trades, ${(learning.winRate * 100).toFixed(0)}% WR`);
      parts.push(`Reinforced signals: ${learning.winSignals.join(', ') || 'none'}`);
      parts.push(`Penalized signals: ${learning.loseSignals.join(', ') || 'none'}`);
    }

    if (explanations.length > 0) {
      parts.push(`\n[Recent Trade Explanations]`);
      for (const e of explanations.slice(-5)) {
        parts.push(`  ${e.action} ${e.mint.slice(0, 8)}: conf=${e.confidence}% — ${e.summary.slice(0, 100)}`);
      }
    }

    return parts.join('\n');
  }

  private buildStructuredReport(
    stats24h: SessionStats, stats7d: SessionStats,
    bestHours: any[], patterns: any[], narratives: any[], learning: any,
  ): string {
    const winRate24h = stats24h.tradesExecuted > 0
      ? ((stats24h.tradesWon / stats24h.tradesExecuted) * 100).toFixed(1) : '0';

    const parts = [
      `# WhiteOwl Daily Report — ${new Date().toISOString().split('T')[0]}`,
      '',
      '## Performance',
      `- 24h P&L: ${stats24h.totalPnlSol >= 0 ? '+' : ''}${stats24h.totalPnlSol.toFixed(4)} SOL`,
      `- 24h Trades: ${stats24h.tradesExecuted} (${stats24h.tradesWon}W / ${stats24h.tradesLost}L)`,
      `- 24h Win Rate: ${winRate24h}%`,
      `- 7d P&L: ${stats7d.totalPnlSol >= 0 ? '+' : ''}${stats7d.totalPnlSol.toFixed(4)} SOL`,
      '',
      '## Timing',
    ];

    if (bestHours.length > 0) {
      parts.push(`- Best: UTC ${bestHours[0].hour}:00 (${(bestHours[0].winRate * 100).toFixed(0)}% WR)`);
    }

    parts.push('', '## Patterns');
    if (patterns.length > 0) {
      for (const p of patterns.slice(0, 3)) {
        parts.push(`- "${p.pattern}" → ${(p.winRate * 100).toFixed(0)}% WR, avg ${p.avgPnl.toFixed(1)}%`);
      }
    } else {
      parts.push('- Insufficient data');
    }

    parts.push('', '## Narratives');
    if (narratives.length > 0) {
      for (const n of narratives.slice(0, 3)) {
        parts.push(`- "${n.narrative}" → ${n.totalPnl.toFixed(3)} SOL (${n.wins}W/${n.losses}L)`);
      }
    } else {
      parts.push('- No narrative data yet');
    }

    parts.push('', '## Self-Learning');
    if (learning.totalTrades >= 5) {
      parts.push(`- Analyzed ${learning.totalTrades} trades at ${(learning.winRate * 100).toFixed(0)}% WR`);
      parts.push(`- Reinforced: ${learning.winSignals.join(', ') || 'none'}`);
      parts.push(`- Penalized: ${learning.loseSignals.join(', ') || 'none'}`);
    } else {
      parts.push('- Need more data (min 5 trades)');
    }

    return parts.join('\n');
  }
}
