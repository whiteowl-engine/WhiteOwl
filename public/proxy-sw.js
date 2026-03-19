// Service Worker: intercepts root-relative URLs from proxy iframes
// and rewrites them to go through /p/{host}/... reverse proxy

const clientHostMap = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Track /p/{host} requests → map client ID to host
  if (url.pathname.startsWith('/p/')) {
    const m = url.pathname.match(/^\/p\/([a-zA-Z0-9][a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    if (m) {
      const cid = event.resultingClientId || event.clientId;
      if (cid) clientHostMap.set(cid, m[1]);
    }
    return; // Let original request through
  }

  // Not a /p/ request — check if it should be proxied
  // (root-relative URL from a proxy iframe)
  const host = clientHostMap.get(event.clientId);
  if (!host) return; // Not from a proxy iframe, pass through

  // Skip panel's own routes
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/sandbox-preview') ||
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/proxy-sw.js') return;

  // Rewrite to proxy path
  const proxyUrl = url.origin + '/p/' + host + url.pathname + url.search;

  event.respondWith(
    fetch(proxyUrl, {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.body,
      credentials: event.request.credentials,
      redirect: 'follow',
    })
  );
});
