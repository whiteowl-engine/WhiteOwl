// CRX3 Chrome Extension packager for AXIOM
// Builds a signed .crx from extension files — no external dependencies
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

// ═══════ CRC32 (for ZIP) ═══════
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

// ═══════ Minimal ZIP builder ═══════
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
    lfh.writeUInt32LE(0x04034b50, 0);  // local file header sig
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 6);            // flags
    lfh.writeUInt16LE(method, 8);       // compression
    lfh.writeUInt16LE(0, 10);           // mod time
    lfh.writeUInt16LE(0, 12);           // mod date
    lfh.writeUInt32LE(crcV, 14);        // crc32
    lfh.writeUInt32LE(comp.length, 18); // compressed size
    lfh.writeUInt32LE(f.data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameB.length, 26);  // filename length
    lfh.writeUInt16LE(0, 28);             // extra field length

    entries.push({ nameB, raw: f.data, comp, crc: crcV, method, offset });
    parts.push(lfh, nameB, comp);
    offset += 30 + nameB.length + comp.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);   // central dir sig
    cdr.writeUInt16LE(20, 4);            // version made by
    cdr.writeUInt16LE(20, 6);            // version needed
    cdr.writeUInt16LE(0, 8);             // flags
    cdr.writeUInt16LE(e.method, 10);     // compression
    cdr.writeUInt16LE(0, 12);            // mod time
    cdr.writeUInt16LE(0, 14);            // mod date
    cdr.writeUInt32LE(e.crc, 16);        // crc32
    cdr.writeUInt32LE(e.comp.length, 20); // compressed size
    cdr.writeUInt32LE(e.raw.length, 24);  // uncompressed size
    cdr.writeUInt16LE(e.nameB.length, 28); // filename length
    cdr.writeUInt16LE(0, 30);            // extra field length
    cdr.writeUInt16LE(0, 32);            // comment length
    cdr.writeUInt16LE(0, 34);            // disk number
    cdr.writeUInt16LE(0, 36);            // internal attrs
    cdr.writeUInt32LE(0, 38);            // external attrs
    cdr.writeUInt32LE(e.offset, 42);     // local header offset
    parts.push(cdr, e.nameB);
    offset += 46 + e.nameB.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // end of central dir sig
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // disk with CD
  eocd.writeUInt16LE(entries.length, 8);   // entries on disk
  eocd.writeUInt16LE(entries.length, 10);  // total entries
  eocd.writeUInt32LE(cdSize, 12);          // CD size
  eocd.writeUInt32LE(cdStart, 16);         // CD offset
  eocd.writeUInt16LE(0, 20);              // comment length
  parts.push(eocd);

  return Buffer.concat(parts);
}

// ═══════ Protobuf varint + length-delimited field encoder ═══════
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

// ═══════ RSA Key management (generated once, persisted) ═══════
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

// ═══════ Extension ID from public key (Chrome's algorithm) ═══════
// SHA-256 of DER public key → first 16 bytes → each nibble mapped to a-p
export function computeExtensionId(publicKeyDer: Buffer): string {
  const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + ((hash[i] >> 4) & 0xF));
    id += String.fromCharCode(97 + (hash[i] & 0xF));
  }
  return id;
}

// ═══════ Build CRX3 ═══════
// Format: "Cr24" + version(3) + header_size + CrxFileHeader(protobuf) + ZIP
function buildCRX3(zipData: Buffer, privateKey: crypto.KeyObject, publicKeyDer: Buffer): Buffer {
  // crx_id = first 16 bytes of SHA-256(public_key)
  const crxId = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);

  // SignedData protobuf: { bytes crx_id = 1; }
  const signedHeaderData = pbField(1, crxId);

  // Signature payload: "CRX3 SignedData\0" + LE32(signedHeaderData.length) + signedHeaderData + zipData
  const shdLen = Buffer.alloc(4);
  shdLen.writeUInt32LE(signedHeaderData.length);
  const signPayload = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00'),
    shdLen,
    signedHeaderData,
    zipData,
  ]);

  const signature = crypto.sign('sha256', signPayload, privateKey);

  // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
  const keyProof = Buffer.concat([
    pbField(1, publicKeyDer),
    pbField(2, signature),
  ]);

  // CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
  const header = Buffer.concat([
    pbField(2, keyProof),
    pbField(10000, signedHeaderData),
  ]);

  // CRX3 envelope
  const envelope = Buffer.alloc(12);
  envelope.write('Cr24', 0);
  envelope.writeUInt32LE(3, 4);
  envelope.writeUInt32LE(header.length, 8);

  return Buffer.concat([envelope, header, zipData]);
}

// ═══════ Main: Build complete CRX package from extension directory ═══════
export function buildExtensionPackage(
  extensionDir: string,
  keyPath: string,
  serverOrigin: string,
): { crx: Buffer; extensionId: string; version: string } {
  const { privateKey, publicKeyDer } = getOrCreateKey(keyPath);
  const extensionId = computeExtensionId(publicKeyDer);
  const version = '1.0.0';

  // Custom manifest for CRX (world: MAIN bypasses page CSP for content scripts)
  const manifest = JSON.stringify({
    manifest_version: 3,
    name: 'AXIOM — AI Trading Agent',
    version,
    description: 'AI trading overlay for pump.fun',
    permissions: ['activeTab'],
    host_permissions: ['https://pump.fun/*', 'https://www.pump.fun/*'],
    content_scripts: [{
      matches: ['https://pump.fun/*', 'https://www.pump.fun/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      world: 'MAIN',
    }],
    icons: { '48': 'icon48.png', '128': 'icon128.png' },
  }, null, 2);

  // content.js = full inject.js with CSS inlined and host replaced
  const cssRaw = fs.readFileSync(path.join(extensionDir, 'overlay.css'), 'utf-8');
  const cssEscaped = cssRaw.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  let injectCode = fs.readFileSync(path.join(extensionDir, 'inject.js'), 'utf-8');
  injectCode = injectCode.replace(/__AXIOM_CSS__/g, cssEscaped).replace(/__AXIOM_HOST__/g, serverOrigin);

  const files: { name: string; data: Buffer }[] = [
    { name: 'manifest.json', data: Buffer.from(manifest) },
    { name: 'content.js', data: Buffer.from(injectCode) },
  ];

  for (const icon of ['icon48.png', 'icon128.png']) {
    const p = path.join(extensionDir, icon);
    if (fs.existsSync(p)) files.push({ name: icon, data: fs.readFileSync(p) });
  }

  const zipData = createZip(files);
  const crx = buildCRX3(zipData, privateKey, publicKeyDer);
  return { crx, extensionId, version };
}
