import { StrategyConfig, StrategyCondition, TokenInfo, TokenAnalysis, Position, LoggerInterface } from '../types.ts';

export class StrategyEngine {
  private strategies = new Map<string, StrategyConfig>();
  private activeStrategy: StrategyConfig | null = null;
  private logger: LoggerInterface;

  constructor(logger: LoggerInterface) {
    this.logger = logger;
  }

  register(strategy: StrategyConfig): void {
    this.strategies.set(strategy.name, strategy);
    this.logger.info(`Strategy registered: ${strategy.name}`);
  }

  setActive(name: string): boolean {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      this.logger.warn(`Strategy not found: ${name}`);
      return false;
    }
    this.activeStrategy = strategy;
    this.logger.info(`Active strategy: ${name}`);
    return true;
  }

  getActive(): StrategyConfig | null {
    return this.activeStrategy;
  }

  getAll(): StrategyConfig[] {
    return Array.from(this.strategies.values());
  }

  checkEntry(token: TokenInfo, analysis?: TokenAnalysis): {
    shouldBuy: boolean;
    amountSol: number;
    slippageBps: number;
    priorityFeeSol: number;
    reason: string;
  } {
    if (!this.activeStrategy) {
      return { shouldBuy: false, amountSol: 0, slippageBps: 0, priorityFeeSol: 0, reason: 'No active strategy' };
    }

    const ctx = this.buildContext(token, analysis);


    if (this.activeStrategy.filters) {
      const blacklistPatterns = this.activeStrategy.filters.blacklistPatterns || [];
      for (const pattern of blacklistPatterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(token.name) || regex.test(token.symbol)) {
          return { shouldBuy: false, amountSol: 0, slippageBps: 0, priorityFeeSol: 0, reason: `Blacklisted pattern: ${pattern}` };
        }
      }

      if (this.activeStrategy.filters.minScore && analysis) {
        if (analysis.score < this.activeStrategy.filters.minScore) {
          return { shouldBuy: false, amountSol: 0, slippageBps: 0, priorityFeeSol: 0, reason: `Score ${analysis.score} below min ${this.activeStrategy.filters.minScore}` };
        }
      }
    }


    const failedConditions: string[] = [];
    for (const condition of this.activeStrategy.entry.conditions) {
      if (!this.evaluateCondition(condition, ctx)) {
        failedConditions.push(`${condition.field} ${condition.operator} ${condition.value}`);
      }
    }

    if (failedConditions.length > 0) {
      return {
        shouldBuy: false,
        amountSol: 0,
        slippageBps: 0,
        priorityFeeSol: 0,
        reason: `Conditions not met: ${failedConditions.join(', ')}`,
      };
    }

    return {
      shouldBuy: true,
      ...this.activeStrategy.entry.buy,
      reason: 'All entry conditions met',
    };
  }

  checkExit(position: Position): {
    shouldSell: boolean;
    sellPercent: number;
    reason: string;
  } {
    if (!this.activeStrategy) {
      return { shouldSell: false, sellPercent: 0, reason: 'No active strategy' };
    }

    const exit = this.activeStrategy.exit;
    const pnlPercent = position.unrealizedPnlPercent;
    const multiplier = 1 + pnlPercent / 100;
    const holdTimeMinutes = (Date.now() - position.openedAt) / 60_000;


    if (pnlPercent <= -exit.stopLossPercent) {
      return {
        shouldSell: true,
        sellPercent: 100,
        reason: `Stop loss triggered: ${pnlPercent.toFixed(1)}% <= -${exit.stopLossPercent}%`,
      };
    }


    const sortedTP = [...exit.takeProfit].sort((a, b) => b.at - a.at);
    for (const tp of sortedTP) {
      if (multiplier >= tp.at) {
        return {
          shouldSell: true,
          sellPercent: tp.sellPercent,
          reason: `Take profit ${tp.at}x hit (current ${multiplier.toFixed(1)}x)`,
        };
      }
    }


    if (exit.timeoutMinutes && holdTimeMinutes >= exit.timeoutMinutes) {
      if (exit.timeoutAction === 'sell') {
        return {
          shouldSell: true,
          sellPercent: 100,
          reason: `Position timeout: held ${holdTimeMinutes.toFixed(0)}m >= ${exit.timeoutMinutes}m`,
        };
      }
    }

    return { shouldSell: false, sellPercent: 0, reason: '' };
  }

  private buildContext(token: TokenInfo, analysis?: TokenAnalysis): Record<string, any> {
    return {
      'token.name': token.name,
      'token.symbol': token.symbol,
      'token.age': (Date.now() - token.createdAt) / 1000,
      'token.mcap': token.marketCap,
      'token.volume': token.volume24h,
      'token.holders': token.holders,
      'token.price': token.price,
      'token.bondingProgress': token.bondingCurveProgress,
      'token.hasTwitter': !!token.twitter,
      'token.hasTelegram': !!token.telegram,
      'token.hasWebsite': !!token.website,
      'token.priceChange5m': token.priceChange5m || 0,
      ...(analysis ? {
        'analysis.score': analysis.score,
        'analysis.rugScore': analysis.rugScore,
        'analysis.recommendation': analysis.recommendation,
      } : {}),
    };
  }

  private evaluateCondition(condition: StrategyCondition, ctx: Record<string, any>): boolean {
    const actual = ctx[condition.field];
    if (actual === undefined) return false;

    const expected = condition.value;

    switch (condition.operator) {
      case '>': return actual > expected;
      case '<': return actual < expected;
      case '>=': return actual >= expected;
      case '<=': return actual <= expected;
      case '==': return actual == expected;
      case '!=': return actual != expected;
      case 'matches': return new RegExp(expected, 'i').test(String(actual));
      case 'in': return Array.isArray(expected) && expected.includes(actual);
      case 'not_in': return Array.isArray(expected) && !expected.includes(actual);
      default: return false;
    }
  }
}
