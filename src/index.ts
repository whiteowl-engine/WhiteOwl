#!/usr/bin/env node

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, loadStrategy } from './config';
import { Runtime } from './runtime';
import { createAPIServer } from './api/server';
import { Logger } from './logger';
import { OAuthManager } from './core/oauth-manager';
import { setOAuthManager } from './llm/providers';
import { initDatabaseEngine } from './memory';

const logger = new Logger();

const BANNER = `
  █████╗ ██╗  ██╗██╗ ██████╗ ███╗   ███╗
 ██╔══██╗╚██╗██╔╝██║██╔═══██╗████╗ ████║
 ███████║ ╚███╔╝ ██║██║   ██║██╔████╔██║
 ██╔══██║ ██╔██╗ ██║██║   ██║██║╚██╔╝██║
 ██║  ██║██╔╝ ██╗██║╚██████╔╝██║ ╚═╝ ██║
 ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝     ╚═╝
  AI Trading Shell for Solana Memecoins
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'interactive';

  // Pre-initialize OAuth manager so config can detect OAuth-based providers
  const oauthManager = new OAuthManager('./data', logger);
  setOAuthManager(oauthManager);

  // Load config
  const configPath = args.find(a => a.startsWith('--config='))?.split('=')[1];
  const config = loadConfig(configPath);

  // Load strategies from ./strategies/ directory
  const strategiesDir = path.resolve('./strategies');

  // Initialize WASM SQLite engine before creating runtime
  await initDatabaseEngine();

  const runtime = new Runtime(config);

  if (fs.existsSync(strategiesDir)) {
    const files = fs.readdirSync(strategiesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const strategy = loadStrategy(path.join(strategiesDir, file));
        runtime.registerStrategy(strategy);
      } catch (err) {
        logger.warn(`Failed to load strategy ${file}: ${err}`);
      }
    }
  }

  await runtime.boot();

  // Start API server
  const api = createAPIServer(runtime, config.api.port, logger, config.api.key);
  api.start();

  // Handle process signals
  const shutdown = async () => {
    logger.info('Received shutdown signal...');
    await runtime.shutdown();
    api.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  switch (command) {
    case 'monitor':
      await runMonitor(runtime, args);
      break;

    case 'autopilot':
      await runAutopilot(runtime, args);
      break;

    case 'report':
      await runReport(runtime);
      break;

    case 'interactive':
    default:
      await runInteractive(runtime);
      break;
  }
}

async function runMonitor(runtime: Runtime, args: string[]) {
  const strategy = args.find(a => a.startsWith('--strategy='))?.split('=')[1];
  const duration = Number(args.find(a => a.startsWith('--duration='))?.split('=')[1] || '0');

  logger.info('Starting in MONITOR mode (read-only, no trades)...');

  await runtime.startSession({
    mode: 'monitor',
    strategy,
    durationMinutes: duration || undefined,
    reportIntervalMinutes: 30,
  });

  // Keep alive — reports printed via scheduler
  await new Promise(() => {});
}

async function runAutopilot(runtime: Runtime, args: string[]) {
  const strategy = args.find(a => a.startsWith('--strategy='))?.split('=')[1];
  const duration = Number(args.find(a => a.startsWith('--duration='))?.split('=')[1] || '1440');

  const balance = await runtime.getWallet().getBalance().catch(() => 0);

  logger.info('Starting in AUTOPILOT mode...');
  logger.info(`Wallet: ${runtime.getWallet().getAddress()}`);
  logger.info(`Balance: ${balance.toFixed(4)} SOL`);

  if (balance < 0.05) {
    logger.warn('Low wallet balance. Fund your wallet before trading.');
  }

  await runtime.startSession({
    mode: 'autopilot',
    strategy,
    durationMinutes: duration,
    reportIntervalMinutes: 15,
  });

  // Keep alive
  await new Promise(() => {});
}

async function runReport(runtime: Runtime) {
  const stats = runtime.getMemory().getStats('24h');
  const pnlByToken = runtime.getMemory().getTradeLog().getPnlByToken();

  console.log('\n=== 24H TRADING REPORT ===');
  console.log(`Trades: ${stats.tradesExecuted}`);
  console.log(`Won: ${stats.tradesWon} | Lost: ${stats.tradesLost}`);
  console.log(`P&L: ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL`);

  if (pnlByToken.length > 0) {
    console.log('\n--- P&L by Token ---');
    for (const row of pnlByToken) {
      const sign = row.pnl >= 0 ? '+' : '';
      console.log(`  ${row.symbol}: ${sign}${row.pnl.toFixed(4)} SOL (bought: ${row.bought.toFixed(4)}, sold: ${row.sold.toFixed(4)})`);
    }
  }

  const sessions = runtime.getMemory().getRecentSessions(5);
  if (sessions.length > 0) {
    console.log('\n--- Recent Sessions ---');
    for (const s of sessions) {
      const duration = s.ended_at ? Math.round((s.ended_at - s.started_at) / 60_000) : '?';
      console.log(`  ${s.id} | ${s.mode} | ${s.status} | ${duration}m`);
    }
  }

  await runtime.shutdown();
  process.exit(0);
}

async function runInteractive(runtime: Runtime) {
  console.log(BANNER);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36mwhiteowl>\x1b[0m ',
  });

  const commands: Record<string, string> = {
    help: 'Show available commands',
    status: 'Show system status',
    balance: 'Check wallet balance',
    start: 'Start session (usage: start <mode> [strategy])',
    stop: 'Stop current session',
    pause: 'Pause current session',
    resume: 'Resume paused session',
    report: 'Show current session report',
    chat: 'Chat with agent (usage: chat <agentId> <message>)',
    agents: 'List active agents',
    skills: 'List loaded skills',
    strategies: 'List available strategies',
    events: 'Show recent events',
    trending: 'Show trending tokens',
    quit: 'Shutdown and exit',
  };

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const [cmd, ...parts] = input.split(/\s+/);
    const rest = parts.join(' ');

    try {
      switch (cmd) {
        case 'help':
          console.log('\nAvailable commands:');
          for (const [name, desc] of Object.entries(commands)) {
            console.log(`  ${name.padEnd(14)} ${desc}`);
          }
          break;

        case 'status': {
          const status = runtime.getStatus();
          const balance = await runtime.getWallet().getBalance().catch(() => 0);
          console.log(`\nReady: ${status.ready}`);
          console.log(`Uptime: ${Math.round(status.uptime / 60_000)}m`);
          console.log(`Wallet: ${status.wallet}`);
          console.log(`Balance: ${balance.toFixed(4)} SOL`);
          console.log(`Agents: ${status.agents.length}`);
          console.log(`Skills: ${status.skills.join(', ')}`);
          if (status.session) {
            console.log(`Session: ${status.session.id} (${status.session.mode}) — ${status.session.status}`);
          }
          break;
        }

        case 'balance': {
          const balance = await runtime.getWallet().getBalance();
          console.log(`Balance: ${balance.toFixed(4)} SOL`);
          break;
        }

        case 'start': {
          const mode = (parts[0] || 'monitor') as any;
          const strategy = parts[1];
          const duration = parts[2] ? Number(parts[2]) : undefined;
          if (!['autopilot', 'advisor', 'monitor', 'manual'].includes(mode)) {
            console.log('Usage: start <autopilot|advisor|monitor|manual> [strategy] [durationMinutes]');
            break;
          }
          const session = await runtime.startSession({
            mode,
            strategy,
            durationMinutes: duration,
          });
          console.log(`Session started: ${session.id}`);
          break;
        }

        case 'stop': {
          const session = await runtime.stopSession();
          if (session) {
            console.log(`Session ${session.id} stopped`);
          } else {
            console.log('No active session');
          }
          break;
        }

        case 'pause':
          runtime.pauseSession();
          break;

        case 'resume':
          runtime.resumeSession();
          break;

        case 'report': {
          const stats = runtime.getSessionStats();
          console.log(`\nTrades: ${stats.tradesExecuted} (${stats.tradesWon}W / ${stats.tradesLost}L)`);
          console.log(`P&L: ${stats.totalPnlSol.toFixed(4)} SOL`);
          console.log(`Scanned: ${stats.tokensScanned} tokens`);
          console.log(`Signals: ${stats.signalsGenerated}`);
          break;
        }

        case 'chat': {
          const agentId = parts[0];
          const message = parts.slice(1).join(' ');
          if (!agentId || !message) {
            console.log('Usage: chat <agentId> <message>');
            break;
          }
          console.log('Thinking...');
          const response = await runtime.chat(agentId, message);
          console.log(`\n${response}\n`);
          break;
        }

        case 'agents': {
          const status = runtime.getStatus();
          for (const agent of status.agents) {
            console.log(`  ${agent.id} | ${agent.config.name} | ${agent.status} | decisions: ${agent.totalDecisions}`);
          }
          break;
        }

        case 'skills': {
          const manifests = runtime.getSkillLoader().getAllManifests();
          for (const m of manifests) {
            console.log(`  ${m.name} v${m.version} — ${m.tools.length} tools`);
          }
          break;
        }

        case 'strategies': {
          const strategies = runtime.getStrategyEngine().getAll();
          if (strategies.length === 0) {
            console.log('No strategies loaded. Add .yaml files to ./strategies/');
          }
          const active = runtime.getStrategyEngine().getActive();
          for (const s of strategies) {
            const marker = active?.name === s.name ? ' [ACTIVE]' : '';
            console.log(`  ${s.name}${marker} — ${s.description}`);
          }
          break;
        }

        case 'events': {
          const events = runtime.getEventBus().history(undefined, 20);
          for (const e of events) {
            const time = new Date(e.timestamp).toLocaleTimeString();
            console.log(`  [${time}] ${e.event}`);
          }
          break;
        }

        case 'trending': {
          const trending = runtime.getMemory().getTokenStore().getTrendingTokens(10);
          if (trending.length === 0) {
            console.log('No trending data yet. Start a monitoring session first.');
          }
          for (const { token, priceChange } of trending) {
            const sign = priceChange >= 0 ? '+' : '';
            console.log(`  ${token.symbol} | ${sign}${priceChange.toFixed(1)}% | MC: ${(token.marketCap / 1000).toFixed(1)}k | ${token.mint.slice(0, 8)}...`);
          }
          break;
        }

        case 'quit':
        case 'exit':
          await runtime.shutdown();
          process.exit(0);

        default:
          // Treat as chat with default agent
          console.log('Thinking...');
          const chatResponse = await runtime.chat('scanner', input);
          console.log(`\n${chatResponse}\n`);
          break;
      }
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await runtime.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
