
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const crcT = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcT[i] = c;
}
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcT[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function createZip(files: { name: string; data: Buffer }[]): Buffer {
  const entries: { nameB: Buffer; raw: Buffer; comp: Buffer; crc: number; method: number; offset: number }[] = [];
  const parts: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameB = Buffer.from(f.name, 'utf-8');
    const crcV = crc32(f.data);
    const deflated = zlib.deflateRawSync(f.data);
    const useDeflate = deflated.length < f.data.length;
    const comp = useDeflate ? deflated : f.data;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crcV, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(nameB.length, 26);
    lfh.writeUInt16LE(0, 28);

    entries.push({ nameB, raw: f.data, comp, crc: crcV, method, offset });
    parts.push(lfh, nameB, comp);
    offset += 30 + nameB.length + comp.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);
    cdr.writeUInt16LE(20, 4);
    cdr.writeUInt16LE(20, 6);
    cdr.writeUInt16LE(0, 8);
    cdr.writeUInt16LE(e.method, 10);
    cdr.writeUInt16LE(0, 12);
    cdr.writeUInt16LE(0, 14);
    cdr.writeUInt32LE(e.crc, 16);
    cdr.writeUInt32LE(e.comp.length, 20);
    cdr.writeUInt32LE(e.raw.length, 24);
    cdr.writeUInt16LE(e.nameB.length, 28);
    cdr.writeUInt16LE(0, 30);
    cdr.writeUInt16LE(0, 32);
    cdr.writeUInt16LE(0, 34);
    cdr.writeUInt16LE(0, 36);
    cdr.writeUInt32LE(0, 38);
    cdr.writeUInt32LE(e.offset, 42);
    parts.push(cdr, e.nameB);
    offset += 46 + e.nameB.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7F) { bytes.push((v & 0x7F) | 0x80); v >>>= 7; }
  bytes.push(v);
  return Buffer.from(bytes);
}

function pbField(fieldNum: number, data: Buffer): Buffer {
  return Buffer.concat([varint((fieldNum << 3) | 2), varint(data.length), data]);
}

export function getOrCreateKey(keyPath: string): { privateKey: crypto.KeyObject; publicKeyDer: Buffer } {
  if (fs.existsSync(keyPath)) {
    const pem = fs.readFileSync(keyPath, 'utf-8');
    const pk = crypto.createPrivateKey(pem);
    const der = crypto.createPublicKey(pk).export({ type: 'spki', format: 'der' }) as Buffer;
    return { privateKey: pk, publicKeyDer: der };
  }
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  const der = pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { privateKey: pair.privateKey, publicKeyDer: der };
}

export function computeExtensionId(publicKeyDer: Buffer): string {
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + ((hash[i] >> 4) & 0xF));
    id += String.fromCharCode(97 + (hash[i] & 0xF));
  }
  return id;
}

function buildCRX3(zipData: Buffer, privateKey: crypto.KeyObject, publicKeyDer: Buffer): Buffer {

  const crxId = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);

  const signedHeaderData = pbField(1, crxId);

  const shdLen = Buffer.alloc(4);
  shdLen.writeUInt32LE(signedHeaderData.length);
  const signPayload = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00'),
    shdLen,
    signedHeaderData,
    zipData,
  ]);

  const signature = crypto.sign('sha256', signPayload, privateKey);

  const keyProof = Buffer.concat([
    pbField(1, publicKeyDer),
    pbField(2, signature),
  ]);

  const header = Buffer.concat([
    pbField(2, keyProof),
    pbField(10000, signedHeaderData),
  ]);

  const envelope = Buffer.alloc(12);
  envelope.write('Cr24', 0);
  envelope.writeUInt32LE(3, 4);
  envelope.writeUInt32LE(header.length, 8);

  return Buffer.concat([envelope, header, zipData]);
}

export function buildExtensionPackage(
  extensionDir: string,
  keyPath: string,
  serverOrigin: string,
): { crx: Buffer; extensionId: string; version: string } {
  const { privateKey, publicKeyDer } = getOrCreateKey(keyPath);
  const extensionId = computeExtensionId(publicKeyDer);
  const version = '1.0.0';

  const matchPatterns = [
    'https://pump.fun/*', 'https://www.pump.fun/*',
    'https://dexscreener.com/*', 'https://www.dexscreener.com/*',
    'https://birdeye.so/*', 'https://www.birdeye.so/*',
    'https://jup.ag/*', 'https://www.jup.ag/*',
    'https://raydium.io/*', 'https://www.raydium.io/*',
    'https://solscan.io/*', 'https://www.solscan.io/*',
    'https://solana.fm/*', 'https://www.solana.fm/*',
    'https://www.defined.fi/*',
    'https://www.tensor.trade/*',
    'https://www.coingecko.com/*',
    'https://x.com/*', 'https://twitter.com/*',
    'https://photon-sol.tinyastro.io/*',
  ];
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: 'WhiteOwl — AI Trading Overlay',
    version,
    description: 'WhiteOwl AI overlay: element inspector, trading tools, and real-time analysis on crypto sites',
    permissions: ['activeTab'],
    host_permissions: ['http://localhost:3377/*', ...matchPatterns],
    background: { service_worker: 'background.js' },
    content_scripts: [
      {
        matches: matchPatterns,
        js: ['content.js'],
        run_at: 'document_idle',
        world: 'MAIN',
      },
      {
        matches: matchPatterns,
        js: ['bridge.js'],
        run_at: 'document_idle',
        world: 'ISOLATED',
      },
    ],
    icons: { '48': 'icon48.png', '128': 'icon128.png' },
  }, null, 2);

  const cssRaw = fs.readFileSync(path.join(extensionDir, 'overlay.css'), 'utf-8');
  const cssEscaped = cssRaw.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  let injectCode = fs.readFileSync(path.join(extensionDir, 'inject.js'), 'utf-8');
  injectCode = injectCode.replace(/__AXIOM_CSS__/g, cssEscaped).replace(/__AXIOM_HOST__/g, serverOrigin);

  const bridgeCode = `window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.type !== 'wo-fetch-req') return;
  const { id, url, method, headers, body } = e.data;
  chrome.runtime.sendMessage({ type: 'wo-fetch', url, method, headers, body }, (resp) => {
    if (chrome.runtime.lastError) {
      window.postMessage({ type: 'wo-fetch-res', id, ok: false, body: chrome.runtime.lastError.message }, '*');
      return;
    }
    window.postMessage({ type: 'wo-fetch-res', id, ok: resp && resp.ok, status: resp && resp.status, body: resp && resp.body }, '*');
  });
});`;

  const bgCode = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf-8');

  const files: { name: string; data: Buffer }[] = [
    { name: 'manifest.json', data: Buffer.from(manifest) },
    { name: 'content.js', data: Buffer.from(injectCode) },
    { name: 'bridge.js', data: Buffer.from(bridgeCode) },
    { name: 'background.js', data: Buffer.from(bgCode) },
  ];

  for (const icon of ['icon48.png', 'icon128.png']) {
    const p = path.join(extensionDir, icon);
    if (fs.existsSync(p)) files.push({ name: icon, data: fs.readFileSync(p) });
  }

  const zipData = createZip(files);
  const crx = buildCRX3(zipData, privateKey, publicKeyDer);
  return { crx, extensionId, version };
}
