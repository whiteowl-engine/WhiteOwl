
import puppeteer, { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

export interface BrowserStatus {
  running: boolean;
  twitterLoggedIn: boolean;
  loginWindowOpen: boolean;
  mainBrowserConnected: boolean;
  axiomConnected: boolean;
  gmgnConnected: boolean;
}

export class BrowserService {
  private browser: Browser | null = null;
  private loginBrowser: Browser | null = null;
  private mainBrowser: Browser | null = null;
  private userDataDir: string;
  private logger: any;
  private twitterLoggedIn = false;
  private loginWindowOpen = false;
  private axiomConnected = false;
  private gmgnConnected = false;
  private static CDP_HOST = '127.0.0.1';

  private axiomCookies: { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }[] = [];
  private axiomCookiesUpdatedAt = 0;
  private axiomAccessTokenRefreshedAt = 0;

  private axiomAuthHeaders: Record<string, string> = {};
  private axiomAuthHeadersUpdatedAt = 0;
  private axiomCdpCookieTimer: ReturnType<typeof setInterval> | null = null;
  private cdpReconnectTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, logger: any) {
    this.userDataDir = path.join(dataDir, 'browser-profile');
    this.logger = logger;
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  getStatus(): BrowserStatus {
    return {
      running: !!(this.browser?.connected),
      twitterLoggedIn: this.twitterLoggedIn,
      loginWindowOpen: this.loginWindowOpen,
      mainBrowserConnected: !!(this.mainBrowser?.connected),
      axiomConnected: this.axiomConnected && !!(this.mainBrowser?.connected) || this.hasAxiomCookies() || this.hasAxiomAuthHeaders(),
      gmgnConnected: this.gmgnConnected && !!(this.mainBrowser?.connected),
    };
  }

  setAxiomCookies(cookies: { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }[]) {
    this.axiomCookies = cookies;
    this.axiomCookiesUpdatedAt = Date.now();
    const hasAuth = cookies.some(c => c.name === 'auth-access-token' || c.name === 'auth-refresh-token');
    if (hasAuth) {
      this.axiomConnected = true;
      this.logger.debug(`[Browser] Axiom cookies synced from extension (${cookies.length} cookies, auth ✓)`);
    }
  }

setAxiomAuthHeaders(headers: Record<string, string>) {
    this.axiomAuthHeaders = headers;
    this.axiomAuthHeadersUpdatedAt = Date.now();

    if (headers.cookie) {
      const pairs = headers.cookie.split(';').map(s => s.trim());
      for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 0) continue;
        const name = pair.substring(0, eqIdx);
        const value = pair.substring(eqIdx + 1);
        const existing = this.axiomCookies.find(c => c.name === name);
        if (existing) {
          existing.value = value;
        } else {
          this.axiomCookies.push({ name, value, domain: '.axiom.trade', path: '/', httpOnly: false, secure: true });
        }
      }
      this.axiomCookiesUpdatedAt = Date.now();
    }
    this.axiomConnected = true;
    this.logger.debug(`[Browser] Axiom auth headers captured from browser (keys: ${Object.keys(headers).join(', ')})`);
  }

hasAxiomAuthHeaders(): boolean {
    return Object.keys(this.axiomAuthHeaders).length > 0 && (Date.now() - this.axiomAuthHeadersUpdatedAt < 300_000);
  }

hasAxiomCookies(): boolean {
    const hasAuth = this.axiomCookies.some(c => c.name === 'auth-access-token' || c.name === 'auth-refresh-token');
    return hasAuth && (Date.now() - this.axiomCookiesUpdatedAt < 300_000);
  }

