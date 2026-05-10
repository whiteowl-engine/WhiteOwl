import { PumpMonitorSkill } from './pump-monitor.ts';
import { TokenAnalyzerSkill } from './token-analyzer.ts';
import { ShitTraderSkill } from './shit-trader.ts';
import { PortfolioSkill } from './portfolio.ts';
import { WalletTrackerSkill } from './wallet-tracker.ts';
import { SocialMonitorSkill } from './social-monitor.ts';
import { GmgnSkill } from './gmgn.ts';
import { CopyTradeSkill } from './copy-trade.ts';
import { AlphaScannerSkill } from './alpha-scanner.ts';
import { AdvancedTraderSkill } from './advanced-trader.ts';
import { TokenSecuritySkill } from './token-security.ts';
import { CurveAnalyzerSkill } from './curve-analyzer.ts';
import { ExitOptimizerSkill } from './exit-optimizer.ts';
import { HolderIntelligenceSkill } from './holder-intelligence.ts';
import { VolumeDetectorSkill } from './volume-detector.ts';
import { BlockchainSkill } from './blockchain.ts';
import { AIMemorySkill } from './ai-memory.ts';
import { WebSearchSkill } from './web-search.ts';
import { SkillBuilderSkill } from './skill-builder.ts';
import { SkillHubSkill } from './skill-hub.ts';
import { ProjectsSkill } from './projects.ts';
import { WebIntelSkill } from './web-intel.ts';
import { ScreenshotSkill } from './screenshot.ts';
import { BrowserEyeSkill } from './browser-eye.ts';
import { InsightXSkill } from './insightx.ts';
import { TerminalSkill } from './terminal.ts';
import { BackgroundJobsSkill } from './background-jobs.ts';
import { NewsSearchSkill } from './news-search.ts';
import { AxiomApiSkill } from './axiom-api.ts';
import { AnnouncementSniperSkill } from './announcement-sniper.ts';
import { HyperliquidPerpSkill } from './hyperliquid-perp.ts';
import { PredictionPulseSkill } from './prediction-pulse.ts';
import { Skill } from '../types.ts';

export function getAllSkills(): Skill[] {
  return [
    new PumpMonitorSkill(),
    new TokenAnalyzerSkill(),
    new ShitTraderSkill(),
    new PortfolioSkill(),
    new WalletTrackerSkill(),
    new SocialMonitorSkill(),
    new GmgnSkill(),
    new CopyTradeSkill(),
    new AlphaScannerSkill(),
    new AdvancedTraderSkill(),
    new TokenSecuritySkill(),
    new CurveAnalyzerSkill(),
    new ExitOptimizerSkill(),
    new HolderIntelligenceSkill(),
    new VolumeDetectorSkill(),
    new BlockchainSkill(),
    new AIMemorySkill(),
    new WebSearchSkill(),
    new SkillBuilderSkill(),
    new SkillHubSkill(),
    new ProjectsSkill(),
    new WebIntelSkill(),
    new ScreenshotSkill(),
    new BrowserEyeSkill(),
    new InsightXSkill(),
    new TerminalSkill(),
    new BackgroundJobsSkill(),
    new NewsSearchSkill(),
    new AxiomApiSkill(),
    new AnnouncementSniperSkill(),
    new HyperliquidPerpSkill(),
    new PredictionPulseSkill(),
  ];
}

export {
  PumpMonitorSkill,
  TokenAnalyzerSkill,
  ShitTraderSkill,
  PortfolioSkill,
  WalletTrackerSkill,
  SocialMonitorSkill,
  GmgnSkill,
  CopyTradeSkill,
  AlphaScannerSkill,
  AdvancedTraderSkill,
  TokenSecuritySkill,
  CurveAnalyzerSkill,
  ExitOptimizerSkill,
  HolderIntelligenceSkill,
  VolumeDetectorSkill,
  BlockchainSkill,
  AIMemorySkill,
  WebSearchSkill,
  SkillBuilderSkill,
  SkillHubSkill,
  ProjectsSkill,
  WebIntelSkill,
  BrowserEyeSkill,
  InsightXSkill,
  TerminalSkill,
  AxiomApiSkill,
  AnnouncementSniperSkill,
  HyperliquidPerpSkill,
  PredictionPulseSkill,
};
