
import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types.ts';
import { axiomResolvePair } from './axiom-api.ts';

export class WebIntelSkill implements Skill {
  manifest: SkillManifest = {
    name: 'web-intel',
    version: '1.0.0',
    description:
      'Scrape real-time token data from Axiom (axiom.trade) and GMGN (gmgn.ai) via the user\'s Chrome session. ' +
      'These platforms update faster than pump.fun APIs. Use for trending tokens, top traders, holder analysis, ' +
      'smart-money / KOL tracking, and token activity feeds.',
    tools: [

      {
        name: 'axiom_get_trending',
        description:
          'Scrape trending / new / surge tokens from Axiom Discover page. ' +
          'Returns token list with Market Cap, Liquidity, Volume, TXNS, Token Info. ' +
          'Faster-updating alternative to pump.fun trending APIs. ' +
          'Requires Axiom connected in Settings.',
        parameters: {
          type: 'object',
          properties: {
            tab: {
              type: 'string',
              enum: ['trending', 'surge', 'top', 'pump_live'],
              description: 'Which discover tab to scrape (default: trending)',
            },
            timeframe: {
              type: 'string',
              enum: ['1m', '5m', '30m', '1h'],
              description: 'Timeframe filter (default: 5m)',
            },
          },
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_get_token',
        description:
          'Scrape a specific token page on Axiom (axiom.trade/meme/{mint}). ' +
          'Returns price, market cap, liquidity, volume, holder count, and raw page content. ' +
          'Use for quick token overview. Requires Axiom connected.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Solana token mint address or full axiom.trade URL' },
          },
          required: ['mint'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_get_top_traders',
        description:
          'Scrape top traders for a token from Axiom. Returns wallets with PnL, bought/sold amounts, ' +
          'and influencer/KOL/notable badges. Use to identify who is trading a token. ' +
          'Requires Axiom connected.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Solana token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'axiom_get_pulse',
        description:
          'Scrape the Axiom Pulse page — real-time feed of market activity across all tokens. ' +
          'Shows latest buys/sells, big trades, and volume spikes. ' +
          'Useful for spotting momentum before it shows up in trending. Requires Axiom connected.',
        parameters: {
          type: 'object',
          properties: {},
        },
        riskLevel: 'read' as const,
      },

      {
        name: 'gmgn_get_trending',
        description:
          'Scrape trending tokens from GMGN (gmgn.ai/trend). ' +
          'Returns tokens with Market Cap, ATH MC, Liquidity, Volume, Txns, Holders, Total Fees, security info. ' +
          'GMGN data updates very fast and includes smart-money tags. Requires GMGN connected.',
        parameters: {
          type: 'object',
          properties: {
            tab: {
              type: 'string',
              enum: ['new', 'trending', 'surge', 'xstocks', 'pump_live', 'bluechip'],
              description: 'Which trend tab (default: trending)',
            },
            timeframe: {
              type: 'string',
              enum: ['1m', '5m', '1h', '6h', '24h'],
              description: 'Timeframe filter (default: 5m)',
            },
          },
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'gmgn_get_token',
        description:
          'Scrape a specific token page on GMGN (gmgn.ai/sol/token/{mint}). ' +
          'Returns price, market cap, liquidity, volume, total fees, supply, and available tabs ' +
          '(Activity, Holders, Top Traders, Dev-token). Richer data than pump.fun API. ' +
          'Requires GMGN connected.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Solana token mint address' },
            tab: {
              type: 'string',
              enum: ['activity', 'holders', 'top_traders', 'dev_token'],
              description: 'Which tab data to focus on (default: activity)',
            },
          },
          required: ['mint'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'gmgn_get_wallet',
        description:
          'Scrape a wallet page on GMGN to see its holdings, PnL, win rate, and tags (smart money, KOL, insider). ' +
          'Use to check if a wallet is notable before following its trades. Requires GMGN connected.',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Solana wallet address' },
          },
          required: ['address'],
        },
        riskLevel: 'read' as const,
      },
      {
        name: 'gmgn_get_top_holders',
        description:
          'Scrape top holders for a token from GMGN. Shows holder addresses, percentages, values, ' +
          'and smart-money/KOL/insider tags. Critical for evaluating token distribution and insider risk. ' +
          'Requires GMGN connected.',
        parameters: {
          type: 'object',
          properties: {
            mint: { type: 'string', description: 'Solana token mint address' },
          },
          required: ['mint'],
        },
        riskLevel: 'read' as const,
      },