private getAxiomCookieHeader(): string {
    return this.axiomCookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

private async ensureAxiomAccessToken(): Promise<void> {

    const hasAccess = this.axiomCookies.some(c => c.name === 'auth-access-token');
    if (hasAccess && Date.now() - this.axiomAccessTokenRefreshedAt < 240_000) return;

    const refreshCookie = this.axiomCookies.find(c => c.name === 'auth-refresh-token');
    if (!refreshCookie) return;

    try {
            const resp = await fetch('https://api.axiom.trade/refresh-token', {
                method: 'POST',
        headers: {
          'Cookie': `auth-refresh-token=${refreshCookie.value}`,
          'Referer': 'https://axiom.trade/',
          'Origin': 'https://axiom.trade',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) {
        this.logger.warn(`[Browser] Axiom token refresh failed: ${resp.status}`);
        return;
      }

      const setCookies = resp.headers.getSetCookie?.() || [];
      for (const sc of setCookies) {
        const match = sc.match(/^([^=]+)=([^;]*)/);
        if (match) {
          const [, name, value] = match;
          const existing = this.axiomCookies.find(c => c.name === name);
          if (existing) {
            existing.value = value;
          } else {
            this.axiomCookies.push({
              name,
              value,
              domain: '.axiom.trade',
              path: '/',
              httpOnly: name.startsWith('auth-'),
              secure: true,
            });
          }
        }
      }

      try {
        const body = await resp.json() as any;
        if (body?.accessToken) {
          const existing = this.axiomCookies.find(c => c.name === 'auth-access-token');
          if (existing) {
            existing.value = body.accessToken;
          } else {
            this.axiomCookies.push({
              name: 'auth-access-token',
              value: body.accessToken,
              domain: '.axiom.trade',
              path: '/',
              httpOnly: true,
              secure: true,
            });
          }
        }
      } catch {}
      this.axiomAccessTokenRefreshedAt = Date.now();
      this.logger.debug(`[Browser] Axiom access token refreshed (cookies: ${this.axiomCookies.map(c => c.name).join(', ')})`);
    } catch (err: any) {
      this.logger.warn(`[Browser] Axiom token refresh error: ${err.message}`);
    }
  }

async captureAxiomCookiesViaCDP(): Promise<boolean> {
    if (!this.mainBrowser?.connected) return false;
    let page: Page | null = null;
    let created = false;
    try {
      const pages = await this.mainBrowser.pages();
      page = pages.find(p => { try { return p.url().includes('axiom.trade'); } catch { return false; } }) || null;
      if (!page) {
        this.logger.debug('[Browser] No axiom.trade tab open — skipping CDP cookie capture');
        return false;
      }

      const cdp = await page.createCDPSession();


      let cookieCaptured = false;
      try {
        const { cookies } = await cdp.send('Network.getCookies', {
          urls: [
            'https://axiom.trade',
            'https://api.axiom.trade',
            'https://api10.axiom.trade',
            'https://api9.axiom.trade',
          ],
        }) as any;
        if (cookies?.length) {
          for (const c of cookies) {
            const existing = this.axiomCookies.find(ec => ec.name === c.name);
            if (existing) existing.value = c.value;
            else this.axiomCookies.push({
              name: c.name, value: c.value,
              domain: c.domain || '.axiom.trade', path: c.path || '/',
              httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
            });
          }
          this.axiomCookiesUpdatedAt = Date.now();
          const hasAccess = cookies.some((c: any) => c.name === 'auth-access-token');
          const hasRefresh = cookies.some((c: any) => c.name === 'auth-refresh-token');
          if (hasAccess || hasRefresh) cookieCaptured = true;
          this.logger.debug(`[Browser] CDP cookies: ${cookies.map((c: any) => c.name).join(', ')} (access=${hasAccess}, refresh=${hasRefresh})`);
        }
      } catch {}


      let headersCaptured = false;
      try {
        await cdp.send('Network.enable');
        headersCaptured = await new Promise<boolean>((resolve) => {
          let done = false;
          const onRequest = (params: any) => {
            if (done) return;
            const url: string = params.request?.url || '';
            if (url.includes('axiom.trade/') && (url.includes('/api') || url.includes('api.axiom') || url.includes('api10.axiom') || url.includes('api9.axiom'))) {
              const reqHeaders = params.request?.headers || {};
              const cookie = reqHeaders['Cookie'] || reqHeaders['cookie'] || '';
              const auth = reqHeaders['Authorization'] || reqHeaders['authorization'] || '';
              if (cookie || auth) {
                done = true;
                cdp.off('Network.requestWillBeSent', onRequest);

                const captured: Record<string, string> = {};
                if (cookie) captured.cookie = cookie;
                if (auth) captured.authorization = auth;
                this.axiomAuthHeaders = captured;
                this.axiomAuthHeadersUpdatedAt = Date.now();

                if (cookie) {
                  for (const pair of cookie.split(';')) {
                    const [name, ...rest] = pair.trim().split('=');
                    if (!name) continue;
                    const value = rest.join('=');
                    const existing = this.axiomCookies.find(c => c.name === name);
                    if (existing) existing.value = value;
                    else this.axiomCookies.push({
                      name, value, domain: '.axiom.trade', path: '/',
                      httpOnly: name.startsWith('auth-'), secure: true,
                    });
                  }
                  this.axiomCookiesUpdatedAt = Date.now();
                }
                this.logger.info(`[Browser] ✓ Axiom auth headers intercepted via CDP (cookie=${cookie.length}ch, auth=${auth ? 'yes' : 'no'})`);
                resolve(true);
              }
            }
          };
          cdp.on('Network.requestWillBeSent', onRequest);

          page!.evaluate(`(async () => {
            try { await fetch('https://api.axiom.trade/lighthouse?v=' + Date.now(), { credentials: 'include' }); } catch {}
          })()`).catch(() => {});

          setTimeout(() => {
            if (!done) {
              done = true;
              cdp.off('Network.requestWillBeSent', onRequest);
              resolve(false);
            }
          }, 5000);
        });
      } catch (err: any) {
        this.logger.debug(`[Browser] CDP header intercept failed: ${err.message}`);
      }

      try { await cdp.send('Network.disable').catch(() => {}); } catch {}
      await cdp.detach().catch(() => {});


      if (created && !headersCaptured && !cookieCaptured && page) {
        await page.close().catch(() => {});
      }

      const hasAccess = this.axiomCookies.some(c => c.name === 'auth-access-token');
      if (headersCaptured || cookieCaptured) {
        this.logger.info(`[Browser] ✓ Axiom CDP auth captured: headers=${headersCaptured}, cookies=${cookieCaptured}, accessToken=${hasAccess}`);
        return true;
      }
      return false;
    } catch (err: any) {
      this.logger.debug(`[Browser] captureAxiomCookiesViaCDP failed: ${err.message}`);
      if (created && page) try { await page.close(); } catch {}
      return false;
    }
  }

startAxiomCookieRefresh(): void {
    if (this.axiomCdpCookieTimer) return;

    this.captureAxiomCookiesViaCDP().catch(() => {});
    this.axiomCdpCookieTimer = setInterval(() => {
      if (this.mainBrowser?.connected) {
        this.captureAxiomCookiesViaCDP().catch(() => {});
      }
    }, 60_000);
    this.logger.info('[Browser] Axiom CDP cookie refresh started (every 60s)');
  }

  stopAxiomCookieRefresh(): void {
    if (this.axiomCdpCookieTimer) {
      clearInterval(this.axiomCdpCookieTimer);
      this.axiomCdpCookieTimer = null;
    }
  }

startCdpReconnectLoop(): void {
    if (this.cdpReconnectTimer) return;
    this.cdpReconnectTimer = setInterval(async () => {

      if (this.mainBrowser?.connected) {
        this.stopCdpReconnectLoop();
        return;
      }
      try {
        const detect = await this.detectMainBrowser();
        if (!detect.available || !detect.wsEndpoint) return;

        this.mainBrowser = await (await import('puppeteer')).default.connect({
          browserWSEndpoint: detect.wsEndpoint,
          defaultViewport: null,
        });
        this.mainBrowser.on('disconnected', () => {
          this.mainBrowser = null;
          this.axiomConnected = false;
          this.gmgnConnected = false;
          this.stopAxiomCookieRefresh();
          this.logger.info('[Browser] Main browser disconnected — will retry CDP in background');

          this.startCdpReconnectLoop();
        });

        this.axiomConnected = true;
        this.gmgnConnected = true;
        this.logger.info(`[Browser] ✓ CDP auto-reconnected to Chrome (${detect.browser})`);


        this.extractMainBrowserTwitterCookies().catch(() => {});


        this.startAxiomCookieRefresh();


        this.stopCdpReconnectLoop();
      } catch (err: any) {
        this.logger.debug(`[Browser] CDP reconnect attempt failed: ${err.message}`);
      }
    }, 15_000);
    this.logger.info('[Browser] CDP reconnect loop started (every 15s)');
  }

  stopCdpReconnectLoop(): void {
    if (this.cdpReconnectTimer) {
      clearInterval(this.cdpReconnectTimer);
      this.cdpReconnectTimer = null;
    }
  }

async axiomDirectFetch(url: string): Promise<any> {

    const hdrs: Record<string, string> = {
      'Referer': 'https://axiom.trade/',
      'Origin': 'https://axiom.trade',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
    if (this.hasAxiomAuthHeaders()) {

      if (this.axiomAuthHeaders.cookie) hdrs['Cookie'] = this.axiomAuthHeaders.cookie;
      if (this.axiomAuthHeaders.authorization) hdrs['Authorization'] = this.axiomAuthHeaders.authorization;
    } else {

      await this.ensureAxiomAccessToken();
      hdrs['Cookie'] = this.getAxiomCookieHeader();
    }

    const resp = await fetch(url, { headers: hdrs });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      this.logger.warn(`[Browser] axiomDirectFetch ${resp.status} for ${url.split('?')[0]} — ${body.slice(0, 200)}`);
      return null;
    }
    return resp.json();
  }

async getAxiomHeadlessPage(url: string, waitSelector?: string, timeout = 15000): Promise<Page> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();
    try {
      const cookies = this.axiomCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.axiom.trade',
        path: c.path || '/',
        httpOnly: c.httpOnly,
        secure: c.secure,
      }));
      if (cookies.length) await page.setCookie(...cookies);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      if (waitSelector) await page.waitForSelector(waitSelector, { timeout }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      return page;
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
  }

private async getHeadlessBrowser(): Promise<Browser> {

    if (this.loginWindowOpen) {
      throw new Error('Login window is open — close it first before fetching content');
    }
    if (this.browser?.connected) return this.browser;
    this.browser = await puppeteer.launch({
      headless: true,
      userDataDir: this.userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    this.browser.on('disconnected', () => { this.browser = null; });
    return this.browser;
  }

private async injectTwitterCookies(page: Page): Promise<void> {
    const raw = process.env.TWITTER_COOKIES;
    if (!raw) return;
    const cookies: { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }[] = [];
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name && value) {
        cookies.push({ name, value, domain: '.x.com', path: '/', httpOnly: true, secure: true });
      }
    }
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }
  }

