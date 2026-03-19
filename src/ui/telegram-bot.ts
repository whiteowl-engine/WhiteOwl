/**
 * Telegram Bot — Phase 11: Full AI Chat + Management
 *
 * Features:
 * - Full AI conversation (chat with any agent)
 * - Inline keyboard menus — session, portfolio, tokens, settings, OAuth
 * - Callback queries for interactive navigation
 * - Token lookup by mint/symbol
 * - Real-time alerts: trades, rugs, risk, position changes
 * - Portfolio management with sell buttons
 * - OAuth setup via Telegram
 * - Settings: auto-approve level, privacy, strategies
 * - Multi-page pagination for long results
 * - Conversation context preserved per chat
 */

import * as https from 'https';
import { Runtime } from '../runtime';
import { LoggerInterface, EventName } from '../types';

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name: string; username?: string };
    message_id: number;
  };
  callback_query?: {
    id: string;
    chat_instance: string;
    from: { id: number; first_name: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

// Per-chat conversation state
interface ChatState {
  mode: 'menu' | 'chat' | 'token_lookup' | 'settings';
  chatAgent: string;
  lastActivity: number;
}

export class TelegramBot {
  private runtime: Runtime;
  private logger: LoggerInterface;
  private botToken: string;
  private chatId: string;
  private allowedChatIds: Set<string>;
  private running = false;
  private lastUpdateId = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private chatStates = new Map<number, ChatState>();

  constructor(runtime: Runtime, logger: LoggerInterface, botToken: string, chatId: string) {
    this.runtime = runtime;
    this.logger = logger;
    this.botToken = botToken;
    this.chatId = chatId;
    this.allowedChatIds = new Set([chatId]);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollUpdates();
    this.bindAlerts();
    this.logger.info('Telegram bot started (Phase 11 — Full AI Chat)');
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info('Telegram bot stopped');
  }

  // ===== State =====

  private getState(chatId: number): ChatState {
    if (!this.chatStates.has(chatId)) {
      this.chatStates.set(chatId, { mode: 'menu', chatAgent: 'commander', lastActivity: Date.now() });
    }
    const state = this.chatStates.get(chatId)!;
    state.lastActivity = Date.now();
    return state;
  }

  // ===== Polling =====

  private async pollUpdates(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.apiCall<{ ok: boolean; result: TelegramUpdate[] }>(
        'getUpdates',
        { offset: this.lastUpdateId + 1, timeout: 10, limit: 20 },
      );

      if (updates?.ok && updates.result) {
        for (const update of updates.result) {
          this.lastUpdateId = update.update_id;
          if (update.callback_query) {
            await this.handleCallback(update.callback_query);
          } else if (update.message?.text) {
            await this.handleMessage(update.message.chat.id, update.message.text);
          }
        }
      }
    } catch (err: any) {
      this.logger.error('Telegram poll error', err.message);
    }

    this.pollTimer = setTimeout(() => this.pollUpdates(), 1000);
  }

  // ===== Main Message Router =====

  private async handleMessage(chatId: number, text: string): Promise<void> {
    if (!this.allowedChatIds.has(String(chatId))) {
      await this.send(chatId, '⛔ Unauthorized');
      return;
    }

    const trimmed = text.trim();
    const state = this.getState(chatId);

    // Commands always work
    if (trimmed.startsWith('/')) {
      return this.handleCommand(chatId, trimmed, state);
    }

    // In chat mode -> send to AI agent
    if (state.mode === 'chat') {
      return this.handleAIChat(chatId, trimmed, state);
    }

    // In token lookup mode
    if (state.mode === 'token_lookup') {
      return this.handleTokenLookup(chatId, trimmed, state);
    }

    // Default: treat as AI chat with commander
    return this.handleAIChat(chatId, trimmed, state);
  }

  // ===== Commands =====

  private async handleCommand(chatId: number, text: string, state: ChatState): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/start':
      case '/menu':
        state.mode = 'menu';
        return this.sendMainMenu(chatId);

      case '/chat':
        state.mode = 'chat';
        state.chatAgent = args[0] || 'commander';
        return this.send(chatId,
          `🤖 *AI Chat Mode*\nAgent: \`${state.chatAgent}\`\n\nSend any message to talk to the AI.\nUse /menu to go back.`,
          { parse_mode: 'Markdown' }
        );

      case '/status':
        return this.sendStatus(chatId);

      case '/portfolio':
      case '/positions':
        return this.sendPortfolio(chatId);

      case '/trades':
        return this.sendTradeHistory(chatId);

      case '/token': {
        if (args[0]) return this.handleTokenLookup(chatId, args[0], state);
        state.mode = 'token_lookup';
        return this.send(chatId, '🔍 Send a token mint address or symbol to look up:');
      }

      case '/begin': {
        const mode = args[0] || 'autopilot';
        const strategy = args[1];
        try {
          const session = await this.runtime.startSession({ mode: mode as any, strategy });
          return this.send(chatId, `✅ Session started\nMode: ${session.mode}\nID: \`${session.id}\``, { parse_mode: 'Markdown' });
        } catch (err: any) {
          return this.send(chatId, `❌ ${err.message}`);
        }
      }

      case '/stop': {
        const session = await this.runtime.stopSession();
        if (!session) return this.send(chatId, 'No active session');
        const wr = session.stats.tradesExecuted > 0
          ? ((session.stats.tradesWon / session.stats.tradesExecuted) * 100).toFixed(1) : '0';
        return this.send(chatId,
          `🛑 Session stopped\nTrades: ${session.stats.tradesExecuted} (${session.stats.tradesWon}W/${session.stats.tradesLost}L)\n` +
          `Win Rate: ${wr}%\nP&L: ${this.fmtPnl(session.stats.totalPnlSol)}`);
      }

      case '/pause':
        this.runtime.pauseSession();
        return this.send(chatId, '⏸️ Paused');

      case '/resume':
        this.runtime.resumeSession();
        return this.send(chatId, '▶️ Resumed');

      case '/report': {
        try {
          await this.send(chatId, '⏳ Generating daily report...');
          const report = await this.runtime.getDailyReportGenerator().generateReport();
          return this.sendLong(chatId, `📋 *Daily Report*\n\n${report}`);
        } catch (err: any) {
          return this.send(chatId, `❌ ${err.message}`);
        }
      }

      case '/settings':
        return this.sendSettings(chatId);

      case '/oauth':
        return this.sendOAuthMenu(chatId);

      case '/skills':
        return this.sendSkills(chatId);

      case '/strategies':
        return this.sendStrategies(chatId);

      case '/help':
      default:
        return this.sendHelp(chatId);
    }
  }

  // ===== AI Chat =====

  private async handleAIChat(chatId: number, message: string, state: ChatState): Promise<void> {
    try {
      await this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' });
      const response = await this.runtime.chat(state.chatAgent, message);
      const kb: InlineKeyboard = { inline_keyboard: [
        [{ text: '🔄 Continue', callback_data: 'chat_continue' }, { text: '🏠 Menu', callback_data: 'menu' }],
        [{ text: '🔀 Switch Agent', callback_data: 'chat_switch' }],
      ]};
      await this.sendLong(chatId, `🤖 *${state.chatAgent}*:\n\n${response}`, kb);
    } catch (err: any) {
      await this.send(chatId, `❌ AI error: ${err.message}\n\n/menu to go back`);
    }
  }

  // ===== Token Lookup =====

  private async handleTokenLookup(chatId: number, input: string, state: ChatState): Promise<void> {
    state.mode = 'menu';
    const mint = input.trim();
    const token = this.runtime.getMemory().getToken(mint);

    if (!token) {
      return this.send(chatId, `❌ Token not found: \`${mint.slice(0, 20)}\`\n\nSend a valid Solana mint address.`, { parse_mode: 'Markdown' });
    }

    const analysis = this.runtime.getMemory().getAnalysis(mint);
    const lines = [
      `🪙 *${token.symbol || 'Unknown'}*`,
      `Mint: \`${mint.slice(0, 8)}...${mint.slice(-6)}\``,
      `MCap: ${token.marketCap ? '$' + this.fmtNum(token.marketCap) : '—'}`,
      `Volume: ${token.volume24h ? '$' + this.fmtNum(token.volume24h) : '—'}`,
      `Holders: ${token.holders || '—'}`,
    ];
    if (analysis) {
      lines.push('', `📊 *Analysis*`);
      if (analysis.score) lines.push(`Score: ${analysis.score}/100`);
      if (analysis.rugScore != null) lines.push(`Rug Score: ${analysis.rugScore}`);
      if (analysis.signals?.length) lines.push(`Signals: ${analysis.signals.join(', ')}`);
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '📊 Ask AI', callback_data: `ai_analyze:${mint}` }, { text: '🔍 Another', callback_data: 'token_lookup' }],
      [{ text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  // ===== Callback Query Handler =====

  private async handleCallback(cq: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = cq.message?.chat.id;
    if (!chatId || !this.allowedChatIds.has(String(chatId))) {
      await this.answerCallback(cq.id, '⛔ Unauthorized');
      return;
    }

    const data = cq.data || '';
    const state = this.getState(chatId);
    await this.answerCallback(cq.id);

    // Route callbacks
    if (data === 'menu') { state.mode = 'menu'; return this.sendMainMenu(chatId); }
    if (data === 'status') return this.sendStatus(chatId);
    if (data === 'portfolio') return this.sendPortfolio(chatId);
    if (data === 'trades') return this.sendTradeHistory(chatId);
    if (data === 'settings') return this.sendSettings(chatId);
    if (data === 'oauth') return this.sendOAuthMenu(chatId);
    if (data === 'skills') return this.sendSkills(chatId);
    if (data === 'strategies') return this.sendStrategies(chatId);
    if (data === 'help') return this.sendHelp(chatId);

    // Chat controls
    if (data === 'chat_commander') { state.mode = 'chat'; state.chatAgent = 'commander'; return this.send(chatId, '🤖 Chat with *Commander*. Send your message:', { parse_mode: 'Markdown' }); }
    if (data === 'chat_trader') { state.mode = 'chat'; state.chatAgent = 'trader'; return this.send(chatId, '🤖 Chat with *Trader*. Send your message:', { parse_mode: 'Markdown' }); }
    if (data === 'chat_continue') { return this.send(chatId, '💬 Send your message:'); }
    if (data === 'chat_switch') {
      const kb: InlineKeyboard = { inline_keyboard: [
        [{ text: '🧠 Commander', callback_data: 'chat_commander' }, { text: '💰 Trader', callback_data: 'chat_trader' }],
        [{ text: '🏠 Menu', callback_data: 'menu' }],
      ]};
      return this.send(chatId, 'Choose an agent:', { reply_markup: JSON.stringify(kb) });
    }

    // Token lookup
    if (data === 'token_lookup') { state.mode = 'token_lookup'; return this.send(chatId, '🔍 Send token mint or symbol:'); }
    if (data.startsWith('ai_analyze:')) {
      const mint = data.slice(11);
      state.mode = 'chat';
      state.chatAgent = 'commander';
      return this.handleAIChat(chatId, `Analyze this token in detail: ${mint}. Give me entry/exit recommendations, risk assessment, and key metrics.`, state);
    }

    // Session controls
    if (data === 'session_start_autopilot') {
      try { await this.runtime.startSession({ mode: 'autopilot' }); return this.send(chatId, '✅ Autopilot started'); }
      catch (e: any) { return this.send(chatId, `❌ ${e.message}`); }
    }
    if (data === 'session_start_advisor') {
      try { await this.runtime.startSession({ mode: 'advisor' }); return this.send(chatId, '✅ Advisor mode started'); }
      catch (e: any) { return this.send(chatId, `❌ ${e.message}`); }
    }
    if (data === 'session_start_monitor') {
      try { await this.runtime.startSession({ mode: 'monitor' }); return this.send(chatId, '✅ Monitor mode started'); }
      catch (e: any) { return this.send(chatId, `❌ ${e.message}`); }
    }
    if (data === 'session_stop') {
      const s = await this.runtime.stopSession();
      return this.send(chatId, s ? `🛑 Stopped. P&L: ${this.fmtPnl(s.stats.totalPnlSol)}` : 'No session');
    }
    if (data === 'session_pause') { this.runtime.pauseSession(); return this.send(chatId, '⏸️ Paused'); }
    if (data === 'session_resume') { this.runtime.resumeSession(); return this.send(chatId, '▶️ Resumed'); }

    // Auto-approve level
    if (data.startsWith('approve_')) {
      const level = data.slice(8) as any;
      this.runtime.setAutoApproveLevel(level);
      return this.send(chatId, `✅ Auto-approve: *${level}*`, { parse_mode: 'Markdown' });
    }

    // OAuth
    if (data.startsWith('oauth_start_')) {
      const provider = data.slice(12);
      try {
        const oauthMgr = this.runtime.getOAuthManager();
        const flow = await oauthMgr.startDeviceFlow(provider);
        flow.pollFn().catch(() => {});
        return this.send(chatId,
          `🔐 *OAuth: ${provider}*\n\n` +
          `1. Open: ${flow.verificationUri}\n` +
          `2. Enter code: \`${flow.userCode}\`\n\n` +
          `Waiting for authorization...`,
          { parse_mode: 'Markdown' }
        );
      } catch (e: any) {
        return this.send(chatId, `❌ ${e.message}`);
      }
    }
    if (data.startsWith('oauth_revoke_')) {
      const provider = data.slice(13);
      this.runtime.getOAuthManager().revokeToken(provider);
      return this.send(chatId, `✅ Revoked: ${provider}`);
    }

    // Report
    if (data === 'report') {
      await this.send(chatId, '⏳ Generating...');
      try {
        const report = await this.runtime.getDailyReportGenerator().generateReport();
        return this.sendLong(chatId, `📋 *Report*\n\n${report}`);
      } catch (e: any) { return this.send(chatId, `❌ ${e.message}`); }
    }

    // Trending
    if (data === 'trending') {
      const trending = this.runtime.getMemory().getTokenStore().getTrendingTokens(10);
      if (!trending.length) return this.send(chatId, 'No trending tokens yet');
      const lines = trending.map((t: any, i: number) =>
        `${i + 1}. *${t.symbol || t.mint?.slice(0, 8)}* — MCap: $${this.fmtNum(t.mcap || 0)}`
      );
      return this.send(chatId, `🔥 *Trending Tokens*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    }
  }

  // ===== Menu Screens =====

  private async sendMainMenu(chatId: number): Promise<void> {
    const status = this.runtime.getStatus();
    const bal = await this.runtime.getWallet().getBalance().catch(() => 0);
    const sessionLine = status.session
      ? `📊 ${status.session.status} | ${status.session.mode}`
      : '⚫ No session';

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '🤖 Chat AI', callback_data: 'chat_switch' }, { text: '📊 Status', callback_data: 'status' }],
      [{ text: '💼 Portfolio', callback_data: 'portfolio' }, { text: '📈 Trades', callback_data: 'trades' }],
      [{ text: '🔥 Trending', callback_data: 'trending' }, { text: '🔍 Token', callback_data: 'token_lookup' }],
      [{ text: '▶️ Start', callback_data: 'session_start_autopilot' }, { text: '⏸️ Pause', callback_data: 'session_pause' }, { text: '🛑 Stop', callback_data: 'session_stop' }],
      [{ text: '⚙️ Settings', callback_data: 'settings' }, { text: '🔐 OAuth', callback_data: 'oauth' }],
      [{ text: '📋 Report', callback_data: 'report' }, { text: '❓ Help', callback_data: 'help' }],
    ]};

    await this.send(chatId,
      `◈ *WhiteOwl Trading Bot*\n\n` +
      `${sessionLine}\n` +
      `💰 ${bal.toFixed(3)} SOL | Agents: ${status.agents.length}\n\n` +
      `Choose an action or send a message to chat with AI:`,
      { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) }
    );
  }

  private async sendStatus(chatId: number): Promise<void> {
    const status = this.runtime.getStatus();
    const bal = await this.runtime.getWallet().getBalance().catch(() => 0);
    const stats = this.runtime.getSessionStats();
    const uptime = status.uptime ? Math.round(status.uptime / 60000) : 0;

    const lines = [
      `◈ *WhiteOwl Status*`,
      ``,
      `Ready: ${status.ready ? '✅' : '❌'}`,
      `Wallet: \`${status.wallet.slice(0, 6)}...${status.wallet.slice(-4)}\``,
      `Balance: ${bal.toFixed(3)} SOL`,
      `Uptime: ${uptime}m`,
      `Agents: ${status.agents.map((a: any) => a.name || a.id).join(', ') || 'none'}`,
      `Skills: ${status.skills.length}`,
      ``,
      `📊 *Session*: ${status.session?.status || 'none'}`,
    ];

    if (stats.tradesExecuted > 0) {
      const wr = ((stats.tradesWon / stats.tradesExecuted) * 100).toFixed(1);
      lines.push(
        `Trades: ${stats.tradesExecuted} (${stats.tradesWon}W/${stats.tradesLost}L)`,
        `Win Rate: ${wr}%`,
        `P&L: ${this.fmtPnl(stats.totalPnlSol)}`,
        `Peak: ${stats.peakPnlSol.toFixed(4)} SOL`,
      );
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '🔄 Refresh', callback_data: 'status' }, { text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  private async sendPortfolio(chatId: number): Promise<void> {
    const stats24h = this.runtime.getMemory().getStats('24h');
    const stats7d = this.runtime.getMemory().getStats('7d');
    const trades = this.runtime.getMemory().getTradeHistory({ limit: 5 });

    const lines = [
      `💼 *Portfolio*`,
      ``,
      `*24h*: ${this.fmtPnl(stats24h.totalPnlSol)} | ${stats24h.tradesExecuted} trades | WR: ${stats24h.tradesExecuted > 0 ? ((stats24h.tradesWon / stats24h.tradesExecuted) * 100).toFixed(0) : 0}%`,
      `*7d*: ${this.fmtPnl(stats7d.totalPnlSol)} | ${stats7d.tradesExecuted} trades | WR: ${stats7d.tradesExecuted > 0 ? ((stats7d.tradesWon / stats7d.tradesExecuted) * 100).toFixed(0) : 0}%`,
    ];

    if (trades.length) {
      lines.push('', `*Recent:*`);
      for (const t of trades) {
        const emoji = t.action === 'buy' ? '🟢' : '🔴';
        lines.push(`${emoji} ${t.action.toUpperCase()} ${t.symbol || t.mint?.slice(0, 8)} — ${t.amount_sol?.toFixed(3) || '?'} SOL ${t.success ? '✅' : '❌'}`);
      }
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '📈 All Trades', callback_data: 'trades' }, { text: '🔄 Refresh', callback_data: 'portfolio' }],
      [{ text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  private async sendTradeHistory(chatId: number): Promise<void> {
    const trades = this.runtime.getMemory().getTradeHistory({ limit: 15 });
    if (!trades.length) return this.send(chatId, 'No trades yet');

    const lines = [`📈 *Trade History* (last ${trades.length})\n`];
    for (const t of trades) {
      const emoji = t.action === 'buy' ? '🟢' : '🔴';
      const time = new Date(t.timestamp).toLocaleTimeString();
      lines.push(`${emoji} ${time} ${t.action.toUpperCase()} ${t.symbol || t.mint?.slice(0, 8)} ${t.amount_sol?.toFixed(3) || '?'} SOL ${t.success ? '✅' : '❌'}`);
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '💼 Portfolio', callback_data: 'portfolio' }, { text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  private async sendSettings(chatId: number): Promise<void> {
    const approval = this.runtime.getAutoApprove();
    const currentLevel = approval.getLevel();

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: `${currentLevel === 'off' ? '✅' : ''} Off`, callback_data: 'approve_off' }, { text: `${currentLevel === 'conservative' ? '✅' : ''} Conservative`, callback_data: 'approve_conservative' }],
      [{ text: `${currentLevel === 'moderate' ? '✅' : ''} Moderate`, callback_data: 'approve_moderate' }, { text: `${currentLevel === 'aggressive' ? '✅' : ''} Aggressive`, callback_data: 'approve_aggressive' }],
      [{ text: `${currentLevel === 'full' ? '✅' : ''} Full Auto`, callback_data: 'approve_full' }],
      [{ text: '📋 Strategies', callback_data: 'strategies' }, { text: '🛠️ Skills', callback_data: 'skills' }],
      [{ text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId,
      `⚙️ *Settings*\n\n` +
      `Auto-Approve: *${currentLevel}*\n\n` +
      `Choose auto-approve level:`,
      { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) }
    );
  }

  private async sendOAuthMenu(chatId: number): Promise<void> {
    const oauth = this.runtime.getOAuthManager();
    const github = oauth.hasToken('github');
    const google = oauth.hasToken('google');
    const azure = oauth.hasToken('azure');

    const lines = [
      `🔐 *OAuth Authentication*`,
      ``,
      `GitHub Copilot: ${github ? '✅ Connected' : '❌ Not connected'}`,
      `Google Cloud: ${google ? '✅ Connected' : '❌ Not connected'}`,
      `Azure AD: ${azure ? '✅ Connected' : '❌ Not connected'}`,
      ``,
      `Connect to use AI for free with existing subscriptions.`,
    ];

    const buttons: InlineKeyboard['inline_keyboard'] = [];
    if (!github) buttons.push([{ text: '🔗 Connect GitHub', callback_data: 'oauth_start_github' }]);
    else buttons.push([{ text: '🗑️ Disconnect GitHub', callback_data: 'oauth_revoke_github' }]);
    if (!google) buttons.push([{ text: '🔗 Connect Google', callback_data: 'oauth_start_google' }]);
    else buttons.push([{ text: '🗑️ Disconnect Google', callback_data: 'oauth_revoke_google' }]);
    if (!azure) buttons.push([{ text: '🔗 Connect Azure', callback_data: 'oauth_start_azure' }]);
    else buttons.push([{ text: '🗑️ Disconnect Azure', callback_data: 'oauth_revoke_azure' }]);
    buttons.push([{ text: '🏠 Menu', callback_data: 'menu' }]);

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify({ inline_keyboard: buttons }) });
  }

  private async sendSkills(chatId: number): Promise<void> {
    const manifests = this.runtime.getSkillLoader().getAllManifests();
    const lines = [`🛠️ *Skills* (${manifests.length})\n`];
    for (const s of manifests) {
      lines.push(`• *${s.name}* — ${s.description?.slice(0, 60) || ''}`);
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '⚙️ Settings', callback_data: 'settings' }, { text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  private async sendStrategies(chatId: number): Promise<void> {
    const strategies = this.runtime.getStrategyEngine().getAll();
    if (!strategies.length) return this.send(chatId, 'No strategies loaded');

    const lines = [`📋 *Strategies*\n`];
    for (const s of strategies) {
      lines.push(`• *${s.name}* — ${s.description?.slice(0, 80) || ''}`);
    }

    const kb: InlineKeyboard = { inline_keyboard: [
      [{ text: '⚙️ Settings', callback_data: 'settings' }, { text: '🏠 Menu', callback_data: 'menu' }],
    ]};

    await this.send(chatId, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: JSON.stringify(kb) });
  }

  private async sendHelp(chatId: number): Promise<void> {
    await this.send(chatId, [
      `◈ *WhiteOwl Bot Help*`,
      ``,
      `*Chat:*`,
      `/chat [agent] — Chat with AI agent`,
      `(or just send any message)`,
      ``,
      `*Session:*`,
      `/begin [mode] [strategy] — Start trading`,
      `/stop — Stop session`,
      `/pause / /resume — Pause/resume`,
      ``,
      `*Info:*`,
      `/status — System status`,
      `/portfolio — P&L summary`,
      `/trades — Recent trades`,
      `/token [mint] — Look up token`,
      `/report — Generate daily report`,
      ``,
      `*Config:*`,
      `/settings — Auto-approve & more`,
      `/oauth — Connect OAuth providers`,
      `/skills — List skills`,
      `/strategies — List strategies`,
      ``,
      `/menu — Main menu with buttons`,
    ].join('\n'), { parse_mode: 'Markdown' });
  }

  // ===== Alerts =====

  private bindAlerts(): void {
    const bus = this.runtime.getEventBus();
    const chatId = Number(this.chatId);

    bus.on('trade:executed', (data) => {
      if (!data.success) return;
      const intent = bus.history('trade:intent', 20).find(e => e.data?.id === data.intentId);
      const action = intent?.data?.action || '?';
      const symbol = intent?.data?.symbol || intent?.data?.mint?.slice(0, 8) || '?';
      this.send(chatId,
        `${action === 'buy' ? '🟢' : '🔴'} *Trade Executed*\n` +
        `${action.toUpperCase()} ${symbol}\n` +
        `Amount: ${data.amountSol?.toFixed(3) || '?'} SOL\n` +
        `TX: \`${(data.txHash || '').slice(0, 16)}\``,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    bus.on('signal:rug', (data) => {
      this.send(chatId,
        `⚠️ *RUG DETECTED*\n${data.mint.slice(0, 8)}...\nConfidence: ${(data.confidence * 100).toFixed(0)}%\n${data.indicators.join(', ')}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    bus.on('risk:emergency', (data) => {
      this.send(chatId, `🚨 *EMERGENCY*: ${data.reason}`, { parse_mode: 'Markdown' }).catch(() => {});
    });

    bus.on('position:closed', (data) => {
      if (Math.abs(data.pnl) < 0.05) return;
      const emoji = data.pnl > 0 ? '🟢' : '🔴';
      this.send(chatId,
        `${emoji} *Position Closed*\n${data.mint.slice(0, 8)}...\nP&L: ${this.fmtPnl(data.pnl)} (${data.pnlPercent.toFixed(1)}%)\nHeld: ${Math.round(data.duration / 60000)}m`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    });

    bus.on('session:report', (data) => {
      const msg = data.report.length > 4000 ? data.report.slice(0, 4000) + '...' : data.report;
      this.send(chatId, `📋 *Report*\n${msg}`, { parse_mode: 'Markdown' }).catch(() => {});
    });
  }

  // ===== Helpers =====

  private fmtPnl(sol: number): string {
    return `${sol >= 0 ? '+' : ''}${sol.toFixed(4)} SOL`;
  }

  private fmtNum(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(0);
  }

  private async send(chatId: number, text: string, extra?: Record<string, any>): Promise<void> {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...extra,
    }).catch(() => {
      // Retry without Markdown
      this.apiCall('sendMessage', {
        chat_id: chatId,
        text: text.replace(/[*_`\[\]]/g, ''),
        disable_web_page_preview: true,
        ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
      }).catch(() => {});
    });
  }

  private async sendLong(chatId: number, text: string, kb?: InlineKeyboard): Promise<void> {
    const MAX = 4000;
    if (text.length <= MAX) {
      return this.send(chatId, text, kb ? { reply_markup: JSON.stringify(kb) } : undefined);
    }
    // Split into chunks
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX) { chunks.push(remaining); break; }
      let cut = remaining.lastIndexOf('\n', MAX);
      if (cut < MAX * 0.5) cut = MAX;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.send(chatId, chunks[i], isLast && kb ? { reply_markup: JSON.stringify(kb) } : undefined);
    }
  }

  private answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    return this.apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    }).then(() => {}).catch(() => {});
  }

  private apiCall<T>(method: string, params: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(params);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON')); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }
}
