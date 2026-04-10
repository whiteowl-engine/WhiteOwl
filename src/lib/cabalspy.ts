
const CABALSPY_BASE = 'https://widget.cabalspy.xyz:8443';
const TIMEOUT_MS = 8000;

export interface CabalSpyResult {
  kols: number;
  smart: number;
  whales: number;
  kolBuyVol: number;
  kolSellVol: number;
  smartBuyVol: number;
  smartSellVol: number;
  whaleBuyVol: number;
  whaleSellVol: number;
  summary: string;
}

interface WalletTx {
  buy: number;
  sell: number;
  buySum: number;
  sellSum: number;
}

function aggregateWallets(data: Record<string, WalletTx>): { count: number; buyVol: number; sellVol: number } {
  const wallets = Object.values(data);
  return {
    count: wallets.length,
    buyVol: wallets.reduce((s, w) => s + (w.buySum || 0), 0),
    sellVol: wallets.reduce((s, w) => s + (w.sellSum || 0), 0),
  };
}

export async function fetchCabalSpy(mint: string, chain: string = 'solana'): Promise<CabalSpyResult | null> {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${CABALSPY_BASE}/widget?address=${mint}`,
    };

    const [kolRes, smartRes, whaleRes] = await Promise.all([
      fetch(`${CABALSPY_BASE}/api/transactions?address=${mint}&chain=${chain}`, {
        headers, signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${CABALSPY_BASE}/api/transactions/smart?address=${mint}&chain=${chain}`, {
        headers, signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${CABALSPY_BASE}/api/transactions/whale?address=${mint}&chain=${chain}`, {
        headers, signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const kol = kolRes?.walletTransactions ? aggregateWallets(kolRes.walletTransactions) : { count: 0, buyVol: 0, sellVol: 0 };
    const smart = smartRes?.walletTransactions ? aggregateWallets(smartRes.walletTransactions) : { count: 0, buyVol: 0, sellVol: 0 };
    const whale = whaleRes?.walletTransactions ? aggregateWallets(whaleRes.walletTransactions) : { count: 0, buyVol: 0, sellVol: 0 };

    const summary = `KOL=${kol.count}(${kol.buyVol.toFixed(1)}/${kol.sellVol.toFixed(1)}SOL) Smart=${smart.count}(${smart.buyVol.toFixed(1)}/${smart.sellVol.toFixed(1)}) Whale=${whale.count}(${whale.buyVol.toFixed(1)}/${whale.sellVol.toFixed(1)})`;

    return {
      kols: kol.count,
      smart: smart.count,
      whales: whale.count,
      kolBuyVol: Number(kol.buyVol.toFixed(2)),
      kolSellVol: Number(kol.sellVol.toFixed(2)),
      smartBuyVol: Number(smart.buyVol.toFixed(2)),
      smartSellVol: Number(smart.sellVol.toFixed(2)),
      whaleBuyVol: Number(whale.buyVol.toFixed(2)),
      whaleSellVol: Number(whale.sellVol.toFixed(2)),
      summary,
    };
  } catch {
    return null;
  }
}
