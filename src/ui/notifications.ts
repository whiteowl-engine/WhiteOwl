/**
 * Notification Manager — Phase 5
 *
 * Unified alert system supporting:
 * - Telegram (via bot)
 * - Discord (webhook)
 * - Generic webhook
 *
 * Filters events by severity and sends formatted notifications.
 */

import * as https from 'https';
import * as http from 'http';
import { EventBusInterface, LoggerInterface, Position } from '../types';

export interface NotificationConfig {
  telegram?: { botToken: string; chatId: string };
  discord?: { webhookUrl: string };
  webhook?: { url: string; headers?: Record<string, string> };
  minSeverity?: 'info' | 'warning' | 'critical';
}

type Severity = 'info' | 'warning' | 'critical';

interface Notification {
  title: string;
  message: string;
  severity: Severity;
  timestamp: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export class NotificationManager {
  private config: NotificationConfig;
  private logger: LoggerInterface;
  private eventBus: EventBusInterface;
  private minSeverity: number;
  private history: Notification[] = [];
  private readonly MAX_HISTORY = 500;

  // Rate limiting: max 1 notification per event type per 30s
  private lastSent = new Map<string, number>();
  private readonly RATE_LIMIT_MS = 30_000;

  constructor(config: NotificationConfig, eventBus: EventBusInterface, logger: LoggerInterface) {
    this.config = config;
    this.eventBus = eventBus;
    this.logger = logger;
    this.minSeverity = SEVERITY_ORDER[config.minSeverity || 'info'];
  }

  start(): void {
    // Trade alerts
    this.eventBus.on('trade:executed', (data) => {
      if (!data.success) return;
      this.notify({
        title: '💰 Trade Executed',
        message: `TX: ${data.txHash?.slice(0, 16) || 'n/a'}\nAmount: ${data.amountSol?.toFixed(3) || '?'} SOL`,
        severity: 'info',
        timestamp: Date.now(),
      });
    });

    // Rug alerts
    this.eventBus.on('signal:rug', (data) => {
      this.notify({
        title: '⚠️ Rug Detected',
        message: `Token: ${data.mint.slice(0, 12)}...\nConfidence: ${(data.confidence * 100).toFixed(0)}%\nIndicators: ${data.indicators.join(', ')}`,
        severity: 'warning',
        timestamp: Date.now(),
      });
    });

    // Emergency
    this.eventBus.on('risk:emergency', (data) => {
      this.notify({
        title: '🚨 EMERGENCY STOP',
        message: data.reason,
        severity: 'critical',
        timestamp: Date.now(),
      });
    });

    // Large P&L position close
    this.eventBus.on('position:closed', (data) => {
      if (Math.abs(data.pnl) < 0.1) return; // Skip tiny moves
      const emoji = data.pnl > 0 ? '🟢' : '🔴';
      this.notify({
        title: `${emoji} Position Closed`,
        message: `Token: ${data.mint.slice(0, 12)}...\nP&L: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)} SOL (${data.pnlPercent.toFixed(1)}%)\nHeld: ${Math.round(data.duration / 60_000)}min`,
        severity: Math.abs(data.pnl) > 0.5 ? 'warning' : 'info',
        timestamp: Date.now(),
      });
    });

    // Risk limits
    this.eventBus.on('risk:limit', (data) => {
      this.notify({
        title: '⚡ Risk Limit',
        message: `${data.type}: ${data.current}/${data.max}`,
        severity: 'warning',
        timestamp: Date.now(),
      });
    });

    this.logger.info('Notification manager started');
  }

  notify(notification: Notification): void {
    // Check severity
    if (SEVERITY_ORDER[notification.severity] < this.minSeverity) return;

    // Rate limit
    const key = notification.title;
    const lastTime = this.lastSent.get(key) || 0;
    if (Date.now() - lastTime < this.RATE_LIMIT_MS) return;
    this.lastSent.set(key, Date.now());

    // Store
    this.history.push(notification);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }

    // Send to all configured channels
    const text = `${notification.title}\n${notification.message}`;

    if (this.config.telegram) {
      this.sendTelegram(text).catch(() => {});
    }
    if (this.config.discord) {
      this.sendDiscord(notification).catch(() => {});
    }
    if (this.config.webhook) {
      this.sendWebhook(notification).catch(() => {});
    }
  }

  getHistory(limit: number = 50): Notification[] {
    return this.history.slice(-limit);
  }

  // ----- Channel implementations -----

  private async sendTelegram(text: string): Promise<void> {
    const { botToken, chatId } = this.config.telegram!;
    const body = JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  private async sendDiscord(notification: Notification): Promise<void> {
    const url = new URL(this.config.discord!.webhookUrl);
    const color = notification.severity === 'critical' ? 0xFF0000
      : notification.severity === 'warning' ? 0xFFA500 : 0x00FF00;

    const body = JSON.stringify({
      embeds: [{
        title: notification.title,
        description: notification.message,
        color,
        timestamp: new Date(notification.timestamp).toISOString(),
        footer: { text: 'WhiteOwl Trading Bot' },
      }],
    });

    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  private async sendWebhook(notification: Notification): Promise<void> {
    const url = new URL(this.config.webhook!.url);
    const body = JSON.stringify(notification);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      ...(this.config.webhook!.headers || {}),
    };

    return new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 10000,
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }
}
