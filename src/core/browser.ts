/* eslint-disable @typescript-eslint/no-explicit-any */
// Browser evaluate() callbacks run in Chromium context (DOM available)
/// <reference lib="dom" />
import puppeteer, { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';

export interface BrowserStatus {
  running: boolean;
  twitterLoggedIn: boolean;
  loginWindowOpen: boolean;
}

/**
 * BrowserService — headless/visible browser for authenticated web browsing.
 * Uses persistent user data directory to maintain login sessions across restarts.
 * Twitter login: opens visible Chrome → user logs in → session auto-saved in profile.
 * Content fetch: headless Chrome with saved session navigates to pages.
 */
export class BrowserService {
  private browser: Browser | null = null;
  private loginBrowser: Browser | null = null;
  private userDataDir: string;
  private logger: any;
  private twitterLoggedIn = false;
  private loginWindowOpen = false;

  constructor(dataDir: string, logger: any) {
    this.userDataDir = path.join(dataDir, 'browser-profile');
    this.logger = logger;
    // Ensure directory exists
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }
  }

  getStatus(): BrowserStatus {
    return {
      running: !!(this.browser?.connected),
      twitterLoggedIn: this.twitterLoggedIn,
      loginWindowOpen: this.loginWindowOpen,
    };
  }

  /**
   * Launch headless browser with persistent profile (reuses login sessions).
   */
  private async getHeadlessBrowser(): Promise<Browser> {
    // Don't launch headless if login window is using the profile
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
      ],
    });
    this.browser.on('disconnected', () => { this.browser = null; });
    return this.browser;
  }

  /**
   * Open a VISIBLE browser window for user to log into Twitter.
   * The user data dir persists cookies, so login survives across restarts.
   */
  async openTwitterLogin(): Promise<{ success: boolean; message: string }> {
    try {
      // Close headless browser if running (can't share profile)
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
        ],
      });

      const page = await this.loginBrowser.newPage();
      await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

      this.logger.info('[Browser] Login window opened — waiting for user to log in');

      // Monitor for successful login (URL changes from /login to /home)
      this.monitorLogin(page);

      // Handle browser close
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

  /**
   * Monitor the login page — when URL changes from /login, login is complete.
   * Also extracts cookies and saves them as TWITTER_COOKIES env var for API fallback.
   */
  private async monitorLogin(page: Page): Promise<void> {
    try {
      // Poll URL every 2 seconds
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

            // Extract cookies for API fallback
            await this.extractAndSaveTwitterCookies(page);

            // Auto-close after short delay
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

      // Timeout after 5 minutes
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

  /**
   * Extract auth_token and ct0 from browser cookies and save to env.
   */
  private async extractAndSaveTwitterCookies(page: Page): Promise<void> {
    try {
      const cookies = await page.cookies('https://x.com');
      const authToken = cookies.find(c => c.name === 'auth_token')?.value;
      const ct0 = cookies.find(c => c.name === 'ct0')?.value;

      if (authToken && ct0) {
        const cookieStr = `auth_token=${authToken}; ct0=${ct0}`;
        process.env.TWITTER_COOKIES = cookieStr;
        this.logger.info('[Browser] Twitter cookies extracted and saved');
      }
    } catch (err: any) {
      this.logger.warn('[Browser] Failed to extract cookies:', err.message);
    }
  }

  /**
   * Check if Twitter session is active by navigating to home.
   */
  async checkTwitterLogin(): Promise<boolean> {
    try {
      const browser = await this.getHeadlessBrowser();
      const page = await browser.newPage();
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

  /**
   * Fetch a tweet via headless browser — returns structured tweet data.
   */
  async fetchTweet(tweetUrl: string): Promise<any> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      // Check for login redirect
      if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
        await page.close();
        this.twitterLoggedIn = false;
        return { error: 'Not logged into Twitter. Use the login button in settings first.' };
      }

      // Wait for tweet content to render
      await page.waitForSelector('[data-testid="tweetText"], [data-testid="tweet"]', { timeout: 10000 });

      // Small delay for engagement counters to load
      await new Promise(r => setTimeout(r, 1500));

      const tweetData = await page.evaluate(() => {
        // Helper: parse engagement number from aria-label like "123 Likes" or text
        const parseNum = (text: string | null): number => {
          if (!text) return 0;
          const m = text.match(/([\d,.]+[KkMm]?)/);
          if (!m) return 0;
          let s = m[1].replace(/,/g, '');
          if (/[Kk]$/.test(s)) return Math.round(parseFloat(s) * 1000);
          if (/[Mm]$/.test(s)) return Math.round(parseFloat(s) * 1000000);
          return parseInt(s) || 0;
        };

        // Tweet text
        const tweetTextEl = document.querySelector('article [data-testid="tweetText"]');
        const fullText = tweetTextEl?.textContent || '';

        // Author info from the first article (main tweet)
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
            // Display name is usually the first meaningful span
            const firstLink = userNameContainer.querySelector('a span');
            if (firstLink) displayName = firstLink.textContent || '';
          }

          // Date/time
          const timeEl = article.querySelector('time');
          dateStr = timeEl?.getAttribute('datetime') || timeEl?.textContent || '';
        }

        // Engagement metrics — look for aria-labels on group elements
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

        // Views — often in a separate analytics link
        let views = 0;
        const viewsLink = article?.querySelector('a[href*="/analytics"]');
        if (viewsLink) views = parseNum(viewsLink.textContent);

        // Media
        const mediaElements: { type: string; url: string }[] = [];
        article?.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(img => {
          const src = img.getAttribute('src');
          if (src) mediaElements.push({ type: 'photo', url: src });
        });
        article?.querySelectorAll('video').forEach(vid => {
          const src = vid.getAttribute('src') || vid.querySelector('source')?.getAttribute('src');
          if (src) mediaElements.push({ type: 'video', url: src });
        });

        // Links in tweet
        const links: { text: string; url: string }[] = [];
        tweetTextEl?.querySelectorAll('a').forEach(a => {
          const href = a.getAttribute('href') || '';
          const text = a.textContent || '';
          if (href && !href.startsWith('/') && !href.includes('x.com')) {
            links.push({ text, url: href });
          }
        });

        // Quoted tweet
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

  /**
   * Fetch a Twitter profile via headless browser.
   */
  async fetchTwitterProfile(profileUrl: string): Promise<any> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 20000 });

      if (page.url().includes('/login') || page.url().includes('/i/flow/login')) {
        await page.close();
        this.twitterLoggedIn = false;
        return { error: 'Not logged into Twitter. Use the login button in settings first.' };
      }

      // Wait for profile to render
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

        // Profile info
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

        // Followers/following
        const links = document.querySelectorAll('a[href*="/followers"], a[href*="/following"], a[href*="/verified_followers"]');
        let followers = 0;
        let following = 0;
        links.forEach(link => {
          const href = link.getAttribute('href') || '';
          const text = link.textContent || '';
          if (href.endsWith('/followers') || href.endsWith('/verified_followers')) followers = parseNum(text);
          if (href.endsWith('/following')) following = parseNum(text);
        });

        // Verified badge
        const verified = !!document.querySelector('[data-testid="icon-verified"]');

        // Recent tweets (first few visible)
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

  /**
   * Generic page fetch — returns text content of any URL.
   */
  async fetchPage(url: string): Promise<{ title: string; text: string; url: string }> {
    const browser = await this.getHeadlessBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });

      const result = await page.evaluate(() => {
        // Remove script/style tags for cleaner text
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

  async shutdown(): Promise<void> {
    if (this.loginBrowser?.connected) {
      await this.loginBrowser.close().catch(() => {});
      this.loginBrowser = null;
    }
    await this.closeHeadless();
    this.loginWindowOpen = false;
    this.logger.info('[Browser] Shutdown complete');
  }
}
