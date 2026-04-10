import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types.ts';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

export class WebSearchSkill implements Skill {
  manifest: SkillManifest = {
    name: 'web-search',
    version: '1.0.0',
    description: 'Web search and content fetching — search the internet, read web pages, get latest crypto news and Solana ecosystem updates',
    tools: [
      {
        name: 'web_search',
        description: 'Search the web for any topic. Returns titles, URLs, and snippets. Use for crypto news, Solana updates, project research, technical docs, trending narratives, and any real-time information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (be specific for best results)' },
            limit: { type: 'number', description: 'Number of results (default: 8, max: 20)' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'fetch_url',
        description: 'Fetch and extract readable text content from a URL. Use to read articles, documentation, release notes, blog posts. Returns cleaned text.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to fetch content from' },
            maxLength: { type: 'number', description: 'Max characters to return (default: 5000)' },
          },
          required: ['url'],
        },
        riskLevel: 'read',
      },
      {
        name: 'crypto_news',
        description: 'Get latest crypto/Solana news and updates. Searches multiple sources for recent developments, launches, narratives, and market-moving events.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Topic to search for (default: "Solana memecoin")' },
            limit: { type: 'number', description: 'Number of results (default: 10)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_fetch',
        description: 'Fetch a page using a real Chrome browser with full JavaScript rendering. Use for SPA sites, dynamic pages, API docs behind JS frameworks (pump.fun, Gitbook, Docusaurus, etc.). Returns rendered text content. Much more powerful than fetch_url for modern websites.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to load in Chrome browser' },
            waitSelector: { type: 'string', description: 'Optional CSS selector to wait for before extracting (e.g. ".main-content", "#docs")' },
            maxLength: { type: 'number', description: 'Max characters to return (default: 6000)' },
          },
          required: ['url'],
        },
        riskLevel: 'read',
      },
      {
        name: 'google_search',
        description: 'Search Google via headless Chrome browser. More reliable than DuckDuckGo. Returns titles, URLs and snippets. Use `start` parameter to get results from deeper pages (page 2 = start 10, page 3 = start 20, etc.). Go through at least 3-5 pages for thorough research.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Google search query' },
            limit: { type: 'number', description: 'Number of results per page (default: 10, max: 20)' },
            start: { type: 'number', description: 'Result offset for pagination. 0 = page 1 (default), 10 = page 2, 20 = page 3, etc. Use to dig deeper into search results.' },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'deep_research',
        description: 'Deep research on any topic: searches the web, fetches top results, extracts and compiles information. Returns a comprehensive research report with all gathered data. Use when you need thorough understanding of an API, library, protocol, or any technical topic. Much more powerful than a single search — reads multiple pages automatically.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'What to research (e.g. "pump.fun API endpoints", "Solana Actions spec", "Jito bundle API")' },
            searchQueries: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: specific search queries to run (default: auto-generated from topic). Provide 2-5 queries for best results.',
            },
            maxPages: { type: 'number', description: 'Max pages to fetch and read (default: 4, max: 8)' },
            focusOn: { type: 'string', description: 'Optional: what to focus on when reading pages (e.g. "API endpoints and parameters", "code examples", "pricing")' },
          },
          required: ['topic'],
        },
        riskLevel: 'read',
      },
      {
        name: 'extract_api_docs',
        description: 'Specialized tool to extract API documentation from a website or GitHub repo. Finds REST endpoints, WebSocket APIs, request/response schemas, authentication methods. Use when building bots or integrations that need to call external APIs.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL of API docs page, GitHub repo, or website to analyze' },
            apiName: { type: 'string', description: 'Name of the API/service (e.g. "pump.fun", "Jupiter", "Helius")' },
          },
          required: ['url'],
        },
        riskLevel: 'read',
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
      case 'web_search':
        return this.webSearch(params.query, params.limit);
      case 'fetch_url':
        return this.fetchUrl(params.url, params.maxLength);
      case 'crypto_news':
        return this.cryptoNews(params.topic, params.limit);
      case 'browser_fetch':
        return this.browserFetch(params.url, params.waitSelector, params.maxLength);
      case 'google_search':
        return this.googleSearch(params.query, params.limit, params.start);
      case 'deep_research':
        return this.deepResearch(params.topic, params.searchQueries, params.maxPages, params.focusOn);
      case 'extract_api_docs':
        return this.extractApiDocs(params.url, params.apiName);
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  async shutdown(): Promise<void> {}


  private async webSearch(query: string, limit: number = 8): Promise<any> {
    const safeLimit = Math.min(Math.max(limit, 1), 20);
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = attempt * 1500;
        this.logger.debug(`DDG search retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }


      try {
        const results = await this.duckDuckGoSearch(query, safeLimit);
        if (results.length > 0) {
          return { query, resultCount: results.length, results };
        }
      } catch (err: any) {
        this.logger.debug(`DuckDuckGo search failed (attempt ${attempt + 1}): ${err.message}`);
      }


      try {
        const results = await this.duckDuckGoLite(query, safeLimit);
        if (results.length > 0) {
          return { query, resultCount: results.length, results };
        }
      } catch (err: any) {
        this.logger.debug(`DuckDuckGo Lite failed (attempt ${attempt + 1}): ${err.message}`);
      }
    }

    return { query, resultCount: 0, results: [], error: 'Search failed — all providers unavailable after multiple retries' };
  }

  private async duckDuckGoSearch(query: string, limit: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const encodedQuery = encodeURIComponent(query);
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodedQuery}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) throw new Error(`DDG status ${res.status}`);
    const html = await res.text();
    return this.parseDDGResults(html, limit);
  }

  private async duckDuckGoLite(query: string, limit: number): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const encodedQuery = encodeURIComponent(query);
        const res = await fetch(`https://lite.duckduckgo.com/lite?q=${encodedQuery}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
      },
    });

    if (!res.ok) throw new Error(`DDG Lite status ${res.status}`);
    const html = await res.text();
    return this.parseDDGResults(html, limit);
  }

  private parseDDGResults(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];


    const linkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;

    const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/gi;

    const liteResultPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;

    const links: Array<{ url: string; title: string }> = [];
    const snippets: string[] = [];

    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const url = this.cleanUrl(match[1]);
      const title = this.stripHtml(match[2]);
      if (url && title && !url.includes('duckduckgo.com')) {
        links.push({ url, title });
      }
    }

    while ((match = snippetPattern.exec(html)) !== null) {
      snippets.push(this.stripHtml(match[1]));
    }


    if (links.length > 0) {
      for (let i = 0; i < Math.min(links.length, limit); i++) {
        results.push({
          title: links[i].title,
          url: links[i].url,
          snippet: snippets[i] || '',
        });
      }
      return results;
    }


    while ((match = liteResultPattern.exec(html)) !== null) {
      const url = this.cleanUrl(match[1]);
      const title = this.stripHtml(match[2]);
      if (url && title && !url.includes('duckduckgo.com') && url.startsWith('http')) {
        results.push({ title, url, snippet: '' });
        if (results.length >= limit) break;
      }
    }


    if (results.length === 0) {
      const hrefPattern = /href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
      while ((match = hrefPattern.exec(html)) !== null) {
        const url = match[1];
        const title = match[2].trim();
        if (url && title && title.length > 5 && !url.includes('duckduckgo.com')) {
          results.push({ title, url, snippet: '' });
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }


  private async fetchUrl(url: string, maxLength: number = 5000): Promise<any> {
    if (!url || !url.startsWith('http')) {
      return { error: 'Invalid URL — must start with http:// or https://' };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,text/plain,application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (!res.ok) {
        return { error: `HTTP ${res.status}`, url };
      }

      const contentType = res.headers.get('content-type') || '';
      const raw = await res.text();

      if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(raw);
          const text = JSON.stringify(json, null, 2).slice(0, maxLength);
          return { url, contentType: 'json', length: text.length, content: text };
        } catch {  }
      }


      const text = this.extractReadableText(raw).slice(0, maxLength);

      return {
        url,
        contentType: contentType.split(';')[0],
        length: text.length,
        title: this.extractTitle(raw),
        content: text,
      };
    } catch (err: any) {
      return { error: err.message, url };
    }
  }


  private async cryptoNews(topic?: string, limit: number = 10): Promise<any> {
    const searchTopic = topic || 'Solana memecoin';
    const queries = [
      `${searchTopic} news today`,
      `${searchTopic} latest updates crypto`,
    ];

    const allResults: Array<{ title: string; url: string; snippet: string; source: string }> = [];

    for (const q of queries) {
      try {
        const results = await this.duckDuckGoSearch(q, Math.ceil(limit / 2));
        for (const r of results) {

          if (!allResults.some(existing => existing.url === r.url)) {
            allResults.push({ ...r, source: new URL(r.url).hostname });
          }
        }
      } catch {  }
    }

    return {
      topic: searchTopic,
      resultCount: Math.min(allResults.length, limit),
      articles: allResults.slice(0, limit),
    };
  }


  private async browserFetch(url: string, waitSelector?: string, maxLength: number = 6000): Promise<any> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { error: 'Invalid URL — must start with http:// or https://' };
    }


    if (this.browser) {
      try {
        const page = await this.browser.newPage?.() || null;
        if (!page) {

          const result = await this.browser.fetchPage(url);
          return { url, title: result.title, content: result.text.slice(0, maxLength), rendered: true, engine: 'puppeteer' };
        }

        await page.setViewport({ width: 1280, height: 900 });
        await page.setUserAgent(USER_AGENT);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });

        if (waitSelector) {
          try { await page.waitForSelector(waitSelector, { timeout: 8000 }); } catch {  }
        }


        await new Promise(r => setTimeout(r, 1500));

        const result = await page.evaluate(() => {
          document.querySelectorAll('script, style, noscript, svg, nav, footer, header').forEach(el => el.remove());
          return {
            title: document.title || '',
            text: (document.body?.innerText || '').slice(0, 20000),
            url: window.location.href,
            links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({
              text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 100) || '',
              href: (a as HTMLAnchorElement).href,
            })).filter(l => l.text && l.href.startsWith('http')),
          };
        });

        await page.close();
        return {
          url: result.url,
          title: result.title,
          content: result.text.slice(0, maxLength),
          links: result.links.slice(0, 30),
          rendered: true,
          engine: 'puppeteer',
        };
      } catch (err: any) {
        this.logger.debug(`Browser fetch failed: ${err.message}, falling back to HTTP fetch`);
      }
    }


    if (this.browser?.fetchPage) {
      try {
        const result = await this.browser.fetchPage(url);
        return { url, title: result.title, content: result.text.slice(0, maxLength), rendered: true, engine: 'puppeteer-fetchPage' };
      } catch (err: any) {
        this.logger.debug(`Browser.fetchPage failed: ${err.message}`);
      }
    }


    return this.fetchUrl(url, maxLength);
  }


  private async googleSearch(query: string, limit: number = 10, start: number = 0): Promise<any> {
    const safeLimit = Math.min(Math.max(limit, 1), 20);
    const safeStart = Math.max(start || 0, 0);
    const page = Math.floor(safeStart / 10) + 1;
    const MAX_RETRIES = 2;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = attempt * 2000;
        this.logger.debug(`Search retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }


      if (this.browser) {
        try {
          const results = await this.googleSearchBrowser(query, safeLimit, safeStart);
          if (results.length > 0) {
            return { query, engine: 'google-browser', page, start: safeStart, resultCount: results.length, results };
          }
        } catch (err: any) {
          this.logger.debug(`Google browser search failed (attempt ${attempt + 1}): ${err.message}`);
        }
      }


      try {
        const results = await this.googleSearchHTTP(query, safeLimit, safeStart);
        if (results.length > 0) {
          return { query, engine: 'google-http', page, start: safeStart, resultCount: results.length, results };
        }
      } catch (err: any) {
        this.logger.debug(`Google HTTP search failed (attempt ${attempt + 1}): ${err.message}`);
      }


      if (attempt === MAX_RETRIES) {
        return this.webSearch(query, safeLimit);
      }
    }


    return this.webSearch(query, safeLimit);
  }

  private async googleSearchBrowser(query: string, limit: number, start: number = 0): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `${GOOGLE_SEARCH_URL}?q=${encodedQuery}&num=${limit}&hl=en${start > 0 ? '&start=' + start : ''}`;

    let page: any;
    try {
      if (this.browser.fetchPage) {

        const result = await this.browser.fetchPage(searchUrl);

        return this.parseGoogleText(result.text, limit);
      }
    } catch (err: any) {
      this.logger.debug(`Google browser search via fetchPage failed: ${err.message}`);
    }

    return [];
  }

  private async googleSearchHTTP(query: string, limit: number, start: number = 0): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `${GOOGLE_SEARCH_URL}?q=${encodedQuery}&num=${limit}&hl=en${start > 0 ? '&start=' + start : ''}`;

    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) throw new Error(`Google status ${res.status}`);
    const html = await res.text();
    return this.parseGoogleHTML(html, limit);
  }

  private parseGoogleHTML(html: string, limit: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];


    const resultBlocks = html.match(/<div class="[^"]*g[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/gi) || [];

    for (const block of resultBlocks) {

      const urlMatch = block.match(/<a[^>]*href="(\/url\?q=([^&"]+)|https?:\/\/[^"]+)"[^>]*>/i);

      const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/si);

      if (urlMatch && titleMatch) {
        let url = urlMatch[2] ? decodeURIComponent(urlMatch[2]) : urlMatch[1];
        if (url.startsWith('/url?q=')) {
          const m = url.match(/\/url\?q=([^&]+)/);
          if (m) url = decodeURIComponent(m[1]);
        }
        const title = this.stripHtml(titleMatch[1]);

        if (url.startsWith('http') && !url.includes('google.com') && title) {

          const snippetMatch = block.match(/<(?:span|div)[^>]*class="[^"]*(?:st|IsZvec|VwiC3b)[^"]*"[^>]*>(.*?)<\/(?:span|div)>/si);
          const snippet = snippetMatch ? this.stripHtml(snippetMatch[1]) : '';

          results.push({ title, url, snippet });
          if (results.length >= limit) break;
        }
      }
    }


    if (results.length === 0) {
      const linkPattern = /<a[^>]*href="\/url\?q=(https?[^&"]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>(.*?)<\/h3>/gi;
      let match;
      while ((match = linkPattern.exec(html)) !== null && results.length < limit) {
        const url = decodeURIComponent(match[1]);
        const title = this.stripHtml(match[2]);
        if (url && title && !url.includes('google.com')) {
          results.push({ title, url, snippet: '' });
        }
      }
    }

    return results;
  }

  private parseGoogleText(text: string, limit: number): Array<{ title: string; url: string; snippet: string }> {

    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    for (let i = 0; i < lines.length && results.length < limit; i++) {

      const urlMatch = lines[i].match(/(https?:\/\/[^\s]+)/);
      if (urlMatch && !urlMatch[1].includes('google.com') && !urlMatch[1].includes('gstatic.com')) {

        const title = i > 0 ? lines[i - 1] : lines[i].replace(urlMatch[0], '').trim();
        const snippet = i + 1 < lines.length ? lines[i + 1] : '';

        if (title && title.length > 3) {
          results.push({
            title: title.slice(0, 200),
            url: urlMatch[1],
            snippet: snippet.slice(0, 300),
          });
        }
      }
    }

    return results;
  }


  private async deepResearch(topic: string, searchQueries?: string[], maxPages: number = 4, focusOn?: string): Promise<any> {
    const safeMaxPages = Math.min(Math.max(maxPages, 1), 8);


    const queries = searchQueries && searchQueries.length > 0
      ? searchQueries.slice(0, 5)
      : this.generateSearchQueries(topic);

    this.logger.info(`[deep_research] Topic: "${topic}", queries: ${queries.length}, maxPages: ${safeMaxPages}`);


    const allSearchResults: Array<{ title: string; url: string; snippet: string; query: string }> = [];
    const seenUrls = new Set<string>();

    for (const q of queries) {
      try {
        const searchResult = await this.webSearch(q, 8);
        if (searchResult.results) {
          for (const r of searchResult.results) {
            const normalizedUrl = r.url.replace(/\/$/, '').toLowerCase();
            if (!seenUrls.has(normalizedUrl) && !this.isJunkUrl(r.url)) {
              seenUrls.add(normalizedUrl);
              allSearchResults.push({ ...r, query: q });
            }
          }
        }
      } catch {  }
    }


    for (const q of queries.slice(0, 2)) {
      try {
        const googleResult = await this.googleSearch(q, 5);
        if (googleResult.results) {
          for (const r of googleResult.results) {
            const normalizedUrl = r.url.replace(/\/$/, '').toLowerCase();
            if (!seenUrls.has(normalizedUrl) && !this.isJunkUrl(r.url)) {
              seenUrls.add(normalizedUrl);
              allSearchResults.push({ ...r, query: q });
            }
          }
        }
      } catch {  }
    }


    const prioritized = this.prioritizeResults(allSearchResults, topic);
    const pagesToFetch = prioritized.slice(0, safeMaxPages);

    this.logger.info(`[deep_research] Found ${allSearchResults.length} URLs, fetching top ${pagesToFetch.length}`);

    const fetchedPages: Array<{ url: string; title: string; content: string; source: string }> = [];

    for (const result of pagesToFetch) {
      try {

        const isJSHeavy = this.isJSHeavySite(result.url);
        let page: any;

        if (isJSHeavy && this.browser) {
          page = await this.browserFetch(result.url, undefined, 12000);
        } else {
          page = await this.fetchUrl(result.url, 12000);
        }

        if (page.content && page.content.length > 100) {
          fetchedPages.push({
            url: result.url,
            title: page.title || result.title,
            content: page.content,
            source: new URL(result.url).hostname,
          });
        }
      } catch (err: any) {
        this.logger.debug(`[deep_research] Failed to fetch ${result.url}: ${err.message}`);
      }
    }


    const report = this.compileResearchReport(topic, queries, allSearchResults, fetchedPages, focusOn);

    return {
      topic,
      queriesUsed: queries,
      totalSearchResults: allSearchResults.length,
      pagesFetched: fetchedPages.length,
      report,
      sources: fetchedPages.map(p => ({ url: p.url, title: p.title, source: p.source })),
      rawData: fetchedPages.map(p => ({
        url: p.url,
        title: p.title,
        content: p.content.slice(0, 2000),
      })),
    };
  }

  private generateSearchQueries(topic: string): string[] {
    const queries = [topic];

    const topicLower = topic.toLowerCase();


    if (topicLower.includes('api') || topicLower.includes('endpoint') || topicLower.includes('bot')) {
      queries.push(`${topic} REST API documentation`);
      queries.push(`${topic} API endpoints examples`);
    }


    if (topicLower.includes('bot') || topicLower.includes('build') || topicLower.includes('create')) {
      queries.push(`${topic} tutorial guide`);
      queries.push(`${topic} github example code`);
    }


    if (topicLower.includes('pump') || topicLower.includes('jupiter') || topicLower.includes('raydium') || topicLower.includes('solana')) {
      queries.push(`${topic} API integration typescript`);
      queries.push(`${topic} SDK npm package`);
    }


    queries.push(`${topic} documentation 2024 2025`);

    return queries.slice(0, 5);
  }

  private isJunkUrl(url: string): boolean {
    const junkDomains = ['google.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'linkedin.com/in/', 'youtube.com/shorts'];
    return junkDomains.some(d => url.includes(d));
  }

  private isJSHeavySite(url: string): boolean {
    const jsHeavy = ['pump.fun', 'gitbook.io', 'docs.', 'app.', 'vercel.app', 'netlify.app', 'notion.so', 'readme.io', 'swagger.io', 'redoc.'];
    return jsHeavy.some(d => url.includes(d));
  }

  private prioritizeResults(results: Array<{ title: string; url: string; snippet: string; query: string }>, topic: string): typeof results {
    const topicWords = topic.toLowerCase().split(/\s+/);
    return results
      .map(r => {
        let score = 0;
        const urlLower = r.url.toLowerCase();
        const titleLower = r.title.toLowerCase();


        if (urlLower.includes('docs.') || urlLower.includes('/docs')) score += 5;
        if (urlLower.includes('api.') || urlLower.includes('/api')) score += 5;
        if (urlLower.includes('github.com')) score += 4;
        if (urlLower.includes('npmjs.com')) score += 3;
        if (urlLower.includes('developer.') || urlLower.includes('/developer')) score += 4;
        if (urlLower.includes('swagger') || urlLower.includes('openapi') || urlLower.includes('redoc')) score += 5;


        for (const word of topicWords) {
          if (titleLower.includes(word)) score += 2;
          if (urlLower.includes(word)) score += 1;
        }


        if (urlLower.includes('reddit.com')) score -= 1;
        if (urlLower.includes('medium.com')) score += 1;
        if (urlLower.includes('stackoverflow.com')) score += 2;

        return { ...r, score };
      })
      .sort((a, b) => (b as any).score - (a as any).score);
  }

  private compileResearchReport(
    topic: string,
    queries: string[],
    searchResults: Array<{ title: string; url: string; snippet: string }>,
    pages: Array<{ url: string; title: string; content: string; source: string }>,
    focusOn?: string,
  ): string {
    const lines: string[] = [];
    lines.push(`# Research Report: ${topic}`);
    lines.push('');
    lines.push(`## Search Queries Used`);
    for (const q of queries) lines.push(`- ${q}`);
    lines.push('');
    lines.push(`## Key Findings`);
    lines.push('');


    for (const page of pages) {
      lines.push(`### ${page.title || page.source}`);
      lines.push(`Source: ${page.url}`);
      lines.push('');

      let content = page.content;

      if (focusOn) {
        const focusWords = focusOn.toLowerCase().split(/\s+/);
        const contentLines = content.split('\n');
        const relevant = contentLines.filter(line => {
          const lineLower = line.toLowerCase();
          return focusWords.some(w => lineLower.includes(w)) || line.match(/^#{1,3}\s/);
        });
        if (relevant.length > 5) {
          content = relevant.join('\n');
        }
      }

      lines.push(content.slice(0, 2000));
      lines.push('');
      lines.push('---');
      lines.push('');
    }


    const visitedUrls = new Set(pages.map(p => p.url));
    const unvisited = searchResults.filter(r => !visitedUrls.has(r.url)).slice(0, 10);
    if (unvisited.length > 0) {
      lines.push('## Additional Search Results (not fetched)');
      for (const r of unvisited) {
        lines.push(`- [${r.title}](${r.url})`);
        if (r.snippet) lines.push(`  ${r.snippet}`);
      }
    }

    return lines.join('\n');
  }


  private async extractApiDocs(url: string, apiName?: string): Promise<any> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { error: 'Invalid URL — must start with http:// or https://' };
    }

    const name = apiName || new URL(url).hostname;
    this.logger.info(`[extract_api_docs] Extracting API docs from: ${url} (${name})`);


    const mainPage = await this.browserFetch(url, undefined, 20000);
    if (mainPage.error) {
      return { error: mainPage.error, url };
    }

    const result: any = {
      apiName: name,
      sourceUrl: url,
      endpoints: [] as Array<{ method: string; path: string; description: string }>,
      authentication: '',
      baseUrl: '',
      websocket: '',
      content: mainPage.content,
    };

    const content = mainPage.content || '';
    const contentLower = content.toLowerCase();


    const endpointPatterns = [
      /(?:GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9\/_\-{}:.?&=]+)/g,
      /(?:endpoint|route|url|path)\s*[:\-=]\s*(\/[a-zA-Z0-9\/_\-{}:.?&=]+)/gi,
      /`((?:GET|POST|PUT|DELETE|PATCH)\s+\/[^`]+)`/g,
    ];

    const endpoints = new Set<string>();
    for (const pattern of endpointPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        endpoints.add(match[0].trim());
      }
    }

    result.endpoints = Array.from(endpoints).map(e => {
      const parts = e.match(/(GET|POST|PUT|DELETE|PATCH)?\s*(\/[^\s]+)/);
      return {
        method: parts?.[1] || 'GET',
        path: parts?.[2] || e,
        description: '',
      };
    });

    const baseUrlMatch = content.match(/(?:base\s*url|api\s*url|host|server)[:\s]*(https?:\/\/[^\s,;"'<]+)/i);
    if (baseUrlMatch) result.baseUrl = baseUrlMatch[1];

    const wsMatch = content.match(/(?:wss?:\/\/[^\s,;"'<]+)/i);
    if (wsMatch) result.websocket = wsMatch[0];

    if (contentLower.includes('api key') || contentLower.includes('apikey') || contentLower.includes('x-api-key')) {
      result.authentication = 'API Key';
    } else if (contentLower.includes('bearer') || contentLower.includes('jwt') || contentLower.includes('oauth')) {
      result.authentication = 'Bearer Token / OAuth';
    } else if (contentLower.includes('basic auth')) {
      result.authentication = 'Basic Auth';
    }

    if (mainPage.links) {
      const apiLinks = mainPage.links.filter((l: any) =>
        l.href.includes('swagger') || l.href.includes('openapi') || l.href.includes('api-docs') ||
        l.href.includes('redoc') || l.text.toLowerCase().includes('api')
      );
      if (apiLinks.length > 0) {
        result.apiDocLinks = apiLinks.slice(0, 10);

        for (const link of apiLinks.slice(0, 2)) {
          try {
            if (link.href.includes('.json') || link.href.includes('swagger') || link.href.includes('openapi')) {
              const specPage = await this.fetchUrl(link.href, 15000);
              if (specPage.content) {
                result.openApiSpec = specPage.content.slice(0, 10000);
                break;
              }
            }
          } catch {  }
        }
      }
    }

    if (url.includes('github.com')) {
      try {

        const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
        if (repoMatch) {
          const rawUrl = `https://raw.githubusercontent.com/${repoMatch[1]}/main/README.md`;
          const readme = await this.fetchUrl(rawUrl, 15000);
          if (readme.content && readme.content.length > 200) {
            result.readme = readme.content;
          } else {

            const rawUrlMaster = `https://raw.githubusercontent.com/${repoMatch[1]}/master/README.md`;
            const readmeMaster = await this.fetchUrl(rawUrlMaster, 15000);
            if (readmeMaster.content) result.readme = readmeMaster.content;
          }
        }
      } catch {  }
    }

    return result;
  }

  private cleanUrl(url: string): string {

    if (url.includes('uddg=')) {
      const match = url.match(/uddg=([^&]+)/);
      if (match) {
        try { return decodeURIComponent(match[1]); } catch {  }
      }
    }

    if (url.startsWith('//')) return 'https:' + url;
    return url;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>(.*?)<\/title>/si);
    return match ? this.stripHtml(match[1]).slice(0, 200) : '';
  }

  private extractReadableText(html: string): string {

    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');

    text = text
      .replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|section|article)>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ');

    text = this.stripHtml(text);

    text = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');

    return text;
  }
}