async openTwitterLogin(): Promise<{ success: boolean; message: string }> {
    try {

      await this.closeHeadless();

      if (this.loginBrowser?.connected) {
        return { success: true, message: 'Login window is already open' };
      }

      this.loginWindowOpen = true;
      this.loginBrowser = await puppeteer.launch({
        headless: false,
        userDataDir: this.userDataDir,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--start-maximized',
          '--no-first-run',
          '--no-default-browser-check',

          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--disable-features=IsolateOrigins,site-per-process',
          '--flag-switches-begin',
          '--flag-switches-end',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      });

      const pages = await this.loginBrowser.pages();
      const page = pages[0] || await this.loginBrowser.newPage();


      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });

        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en', 'ru'],
        });

        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : originalQuery(parameters);
      });

      await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

      this.logger.info('[Browser] Login window opened — waiting for user to log in');


      this.monitorLogin(page);


      this.loginBrowser.on('disconnected', () => {
        this.loginWindowOpen = false;
        this.loginBrowser = null;
        this.logger.info('[Browser] Login window closed');
      });

      return { success: true, message: 'Browser opened — log into Twitter and close the window when done.' };
    } catch (err: any) {
      this.loginWindowOpen = false;
      this.loginBrowser = null;
      return { success: false, message: err.message };
    }
  }

private async monitorLogin(page: Page): Promise<void> {
    try {

      const checkInterval = setInterval(async () => {
        try {
          if (!page || page.isClosed()) {
            clearInterval(checkInterval);
            return;
          }
          const url = page.url();
          if (url && !url.includes('/login') && !url.includes('/i/flow/login') && url.includes('x.com')) {
            clearInterval(checkInterval);
            this.twitterLoggedIn = true;
            this.logger.info('[Browser] Twitter login detected!');


            await this.extractAndSaveTwitterCookies(page);


            setTimeout(async () => {
              try {
                if (this.loginBrowser?.connected) {
                  await this.loginBrowser.close();
                }
              } catch {}
              this.loginWindowOpen = false;
              this.loginBrowser = null;
            }, 3000);
          }
        } catch {
          clearInterval(checkInterval);
        }
      }, 2000);


      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.loginBrowser?.connected) {
          this.logger.warn('[Browser] Login timeout — closing window');
          this.loginBrowser.close().catch(() => {});
        }
        this.loginWindowOpen = false;
        this.loginBrowser = null;
      }, 5 * 60 * 1000);
    } catch {}
  }

private async extractAndSaveTwitterCookies(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies('https://x.com');
      const authToken = cookies.find(c => c.name === 'auth_token')?.value;
      const ct0 = cookies.find(c => c.name === 'ct0')?.value;

      if (authToken && ct0) {
        const cookieStr = `auth_token=${authToken}; ct0=${ct0}`;
        process.env.TWITTER_COOKIES = cookieStr;
        this.logger.info('[Browser] Twitter cookies extracted and saved to env');


        try {
          const { getRuntime } = require('../runtime');
          const runtime = getRuntime?.();
          if (runtime?.setTwitterCookies) {
            runtime.setTwitterCookies(cookieStr);
            this.logger.info('[Browser] Twitter cookies persisted to disk');
          }
        } catch {}
      } else {
        this.logger.warn('[Browser] Could not find auth_token or ct0 in cookies');

        if (authToken) {
          process.env.TWITTER_COOKIES = `auth_token=${authToken}`;
          this.logger.info('[Browser] Partial cookies saved (auth_token only, ct0 missing)');
        }
      }
    } catch (err: any) {
      this.logger.warn('[Browser] Failed to extract cookies:', err.message);
    }
  }

async checkTwitterLogin(): Promise<boolean> {
    try {
      const browser = await this.getHeadlessBrowser();
      const page = await browser.newPage();
      await this.injectTwitterCookies(page);
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 15000 });
      const url = page.url();
      const loggedIn = !url.includes('/login') && !url.includes('/i/flow/login');

      if (loggedIn) {
        await this.extractAndSaveTwitterCookies(page);
        this.twitterLoggedIn = true;
      } else {
        this.twitterLoggedIn = false;
      }

      await page.close();
      return loggedIn;
    } catch {
      return false;
    }
  }

