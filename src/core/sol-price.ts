
import WebSocket from 'ws';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WS_URL = 'wss://trench-stream.jup.ag/ws';
const RECONNECT_DELAY = 5_000;
const REST_FALLBACK_URL = `https://api.jup.ag/price/v2?ids=${SOL_MINT}`;

let _price = 0;
let _ts = 0;
let _ws: WebSocket | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

function connect() {
  if (_ws) return;
  try {
    _ws = new WebSocket(WS_URL);

    _ws.on('open', () => {
      _ws!.send(JSON.stringify({
        type: 'subscribe:prices',
        assets: [SOL_MINT],
      }));
    });

    _ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'prices' && Array.isArray(msg.data)) {
          for (const item of msg.data) {
            if (item.assetId === SOL_MINT && item.price > 0) {
              _price = item.price;
              _ts = Date.now();
            }
          }
        }
      } catch {  }
    });

    _ws.on('close', () => {
      _ws = null;
      scheduleReconnect();
    });

    _ws.on('error', () => {
      try { _ws?.close(); } catch {}
      _ws = null;
      scheduleReconnect();
    });
  } catch {
    _ws = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

async function fetchFallback(): Promise<number> {
  try {
    const resp = await fetch(REST_FALLBACK_URL, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json() as any;
    const price = Number(data?.data?.[SOL_MINT]?.price);
    if (price && price > 0) {
      _price = price;
      _ts = Date.now();
    }
  } catch {  }
  return _price;
}

export function startSolPriceStream(): void {
  if (_started) return;
  _started = true;
  connect();

  fetchFallback().catch(() => {});
}

export function getSolPriceUsd(): number {
  return _price;
}

export function getSolPriceAge(): number {
  return _ts ? Date.now() - _ts : Infinity;
}

export async function getSolPriceReliable(): Promise<number> {
  if (_price > 0 && Date.now() - _ts < 60_000) return _price;
  return fetchFallback();
}

export function stopSolPriceStream(): void {
  _started = false;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
}
