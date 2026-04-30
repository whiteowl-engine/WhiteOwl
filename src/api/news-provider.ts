import * as crypto from 'crypto';
import { LoggerInterface, NewsItem, NewsCategory } from '../types.ts';

function hashTitle(title: string): string {
  return crypto.createHash('sha256').update(title.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function timeAgo(dateStr: string): number {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

interface CryptoPanicConfig {
  apiKey: string;
  filter?: string;
  currencies?: string;
}

interface CryptoPanicPost {
  id: number;
  title: string;
  url: string;
  source: { title: string; domain: string };
  published_at: string;
  currencies?: Array<{ code: string; title: string }>;
  votes?: { positive: number; negative: number; important: number; liked: number; disliked: number };
  kind: string;
}

export async function fetchCryptoPanic(config: CryptoPanicConfig, logger: LoggerInterface): Promise<NewsItem[]> {
  if (!config.apiKey) {
    logger.debug('[News] CryptoPanic: no API key, skipping');
    return [];
  }

  const params = new URLSearchParams({
    auth_token: config.apiKey,
    public: 'true',
  });
  if (config.filter) params.set('filter', config.filter);
  if (config.currencies) params.set('currencies', config.currencies);

  const url = `https://cryptopanic.com/api/free/v1/posts/?${params}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn(`[News] CryptoPanic API: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json() as { results?: CryptoPanicPost[] };
    const posts = data.results || [];

    return posts.map((p): NewsItem => {
      const mentionedTokens = (p.currencies || []).map(c => c.code);
      const v = p.votes || { positive: 0, negative: 0, important: 0, liked: 0, disliked: 0 };


      let sentiment: NewsItem['sentiment'] = 'neutral';
      if (v.positive > v.negative * 1.5) sentiment = 'bullish';
      else if (v.negative > v.positive * 1.5) sentiment = 'bearish';


      let category: NewsCategory = 'crypto';
      const titleLower = p.title.toLowerCase();
      if (mentionedTokens.includes('SOL') || titleLower.includes('solana')) category = 'solana';
      else if (titleLower.includes('defi') || titleLower.includes('swap') || titleLower.includes('yield')) category = 'defi';
      else if (titleLower.includes('sec') || titleLower.includes('regulat') || titleLower.includes('ban')) category = 'regulation';
      else if (titleLower.includes('hack') || titleLower.includes('exploit') || titleLower.includes('drain')) category = 'hack';
      else if (titleLower.includes('meme') || titleLower.includes('doge') || titleLower.includes('pepe')) category = 'memes';
      else if (titleLower.includes('fed') || titleLower.includes('inflation') || titleLower.includes('gdp') || titleLower.includes('cpi')) category = 'macro';

      const voteScore = v.positive + v.important - v.negative;

      return {
        id: `cp_${p.id}`,
        title: p.title,
        summary: p.title,
        url: p.url,
        source: p.source?.title || p.source?.domain || 'CryptoPanic',
        published_at: timeAgo(p.published_at),
        category,
        sentiment,
        relevance_score: Math.min(100, Math.max(0, 50 + voteScore * 5)),
        mentioned_tokens: mentionedTokens,
        priority: 0,
        votes: { bullish: v.positive, bearish: v.negative, important: v.important },
        created_at: Date.now(),
      };
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn('[News] CryptoPanic: request timed out');
    } else {
      logger.error('[News] CryptoPanic fetch failed', err.message);
    }
    return [];
  }
}


interface RSSFeedConfig {
  id: string;
  name: string;
  url: string;
  priorityWeight: number;
  defaultCategory?: string;
}

interface RSSItemRaw {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  contentSnippet?: string;
  content?: string;
  creator?: string;
  categories?: string[];
}

async function parseRSSFeed(feedUrl: string, timeout: number = 15_000, retries: number = 2): Promise<RSSItemRaw[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(feedUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`RSS ${res.status}: ${feedUrl}`);
      const xml = await res.text();
      return parseRSSXml(xml);
    } catch (err: any) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  return [];
}

function parseRSSXml(xml: string): RSSItemRaw[] {
  const items: RSSItemRaw[] = [];


  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const getTag = (tag: string): string => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };


    let link = getTag('link');
    if (!link) {
      const linkM = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (linkM) link = linkM[1];
    }

    const pubDate = getTag('pubDate') || getTag('published') || getTag('updated') || '';
    const content = getTag('content:encoded') || getTag('content') || getTag('description') || '';

    const snippet = content.replace(/<[^>]+>/g, '').slice(0, 300).trim();

    const categories: string[] = [];
    const catRegex = /<category[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/gi;
    let catMatch: RegExpExecArray | null;
    while ((catMatch = catRegex.exec(block)) !== null) {
      categories.push(catMatch[1].trim());
    }


    let sourceName = '';
    const sourceM = block.match(/<source[^>]+url=["']([^"']+)["'][^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/i);
    if (sourceM) {
      if (!link || link.includes('news.google.com')) link = sourceM[1];
      sourceName = sourceM[2].trim();
    }

    items.push({
      title: getTag('title'),
      link,
      pubDate,
      isoDate: pubDate,
      contentSnippet: snippet,
      content: snippet,
      categories,
      creator: sourceName || undefined,
    });
  }

  return items;
}


const RSS_CONCURRENCY = 6;
let _rssActive = 0;
const _rssQueue: Array<() => void> = [];

export async function rssGate<T>(fn: () => Promise<T>): Promise<T> {
  while (_rssActive >= RSS_CONCURRENCY) {
    await new Promise<void>(resolve => _rssQueue.push(resolve));
  }
  _rssActive++;
  try {
    return await fn();
  } finally {
    _rssActive--;
    if (_rssQueue.length > 0) _rssQueue.shift()!();
  }
}

export async function fetchRSSFeed(config: RSSFeedConfig, logger: LoggerInterface): Promise<NewsItem[]> {
  try {
    const rawItems = await parseRSSFeed(config.url);

    return rawItems
      .filter(item => item.title)
      .slice(0, 30)
      .map((item): NewsItem => {
        const title = item.title!.trim();
        const id = `rss_${config.id}_${hashTitle(title)}`;
        const publishedAt = item.pubDate ? timeAgo(item.pubDate) : Date.now();


        const cats = (item.categories || []).map(c => c.toLowerCase()).join(' ');
        const titleLower = title.toLowerCase();
        const text = `${titleLower} ${cats}`;

        let category: NewsCategory = (config.defaultCategory as NewsCategory) || 'general';


        if (text.includes('solana') || text.includes(' sol ')) category = 'solana';
        else if (text.includes('defi') || text.includes('swap') || text.includes('lending') || text.includes('yield farm') || text.includes('amm') || text.includes('liquidity')) category = 'defi';
        else if (text.includes('hack') || text.includes('exploit') || text.includes('drain') || text.includes('breach') || text.includes('vulnerability')) category = 'hack';
        else if (text.includes('meme coin') || text.includes('memecoin') || text.includes('doge') || text.includes('pepe') || text.includes('shib')) category = 'memes';
        else if (text.includes('bitcoin') || text.includes('ethereum') || text.includes('crypto') || text.includes('blockchain') || text.includes('token') || text.includes('nft') || text.includes('web3')) category = 'crypto';

        else if (text.includes('election') || text.includes('ballot') || text.includes('poll') || text.includes('voter') || text.includes('candidat') || text.includes('campaign') || text.includes('primary') || text.includes('caucus')) category = 'elections';
        else if (text.includes('trump') || text.includes('biden') || text.includes('congress') || text.includes('senate') || text.includes('parliament') || text.includes('democrat') || text.includes('republican') || text.includes('politic') || text.includes('legislation') || text.includes('white house') || text.includes('governor') || text.includes('impeach')) category = 'politics';

        else if (text.includes('regulat') || text.includes(' sec ') || text.includes('sanction') || text.includes('ban ') || text.includes('compliance') || text.includes('antitrust') || text.includes('lawsuit')) category = 'regulation';

        else if (text.includes('war ') || text.includes('conflict') || text.includes('military') || text.includes('missile') || text.includes('strike') || text.includes('invasion') || text.includes('nato') || text.includes('troops') || text.includes('battlefield') || text.includes('airstrike') || text.includes('ceasefire') || text.includes('ukraine') || text.includes('gaza')) category = 'conflict';

        else if (text.includes('nba') || text.includes('nfl') || text.includes('soccer') || text.includes('football') || text.includes('tennis') || text.includes('baseball') || text.includes('hockey') || text.includes('championship') || text.includes('olympic') || text.includes('world cup') || text.includes('tournament') || text.includes('league') || text.includes('playoff') || text.includes('ufc') || text.includes('f1') || text.includes('formula 1') || text.includes('espn')) category = 'sports';

        else if (text.includes('science') || text.includes('research') || text.includes('study finds') || text.includes('nasa') || text.includes('space') || text.includes('climate') || text.includes('discover') || text.includes('physics') || text.includes('biology') || text.includes('genome') || text.includes('asteroid')) category = 'science';

        else if (text.includes('movie') || text.includes('film') || text.includes('actor') || text.includes('actress') || text.includes('netflix') || text.includes('streaming') || text.includes('box office') || text.includes('celebrity') || text.includes('music') || text.includes('album') || text.includes('concert') || text.includes('grammy') || text.includes('oscar') || text.includes('emmy') || text.includes('tv show')) category = 'entertainment';

        else if (text.includes('stock') || text.includes('earnings') || text.includes('revenue') || text.includes('profit') || text.includes('merger') || text.includes('acquisition') || text.includes('ipo') || text.includes('startup') || text.includes('venture') || text.includes('market') || text.includes('invest') || text.includes('hedge fund') || text.includes('wall street') || text.includes('nasdaq') || text.includes('s&p')) category = 'business';

        else if (text.includes('fed') || text.includes('inflation') || text.includes('gdp') || text.includes('cpi') || text.includes('interest rate') || text.includes('central bank') || text.includes('recession') || text.includes('unemployment') || text.includes('treasury') || text.includes('bond') || text.includes('oil price') || text.includes('opec')) category = 'macro';

        else if (text.includes('ai ') || text.includes('artificial intelligence') || text.includes('openai') || text.includes('google') || text.includes('apple') || text.includes('microsoft') || text.includes('amazon') || text.includes('meta') || text.includes('chip') || text.includes('semiconductor') || text.includes('robot') || text.includes('quantum') || text.includes('cybersecur') || text.includes('software') || text.includes('silicon valley')) category = 'tech';

        else if (text.includes('hurricane') || text.includes('earthquake') || text.includes('tornado') || text.includes('flood') || text.includes('wildfire') || text.includes('tsunami') || text.includes('storm') || text.includes('drought') || text.includes('weather')) category = 'weather';

        return {
          id,
          title,
          summary: item.contentSnippet?.slice(0, 200) || title,
          url: item.link || undefined,
          source: item.creator || config.name,
          published_at: publishedAt,
          category,
          sentiment: 'neutral',
          relevance_score: 50,
          mentioned_tokens: [],
          priority: 0,
          created_at: Date.now(),
        };
      });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn(`[News] RSS ${config.name}: timed out`);
    } else {
      logger.error(`[News] RSS ${config.name}: ${err.message}`);
    }
    return [];
  }
}


export interface TelegramChannelConfig {
  id: string;
  name: string;
  channel: string;
  enabled: boolean;
  pollIntervalMs: number;
  priorityWeight: number;
  defaultCategory?: string;
}

export async function fetchTelegramChannel(config: TelegramChannelConfig, logger: LoggerInterface): Promise<NewsItem[]> {
  const url = `https://t.me/s/${config.channel}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn(`[News] Telegram ${config.channel}: ${res.status}`);
      return [];
    }

    const html = await res.text();


    const hasMessages = html.includes('data-post="');
    if (!hasMessages) {
      if (html.includes('tg://resolve') || html.includes('tg:resolve')) {
        logger.warn(`[News] Telegram ${config.channel}: no public preview (redirects to app)`);
      } else {
        logger.warn(`[News] Telegram ${config.channel}: no messages found in HTML`);
      }
      return [];
    }


    const blocks = html.split('data-post="');

    const items: NewsItem[] = [];

    for (let i = 1; i < blocks.length && items.length < 30; i++) {
      const block = blocks[i];


      const textMatch = block.match(/tgme_widget_message_text[^>]*>(.*?)<\/div>/s);
      if (!textMatch) continue;


      let text = textMatch[1]
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length < 10) continue;


      const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const publishedAt = timeMatch ? new Date(timeMatch[1]).getTime() : Date.now();


      const postIdMatch = block.match(/^([^"]+)/);
      const postId = postIdMatch ? postIdMatch[1].replace('/', '_') : `${i}`;


      const title = text.length > 120 ? text.slice(0, 117) + '...' : text;


      const titleLower = text.toLowerCase();
      let category: NewsCategory = (config.defaultCategory as NewsCategory) || 'crypto';

      if (titleLower.includes('solana') || titleLower.includes(' sol ')) category = 'solana';
      else if (titleLower.includes('defi') || titleLower.includes('swap') || titleLower.includes('yield') || titleLower.includes('liquidity pool')) category = 'defi';
      else if (titleLower.includes('hack') || titleLower.includes('exploit') || titleLower.includes('breach') || titleLower.includes('stolen')) category = 'hack';
      else if (titleLower.includes('meme') || titleLower.includes('doge') || titleLower.includes('pepe') || titleLower.includes('shib')) category = 'memes';
      else if (titleLower.includes('nft') || titleLower.includes('opensea')) category = 'crypto';
      else if (titleLower.includes('sec ') || titleLower.includes('regulat') || titleLower.includes('lawsuit') || titleLower.includes(' ban ')) category = 'regulation';
      else if (titleLower.includes('whale') || titleLower.includes('transfer') || titleLower.includes('moved')) category = 'crypto';
      else if (titleLower.includes('war') || titleLower.includes('military') || titleLower.includes('missile')) category = 'conflict';
      else if (titleLower.includes('election') || titleLower.includes('trump') || titleLower.includes('biden')) category = 'elections';
      else if (titleLower.includes('fed ') || titleLower.includes('inflation') || titleLower.includes('interest rate') || titleLower.includes('gdp')) category = 'macro';


      const tokens: string[] = [];
      if (/\bbtc\b|\bbitcoin\b/i.test(text)) tokens.push('BTC');
      if (/\beth\b|\bethereum\b/i.test(text)) tokens.push('ETH');
      if (/\bsol\b|\bsolana\b/i.test(text)) tokens.push('SOL');
      if (/\bbnb\b|\bbinance\b/i.test(text)) tokens.push('BNB');
      if (/\bxrp\b|\bripple\b/i.test(text)) tokens.push('XRP');

      items.push({
        id: `tg_${config.channel}_${hashTitle(postId + title)}`,
        title,
        summary: text.length > 300 ? text.slice(0, 297) + '...' : text,
        url: `https://t.me/${config.channel}/${postId}`,
        source: `Telegram @${config.channel}`,
        published_at: isNaN(publishedAt) ? Date.now() : publishedAt,
        category,
        sentiment: 'neutral',
        relevance_score: Math.round(50 * config.priorityWeight),
        mentioned_tokens: tokens,
        priority: 0,
        created_at: Date.now(),
      });
    }

    return items;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn(`[News] Telegram ${config.channel}: request timed out`);
    } else {
      logger.error(`[News] Telegram ${config.channel}: ${err.message}`);
    }
    return [];
  }
}