async fetchTweet(tweetUrl: string): Promise<any> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      await this.injectTwitterCookies(page);
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 20000 });


      if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
        await page.close();
        this.twitterLoggedIn = false;
        return { error: 'Not logged into Twitter. Use the login button in settings first.' };
      }


      await page.waitForSelector('[data-testid="tweetText"], [data-testid="tweet"]', { timeout: 10000 });


      await new Promise(r => setTimeout(r, 1500));

      const tweetData = await page.evaluate(() => {

        const parseNum = (text: string | null): number => {
          if (!text) return 0;
          const m = text.match(/([\d,.]+[KkMm]?)/);
          if (!m) return 0;
          let s = m[1].replace(/,/g, '');
          if (/[Kk]$/.test(s)) return Math.round(parseFloat(s) * 1000);
          if (/[Mm]$/.test(s)) return Math.round(parseFloat(s) * 1000000);
          return parseInt(s) || 0;
        };


        const tweetTextEl = document.querySelector('article [data-testid="tweetText"]');
        const fullText = tweetTextEl?.textContent || '';


        const article = document.querySelector('article[data-testid="tweet"]');
        let displayName = '';
        let username = '';
        let dateStr = '';

        if (article) {
          const userNameContainer = article.querySelector('[data-testid="User-Name"]');
          if (userNameContainer) {
            const spans = userNameContainer.querySelectorAll('span');
            spans.forEach(span => {
              const text = span.textContent || '';
              if (text.startsWith('@')) username = text.slice(1);
            });

            const firstLink = userNameContainer.querySelector('a span');
            if (firstLink) displayName = firstLink.textContent || '';
          }


          const timeEl = article.querySelector('time');
          dateStr = timeEl?.getAttribute('datetime') || timeEl?.textContent || '';
        }


        const getMetric = (testId: string): number => {
          const el = article?.querySelector(`[data-testid="${testId}"]`);
          if (!el) return 0;
          const ariaLabel = el.getAttribute('aria-label') || '';
          if (ariaLabel) return parseNum(ariaLabel);
          return parseNum(el.textContent);
        };

        const likes = getMetric('like');
        const retweets = getMetric('retweet');
        const replies = getMetric('reply');


        let views = 0;
        const viewsLink = article?.querySelector('a[href*="/analytics"]');
        if (viewsLink) views = parseNum(viewsLink.textContent);


        const mediaElements: { type: string; url: string }[] = [];
        article?.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(img => {
          const src = img.getAttribute('src');
          if (src) mediaElements.push({ type: 'photo', url: src });
        });
        article?.querySelectorAll('video').forEach(vid => {
          const src = vid.getAttribute('src') || vid.querySelector('source')?.getAttribute('src');
          if (src) mediaElements.push({ type: 'video', url: src });
        });


        const links: { text: string; url: string }[] = [];
        tweetTextEl?.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') || '';
          const text = a.textContent || '';
          if (href && !href.startsWith('/') && !href.includes('x.com')) {
            links.push({ text, url: href });
          }
        });


        let quotedTweet = null;
        const qtEl = article?.querySelector('[data-testid="quoteTweet"]') ||
                      article?.querySelector('[role="link"][tabindex="0"]');
        if (qtEl) {
          const qtText = qtEl.querySelector('[data-testid="tweetText"]')?.textContent || '';
          if (qtText && qtText !== fullText) {
            quotedTweet = { fullText: qtText };
          }
        }

        return {
          fullText,
          author: { username, displayName },
          date: dateStr,
          engagement: { likes, retweets, replies, views },
          media: mediaElements.length > 0 ? mediaElements : undefined,
          links: links.length > 0 ? links : undefined,
          quotedTweet,
          source: 'browser',
        };
      });

      await page.close();
      return tweetData;
    } catch (err: any) {
      try { await page.close(); } catch {}
      return { error: err.message, source: 'browser' };
    }
  }

async fetchTwitterProfile(profileUrl: string): Promise<any> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
        await page.close();
        this.twitterLoggedIn = false;
        return { error: 'Not logged into Twitter. Use the login button in settings first.' };
      }


      await page.waitForSelector('[data-testid="UserName"], [data-testid="UserDescription"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 1500));

      const profileData = await page.evaluate(() => {
        const parseNum = (text: string | null): number => {
          if (!text) return 0;
          const m = text.match(/([\d,.]+[KkMm]?)/);
          if (!m) return 0;
          let s = m[1].replace(/,/g, '');
          if (/[Kk]$/.test(s)) return Math.round(parseFloat(s) * 1000);
          if (/[Mm]$/.test(s)) return Math.round(parseFloat(s) * 1000000);
          return parseInt(s) || 0;
        };


        const nameEl = document.querySelector('[data-testid="UserName"]');
        let displayName = '';
        let username = '';
        if (nameEl) {
          const spans = nameEl.querySelectorAll('span');
          spans.forEach(span => {
            const text = span.textContent || '';
            if (text.startsWith('@')) username = text.slice(1);
          });
          const firstSpan = nameEl.querySelector('span span');
          if (firstSpan) displayName = firstSpan.textContent || '';
        }

        const bio = document.querySelector('[data-testid="UserDescription"]')?.textContent || '';


        const links = document.querySelectorAll('a[href*="/followers"], a[href*="/following"], a[href*="/verified_followers"]');
        let followers = 0;
        let following = 0;
        links.forEach(link => {
          const href = link.getAttribute('href') || '';
          const text = link.textContent || '';
          if (href.endsWith('/followers') || href.endsWith('/verified_followers')) followers = parseNum(text);
          if (href.endsWith('/following')) following = parseNum(text);
        });


        const verified = !!document.querySelector('[data-testid="icon-verified"]');


        const tweets: { text: string; date: string; likes: number; retweets: number }[] = [];
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach((article, i) => {
          if (i >= 10) return;
          const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';
          const time = article.querySelector('time');
          const date = time?.getAttribute('datetime') || time?.textContent || '';

          const getMetric = (testId: string): number => {
            const el = article.querySelector(`[data-testid="${testId}"]`);
            if (!el) return 0;
            return parseNum(el.getAttribute('aria-label') || el.textContent);
          };

          if (text) {
            tweets.push({
              text: text.slice(0, 500),
              date,
              likes: getMetric('like'),
              retweets: getMetric('retweet'),
            });
          }
        });

        return {
          username,
          displayName,
          bio,
          followers,
          following,
          verified,
          recentTweets: tweets,
          source: 'browser',
        };
      });

      await page.close();
      return profileData;
    } catch (err: any) {
      try { await page.close(); } catch {}
      return { error: err.message, source: 'browser' };
    }
  }