      {
        name: 'web_intel_check_status',
        description:
          'Check which web intel data sources are currently connected (Axiom and/or GMGN). ' +
          'Returns connection status and session validity for each platform.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read' as const,
      },
    ],
  };

  private logger!: LoggerInterface;
  private browser: any = null;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.browser = ctx.browser || null;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'axiom_get_trending':     return this.axiomGetTrending(params.tab, params.timeframe);
      case 'axiom_get_token':        return this.axiomGetToken(params.mint);
      case 'axiom_get_top_traders':  return this.axiomGetTopTraders(params.mint);
      case 'axiom_get_pulse':        return this.axiomGetPulse();
      case 'gmgn_get_trending':      return this.gmgnGetTrending(params.tab, params.timeframe);
      case 'gmgn_get_token':         return this.gmgnGetToken(params.mint, params.tab);
      case 'gmgn_get_wallet':        return this.gmgnGetWallet(params.address);
      case 'gmgn_get_top_holders':   return this.gmgnGetTopHolders(params.mint);
      case 'web_intel_check_status': return this.checkStatus();
      default: throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}


  private async checkStatus(): Promise<any> {
    if (!this.browser) return { axiom: false, gmgn: false, error: 'BrowserService not available' };
    const s = this.browser.getStatus();
    return {
      axiom: { connected: s.axiomConnected },
      gmgn:  { connected: s.gmgnConnected },
      hint: !s.axiomConnected && !s.gmgnConnected
        ? 'Neither Axiom nor GMGN is connected. Ask user to connect in Settings → Axiom / GMGN cards.'
        : undefined,
    };
  }


  private ensureAxiom(): string | null {
    if (!this.browser) return 'BrowserService not available';
    const s = this.browser.getStatus();
    if (!s.axiomConnected) return 'Axiom not connected — ask user to connect in Settings → Axiom card.';
    return null;
  }

  private async axiomPage(url: string, waitSelector: string, timeout = 15000): Promise<any> {
    const mainBrowser = this.browser.mainBrowser;
    if (!mainBrowser?.connected) throw new Error('Browser disconnected');
    const page = await mainBrowser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForSelector(waitSelector, { timeout }).catch(() => {});

      await new Promise(r => setTimeout(r, 3000));
      return page;
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }

  private async axiomGetTrending(tab?: string, timeframe?: string): Promise<any> {
    const err = this.ensureAxiom();
    if (err) return { error: err };
    let page: any = null;
    try {
      page = await this.axiomPage('https://axiom.trade/discover?chain=sol', '[class*="pair"], [class*="row"], table', 12000);


      if (tab && tab !== 'trending') {
        await page.evaluate((t: string) => {
          const tabMap: Record<string, string> = { top: 'Top', surge: 'Surge', pump_live: 'Pump Live' };
          const label = tabMap[t] || t;
          const btns = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
          const btn = btns.find((b: any) => b.innerText?.trim().toLowerCase() === label.toLowerCase()) as HTMLElement | undefined;
          btn?.click();
        }, tab);
        await new Promise(r => setTimeout(r, 2000));
      }


      if (timeframe) {
        await page.evaluate((tf: string) => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find((b: any) => b.innerText?.trim() === tf) as HTMLElement | undefined;
          btn?.click();
        }, timeframe);
        await new Promise(r => setTimeout(r, 1500));
      }

      const data = await page.evaluate(() => {
        const text = document.body?.innerText || '';

        const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);

        const headerIdx = lines.findIndex((l: string) => l.includes('Market Cap') || l.includes('Pair Info'));
        const tokens: any[] = [];

        const rawSection = headerIdx >= 0 ? lines.slice(headerIdx).join('\n') : text.substring(0, 6000);
        return { tokens: rawSection.substring(0, 6000), source: 'axiom_discover' };
      });

      await page.close().catch(() => {});
      return data;
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, source: 'axiom_discover' };
    }
  }

  private async resolveAxiomUrl(mintOrUrl: string): Promise<{ url: string; mint: string }> {
    const trimmed = mintOrUrl.trim();

    if (/^https?:\/\/.*axiom\.trade\//i.test(trimmed)) {
      const mintMatch = trimmed.match(/\/(?:meme|t)\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      return { url: trimmed, mint: mintMatch?.[1] || trimmed };
    }

    try {
      const pair = await axiomResolvePair(trimmed);
      if (pair) {
        return {
          url: `https://axiom.trade/meme/${pair}?chain=sol`,
          mint: trimmed,
        };
      }
    } catch {}

    return {
      url: `https://axiom.trade/meme/${encodeURIComponent(trimmed)}?chain=sol`,
      mint: trimmed,
    };
  }

  private async axiomGetToken(mint: string): Promise<any> {
    const err = this.ensureAxiom();
    if (err) return { error: err };
    let page: any = null;
    try {
      const { url, mint: resolvedMint } = await this.resolveAxiomUrl(mint);
      page = await this.axiomPage(
        url,
        '[class*="chart"], [class*="price"], [class*="trade"], [class*="token"]',
        15000
      );


      const maxPollMs = 15000;
      const pollInterval = 1500;
      const pollStart = Date.now();
      let hasContent = false;
      while (Date.now() - pollStart < maxPollMs) {
        hasContent = await page.evaluate(() => {
          const text = document.body?.innerText || '';

          return /\$[\d,.]+[KMB]?/i.test(text) && /(vol|volume|buy|sell|trade|holder|liquidity)/i.test(text);
        }).catch(() => false);
        if (hasContent) break;
        await new Promise(r => setTimeout(r, pollInterval));
      }

      const data = await page.evaluate(() => {
        return { content: (document.body?.innerText || '').substring(0, 10000), source: 'axiom_token' };
      });
      await page.close().catch(() => {});
      return { mint: resolvedMint, ...data };
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, mint, source: 'axiom_token' };
    }
  }

  private async axiomGetTopTraders(mint: string): Promise<any> {
    const err = this.ensureAxiom();
    if (err) return { error: err };

    return this.browser.scrapeAxiomToken(mint);
  }

  private async axiomGetPulse(): Promise<any> {
    const err = this.ensureAxiom();
    if (err) return { error: err };
    let page: any = null;
    try {
      page = await this.axiomPage('https://axiom.trade/pulse?chain=sol', 'body', 12000);
      const data = await page.evaluate(() => {
        return { content: (document.body?.innerText || '').substring(0, 8000), source: 'axiom_pulse' };
      });
      await page.close().catch(() => {});
      return data;
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, source: 'axiom_pulse' };
    }
  }


  private ensureGmgn(): string | null {
    if (!this.browser) return 'BrowserService not available';
    const s = this.browser.getStatus();
    if (!s.gmgnConnected) return 'GMGN not connected — ask user to connect in Settings → GMGN card.';
    return null;
  }

  private async gmgnPage(url: string, waitSelector: string, timeout = 15000): Promise<any> {
    const mainBrowser = this.browser.mainBrowser;
    if (!mainBrowser?.connected) throw new Error('Browser disconnected');
    const page = await mainBrowser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      await page.waitForSelector(waitSelector, { timeout }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      return page;
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }

  private async gmgnGetTrending(tab?: string, timeframe?: string): Promise<any> {
    const err = this.ensureGmgn();
    if (err) return { error: err };
    let page: any = null;
    try {
      page = await this.gmgnPage('https://gmgn.ai/trend?chain=sol', 'table, [class*="row"]', 12000);


      if (tab && tab !== 'trending') {
        await page.evaluate((t: string) => {
          const tabMap: Record<string, string> = {
            new: 'New coins', surge: 'Surge', xstocks: 'xStocks',
            pump_live: 'Pump Live', bluechip: 'Next blue chips',
          };
          const label = tabMap[t] || t;
          const btns = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
          const btn = btns.find((b: any) => {
            const txt = b.innerText?.trim().toLowerCase();
            return txt === label.toLowerCase() || txt === t.toLowerCase();
          }) as HTMLElement | undefined;
          btn?.click();
        }, tab);
        await new Promise(r => setTimeout(r, 2000));
      }


      if (timeframe) {
        await page.evaluate((tf: string) => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find((b: any) => b.innerText?.trim() === tf) as HTMLElement | undefined;
          btn?.click();
        }, timeframe);
        await new Promise(r => setTimeout(r, 1500));
      }

      const data = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        const lines = text.split('\n').map((l: string) => l.trim()).filter(Boolean);
        const headerIdx = lines.findIndex((l: string) =>
          l.includes('Market Cap') || l.includes('Token')
        );
        const rawSection = headerIdx >= 0 ? lines.slice(headerIdx).join('\n') : text.substring(0, 8000);
        return { tokens: rawSection.substring(0, 8000), source: 'gmgn_trending' };
      });

      await page.close().catch(() => {});
      return data;
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, source: 'gmgn_trending' };
    }
  }

  private async gmgnGetToken(mint: string, tab?: string): Promise<any> {
    const err = this.ensureGmgn();
    if (err) return { error: err };
    let page: any = null;
    try {
      let url = `https://gmgn.ai/sol/token/${mint}`;
      if (tab) {
        const tabMap: Record<string, string> = {
          activity: '', holders: 'holder', top_traders: 'top_trader', dev_token: 'dev_token',
        };
        const tabParam = tabMap[tab];
        if (tabParam) url += `?tab=${tabParam}`;
      }
      page = await this.gmgnPage(url, 'body', 12000);
      const data = await page.evaluate(() => {
        return { content: (document.body?.innerText || '').substring(0, 8000), source: 'gmgn_token' };
      });
      await page.close().catch(() => {});
      return { mint, tab: tab || 'activity', ...data };
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, mint, source: 'gmgn_token' };
    }
  }

  private async gmgnGetWallet(address: string): Promise<any> {
    const err = this.ensureGmgn();
    if (err) return { error: err };
    let page: any = null;
    try {
      page = await this.gmgnPage(
        `https://gmgn.ai/sol/wallet/${address}`,
        'body', 12000,
      );
      const data = await page.evaluate(() => {
        const text = document.body?.innerText || '';

        const tagEls = document.querySelectorAll('[class*="smart"], [class*="kol"], [class*="whale"], [class*="insider"], [class*="tag"]');
        const tags = Array.from(tagEls).map((t: any) => t.innerText?.trim()).filter(Boolean);
        return { content: text.substring(0, 8000), tags, source: 'gmgn_wallet' };
      });
      await page.close().catch(() => {});
      return { address, ...data };
    } catch (e: any) {
      if (page) await page.close().catch(() => {});
      return { error: e.message, address, source: 'gmgn_wallet' };
    }
  }

  private async gmgnGetTopHolders(mint: string): Promise<any> {
    const err = this.ensureGmgn();
    if (err) return { error: err };

    return this.browser.scrapeGmgnToken(mint);
  }
}