interface GDELTConfig {
  id: string;
  name: string;
  query: string;
  maxRecords?: number;
  timespan?: string;
  priorityWeight: number;
  defaultCategory?: string;
}

interface GDELTArticle {
  url: string;
  url_mobile?: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language?: string;
  sourcecountry?: string;
}

export async function fetchGDELT(config: GDELTConfig, logger: LoggerInterface): Promise<NewsItem[]> {
  const maxRecords = config.maxRecords || 75;
  const timespan = config.timespan || '30min';
  const params = new URLSearchParams({
    query: config.query,
    mode: 'ArtList',
    maxrecords: String(maxRecords),
    format: 'json',
    timespan,
    sort: 'DateDesc',
  });
  const url = `https://gdelt-api.com/api/v2/doc/doc?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WhiteOwl/1.0 News Aggregator' },
    });
    clearTimeout(timer);

    if (res.status === 429) {
      logger.warn(`[News] GDELT ${config.name}: rate limited, backing off`);
      return [];
    }
    if (!res.ok) {
      logger.warn(`[News] GDELT ${config.name}: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json() as { articles?: GDELTArticle[] };
    const articles = data.articles || [];

    return articles
      .filter(a => a.title && a.url)
      .slice(0, 30)
      .map((a): NewsItem => {
        const title = a.title.trim();
        const id = `gdelt_${config.id}_${hashTitle(title)}`;


        let publishedAt = Date.now();
        if (a.seendate) {
          const s = a.seendate;
          const dateStr = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`;
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) publishedAt = d.getTime();
        }


        const titleLower = title.toLowerCase();
        let category: NewsCategory = (config.defaultCategory as NewsCategory) || 'general';

        if (titleLower.includes('solana') || titleLower.includes(' sol ')) category = 'solana';
        else if (titleLower.includes('defi') || titleLower.includes('swap') || titleLower.includes('yield')) category = 'defi';
        else if (titleLower.includes('hack') || titleLower.includes('exploit') || titleLower.includes('breach')) category = 'hack';
        else if (titleLower.includes('bitcoin') || titleLower.includes('ethereum') || titleLower.includes('crypto') || titleLower.includes('blockchain')) category = 'crypto';
        else if (titleLower.includes('war') || titleLower.includes('military') || titleLower.includes('missile') || titleLower.includes('nato')) category = 'conflict';
        else if (titleLower.includes('election') || titleLower.includes('vote') || titleLower.includes('ballot')) category = 'elections';
        else if (titleLower.includes('regulat') || titleLower.includes(' sec ') || titleLower.includes('sanction')) category = 'regulation';
        else if (titleLower.includes('fed') || titleLower.includes('inflation') || titleLower.includes('gdp') || titleLower.includes('interest rate')) category = 'macro';

        return {
          id,
          title,
          summary: title,
          url: a.url,
          source: a.domain || config.name,
          published_at: publishedAt,
          category,
          sentiment: 'neutral',
          relevance_score: 50,
          mentioned_tokens: [],
          priority: 0,
          created_at: Date.now(),
        };
      });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn(`[News] GDELT ${config.name}: request timed out`);
    } else {
      logger.error(`[News] GDELT ${config.name}: ${err.message}`);
    }
    return [];
  }
}


interface HackerNewsConfig {
  id: string;
  name: string;
  endpoint: string;
  maxItems?: number;
  priorityWeight: number;
  defaultCategory?: string;
}

interface HNItem {
  id: number;
  title?: string;
  url?: string;
  by?: string;
  time?: number;
  score?: number;
  type?: string;
}

export async function fetchHackerNews(config: HackerNewsConfig, logger: LoggerInterface): Promise<NewsItem[]> {
  const endpoint = config.endpoint || 'newstories';
  const maxItems = config.maxItems || 30;

  try {

    const controller1 = new AbortController();
    const timer1 = setTimeout(() => controller1.abort(), 10_000);
        const res1 = await fetch(`https://hacker-news.firebaseio.com/v0/${endpoint}.json`, {
      signal: controller1.signal,
    });
    clearTimeout(timer1);

    if (!res1.ok) {
      logger.warn(`[News] HN ${config.name}: ${res1.status}`);
      return [];
    }

    const storyIds = (await res1.json() as number[]).slice(0, maxItems);


    const items: NewsItem[] = [];
    for (let i = 0; i < storyIds.length; i += 10) {
      const batch = storyIds.slice(i, i + 10);
      const batchResults = await Promise.allSettled(
        batch.map(async (sid) => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 8_000);
          const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${sid}.json`, { signal: c.signal });
          clearTimeout(t);
          if (!r.ok) return null;
          return r.json() as Promise<HNItem>;
        })
      );

      for (const result of batchResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const story = result.value;
        if (!story.title || story.type !== 'story') continue;

        const title = story.title.trim();
        const titleLower = title.toLowerCase();
        let category: NewsCategory = (config.defaultCategory as NewsCategory) || 'tech';

        if (titleLower.includes('solana') || titleLower.includes(' sol ')) category = 'solana';
        else if (titleLower.includes('defi') || titleLower.includes('swap')) category = 'defi';
        else if (titleLower.includes('hack') || titleLower.includes('exploit') || titleLower.includes('breach') || titleLower.includes('vulnerab')) category = 'hack';
        else if (titleLower.includes('bitcoin') || titleLower.includes('ethereum') || titleLower.includes('crypto') || titleLower.includes('blockchain')) category = 'crypto';
        else if (titleLower.includes('ai ') || titleLower.includes('llm') || titleLower.includes('gpt') || titleLower.includes('machine learn')) category = 'tech';

        items.push({
          id: `hn_${story.id}`,
          title,
          summary: title,
          url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
          source: 'Hacker News',
          published_at: story.time ? story.time * 1000 : Date.now(),
          category,
          sentiment: 'neutral',
          relevance_score: Math.min(100, 40 + (story.score || 0)),
          mentioned_tokens: [],
          priority: 0,
          created_at: Date.now(),
        });
      }
    }

    return items;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      logger.warn(`[News] HN ${config.name}: request timed out`);
    } else {
      logger.error(`[News] HN ${config.name}: ${err.message}`);
    }
    return [];
  }
}


export interface MacroSnapshot {
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  marketCapChangePercent24h: number;
}

export async function fetchMacroData(logger: LoggerInterface): Promise<{ snapshot: MacroSnapshot | null; newsItem: NewsItem | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch('https://api.coingecko.com/api/v3/global', {
      signal: controller.signal,
      headers: { 'User-Agent': 'WhiteOwl/1.0' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn(`[News] CoinGecko global: ${res.status}`);
      return { snapshot: null, newsItem: null };
    }

    const body = await res.json() as { data?: any };
    const d = body.data;
    if (!d) return { snapshot: null, newsItem: null };

    const snapshot: MacroSnapshot = {
      totalMarketCap: d.total_market_cap?.usd || 0,
      totalVolume24h: d.total_volume?.usd || 0,
      btcDominance: d.market_cap_percentage?.btc || 0,
      marketCapChangePercent24h: d.market_cap_change_percentage_24h_usd || 0,
    };


    const changePercent = snapshot.marketCapChangePercent24h;
    let newsItem: NewsItem | null = null;

    if (Math.abs(changePercent) > 2) {
      const direction = changePercent > 0 ? 'rose' : 'fell';
      const sentiment = changePercent > 0 ? 'bullish' : 'bearish';
      const mcapTrln = (snapshot.totalMarketCap / 1e12).toFixed(2);

      newsItem = {
        id: `macro_global_${Date.now()}`,
        title: `Crypto market cap ${changePercent > 0 ? 'up' : 'down'} ${Math.abs(changePercent).toFixed(1)}% in 24h — $${mcapTrln}T`,
        summary: `Total crypto market cap: $${mcapTrln}T. BTC dominance: ${snapshot.btcDominance.toFixed(1)}%. 24h volume: $${(snapshot.totalVolume24h / 1e9).toFixed(0)}B.`,
        summary_ru: `Crypto market cap ${direction} ${Math.abs(changePercent).toFixed(1)}% in 24h — $${mcapTrln}T. BTC dominance: ${snapshot.btcDominance.toFixed(1)}%.`,
        source: 'CoinGecko',
        published_at: Date.now(),
        category: 'macro',
        sentiment: sentiment as any,
        relevance_score: Math.min(100, 50 + Math.abs(changePercent) * 10),
        mentioned_tokens: ['BTC', 'ETH'],
        priority: 0,
        created_at: Date.now(),
      };
    }

    return { snapshot, newsItem };
  } catch (err: any) {
    logger.error(`[News] Macro data fetch failed: ${err.message}`);
    return { snapshot: null, newsItem: null };
  }
}