async searchTwitter(query: string, maxResults = 20): Promise<any[]> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      await this.injectTwitterCookies(page);
      await page.setViewport({ width: 1280, height: 900 });


      const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&f=top`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
        await page.close();
        this.twitterLoggedIn = false;
        return [{ error: 'Not logged into Twitter. Use the login button in settings first.' }];
      }

      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await new Promise(r => setTimeout(r, 1000));
      }

      const results = await page.evaluate((limit: number) => {
        const parseNum = (text: string | null): number => {
          if (!text) return 0;
          const m = text.match(/([\d,.]+[KkMm]?)/);
          if (!m) return 0;
          let s = m[1].replace(/,/g, '');
          if (/[Kk]$/.test(s)) return Math.round(parseFloat(s) * 1000);
          if (/[Mm]$/.test(s)) return Math.round(parseFloat(s) * 1000000);
          return parseInt(s) || 0;
        };

        const tweets: any[] = [];
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach((article, i) => {
          if (i >= limit) return;
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const text = textEl?.textContent || '';
          if (!text) return;

          let username = '';
          let displayName = '';
          const userNameContainer = article.querySelector('[data-testid="User-Name"]');
          if (userNameContainer) {
            const spans = userNameContainer.querySelectorAll('span');
            spans.forEach(span => {
              const t = span.textContent || '';
              if (t.startsWith('@')) username = t.slice(1);
            });
            const firstLink = userNameContainer.querySelector('a span');
            if (firstLink) displayName = firstLink.textContent || '';
          }

          const timeEl = article.querySelector('time');
          const date = timeEl?.getAttribute('datetime') || timeEl?.textContent || '';

          const getMetric = (testId: string): number => {
            const el = article.querySelector(`[data-testid="${testId}"]`);
            if (!el) return 0;
            return parseNum(el.getAttribute('aria-label') || el.textContent);
          };

          const tweetLink = article.querySelector('a[href*="/status/"]');
          const tweetUrl = tweetLink ? 'https://x.com' + tweetLink.getAttribute('href') : '';

          tweets.push({
            text: text.slice(0, 500),
            author: { username, displayName },
            date,
            likes: getMetric('like'),
            retweets: getMetric('retweet'),
            replies: getMetric('reply'),
            url: tweetUrl,
          });
        });

        return tweets;
      }, maxResults);

      await page.close();
      return results;
    } catch (err: any) {
      try { await page.close(); } catch {}
      return [{ error: err.message }];
    }
  }

  async fetchPage(url: string): Promise<{ title: string; text: string; url: string }> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

      const result = await page.evaluate(() => {

        document.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return {
          title: document.title || '',
          text: (document.body?.innerText || '').slice(0, 15000),
          url: window.location.href,
        };
      });

      await page.close();
      return result;
    } catch (err: any) {
      try { await page.close(); } catch {}
      return { title: '', text: `Error: ${err.message}`, url };
    }
  }

  private async closeHeadless(): Promise<void> {
    if (this.browser?.connected) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

async detectMainBrowser(): Promise<{ available: boolean; browser?: string; wsEndpoint?: string }> {
    const host = BrowserService.CDP_HOST;
    const localAppData = process.env.LOCALAPPDATA || '';
    const appData = process.env.APPDATA || '';
    const dataDirs: { name: string; dir: string }[] = [
      { name: 'Chrome', dir: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
      { name: 'Chrome', dir: path.join(localAppData, 'Google', 'ChromeDebug') },
      { name: 'Edge', dir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Brave', dir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { name: 'Opera', dir: path.join(appData, 'Opera Software', 'Opera Stable') },
      { name: 'Opera GX', dir: path.join(appData, 'Opera Software', 'Opera GX Stable') },
      { name: 'Vivaldi', dir: path.join(localAppData, 'Vivaldi', 'User Data') },
      { name: 'Chromium', dir: path.join(localAppData, 'Chromium', 'User Data') },
    ];

    for (const { name, dir } of dataDirs) {
      try {
        const portFile = path.join(dir, 'DevToolsActivePort');
        if (!fs.existsSync(portFile)) continue;
        const content = fs.readFileSync(portFile, 'utf-8').trim();
        const lines = content.split('\n');
        if (lines.length < 2) continue;
        const port = parseInt(lines[0].trim(), 10);
        const wsPath = lines[1].trim();
        if (!port || !wsPath.startsWith('/devtools/browser/')) continue;

        const httpOk = await fetch(`http://${host}:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        }).then(r => r.ok).catch(() => false);
        if (httpOk) {
          const wsEndpoint = `ws://${host}:${port}${wsPath}`;
          this.logger.info(`[Browser] CDP auto-detected via DevToolsActivePort: ${name} on port ${port}`);
          return { available: true, browser: name, wsEndpoint };
        }
        this.logger.debug(`[Browser] DevToolsActivePort found for ${name} (port ${port}) but HTTP /json/version not available`);
      } catch {  }
    }

    const probePorts = [9222, 9229, 9333, 9515, 9223, 9224, 9225];
    for (const port of probePorts) {
      const result = await this.tryCdpPort(host, port);
      if (result) return result;
    }

    const dynamicPorts = this.getListeningPorts();
    const skip = new Set([...probePorts, 80, 443, 3377, 3388, 3390, 11434]);
    for (const port of dynamicPorts) {
      if (skip.has(port)) continue;
      const result = await this.tryCdpPort(host, port);
      if (result) {
        this.logger.info(`[Browser] CDP auto-discovered on dynamic port ${port}`);
        return result;
      }
    }

    return { available: false };
  }

  private async tryCdpPort(host: string, port: number): Promise<{ available: boolean; browser: string; wsEndpoint: string } | null> {
    try {
      const resp = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(1200),
      });
      if (resp.ok) {
        const info = await resp.json() as any;
        if (info.webSocketDebuggerUrl) {
          return { available: true, browser: info.Browser || 'Unknown', wsEndpoint: info.webSocketDebuggerUrl };
        }
      }
    } catch {  }
    return null;
  }

  private getListeningPorts(): number[] {
    try {
      if (process.platform === 'win32') {
        const out = execSync(
          'powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"',
          { timeout: 5000, encoding: 'utf-8' }
        );
        return out.trim().split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(p => p > 1024 && p < 65536);
      } else {
        const out = execSync(
          "ss -tlnH 2>/dev/null || netstat -tlnp 2>/dev/null | awk '{print $4}'",
          { timeout: 5000, encoding: 'utf-8' }
        );
        const ports = new Set<number>();
        for (const line of out.trim().split('\n')) {
          const m = line.match(/:(\d+)\s*$/);
          if (m) { const p = parseInt(m[1], 10); if (p > 1024 && p < 65536) ports.add(p); }
        }
        return [...ports].sort((a, b) => a - b);
      }
    } catch {
      return [];
    }
  }

