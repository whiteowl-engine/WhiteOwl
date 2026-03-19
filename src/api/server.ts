import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { Runtime } from '../runtime';
import { LoggerInterface, EventName } from '../types';
import { buildExtensionPackage, computeExtensionId, getOrCreateKey } from './crx-builder';
import { MetricsCollector } from '../core/metrics';
import { getAvailableModels } from '../config';
import { CursorProvider } from '../llm/providers';

export function createAPIServer(runtime: Runtime, port: number, logger: LoggerInterface, apiKey?: string) {
  const app = express();

  // ── In-memory store for chat responses (survives page refresh) ──
  const chatResponseStore = new Map<string, {
    status: 'processing' | 'done' | 'error';
    agentId: string;
    events: Array<{ type: string; [key: string]: any }>;
    response?: string;
    error?: string;
    startedAt: number;
  }>();

  // Clean up old entries every 5 minutes (keep last 30 min)
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, val] of chatResponseStore) {
      if (val.startedAt < cutoff) chatResponseStore.delete(key);
    }
  }, 5 * 60 * 1000);

  // ── Full reverse proxy for desktop browser — MUST be before body parsers ──
  app.use('/p', (req: any, res: any) => {
    // URL format: /p/{host}/path?query → https://{host}/path?query
    const match = req.url.match(/^\/([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/.*)$/);
    if (!match) {
      // Try bare host: /p/{host}
      const bare = req.url.match(/^\/([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})\/?$/);
      if (bare) return res.redirect(302, `/p/${bare[1]}/`);
      return res.status(400).send('Bad proxy URL');
    }
    const host = match[1];
    const targetPath = match[2];
    const targetUrl = `https://${host}${targetPath}`;

    // Security: block internal/private IPs
    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
    if (blockedHosts.some(h => host.includes(h))) {
      return res.status(403).send('Blocked host');
    }

    const parsedTarget = new URL(targetUrl);

    // Build proxy request headers
    const proxyHeaders: Record<string, string> = {
      'host': host,
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
    };
    // Forward relevant headers
    if (req.headers['content-type']) proxyHeaders['content-type'] = req.headers['content-type'];
    if (req.headers['content-length']) proxyHeaders['content-length'] = req.headers['content-length'];
    if (req.headers['referer']) {
      // Rewrite referer to point to original domain
      try {
        const refUrl = new URL(req.headers['referer']);
        const refMatch = refUrl.pathname.match(/^\/p\/([^\/]+)(\/.*)$/);
        if (refMatch) proxyHeaders['referer'] = `https://${refMatch[1]}${refMatch[2]}`;
      } catch {}
    } else {
      proxyHeaders['referer'] = `https://${host}/`;
    }
    if (req.headers['origin']) {
      proxyHeaders['origin'] = `https://${host}`;
    }
    // Forward cookies
    if (req.headers['cookie']) proxyHeaders['cookie'] = req.headers['cookie'];

    const proxyReq = https.request({
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || 443,
      path: parsedTarget.pathname + parsedTarget.search,
      method: req.method,
      headers: proxyHeaders,
      rejectUnauthorized: false,
    } as any, (proxyRes: any) => {
      // Handle redirects — rewrite Location to stay in proxy
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let loc = proxyRes.headers.location;
        try {
          const locUrl = new URL(loc, targetUrl);
          if (locUrl.hostname === host || locUrl.hostname.endsWith('.' + host)) {
            loc = `/p/${locUrl.hostname}${locUrl.pathname}${locUrl.search}`;
          } else {
            // Different domain redirect — proxy that domain too
            loc = `/p/${locUrl.hostname}${locUrl.pathname}${locUrl.search}`;
          }
        } catch {
          if (loc.startsWith('/')) loc = `/p/${host}${loc}`;
        }
        res.writeHead(proxyRes.statusCode, { 'Location': loc });
        res.end();
        return;
      }

      const ct = (proxyRes.headers['content-type'] || 'application/octet-stream').toLowerCase();

      // Build response headers — strip frame-blocking ones
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const kl = k.toLowerCase();
        if (kl === 'x-frame-options') continue;
        if (kl === 'content-security-policy') continue;
        if (kl === 'content-security-policy-report-only') continue;
        if (kl === 'x-content-type-options') continue;
        if (kl === 'content-encoding') continue; // we requested identity
        if (kl === 'content-length') continue; // will change for HTML
        if (kl === 'transfer-encoding') continue;
        if (kl === 'set-cookie') {
          // Translate cookies: strip Domain, adjust Path
          const cookies = Array.isArray(v) ? v : [v as string];
          const translated = cookies.map((c: string) => {
            return c
              .replace(/;\s*[Dd]omain=[^;]*/g, '')
              .replace(/;\s*[Pp]ath=([^;]*)/g, `;Path=/p/${host}$1`)
              .replace(/;\s*[Ss]ecure/g, '')
              .replace(/;\s*[Ss]ame[Ss]ite=[^;]*/g, ';SameSite=Lax');
          });
          respHeaders['set-cookie'] = translated;
          continue;
        }
        if (v !== undefined) respHeaders[k] = v as string;
      }
      respHeaders['access-control-allow-origin'] = '*';

      if (ct.includes('text/html')) {
        // Collect HTML body
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');

          // Remove CSP meta tags
          html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
          // Remove frame-busting scripts
          html = html.replace(/if\s*\(\s*(?:top|window\.top|parent|window\.parent)\s*!==?\s*(?:self|window\.self|window)\s*\)[^}]*}/gi, '');
          html = html.replace(/top\.location\s*=\s*self\.location/gi, '');

          // Convert root-relative CF challenge URLs to relative so <base> tag applies
          // /cdn-cgi/... → cdn-cgi/...  and  /?__cf_chl_... → ?__cf_chl_...
          html = html.replace(/(["'])\/cdn-cgi\//g, '$1cdn-cgi/');
          html = html.replace(/(["'])\/\?__cf_chl_/g, '$1?__cf_chl_');
          // Also fix HTML attributes with root-relative paths
          html = html.replace(/(href|src|action)\s*=\s*"\/(?!\/)/gi, '$1="');
          html = html.replace(/(href|src|action)\s*=\s*'\/(?!\/)/gi, "$1='");

          // Inject <base> AFTER URL rewriting so it doesn't get mangled
          const baseTag = `<base href="/p/${host}/">`;
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
          } else if (/<html[^>]*>/i.test(html)) {
            html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
          } else {
            html = `<head>${baseTag}</head>` + html;
          }

          // Inject navigation interceptor for link clicks + title reporter + fetch/XHR/WS proxy
          const injScript = `<script>
(function(){
  var proxyOrigin = window.location.origin;
  // Extract target host from proxy path
  var pathMatch = window.location.pathname.match(/^\\/p\\/([^\\/]+)/);
  var targetHost = pathMatch ? pathMatch[1] : '';
  var proxyBase = proxyOrigin + '/p/' + targetHost;

  function toProxyUrl(absUrl) {
    try {
      var u = new URL(absUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        return proxyOrigin + '/p/' + u.host + u.pathname + u.search + u.hash;
      }
    } catch(e) {}
    return null;
  }

  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;
    // Skip data URLs, blobs, etc
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
    
    try {
      // Handle absolute URLs (http:// or https://)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        var u = new URL(url);
        // Already pointing to our proxy
        if (u.origin === proxyOrigin && u.pathname.startsWith('/p/')) return url;
        // External URL - route through proxy
        return proxyOrigin + '/p/' + u.host + u.pathname + u.search + u.hash;
      }
      // Handle protocol-relative URLs (//example.com/path)
      if (url.startsWith('//')) {
        var u2 = new URL('https:' + url);
        return proxyOrigin + '/p/' + u2.host + u2.pathname + u2.search + u2.hash;
      }
      // Handle root-relative URLs (/path/to/resource)
      if (url.startsWith('/')) {
        // Already a proxy path
        if (url.startsWith('/p/')) return url;
        // Route through current target host
        return proxyBase + url;
      }
      // Relative URLs (path/to/resource) - let browser resolve with base tag
      return url;
    } catch(e) {
      console.warn('[Proxy] URL rewrite error:', e, url);
    }
    return url;
  }

  // Intercept fetch to route ALL requests through proxy
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') {
        var newUrl = rewriteUrl(input);
        if (newUrl !== input) {
          console.log('[Proxy] fetch:', input, '->', newUrl);
          input = newUrl;
        }
      } else if (input instanceof Request) {
        var newUrl = rewriteUrl(input.url);
        if (newUrl !== input.url) {
          console.log('[Proxy] fetch Request:', input.url, '->', newUrl);
          // Clone request with new URL
          var newInit = {};
          ['method','headers','body','mode','credentials','cache','redirect','referrer','integrity'].forEach(function(k) {
            if (input[k] !== undefined) newInit[k] = input[k];
          });
          if (init) Object.assign(newInit, init);
          // Force cors mode for cross-origin
          newInit.mode = 'cors';
          newInit.credentials = 'include';
          input = new Request(newUrl, newInit);
        }
      }
    } catch(e) { console.warn('[Proxy] fetch intercept error:', e); }
    return origFetch.call(this, input, init);
  };

  // Intercept XMLHttpRequest.open
  var origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      var newUrl = rewriteUrl(url);
      if (newUrl !== url) {
        console.log('[Proxy] XHR:', url, '->', newUrl);
        arguments[1] = newUrl;
      }
    } catch(e) { console.warn('[Proxy] XHR intercept error:', e); }
    return origXHROpen.apply(this, arguments);
  };

  // Intercept WebSocket for real-time data - route through proxy
  var OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var wsUrl = url;
    try {
      var u = new URL(url);
      // Route wss:// and ws:// through our WebSocket proxy
      if ((u.protocol === 'wss:' || u.protocol === 'ws:') && u.host !== window.location.host) {
        wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + 
                window.location.host + '/wsp/' + u.host + u.pathname + u.search;
        console.log('[Proxy] WebSocket:', url, '->', wsUrl);
      }
    } catch(e) { console.warn('[Proxy] WebSocket URL parse error:', e); }
    return protocols ? new OrigWS(wsUrl, protocols) : new OrigWS(wsUrl);
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  window.WebSocket.CLOSED = OrigWS.CLOSED;

  // Intercept Image loading
  var origImage = window.Image;
  window.Image = function(w, h) {
    var img = new origImage(w, h);
    var origSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (origSrcDesc && origSrcDesc.set) {
      Object.defineProperty(img, 'src', {
        set: function(v) {
          var newV = rewriteUrl(v);
          if (newV !== v) console.log('[Proxy] Image:', v, '->', newV);
          origSrcDesc.set.call(this, newV);
        },
        get: function() { return origSrcDesc.get.call(this); }
      });
    }
    return img;
  };

  // Intercept dynamic script/img/link element creation
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreateElement(tag);
    var tagLower = tag.toLowerCase();
    if (tagLower === 'script' || tagLower === 'img' || tagLower === 'link' || tagLower === 'iframe') {
      var srcAttr = tagLower === 'link' ? 'href' : 'src';
      var origDesc = Object.getOwnPropertyDescriptor(el.__proto__, srcAttr);
      if (origDesc && origDesc.set) {
        Object.defineProperty(el, srcAttr, {
          set: function(v) {
            var newV = rewriteUrl(v);
            if (newV !== v) console.log('[Proxy] ' + tag + '.' + srcAttr + ':', v, '->', newV);
            origDesc.set.call(this, newV);
          },
          get: function() { return origDesc.get ? origDesc.get.call(this) : this.getAttribute(srcAttr); },
          configurable: true
        });
      }
    }
    return el;
  };

  // Intercept links → rewrite to proxy URLs
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) return;
    
    var newHref = rewriteUrl(href);
    if (newHref !== href) {
      e.preventDefault();
      e.stopPropagation();
      console.log('[Proxy] link click:', href, '->', newHref);
      if (a.target === '_blank') {
        window.open(newHref, '_blank');
      } else {
        window.parent.postMessage({ type: 'desk-navigate', url: href }, '*');
        window.location.href = newHref;
      }
      return false;
    }
  }, true);

  // Report title
  var lastTitle = '';
  setInterval(function() {
    if (document.title && document.title !== lastTitle) {
      lastTitle = document.title;
      window.parent.postMessage({ type: 'desk-title', title: document.title }, '*');
    }
  }, 500);

  // Report current real URL
  setInterval(function() {
    try {
      var path = window.location.pathname;
      var m = path.match(/^\\/p\\/([^\\/]+)(\\/.*)$/);
      if (m) {
        var realUrl = 'https://' + m[1] + m[2] + window.location.search;
        window.parent.postMessage({ type: 'desk-url', url: realUrl }, '*');
      }
    } catch(ex) {}
  }, 1000);

  console.log('[Proxy] Interceptors installed for host:', targetHost);
})();
</script>`;
          html = html.replace(/<\/body>/i, injScript + '</body>');
          if (!/<\/body>/i.test(html)) html += injScript;

          respHeaders['content-type'] = ct;
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(html);
        });
      } else if (ct.includes('text/css') || ct.includes('stylesheet')) {
        // Rewrite URLs in CSS files
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let css = Buffer.concat(chunks).toString('utf-8');
          
          // Rewrite url() references
          css = css.replace(/url\(\s*['"]?(https?:\/\/[^'"\)]+)['"]?\s*\)/gi, (match, url) => {
            try {
              const u = new URL(url);
              return `url("/p/${u.host}${u.pathname}${u.search}")`;
            } catch { return match; }
          });
          // Rewrite protocol-relative URLs
          css = css.replace(/url\(\s*['"]?(\/\/[^'"\)]+)['"]?\s*\)/gi, (match, url) => {
            try {
              const u = new URL('https:' + url);
              return `url("/p/${u.host}${u.pathname}${u.search}")`;
            } catch { return match; }
          });
          // Rewrite root-relative URLs to go through proxy
          css = css.replace(/url\(\s*['"]?(\/[^'"\)]+)['"]?\s*\)/gi, (match, path) => {
            if (path.startsWith('/p/')) return match;
            return `url("/p/${host}${path}")`;
          });
          
          respHeaders['content-type'] = ct;
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(css);
        });
      } else if (ct.includes('javascript') || ct.includes('application/json')) {
        // Rewrite URLs in JavaScript and JSON
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let js = Buffer.concat(chunks).toString('utf-8');
          
          // Rewrite absolute URLs in strings
          js = js.replace(/(["'])(https?:\/\/)([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/[^"']*)?(['"])/g, 
            (match, q1, proto, domain, path, q2) => {
              // Skip if it's our own proxy URL
              if (domain === 'localhost' || domain.startsWith('127.')) return match;
              return `${q1}/p/${domain}${path || '/'}${q2}`;
            });
          // Rewrite protocol-relative URLs in strings
          js = js.replace(/(["'])(\/\/)([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/[^"']*)?(['"])/g,
            (match, q1, slashes, domain, path, q2) => {
              return `${q1}/p/${domain}${path || '/'}${q2}`;
            });
          
          respHeaders['content-type'] = ct;
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(js);
        });
      } else {
        // Non-HTML/CSS/JS: pipe through directly
        res.writeHead(proxyRes.statusCode || 200, respHeaders);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err: any) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy error: ' + (err.message || String(err)) });
      }
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Proxy timeout' });
    });

    // Pipe request body for POST/PUT etc
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });

  app.use(express.json({ limit: '10mb' }));

  // CORS — allow cross-origin requests
  app.use(cors());

  // Rate limiting — 100 requests per minute per IP
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use(limiter);

  // =====================================================
  // Session-based auth — tokens persisted to disk
  // =====================================================
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const SESSIONS_FILE = path.join('./data', 'sessions.json');

  interface SessionData { username: string; provider: string; createdAt: number }
  const authSessions = new Map<string, SessionData>();

  // Load sessions from disk on startup
  function loadSessions(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        const entries: [string, SessionData][] = JSON.parse(raw);
        const now = Date.now();
        let loaded = 0;
        for (const [token, session] of entries) {
          if (now - session.createdAt < SESSION_TTL_MS) {
            authSessions.set(token, session);
            loaded++;
          }
        }
        if (loaded > 0) logger.info(`Restored ${loaded} auth session(s) from disk`);
      }
    } catch { /* first run or corrupted — start fresh */ }
  }

  function saveSessions(): void {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = Array.from(authSessions.entries());
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(entries), 'utf-8');
    } catch { /* non-critical */ }
  }

  loadSessions();

  // Periodic session cleanup every 30 minutes
  setInterval(() => {
    const now = Date.now();
    let deleted = false;
    for (const [token, session] of authSessions) {
      if (now - session.createdAt > SESSION_TTL_MS) { authSessions.delete(token); deleted = true; }
    }
    if (deleted) saveSessions();
  }, 30 * 60 * 1000);

  function generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  function getAuthToken(req: express.Request): string | undefined {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) return header.slice(7);
    return req.query.token as string | undefined;
  }

  function isAuthenticated(req: express.Request): boolean {
    const token = getAuthToken(req);
    if (!token) return false;
    const session = authSessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      authSessions.delete(token);
      saveSessions();
      return false;
    }
    return true;
  }

  // Public route prefixes — no auth required
  const publicPrefixes = [
    '/api/auth/',
    '/api/oauth/',
    '/api/twitter/',
    '/health',
    '/metrics',
    '/dashboard',
    '/extension',
    '/skillhub',
    '/desktop-browse',
    '/p/',
    '/api/projects/preview/',
  ];

  // Exact public paths
  const publicExact = new Set(['/', '/dashboard', '/proxy-sw.js']);

  // Auth middleware — gates all API routes except public ones
  app.use((req, res, next) => {
    const path = req.path;
    // Allow exact public paths
    if (publicExact.has(path)) return next();
    // Allow public prefixes
    if (publicPrefixes.some(p => path.startsWith(p))) return next();
    // Allow static assets
    if (path.match(/\.(html|css|js|ico|png|svg|jpg|woff2?)$/)) return next();
    // API key bypass (legacy)
    if (apiKey) {
      const key = req.headers['x-api-key'] || req.query.key;
      if (key === apiKey) return next();
    }
    // Check session token
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  });

  // =====================================================
  // Auth API — login / status / logout
  // =====================================================

  // Login with "Free AI" (no real auth, just a username) or OAuth provider
  app.post('/api/auth/login', (req, res) => {
    const { username, provider } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length < 1) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const sanitized = username.trim().slice(0, 50);
    const token = generateToken();
    authSessions.set(token, {
      username: sanitized,
      provider: provider || 'free',
      createdAt: Date.now(),
    });
    saveSessions();
    logger.info(`User logged in: ${sanitized} (${provider || 'free'})`);
    res.json({ token, username: sanitized, provider: provider || 'free' });
  });

  // Check auth status
  app.get('/api/auth/status', (req, res) => {
    const token = getAuthToken(req);
    if (!token || !authSessions.has(token)) {
      return res.json({ authenticated: false });
    }
    const session = authSessions.get(token)!;
    res.json({ authenticated: true, username: session.username, provider: session.provider });
  });

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    const token = getAuthToken(req);
    if (token) { authSessions.delete(token); saveSessions(); }
    res.json({ success: true });
  });

  // Status
  app.get('/api/status', async (_req, res) => {
    try {
      const status = runtime.getStatus();
      const w = runtime.getWallet();
      const balance = w.hasWallet() ? await w.getBalance().catch(() => 0) : 0;
      res.json({ ...status, balance });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Wallet management
  app.get('/api/wallet', async (_req, res) => {
    try {
      const w = runtime.getWallet();
      if (!w.hasWallet()) {
        return res.json({ configured: false, address: '', balance: 0, recentTxs: [], wallets: w.getStoredWallets() });
      }
      const address = w.getAddress();
      // Ensure the active wallet is in the store (e.g. loaded from env)
      const stored = w.getStoredWallets();
      if (!stored.some(s => s.address === address)) {
        w.addCurrentToStore('Main Wallet');
      }
      const wallets = w.getStoredWallets();
      // Fetch balance and txs in parallel, with short timeout
      const connection = w.getConnection();
      const [balance, recentTxs] = await Promise.all([
        w.getBalance().catch(() => 0),
        connection.getSignaturesForAddress(w.getPublicKey(), { limit: 10 })
          .then(sigs => sigs.map(s => ({
            signature: s.signature,
            slot: s.slot,
            time: s.blockTime ? s.blockTime * 1000 : null,
            status: s.err ? 'failed' : 'success',
            memo: s.memo || null
          })))
          .catch(() => [] as any[])
      ]);
      res.json({ configured: true, address, balance, recentTxs, wallets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/wallet/export', (_req, res) => {
    try {
      const pk = runtime.getWallet().exportPrivateKey();
      res.json({ privateKey: pk });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/wallet/import', (req, res) => {
    try {
      const { privateKey, name } = req.body;
      if (!privateKey || typeof privateKey !== 'string') {
        return res.status(400).json({ error: 'privateKey is required' });
      }
      runtime.getWallet().importFromKey(privateKey.trim(), name || undefined);
      res.json({ address: runtime.getWallet().getAddress() });
    } catch (err: any) {
      res.status(400).json({ error: 'Invalid private key: ' + err.message });
    }
  });

  app.post('/api/wallet/generate', (req, res) => {
    try {
      const { name } = req.body || {};
      const result = runtime.getWallet().generateNew(name || undefined);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/wallet/withdraw', async (req, res) => {
    try {
      const { to, amount } = req.body;
      if (!to || !amount) return res.status(400).json({ error: 'to and amount are required' });
      const { PublicKey: PK, SystemProgram, Transaction: Tx } = await import('@solana/web3.js');
      const lamports = Math.round(Number(amount) * 1_000_000_000);
      if (lamports <= 0) return res.status(400).json({ error: 'Invalid amount' });
      let toPubkey: InstanceType<typeof PK>;
      try { toPubkey = new PK(to); } catch { return res.status(400).json({ error: 'Invalid address' }); }
      const tx = new Tx().add(SystemProgram.transfer({
        fromPubkey: runtime.getWallet().getPublicKey(),
        toPubkey,
        lamports
      }));
      const sig = await runtime.getWallet().signAndSend(tx);
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Wallet list (all stored wallets)
  app.get('/api/wallet/list', (_req, res) => {
    try {
      const w = runtime.getWallet();
      const wallets = w.getStoredWallets();
      const active = w.getAddress();
      res.json({ wallets, activeAddress: active });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Switch active wallet
  app.post('/api/wallet/switch', (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const ok = runtime.getWallet().switchToWallet(address);
      if (!ok) return res.status(404).json({ error: 'Wallet not found in storage' });
      res.json({ address: runtime.getWallet().getAddress() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete wallet from store
  app.post('/api/wallet/delete', (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const ok = runtime.getWallet().removeFromStore(address);
      if (!ok) return res.status(404).json({ error: 'Wallet not found' });
      res.json({ ok: true, hasWallet: runtime.getWallet().hasWallet() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rename wallet in store
  app.post('/api/wallet/rename', (req, res) => {
    try {
      const { address, name } = req.body;
      if (!address || !name) return res.status(400).json({ error: 'address and name are required' });
      const ok = runtime.getWallet().renameInStore(address, name.toString().trim().slice(0, 32));
      if (!ok) return res.status(404).json({ error: 'Wallet not found' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Session management
  app.post('/api/session/start', async (req, res) => {
    try {
      const { mode, strategy, duration, reportInterval } = req.body;
      const session = await runtime.startSession({
        mode: mode || 'monitor',
        strategy,
        durationMinutes: duration,
        reportIntervalMinutes: reportInterval,
      });
      res.json(session);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session/stop', async (_req, res) => {
    try {
      const session = await runtime.stopSession();
      res.json(session || { status: 'no_active_session' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/session/pause', (_req, res) => {
    runtime.pauseSession();
    res.json({ status: 'paused' });
  });

  app.post('/api/session/resume', (_req, res) => {
    runtime.resumeSession();
    res.json({ status: 'resumed' });
  });

  // Stats
  app.get('/api/stats', (_req, res) => {
    res.json(runtime.getSessionStats());
  });

  app.get('/api/stats/:period', (req, res) => {
    const period = req.params.period as '1h' | '4h' | '24h' | '7d' | 'all';
    const stats = runtime.getMemory().getStats(period);
    res.json(stats);
  });

  // Trades
  app.get('/api/trades', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const mint = req.query.mint as string | undefined;
    const trades = runtime.getMemory().getTradeHistory({ limit, mint });
    res.json(trades);
  });

  // Tokens
  app.get('/api/tokens/trending', (_req, res) => {
    const trending = runtime.getMemory().getTokenStore().getTrendingTokens(20);
    res.json(trending);
  });

  app.get('/api/tokens/top/:period', (req, res) => {
    const period = req.params.period as '1h' | '4h' | '24h';
    const by = (req.query.by as string) || 'volume';
    const tokens = runtime.getMemory().getTopTokens(
      period,
      by as 'volume' | 'mcap' | 'holders' | 'mentions',
      20
    );
    res.json(tokens);
  });

  app.get('/api/tokens/:mint', async (req, res) => {
    const mint = req.params.mint;
    let token = runtime.getMemory().getToken(mint);

    // If not in DB (or has no market data), fetch live from pump.fun + DexScreener
    if (!token || (!token.marketCap && !token.volume24h)) {

      // 1) Try pump.fun for metadata
      try {
        const pumpRes = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, {
          headers: { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' },
        });
        if (pumpRes.ok) {
          const text = await pumpRes.text();
          if (text && text.length > 2) {
            const pf = JSON.parse(text);
            const realSol = (pf.real_sol_reserves || 0) / 1e9;
            const virtualSol = (pf.virtual_sol_reserves || 0) / 1e9;
            const virtualTokens = (pf.virtual_token_reserves || 0) / 1e6;
            const isComplete = !!pf.complete || !!pf.pool_address;
            const bondingProgress = isComplete ? 100 : (realSol > 0 ? Math.min((realSol / 85) * 100, 100) : 0);
            const price = virtualTokens > 0 ? virtualSol / virtualTokens : 0;

            token = {
              mint: pf.mint || mint,
              name: pf.name || '',
              symbol: pf.symbol || '',
              description: pf.description || '',
              image: pf.image_uri || '',
              twitter: pf.twitter || '',
              telegram: pf.telegram || '',
              website: pf.website || '',
              dev: pf.creator || '',
              createdAt: pf.created_timestamp || Date.now(),
              bondingCurveProgress: bondingProgress,
              marketCap: pf.usd_market_cap || pf.market_cap || 0,
              volume24h: 0,
              holders: 0,
              price,
            };

            runtime.getMemory().getTokenStore().store(token);
            runtime.getMemory().getTokenStore().storeSnapshot({
              mint, price, mcap: token.marketCap || 0,
              volume5m: 0, volume1h: 0, volume24h: 0, holders: 0,
              bondingProgress, timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        logger.warn(`pump.fun fetch failed for ${mint}: ${err}`);
      }

      // 2) Fetch DexScreener + RugCheck in parallel for market data & holder count
      let holderCount = 0;
      const [dexResult, rugResult] = await Promise.allSettled([
        fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then(r => r.ok ? r.json() as Promise<any> : null),
        fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() as Promise<any> : null),
      ]);

      // Process RugCheck data (holder count)
      try {
        const rug = rugResult.status === 'fulfilled' ? rugResult.value as any : null;
        if (rug && rug.totalHolders) {
          holderCount = rug.totalHolders;
          if (token && !token.holders) token.holders = holderCount;
        }
      } catch {}

      // Fallback: if RugCheck returned 0 holders, try Solana RPC getTokenLargestAccounts
      if (!holderCount) {
        try {
          const rpcUrl = runtime.getRpcConfig?.()?.helius || runtime.getRpcConfig?.()?.solana || 'https://api.mainnet-beta.solana.com';
          const rpcRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint] }),
            signal: AbortSignal.timeout(8000),
          });
          if (rpcRes.ok) {
            const rpcData = await rpcRes.json() as any;
            const accounts = rpcData?.result?.value;
            if (Array.isArray(accounts) && accounts.length > 0) {
              holderCount = accounts.length; // up to 20
              if (token && !token.holders) token.holders = holderCount;
            }
          }
        } catch {}
      }

      // Process DexScreener data
      try {
        const dex = dexResult.status === 'fulfilled' ? dexResult.value as any : null;
        if (dex) {
          const pairs = (dex.pairs || []).filter((p: any) => p.chainId === 'solana');
          if (pairs.length > 0) {
            const best = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            const vol24h = best.volume?.h24 || 0;
            const mcap = best.marketCap || best.fdv || 0;
            const dexPrice = parseFloat(best.priceUsd) || 0;

            // If pump.fun didn't return data, build token from DexScreener
            if (!token) {
              const bt = best.baseToken || {};
              token = {
                mint: bt.address || mint,
                name: bt.name || '',
                symbol: bt.symbol || '',
                description: '',
                image: best.info?.imageUrl || '',
                twitter: '',
                telegram: '',
                website: '',
                dev: '',
                createdAt: best.pairCreatedAt ? new Date(best.pairCreatedAt).getTime() : Date.now(),
                bondingCurveProgress: 100, // graduated if on DEX
                marketCap: mcap,
                volume24h: vol24h,
                holders: holderCount,
                price: dexPrice,
              };
              // Extract socials if available
              if (best.info?.socials) {
                for (const s of best.info.socials) {
                  if (s.type === 'twitter' && s.url) token.twitter = s.url.split('/').pop() || '';
                  if (s.type === 'telegram' && s.url) token.telegram = s.url.split('/').pop() || '';
                }
              }
              if (best.info?.websites?.[0]?.url) token.website = best.info.websites[0].url;
              runtime.getMemory().getTokenStore().store(token);
            } else {
              if (vol24h) token.volume24h = vol24h;
              if (mcap && mcap > (token.marketCap || 0)) token.marketCap = mcap;
              if (dexPrice) token.price = dexPrice;
              if (holderCount && !token.holders) token.holders = holderCount;
            }

            // Store snapshot with combined data
            runtime.getMemory().getTokenStore().storeSnapshot({
              mint,
              price: token.price || 0,
              mcap: token.marketCap || 0,
              volume5m: best.volume?.m5 || 0,
              volume1h: best.volume?.h1 || 0,
              volume24h: vol24h,
              holders: holderCount,
              bondingProgress: token.bondingCurveProgress || 0,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err) {
        logger.warn(`DexScreener processing failed for ${mint}: ${err}`);
      }
    }

    if (!token) return res.status(404).json({ error: 'Token not found' });
    const analysis = runtime.getMemory().getAnalysis(mint);
    const holders = runtime.getMemory().getHolderData(mint);
    res.json({ token, analysis, holders });
  });

  // Chat with agents
  app.post('/api/chat', async (req, res) => {
    try {
      const { agent, message, chatId, image: rawImage, projectFolder } = req.body;
      if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
      if (message.length > 100000) return res.status(400).json({ error: 'Message too long (max 100K chars)' });
      const agentId = typeof agent === 'string' ? agent.slice(0, 50) : 'commander';
      const image = typeof rawImage === 'string' && rawImage.length < 4_000_000 ? rawImage : undefined;

      // Set chatId and projectFolder on ProjectsSkill
      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      if (projectsSkill?.setChatId && chatId) projectsSkill.setChatId(String(chatId).slice(0, 100));
      if (projectsSkill?.setProjectFolder) projectsSkill.setProjectFolder(projectFolder ? String(projectFolder).slice(0, 500) : '');

      // Collect tool calls and thinking steps during processing
      const steps: { type: string; tool?: string; params?: any; round?: number; result?: string; durationMs?: number }[] = [];
      const eventBus = runtime.getEventBus();
      const toolCallHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        steps.push({ type: 'tool_call', tool: data.tool, params: data.params, round: data.round });
      };
      const toolResultHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        steps.push({ type: 'tool_result', tool: data.tool, result: data.result, durationMs: data.durationMs });
      };
      const thinkingHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        steps.push({ type: 'thinking', round: data.round, tool: undefined });
      };
      eventBus.on('agent:tool_call' as any, toolCallHandler);
      eventBus.on('agent:tool_result' as any, toolResultHandler);
      eventBus.on('agent:llm_response' as any, thinkingHandler);

      const response = await runtime.chat(agentId, message, image);

      eventBus.off('agent:tool_call' as any, toolCallHandler);
      eventBus.off('agent:tool_result' as any, toolResultHandler);
      eventBus.off('agent:llm_response' as any, thinkingHandler);

      res.json({ agent: agentId, response, steps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AI Widget Generator — generates HTML/CSS/JS widget code from natural language description
  app.post('/api/ui/generate-widget', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
      if (prompt.length > 2000) return res.status(400).json({ error: 'Prompt too long (max 2000 chars)' });

      const systemPrompt = `You are a UI widget generator for the WhiteOwl trading dashboard. The user will describe a widget they want.

RULES:
1. Return ONLY a valid JSON object, no markdown, no code fences, no explanation
2. The JSON must have these fields:
   - "title": short widget title (string)
   - "html": the widget HTML (string, inline styles only, use CSS variables: --bg, --surface, --surface2, --border, --text, --text2, --muted, --primary, --green, --red, --yellow, --purple, --cyan, --orange)
   - "js": optional JavaScript code that runs after insertion (string or ""). Use vanilla JS only. You can use these helpers: api(url,method,body) for API calls, $(sel) for querySelector, $$(sel) for querySelectorAll, esc(str) for HTML escaping, toast(msg,type) for notifications. For data display use fetch to /api/status, /api/portfolio, /api/stats/24h, /api/events, /api/skills. Use setInterval for auto-refresh (store interval ID in window.__widget_intervals).
   - "css": optional extra CSS (string or "")
   - "refreshInterval": optional auto-refresh in seconds (number or 0)
3. Keep it self-contained. The widget appears inside a card with class "cust-ai-widget" on the dashboard.
4. Use dark theme colors matching the WhiteOwl design.
5. Make it compact and functional.
6. NEVER include script tags in html. JS goes in "js" field only.
7. NEVER use eval, Function constructor, innerHTML with user input, or any dangerous patterns.

Available API endpoints:
- GET /api/status — { wallet, balance, session: {mode, status}, uptime, agents[], skills[] }
- GET /api/stats/24h — { totalPnlSol, tradesExecuted, tradesWon, tradesLost, peakPnlSol, worstDrawdownSol }
- GET /api/portfolio — { positions[], trades[] }
- GET /api/events?limit=20 — recent events array
- GET /api/skills — skills with tools array

Example response:
{"title":"SOL Balance","html":"<div id=\\"wb\\"><span style=\\"color:var(--muted);font-size:.75rem\\">Balance</span><div id=\\"wbVal\\" style=\\"font-size:1.5rem;font-weight:800;color:var(--green)\\">...</div></div>","js":"function loadBal(){api('/api/status').then(function(s){document.getElementById('wbVal').textContent=(s.balance||0).toFixed(4)+' SOL'}).catch(function(){})}loadBal();","css":"","refreshInterval":30}`;

      const aiMsg = `Generate a dashboard widget: ${prompt}`;
      const response = await runtime.chat('commander', `[SYSTEM INSTRUCTION — you are a widget code generator, respond ONLY with raw JSON, no markdown]\n\n${systemPrompt}\n\nUser request: ${aiMsg}`);

      // Try to extract JSON from response
      let widget;
      try {
        // Try direct JSON parse first
        widget = JSON.parse(response);
      } catch {
        // Try to find JSON in the response
        const jsonMatch = response.match(/\{[\s\S]*"title"[\s\S]*"html"[\s\S]*\}/);
        if (jsonMatch) {
          widget = JSON.parse(jsonMatch[0]);
        } else {
          return res.status(422).json({ error: 'AI did not return valid widget JSON. Try rephrasing your request.', raw: response.slice(0, 500) });
        }
      }

      // Validate required fields
      if (!widget.title || !widget.html) {
        return res.status(422).json({ error: 'Widget missing required fields (title, html)' });
      }

      // Security: sanitize JS — block dangerous patterns
      const js = widget.js || '';
      const forbidden = ['eval(', 'Function(', 'new Function', 'document.write', 'document.cookie', 'localStorage.clear', 'window.location', 'XMLHttpRequest', '<script', 'import(', 'require('];
      for (const f of forbidden) {
        if (js.includes(f)) {
          return res.status(422).json({ error: `Widget JS contains forbidden pattern: ${f}` });
        }
      }

      res.json({
        widget: {
          id: 'w_' + Date.now().toString(36),
          title: String(widget.title).slice(0, 100),
          html: String(widget.html),
          js: js.slice(0, 5000),
          css: String(widget.css || '').slice(0, 2000),
          refreshInterval: Math.min(Number(widget.refreshInterval) || 0, 300),
          prompt: prompt,
          created: new Date().toISOString()
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Streaming chat with SSE — sends tool call progress events, then final response
  app.post('/api/chat/stream', async (req, res) => {
    try {
      const { agent, message, chatId, image: rawImage, projectFolder } = req.body;
      if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
      if (message.length > 100000) return res.status(400).json({ error: 'Message too long (max 100K chars)' });
      const agentId = typeof agent === 'string' ? agent.slice(0, 50) : 'commander';
      const image = typeof rawImage === 'string' && rawImage.length < 4_000_000 ? rawImage : undefined;
      const storeKey = chatId ? String(chatId).slice(0, 100) : '';

      // Set chatId and projectFolder on ProjectsSkill
      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      if (projectsSkill?.setChatId && chatId) projectsSkill.setChatId(String(chatId).slice(0, 100));
      if (projectsSkill?.setProjectFolder) projectsSkill.setProjectFolder(projectFolder ? String(projectFolder).slice(0, 500) : '');

      // Initialize response store for this chat
      if (storeKey) {
        chatResponseStore.set(storeKey, {
          status: 'processing',
          agentId,
          events: [],
          startedAt: Date.now(),
        });
      }

      // Set up SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let clientDisconnected = false;
      req.on('close', () => { clientDisconnected = true; });

      const sendEvent = (type: string, data: any) => {
        const eventObj = { type, ...data };
        // Store event for reconnection
        if (storeKey) {
          const entry = chatResponseStore.get(storeKey);
          if (entry) entry.events.push(eventObj);
        }
        if (!clientDisconnected) {
          try { res.write(`data: ${JSON.stringify(eventObj)}\n\n`); } catch (_) {}
        }
      };

      // Listen for agent events during this chat
      const eventBus = runtime.getEventBus();
      const toolHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        sendEvent('tool_call', { tool: data.tool, params: data.params, round: data.round });
      };
      const toolResultHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        sendEvent('tool_result', { tool: data.tool, result: typeof data.result === 'string' ? data.result.slice(0, 500) : JSON.stringify(data.result).slice(0, 500), durationMs: data.durationMs });
      };
      const responseHandler = (data: any) => {
        if (data?.agentId !== agentId) return;
        sendEvent('thinking', { round: data.round, toolCalls: data.toolCallsCount });
      };

      eventBus.on('agent:tool_call' as any, toolHandler);
      eventBus.on('agent:tool_result' as any, toolResultHandler);
      eventBus.on('agent:llm_response' as any, responseHandler);

      sendEvent('status', { status: 'thinking', agentId });

      try {
        const response = await runtime.chat(agentId, message, image);
        sendEvent('response', { agent: agentId, response });
        // Store final response
        if (storeKey) {
          const entry = chatResponseStore.get(storeKey);
          if (entry) {
            entry.status = 'done';
            entry.response = response;
          }
        }
      } catch (err: any) {
        sendEvent('error', { error: err.message });
        if (storeKey) {
          const entry = chatResponseStore.get(storeKey);
          if (entry) {
            entry.status = 'error';
            entry.error = err.message;
          }
        }
      }

      eventBus.off('agent:tool_call' as any, toolHandler);
      eventBus.off('agent:tool_result' as any, toolResultHandler);
      eventBus.off('agent:llm_response' as any, responseHandler);

      sendEvent('done', {});
      if (!clientDisconnected) {
        try { res.end(); } catch (_) {}
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // Get pending/completed chat response (for page refresh reconnection)
  app.get('/api/chat/pending/:chatId', (req, res) => {
    const chatId = req.params.chatId;
    const entry = chatResponseStore.get(chatId);
    if (!entry) {
      return res.json({ found: false });
    }
    res.json({
      found: true,
      status: entry.status,
      agentId: entry.agentId,
      events: entry.events,
      response: entry.response,
      error: entry.error,
      elapsed: ((Date.now() - entry.startedAt) / 1000).toFixed(1),
    });
    // Clear after retrieval if done/error
    if (entry.status !== 'processing') {
      chatResponseStore.delete(chatId);
    }
  });

  // Get available agents for chat
  app.get('/api/chat/agents', async (_req, res) => {
    await runtime.ensureAgents();
    res.json({
      agents: runtime.getAvailableAgents(),
      models: runtime.getAgentModels(),
      capabilities: runtime.getAgentCapabilities(),
    });
  });

  // Force reload agents (after OAuth connection)
  app.post('/api/agents/reload', async (_req, res) => {
    try {
      const created = await runtime.ensureAgents();
      res.json({ success: created, agents: runtime.getAvailableAgents() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Available models for agent creation
  app.get('/api/models', (_req, res) => {
    res.json(getAvailableModels());
  });

  // Create custom agent
  app.post('/api/agents/create', async (req, res) => {
    try {
      const { name, role, model, skills, autonomy, riskLimits } = req.body;
      if (!name || !role || !model?.provider || !model?.model) {
        return res.status(400).json({ error: 'name, role, model.provider, model.model are required' });
      }
      const validAutonomy = ['autopilot', 'advisor', 'monitor', 'manual'];
      const agentConfig = {
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        role,
        model: { provider: model.provider, model: model.model },
        skills: Array.isArray(skills) ? skills : [],
        autonomy: validAutonomy.includes(autonomy) ? autonomy : 'advisor',
        riskLimits: {
          maxPositionSol: Number(riskLimits?.maxPositionSol) || 0.5,
          maxOpenPositions: Number(riskLimits?.maxOpenPositions) || 5,
          maxDailyLossSol: Number(riskLimits?.maxDailyLossSol) || 2,
          maxDrawdownPercent: Number(riskLimits?.maxDrawdownPercent) || 50,
        },
      };
      const result = runtime.addAgent(agentConfig as any);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const status = runtime.getStatus();
      const agent = status.agents.find(a => a.id === agentConfig.id);
      res.json({ success: true, agent });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete custom agent
  app.post('/api/agents/delete', (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id is required' });
      if (id === 'commander') {
        return res.status(400).json({ error: 'Cannot delete default agent' });
      }
      const result = runtime.removeAgent(id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update custom agent
  app.post('/api/agents/update', (req, res) => {
    try {
      const { id, name, role, model, skills, autonomy, riskLimits } = req.body;
      if (!id) return res.status(400).json({ error: 'id is required' });
      // Allow editing any agent
      const validAutonomy = ['autopilot', 'advisor', 'monitor', 'manual'];
      const agentConfig = {
        id,
        name: name || 'Agent',
        role: role || '',
        model: { provider: model?.provider || 'copilot', model: model?.model || 'gpt-4.1' },
        skills: Array.isArray(skills) ? skills : [],
        autonomy: validAutonomy.includes(autonomy) ? autonomy : 'advisor',
        riskLimits: {
          maxPositionSol: Number(riskLimits?.maxPositionSol) || 0.5,
          maxOpenPositions: Number(riskLimits?.maxOpenPositions) || 5,
          maxDailyLossSol: Number(riskLimits?.maxDailyLossSol) || 2,
          maxDrawdownPercent: Number(riskLimits?.maxDrawdownPercent) || 50,
        },
      };
      const result = runtime.updateAgent(agentConfig as any);
      if (!result.ok) return res.status(400).json({ error: result.error });
      const status = runtime.getStatus();
      const agent = status.agents.find(a => a.id === id);
      res.json({ success: true, agent });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Strategies
  app.get('/api/strategies', (_req, res) => {
    const strategies = runtime.getStrategyEngine().getAll();
    res.json(strategies);
  });

  // Optimize agent prompt via AI
  app.post('/api/agents/optimize-prompt', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required' });
      if (prompt.length > 4000) return res.status(400).json({ error: 'Prompt too long' });
      const optimizeRequest = [
        'You are an expert system prompt engineer.',
        'The user wrote a short/rough description of what they want their AI agent to do.',
        'Your ONLY job: expand it into a well-structured system prompt while STRICTLY preserving the user\'s original intent.',
        '',
        'CRITICAL RULES:',
        '- DO NOT change the topic or shift focus. If user says "analyze blockchain transactions" — the result must be about analyzing blockchain transactions, NOT about trading memecoins.',
        '- DO NOT add capabilities the user did not ask for. Only expand on what they actually wrote.',
        '- DO NOT assume the agent is a trading bot unless the user explicitly says so.',
        '- Preserve the user\'s language (Russian prompt → Russian output, English → English).',
        '- Add clear structure: identity, core task, how to approach the task, response format, rules.',
        '- Keep it focused and concise (max 500 words). Quality over quantity.',
        '- Output ONLY the optimized prompt text. No explanations, no markdown code fences, no preamble.',
        '',
        'User\'s rough prompt:',
        prompt,
      ].join('\n');
      const result = await runtime.chat('commander', optimizeRequest);
      res.json({ optimized: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Skills
  app.get('/api/skills', (_req, res) => {
    const manifests = runtime.getSkillLoader().getAllManifests();
    res.json(manifests);
  });

  // ── AI Todo List API ──
  const todosFilePath = path.resolve('./data/project-todos.json');
  app.get('/api/todos', (req, res) => {
    try {
      if (fs.existsSync(todosFilePath)) {
        const allTodos = JSON.parse(fs.readFileSync(todosFilePath, 'utf-8'));
        const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
        const todos = chatId
          ? allTodos.filter((t: any) => t.chatId === chatId)
          : allTodos;
        res.json({ todos });
      } else {
        res.json({ todos: [] });
      }
    } catch { res.json({ todos: [] }); }
  });

  // ── Projects API (sandboxed to ~/Desktop/Projects) ──
  const PROJECTS_ROOT = path.join(os.homedir(), 'Desktop', 'Projects');
  try { fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); } catch {}

  function ensureInsideProjects(p: string): string {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(PROJECTS_ROOT)) {
      throw new Error('Access denied: path must be inside Projects folder');
    }
    return resolved;
  }

  app.get('/api/projects/defaults', (_req, res) => {
    res.json({ home: PROJECTS_ROOT, sep: path.sep, platform: process.platform });
  });

  app.get('/api/projects/list', (req, res) => {
    try {
      const dirPath = (req.query.path as string) || PROJECTS_ROOT;
      const resolved = ensureInsideProjects(dirPath);
      const entries = fs.readdirSync(resolved);
      const result = entries.map(name => {
        const full = path.join(resolved, name);
        try {
          const st = fs.statSync(full);
          return { name, path: full, isDir: st.isDirectory(), size: st.size };
        } catch {
          return { name, path: full, isDir: false, size: 0 };
        }
      }).filter(e => !e.name.startsWith('.'));
      res.json({ path: resolved, entries: result });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/projects/read', (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const resolved = ensureInsideProjects(filePath);
      const stats = fs.statSync(resolved);
      if (stats.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large (>5MB)' });
      const buf = fs.readFileSync(resolved);
      const isBinary = buf.some((byte, i) => i < 8000 && byte === 0);
      if (isBinary) return res.json({ path: resolved, binary: true, size: stats.size });
      res.json({ path: resolved, content: buf.toString('utf-8'), size: stats.size });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/projects/write', (req, res) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
      const resolved = ensureInsideProjects(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      res.json({ success: true, path: resolved });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/projects/mkdir', (req, res) => {
    try {
      const { path: dirPath } = req.body;
      if (!dirPath) return res.status(400).json({ error: 'path required' });
      const resolved = ensureInsideProjects(dirPath);
      fs.mkdirSync(resolved, { recursive: true });
      res.json({ success: true, path: resolved });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/projects/delete', (req, res) => {
    try {
      const { path: filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const resolved = ensureInsideProjects(filePath);
      if (resolved === PROJECTS_ROOT) return res.status(400).json({ error: 'Cannot delete the Projects root folder' });
      const st = fs.statSync(resolved);
      if (st.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.unlinkSync(resolved);
      }
      res.json({ success: true });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── Preview: serve static files from project subfolders ──
  app.use('/api/projects/preview', (req, res, next) => {
    // Only serve files inside PROJECTS_ROOT
    const reqPath = decodeURIComponent(req.path);
    const fullPath = path.join(PROJECTS_ROOT, reqPath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(PROJECTS_ROOT)) return res.status(403).send('Access denied');
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const idx = path.join(resolved, 'index.html');
      if (fs.existsSync(idx)) return res.sendFile(idx);
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return res.sendFile(resolved);
    }
    res.status(404).send('Not found');
  });

  app.post('/api/projects/execute', async (req, res) => {
    try {
      const { path: filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const resolved = ensureInsideProjects(filePath);
      const ext = path.extname(resolved).toLowerCase();
      let cmd: string, args: string[];
      switch (ext) {
        case '.js': case '.mjs': cmd = 'node'; args = [resolved]; break;
        case '.ts': cmd = 'npx'; args = ['tsx', resolved]; break;
        case '.py': cmd = process.platform === 'win32' ? 'python' : 'python3'; args = [resolved]; break;
        case '.sh': cmd = 'bash'; args = [resolved]; break;
        case '.bat': case '.cmd': cmd = 'cmd'; args = ['/c', resolved]; break;
        case '.ps1': cmd = 'powershell'; args = ['-File', resolved]; break;
        default: return res.status(400).json({ error: 'Unsupported file type: ' + ext });
      }
      const proc = spawn(cmd, args, {
        cwd: path.dirname(resolved),
        timeout: 30000,
        env: { ...process.env },
      });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (exitCode) => {
        res.json({ stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 50000), exitCode });
      });
      proc.on('error', (err) => {
        res.status(500).json({ error: err.message });
      });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── Desktop Terminal API ──
  const activeTerminals = new Map<string, { proc: ChildProcess; output: string[]; alive: boolean }>();
  const PROJECTS_ROOT_ABS = path.resolve('./data/projects');
  const TERMINAL_MAX_OUTPUT = 50_000;

  app.post('/api/desktop/terminal/create', (_req, res) => {
    const id = crypto.randomUUID();

    fs.mkdirSync(PROJECTS_ROOT_ABS, { recursive: true });

    // Spawn local terminal
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/bash';
    const proc = spawn(shell, [], { cwd: PROJECTS_ROOT_ABS, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!proc || !proc.pid) return res.status(500).json({ error: 'Failed to create terminal' });

    const term = { proc, output: [] as string[], alive: true };
    activeTerminals.set(id, term);

    proc.stdout?.on('data', (d: Buffer) => {
      const text = d.toString();
      term.output.push(text);
      while (term.output.join('').length > TERMINAL_MAX_OUTPUT) term.output.shift();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      term.output.push(text);
      while (term.output.join('').length > TERMINAL_MAX_OUTPUT) term.output.shift();
    });
    proc.on('close', () => { term.alive = false; });
    proc.on('error', () => { term.alive = false; });

    // Auto-kill after 60 minutes
    setTimeout(() => {
      if (term.alive) { try { proc.kill(); } catch {} }
      activeTerminals.delete(id);
    }, 60 * 60_000);

    res.json({ id, cwd: PROJECTS_ROOT_ABS, mode: 'local' });
  });

  app.post('/api/desktop/terminal/input', (req, res) => {
    const { id, command } = req.body;
    const term = activeTerminals.get(id);
    if (!term || !term.alive) return res.status(404).json({ error: 'Terminal not found or closed' });
    try {
      term.proc.stdin?.write(command + '\n');
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/desktop/terminal/output', (req, res) => {
    const id = req.query.id as string;
    const term = activeTerminals.get(id);
    if (!term) return res.status(404).json({ error: 'Terminal not found' });
    res.json({ output: term.output.join(''), alive: term.alive });
  });

  app.post('/api/desktop/terminal/kill', (req, res) => {
    const { id } = req.body;
    const term = activeTerminals.get(id);
    if (term && term.alive) { try { term.proc.kill(); } catch {} }
    activeTerminals.delete(id);
    res.json({ success: true });
  });

  app.get('/api/desktop/terminal/list', (_req, res) => {
    const terms: any[] = [];
    activeTerminals.forEach((t, id) => terms.push({ id, alive: t.alive, mode: 'local' }));
    res.json(terms);
  });

  // ── Skill Hub API ──

  // Connection handshake — SkillHub uses this to verify it's connected to a valid panel
  app.get('/api/hub/connect', async (_req, res) => {
    try {
      const manifests = runtime.getSkillLoader().getAllManifests();
      const browseResult = await runtime.getSkillLoader().executeTool('hub_browse', {});
      const entries = (browseResult as any).entries || [];
      res.json({
        connected: true,
        version: '1.0.0',
        skillCount: manifests.length,
        hubPackages: entries.length,
        installedPackages: entries.filter((e: any) => e.installed).length,
        capabilities: ['browse', 'install', 'uninstall', 'export', 'import', 'inspect', 'remove']
      });
    } catch (err: any) { res.status(500).json({ connected: false, error: err.message }); }
  });

  app.get('/api/hub/browse', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_browse', {
        query: req.query.q as string || undefined,
        tag: req.query.tag as string || undefined,
        installed: req.query.installed === 'true' ? true : req.query.installed === 'false' ? false : undefined,
      });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/hub/inspect/:id', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_inspect', { packageId: req.params.id });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hub/install/:id', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_install', { packageId: req.params.id });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hub/uninstall/:id', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_uninstall', { packageId: req.params.id });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hub/remove/:id', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_remove', { packageId: req.params.id });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hub/export', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_export', req.body);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hub/import', async (req, res) => {
    try {
      const result = await runtime.getSkillLoader().executeTool('hub_import', { filePath: req.body.filePath });
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Events history
  app.get('/api/events', (req, res) => {
    const event = req.query.event as EventName | undefined;
    const limit = Number(req.query.limit) || 50;
    const events = runtime.getEventBus().history(event, limit);
    res.json(events);
  });

  // Sessions history
  app.get('/api/sessions', (_req, res) => {
    const sessions = runtime.getMemory().getRecentSessions(20);
    res.json(sessions);
  });

  // Decision explanations
  app.get('/api/explanations', (_req, res) => {
    const limit = Number((_req as any).query?.limit) || 20;
    res.json(runtime.getDecisionExplainer().getRecentExplanations(limit));
  });

  app.get('/api/explanations/:intentId', (req, res) => {
    const e = runtime.getDecisionExplainer().getExplanation(req.params.intentId);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  });

  // Daily report
  app.get('/api/report/daily', async (_req, res) => {
    try {
      const report = await runtime.getDailyReportGenerator().generateReport();
      res.json({ report });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Context memory
  app.get('/api/context/dev/:address', (req, res) => {
    const rep = runtime.getContextMemory().getDevReputation(req.params.address);
    if (!rep) return res.status(404).json({ error: 'Unknown dev' });
    res.json(rep);
  });

  app.get('/api/context/timing', (_req, res) => {
    res.json({
      best: runtime.getContextMemory().getBestTradingHours(),
      worst: runtime.getContextMemory().getWorstTradingHours(),
    });
  });

  app.get('/api/context/patterns', (_req, res) => {
    res.json(runtime.getContextMemory().getProfitablePatterns('name', 2));
  });

  app.get('/api/context/narratives', (_req, res) => {
    res.json(runtime.getContextMemory().getBestNarratives(10));
  });

  // Multi-agent messages
  app.get('/api/agents/messages', (_req, res) => {
    const coordinator = runtime.getMultiAgentCoordinator();
    if (!coordinator) return res.json([]);
    res.json(coordinator.getMessageLog(50));
  });

  // =====================================================
  // Auto-Approve API
  // =====================================================

  app.get('/api/auto-approve/status', (_req, res) => {
    res.json(runtime.getAutoApprove().getStatus());
  });

  app.post('/api/auto-approve/level', (req, res) => {
    const { level } = req.body;
    if (!['off', 'conservative', 'moderate', 'aggressive', 'full'].includes(level)) {
      return res.status(400).json({ error: 'Invalid level. Use: off, conservative, moderate, aggressive, full' });
    }
    runtime.setAutoApproveLevel(level);
    res.json({ success: true, level });
  });

  app.get('/api/auto-approve/audit', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json(runtime.getAutoApprove().getAuditTrail(limit));
  });

  // =====================================================
  // UI Preferences API
  // =====================================================
  const uiPrefsPath = path.join(process.cwd(), 'data', 'ui-prefs.json');

  app.get('/api/ui/prefs', (_req, res) => {
    try {
      if (fs.existsSync(uiPrefsPath)) {
        res.json(JSON.parse(fs.readFileSync(uiPrefsPath, 'utf-8')));
      } else {
        res.json({});
      }
    } catch { res.json({}); }
  });

  app.post('/api/ui/prefs', (req, res) => {
    try {
      const dir = path.dirname(uiPrefsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(uiPrefsPath, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // =====================================================
  // Privacy Guard API
  // =====================================================

  app.get('/api/privacy/stats', (_req, res) => {
    res.json(runtime.getPrivacyStats());
  });

  app.post('/api/privacy/config', (req, res) => {
    const config = req.body;
    runtime.setPrivacyConfig(config);
    res.json({ success: true, config });
  });

  // =====================================================
  // Model Selection API
  // =====================================================

  type SetupActionType =
    | 'open_api_keys'
    | 'open_oauth'
    | 'open_model'
    | 'reload_status'
    | 'open_external';

  interface SetupAction {
    type: SetupActionType;
    label: string;
    url?: string;
  }

  interface SetupStep {
    id: string;
    title: string;
    description: string;
    blocking: boolean;
    actions?: SetupAction[];
  }

  interface SetupGuide {
    provider: string;
    title: string;
    summary: string;
    steps: SetupStep[];
    commonErrors: Array<{ pattern: string; explanation: string; fix: string }>;
  }

  const OAUTH_PROVIDERS = new Set(['github', 'google', 'azure']);
  const API_KEY_ONLY_PROVIDERS = new Set([
    'openai', 'anthropic', 'google', 'groq', 'deepseek', 'mistral',
    'openrouter', 'xai', 'cerebras', 'together', 'fireworks', 'sambanova',
    'cursor', 'ollama',
  ]);

  const buildProviderGuide = (provider: string): SetupGuide => {
    if (provider === 'cursor') {
      return {
        provider,
        title: 'Cursor Cloud Agent Setup',
        summary: 'Cursor uses the Cloud Agents API. You need an API key and a repository to run agents.',
        steps: [
          {
            id: 'cursor-api-key',
            title: 'Add Cursor API Key',
            description: 'Go to cursor.com → Settings → API Keys, create a new key and copy it. Paste it in the field below and click Save key.',
            blocking: true,
            actions: [
              { type: 'open_external', label: 'Open Cursor API Keys', url: 'https://cursor.com/settings' },
            ],
          },
          {
            id: 'cursor-github-oauth',
            title: 'Connect GitHub OAuth (recommended)',
            description: 'Cursor Cloud Agent works with GitHub repositories. Connect your GitHub account by clicking Connect below — a GitHub authorization window will open. This enables automatic repository provisioning. You can skip this if you already set up a repo manually.',
            blocking: false,
            actions: [],
          },
          {
            id: 'cursor-repository',
            title: 'Configure Repository for Cloud Agent',
            description: 'Cursor Cloud Agent runs tasks in a GitHub repository. Two options:\n1) Go to cursor.com/dashboard/cloud-agents → "Defaults" section → "Default Repository" — pick any of your GitHub repos (or create a new one). The field below can be left empty.\n2) Or paste a repository URL in the field below (format: https://github.com/user/repo).\nIf you connected GitHub OAuth earlier, a repo can be auto-created on the first AI request.',
            blocking: false,
            actions: [
              { type: 'open_external', label: 'Open Cursor Cloud Agents', url: 'https://cursor.com/dashboard/cloud-agents' },
            ],
          },
          {
            id: 'cursor-model-selected',
            title: 'Choose Cursor Model',
            description: 'Pick a model from the list below. All Cursor models are available: Claude 4 Opus, Claude Sonnet 4.5, GPT-4.1, Gemini 2.5 Pro and more. The "Default Model" option uses whichever model is set as default at cursor.com → Cloud Agents → Defaults → Default Model. Select one and click Apply model.',
            blocking: true,
            actions: [],
          },
          {
            id: 'cursor-reload-check',
            title: 'Done — Test It Out',
            description: 'Setup complete! Click Finish to close the wizard, then go to AI Chat and send a test message. If everything is configured correctly, the bot will respond.',
            blocking: false,
            actions: [],
          },
        ],
        commonErrors: [
          {
            pattern: '401|authentication',
            explanation: 'API key is invalid, expired, or lacks permissions.',
            fix: 'Recreate the API key in Cursor Dashboard and save it again in API Keys.',
          },
          {
            pattern: 'repository is required|default repository',
            explanation: 'Cloud Agents API needs a repository to run the task.',
            fix: 'Set a default repository in Cursor settings or provide CURSOR_REPOSITORY_URL.',
          },
          {
            pattern: 'model|unsupported|invalid',
            explanation: 'The selected model is not available for your account/plan.',
            fix: 'Switch to an available model or use model=default.',
          },
        ],
      };
    }

    if (provider === 'copilot') {
      return {
        provider,
        title: 'GitHub Copilot Setup',
        summary: 'Copilot uses a GitHub OAuth token and works without an API key.',
        steps: [
          {
            id: 'copilot-github-oauth',
            title: 'Connect GitHub Account',
            description: 'Copilot works through GitHub. Click the Connect button below — an authorization window will open. Enter the code on the GitHub page and confirm. Status will update automatically after connecting.',
            blocking: true,
            actions: [],
          },
          {
            id: 'copilot-model-selected',
            title: 'Choose Copilot Model',
            description: 'Pick a model from the list below (GPT-4o, Claude, and others available via Copilot). Click Apply model to activate.',
            blocking: true,
            actions: [],
          },
          {
            id: 'copilot-reload-check',
            title: 'Done — Test It Out',
            description: 'Setup complete! Click Finish, go to AI Chat and send a test message.',
            blocking: false,
            actions: [],
          },
        ],
        commonErrors: [
          {
            pattern: '401|403|copilot subscription',
            explanation: 'No active Copilot subscription or token is invalid.',
            fix: 'Reconnect GitHub OAuth and verify your Copilot subscription is active.',
          },
        ],
      };
    }

    if (provider === 'google-oauth' || provider === 'azure-oauth') {
      const oauthProvider = provider === 'google-oauth' ? 'google' : 'azure';
      return {
        provider,
        title: `${provider} Setup`,
        summary: 'This provider works via OAuth — no API key needed.',
        steps: [
          {
            id: `${provider}-oauth`,
            title: `Connect ${oauthProvider === 'google' ? 'Google' : 'Azure'} Account`,
            description: `Click the Connect button below — a ${oauthProvider === 'google' ? 'Google' : 'Azure'} authorization window will open. Confirm access. Status will update automatically after connecting.`,
            blocking: true,
            actions: [],
          },
          {
            id: `${provider}-model-selected`,
            title: `Choose ${oauthProvider === 'google' ? 'Google' : 'Azure'} Model`,
            description: 'Pick a model from the list below and click Apply model.',
            blocking: true,
            actions: [],
          },
          {
            id: `${provider}-reload-check`,
            title: 'Done — Test It Out',
            description: 'Setup complete! Click Finish, go to AI Chat and send a test message.',
            blocking: false,
            actions: [],
          },
        ],
        commonErrors: [
          {
            pattern: '401|unauthorized|invalid_grant',
            explanation: 'OAuth token expired or revoked.',
            fix: 'Disconnect + Connect again in OAuth / Free AI.',
          },
        ],
      };
    }

    const isApiKeyProvider = API_KEY_ONLY_PROVIDERS.has(provider);
    return {
      provider,
      title: `${provider.toUpperCase()} API Key Setup`,
      summary: isApiKeyProvider
        ? 'This provider requires an API key (or a local URL for Ollama).'
        : 'Check the provider requirements and connect it in the appropriate section.',
      steps: [
        {
          id: `${provider}-api-key`,
          title: provider === 'ollama' ? 'Enter Ollama URL' : `Add ${provider.toUpperCase()} API Key`,
          description: provider === 'ollama'
            ? 'Enter the URL of your local Ollama server (usually http://localhost:11434) in the field below and click Save key.'
            : `Get an API key from the ${provider} website, then paste it in the field below and click Save key.`,
          blocking: true,
          actions: [],
        },
        {
          id: `${provider}-model-selected`,
          title: `Choose ${provider} Model`,
          description: 'Pick a model from the list below and click Apply model.',
          blocking: true,
          actions: [],
        },
        {
          id: `${provider}-reload-check`,
          title: 'Done — Test It Out',
          description: 'Setup complete! Click Finish, go to AI Chat and send a test message.',
          blocking: false,
          actions: [],
        },
      ],
      commonErrors: [
        {
          pattern: '401|invalid api key|unauthorized',
          explanation: 'Key is invalid, empty, or lacks access to the model.',
          fix: 'Check the key format, account permissions, and save the API key again.',
        },
      ],
    };
  };

  const buildSetupStepStatus = (provider: string) => {
    const oauthManager = runtime.getOAuthManager();
    const keys = runtime.getApiKeys();
    const keyConfigured = !!keys[provider];
    const githubConnected = oauthManager.hasToken('github');
    const googleConnected = oauthManager.hasToken('google');
    const azureConnected = oauthManager.hasToken('azure');
    const current = runtime.getModelConfig();
    const commander = current.commander;
    const selectedProvider = commander?.provider || '';
    const selectedMatches = selectedProvider === provider;

    const status: Record<string, { done: boolean; detail: string }> = {};

    if (provider === 'cursor') {
      status['cursor-model-selected'] = {
        done: selectedMatches,
        detail: selectedMatches ? 'Cursor model selected.' : 'A different model is currently active.',
      };
      status['cursor-api-key'] = {
        done: !!keys.cursor,
        detail: keys.cursor ? 'Cursor API key saved.' : 'Cursor API key required.',
      };
      status['cursor-github-oauth'] = {
        done: githubConnected,
        detail: githubConnected ? 'GitHub OAuth connected.' : 'Recommended: connect GitHub OAuth for auto-provisioning.',
      };
      status['cursor-repository'] = {
        done: !!process.env.CURSOR_REPOSITORY_URL || githubConnected,
        detail: process.env.CURSOR_REPOSITORY_URL
          ? 'CURSOR_REPOSITORY_URL is set.'
          : githubConnected
            ? 'GitHub connected — repo can be auto-created, or set Default Repository at cursor.com.'
            : 'Set Default Repository at cursor.com/dashboard/cloud-agents or enter URL below.',
      };
      status['cursor-reload-check'] = {
        done: false,
        detail: 'Click Refresh after making changes.',
      };
      return status;
    }

    if (provider === 'copilot') {
      status['copilot-model-selected'] = {
        done: selectedMatches,
        detail: selectedMatches ? 'Copilot model selected.' : 'A different model is currently active.',
      };
      status['copilot-github-oauth'] = {
        done: githubConnected,
        detail: githubConnected ? 'GitHub OAuth connected.' : 'GitHub OAuth connection required.',
      };
      status['copilot-reload-check'] = {
        done: false,
        detail: 'Click Refresh after making changes.',
      };
      return status;
    }

    if (provider === 'google-oauth') {
      status['google-oauth-model-selected'] = {
        done: selectedMatches,
        detail: selectedMatches ? 'Google OAuth model selected.' : 'A different model is currently active.',
      };
      status['google-oauth-oauth'] = {
        done: googleConnected,
        detail: googleConnected ? 'Google OAuth connected.' : 'Google OAuth connection required.',
      };
      status['google-oauth-reload-check'] = {
        done: false,
        detail: 'Click Refresh after making changes.',
      };
      return status;
    }

    if (provider === 'azure-oauth') {
      status['azure-oauth-model-selected'] = {
        done: selectedMatches,
        detail: selectedMatches ? 'Azure OAuth model selected.' : 'A different model is currently active.',
      };
      status['azure-oauth-oauth'] = {
        done: azureConnected,
        detail: azureConnected ? 'Azure OAuth connected.' : 'Azure OAuth connection required.',
      };
      status['azure-oauth-reload-check'] = {
        done: false,
        detail: 'Click Refresh after making changes.',
      };
      return status;
    }

    status[`${provider}-model-selected`] = {
      done: selectedMatches,
      detail: selectedMatches ? 'Provider model selected.' : 'A different model is currently active.',
    };
    status[`${provider}-api-key`] = {
      done: keyConfigured,
      detail: keyConfigured ? 'Key/URL saved.' : 'Key/URL needs to be configured in API Keys.',
    };
    status[`${provider}-reload-check`] = {
      done: false,
      detail: 'Click Refresh after making changes.',
    };
    return status;
  };

  app.get('/api/setup-guides', (_req, res) => {
    const available = getAvailableModels();
    const knownProviders = [
      'cursor',
      'copilot',
      'google-oauth',
      'azure-oauth',
      'openai',
      'anthropic',
      'google',
      'groq',
      'deepseek',
      'mistral',
      'openrouter',
      'xai',
      'cerebras',
      'together',
      'fireworks',
      'sambanova',
      'ollama',
    ];
    const providers = Array.from(new Set([...knownProviders, ...available.map(m => m.provider)]));
    const requested = String(_req.query.provider || '').trim();
    if (requested) {
      return res.json({
        provider: requested,
        guide: buildProviderGuide(requested),
        providers,
      });
    }
    const guides = providers.map(p => buildProviderGuide(p));
    res.json({ providers, guides });
  });

  app.get('/api/setup-guides/status', (_req, res) => {
    const provider = String(_req.query.provider || '').trim();
    if (!provider) return res.status(400).json({ error: 'provider query parameter is required' });
    const stepStatus = buildSetupStepStatus(provider);
    res.json({ provider, stepStatus });
  });

  app.get('/api/model/config', (_req, res) => {
    const current = runtime.getModelConfig();
    const available = getAvailableModels();
    res.json({ current, available });
  });

  app.post('/api/model/config', (req, res) => {
    const { provider, model } = req.body;
    if (!provider || !model || typeof provider !== 'string' || typeof model !== 'string') {
      return res.status(400).json({ error: 'provider and model are required' });
    }
    if (provider.length > 50 || model.length > 100) {
      return res.status(400).json({ error: 'Invalid provider or model name' });
    }
    try {
      runtime.setModelConfig({ provider, model });
      res.json({ success: true, provider, model });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =====================================================
  // RPC Config API
  // =====================================================

  // =====================================================
  // API Keys Management
  // =====================================================

  app.get('/api/keys/config', (_req, res) => {
    const keys = runtime.getApiKeys();
    res.json({ keys });
  });

  app.post('/api/keys/config', async (req, res) => {
    const { keys } = req.body;
    if (!keys || typeof keys !== 'object') {
      return res.status(400).json({ error: 'keys object required' });
    }
    // Validate: all values must be strings
    for (const [k, v] of Object.entries(keys)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return res.status(400).json({ error: 'All keys and values must be strings' });
      }
      if (k.length > 50 || (v as string).length > 500) {
        return res.status(400).json({ error: 'Key name or value too long' });
      }
    }
    try {
      runtime.setApiKeys(keys as Record<string, string>);
      // Try to create agents if they don't exist yet (new API key might enable LLM)
      await runtime.ensureAgents();
      res.json({ success: true, keys: runtime.getApiKeys() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/rpc/config', (_req, res) => {
    const rpc = runtime.getRpcConfig();
    res.json({
      solana: rpc.solana,
      helius: rpc.helius ? '***configured***' : '',
    });
  });

  app.post('/api/rpc/config', async (req, res) => {
    const { solana, helius } = req.body;
    if (solana && typeof solana === 'string') {
      // Validate URL format
      try {
        new URL(solana);
      } catch {
        return res.status(400).json({ error: 'Invalid Solana RPC URL format' });
      }
      // Test connectivity
      try {
        const testRes = await fetch(solana, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        });
        if (!testRes.ok) throw new Error(`HTTP ${testRes.status}`);
      } catch (err: any) {
        return res.status(400).json({ error: `RPC connection test failed: ${err.message}` });
      }
    }
    const update: { solana?: string; helius?: string } = {};
    if (solana) update.solana = solana;
    if (helius !== undefined) update.helius = helius;
    runtime.setRpcConfig(update);
    res.json({ success: true, solana: solana || runtime.getRpcConfig().solana });
  });

  app.post('/api/rpc/test', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL required' });
    }
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    try {
      const start = Date.now();
      const testRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      });
      const latency = Date.now() - start;
      if (!testRes.ok) throw new Error(`HTTP ${testRes.status}`);
      const data = await testRes.json() as any;
      res.json({ success: true, latency, result: data.result || 'ok' });
    } catch (err: any) {
      res.status(400).json({ error: err.message, success: false });
    }
  });

  // =====================================================
  // Twitter Cookies Config
  // =====================================================

  app.get('/api/twitter/config', (_req, res) => {
    const cookies = runtime.getTwitterCookies();
    res.json({ configured: !!cookies });
  });

  app.post('/api/twitter/config', (req, res) => {
    const { cookies } = req.body;
    if (cookies !== undefined && typeof cookies !== 'string') {
      return res.status(400).json({ error: 'cookies must be a string' });
    }
    runtime.setTwitterCookies(cookies || '');
    res.json({ success: true, configured: !!runtime.getTwitterCookies() });
  });

  // Fetch a specific tweet by URL or ID
  app.get('/api/twitter/tweet/:tweetId', async (req, res) => {
    try {
      const { tweetId } = req.params;
      if (!/^\d+$/.test(tweetId)) {
        return res.status(400).json({ error: 'Invalid tweet ID — must be numeric' });
      }
      const skillLoader = runtime.getSkillLoader();
      const result = await skillLoader.executeTool('fetch_tweet', { url: tweetId });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =====================================================
  // Browser Service — headless Chrome for web browsing
  // =====================================================

  // Open visible browser for Twitter login
  app.post('/api/browser/twitter/login', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.openTwitterLogin();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check browser & Twitter login status
  app.get('/api/browser/status', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const status = browser.getStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Check Twitter login by navigating to x.com/home
  app.post('/api/browser/twitter/check', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const loggedIn = await browser.checkTwitterLogin();
      res.json({ loggedIn });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Fetch any webpage via browser
  app.post('/api/browser/fetch', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
      }
      // Only allow http/https URLs
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'Only http/https URLs are allowed' });
      }
      const browser = runtime.getBrowser();
      const result = await browser.fetchPage(url);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // =====================================================
  // OAuth API — Device authorization flow for Copilot / Google / Azure
  // =====================================================

  // Start device flow — returns user_code + verification_uri for display
  app.post('/api/oauth/start/:provider', async (req, res) => {
    try {
      const providerName = req.params.provider;
      const oauthManager = runtime.getOAuthManager();
      const flow = await oauthManager.startDeviceFlow(providerName);
      res.json({
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        message: `Open ${flow.verificationUri} and enter code: ${flow.userCode}`,
      });
      (async () => {
        try {
          let done = false;
          while (!done) {
            done = await flow.pollFn();
          }
          logger.info(`OAuth device flow completed for ${providerName}`);

          if (providerName === 'github') {
            CursorProvider.resetRepoFailure();
            logger.info('Cursor repo cache cleared — auto-initializing empty repos...');
            const ghToken = await runtime.getOAuthManager().getToken('github');
            if (ghToken) {
              autoInitEmptyGitHubRepos(ghToken, logger).catch(() => {});
            }
          }
        } catch (err: any) {
          logger.warn(`OAuth poll failed for ${providerName}: ${err.message}`);
        }
      })();
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Check if a provider has a valid token
  app.get('/api/oauth/status', (_req, res) => {
    const oauthManager = runtime.getOAuthManager();
    const providers = ['github', 'google', 'azure'];
    const status: Record<string, boolean> = {};
    for (const p of providers) {
      status[p] = oauthManager.hasToken(p);
    }
    res.json(status);
  });

  // Revoke token for a provider
  app.delete('/api/oauth/revoke/:provider', (req, res) => {
    try {
      const oauthManager = runtime.getOAuthManager();
      oauthManager.revokeToken(req.params.provider);
      res.json({ success: true, provider: req.params.provider });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Extension overlay (inject into pump.fun) ──
  const extensionDir = path.join(process.cwd(), 'extension');

  // Serve combined inject.js with CSS inlined and host replaced
  app.get('/extension/inject.js', (_req, res) => {
    try {
      const cssPath = path.join(extensionDir, 'overlay.css');
      const jsPath = path.join(extensionDir, 'inject.js');
      if (!fs.existsSync(cssPath) || !fs.existsSync(jsPath)) {
        return res.status(404).send('Extension files not found');
      }
      const css = fs.readFileSync(cssPath, 'utf-8').replace(/`/g, '\\`').replace(/\\/g, '\\\\');
      let js = fs.readFileSync(jsPath, 'utf-8');
      const origin = `${_req.protocol}://${_req.get('host')}`;
      js = js.replace(/__WhiteOwl_CSS__/g, css);
      js = js.replace(/__WhiteOwl_HOST__/g, origin);
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.send(js);
    } catch (err: any) {
      res.status(500).send('// Error: ' + err.message);
    }
  });

  // Static extension files (manifest.json, overlay.css, content.js, icons)
  app.use('/extension/static', express.static(extensionDir));

  // ── CRX3 signed package (Chrome installs this via policy) ──
  app.get('/extension/WhiteOwl.crx', (_req, res) => {
    try {
      const origin = `${_req.protocol}://${_req.get('host')}`;
      const keyPath = path.join(extensionDir, 'key.pem');
      const { crx } = buildExtensionPackage(extensionDir, keyPath, origin);
      res.set('Content-Type', 'application/x-chrome-extension');
      res.set('Content-Disposition', 'attachment; filename="WhiteOwl.crx"');
      res.set('Cache-Control', 'no-cache');
      res.send(crx);
    } catch (err: any) {
      logger.error('CRX build error: ' + err.message);
      res.status(500).send('CRX build failed: ' + err.message);
    }
  });

  // ── Chrome update manifest XML (referenced by registry policy) ──
  app.get('/extension/update.xml', (_req, res) => {
    try {
      const origin = `${_req.protocol}://${_req.get('host')}`;
      const keyPath = path.join(extensionDir, 'key.pem');
      const { publicKeyDer } = getOrCreateKey(keyPath);
      const extId = computeExtensionId(publicKeyDer);
      const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${extId}'>
    <updatecheck codebase='${origin}/extension/WhiteOwl.crx' version='1.0.0' />
  </app>
</gupdate>`;
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.send(xml);
    } catch (err: any) {
      res.status(500).send('Error: ' + err.message);
    }
  });

  // ── Extension ID (used by installer script) ──
  app.get('/extension/id', (_req, res) => {
    try {
      const keyPath = path.join(extensionDir, 'key.pem');
      const { publicKeyDer } = getOrCreateKey(keyPath);
      res.set('Content-Type', 'text/plain');
      res.send(computeExtensionId(publicKeyDer));
    } catch (err: any) {
      res.status(500).send('Error');
    }
  });

  // ── Windows auto-installer .bat (admin + HKLM policies + External Extensions + local backup) ──
  app.get('/extension/install.bat', (_req, res) => {
    const origin = `${_req.protocol}://${_req.get('host')}`;
    const bat = `@echo off\r
:: Auto-elevate to admin (needed for HKLM registry)\r
net session >nul 2>&1\r
if errorlevel 1 (\r
    echo  Requesting admin rights...\r
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"\r
    exit /b 0\r
)\r
\r
chcp 65001 >nul\r
title WhiteOwl — Chrome Extension Installer\r
color 0A\r
echo.\r
echo  ══════════════════════════════════════════════\r
echo    WhiteOwl — Auto-install Chrome Extension\r
echo  ══════════════════════════════════════════════\r
echo.\r
\r
set "WhiteOwl_URL=${origin}"\r
\r
echo  [1/4] Connecting to WhiteOwl server...\r
for /f "delims=" %%i in ('curl -s "%WhiteOwl_URL%/extension/id"') do set "EXT_ID=%%i"\r
if "%EXT_ID%"=="" (\r
  echo.\r
  echo  ERROR: Cannot reach %WhiteOwl_URL%\r
  echo  Start WhiteOwl first: npx tsx src/index.ts\r
  echo.\r
  pause\r
  exit /b 1\r
)\r
echo  Extension ID: %EXT_ID%\r
\r
echo  [2/4] Downloading extension files locally...\r
set "EXT_DIR=%LOCALAPPDATA%\\WhiteOwl-extension"\r
if not exist "%EXT_DIR%" mkdir "%EXT_DIR%"\r
curl -s -o "%EXT_DIR%\\content.js" "%WhiteOwl_URL%/extension/inject.js"\r
curl -s -o "%EXT_DIR%\\icon48.png" "%WhiteOwl_URL%/extension/static/icon48.png"\r
curl -s -o "%EXT_DIR%\\icon128.png" "%WhiteOwl_URL%/extension/static/icon128.png"\r
>"%EXT_DIR%\\manifest.json" echo {"manifest_version":3,"name":"WhiteOwl","version":"1.0.0","description":"AI overlay","host_permissions":["https://pump.fun/*","https://www.pump.fun/*"],"content_scripts":[{"matches":["https://pump.fun/*","https://www.pump.fun/*"],"js":["content.js"],"run_at":"document_idle","world":"MAIN"}],"icons":{"48":"icon48.png","128":"icon128.png"}}\r
echo  Saved to: %EXT_DIR%\r
\r
echo  [3/4] Setting browser policies (HKLM + HKCU + External)...\r
\r
:: ── Force-install via HKLM policy (most reliable on unmanaged Windows) ──\r
reg add "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
\r
:: ── Force-install via HKCU policy (backup) ──\r
reg add "HKCU\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKCU\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
\r
:: ── Allow localhost as extension install source ──\r
reg add "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallSources" /v 1 /t REG_SZ /d "http://localhost:*/*" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallSources" /v 1 /t REG_SZ /d "http://localhost:*/*" /f >nul 2>&1\r
\r
:: ── External Extensions registry (alternative install method) ──\r
reg add "HKLM\\SOFTWARE\\Google\\Chrome\\Extensions\\%EXT_ID%" /v update_url /t REG_SZ /d "%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\Extensions\\%EXT_ID%" /v update_url /t REG_SZ /d "%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
\r
echo  Policies set: Chrome, Edge, Brave (HKLM + HKCU + External)\r
\r
echo  [4/4] Restarting browsers...\r
taskkill /f /im chrome.exe >nul 2>&1\r
taskkill /f /im chrome_crashpad_handler.exe >nul 2>&1\r
taskkill /f /im msedge.exe >nul 2>&1\r
taskkill /f /im brave.exe >nul 2>&1\r
timeout /t 3 /nobreak >nul\r
start "" chrome.exe https://pump.fun\r
\r
echo.\r
echo  Done! Extension installed.\r
echo  Chrome: "Managed by your organization" = normal.\r
echo.\r
echo  Verify: chrome://policy  chrome://extensions\r
echo.\r
echo  Fallback (if not auto-loaded):\r
echo    chrome://extensions - Developer Mode ON -\r
echo    Load unpacked - %EXT_DIR%\r
echo.\r
pause\r
`;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="WhiteOwl-install.bat"');
    res.send(bat);
  });

  // ── Uninstall .bat (removes all registry policies + local files) ──
  app.get('/extension/uninstall.bat', (_req, res) => {
    const bat = `@echo off\r
net session >nul 2>&1\r
if errorlevel 1 (\r
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"\r
    exit /b 0\r
)\r
chcp 65001 >nul\r
echo.\r
echo  Removing WhiteOwl extension...\r
echo.\r
:: HKLM policies\r
reg delete "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
reg delete "HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
reg delete "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallSources" /v 1 /f >nul 2>&1\r
reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallSources" /v 1 /f >nul 2>&1\r
:: HKCU policies\r
reg delete "HKCU\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
reg delete "HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
reg delete "HKCU\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /f >nul 2>&1\r
:: External extensions\r
for /f "delims=" %%i in ('curl -s "http://localhost:3377/extension/id" 2^>nul') do set "EXT_ID=%%i"\r
if not "%EXT_ID%"=="" (\r
  reg delete "HKLM\\SOFTWARE\\Google\\Chrome\\Extensions\\%EXT_ID%" /f >nul 2>&1\r
  reg delete "HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\Extensions\\%EXT_ID%" /f >nul 2>&1\r
)\r
:: Local files\r
if exist "%LOCALAPPDATA%\\WhiteOwl-extension" rmdir /s /q "%LOCALAPPDATA%\\WhiteOwl-extension" >nul 2>&1\r
echo  All policies removed. Restart browser.\r
echo.\r
pause\r
`;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="WhiteOwl-uninstall.bat"');
    res.send(bat);
  });

  // ── Extension status ──
  app.get('/extension/status', (_req, res) => {
    try {
      const keyPath = path.join(extensionDir, 'key.pem');
      const { publicKeyDer } = getOrCreateKey(keyPath);
      const extId = computeExtensionId(publicKeyDer);
      res.json({ installed: true, version: '1.0.0', extensionId: extId, server: `${_req.protocol}://${_req.get('host')}` });
    } catch (err: any) {
      res.json({ installed: false, error: err.message });
    }
  });

  // Serve dashboard static files (no cache for development)
  app.use('/dashboard', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  }, express.static('public'));
  app.get('/', (_req, res) => res.redirect('/dashboard'));

  // Serve proxy Service Worker at root (SW scope must cover /p/)
  app.get('/proxy-sw.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.resolve('public/proxy-sw.js'));
  });

  // Serve SkillHub as a separate site
  app.use('/skillhub', express.static('skillhub'));

  // Prometheus metrics endpoint
  app.get('/metrics', (_req, res) => {
    const metrics = runtime.getMetrics();
    if (!metrics) return res.status(503).send('Metrics not available');
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.getPrometheusMetrics());
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    const metrics = runtime.getMetrics();
    if (!metrics) return res.json({ healthy: true, details: 'Metrics not initialized' });
    const health = metrics.isHealthy();
    res.status(health.healthy ? 200 : 503).json(health);
  });

  // Create HTTP server
  const server = http.createServer(app);

  // WebSocket servers — noServer mode to avoid upgrade conflicts
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const termWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wsProxyServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  // Route upgrade requests by path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;
    
    // WebSocket proxy for /wsp/{host}/path
    if (pathname.startsWith('/wsp/')) {
      const match = pathname.match(/^\/wsp\/([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/.*)$/);
      if (match) {
        const targetHost = match[1];
        const targetPath = match[2] || '/';
        
        wsProxyServer.handleUpgrade(request, socket, head, (clientWs) => {
          const targetUrl = `wss://${targetHost}${targetPath}`;
          logger.info(`[WSProxy] Connecting to ${targetUrl}`);
          
          const targetWs = new WebSocket(targetUrl, {
            headers: {
              'Origin': `https://${targetHost}`,
              'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
            }
          });
          
          targetWs.on('open', () => {
            logger.info(`[WSProxy] Connected to ${targetHost}`);
          });
          
          targetWs.on('message', (data, isBinary) => {
            try {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data, { binary: isBinary });
              }
            } catch (e) { /* ignore */ }
          });
          
          clientWs.on('message', (data, isBinary) => {
            try {
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(data, { binary: isBinary });
              }
            } catch (e) { /* ignore */ }
          });
          
          const cleanup = () => {
            try { clientWs.close(); } catch {}
            try { targetWs.close(); } catch {}
          };
          
          clientWs.on('close', cleanup);
          clientWs.on('error', cleanup);
          targetWs.on('close', cleanup);
          targetWs.on('error', (err) => {
            logger.error(`[WSProxy] Target error:`, err.message);
            cleanup();
          });
        });
        return;
      }
    }
    
    if (pathname === '/ws/terminal') {
      termWss.handleUpgrade(request, socket, head, (ws) => {
        termWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
  termWss.on('connection', (ws: WebSocket) => {
    let termProc: ChildProcess | null = null;
    let alive = true;

    // Spawn local terminal
    const isWinTerm = process.platform === 'win32';
    const termShell = isWinTerm ? 'cmd.exe' : '/bin/bash';
    termProc = spawn(termShell, [], { cwd: PROJECTS_ROOT_ABS, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!termProc || !termProc.pid) {
      ws.send(JSON.stringify({ type: 'error', data: 'Failed to spawn terminal' }));
      ws.close();
      return;
    }

    ws.send(JSON.stringify({ type: 'info', mode: 'local', cwd: PROJECTS_ROOT_ABS }));

    termProc.stdout?.on('data', (d: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: d.toString() }));
      }
    });
    termProc.stderr?.on('data', (d: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: d.toString() }));
      }
    });
    termProc.on('close', () => {
      alive = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit' }));
      }
    });
    termProc.on('error', () => { alive = false; });

    ws.on('message', (raw: Buffer) => {
      if (!alive || !termProc) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && msg.data) {
          termProc.stdin?.write(msg.data);
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          // Resize not supported in basic mode, but kept for future pty support
        }
      } catch {}
    });

    ws.on('close', () => {
      if (alive && termProc) {
        try { termProc.kill(); } catch {}
      }
    });

    // Auto-kill after 60 min
    setTimeout(() => {
      if (alive && termProc) { try { termProc.kill(); } catch {} }
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }, 60 * 60_000);
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info('WebSocket client connected');

    ws.on('error', (err) => {
      logger.error('WebSocket error: ' + err.message);
    });

    const subscriptions = new Set<string>();
    let subscribeAll = false;

    // Forward events to WebSocket clients
    const handler = (event: EventName, data: any) => {
      if (!subscribeAll && !subscriptions.has(event)) return;

      try {
        ws.send(JSON.stringify({ event, data, timestamp: Date.now() }));
      } catch {}
    };

    runtime.getEventBus().onAny(handler);

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'subscribe') {
          if (msg.event === '*') {
            subscribeAll = true;
          } else {
            subscriptions.add(msg.event);
          }
        } else if (msg.type === 'unsubscribe') {
          if (msg.event === '*') {
            subscribeAll = false;
          } else {
            subscriptions.delete(msg.event);
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        } else if (msg.type === 'tool_call') {
          // Direct tool execution — no LLM, instant result
          const tool = typeof msg.tool === 'string' ? msg.tool.slice(0, 100) : '';
          const params = (msg.params && typeof msg.params === 'object') ? msg.params : {};
          if (!tool) {
            ws.send(JSON.stringify({ type: 'tool_error', error: 'tool name required' }));
            return;
          }
          ws.send(JSON.stringify({ type: 'tool_status', status: 'executing', tool }));
          try {
            const result = await runtime.getSkillLoader().executeTool(tool, params);
            ws.send(JSON.stringify({ type: 'tool_result', tool, result, timestamp: Date.now() }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'tool_error', tool, error: err.message, timestamp: Date.now() }));
          }
        } else if (msg.type === 'chat') {
          // WebSocket-based chat with streaming progress
          const agentId = typeof msg.agent === 'string' ? msg.agent.slice(0, 50) : 'commander';
          const message = typeof msg.message === 'string' ? msg.message.slice(0, 4096) : '';
          const image = typeof msg.image === 'string' && msg.image.length < 2_000_000 ? msg.image : undefined;
          const wsChatId = typeof msg.chatId === 'string' ? msg.chatId.slice(0, 100) : '';
          if (!message) {
            ws.send(JSON.stringify({ type: 'chat_error', error: 'message required' }));
            return;
          }

          // Set chatId on ProjectsSkill for per-chat todos
          const projectsSkillWs = runtime.getSkillLoader().getSkill('projects') as any;
          if (projectsSkillWs?.setChatId && wsChatId) projectsSkillWs.setChatId(wsChatId);

          ws.send(JSON.stringify({ type: 'chat_status', status: 'thinking', agentId }));

          // Stream tool calls to this client
          const chatToolHandler = (data: any) => {
            if (data?.agentId !== agentId) return;
            try {
              ws.send(JSON.stringify({ type: 'chat_tool_call', tool: data.tool, params: data.params, timestamp: Date.now() }));
            } catch {}
          };
          runtime.getEventBus().on('agent:tool_call' as any, chatToolHandler);

          try {
            const response = await runtime.chat(agentId, message, image);
            ws.send(JSON.stringify({ type: 'chat_response', agent: agentId, response, timestamp: Date.now() }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'chat_error', error: err.message, timestamp: Date.now() }));
          }

          runtime.getEventBus().off('agent:tool_call' as any, chatToolHandler);
        }
      } catch {}
    });

    ws.on('close', () => {
      runtime.getEventBus().offAny(handler);
      logger.info('WebSocket client disconnected');
    });
  });

  return {
    app,
    server,
    start: () => {
      server.listen(port, () => {
        logger.info(`API server running on http://localhost:${port}`);
        logger.info(`WebSocket available at ws://localhost:${port}/ws`);
      });
    },
    stop: () => {
      return new Promise<void>((resolve) => {
        termWss.close();
        wss.close();
        server.close(() => resolve());
      });
    },
  };
}

async function autoInitEmptyGitHubRepos(ghToken: string, logger: LoggerInterface): Promise<void> {
  const ghHeaders: Record<string, string> = {
    'Authorization': `token ${ghToken}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'WhiteOwl-AutoInit',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const resp = await fetch('https://api.github.com/user/repos?per_page=10&sort=updated&direction=desc', {
      headers: ghHeaders,
    });
    if (!resp.ok) return;
    const repos = await resp.json() as any[];

    for (const repo of (repos || [])) {
      if (!repo?.full_name) continue;
      const branch = String(repo.default_branch || 'main');

      const refResp = await fetch(`https://api.github.com/repos/${repo.full_name}/git/ref/heads/${branch}`, {
        headers: ghHeaders,
      });
      if (refResp.ok) continue;

      logger.info(`Auto-initializing empty repo: ${repo.full_name}`);
      const content = Buffer.from('# WhiteOwl\nAuto-initialized repository for Cursor Cloud Agents.\n').toString('base64');
      const putResp = await fetch(`https://api.github.com/repos/${repo.full_name}/contents/README.md`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Initial commit', content, branch }),
      });
      if (putResp.ok) {
        logger.info(`Successfully initialized ${repo.full_name}`);
        return;
      }
      if (putResp.status === 422) {
        const putResp2 = await fetch(`https://api.github.com/repos/${repo.full_name}/contents/README.md`, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Initial commit', content }),
        });
        if (putResp2.ok) {
          logger.info(`Successfully initialized ${repo.full_name} (default branch)`);
          return;
        }
      }
      logger.warn(`Failed to initialize ${repo.full_name} — may need repo scope`);
    }
  } catch (err: any) {
    logger.warn(`Auto-init repos failed: ${err.message}`);
  }
}
