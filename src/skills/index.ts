import { PumpMonitorSkill } from './pump-monitor';
import { TokenAnalyzerSkill } from './token-analyzer';
import { PumpTraderSkill } from './pump-trader';
import { PortfolioSkill } from './portfolio';
import { WalletTrackerSkill } from './wallet-tracker';
import { SocialMonitorSkill } from './social-monitor';
import { DexScreenerSkill } from './dex-screener';
import { CopyTradeSkill } from './copy-trade';
import { FastSniperSkill } from './fast-sniper';
import { TrendSniperSkill } from './trend-sniper';
import { AlphaScannerSkill } from './alpha-scanner';
import { AdvancedTraderSkill } from './advanced-trader';
import { TokenSecuritySkill } from './token-security';
import { CurveAnalyzerSkill } from './curve-analyzer';
import { ExitOptimizerSkill } from './exit-optimizer';
import { HolderIntelligenceSkill } from './holder-intelligence';
import { VolumeDetectorSkill } from './volume-detector';
import { BlockchainSkill } from './blockchain';
import { AIMemorySkill } from './ai-memory';
import { WebSearchSkill } from './web-search';
import { SkillBuilderSkill } from './skill-builder';
import { SkillHubSkill } from './skill-hub';
import { ProjectsSkill } from './projects';
import { Skill } from '../types';

export function getAllSkills(): Skill[] {
  return [
    new PumpMonitorSkill(),
    new TokenAnalyzerSkill(),
    new PumpTraderSkill(),
    new PortfolioSkill(),
    new WalletTrackerSkill(),
    new SocialMonitorSkill(),
    new DexScreenerSkill(),
    new CopyTradeSkill(),
    new FastSniperSkill(),
    new TrendSniperSkill(),
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
  ];
}

export {
  PumpMonitorSkill,
  TokenAnalyzerSkill,
  PumpTraderSkill,
  PortfolioSkill,
  WalletTrackerSkill,
  SocialMonitorSkill,
  DexScreenerSkill,
  CopyTradeSkill,
  FastSniperSkill,
  TrendSniperSkill,
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
};