async connectMainBrowser(): Promise<{ success: boolean; message: string; twitterLoggedIn?: boolean }> {
    try {

      if (this.mainBrowser?.connected) {
        return { success: true, message: 'Already connected to main browser' };
      }


      const detect = await this.detectMainBrowser();
      if (!detect.available || !detect.wsEndpoint) {


        this.startCdpReconnectLoop();
        if (this.hasAxiomCookies()) {
          this.axiomConnected = true;
          this.logger.info('[Browser] CDP unavailable, cookies via extension. Reconnect loop started — will auto-connect when Chrome opens.');
          return {
            success: true,
            message: 'CDP unavailable — reconnect loop started. Axiom API available via extension cookies. CDP will auto-connect when Chrome starts.'
          };
        }
        return {
          success: false,
          message: 'Chrome CDP not available — reconnect loop started. Will auto-detect when any Chromium browser starts with remote debugging enabled.'
        };
      }

      this.mainBrowser = await puppeteer.connect({
        browserWSEndpoint: detect.wsEndpoint,
        defaultViewport: null,
      });

      this.mainBrowser.on('disconnected', () => {
        this.mainBrowser = null;
        this.axiomConnected = false;
        this.gmgnConnected = false;
        this.stopAxiomCookieRefresh();
        this.logger.info('[Browser] Main browser disconnected');
      });


      this.axiomConnected = true;
      this.gmgnConnected = true;

      this.logger.info(`[Browser] Connected to main browser: ${detect.browser} (Axiom + GMGN auto-enabled)`);


      const twitterOk = await this.extractMainBrowserTwitterCookies();


      this.startAxiomCookieRefresh();

      return {
        success: true,
        message: `Connected to ${detect.browser} — all services available` + (twitterOk ? ', Twitter cookies extracted!' : ''),
        twitterLoggedIn: twitterOk,
      };
    } catch (err: any) {
      this.mainBrowser = null;

      this.startCdpReconnectLoop();

      if (this.hasAxiomCookies()) {
        this.axiomConnected = true;
        return { success: true, message: 'CDP failed but Axiom cookies available via extension. Will auto-reconnect CDP.' };
      }
      return { success: false, message: err.message };
    }
  }

async disconnectMainBrowser(): Promise<void> {
    this.stopAxiomCookieRefresh();
    this.stopCdpReconnectLoop();
    if (this.mainBrowser?.connected) {
      this.mainBrowser.disconnect();
    }
    this.mainBrowser = null;
    this.axiomConnected = false;
    this.gmgnConnected = false;
    this.logger.info('[Browser] Disconnected from main browser (all services)');
  }

async extractMainBrowserTwitterCookies(): Promise<boolean> {
    if (!this.mainBrowser?.connected) return false;

    let page: Page | null = null;
    let createdNewPage = false;
    try {

      const pages = await this.mainBrowser.pages();
      page = pages.find(p => {
        try { return p.url().includes('x.com') || p.url().includes('twitter.com'); }
        catch { return false; }
      }) || null;

      if (!page) {

        page = await this.mainBrowser.newPage();
        createdNewPage = true;
        await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      }


      const client = await page.createCDPSession();
      const { cookies } = await client.send('Network.getCookies', { urls: ['https://x.com', 'https://twitter.com'] }) as any;
      await client.detach();

      const authToken = cookies.find((c: any) => c.name === 'auth_token')?.value;
      const ct0 = cookies.find((c: any) => c.name === 'ct0')?.value;

      if (createdNewPage && page) {
        await page.close().catch(() => {});
      }

      if (authToken && ct0) {
        const cookieStr = `auth_token=${authToken}; ct0=${ct0}`;
        process.env.TWITTER_COOKIES = cookieStr;
        this.twitterLoggedIn = true;
        this.logger.info('[Browser] Twitter cookies extracted from main browser');


        try {
          const { getRuntime } = require('../runtime');
          const runtime = getRuntime?.();
          if (runtime?.setTwitterCookies) {
            runtime.setTwitterCookies(cookieStr);
            this.logger.info('[Browser] Twitter cookies persisted to disk');
          }
        } catch {}

        return true;
      } else {
        this.logger.warn('[Browser] No Twitter auth cookies found in main browser. Are you logged in on x.com?');
        if (authToken) {
          process.env.TWITTER_COOKIES = `auth_token=${authToken}`;
          this.twitterLoggedIn = true;
          return true;
        }
        return false;
      }
    } catch (err: any) {
      this.logger.warn('[Browser] Failed to extract cookies from main browser:', err.message);
      if (createdNewPage && page) {
        try { await page.close(); } catch {}
      }
      return false;
    }
  }


async connectAxiom(): Promise<{ success: boolean; message: string; loggedIn?: boolean }> {
    try {
      if (!this.mainBrowser?.connected) {
        const detect = await this.detectMainBrowser();
        if (!detect.available || !detect.wsEndpoint) {
          return { success: false, message: 'Chrome not detected. Connect via Main Browser in Twitter section first, or enable chrome://inspect/#remote-debugging' };
        }
        this.mainBrowser = await puppeteer.connect({ browserWSEndpoint: detect.wsEndpoint, defaultViewport: null });
        this.mainBrowser.on('disconnected', () => { this.mainBrowser = null; this.axiomConnected = false; this.gmgnConnected = false; });
      }
      const loggedIn = await this.checkAxiomSession();
      this.axiomConnected = true;
      return { success: true, message: loggedIn ? 'Axiom connected — session active' : 'Connected. Log into axiom.trade in Chrome, then click Check Session.', loggedIn };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async disconnectAxiom(): Promise<void> {
    this.axiomConnected = false;
    this.logger.info('[Browser] Axiom disconnected');
  }

  async checkAxiomSession(): Promise<boolean> {
    if (this.hasAxiomCookies() || this.hasAxiomAuthHeaders()) {
      try {
        const data = await this.axiomDirectFetch(`https://api.axiom.trade/lighthouse?v=${Date.now()}`);
        if (data != null) return true;
      } catch {}
    }
    if (this.mainBrowser?.connected) {
      const captured = await this.captureAxiomCookiesViaCDP();
      if (captured) return true;
    }
    return false;
  }

async scrapeAxiomToken(mint: string): Promise<any> {
    try {
      const pairAddr = await this.resolveAxiomPair(mint) || mint;
      const base = 'https://api.axiom.trade';
      const v = Date.now();
      const [topTraders, batchData] = await Promise.all([
        this.axiomDirectFetch(`${base}/top-traders-v5?pairAddress=${pairAddr}&onlyTrackedWallets=false&v=${v}`),
        this.axiomBatchTokenDataDirect(pairAddr),
      ]);
      return {
        mint,
        source: 'axiom',
        topTraders: Array.isArray(topTraders) ? topTraders : [],
        influencers: [],
        ...(batchData || {}),
      };
    } catch (err: any) {
      return { error: err.message, mint, source: 'axiom' };
    }
  }

  async axiomApiFetch(url: string): Promise<any> {
    if (this.hasAxiomCookies() || this.hasAxiomAuthHeaders()) {
      try {
        const data = await this.axiomDirectFetch(url);
        if (data != null) return data;
      } catch {}
    }
    if (this.mainBrowser?.connected) {
      await this.captureAxiomCookiesViaCDP();
      if (this.hasAxiomCookies() || this.hasAxiomAuthHeaders()) {
        try { return await this.axiomDirectFetch(url); } catch {}
      }
    }
    return null;
  }


  private pairAddressCache = new Map<string, { pair: string; ts: number }>();
  private static PAIR_CACHE_TTL = 5 * 60_000;

async resolveAxiomPair(mint: string): Promise<string | null> {

    const cached = this.pairAddressCache.get(mint);
    if (cached && Date.now() - cached.ts < BrowserService.PAIR_CACHE_TTL) return cached.pair;

    const direct = await this.resolveAxiomPairDirect(mint);
    if (direct) return direct;

    if (this.mainBrowser?.connected && !this.hasAxiomCookies() && !this.hasAxiomAuthHeaders()) {
      await this.captureAxiomCookiesViaCDP();
      return this.resolveAxiomPairDirect(mint);
    }

    return null;
  }

private async resolveAxiomPairDirect(mint: string): Promise<string | null> {
    const cached = this.pairAddressCache.get(mint);
    if (cached && Date.now() - cached.ts < BrowserService.PAIR_CACHE_TTL) return cached.pair;
    try {
      const v = Date.now();
      const domains = ['api.axiom.trade', 'api10.axiom.trade', 'api9.axiom.trade'];
      for (const domain of domains) {
        try {
          const url = `https://${domain}/search-v4?searchQuery=${encodeURIComponent(mint)}&isOg=false&isPumpSearch=false&isBonkSearch=false&isBagsSearch=false&isUsd1Search=false&onlyBonded=false&sortBy=trending&v=${v}`;
          const data = await this.axiomDirectFetch(url);
          if (Array.isArray(data) && data.length > 0) {
            const match = data.find((d: any) => d.tokenAddress === mint);
            const pairAddress = match?.pairAddress || data[0]?.pairAddress;
            if (pairAddress) {
              this.pairAddressCache.set(mint, { pair: pairAddress, ts: Date.now() });
              this.logger.debug(`[Browser] Resolved pair (direct) for ${mint.slice(0, 8)}…: ${pairAddress.slice(0, 8)}…`);
              return pairAddress;
            }
          }
        } catch { continue; }
      }
      return null;
    } catch (err: any) {
      this.logger.warn(`[Browser] resolveAxiomPairDirect failed: ${err.message}`);
      return null;
    }
  }

async axiomBatchTokenData(pairAddress: string): Promise<{
    tokenInfo: any;
    pairInfo: any;
    tokenAnalysis: any;
    kolTxns: any[];
    sniperTxns: any[];
    holderData: any[];
  } | null> {

    const direct = await this.axiomBatchTokenDataDirect(pairAddress);
    if (direct?.tokenInfo || direct?.pairInfo) return direct;

    if (this.mainBrowser?.connected && !this.hasAxiomCookies() && !this.hasAxiomAuthHeaders()) {
      await this.captureAxiomCookiesViaCDP();
      return this.axiomBatchTokenDataDirect(pairAddress);
    }

    return null;
  }

private async axiomBatchTokenDataDirect(pairAddress: string): Promise<{
    tokenInfo: any; pairInfo: any; tokenAnalysis: any; kolTxns: any[]; sniperTxns: any[]; holderData: any[];
  } | null> {
    try {
      const base = 'https://api.axiom.trade';
      const v = Date.now();
      const [tokenInfo, pairInfo, kolTxns, sniperTxns, holderData] = await Promise.all([
        this.axiomDirectFetch(`${base}/token-info?pairAddress=${pairAddress}&v=${v}`),
        this.axiomDirectFetch(`${base}/pair-info?pairAddress=${pairAddress}&v=${v + 1}`),
        this.axiomDirectFetch(`${base}/kol-transactions-v2?pairAddress=${pairAddress}&v=${v + 2}`),
        this.axiomDirectFetch(`${base}/sniper-transactions?pairAddress=${pairAddress}&v=${v + 3}`),
        this.axiomDirectFetch(`${base}/holder-data-v5?pairAddress=${pairAddress}&v=${v + 4}`),
      ]);
      let tokenAnalysis = null;
      if (pairInfo && pairInfo.deployerAddress && pairInfo.tokenTicker) {
        tokenAnalysis = await this.axiomDirectFetch(
          `${base}/token-analysis?devAddress=${pairInfo.deployerAddress}&tokenTicker=${encodeURIComponent(pairInfo.tokenTicker)}&pairAddress=${pairAddress}&v=${v + 5}`
        );
      }
      return { tokenInfo, pairInfo, tokenAnalysis, kolTxns: kolTxns || [], sniperTxns: sniperTxns || [], holderData: holderData || [] };
    } catch (err: any) {
      this.logger.warn(`[Browser] axiomBatchTokenDataDirect failed: ${err.message}`);
      return null;
    }
  }

async extractAxiomCookies(): Promise<string | null> {
    if (!this.mainBrowser?.connected) return null;
    try {
      const pages = await this.mainBrowser.pages();
      const page = pages.find(p => { try { return p.url().includes('axiom.trade'); } catch { return false; } }) || null;
      if (!page) return null;
      const client = await page.createCDPSession();
      const { cookies } = await client.send('Network.getCookies', {
        urls: ['https://axiom.trade', 'https://api.axiom.trade'],
      }) as any;
      await client.detach();
      if (!cookies?.length) return null;
      return cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    } catch (err: any) {
      this.logger.warn(`[Browser] extractAxiomCookies failed: ${err.message}`);
      return null;
    }
  }


  async connectGmgn(): Promise<{ success: boolean; message: string; loggedIn?: boolean }> {
    try {
      if (!this.mainBrowser?.connected) {
        const detect = await this.detectMainBrowser();
        if (!detect.available || !detect.wsEndpoint) {
          return { success: false, message: 'Chrome not detected. Enable chrome://inspect/#remote-debugging first.' };
        }
        this.mainBrowser = await puppeteer.connect({ browserWSEndpoint: detect.wsEndpoint, defaultViewport: null });
        this.mainBrowser.on('disconnected', () => { this.mainBrowser = null; this.axiomConnected = false; this.gmgnConnected = false; });
      }
      const loggedIn = await this.checkGmgnSession();
      this.gmgnConnected = true;
      return { success: true, message: loggedIn ? 'GMGN connected — session active' : 'Connected. Log into gmgn.ai in Chrome, then click Check Session.', loggedIn };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async disconnectGmgn(): Promise<void> {
    this.gmgnConnected = false;
    this.logger.info('[Browser] GMGN disconnected');
  }

async captureGmgnWsUrl(): Promise<{ success: boolean; wsUrl?: string; message: string }> {
    if (!this.mainBrowser?.connected) {

      const detect = await this.detectMainBrowser();
      if (!detect.available || !detect.wsEndpoint) {
        return { success: false, message: 'Chrome not detected. Enable chrome://inspect/#remote-debugging first.' };
      }
      this.mainBrowser = await puppeteer.connect({ browserWSEndpoint: detect.wsEndpoint, defaultViewport: null });
      this.mainBrowser.on('disconnected', () => { this.mainBrowser = null; this.axiomConnected = false; this.gmgnConnected = false; });
    }

    let page: Page | null = null;
    let createdPage = false;
    try {

      const pages = await this.mainBrowser!.pages();
      page = pages.find(p => { try { return p.url().includes('gmgn.ai'); } catch { return false; } }) || null;

      if (!page) {
        page = await this.mainBrowser!.newPage();
        createdPage = true;
      }


      const cdp = await page.createCDPSession();

      return await new Promise<{ success: boolean; wsUrl?: string; message: string }>((resolve) => {
        let resolved = false;
        const cleanup = () => {
          if (createdPage && page) page.close().catch(() => {});
          cdp.detach().catch(() => {});
        };


        cdp.on('Network.webSocketCreated', (params: any) => {
          const url: string = params.url || '';
          if (!resolved && url.includes('gmgn.ai/ws')) {
            resolved = true;
            this.logger.info('[Browser] Captured GMGN WS URL: ' + url.slice(0, 80) + '...');
            cleanup();
            resolve({ success: true, wsUrl: url, message: 'WebSocket URL captured successfully' });
          }
        });

        cdp.send('Network.enable').then(() => {

          const currentUrl = page!.url();
          if (currentUrl.includes('gmgn.ai') && currentUrl.includes('/x/tracker')) {

            page!.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          } else {
            page!.goto('https://gmgn.ai/x/tracker', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
        }).catch(() => {});


        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ success: false, message: 'Timeout — no GMGN WebSocket detected. Make sure you are logged into gmgn.ai.' });
          }
        }, 20000);
      });
    } catch (err: any) {
      if (createdPage && page) try { page.close(); } catch {}
      return { success: false, message: err.message };
    }
  }

  async checkGmgnSession(): Promise<boolean> {
    if (!this.mainBrowser?.connected) return false;
    let page: Page | null = null;
    let created = false;
    try {
      const pages = await this.mainBrowser.pages();
      page = pages.find(p => { try { return p.url().includes('gmgn.ai'); } catch { return false; } }) || null;
      if (!page) {
        page = await this.mainBrowser.newPage();
        created = true;
        await page.goto('https://gmgn.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      const loggedIn = await page.evaluate(() => {

        const hasSidCookie = document.cookie.includes('sid=');
        let hasUserInfo = false;
        try { hasUserInfo = !!(localStorage.getItem('userInfo') || localStorage.getItem('accountInfo')); } catch {}

        const hasLoginBtn = !!(document.querySelector('button[class*="login"], button[class*="Login"], [class*="connect-wallet"]'));
        return (hasSidCookie || hasUserInfo) && !hasLoginBtn;
      });
      if (created && page) await page.close().catch(() => {});
      return loggedIn;
    } catch (err: any) {
      this.logger.warn('[Browser] GMGN session check failed:', err.message);
      if (created && page) try { await page.close(); } catch {}
      return false;
    }
  }

async scrapeGmgnToken(mint: string): Promise<any> {
    if (!this.mainBrowser?.connected) {
      return { error: 'Chrome not connected. Connect via Settings → Browser first.' };
    }
    let page: Page | null = null;
    try {
      page = await this.mainBrowser.newPage();
      await page.goto(`https://gmgn.ai/sol/token/${mint}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('table, [class*="holder"], [class*="trader"]', { timeout: 10000 }).catch(() => {});

      const data = await page.evaluate(() => {
        const results: any = { topHolders: [], smartMoney: [], kols: [], insiders: [], raw: '' };

        const holderRows = document.querySelectorAll('table tbody tr, [class*="holder-row"]');
        holderRows.forEach((row: any) => {
          const cells = row.querySelectorAll('td, [class*="cell"]');
          const texts = Array.from(cells).map((c: any) => c.innerText?.trim()).filter(Boolean);
          if (texts.length >= 2) {
            results.topHolders.push({
              address: texts[0] || '',
              percentage: texts[1] || '',
              value: texts[2] || '',
              extra: texts.slice(3).join(' | '),
            });
          }
        });

        const smartTags = document.querySelectorAll('[class*="smart"], [class*="kol"], [class*="whale"], [class*="insider"], [class*="influencer"]');
        smartTags.forEach((tag: any) => {
          const text = tag.innerText?.trim();
          const parent = tag.closest('tr, [class*="row"]');
          const parentText = parent?.innerText?.trim()?.slice(0, 300) || '';
          if (text) {
            const entry = { label: text, context: parentText };
            if (/smart/i.test(text)) results.smartMoney.push(entry);
            else if (/kol|influencer/i.test(text)) results.kols.push(entry);
            else if (/insider/i.test(text)) results.insiders.push(entry);
          }
        });
        results.raw = (document.body?.innerText || '').slice(0, 8000);
        return results;
      });

      await page.close().catch(() => {});
      return { mint, source: 'gmgn', ...data };
    } catch (err: any) {
      if (page) try { await page.close(); } catch {}
      return { error: err.message, mint, source: 'gmgn' };
    }
  }

  async shutdown(): Promise<void> {
    this.axiomConnected = false;
    this.gmgnConnected = false;
    await this.disconnectMainBrowser();
    if (this.loginBrowser?.connected) {
      await this.loginBrowser.close().catch(() => {});
      this.loginBrowser = null;
    }
    await this.closeHeadless();
    this.loginWindowOpen = false;
    this.logger.info('[Browser] Shutdown complete');
  }
}
