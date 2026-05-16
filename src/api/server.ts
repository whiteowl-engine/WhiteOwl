import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __filename_server = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename_server), '..', '..');
import QRCode from 'qrcode';
import { Runtime } from '../runtime.ts';
import { LoggerInterface, EventName } from '../types.ts';
import { sharedTerminal, terminalManager } from '../core/shared-terminal.ts';
import { buildExtensionPackage, computeExtensionId, getOrCreateKey } from './crx-builder.ts';
import { startSolPriceStream, getSolPriceUsd, getSolPriceReliable } from '../core/sol-price.ts';
import { MetricsCollector } from '../core/metrics.ts';
import { getAvailableModels, refreshOllamaModels } from '../config.ts';
import { Keypair, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, feeSharingConfigPda } from '../lib/pump-sdk.ts';
import BN from 'bn.js';
import { SquadsMultisig } from '../wallet/multisig.ts';
import { Worker } from 'worker_threads';
import { InsightXClient, RpcHolderAnalyzer, detectBotPattern, detectBotPatternFromHolders, computeDistributionMetrics } from '../skills/insightx.ts';
import { NewsStore } from '../memory/news-store.ts';
import { getAxiomApiStats } from '../skills/axiom-api.ts';

const _pumpMintPool: Keypair[] = [];
const _POOL_TARGET = 3;

const _workerCode = `
  const { parentPort } = require('worker_threads');
  const crypto = require('node:crypto');

  const P41 = 58n ** 41n;
  const LO = 1728n * P41;
  const HI = 1729n * P41;

  function run() {
    for (let i = 0; i < 5000; i++) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
      const pubDer = publicKey.export({ type: 'spki', format: 'der' });
      const off = pubDer.length - 32;
      let n = 0n;
      for (let j = 0; j < 32; j++) n = (n << 8n) | BigInt(pubDer[off + j]);
      if (n < LO || n >= HI) continue;

      const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
      const secret = Buffer.alloc(64);
      privDer.copy(secret, 0, privDer.length - 32);
      pubDer.copy(secret, 32, off);
      parentPort.postMessage([...secret]);
      return;
    }
    setImmediate(run);
  }
  run();
`;

function _spawnGrindWorker(): void {
  try {
    const w = new Worker(_workerCode, { eval: true });
    w.on('message', (secretKey: number[]) => {
      w.terminate();
      if (_pumpMintPool.length < 20) {
        _pumpMintPool.push(Keypair.fromSecretKey(Uint8Array.from(secretKey)));
      }
      if (_pumpMintPool.length < _POOL_TARGET) _spawnGrindWorker();
    });
    w.on('error', (e) => {

      if (_pumpMintPool.length < _POOL_TARGET) _spawnGrindWorker();
    });
  } catch {  }
}

for (let i = 0; i < 8; i++) _spawnGrindWorker();

function _takePumpMint(): Keypair {
  const kp = _pumpMintPool.shift();
  if (_pumpMintPool.length < _POOL_TARGET) _spawnGrindWorker();
  return kp ?? Keypair.generate();
}

const _SAFE_IMG_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com', 'ton.twitter.com', 'pbs.twitter.com']);

async function uploadToIpfs(params: {
  name: string; symbol: string; description: string;
  twitter?: string; telegram?: string; website?: string;
  imageUrl?: string;
}): Promise<string> {
  const fd = new FormData();
  fd.append('name', params.name);
  fd.append('symbol', params.symbol);
  fd.append('description', params.description);
  fd.append('showName', 'true');
  if (params.twitter)  fd.append('twitter',  params.twitter);
  if (params.telegram) fd.append('telegram', params.telegram);
  if (params.website)  fd.append('website',  params.website);

  if (params.imageUrl) {
    try {
      const host = new URL(params.imageUrl).hostname;
      if (_SAFE_IMG_HOSTS.has(host)) {
        const imgRes = await fetch(params.imageUrl, { signal: AbortSignal.timeout(8000) });
        if (imgRes.ok) {
          const blob = await imgRes.blob();
          fd.append('file', blob, 'avatar.jpg');
        }
      }
    } catch {  }
  }

    const resp = await fetch('https://pump.fun/api/ipfs', {
        method: 'POST',
    body: fd,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhiteOwl/1.0)' },
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) throw new Error(`IPFS upload failed: ${resp.status}`);
  const data = await resp.json() as { metadataUri?: string };
  if (!data.metadataUri) throw new Error('No metadataUri returned');
  return data.metadataUri;
}

function inspectorScript(port: number): string {
  return `(function(){
  if(window.__axiomInspector){window.__axiomInspector.destroy();delete window.__axiomInspector;return}
  var API='http://localhost:${port}';
  var hl=null,OUTLINE='3px solid #7c3aed',OUTLINE_BG='rgba(124,58,237,0.08)';
  var badge=document.createElement('div');
  badge.id='__axiom_badge';
  badge.innerHTML='<span style="margin-right:6px">\\u{1F989}</span> WhiteOwl Inspector Ã¢â‚¬â€ click any element (ESC to exit)';
  badge.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:linear-gradient(135deg,#1e1b4b,#312e81);color:#c4b5fd;font:600 13px/1 system-ui,sans-serif;padding:10px 20px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.4);cursor:default;user-select:none;pointer-events:auto;border:1px solid #4c1d95';
  document.body.appendChild(badge);
  function onOver(e){
    if(hl&&hl!==e.target){hl.style.outline=hl._po||'';hl.style.backgroundColor=hl._pb||''}
    hl=e.target;hl._po=hl.style.outline;hl._pb=hl.style.backgroundColor;
    hl.style.outline=OUTLINE;hl.style.backgroundColor=OUTLINE_BG;
  }
  function onOut(e){
    if(e.target&&e.target._po!==undefined){e.target.style.outline=e.target._po;e.target.style.backgroundColor=e.target._pb}
  }
  function getSelector(el){
    if(el.id)return'#'+el.id;
    var parts=[];
    while(el&&el!==document.body&&el!==document.documentElement){
      var tag=el.tagName.toLowerCase();
      if(el.id){parts.unshift('#'+el.id);break}
      if(el.className&&typeof el.className==='string'){
        var cls=el.className.trim().split(/\\s+/).slice(0,2).join('.');
        parts.unshift(tag+'.'+cls);
      }else parts.unshift(tag);
      el=el.parentElement;
    }
    return parts.join(' > ');
  }
  function onClick(e){
    e.preventDefault();e.stopPropagation();
    var el=e.target;
    var htm=el.outerHTML;if(htm.length>800)htm=htm.substring(0,800)+'...';
    var payload={selector:getSelector(el),tag:el.tagName.toLowerCase(),html:htm,text:(el.innerText||'').substring(0,200),url:location.href};
    fetch(API+'/api/browser/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),mode:'cors'}).then(function(){
      badge.innerHTML='<span style="margin-right:6px">\\u2705</span> Sent: &lt;'+payload.tag+'&gt; '+payload.selector.substring(0,40);
      setTimeout(function(){badge.innerHTML='<span style="margin-right:6px">\\u{1F989}</span> WhiteOwl Inspector Ã¢â‚¬â€ click another element (ESC to exit)'},1500);
    }).catch(function(err){
      badge.innerHTML='<span style="margin-right:6px">\\u274C</span> Error: '+err.message;
    });
    if(hl){hl.style.outline=hl._po||'';hl.style.backgroundColor=hl._pb||''}
  }
  function onKey(e){if(e.key==='Escape')destroy()}
  function destroy(){
    document.removeEventListener('mouseover',onOver,true);
    document.removeEventListener('mouseout',onOut,true);
    document.removeEventListener('click',onClick,true);
    document.removeEventListener('keydown',onKey,true);
    if(hl){hl.style.outline=hl._po||'';hl.style.backgroundColor=hl._pb||''}
    if(badge.parentNode)badge.parentNode.removeChild(badge);
    delete window.__axiomInspector;
  }
  document.addEventListener('mouseover',onOver,true);
  document.addEventListener('mouseout',onOut,true);
  document.addEventListener('click',onClick,true);
  document.addEventListener('keydown',onKey,true);
  window.__axiomInspector={destroy:destroy};
})();`;
}

function generateTokenAvatar(seed: string): string {
  let _h = 0;
  const s = String(seed || 'TOKEN');
  for (let i = 0; i < s.length; i++) _h = ((_h << 5) - _h + s.charCodeAt(i)) | 0;
  _h = Math.abs(_h) || 1;
  const rng = () => { _h = (_h * 16807) % 2147483647; return (_h & 0x7fffffff) / 2147483647; };
  const u = 'ta' + (Math.abs(_h) % 99999);
  const P = Math.PI, T = P * 2;
  const palettes = [
    ['#0f0c29','#302b63','#24243e','#8e2de2','#4a00e0','#e040fb'],
    ['#0d1b2a','#1b263b','#415a77','#00b4d8','#90e0ef','#48cae4'],
    ['#1a1a2e','#16213e','#e94560','#ff6b6b','#ffc93c','#ff8c42'],
    ['#0b0b0b','#1a1a2e','#e2e2e2','#00f5d4','#00bbf9','#ffd166'],
    ['#2d1b69','#11998e','#38ef7d','#a8ff78','#78ffd6','#eaffd0'],
    ['#1f1c2c','#928dab','#e8cbc0','#ff6a88','#ff99ac','#ffd6e0'],
    ['#0c0c0c','#f7971e','#ffd200','#ff5e62','#ff9966','#ffecd2'],
    ['#141e30','#243b55','#4ecdc4','#2bc0e4','#eaecc6','#a8e6cf'],
  ];
  const pal = palettes[~~(rng() * palettes.length)];
  const theme = ~~(rng() * 8);
  const letter = (s.match(/[A-Za-z0-9]/)?.[0] || s[0] || '?').toUpperCase();
  let defs = '', bg = '', layers = '';
  const gAng = ~~(rng() * 360);
  const gx1 = (50 + 50 * Math.cos(gAng * P / 180)).toFixed(0);
  const gy1 = (50 + 50 * Math.sin(gAng * P / 180)).toFixed(0);
  const gx2 = (50 - 50 * Math.cos(gAng * P / 180)).toFixed(0);
  const gy2 = (50 - 50 * Math.sin(gAng * P / 180)).toFixed(0);
  defs += `<linearGradient id="${u}bg" x1="${gx1}%" y1="${gy1}%" x2="${gx2}%" y2="${gy2}%">`;
  defs += `<stop offset="0%" stop-color="${pal[0]}"/><stop offset="50%" stop-color="${pal[1]}"/><stop offset="100%" stop-color="${pal[2]}"/></linearGradient>`;
  defs += `<radialGradient id="${u}rg" cx="${(30+rng()*40).toFixed(0)}%" cy="${(30+rng()*40).toFixed(0)}%" r="60%"><stop offset="0%" stop-color="${pal[3]}" stop-opacity=".6"/><stop offset="100%" stop-color="${pal[3]}" stop-opacity="0"/></radialGradient>`;
  defs += `<radialGradient id="${u}rg2" cx="${(40+rng()*30).toFixed(0)}%" cy="${(50+rng()*30).toFixed(0)}%" r="50%"><stop offset="0%" stop-color="${pal[4]}" stop-opacity=".4"/><stop offset="100%" stop-color="${pal[4]}" stop-opacity="0"/></radialGradient>`;
  defs += `<filter id="${u}gl"><feGaussianBlur stdDeviation="6"/></filter>`;
  defs += `<filter id="${u}gl2"><feGaussianBlur stdDeviation="12"/></filter>`;
  defs += `<filter id="${u}sh"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-color="${pal[0]}" flood-opacity=".7"/></filter>`;
  defs += `<clipPath id="${u}clip"><rect width="100" height="100" rx="16"/></clipPath>`;
  bg = `<rect width="100" height="100" rx="16" fill="url(#${u}bg)"/><rect width="100" height="100" rx="16" fill="url(#${u}rg)"/><rect width="100" height="100" rx="16" fill="url(#${u}rg2)"/>`;
  if (theme === 0) {
    for (let i=0;i<5;i++){const cx=10+rng()*80,cy=10+rng()*80,r=12+rng()*25;layers+=`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${pal[3+(i%3)]}" opacity="${(.15+rng()*.25).toFixed(2)}" filter="url(#${u}gl2)"/>`;}for(let i=0;i<20;i++){const cx=5+rng()*90,cy=5+rng()*90,r=.4+rng()*1.8;layers+=`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="white" opacity="${(.3+rng()*.7).toFixed(2)}"/>`;}layers+=`<circle cx="${(35+rng()*30).toFixed(0)}" cy="${(35+rng()*30).toFixed(0)}" r="18" fill="${pal[5]}" opacity=".12" filter="url(#${u}gl2)"/>`;
  } else if (theme === 1) {
    for(let i=0;i<6;i++){const cx=20+rng()*60,cy=20+rng()*60,sides=3+~~(rng()*4),sz=8+rng()*20,rot=rng()*T;let pts='';for(let si=0;si<sides;si++){const a=rot+si/sides*T;pts+=`${(cx+sz*Math.cos(a)).toFixed(1)},${(cy+sz*Math.sin(a)).toFixed(1)} `;}layers+=`<polygon points="${pts.trim()}" fill="${pal[3+(i%3)]}" opacity="${(.1+rng()*.2).toFixed(2)}" filter="url(#${u}gl)"/><polygon points="${pts.trim()}" fill="none" stroke="${pal[4]}" stroke-width=".5" opacity="${(.3+rng()*.4).toFixed(2)}"/>`;}for(let i=0;i<3;i++){const a=rng()*T,len=30+rng()*50;layers+=`<line x1="50" y1="50" x2="${(50+len*Math.cos(a)).toFixed(1)}" y2="${(50+len*Math.sin(a)).toFixed(1)}" stroke="${pal[5]}" stroke-width=".6" opacity="${(.15+rng()*.2).toFixed(2)}"/>`; }
  } else if (theme === 2) {
    for(let i=0;i<7;i++){const bx=15+rng()*70,by=80-rng()*20,h=25+rng()*45,w=8+rng()*16;layers+=`<path d="M${bx.toFixed(1)},${by.toFixed(1)} C${(bx-w*(.5+rng())).toFixed(1)},${(by-h*.4).toFixed(1)} ${(bx+w*(.5+rng())).toFixed(1)},${(by-h*.6).toFixed(1)} ${(bx+(rng()-.5)*10).toFixed(1)},${(by-h).toFixed(1)}" fill="none" stroke="${pal[3+(i%3)]}" stroke-width="${(2+rng()*6).toFixed(1)}" opacity="${(.2+rng()*.3).toFixed(2)}" stroke-linecap="round" filter="url(#${u}gl)"/>`;}for(let i=0;i<12;i++){const ex=15+rng()*70,ey=10+rng()*70,er=.5+rng()*2;layers+=`<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${er.toFixed(1)}" fill="${pal[4+(i%2)]}" opacity="${(.4+rng()*.6).toFixed(2)}"/>`; }
  } else if (theme === 3) {
    const cols=5,rows=5,sp=20;for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const nx=10+c*sp+(rng()-.5)*6,ny=10+r*sp+(rng()-.5)*6;if(rng()>.3){const dir=~~(rng()*4),len=sp*(.5+rng()*.8),dx=[len,0,-len,0][dir],dy=[0,len,0,-len][dir];layers+=`<line x1="${nx.toFixed(1)}" y1="${ny.toFixed(1)}" x2="${(nx+dx).toFixed(1)}" y2="${(ny+dy).toFixed(1)}" stroke="${pal[3+(c%3)]}" stroke-width="${(.4+rng()*.8).toFixed(1)}" opacity="${(.2+rng()*.4).toFixed(2)}"/>`;}layers+=`<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(.8+rng()*2).toFixed(1)}" fill="${pal[4]}" opacity="${(.3+rng()*.5).toFixed(2)}"/>`;}for(let i=0;i<3;i++)layers+=`<circle cx="${(rng()*100).toFixed(0)}" cy="${(rng()*100).toFixed(0)}" r="12" fill="${pal[5]}" opacity=".08" filter="url(#${u}gl2)"/>`;
  } else if (theme === 4) {
    for(let i=0;i<6;i++){const y=5+i*16+rng()*8,amp=4+rng()*12,freq=.5+rng()*1.5;let d=`M-5,${y.toFixed(1)}`;for(let x=0;x<=110;x+=5)d+=` L${x},${(y+amp*Math.sin(x*freq*P/50)).toFixed(1)}`;layers+=`<path d="${d}" fill="none" stroke="${pal[3+(i%3)]}" stroke-width="${(3+rng()*8).toFixed(1)}" opacity="${(.12+rng()*.2).toFixed(2)}" stroke-linecap="round" filter="url(#${u}gl)"/>`;}
    for(let i=0;i<8;i++)layers+=`<circle cx="${(rng()*100).toFixed(0)}" cy="${(rng()*100).toFixed(0)}" r="${(3+rng()*10).toFixed(1)}" fill="${pal[5]}" opacity="${(.05+rng()*.1).toFixed(2)}" filter="url(#${u}gl2)"/>`;
  } else if (theme === 5) {
    const cx0=35+rng()*30,cy0=35+rng()*30;for(let i=0;i<7;i++){const r=6+i*7+rng()*4,dx=(rng()-.5)*8,dy=(rng()-.5)*8;layers+=`<ellipse cx="${(cx0+dx).toFixed(1)}" cy="${(cy0+dy).toFixed(1)}" rx="${r.toFixed(1)}" ry="${(r*(.7+rng()*.6)).toFixed(1)}" fill="none" stroke="${pal[3+(i%3)]}" stroke-width="${(.5+rng()*1).toFixed(1)}" opacity="${(.2+rng()*.35).toFixed(2)}" transform="rotate(${(rng()*40-20).toFixed(0)} ${cx0.toFixed(0)} ${cy0.toFixed(0)})"/>`;}
    for(let i=0;i<15;i++)layers+=`<circle cx="${(rng()*100).toFixed(0)}" cy="${(rng()*100).toFixed(0)}" r="${(.5+rng()*1.5).toFixed(1)}" fill="${pal[4]}" opacity="${(.2+rng()*.5).toFixed(2)}"/>`;
  } else if (theme === 6) {
    for(let i=0;i<5;i++){const cx=15+rng()*70,cy=15+rng()*70,rx=10+rng()*22,ry=10+rng()*22;layers+=`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${pal[3+(i%3)]}" opacity="${(.18+rng()*.22).toFixed(2)}" filter="url(#${u}gl2)" transform="rotate(${(rng()*360).toFixed(0)} ${cx.toFixed(0)} ${cy.toFixed(0)})"/>`;}
    for(let i=0;i<4;i++){const cx=20+rng()*60,cy=20+rng()*60;layers+=`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(5+rng()*10).toFixed(1)}" ry="${(3+rng()*6).toFixed(1)}" fill="white" opacity="${(.03+rng()*.06).toFixed(2)}" filter="url(#${u}gl)"/>`;}
  } else {
    for(let i=0;i<12;i++){const x=rng()*90,y=rng()*90,w=8+rng()*20,h=8+rng()*20,rot=~~(rng()*45)-22;layers+=`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(1+rng()*4).toFixed(1)}" fill="${pal[3+(i%3)]}" opacity="${(.08+rng()*.18).toFixed(2)}" transform="rotate(${rot} ${(x+w/2).toFixed(0)} ${(y+h/2).toFixed(0)})"/>`;}
    layers+=`<circle cx="50" cy="50" r="30" fill="${pal[5]}" opacity=".06" filter="url(#${u}gl2)"/>`;
  }
  const textLayer = `<circle cx="50" cy="50" r="22" fill="${pal[0]}" opacity=".45" filter="url(#${u}gl)"/><text x="50" y="53" text-anchor="middle" dominant-baseline="central" font-size="36" font-weight="800" fill="white" fill-opacity=".95" font-family="'Inter','SF Pro Display',system-ui,sans-serif" filter="url(#${u}sh)" letter-spacing="1">${letter}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs><g clip-path="url(#${u}clip)">${bg}${layers}${textLayer}</g></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function createAPIServer(runtime: Runtime, port: number, logger: LoggerInterface, apiKey?: string) {
  const app = express();


  let _wss: WebSocketServer | null = null;
  function broadcastWalletChanged() {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'wallet-changed' });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  }


  let _gmgnWs: WebSocket | null = null;
  let _gmgnWsBackoff = 2000;
  const _gmgnTwitterBuffer: any[] = [];
  const GMGN_TWITTER_MAX = 200;
  let _capturedGmgnWsUrl = '';
  let _capturedGmgnWsTime = 0;


  const _eventBuffer: any[] = [];
  const _aiLogBuffer: any[] = [];
  const EVENT_BUFFER_MAX = 500;
  const AI_LOG_BUFFER_MAX = 500;


  const BUFFER_MUTED = new Set(['token:trade', 'token:snapshot']);
  runtime.getEventBus().onAny((event: string, data: any) => {
    if (BUFFER_MUTED.has(event)) return;
    const entry = { event, data, timestamp: Date.now() };

    _eventBuffer.push(entry);
    if (_eventBuffer.length > EVENT_BUFFER_MAX) _eventBuffer.shift();

    if (typeof event === 'string' && event.startsWith('agent:')) {
      _aiLogBuffer.push(entry);
      if (_aiLogBuffer.length > AI_LOG_BUFFER_MAX) _aiLogBuffer.shift();
    }
  });

  function broadcastGmgnTwitter(data: any) {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'gmgn_twitter', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  }

  let _gmgnFallbackFailed = false;

  function connectGmgnTwitterWs(forcedUrl?: string) {
    try {

      if (forcedUrl && _gmgnWs) {
        try { _gmgnWs.removeAllListeners(); _gmgnWs.close(); } catch {}
        _gmgnWs = null;
        _gmgnFallbackFailed = false;
      }
      if (_gmgnWs && (_gmgnWs.readyState === WebSocket.OPEN || _gmgnWs.readyState === WebSocket.CONNECTING)) return;


      const relayActive = _capturedGmgnWsTime > Date.now() - 30000 && _gmgnTwitterBuffer.length > 0;

      let wsUrl: string;
      let isFallback = false;
      if (forcedUrl) {
        wsUrl = forcedUrl;
        logger.info('[GMGN-WS] Connecting with captured URL from extension...');
      } else if (_capturedGmgnWsUrl && _capturedGmgnWsTime > Date.now() - 900000) {

        wsUrl = _capturedGmgnWsUrl;
        logger.info('[GMGN-WS] Reconnecting with previously captured URL...');
      } else {

        if (relayActive) {
          logger.info('[GMGN-WS] Extension relay active, skipping direct WS connection');
          return;
        }
        if (_gmgnFallbackFailed) return;
        isFallback = true;
        const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm';
        const tzOffset = -new Date().getTimezoneOffset() * 60;
        const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const appVer = `${datePart}-12279-c315e4d`;
        const deviceId = '17d36dea-7b0f-41a5-b075-55e05ac80fed';
        const fpDid = '658c1cb4de30106c298c464bd5273547';
        const clientId = `gmgn_web_${appVer}`;

        const params = new URLSearchParams({
          device_id: deviceId,
          fp_did: fpDid,
          client_id: clientId,
          from_app: 'gmgn',
          app_ver: appVer,
          tz_name: tzName,
          tz_offset: String(tzOffset),
          app_lang: 'ru',
          os: 'web',
        });

        wsUrl = `wss://gmgn.ai/api/v1/twitter_monitor/ws?${params.toString()}`;
        logger.info('[GMGN-WS] Connecting with fallback hardcoded params...');
      }

      _gmgnWs = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://gmgn.ai',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        }
      });

      _gmgnWs.on('error', (err: Error) => {
        logger.error('[GMGN-WS] Error:', err.message);
        if (isFallback) _gmgnFallbackFailed = true;
      });

      _gmgnWs.on('open', () => {
        logger.info('[GMGN-WS] Connected, subscribing to public_broadcast...');
        _gmgnWsBackoff = 2000;
        const subMsg = {
          action: 'subscribe',
          channel: 'public_broadcast',
          f: 'w',
          id: `sub_${Date.now()}`,
          data: [{ chain: 'sol' }]
        };
        _gmgnWs!.send(JSON.stringify(subMsg));
      });

      _gmgnWs.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          _gmgnTwitterBuffer.push({ ...msg, _ts: Date.now() });
          if (_gmgnTwitterBuffer.length > GMGN_TWITTER_MAX) _gmgnTwitterBuffer.shift();
          broadcastGmgnTwitter(msg);


          const dataArr = Array.isArray(msg.data) ? msg.data : [];
          for (const item of dataArr) {
            if (item.et !== 'twitter_watched' || !item.ed) continue;
            const ot = item.ed.ot || {};
            const st = item.ed.st || {};
            const tokens = ot.kw || st.kw || [];
            const analysis = ot.ak || '';
            const relatedAnalysis = st.ak || '';
            for (const mint of tokens) {
              if (typeof mint === 'string' && mint.length > 30) {
                runtime.getEventBus().emit('gmgn:tweet' as any, {
                  mint, ts: Date.now(), analysis, relatedAnalysis,
                });
              }
            }
          }
        } catch {}
      });

      _gmgnWs.on('close', () => {
        _gmgnWs = null;

        if (isFallback && _gmgnFallbackFailed) {
          logger.info('[GMGN-WS] Fallback params rejected, not retrying. Waiting for extension URL.');
          return;
        }

        const relayFresh = _capturedGmgnWsTime > Date.now() - 30000;
        if (relayFresh) {
          logger.info('[GMGN-WS] Direct WS closed but extension relay is active, deferring reconnect');
          setTimeout(connectGmgnTwitterWs, 60000);
        } else {
          logger.info('[GMGN-WS] Disconnected, reconnecting in ' + Math.round(_gmgnWsBackoff/1000) + 's...');
          setTimeout(connectGmgnTwitterWs, _gmgnWsBackoff);
          _gmgnWsBackoff = Math.min(_gmgnWsBackoff * 1.5, 120000);
        }
      });

    } catch (err: any) {
      logger.error('[GMGN-WS] Connect failed:', err.message);
      setTimeout(connectGmgnTwitterWs, _gmgnWsBackoff);
      _gmgnWsBackoff = Math.min(_gmgnWsBackoff * 1.5, 30000);
    }
  }


  app.get('/api/events/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 500, EVENT_BUFFER_MAX);
    res.json({ items: _eventBuffer.slice(-limit) });
  });

  app.get('/api/ailog/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 500, AI_LOG_BUFFER_MAX);
    res.json({ items: _aiLogBuffer.slice(-limit) });
  });

  app.get('/api/twitter/feed', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, GMGN_TWITTER_MAX);
    res.json({ items: _gmgnTwitterBuffer.slice(-limit) });
  });

  app.post('/api/twitter/push', express.json({ limit: '64kb' }), (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body ? [req.body] : [];
    for (const item of items) {
      _gmgnTwitterBuffer.push({ ...item, _ts: Date.now() });
      if (_gmgnTwitterBuffer.length > GMGN_TWITTER_MAX) _gmgnTwitterBuffer.shift();
      broadcastGmgnTwitter(item);


      const dataArr = Array.isArray(item.data) ? item.data : [];
      for (const entry of dataArr) {
        if (entry.et !== 'twitter_watched' || !entry.ed) continue;
        const ot = entry.ed.ot || {};
        const st = entry.ed.st || {};
        const tokens = ot.kw || st.kw || [];
        const analysis = ot.ak || '';
        const relatedAnalysis = st.ak || '';
        for (const mint of tokens) {
          if (typeof mint === 'string' && mint.length > 30) {
            runtime.getEventBus().emit('gmgn:tweet' as any, {
              mint, ts: Date.now(), analysis, relatedAnalysis,
            });
          }
        }
      }
    }

    _capturedGmgnWsTime = Date.now();
    res.json({ ok: true, buffered: _gmgnTwitterBuffer.length });
  });


  app.post('/api/twitter/gmgn-ws', express.json({ limit: '4kb' }), (req, res) => {
    const { wsUrl } = req.body || {};
    if (wsUrl && typeof wsUrl === 'string' && wsUrl.includes('gmgn.ai') && wsUrl.includes('/ws')) {
      _capturedGmgnWsUrl = wsUrl;
      _capturedGmgnWsTime = Date.now();
      logger.info('[GMGN-WS] Captured WS URL from extension: ' + wsUrl.slice(0, 80) + '...');

      if (_gmgnWs) {
        try { _gmgnWs.removeAllListeners(); _gmgnWs.close(); } catch {}
        _gmgnWs = null;
      }
      _gmgnWsBackoff = 2000;
      connectGmgnTwitterWs(wsUrl);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Invalid WS URL' });
    }
  });

  app.get('/api/twitter/gmgn-ws', (_req, res) => {
    res.json({
      wsUrl: _capturedGmgnWsUrl || '',
      capturedAt: _capturedGmgnWsTime,
      fresh: _capturedGmgnWsTime > Date.now() - 900000,
      wsConnected: _gmgnWs ? _gmgnWs.readyState === WebSocket.OPEN : false,
      bufferSize: _gmgnTwitterBuffer.length,
    });
  });


  let _newsStore: NewsStore | null = null;
  try {
    _newsStore = new NewsStore(runtime.getMemory().getDb());
  } catch {

  }

  app.get('/api/news/feed', (req, res) => {
    if (!_newsStore) return res.json({ items: [] });
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const category = (req.query.category as string) || 'all';
    const since = parseInt(req.query.since as string) || 0;
    const items = _newsStore.getItems({ limit, offset, category: category as any, since });
    res.json({ items });
  });

  app.get('/api/news/sentiment', (_req, res) => {
    if (!_newsStore) return res.json({ bullish: 0, bearish: 0, neutral: 0, trend: 'neutral', updated_at: Date.now() });
    res.json(_newsStore.getSentimentSummary());
  });

  app.get('/api/news/sources', (_req, res) => {
    const scheduler = (runtime as any)._newsScheduler;
    if (scheduler && typeof scheduler.getSourceStatuses === 'function') {
      res.json({ sources: scheduler.getSourceStatuses() });
    } else {
      res.json({ sources: [] });
    }
  });

  app.get('/api/news/search', (req, res) => {
    if (!_newsStore) return res.json({ items: [] });
    const q = (req.query.q as string) || '';
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    if (!q) return res.json({ items: [] });
    res.json({ items: _newsStore.search(q, limit) });
  });


  runtime.getEventBus().on('news:headline', (data) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'news_headline', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });

  runtime.getEventBus().on('news:sentiment_update', (data) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'news_sentiment', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });


  app.post('/api/sniper/start', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    sniperJob.start();
    res.json({ ok: true, status: 'running' });
  });

  app.post('/api/sniper/stop', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    sniperJob.stop();
    res.json({ ok: true, status: 'stopped' });
  });

  app.get('/api/sniper/status', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.json({ running: false, initialized: false });
    const stats = sniperJob.getStats();
    const strategy = sniperJob.getStrategy();
    res.json({ initialized: true, ...stats, strategy });
  });

  app.post('/api/sniper/config', express.json(), (req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    if (req.body && typeof req.body === 'object') {
      sniperJob.updateStrategy(req.body);
    }
    res.json({ ok: true, strategy: sniperJob.getStrategy() });
  });

  app.get('/api/sniper/tokens', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.json({ tokens: [] });
    res.json({ tokens: sniperJob.getTokenOverlay() });
  });

  app.get('/api/sniper/position/:mint', (req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });

    const mint = String(req.params.mint || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      return res.status(400).json({ error: 'Invalid mint' });
    }

    const paper = sniperJob.getPaperStatus();
    res.json({
      position: sniperJob.getTrackedPosition(mint),
      paperMode: paper.enabled,
      paperBalance: paper.balance,
      realBalance: paper.realBalance,
      readyForLive: paper.readyForLive,
    });
  });


  app.post('/api/sniper/paper', express.json(), (req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    const { mode, balance, adjust, sync, reset } = req.body || {};

    if (mode === 'paper' || mode === 'demo') {
      sniperJob.setPaperMode(true);
    } else if (mode === 'live' || mode === 'real') {
      sniperJob.setPaperMode(false);
    }

    if (balance !== undefined) sniperJob.setPaperBalance(Number(balance));

    if (adjust !== undefined) sniperJob.adjustPaperBalance(Number(adjust));

    if (sync) sniperJob.syncPaperWithReal();

    if (reset) sniperJob.resetPaper();
    res.json({ ok: true, paper: sniperJob.getPaperStatus() });
  });

  app.get('/api/sniper/paper', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    res.json(sniperJob.getPaperStatus());
  });


  app.post('/api/sniper/chat', express.json(), async (req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'message required (max 2000 chars)' });
    }
    try {
      const reply = await sniperJob.chatWithAI(message);
      res.json({ ok: true, reply, instructions: sniperJob.getUserInstructions() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'chat failed' });
    }
  });

  app.get('/api/sniper/chat', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    res.json({ history: sniperJob.getChatHistory(), instructions: sniperJob.getUserInstructions() });
  });

  app.delete('/api/sniper/chat/instruction/:index', (req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    const idx = parseInt(req.params.index, 10);
    const removed = sniperJob.removeInstruction(idx);
    res.json({ ok: removed, instructions: sniperJob.getUserInstructions() });
  });


  app.get('/api/sniper/trades', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    const stats = sniperJob.getStats();
    const strategy = sniperJob.getStrategy();
    res.json({
      allTrades: sniperJob.getAllPaperTrades(),
      positions: stats.trackedPositions || [],
      takeProfitLevels: strategy.takeProfitLevels || [],
    });
  });


  app.get('/api/sniper/journal', (_req, res) => {
    const sniperJob = (runtime as any)._sniperJob;
    if (!sniperJob) return res.status(503).json({ error: 'Sniper not initialized' });
    res.json({ journal: sniperJob.getLearningJournal(), stats: sniperJob.getLearningStats() });
  });


  app.get('/api/sniper/connections', (_req, res) => {
    const axiom = getAxiomApiStats();
    const pumpSkill = runtime.getSkillLoader().getSkill('pump-monitor') as any;
    const pump = pumpSkill?.getPumpApiStats?.() || {};
    const gmgnSkill = runtime.getSkillLoader().getSkill('gmgn') as any;
    const gmgn = gmgnSkill?.getGmgnApiStats?.() || {};
    res.json({ axiom, pump, gmgn });
  });


  runtime.getEventBus().on('sniper:cycle' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'sniper_cycle', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });
  runtime.getEventBus().on('sniper:started' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'sniper_started', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });
  runtime.getEventBus().on('sniper:stopped' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'sniper_stopped', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });


  const getAnnouncementSkill = () =>
    runtime.getSkillLoader().getSkill('announcement-sniper') as any;

  app.get('/api/announcement/status', async (_req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_status', {}));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announcement/configure', express.json(), async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_configure', req.body || {}));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/announcement/active', async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      const limit = parseInt(req.query.limit as string) || 20;
      res.json(await skill.execute('announcement_active', { limit }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/announcement/history', async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(await skill.execute('announcement_history', { limit }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announcement/test', express.json(), async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_test', req.body || {}));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announcement/skip/:id', async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_skip', { id: req.params.id }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announcement/approve/:id', express.json(), async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      const sizeSol = typeof req.body?.sizeSol === 'number' ? req.body.sizeSol : undefined;
      res.json(await skill.execute('announcement_approve', { id: req.params.id, sizeSol }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announcement/pattern', express.json(), async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_pattern_add', req.body || {}));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/announcement/pattern/:id', async (req, res) => {
    try {
      const skill = getAnnouncementSkill();
      if (!skill) return res.status(503).json({ error: 'announcement-sniper not loaded' });
      res.json(await skill.execute('announcement_pattern_remove', { id: req.params.id }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  runtime.getEventBus().on('announcement:detected' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'announcement_detected', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });

  const getHL = () => runtime.getSkillLoader().getSkill('hyperliquid-perp') as any;

  app.get('/api/hyperliquid/status', async (_req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_status', {}));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/hyperliquid/configure', express.json(), async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_configure', req.body || {}));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/hyperliquid/funding', async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_funding', { coin: req.query.coin }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/hyperliquid/mark', async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_mark_price', { coin: req.query.coin }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/hyperliquid/open', express.json(), async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_open', req.body || {}));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/hyperliquid/close/:id', async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_close', { id: req.params.id }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/hyperliquid/positions', async (req, res) => {
    try {
      const s = getHL();
      if (!s) return res.status(503).json({ error: 'hyperliquid-perp not loaded' });
      res.json(await s.execute('hl_positions', { includeClosed: req.query.includeClosed === 'true' }));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  runtime.getEventBus().on('hyperliquid:position_opened' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'hyperliquid_position_opened', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });
  runtime.getEventBus().on('hyperliquid:position_closed' as any, (data: any) => {
    if (!_wss) return;
    const msg = JSON.stringify({ type: 'hyperliquid_position_closed', data });
    _wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch {} });
  });

  const chatResponseStore = new Map<string, {
    status: 'processing' | 'done' | 'error';
    agentId: string;
    events: Array<{ type: string; [key: string]: any }>;
    response?: string;
    error?: string;
    startedAt: number;
  }>();


  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, val] of chatResponseStore) {
      if (val.startedAt < cutoff) chatResponseStore.delete(key);
    }
  }, 5 * 60 * 1000);


  app.use('/p', (req: any, res: any) => {

    const match = req.url.match(/^\/([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/.*)$/);
    if (!match) {

      const bare = req.url.match(/^\/([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})\/?$/);
      if (bare) return res.redirect(302, `/p/${bare[1]}/`);
      return res.status(400).send('Bad proxy URL');
    }
    const host = match[1];
    const targetPath = match[2];
    const targetUrl = `https://${host}${targetPath}`;

    const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];
    if (blockedHosts.some(h => host.includes(h))) {
      return res.status(403).send('Blocked host');
    }

    const parsedTarget = new URL(targetUrl);

    const proxyHeaders: Record<string, string> = {
      'host': host,
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
    };

    if (req.headers['content-type']) proxyHeaders['content-type'] = req.headers['content-type'];
    if (req.headers['content-length']) proxyHeaders['content-length'] = req.headers['content-length'];
    if (req.headers['referer']) {

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

    if (req.headers['cookie']) proxyHeaders['cookie'] = req.headers['cookie'];

    const proxyReq = https.request({
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || 443,
      path: parsedTarget.pathname + parsedTarget.search,
      method: req.method,
      headers: proxyHeaders,
      rejectUnauthorized: false,
    } as any, (proxyRes: any) => {

      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        let loc = proxyRes.headers.location;
        try {
          const locUrl = new URL(loc, targetUrl);
          if (locUrl.hostname === host || locUrl.hostname.endsWith('.' + host)) {
            loc = `/p/${locUrl.hostname}${locUrl.pathname}${locUrl.search}`;
          } else {

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


      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const kl = k.toLowerCase();
        if (kl === 'x-frame-options') continue;
        if (kl === 'content-security-policy') continue;
        if (kl === 'content-security-policy-report-only') continue;
        if (kl === 'x-content-type-options') continue;
        if (kl === 'content-encoding') continue;
        if (kl === 'content-length') continue;
        if (kl === 'transfer-encoding') continue;
        if (kl === 'set-cookie') {

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

        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf-8');


          html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');

          html = html.replace(/if\s*\(\s*(?:top|window\.top|parent|window\.parent)\s*!==?\s*(?:self|window\.self|window)\s*\)[^}]*}/gi, '');
          html = html.replace(/top\.location\s*=\s*self\.location/gi, '');


          html = html.replace(/(["'])\/cdn-cgi\//g, '$1cdn-cgi/');
          html = html.replace(/(["'])\/\?__cf_chl_/g, '$1?__cf_chl_');

          html = html.replace(/(href|src|action)\s*=\s*"\/(?!\/)/gi, '$1="');
          html = html.replace(/(href|src|action)\s*=\s*'\/(?!\/)/gi, "$1='");


          const baseTag = `<base href="/p/${host}/">`;
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
          } else if (/<html[^>]*>/i.test(html)) {
            html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
          } else {
            html = `<head>${baseTag}</head>` + html;
          }


          const injScript = `<script>
(function(){
  var proxyOrigin = window.location.origin;

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

    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;

    try {

      if (url.startsWith('http://') || url.startsWith('https://')) {
        var u = new URL(url);

        if (u.origin === proxyOrigin && u.pathname.startsWith('/p/')) return url;

        return proxyOrigin + '/p/' + u.host + u.pathname + u.search + u.hash;
      }

      if (url.startsWith('//')) {
        var u2 = new URL('https:' + url);
        return proxyOrigin + '/p/' + u2.host + u2.pathname + u2.search + u2.hash;
      }

      if (url.startsWith('/')) {

        if (url.startsWith('/p/')) return url;

        return proxyBase + url;
      }

      return url;
    } catch(e) {
      console.warn('[Proxy] URL rewrite error:', e, url);
    }
    return url;
  }

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

          var newInit = {};
          ['method','headers','body','mode','credentials','cache','redirect','referrer','integrity'].forEach(function(k) {
            if (input[k] !== undefined) newInit[k] = input[k];
          });
          if (init) Object.assign(newInit, init);

          newInit.mode = 'cors';
          newInit.credentials = 'include';
          input = new Request(newUrl, newInit);
        }
      }
    } catch(e) { console.warn('[Proxy] fetch intercept error:', e); }
    return origFetch.call(this, input, init);
  };

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

  var OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var wsUrl = url;
    try {
      var u = new URL(url);

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

  var lastTitle = '';
  setInterval(function() {
    if (document.title && document.title !== lastTitle) {
      lastTitle = document.title;
      window.parent.postMessage({ type: 'desk-title', title: document.title }, '*');
    }
  }, 500);

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

        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let css = Buffer.concat(chunks).toString('utf-8');


          css = css.replace(/url\(\s*['"]?(https?:\/\/[^'"\)]+)['"]?\s*\)/gi, (match, url) => {
            try {
              const u = new URL(url);
              return `url("/p/${u.host}${u.pathname}${u.search}")`;
            } catch { return match; }
          });

          css = css.replace(/url\(\s*['"]?(\/\/[^'"\)]+)['"]?\s*\)/gi, (match, url) => {
            try {
              const u = new URL('https:' + url);
              return `url("/p/${u.host}${u.pathname}${u.search}")`;
            } catch { return match; }
          });

          css = css.replace(/url\(\s*['"]?(\/[^'"\)]+)['"]?\s*\)/gi, (match, path) => {
            if (path.startsWith('/p/')) return match;
            return `url("/p/${host}${path}")`;
          });

          respHeaders['content-type'] = ct;
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(css);
        });
      } else if (ct.includes('javascript') || ct.includes('application/json')) {

        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let js = Buffer.concat(chunks).toString('utf-8');


          js = js.replace(/(["'])(https?:\/\/)([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/[^"']*)?(['"])/g,
            (match, q1, proto, domain, path, q2) => {

              if (domain === 'localhost' || domain.startsWith('127.')) return match;
              return `${q1}/p/${domain}${path || '/'}${q2}`;
            });

          js = js.replace(/(["'])(\/\/)([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,})(\/[^"']*)?(['"])/g,
            (match, q1, slashes, domain, path, q2) => {
              return `${q1}/p/${domain}${path || '/'}${q2}`;
            });

          respHeaders['content-type'] = ct;
          res.writeHead(proxyRes.statusCode || 200, respHeaders);
          res.end(js);
        });
      } else {

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


    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });

  app.use(express.json({ limit: '10mb' }));


  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });
  app.use(cors());


  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const SESSIONS_FILE = path.join('./data', 'sessions.json');

  interface SessionData { username: string; provider: string; createdAt: number }
  const authSessions = new Map<string, SessionData>();


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
    } catch {  }
  }

  function saveSessions(): void {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = Array.from(authSessions.entries());
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(entries), 'utf-8');
    } catch {  }
  }

  loadSessions();


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


  const publicPrefixes = [
    '/api/auth/',
    '/api/oauth/',
    '/health',
    '/api/twitter/',
    '/api/pumpfun/',
    '/api/token/',
    '/api/image-scan',
    '/api/wallet/tokens',
    '/api/portfolio/',
    '/metrics',
    '/dashboard',
    '/extension',
    '/skillhub',
    '/desktop-browse',
    '/p/',
    '/api/projects/preview/',
    '/api/browser/select',
    '/api/browser/inspector.js',
  ];


  const publicExact = new Set(['/', '/dashboard', '/proxy-sw.js']);


  app.use((_req, _res, next) => next());


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


  app.get('/api/auth/status', (req, res) => {
    const token = getAuthToken(req);
    if (!token || !authSessions.has(token)) {
      return res.json({ authenticated: false });
    }
    const session = authSessions.get(token)!;
    res.json({ authenticated: true, username: session.username, provider: session.provider });
  });


  app.post('/api/auth/logout', (req, res) => {
    const token = getAuthToken(req);
    if (token) { authSessions.delete(token); saveSessions(); }
    res.json({ success: true });
  });


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


async function _fetchImageAsBase64(imageUrl: string): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    try {
      const host = new URL(imageUrl).hostname;
      if (!_SAFE_IMG_HOSTS.has(host)) return undefined;
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(6000) });
      if (!imgRes.ok) return undefined;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mime = imgRes.headers.get('content-type') || 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  async function derivePumpMetadata(text: string, imageUrl?: string): Promise<{ name: string; symbol: string; description: string }> {
    const cleanText = String(text || '').trim();
    if (!cleanText && !imageUrl) return { name: 'Shield Token', symbol: 'SHLD', description: 'Generated token' };


    try {

      const imageBase64 = imageUrl ? await _fetchImageAsBase64(imageUrl) : undefined;
      const hasImage = Boolean(imageBase64);

      const prompt = `You are a top Pump.fun meme-coin creator. Your job is to create a VIRAL, catchy token name based on the tweet below.${hasImage ? ' An image from the post is attached Ã¢â‚¬â€ analyze it carefully for meme references, characters, animals, emotions, or visual gags that can inspire the token.' : ''}
Return strictly valid JSON with three keys: "name", "symbol", and "description".

RULES for "name":
- Must be catchy, memeable, and FUN (think: $PEPE, $DOGE, $BONK, $WIF)
- If the post mentions a person, animal, object, or meme Ã¢â‚¬â€ build the name around THAT
- Use wordplay, puns, abbreviations, or internet slang when fitting
- Max 20 chars, no generic names like "Shield Token" or "Post Token"
- One or two words is ideal

RULES for "symbol":
- Uppercase ticker, 3-6 chars, derived from the name
- Must be memorable and easy to type

RULES for "description":
- One sentence describing what the token represents
- Reference the actual content of the post${hasImage ? ' and image' : ''}
- No hype, no emojis, no "to the moon", no calls to action

Post text: "${cleanText}"`;

      const output = await runtime.quickLlm(prompt, imageBase64);
      const start = output.indexOf('{');
      const end = output.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(output.substring(start, end + 1));
        if (parsed.name && parsed.symbol) {
          return {
            name: String(parsed.name).slice(0, 32),
            symbol: String(parsed.symbol).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase(),
            description: String(parsed.description || cleanText).slice(0, 280)
          };
        }
      }
    } catch (e) {

    }

    const words = cleanText.split(/\s+/).filter(Boolean);
    const base = words.slice(0, 4).join(' ') || 'Shield Token';
    const name = base.slice(0, 32);
    const symbolRaw = (words[0] || 'SHLD').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
    const symbol = symbolRaw || 'SHLD';
    const description = cleanText.slice(0, 280) || 'Pump.fun token generated from post';
    return { name, symbol, description };
  }


  app.post('/api/image-scan', async (req, res) => {
    try {
      const { imageUrl, imageBase64: providedBase64 } = req.body || {};


      let imageBase64: string | undefined = undefined;
      if (providedBase64 && typeof providedBase64 === 'string' && providedBase64.startsWith('data:')) {
        imageBase64 = providedBase64;
      } else if (imageUrl && typeof imageUrl === 'string') {
        let host: string;
        try { host = new URL(imageUrl).hostname; } catch { return res.json({ mints: [] }); }
        if (!_SAFE_IMG_HOSTS.has(host)) return res.json({ mints: [] });
        imageBase64 = await _fetchImageAsBase64(imageUrl);
      }
      if (!imageBase64) return res.json({ mints: [] });

      const SOL_ADDR_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,48}\b/g;
      const SKIP = new Set([
        'So11111111111111111111111111111111111111112',
        '11111111111111111111111111111111',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ]);

      const prompt = `You are a Solana blockchain expert. Look at this image carefully and extract ALL Solana token contract addresses (mint addresses) visible in it.

Solana addresses are base58 strings, typically 32-44 characters long (pump.fun vanity addresses end in "pump" and may appear up to 44-45 chars). They contain only: 1-9 A-H J-N P-Z a-k m-z (no 0, O, I, l).
They may appear as: plain text, in a QR-like display, next to labels like "CA:", "Contract:", "Mint:", "Address:", or in pump.fun/solscan/birdeye URLs, or written alone as the entire content of the image.

Return ONLY a JSON object: { "mints": ["addr1", "addr2"] }
If no addresses found, return { "mints": [] }
Do NOT include system programs or well-known non-token addresses.
Do NOT explain or add any other text.`;

      const output = await runtime.quickLlm(prompt, imageBase64);
      console.log('[image-scan] LLM raw output:', output.slice(0, 500));
      const start = output.indexOf('{');
      const end = output.lastIndexOf('}');
      let mints: string[] = [];
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(output.substring(start, end + 1));
          if (Array.isArray(parsed.mints)) {
            mints = parsed.mints
              .filter((m: any) => typeof m === 'string' && SOL_ADDR_RE.test(m) && !SKIP.has(m))
              .map((m: string) => m.trim());
            SOL_ADDR_RE.lastIndex = 0;
          }
        } catch {}
      }

      if (mints.length === 0) {
        SOL_ADDR_RE.lastIndex = 0;
        const matches = output.match(SOL_ADDR_RE) || [];
        mints = [...new Set(matches.filter((m: string) => !SKIP.has(m)))];
        if (mints.length > 0) console.log('[image-scan] regex fallback found:', mints);
      }
      console.log('[image-scan] final mints:', mints);
      return res.json({ mints });
    } catch (err: any) {
      return res.json({ mints: [], error: err.message });
    }
  });

  app.post('/api/pumpfun/preview', async (req, res) => {
    try {
      const { text = '', postUrl = '', buyIn = 0, imageUrl = '', twitter = '', telegram = '', website = '' } = req.body || {};


      const [meta, mint] = await Promise.all([
        derivePumpMetadata(String(text || ''), imageUrl || undefined),
        Promise.resolve(_takePumpMint()),
      ]);

      const tokenAddress = mint.publicKey.toBase58();
      const mintSecret = Array.from(mint.secretKey);


      let metadataUri = postUrl || 'https://pump.fun';
      try {
        metadataUri = await uploadToIpfs({
          name: meta.name, symbol: meta.symbol, description: meta.description,
          twitter: twitter || undefined, telegram: telegram || undefined, website: website || undefined,
          imageUrl: imageUrl || undefined,
        });
      } catch (e: any) {

      }


      const avatar = imageUrl || generateTokenAvatar(meta.symbol || meta.name || 'SHLD');
      const tokenUrl = `https://pump.fun/coin/${tokenAddress}`;

      res.json({ ok: true, ...meta, tokenAddress, mintSecret, metadataUri, tokenUrl, buyIn, avatar });
    } catch (err: any) {
      logger.error(`pumpfun preview failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message || 'Preview generation failed' });
    }
  });

  app.post('/api/pumpfun/autobuild', async (req, res) => {
    const { text = '', postUrl = '', buyIn = 0.05, name, symbol, description,
      mayhemMode = false, cashback = false, tokenizedAgent = false,
      mintSecret, metadataUri,
      twitter, telegram, website,
      imageUrl
    } = req.body || {};
    const wallet = runtime.getWallet();
    if (!wallet.hasWallet()) {
      return res.status(400).json({ ok: false, error: 'Wallet not configured' });
    }

    try {
      const meta = await derivePumpMetadata(String(text || ''), imageUrl || undefined);
      const finalName = (name || meta.name || 'Pump Token').slice(0, 20);
      const finalSymbol = (symbol || meta.symbol || 'PUMP').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'PUMP';
      const finalDescription = (description || meta.description || '').slice(0, 200);

      const connection = wallet.getConnection();
      const onlineSdk = new OnlinePumpSdk(connection);
      const global = await onlineSdk.fetchGlobal();

      const lamportsFloat = Math.max(0.005, Number(buyIn) || 0.05) * LAMPORTS_PER_SOL;
      const solLamports = new BN(Math.round(lamportsFloat));
      const buyAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig: null,
        mintSupply: null,
        bondingCurve: null,
        amount: solLamports,
      });

      let mint: Keypair;
      if (mintSecret && Array.isArray(mintSecret)) {
        mint = Keypair.fromSecretKey(Uint8Array.from(mintSecret));
      } else {
        mint = _takePumpMint();
      }
      const creator = wallet.getPublicKey();
      const creatorKp = wallet.getKeypairRaw();


      const hasSocialLinks = Boolean(twitter || telegram || website);
      let finalUri = metadataUri || '';
      if (!finalUri || finalUri === 'https://pump.fun' || hasSocialLinks) {
        try {
          finalUri = await uploadToIpfs({
            name: finalName, symbol: finalSymbol, description: finalDescription,
            twitter: twitter || undefined, telegram: telegram || undefined, website: website || undefined,
            imageUrl: imageUrl || undefined,
          });
        } catch {

          finalUri = metadataUri && metadataUri !== 'https://pump.fun' ? metadataUri : 'https://pump.fun';
        }
      }

      const instructions = await PUMP_SDK.createV2AndBuyInstructions({
        global,
        mint: mint.publicKey,
        name: finalName,
        symbol: finalSymbol,
        uri: finalUri,
        creator,
        user: creator,
        amount: buyAmount,
        solAmount: solLamports,
        mayhemMode: Boolean(mayhemMode),
        cashback: Boolean(cashback),
      });

      const tx = new Transaction();
      tx.add(...instructions);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = creator;


      tx.sign(mint, creatorKp);
      const signature = await sendAndConfirmTransaction(connection, tx, [creatorKp, mint], { commitment: 'confirmed' });


      if (tokenizedAgent) {
        try {
          const feeSharingIx = await PUMP_SDK.createFeeSharingConfig({
            creator,
            mint: mint.publicKey,
            pool: null,
          });
          const tx2 = new Transaction();
          tx2.add(feeSharingIx);
          const { blockhash: bh2 } = await connection.getLatestBlockhash();
          tx2.recentBlockhash = bh2;
          tx2.feePayer = creator;
          tx2.sign(creatorKp);
          await sendAndConfirmTransaction(connection, tx2, [creatorKp], { commitment: 'confirmed' });
        } catch (e: any) {
          logger.warn(`Fee sharing config tx failed (non-fatal): ${e.message}`);
        }
      }

      const tokenAddress = mint.publicKey.toBase58();
      const tokenUrl = `https://pump.fun/coin/${tokenAddress}`;
      const avatar = imageUrl || generateTokenAvatar(finalSymbol || finalName || 'SHLD');

      res.json({
        ok: true,
        tokenAddress,
        tokenUrl,
        tx: signature,
        name: finalName,
        symbol: finalSymbol,
        description: finalDescription,
        buyIn: solLamports.toNumber() / LAMPORTS_PER_SOL,
        avatar,
      });
    } catch (err: any) {
      logger.error(`pumpfun autobuild failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message || 'Failed to build token' });
    }
  });


  app.post('/api/pumpfun/buy', async (req, res) => {
    try {
      const { tokenAddress, solAmount = 0.1 } = req.body || {};
      if (!tokenAddress) return res.status(400).json({ ok: false, error: 'tokenAddress required' });
      const sol = Math.max(0.001, Number(solAmount) || 0.1);

      const traderSkill = runtime.getSkillLoader().getSkill('shit-trader') as any;
      if (!traderSkill) return res.status(503).json({ ok: false, error: 'shit-trader skill not loaded' });

      const result = await traderSkill.execute('fast_buy', { mint: tokenAddress, solAmount: sol });
      res.json({ ok: result.success, txHash: result.txHash, error: result.error });
    } catch (err: any) {
      logger.error(`pumpfun buy failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message || 'Buy failed' });
    }
  });


  app.post('/api/pumpfun/sell', async (req, res) => {
    try {
      const { tokenAddress, percent = 100 } = req.body || {};
      if (!tokenAddress) return res.status(400).json({ ok: false, error: 'tokenAddress required' });
      const pct = Math.max(1, Math.min(100, Number(percent) || 100));

      const traderSkill = runtime.getSkillLoader().getSkill('shit-trader') as any;
      if (!traderSkill) return res.status(503).json({ ok: false, error: 'shit-trader skill not loaded' });


      const result = await traderSkill.execute('fast_sell', { mint: tokenAddress, percent: pct });
      res.json({ ok: result.success, txHash: result.txHash, error: result.error });
    } catch (err: any) {
      logger.error(`pumpfun sell failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message || 'Sell failed' });
    }
  });


  const _createdTsCache = new Map<string, { ts: number; at: number }>();
  const PUMP_HDRS = {
    Accept: 'application/json',
    Origin: 'https://pump.fun',
    Referer: 'https://pump.fun/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  app.get('/api/pumpfun/chart/:mint', async (req, res) => {
    const mint = String(req.params.mint || '').trim();
    if (!mint || !/^[A-HJ-NP-Za-km-z1-9]{32,50}$/.test(mint)) {
      return res.status(400).json({ ok: false, error: 'Invalid mint address' });
    }
    try {

      let createdTs = 0;
      const cached = _createdTsCache.get(mint);
      if (cached && Date.now() - cached.at < 600_000) {
        createdTs = cached.ts;
      } else {
        try {
          const infoResp = await fetch(`https://frontend-api.pump.fun/coins/${mint}`);
          if (infoResp.ok) {
            const text = await infoResp.text();
            if (text) {
              const info: any = JSON.parse(text);
              createdTs = Number(info.created_timestamp || 0);
            }
          }
        } catch (_e) {  }
        if (createdTs) _createdTsCache.set(mint, { ts: createdTs, at: Date.now() });
      }

      if (!createdTs) {
        return res.json({ ok: false, error: 'Token not indexed yet Ã¢â‚¬â€ no chart data available' });
      }

      const url = `https://swap-api.pump.fun/v2/coins/${mint}/candles?interval=1m&limit=200&currency=USD&program=pump&createdTs=${createdTs}`;
      const candleResp = await fetch(url, { headers: PUMP_HDRS, signal: AbortSignal.timeout(8000) });
      if (!candleResp.ok) return res.status(candleResp.status).json({ ok: false, error: `pump.fun candle API ${candleResp.status}` });
      const raw = await candleResp.json() as any[];

      const candles = raw.map((c: any) => ({
        ts: Math.floor((c.timestamp || 0) / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }));
      res.json({ ok: true, candles });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || 'Chart fetch failed' });
    }
  });


  const _txCache: { address: string; sigs: string; txs: any[]; ts: number } = { address: '', sigs: '', txs: [], ts: 0 };
  const TX_CACHE_TTL = 120_000;
  let _txRefreshing = false;


  const DEX_PROGRAMS = new Set([
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
    'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN9hQ',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
    'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',
    'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  ]);


  let _walletResCache: { data: any; ts: number } = { data: null, ts: 0 };
  app.get('/api/wallet', async (_req, res) => {
    try {
      const w = runtime.getWallet();
      if (!w.hasWallet()) {
        return res.json({ configured: false, address: '', balance: 0, recentTxs: [], wallets: w.getStoredWallets() });
      }


      if (_vaultMode.active) {
        const vaultAddr = _vaultMode.vault;
        if (_walletResCache.data && _walletResCache.data.address === vaultAddr && Date.now() - _walletResCache.ts < 3000) {
          return res.json(_walletResCache.data);
        }
        const vaultBalance = await _squads.getVaultBalance(_vaultMode.multisigPda).catch(() => 0);
        const wallets = w.getStoredWallets();
        const result = {
          configured: true,
          address: vaultAddr,
          balance: vaultBalance,
          recentTxs: [],
          wallets,
          vaultMode: {
            active: true,
            name: _vaultMode.name,
            multisigPda: _vaultMode.multisigPda,
            vault: _vaultMode.vault,
            threshold: _vaultMode.threshold,
            members: _vaultMode.members,
          },
        };
        _walletResCache = { data: result, ts: Date.now() };
        return res.json(result);
      }

      const address = w.getAddress();


      if (_walletResCache.data && _walletResCache.data.address === address && Date.now() - _walletResCache.ts < 3000) {
        return res.json(_walletResCache.data);
      }


      const stored = w.getStoredWallets();
      if (!stored.some(s => s.address === address)) {
        w.addCurrentToStore('Main Wallet');
      }
      const wallets = w.getStoredWallets();


      const balance = await w.getBalance().catch((e: any) => {
        logger.warn(`getBalance failed: ${e.message}`);
        return 0;
      });


      const cachedTxs = (_txCache.address === address && _txCache.txs.length > 0) ? _txCache.txs : [];


      if (!_txRefreshing && (_txCache.address !== address || Date.now() - _txCache.ts > TX_CACHE_TTL)) {
        _refreshTxCache(w).catch(() => {});
      }

      const result = { configured: true, address, balance, recentTxs: cachedTxs, wallets };
      _walletResCache = { data: result, ts: Date.now() };
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  async function _refreshTxCache(w: any) {
    if (_txRefreshing) return;
    _txRefreshing = true;
    try {
      const connection = w.getConnection();
      const ownerAddr = w.getAddress();
      const sigs = await connection.getSignaturesForAddress(w.getPublicKey(), { limit: 5 });
      if (!sigs.length) { _txCache.address = ownerAddr; _txCache.sigs = ''; _txCache.txs = []; _txCache.ts = Date.now(); logger.info('getSignaturesForAddress returned 0 results'); return; }
      const txSigs = sigs.map((s: any) => s.signature);
      const sigsKey = txSigs.join(',');


      if (_txCache.address === ownerAddr && _txCache.sigs === sigsKey && Date.now() - _txCache.ts < TX_CACHE_TTL) return;


      const basicResults = sigs.map((s: any) => ({
        signature: s.signature,
        slot: s.slot,
        time: s.blockTime ? s.blockTime * 1000 : null,
        status: s.err ? 'failed' : 'success',
        memo: s.memo || null,
      }));


      _txCache.address = ownerAddr;
      _txCache.sigs = sigsKey;
      _txCache.txs = basicResults;
      _txCache.ts = Date.now();
      logger.info(`TX cache: stored ${basicResults.length} basic results from signatures`);


      const rpcUrl = runtime.getRpcConfig?.()?.solana || '';
      const isPublicRpc = !rpcUrl || rpcUrl.includes('api.mainnet-beta.solana.com');


      if (isPublicRpc) {
        logger.info('Public RPC detected Ã¢â‚¬â€ skipping getParsedTransaction to avoid 429 rate limits');
        return;
      }


      let parsedTxs: any[] = new Array(txSigs.length).fill(null);
      for (let ci = 0; ci < txSigs.length; ci++) {
        if (ci > 0) await new Promise(r => setTimeout(r, 2500));
        try {
          parsedTxs[ci] = await connection.getParsedTransaction(txSigs[ci], { maxSupportedTransactionVersion: 0 });
        } catch (e: any) {
          logger.warn(`getParsedTransaction(${txSigs[ci].slice(0,8)}) failed: ${e.message}`);
        }
      }
      logger.info(`getParsedTransactions: ${parsedTxs.length} results, nulls: ${parsedTxs.filter((t: any) => !t).length}`);


      const allMints = new Set<string>();
      for (const ptx of (parsedTxs || [])) {
        if (!ptx?.meta) continue;
        for (const b of [...(ptx.meta.preTokenBalances || []), ...(ptx.meta.postTokenBalances || [])]) {
          if (b.mint && !KNOWN_TOKENS[b.mint] && !_tokenMetaCache.has(b.mint)) allMints.add(b.mint);
        }
      }

      if (allMints.size > 0) {
        const mintsArr = [...allMints];
        await fetchMetaHelius(mintsArr).catch(() => {});
        const stillUnknown = mintsArr.filter(m => !_tokenMetaCache.has(m));
        if (stillUnknown.length > 0) await fetchMetaOnChain(stillUnknown, connection).catch(() => {});
      }

      const result = sigs.map((s: any, i: number) => {
        const base: any = {
                signature: s.signature,
                slot: s.slot,
                time: s.blockTime ? s.blockTime * 1000 : null,
                status: s.err ? 'failed' : 'success',
                memo: s.memo || null,
              };

              const ptx = parsedTxs?.[i];
              if (!ptx?.meta || !ptx?.transaction) {
                logger.warn(`TX ${s.signature.slice(0,8)}: parsed data missing (ptx=${!!ptx}, meta=${!!ptx?.meta}, tx=${!!ptx?.transaction})`);
              }
              if (ptx?.meta && ptx.transaction) {

                try {
                  const preTokenBals = ptx.meta.preTokenBalances || [];
                  const postTokenBals = ptx.meta.postTokenBalances || [];
                  const accountKeys = ptx.transaction.message.accountKeys.map((k: any) =>
                    typeof k === 'string' ? k : k.pubkey?.toBase58?.() || k.pubkey?.toString?.() || String(k));

                  const tokenChanges: Array<{ mint: string; change: number; decimals: number; symbol: string | null; name: string | null; image: string | null }> = [];
                  const postMap = new Map<string, any>();
                  for (const pb of postTokenBals) postMap.set(`${pb.accountIndex}:${pb.mint}`, pb);
                  const preMap = new Map<string, any>();
                  for (const pb of preTokenBals) preMap.set(`${pb.accountIndex}:${pb.mint}`, pb);

                  const seen = new Set<string>();
                  for (const b of [...preTokenBals, ...postTokenBals]) {
                    if (b.owner !== ownerAddr) continue;
                    const key = `${b.accountIndex}:${b.mint}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const pre = preMap.get(key);
                    const post = postMap.get(key);
                    const preBal = Number(pre?.uiTokenAmount?.uiAmount || 0);
                    const postBal = Number(post?.uiTokenAmount?.uiAmount || 0);
                    const change = postBal - preBal;
                    if (Math.abs(change) < 1e-12) continue;
                    const mint = b.mint;
                    const meta = KNOWN_TOKENS[mint] || _tokenMetaCache.get(mint);
                    tokenChanges.push({
                      mint,
                      change,
                      decimals: post?.uiTokenAmount?.decimals ?? pre?.uiTokenAmount?.decimals ?? 0,
                      symbol: meta?.symbol || (mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : null),
                      name: meta?.name || null,
                      image: meta?.logoURI || null,
                    });
                  }


                  const ownerIndex = accountKeys.indexOf(ownerAddr);
                  let solDiff = 0;
                  if (ownerIndex >= 0 && ptx.meta.preBalances && ptx.meta.postBalances) {
                    solDiff = (ptx.meta.postBalances[ownerIndex] - ptx.meta.preBalances[ownerIndex]) / 1_000_000_000;

                    const threshold = tokenChanges.length > 0 ? 0.001 : 0.0005;
                    if (Math.abs(solDiff) > threshold && !tokenChanges.some(tc => tc.mint === 'So11111111111111111111111111111111111111112')) {
                      tokenChanges.push({ mint: 'native', change: solDiff, decimals: 9, symbol: 'SOL', name: 'Solana', image: null });
                    }
                  }


                  const allProgramIds = accountKeys.filter((_: any, idx: number) =>
                    ptx.transaction.message.instructions.some((ix: any) => {
                      const pIdx = ix.programIdIndex ?? -1;
                      return pIdx === idx;
                    })
                  );
                  const isDexTx = allProgramIds.some((pid: string) => DEX_PROGRAMS.has(pid))
                    || ptx.transaction.message.instructions.some((ix: any) => {
                      const pid = ix.programId?.toBase58?.() || ix.programId?.toString?.() || '';
                      return DEX_PROGRAMS.has(pid);
                    });


                  if (isDexTx && tokenChanges.length === 1 && Math.abs(solDiff) > 0.00001
                      && !tokenChanges.some(tc => tc.mint === 'native')) {
                    tokenChanges.push({ mint: 'native', change: solDiff, decimals: 9, symbol: 'SOL', name: 'Solana', image: null });
                  }

                  const decreased = tokenChanges.filter(c => c.change < 0);
                  const increased = tokenChanges.filter(c => c.change > 0);

                  if (decreased.length > 0 && increased.length > 0) {

                    const sentTc = decreased.sort((a, b) => a.change - b.change)[0];
                    const recvTc = increased.sort((a, b) => b.change - a.change)[0];
                    base.tokenTransfer = {
                      type: 'swap',
                      mint: recvTc.mint,
                      amount: Math.abs(recvTc.change),
                      decimals: recvTc.decimals,
                      symbol: recvTc.symbol,
                      name: recvTc.name,
                      image: recvTc.image,
                      direction: 'swap',
                      counterparty: '',
                      swapFrom: { symbol: sentTc.symbol, amount: Math.abs(sentTc.change) },
                      swapTo: { symbol: recvTc.symbol, amount: Math.abs(recvTc.change) },
                    };
                  } else if (isDexTx && tokenChanges.length > 0) {

                    const tc = tokenChanges.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
                    const direction = tc.change > 0 ? 'received' : 'sent';
                    base.tokenTransfer = {
                      type: 'swap',
                      mint: tc.mint === 'native' ? null : tc.mint,
                      amount: Math.abs(tc.change),
                      decimals: tc.decimals,
                      symbol: tc.symbol,
                      name: tc.name,
                      image: tc.image,
                      direction: 'swap',
                      counterparty: '',
                      swapFrom: direction === 'sent' ? { symbol: tc.symbol, amount: Math.abs(tc.change) } : { symbol: 'SOL', amount: Math.abs(solDiff) || 0 },
                      swapTo: direction === 'received' ? { symbol: tc.symbol, amount: Math.abs(tc.change) } : { symbol: 'SOL', amount: Math.abs(solDiff) || 0 },
                    };
                  } else if (tokenChanges.length > 0) {
                    const tc = tokenChanges.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
                    const direction = tc.change > 0 ? 'received' : 'sent';
                    base.tokenTransfer = {
                      type: tc.mint === 'native' ? 'sol' : 'spl',
                      mint: tc.mint === 'native' ? null : tc.mint,
                      amount: Math.abs(tc.change),
                      decimals: tc.decimals,
                      symbol: tc.symbol,
                      name: tc.name,
                      image: tc.image,
                      direction,
                      counterparty: '',
                    };

                    for (const b of [...preTokenBals, ...postTokenBals]) {
                      if (b.owner && b.owner !== ownerAddr && b.mint === tc.mint) { base.tokenTransfer.counterparty = b.owner; break; }
                    }
                  }
                } catch (e: any) {
                  logger.warn(`TX balance-diff parse error for ${s.signature.slice(0,8)}: ${e.message}`);
                }


                if (!base.tokenTransfer) {
                  try {
                    const instructions = ptx.transaction.message.instructions;
                    const innerIxs = (ptx.meta.innerInstructions || []).flatMap((ii: any) => ii.instructions || []);
                    const allIxs = [...instructions, ...innerIxs];
                    for (const ix of allIxs) {
                      const parsed = (ix as any).parsed;
                      if (!parsed) continue;
                      const prog = (ix as any).program;

                      if (prog === 'system' && parsed.type === 'transfer') {
                        const info = parsed.info;
                        const lamports = Number(info.lamports || 0);
                        const solAmt = lamports / 1_000_000_000;
                        const from = info.source || '';
                        const to = info.destination || '';
                        const direction = from === ownerAddr ? 'sent' : to === ownerAddr ? 'received' : 'unknown';
                        const counterparty = direction === 'sent' ? to : from;
                        base.tokenTransfer = {
                          type: 'sol', mint: null, amount: solAmt, decimals: 9,
                          symbol: 'SOL', name: 'Solana', image: null,
                          direction, counterparty,
                        };
                        break;
                      }

                      if (prog === 'spl-token' && (parsed.type === 'transfer' || parsed.type === 'transferChecked')) {
                        const info = parsed.info;
                        const amt = info.tokenAmount?.uiAmount ?? (info.amount ? Number(info.amount) : 0);
                        let mint = info.mint || null;

                        if (!mint) {
                          const allBals = [...(ptx.meta.preTokenBalances || []), ...(ptx.meta.postTokenBalances || [])];
                          if (allBals.length > 0) mint = allBals[0].mint;
                        }
                        const preBalances = ptx.meta.preTokenBalances || [];
                        const postBalances = ptx.meta.postTokenBalances || [];
                        let direction = 'unknown';
                        let counterparty = '';
                        for (const b of [...preBalances, ...postBalances]) {
                          if (b.owner === ownerAddr) {
                            const pre = preBalances.find((p: any) => p.accountIndex === b.accountIndex);
                            const post = postBalances.find((p: any) => p.accountIndex === b.accountIndex);
                            if (pre && post) {
                              const preBal = Number(pre.uiTokenAmount?.uiAmount || 0);
                              const postBal = Number(post.uiTokenAmount?.uiAmount || 0);
                              direction = postBal < preBal ? 'sent' : 'received';
                            }
                            break;
                          }
                        }
                        for (const b of [...preBalances, ...postBalances]) {
                          if (b.owner && b.owner !== ownerAddr) { counterparty = b.owner; break; }
                        }
                        const meta = mint ? (KNOWN_TOKENS[mint] || _tokenMetaCache.get(mint)) : null;
                        base.tokenTransfer = {
                          type: 'spl', mint, amount: amt,
                          decimals: info.tokenAmount?.decimals ?? 0,
                          symbol: meta?.symbol || (mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : null),
                          name: meta?.name || null, image: meta?.logoURI || null,
                          direction, counterparty,
                        };
                        break;
                      }
                    }
                  } catch (e: any) {
                    logger.warn(`TX instruction parse error for ${s.signature.slice(0,8)}: ${e.message}`);
                  }
                }


                if (!base.tokenTransfer) {
                  try {
                    const accountKeys = ptx.transaction.message.accountKeys.map((k: any) =>
                      typeof k === 'string' ? k : k.pubkey?.toBase58?.() || k.pubkey?.toString?.() || String(k));

                    const hasDex = ptx.transaction.message.instructions.some((ix: any) => {
                      const pid = ix.programId?.toBase58?.() || ix.programId?.toString?.() || '';
                      return DEX_PROGRAMS.has(pid);
                    });
                    const ownerIndex = accountKeys.indexOf(ownerAddr);
                    if (ownerIndex >= 0 && ptx.meta.preBalances && ptx.meta.postBalances) {
                      const solDiff = (ptx.meta.postBalances[ownerIndex] - ptx.meta.preBalances[ownerIndex]) / 1_000_000_000;
                      if (hasDex) {

                        base.tokenTransfer = {
                          type: 'swap', mint: null,
                          amount: Math.abs(solDiff), decimals: 9,
                          symbol: 'SOL', name: 'Solana', image: null,
                          direction: 'swap', counterparty: '',
                          swapFrom: solDiff < 0 ? { symbol: 'SOL', amount: Math.abs(solDiff) } : { symbol: '?', amount: 0 },
                          swapTo: solDiff > 0 ? { symbol: 'SOL', amount: Math.abs(solDiff) } : { symbol: '?', amount: 0 },
                        };
                      } else if (Math.abs(solDiff) > 0.0001) {
                        const direction = solDiff > 0 ? 'received' : 'sent';
                        base.tokenTransfer = {
                          type: 'sol', mint: null, amount: Math.abs(solDiff), decimals: 9,
                          symbol: 'SOL', name: 'Solana', image: null,
                          direction, counterparty: '',
                        };
                      }
                    }
                  } catch {}
                }
              }
              return base;
            });


            _txCache.address = ownerAddr;
            _txCache.sigs = sigsKey;
            _txCache.txs = result;
            _txCache.ts = Date.now();
          } catch (e: any) {
            logger.warn(`Background TX refresh failed: ${e.message}`);
          } finally {
            _txRefreshing = false;
          }
  }


  let _balCache = { address: '', balance: 0, ts: 0 };
  app.get('/api/wallet/balance', async (_req, res) => {
    try {
      const w = runtime.getWallet();
      if (!w.hasWallet()) return res.json({ balance: 0 });


      if (_vaultMode.active) {
        const vaultAddr = _vaultMode.vault;
        if (_balCache.address === vaultAddr && Date.now() - _balCache.ts < 5000) {
          return res.json({ balance: _balCache.balance });
        }
        const balance = await _squads.getVaultBalance(_vaultMode.multisigPda).catch(() => 0);
        _balCache = { address: vaultAddr, balance, ts: Date.now() };
        return res.json({ balance });
      }

      const addr = w.getAddress();

      if (_balCache.address === addr && Date.now() - _balCache.ts < 5000) {
        return res.json({ balance: _balCache.balance });
      }
      const balance = await w.getBalance().catch(() => 0);
      _balCache = { address: addr, balance, ts: Date.now() };
      res.json({ balance });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  startSolPriceStream();
  app.get('/api/sol-price', async (_req, res) => {
    try {
      const price = await getSolPriceReliable();
      res.json({ price });
    } catch {
      res.json({ price: getSolPriceUsd() || 0 });
    }
  });


  let _totalBalCache = { totalSol: 0, totalUsd: 0, solPrice: 0, ts: 0 };
  app.get('/api/wallet/total-balance-usd', async (_req, res) => {
    try {
      const now = Date.now();
      if (_totalBalCache.ts && now - _totalBalCache.ts < 30_000) {
        return res.json(_totalBalCache);
      }
      const w = runtime.getWallet();
      const conn = w.getConnection();
      const wallets = w.getStoredWallets().filter(sw => !sw.isBurn);


      const solPrice = await getSolPriceReliable();


      const { PublicKey } = await import('@solana/web3.js');
      const balances = await Promise.all(
        wallets.map(sw =>
          conn.getBalance(new PublicKey(sw.address))
            .then(l => l / 1_000_000_000)
            .catch(() => 0)
        )
      );
      const totalSol = balances.reduce((a, b) => a + b, 0);
      const totalUsd = totalSol * solPrice;
      _totalBalCache = { totalSol, totalUsd, solPrice, ts: now };
      res.json(_totalBalCache);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const METADATA_PROGRAM = 'metaqbxxUEg8AoQdPPc9G6DQTXK9dWjKKzszNPdTpyj';


  let _guardianKeypair: import('@solana/web3.js').Keypair | null = null;


  const _squads = new SquadsMultisig(
    runtime.getWallet().getConnection().rpcEndpoint,
    logger,
    runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null,
  );


  let _vaultMode: {
    active: boolean;
    multisigPda: string;
    vault: string;
    name: string;
    threshold: number;
    members: string[];
  } = { active: false, multisigPda: '', vault: '', name: '', threshold: 0, members: [] };


  const KNOWN_TOKENS: Record<string, { name: string; symbol: string; logoURI: string }> = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { name: 'USD Coin', symbol: 'USDC', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { name: 'USDT', symbol: 'USDT', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' },
    'So11111111111111111111111111111111111111112': { name: 'Wrapped SOL', symbol: 'WSOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { name: 'Bonk', symbol: 'BONK', logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I' },
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { name: 'Jupiter', symbol: 'JUP', logoURI: 'https://static.jup.ag/jup/icon.png' },
    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': { name: 'Jito', symbol: 'JTO', logoURI: 'https://metadata.jito.network/token/jto/icon.png' },
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { name: 'Marinade SOL', symbol: 'mSOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png' },
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { name: 'Ether (Wormhole)', symbol: 'whETH', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs/logo.png' },
    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { name: 'Pyth Network', symbol: 'PYTH', logoURI: 'https://pyth.network/token.svg' },
    'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk': { name: 'Wen', symbol: 'WEN', logoURI: 'https://shdw-drive.genesysgo.net/GwJapVHVvfM4Mw4sWszkzywncUWuxxPd6s9VuRe3YF2i/wen_logo.png' },
    'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof': { name: 'Render Token', symbol: 'RNDR', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof/logo.png' },
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': { name: 'BlazeStake SOL', symbol: 'bSOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1/logo.png' },
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { name: 'dogwifhat', symbol: 'WIF', logoURI: 'https://bafkreibk3covs5ltyqxa272uodhber6fjt3wqonpat7au3aqle6fqphm2m.ipfs.nftstorage.link' },
    'RaydiumPooL11111111111111111111111111111111': { name: 'Raydium', symbol: 'RAY', logoURI: '' },
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { name: 'Raydium', symbol: 'RAY', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png' },
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { name: 'Lido Staked SOL', symbol: 'stSOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj/logo.png' },
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE': { name: 'Orca', symbol: 'ORCA', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png' },
  };


  function parseMetaplexMeta(data: Buffer): { name: string; symbol: string; uri: string } | null {
    try {
      let offset = 1 + 32 + 32;
      const nameLen = data.readUInt32LE(offset); offset += 4;
      if (nameLen > 200) return null;
      const name = data.subarray(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
      offset += nameLen;
      const symLen = data.readUInt32LE(offset); offset += 4;
      if (symLen > 50) return null;
      const symbol = data.subarray(offset, offset + symLen).toString('utf8').replace(/\0/g, '').trim();
      offset += symLen;
      const uriLen = data.readUInt32LE(offset); offset += 4;
      if (uriLen > 500) return null;
      const uri = data.subarray(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
      return { name, symbol, uri };
    } catch { return null; }
  }


  const _tokenMetaCache = new Map<string, { name: string; symbol: string; logoURI: string }>();


  async function fetchMetaHelius(mints: string[]): Promise<void> {
    if (mints.length === 0) return;
    const rpcCfg = runtime.getRpcConfig();
    let heliusUrl = rpcCfg.helius || '';
    if (!heliusUrl && rpcCfg.solana?.includes('helius')) heliusUrl = rpcCfg.solana;
    if (!heliusUrl) { logger.warn('Helius DAS: no Helius URL configured'); return; }
    try {
      for (let i = 0; i < mints.length; i += 100) {
        const batch = mints.slice(i, i + 100);
        const resp = await fetch(heliusUrl, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'meta', method: 'getAssetBatch', params: { ids: batch } }),
          signal: AbortSignal.timeout(10000),
        });
        const data = await resp.json() as any;
        if (data.error) { logger.warn(`Helius DAS error: ${JSON.stringify(data.error)}`); }
        const assets = data?.result;
        if (Array.isArray(assets)) {
          for (const a of assets) {
            if (a?.id && a?.content?.metadata) {
              const m = a.content.metadata;
              const img = a.content?.links?.image || a.content?.files?.[0]?.cdn_uri || a.content?.files?.[0]?.uri || '';
              _tokenMetaCache.set(a.id, { name: m.name || '', symbol: m.symbol || '', logoURI: img });
            }
          }
          logger.info(`Helius DAS: resolved ${assets.filter((a: any) => a?.content?.metadata).length}/${batch.length} tokens`);
        }
      }
    } catch (e: any) {
      logger.warn(`Helius DAS failed: ${e.message}`);
    }
  }


  async function fetchMetaOnChain(mints: string[], conn: any): Promise<void> {
    if (mints.length === 0) return;
    try {
      const { PublicKey: PK } = await import('@solana/web3.js');
      const metaProg = new PK(METADATA_PROGRAM);
      const pdaKeys: any[] = [];
      const pdaMints: string[] = [];

      for (const mint of mints) {
        try {
          const seeds = [Buffer.from('metadata'), metaProg.toBuffer(), new PK(mint).toBuffer()];
          const [pda] = PK.findProgramAddressSync(seeds, metaProg);
          pdaKeys.push(pda);
          pdaMints.push(mint);
        } catch {  }
      }

      if (pdaKeys.length === 0) return;


      for (let i = 0; i < pdaKeys.length; i += 100) {
        const batch = pdaKeys.slice(i, i + 100);
        const batchMints = pdaMints.slice(i, i + 100);
        const accounts = await conn.getMultipleAccountsInfo(batch);
        for (let j = 0; j < accounts.length; j++) {
          const acc = accounts[j];
          const mint = batchMints[j];
          if (acc?.data) {
            const meta = parseMetaplexMeta(acc.data as Buffer);
            if (meta && (meta.name || meta.symbol)) {
              let image = '';

              if (meta.uri && meta.uri.startsWith('http')) {
                try {
                  const jr = await fetch(meta.uri, { signal: AbortSignal.timeout(3000) });
                  const jd = await jr.json() as any;
                  image = jd?.image || '';
                } catch {  }
              }
              _tokenMetaCache.set(mint, { name: meta.name, symbol: meta.symbol, logoURI: image });
            }
          }
        }
      }
      logger.info(`On-chain Metaplex: resolved metadata for ${mints.length} mints`);
    } catch (e: any) {
      logger.warn(`On-chain Metaplex failed: ${e.message}`);
    }
  }

  app.get('/api/wallet/tokens', async (_req, res) => {
    try {
      const w = runtime.getWallet();
      if (!w.hasWallet()) return res.json({ tokens: [], nfts: [] });
      const conn = w.getConnection();
      const owner = w.getPublicKey();
      const { PublicKey: PK } = await import('@solana/web3.js');

      let rpcErrors: string[] = [];


      const [result1, result2] = await Promise.all([
        conn.getParsedTokenAccountsByOwner(owner, { programId: new PK(TOKEN_PROGRAM) }).catch((e: any) => {
          logger.warn(`getParsedTokenAccountsByOwner(TOKEN) failed: ${e.message}`);
          rpcErrors.push(e.message);
          return { value: [] };
        }),
        conn.getParsedTokenAccountsByOwner(owner, { programId: new PK(TOKEN_2022_PROGRAM) }).catch((e: any) => {
          logger.warn(`getParsedTokenAccountsByOwner(TOKEN_2022) failed: ${e.message}`);
          rpcErrors.push(e.message);
          return { value: [] };
        }),
      ]);


      let r1 = result1, r2 = result2;
      if (rpcErrors.length >= 2) {
        logger.info('Both token fetches failed, retrying once after 1s...');
        await new Promise(r => setTimeout(r, 1000));
        rpcErrors = [];
        [r1, r2] = await Promise.all([
          conn.getParsedTokenAccountsByOwner(owner, { programId: new PK(TOKEN_PROGRAM) }).catch((e: any) => {
            logger.warn(`getParsedTokenAccountsByOwner(TOKEN) retry failed: ${e.message}`);
            rpcErrors.push(e.message);
            return { value: [] };
          }),
          conn.getParsedTokenAccountsByOwner(owner, { programId: new PK(TOKEN_2022_PROGRAM) }).catch((e: any) => {
            logger.warn(`getParsedTokenAccountsByOwner(TOKEN_2022) retry failed: ${e.message}`);
            rpcErrors.push(e.message);
            return { value: [] };
          }),
        ]);
      }

      const allAccounts = [...r1.value, ...r2.value];
      const tokens: any[] = [];
      const nfts: any[] = [];
      const needMeta: string[] = [];

      for (const item of allAccounts) {
        const info = item.account.data.parsed.info;
        const mint: string = info.mint;
        const amount = Number(info.tokenAmount.uiAmount || 0);
        const decimals: number = info.tokenAmount.decimals;
        if (amount === 0) continue;


        const meta = KNOWN_TOKENS[mint] || _tokenMetaCache.get(mint);
        const name = meta?.name || '';
        const symbol = meta?.symbol || '';
        const image = meta?.logoURI || '';

        if (decimals === 0 && amount === 1) {
          nfts.push({ mint, name, symbol, image });
        } else {
          tokens.push({ mint, amount, decimals, name, symbol, image });
        }
        if (!name && !symbol) needMeta.push(mint);
      }


      if (needMeta.length > 0) {
        logger.info(`Resolving metadata for ${needMeta.length} unknown tokens: ${needMeta.map(m => m.slice(0, 8)).join(', ')}`);


        await fetchMetaHelius(needMeta);
        const stillUnknown = needMeta.filter(m => !_tokenMetaCache.has(m));


        if (stillUnknown.length > 0) {
          await fetchMetaOnChain(stillUnknown, conn);
        }


        for (const t of [...tokens, ...nfts]) {
          if (!t.name && !t.symbol) {
            const h = _tokenMetaCache.get(t.mint);
            if (h) { t.name = h.name; t.symbol = h.symbol; t.image = h.logoURI; }
          }
        }
      }

      tokens.sort((a: any, b: any) => (a.symbol || a.mint).localeCompare(b.symbol || b.mint));
      const response: any = { tokens, nfts };
      if (rpcErrors.length > 0) {
        response.rpcError = rpcErrors[0];
        logger.warn(`Token endpoint returning with RPC errors: ${rpcErrors.join('; ')}`);
      }
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/send-token', async (req, res) => {
    try {
      const { to, mint, amount, decimals } = req.body;
      if (!to || !mint) return res.status(400).json({ error: 'to and mint are required' });
      const { PublicKey: PK, Transaction: Tx, sendAndConfirmTransaction } = await import('@solana/web3.js');
      const { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

      let toPubkey: InstanceType<typeof PK>;
      try { toPubkey = new PK(to); } catch { return res.status(400).json({ error: 'Invalid recipient address' }); }
      let mintPubkey: InstanceType<typeof PK>;
      try { mintPubkey = new PK(mint); } catch { return res.status(400).json({ error: 'Invalid mint address' }); }

      const dec = Number(decimals) || 0;
      const rawAmount = BigInt(Math.round(Number(amount) * Math.pow(10, dec)));
      if (rawAmount <= 0n) return res.status(400).json({ error: 'Invalid amount' });

      const w = runtime.getWallet();
      const fromPubkey = w.getPublicKey();
      const conn = w.getConnection();


      const payerPubkey = _guardianKeypair ? _guardianKeypair.publicKey : fromPubkey;


      const fromATA = getAssociatedTokenAddressSync(mintPubkey, fromPubkey);
      const toATA = getAssociatedTokenAddressSync(mintPubkey, toPubkey);

      const tx = new Tx();


      const toATAInfo = await conn.getAccountInfo(toATA).catch(() => null);
      if (!toATAInfo) {
        tx.add(createAssociatedTokenAccountInstruction(payerPubkey, toATA, toPubkey, mintPubkey));
      }

      tx.add(createTransferCheckedInstruction(fromATA, mintPubkey, toATA, fromPubkey, rawAmount, dec));

      let sig: string;
      if (_guardianKeypair) {
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = _guardianKeypair.publicKey;
        sig = await sendAndConfirmTransaction(conn, tx, [_guardianKeypair, w.getKeypairRaw()], { commitment: 'confirmed' });
      } else {
        sig = await w.signAndSend(tx);
      }
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/wallet/token-meta/:mint', async (req, res) => {
    const mint = req.params.mint;
    const results: Record<string, any> = { mint, layers: {} };


    results.layers.builtin = KNOWN_TOKENS[mint] || null;


    results.layers.cache = _tokenMetaCache.get(mint) || null;


    try {
      const rpcCfg = runtime.getRpcConfig();
      let heliusUrl = rpcCfg.helius || '';
      if (!heliusUrl && rpcCfg.solana?.includes('helius')) heliusUrl = rpcCfg.solana;
      results.layers.helius_url = heliusUrl ? heliusUrl.replace(/api-key=[^&]+/, 'api-key=***') : 'not configured';
      if (heliusUrl) {
        const r = await fetch(heliusUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'getAssetBatch', params: { ids: [mint] } }),
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json() as any;
        results.layers.helius_raw = d;
      }
    } catch (e: any) { results.layers.helius_error = e.message; }


    try {
      const { PublicKey: PK } = await import('@solana/web3.js');
      const metaProg = new PK(METADATA_PROGRAM);
      const seeds = [Buffer.from('metadata'), metaProg.toBuffer(), new PK(mint).toBuffer()];
      const [pda] = PK.findProgramAddressSync(seeds, metaProg);
      results.layers.metaplex_pda = pda.toBase58();
      const conn = runtime.getWallet().getConnection();
      const acc = await conn.getAccountInfo(pda);
      if (acc?.data) {
        const meta = parseMetaplexMeta(acc.data as Buffer);
        results.layers.metaplex_parsed = meta;
      } else {
        results.layers.metaplex_parsed = null;
      }
    } catch (e: any) { results.layers.metaplex_error = e.message; }

    res.json(results);
  });

  app.get('/api/wallet/export', (_req, res) => {
    try {
      const pk = runtime.getWallet().exportPrivateKey();
      res.json({ privateKey: pk });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/wallet/qr', async (req, res) => {
    try {
      const address = runtime.getWallet().getAddress();
      if (!address) return res.status(400).json({ error: 'No wallet loaded' });
      const dataUrl = await QRCode.toDataURL(address, { width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
      res.json({ qr: dataUrl, address });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/wallet/import', (req, res) => {
    try {
      const { privateKey, name, isBurn } = req.body;
      if (!privateKey || typeof privateKey !== 'string') {
        return res.status(400).json({ error: 'privateKey is required' });
      }
      runtime.getWallet().importFromKey(privateKey.trim(), name || undefined, isBurn || undefined);
      broadcastWalletChanged();
      res.json({ address: runtime.getWallet().getAddress() });
    } catch (err: any) {
      res.status(400).json({ error: 'Invalid private key: ' + err.message });
    }
  });

  app.post('/api/wallet/recover-seed', (req, res) => {
    try {
      const { mnemonic, name } = req.body;
      if (!mnemonic || typeof mnemonic !== 'string') {
        return res.status(400).json({ error: 'mnemonic is required' });
      }
      runtime.getWallet().importFromSeed(mnemonic.trim(), name || undefined);
      broadcastWalletChanged();
      res.json({ address: runtime.getWallet().getAddress() });
    } catch (err: any) {
      res.status(400).json({ error: 'Seed recovery failed: ' + err.message });
    }
  });

  app.post('/api/wallet/generate', (req, res) => {
    try {
      const { name, prefix, isBurn } = req.body || {};
      const result = runtime.getWallet().generateNew(name || undefined, prefix || undefined, !!isBurn || undefined);
      broadcastWalletChanged();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/guardian', async (req, res) => {
    try {
      const { enabled, privateKey } = req.body;
      if (!enabled) {
        _guardianKeypair = null;
        logger.info('Guardian wallet disabled');
        return res.json({ enabled: false });
      }
      if (!privateKey || typeof privateKey !== 'string') {
        return res.status(400).json({ error: 'privateKey is required' });
      }
      const { Keypair } = await import('@solana/web3.js');
      const bs58m = await import('bs58');
      let kp: InstanceType<typeof Keypair>;
      try {
        kp = Keypair.fromSecretKey(bs58m.default.decode(privateKey.trim()));
      } catch {
        return res.status(400).json({ error: 'Invalid private key' });
      }
      _guardianKeypair = kp;
      logger.info(`Guardian wallet set: ${kp.publicKey.toBase58()}`);
      res.json({ enabled: true, address: kp.publicKey.toBase58() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/multisig/list', (_req, res) => {
    res.json({ multisigs: _squads.getStoredMultisigs() });
  });


  app.post('/api/multisig/check-members', (req, res) => {
    try {
      const { members } = req.body;
      if (!Array.isArray(members)) return res.status(400).json({ error: 'members must be an array' });
      const activeAddr = runtime.getWallet().hasWallet() ? runtime.getWallet().getAddress() : '';
      const allMemberKeys = Array.from(new Set([activeAddr, ...members].filter(Boolean)));
      const check = _squads.checkMembers(allMemberKeys);

      const balance = runtime.getWallet().hasWallet() ? -1 : 0;
      res.json({
        ...check,
        feePayer: activeAddr,
        totalMembers: allMemberKeys.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/create', async (req, res) => {
    try {
      const { name, members, threshold, confirmed } = req.body;
      if (!name || !threshold || !Array.isArray(members)) {
        return res.status(400).json({ error: 'name, members (array), and threshold are required' });
      }
      if (typeof threshold !== 'number' || threshold < 1) {
        return res.status(400).json({ error: 'threshold must be a positive integer' });
      }

      const activeAddr = runtime.getWallet().hasWallet() ? runtime.getWallet().getAddress() : '';
      const allKeys = Array.from(new Set([activeAddr, ...members].filter(Boolean)));
      const check = _squads.checkMembers(allKeys);
      if (check.allLocal && allKeys.length > 1 && !confirmed) {
        return res.status(200).json({
          warning: true,
          message: 'All member keys are imported in this wallet. This means a single device controls the entire vault Ã¢â‚¬â€ reduced security compared to using external signers. Continue anyway?',
          local: check.local,
          external: check.external,
          feePayer: activeAddr,
        });
      }
      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const result = await _squads.createMultisig(name, members, threshold);
      res.json({ ...result, autoApprove: check.allLocal });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/import', async (req, res) => {
    try {
      const { multisigPda, name } = req.body;
      if (!multisigPda || !name) return res.status(400).json({ error: 'multisigPda and name are required' });
      const result = await _squads.importMultisig(multisigPda, name);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/multisig/:multisigPda/info', async (req, res) => {
    try {
      const info = await _squads.getMultisigInfo(req.params.multisigPda);
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/multisig/:multisigPda/proposals', async (req, res) => {
    try {
      const proposals = await _squads.listProposals(req.params.multisigPda);
      res.json({ proposals });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/:multisigPda/propose-transfer', async (req, res) => {
    try {
      const { to, amountSol, memo } = req.body;
      if (!to || !amountSol) return res.status(400).json({ error: 'to and amountSol are required' });
      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const result = await _squads.proposeTransfer(req.params.multisigPda, to, Number(amountSol), memo);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/:multisigPda/approve/:txIndex', async (req, res) => {
    try {
      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const sig = await _squads.approveProposal(req.params.multisigPda, Number(req.params.txIndex));
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/:multisigPda/reject/:txIndex', async (req, res) => {
    try {
      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const sig = await _squads.rejectProposal(req.params.multisigPda, Number(req.params.txIndex));
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/multisig/:multisigPda/execute/:txIndex', async (req, res) => {
    try {
      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const sig = await _squads.executeProposal(req.params.multisigPda, Number(req.params.txIndex));
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.delete('/api/multisig/:multisigPda', (req, res) => {
    const removed = _squads.removeFromStore(req.params.multisigPda);
    res.json({ removed });
  });


  app.post('/api/vault-mode/activate', async (req, res) => {
    try {
      const { multisigPda } = req.body;
      if (!multisigPda) return res.status(400).json({ error: 'multisigPda is required' });


      const keyInfo = _squads.getLocalKeyCount(multisigPda);
      if (keyInfo.localKeys < keyInfo.threshold) {
        return res.status(400).json({
          error: `Not enough local keys. Need ${keyInfo.threshold} but only have ${keyInfo.localKeys}. Use proposal workflow instead.`,
        });
      }

      const info = await _squads.getMultisigInfo(multisigPda);
      _vaultMode = {
        active: true,
        multisigPda,
        vault: info.vault,
        name: info.name,
        threshold: info.threshold,
        members: info.members,
      };

      _walletResCache = { data: null, ts: 0 };
      _balCache = { address: '', balance: 0, ts: 0 };
      broadcastWalletChanged();
      logger.info(`[Vault Mode] Activated: ${info.name} (${info.vault})`);
      res.json({ ok: true, vault: info.vault, name: info.name, threshold: info.threshold, localKeys: keyInfo.localKeys });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/vault-mode/deactivate', (_req, res) => {
    _vaultMode = { active: false, multisigPda: '', vault: '', name: '', threshold: 0, members: [] };
    _walletResCache = { data: null, ts: 0 };
    _balCache = { address: '', balance: 0, ts: 0 };
    broadcastWalletChanged();
    logger.info('[Vault Mode] Deactivated Ã¢â‚¬â€ back to regular wallet');
    res.json({ ok: true });
  });


  app.get('/api/vault-mode/status', (_req, res) => {
    res.json(_vaultMode);
  });


  app.post('/api/vault-mode/send', async (req, res) => {
    try {
      if (!_vaultMode.active) return res.status(400).json({ error: 'Vault mode is not active' });
      const { to, amount, memo } = req.body;
      if (!to || !amount) return res.status(400).json({ error: 'to and amount are required' });
      const amountSol = Number(amount);
      if (isNaN(amountSol) || amountSol <= 0) return res.status(400).json({ error: 'Invalid amount' });
      try { new (await import('@solana/web3.js')).PublicKey(to); } catch { return res.status(400).json({ error: 'Invalid address' }); }

      _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
      const result = await _squads.smartSendFromVault(_vaultMode.multisigPda, to, amountSol, memo);
      _balCache = { address: '', balance: 0, ts: 0 };
      _walletResCache = { data: null, ts: 0 };
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/wallet/withdraw', async (req, res) => {
    try {
      const { to, amount } = req.body;
      if (!to || !amount) return res.status(400).json({ error: 'to and amount are required' });


      if (_vaultMode.active) {
        const amountSol = Number(amount);
        if (isNaN(amountSol) || amountSol <= 0) return res.status(400).json({ error: 'Invalid amount' });
        try { new (await import('@solana/web3.js')).PublicKey(to); } catch { return res.status(400).json({ error: 'Invalid address' }); }
        _squads.setKeypair(runtime.getWallet().hasWallet() ? runtime.getWallet().getKeypairRaw() : null);
        const result = await _squads.smartSendFromVault(_vaultMode.multisigPda, to, amountSol);
        _balCache = { address: '', balance: 0, ts: 0 };
        _walletResCache = { data: null, ts: 0 };
        if (result.status === 'executed') {
          return res.json({ signature: result.signature });
        }
        return res.json({ pending: true, txIndex: result.txIndex, approvalsHave: result.approvalsHave, approvalsNeeded: result.approvalsNeeded });
      }

      const { PublicKey: PK, SystemProgram, Transaction: Tx, sendAndConfirmTransaction } = await import('@solana/web3.js');
      let lamports = Math.round(Number(amount) * 1_000_000_000);
      if (lamports <= 0) return res.status(400).json({ error: 'Invalid amount' });
      let toPubkey: InstanceType<typeof PK>;
      try { toPubkey = new PK(to); } catch { return res.status(400).json({ error: 'Invalid address' }); }
      const w = runtime.getWallet();


      const conn = w.getConnection();
      const currentBalance = await conn.getBalance(w.getPublicKey());
      const txFee = 5000;
      if (lamports + txFee > currentBalance) {
        lamports = Math.max(0, currentBalance - txFee);
        if (lamports <= 0) return res.status(400).json({ error: 'Insufficient balance to cover transaction fee' });
      }

      const tx = new Tx().add(SystemProgram.transfer({
        fromPubkey: w.getPublicKey(),
        toPubkey,
        lamports
      }));

      let sig: string;
      if (_guardianKeypair) {

        const conn = w.getConnection();
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = _guardianKeypair.publicKey;
        sig = await sendAndConfirmTransaction(conn, tx, [_guardianKeypair, w.getKeypairRaw()], { commitment: 'confirmed' });
      } else {
        sig = await w.signAndSend(tx);
      }
      res.json({ signature: sig });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  const HOUDINI_API = 'https://api-partner.houdiniswap.com';

  function _houdiniAuth(): Record<string, string> {
    const key = process.env.HOUDINI_API_KEY || '';
    const secret = process.env.HOUDINI_API_SECRET || '';
    return {
      'Authorization': `${key}:${secret}`,
      'Content-Type': 'application/json',
    };
  }

  function _houdiniUserInfo(req: any) {
    return {
      ip: (req.headers['x-forwarded-for'] as string || req.ip || '127.0.0.1').split(',')[0].trim(),
      userAgent: req.headers['user-agent'] || 'WhiteOwl/1.0',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    };
  }


  function _houdiniConfigured(): boolean {
    return !!(process.env.HOUDINI_API_KEY && process.env.HOUDINI_API_SECRET);
  }


  app.get('/api/wallet/private-send/tokens', async (_req, res) => {
    try {
      if (!_houdiniConfigured()) return res.status(400).json({ error: 'Houdini not configured' });
      const resp = await fetch(`${HOUDINI_API}/tokens`, { headers: _houdiniAuth() });
      const text = await resp.text();
      let data: any;
      try { data = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON', raw: text.slice(0, 500) }); }
      if (!resp.ok) return res.status(resp.status).json(data);

      const solTokens = (Array.isArray(data) ? data : []).filter((t: any) =>
        (t.id || '').toLowerCase().includes('sol') ||
        (t.symbol || '').toLowerCase().includes('sol') ||
        (t.name || '').toLowerCase().includes('solana') ||
        (t.network?.shortName || '').toLowerCase().includes('sol')
      );
      res.json({ total: data.length, solTokens, allIds: data.map((t: any) => t.id).slice(0, 50) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  app.get('/api/wallet/private-send/quote', async (req, res) => {
    try {
      if (!_houdiniConfigured()) {
        return res.status(400).json({ error: 'Houdini API keys not configured. Add HOUDINI_API_KEY and HOUDINI_API_SECRET.' });
      }
      const amount = String(req.query.amount || '');
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.status(400).json({ error: 'Valid amount required' });
      }
      const url = `${HOUDINI_API}/quote?from=SOL&to=SOL&amount=${encodeURIComponent(amount)}&anonymous=true`;
      const resp = await fetch(url, { method: 'GET', headers: _houdiniAuth() });
      const text = await resp.text();
      let data: any;
      try { data = JSON.parse(text); } catch {
        logger.warn(`Houdini quote non-JSON (${resp.status}): ${text.slice(0, 200)}`);

        if (resp.status === 500) {
          return res.status(400).json({ error: `Amount too small for Houdini private route. Try at least 0.5 SOL.` });
        }
        return res.status(502).json({ error: `Houdini returned non-JSON response (HTTP ${resp.status}). Check API keys.` });
      }
      if (!resp.ok) {
        return res.status(resp.status).json({ error: data?.message || data?.error || 'Houdini quote failed' });
      }

      const fee = Number(data.amountIn || amount) - Number(data.amountOut || 0);
      res.json({
        sendAmount: data.amountIn || amount,
        receiveAmount: data.amountOut,
        fee: fee > 0 ? fee.toFixed(6) : null,
        serviceFee: fee > 0 ? fee.toFixed(6) : null,
        min: data.min,
        max: data.max,
        estimatedTime: data.duration ? `~${data.duration} min` : '2-5 min',
      });
    } catch (err: any) {
      logger.warn(`Houdini quote error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/private-send', async (req, res) => {
    try {
      if (!_houdiniConfigured()) {
        return res.status(400).json({ error: 'Houdini API keys not configured. Add HOUDINI_API_KEY and HOUDINI_API_SECRET.' });
      }
      const { to, amount } = req.body;
      if (!to || !amount) return res.status(400).json({ error: 'to and amount are required' });
      const { PublicKey: PK, SystemProgram, Transaction: Tx, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = await import('@solana/web3.js');

      try { new PK(to); } catch { return res.status(400).json({ error: 'Invalid recipient address' }); }


      const w = runtime.getWallet();
      const conn = w.getConnection();
      const balanceLamports = await conn.getBalance(w.getPublicKey());
      const needed = Math.round(Number(amount) * LAMPORTS_PER_SOL);
      const feePadding = 10_000;
      if (balanceLamports < needed + feePadding) {
        const have = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
        return res.status(400).json({ error: `Insufficient balance: you have ${have} SOL but need ${amount} SOL (+ fee) for this private send.` });
      }


      const userInfo = _houdiniUserInfo(req);
      const exchangeBody: Record<string, any> = {
        amount: Number(amount),
        from: 'SOL',
        to: 'SOL',
        receiverTag: '',
        addressTo: to,
        anonymous: true,
        ip: userInfo.ip,
        userAgent: userInfo.userAgent,
        timezone: userInfo.timezone,
        useXmr: false,
      };

      logger.info(`Creating Houdini exchange: ${amount} SOL Ã¢â€ â€™ ${to}`);

            const exResp = await fetch(`${HOUDINI_API}/exchange`, {
                method: 'POST',
        headers: _houdiniAuth(),
        body: JSON.stringify(exchangeBody),
      });
      const exText = await exResp.text();
      let exData: any;
      try { exData = JSON.parse(exText); } catch {
        logger.warn(`Houdini exchange non-JSON (${exResp.status}): ${exText.slice(0, 300)}`);
        if (exResp.status === 500) {
          return res.status(400).json({ error: `Houdini cannot route this amount. Try at least 0.5 SOL for private sends.` });
        }
        return res.status(502).json({ error: `Houdini returned non-JSON response (HTTP ${exResp.status}). Check API keys.` });
      }
      if (!exResp.ok) {
        logger.warn(`Houdini exchange error (${exResp.status}): ${JSON.stringify(exData)}`);
        return res.status(exResp.status).json({ error: exData?.message || exData?.error || 'Failed to create Houdini exchange' });
      }


      const houdiniId = exData.houdiniId;
      const senderAddress = exData.senderAddress;
      const depositAmount = Number(exData.inAmount || amount);

      if (!senderAddress) {
        logger.warn(`Houdini response missing senderAddress: ${JSON.stringify(exData).slice(0, 500)}`);
        return res.status(500).json({ error: 'Houdini did not return a deposit address (senderAddress)' });
      }

      logger.info(`Houdini exchange ${houdiniId} created Ã¢â‚¬â€ deposit ${depositAmount} SOL to ${senderAddress} (ETA: ${exData.eta || '?'} min)`);


      const lamports = Math.round(depositAmount * LAMPORTS_PER_SOL);
      let depositPubkey: InstanceType<typeof PK>;
      try { depositPubkey = new PK(senderAddress); } catch { return res.status(500).json({ error: 'Invalid Houdini deposit address: ' + senderAddress }); }

      const tx = new Tx().add(SystemProgram.transfer({
        fromPubkey: w.getPublicKey(),
        toPubkey: depositPubkey,
        lamports,
      }));

      let sig: string;
      if (_guardianKeypair) {
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = _guardianKeypair.publicKey;
        sig = await sendAndConfirmTransaction(conn, tx, [_guardianKeypair, w.getKeypairRaw()], { commitment: 'confirmed' });
      } else {
        sig = await w.signAndSend(tx);
      }
      logger.info(`Houdini deposit sent: ${sig} (${depositAmount} SOL Ã¢â€ â€™ ${senderAddress})`);


      res.json({
        exchangeId: houdiniId,
        depositTx: sig,
        depositAddress: senderAddress,
        depositAmount,
        outAmount: exData.outAmount,
        eta: exData.eta,
        status: 'deposited',
      });
    } catch (err: any) {
      logger.warn(`Private send error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/wallet/private-send/status/:id', async (req, res) => {
    try {
      if (!_houdiniConfigured()) {
        return res.status(400).json({ error: 'Houdini API not configured' });
      }
      const id = req.params.id;
            const resp = await fetch(`${HOUDINI_API}/status?id=${encodeURIComponent(id)}`, {
                method: 'GET',
        headers: _houdiniAuth(),
      });
      const text = await resp.text();
      let data: any;
      try { data = JSON.parse(text); } catch {
        logger.warn(`Houdini status non-JSON (${resp.status}): ${text.slice(0, 200)}`);
        return res.status(502).json({ error: `Houdini returned non-JSON response (HTTP ${resp.status})` });
      }
      if (!resp.ok) {
        return res.status(resp.status).json({ error: data?.message || data?.error || 'Status check failed' });
      }

      const statusMap: Record<number, string> = { 0: 'waiting', 1: 'confirming', 2: 'exchanging', 3: 'sending', 4: 'finished', 5: 'failed' };
      const statusNum = typeof data.status === 'number' ? data.status : -1;
      const statusStr = statusMap[statusNum] || String(data.status || 'unknown');
      res.json({
        id: data.houdiniId || id,
        status: statusStr,
        receiveTx: data.outHash || data.payoutHash || null,
        receiveAmount: data.outAmount || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


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


  app.post('/api/wallet/switch', (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const ok = runtime.getWallet().switchToWallet(address);
      if (!ok) return res.status(404).json({ error: 'Wallet not found in storage' });

      _walletResCache = { data: null, ts: 0 };
      _balCache = { address: '', balance: 0, ts: 0 };
      _txCache.address = '';
      broadcastWalletChanged();
      res.json({ address: runtime.getWallet().getAddress() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/delete', (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const ok = runtime.getWallet().removeFromStore(address);
      if (!ok) return res.status(404).json({ error: 'Wallet not found' });

      _walletResCache = { data: null, ts: 0 };
      _balCache = { address: '', balance: 0, ts: 0 };
      _txCache.address = '';
      broadcastWalletChanged();
      res.json({ ok: true, hasWallet: runtime.getWallet().hasWallet() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/rename', (req, res) => {
    try {
      const { address, name } = req.body;
      if (!address || !name) return res.status(400).json({ error: 'address and name are required' });
      const ok = runtime.getWallet().renameInStore(address, name.toString().trim().slice(0, 32));
      if (!ok) return res.status(404).json({ error: 'Wallet not found' });
      broadcastWalletChanged();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/provider-sign', async (req, res) => {
    try {
      const { action, transaction, message, options } = req.body;
      const w = runtime.getWallet();
      if (!w.hasWallet()) return res.status(400).json({ error: 'No wallet configured' });

      if (action === 'signMessage') {

        const msgBytes = new Uint8Array(message);
        const nacl = await import('tweetnacl');
        const sign = (nacl as any).default?.sign || (nacl as any).sign;
        const kp = w.getKeypairRaw();
        const sig = sign.detached(msgBytes, kp.secretKey);
        return res.json({ signature: Array.from(sig) });
      }

      if (action === 'signTransaction' || action === 'signAndSendTransaction') {
        if (!transaction) return res.status(400).json({ error: 'No transaction data' });
        const { VersionedTransaction } = await import('@solana/web3.js');
        const txBuf = Buffer.from(transaction);
        const vtx = VersionedTransaction.deserialize(txBuf);
        const kp = w.getKeypairRaw();
        vtx.sign([kp]);

        if (action === 'signAndSendTransaction') {
          const conn = w.getConnection();
          const raw = vtx.serialize();
          const sig = await conn.sendRawTransaction(raw, {
            skipPreflight: true,
            maxRetries: 3,
          });

          logger.info(`Provider signAndSend: ${sig}`);
          res.json({ signature: sig });

          conn.confirmTransaction(sig, 'confirmed')
            .then(() => logger.info(`Provider tx confirmed: ${sig}`))
            .catch((e: any) => logger.warn(`Provider tx confirm timeout (tx may still succeed): ${sig} Ã¢â‚¬â€ ${e.message}`));
          return;
        } else {

          const signed = vtx.serialize();
          return res.json({ signedTransaction: Array.from(signed) });
        }
      }

      res.status(400).json({ error: 'Unknown action: ' + action });
    } catch (err: any) {
      logger.error('Provider sign error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  let _jupBuildId = 'yqvnh2-DLC-IIvsPkr3Rp';
  const _jupVerifiedCache = new Map<string, boolean>();
  const _jupVerifiedCacheTs = new Map<string, number>();
  const JUP_VRFD_CACHE_TTL = 24 * 60 * 60 * 1000;

async function refreshJupBuildId(): Promise<string | null> {
    try {

            const resp = await fetch('https://jup.ag/swap/SOL-USDC', {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!resp.ok) return null;
      const html = await resp.text();

      const m = html.match(/_next\/static\/([A-Za-z0-9_-]+)\/_(?:buildManifest|ssgManifest)/);
      if (m) { _jupBuildId = m[1]; return m[1]; }
      const m2 = html.match(/"buildId"\s*:\s*"([^"]+)"/);
      if (m2) { _jupBuildId = m2[1]; return m2[1]; }
    } catch {}
    return null;
  }

async function checkJupiterVerified(mint: string): Promise<boolean> {

    const cachedTs = _jupVerifiedCacheTs.get(mint);
    if (cachedTs && Date.now() - cachedTs < JUP_VRFD_CACHE_TTL) {
      return _jupVerifiedCache.get(mint) || false;
    }
    try {
      const url = `https://jup.ag/_next/data/${_jupBuildId}/tokens/${encodeURIComponent(mint)}.json?tokenId=${encodeURIComponent(mint)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (resp.status === 404) {

        const newId = await refreshJupBuildId();
        if (newId) {
          const url2 = `https://jup.ag/_next/data/${newId}/tokens/${encodeURIComponent(mint)}.json?tokenId=${encodeURIComponent(mint)}`;
          const resp2 = await fetch(url2, { signal: AbortSignal.timeout(4000) });
          if (resp2.ok) {
            const d = await resp2.json() as any;
            const tokenData = d?.pageProps?.dehydratedState?.queries?.[0]?.state?.data;
            const verified = !!(tokenData && tokenData.isVerified);
            _jupVerifiedCache.set(mint, verified);
            _jupVerifiedCacheTs.set(mint, Date.now());
            return verified;
          }
        }
        _jupVerifiedCache.set(mint, false);
        _jupVerifiedCacheTs.set(mint, Date.now());
        return false;
      }
      if (!resp.ok) return false;
      const d = await resp.json() as any;
      const tokenData = d?.pageProps?.dehydratedState?.queries?.[0]?.state?.data;
      const verified = !!(tokenData && tokenData.isVerified);
      _jupVerifiedCache.set(mint, verified);
      _jupVerifiedCacheTs.set(mint, Date.now());
      return verified;
    } catch {
      return _jupVerifiedCache.get(mint) || false;
    }
  }

async function batchCheckJupiterVerified(mints: string[]): Promise<void> {
    const now = Date.now();
    const toCheck = mints.filter(m => {
      const ts = _jupVerifiedCacheTs.get(m);
      return !ts || (now - ts > JUP_VRFD_CACHE_TTL);
    });
    if (toCheck.length === 0) return;

    for (let i = 0; i < toCheck.length; i += 6) {
      const batch = toCheck.slice(i, i + 6);
      await Promise.all(batch.map(m => checkJupiterVerified(m)));
    }
  }

  function isJupiterVerified(mint: string): boolean {
    return _jupVerifiedCache.get(mint) === true;
  }


  app.get('/api/token/search', async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (!q) return res.json({ tokens: [] });

      const isAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
      const results: any[] = [];

      if (isAddress) {

        const known = KNOWN_TOKENS[q];
        const cached = _tokenMetaCache.get(q);
        const meta = known || cached;
        if (meta) {
          results.push({
            address: q,
            symbol: meta.symbol || '???',
            name: meta.name || 'Unknown',
            logoURI: meta.logoURI || '',
            decimals: (meta as any).decimals ?? 9,
            daily_volume: 0,
          });
        } else {

          await fetchMetaHelius([q]).catch(() => {});
          if (!_tokenMetaCache.get(q)) {
            try { await fetchMetaOnChain([q], runtime.getWallet().getConnection()); } catch {}
          }
          const resolved = _tokenMetaCache.get(q);
          if (resolved) {
            results.push({
              address: q,
              symbol: resolved.symbol || '???',
              name: resolved.name || 'Unknown',
              logoURI: resolved.logoURI || '',
              decimals: 9,
              daily_volume: 0,
            });
          } else {

            let found = false;
            try {
                            const gmResp = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${q}`, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
                signal: AbortSignal.timeout(6000),
              });
              if (gmResp.ok) {
                const gmJson = await gmResp.json() as any;
                const t = gmJson?.data?.token;
                if (t) {
                  found = true;
                  results.push({
                    address: q,
                    symbol: t.symbol || '???',
                    name: t.name || 'Unknown',
                    logoURI: t.logo || '',
                    decimals: 9,
                    daily_volume: t.volume_24h || 0,
                    price: t.price ?? undefined,
                    liquidity: t.liquidity || 0,
                  });
                  _tokenMetaCache.set(q, { symbol: t.symbol, name: t.name, logoURI: t.logo || '' });
                }
              }
            } catch {}
            if (!found) {
              results.push({
                address: q, symbol: q.slice(0, 4) + 'Ã¢â‚¬Â¦', name: 'Unknown Token',
                logoURI: '', decimals: 9, verified: false, daily_volume: 0,
              });
            }
          }
        }
      } else {

        const ql = q.toLowerCase();

        for (const [addr, m] of Object.entries(KNOWN_TOKENS)) {
          if (m.symbol.toLowerCase().includes(ql) || m.name.toLowerCase().includes(ql)) {
            results.push({
              address: addr, symbol: m.symbol, name: m.name,
              logoURI: m.logoURI || '', decimals: 9, daily_volume: 0,
            });
          }
        }

        try {
                    const gmResp = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/search?q=${encodeURIComponent(q)}&chain=sol`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
            signal: AbortSignal.timeout(6000),
          });
          if (gmResp.ok) {
            const gmData = await gmResp.json() as any;
            const tokens = gmData?.data?.tokens || gmData?.data?.pairs || [];
            const seen = new Set(results.map(r => r.address));
            for (const t of tokens) {
              const addr = t.address || t.base_address;
              if (!addr || seen.has(addr)) continue;
              seen.add(addr);
              results.push({
                address: addr,
                symbol: t.symbol || '???',
                name: t.name || '',
                logoURI: t.logo || '',
                decimals: 9,
                daily_volume: t.volume_24h || 0,
                price: t.price ?? undefined,
                liquidity: t.liquidity || 0,
              });
            }
          }
        } catch {}
      }


      const allMints = results.map(r => r.address).filter(Boolean);
      await batchCheckJupiterVerified(allMints);
      for (const r of results) {
        r.verified = isJupiterVerified(r.address);
      }


      results.sort((a, b) => {
        if (a.verified !== b.verified) return a.verified ? -1 : 1;
        return (b.daily_volume || 0) - (a.daily_volume || 0);
      });

      res.json({ tokens: results.slice(0, 30) });
    } catch (err: any) {
      logger.error('Token search error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/token/info/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid mint address' });
      }

      await batchCheckJupiterVerified([mint]);
      const result: any = { address: mint, verified: isJupiterVerified(mint) };


      {
        const known = KNOWN_TOKENS[mint] || _tokenMetaCache.get(mint);
        if (known) {
          result.symbol = known.symbol;
          result.name = known.name;
          result.logoURI = known.logoURI || '';
          result.decimals = (known as any).decimals ?? 9;
        } else {
          await fetchMetaHelius([mint]).catch(() => {});
          const cached = _tokenMetaCache.get(mint);
          if (cached) {
            result.symbol = cached.symbol;
            result.name = cached.name;
            result.logoURI = cached.logoURI || '';
          }
        }
      }


      try {
                const gmResp = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${mint}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
          signal: AbortSignal.timeout(6000),
        });
        if (gmResp.ok) {
          const gmJson = await gmResp.json() as any;
          const t = gmJson?.data?.token;
          if (t) {
            if (t.price) result.price = t.price;
            result.daily_volume = t.volume_24h || 0;
            result.liquidity = t.liquidity || 0;
            result.priceChange24h = t.price_change_percent?.h24 || 0;
            result.fdv = t.fdv || t.market_cap || 0;
            result.marketCap = t.market_cap || 0;
            result.pairAddress = t.pool_address || '';
            result.dexId = t.launchpad || 'raydium';

            if (!result.symbol && t.symbol) result.symbol = t.symbol;
            if (!result.name && t.name) result.name = t.name;
            if (!result.logoURI && t.logo) result.logoURI = t.logo;
          }
        }
      } catch {}

      try {
        const qResp = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${encodeURIComponent(mint)}&amount=1000000000&slippageBps=50`, { signal: AbortSignal.timeout(6000) });
        if (qResp.ok) {
          const qd = await qResp.json() as any;
          result.swappable = true;
          result.routePlan = (qd.routePlan || []).map((r: any) => ({
            amm: r.swapInfo?.label || 'Unknown',
            inputMint: r.swapInfo?.inputMint,
            outputMint: r.swapInfo?.outputMint,
            feeAmount: r.swapInfo?.feeAmount,
            feeMint: r.swapInfo?.feeMint,
          }));
          result.priceImpactPct = qd.priceImpactPct;

          if (!result.price && qd.outAmount) {
            const outDec = result.decimals || 9;
            const tokensPerSol = Number(qd.outAmount) / Math.pow(10, outDec);

          }
        } else {
          result.swappable = false;
        }
      } catch {
        result.swappable = false;
      }

      res.json(result);
    } catch (err: any) {
      logger.error('Token info error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/token/holders/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid mint address' });
      }

      const rpcUrl = runtime.getRpcConfig?.()?.helius || runtime.getRpcConfig?.()?.solana || 'https://api.mainnet-beta.solana.com';


      const rpcRes = await fetch(rpcUrl, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint] }),
        signal: AbortSignal.timeout(10000),
      });
      if (!rpcRes.ok) return res.status(502).json({ error: 'RPC request failed' });
      const rpcData = await rpcRes.json() as any;
      const accounts = rpcData?.result?.value;
      if (!Array.isArray(accounts) || accounts.length === 0) {
        return res.json({ mint, holders: [], top10Pct: 0 });
      }


      const supplyRes = await fetch(rpcUrl, {
                method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
        signal: AbortSignal.timeout(8000),
      });
      let totalSupply = 0;
      if (supplyRes.ok) {
        const supplyData = await supplyRes.json() as any;
        totalSupply = Number(supplyData?.result?.value?.uiAmount || 0);
      }

      const top10 = accounts.slice(0, 10).map((acc: any) => {
        const uiAmount = acc.uiAmount ?? (Number(acc.amount) / Math.pow(10, acc.decimals || 9));
        return {
          address: acc.address,
          amount: uiAmount,
          pct: totalSupply > 0 ? Number(((uiAmount / totalSupply) * 100).toFixed(2)) : 0,
        };
      });

      const top10Pct = top10.reduce((s: number, h: any) => s + h.pct, 0);

      res.json({ mint, holders: top10, top10Pct: Number(top10Pct.toFixed(2)), totalSupply });
    } catch (err: any) {
      logger.error('Token holders error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  const _insightxClient = (() => {
    const key = process.env.INSIGHTX_API_KEY || '';
    return key ? new InsightXClient(key, logger) : null;
  })();

  const _getRpcAnalyzer = () => {
    const rpcUrl = runtime.getRpcConfig?.()?.helius || runtime.getRpcConfig?.()?.solana || 'https://api.mainnet-beta.solana.com';
    return new RpcHolderAnalyzer(rpcUrl, logger);
  };

  app.get('/api/insightx/analyze/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      if (_insightxClient) {
        const result = await _insightxClient.fullAnalysis(mint);
        res.json(result);
      } else {
        const result = await _getRpcAnalyzer().fullAnalysis(mint);
        res.json(result);
      }
    } catch (err: any) {
      logger.error('InsightX analyze error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/clusters/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      if (_insightxClient) {
        const result = await _insightxClient.getClusters(mint);
        res.json(result || { total_cluster_pct: 0, clusters: [] });
      } else {
        const rpc = _getRpcAnalyzer();
        const holders = await rpc.getHolders(mint);
        res.json(rpc.findClusters(holders as any));
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/snipers/:mint', async (req, res) => {
    try {
      if (!_insightxClient) return res.json({ note: 'Sniper detection requires InsightX API key', total_sniper_pct: 0, count: { total: 0, sold_partially: 0, sold_fully: 0, bought_more: 0 }, snipers: [] });
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      const result = await _insightxClient.getSnipers(mint);
      res.json(result || { total_sniper_pct: 0, count: { total: 0, sold_partially: 0, sold_fully: 0, bought_more: 0 }, snipers: [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/bundlers/:mint', async (req, res) => {
    try {
      if (!_insightxClient) return res.json({ note: 'Bundler detection requires InsightX API key', total_bundlers_pct: 0, bundlers: [] });
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      const result = await _insightxClient.getBundlers(mint);
      res.json(result || { total_bundlers_pct: 0, bundlers: [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/insiders/:mint', async (req, res) => {
    try {
      if (!_insightxClient) return res.json({ note: 'Insider detection requires InsightX API key', total_insiders_pct: 0, insiders: [] });
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      const result = await _insightxClient.getInsiders(mint);
      res.json(result || { total_insiders_pct: 0, insiders: [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/distribution/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      if (_insightxClient) {
        const result = await _insightxClient.getDistribution(mint);
        res.json(result || { gini: 0, hhi: 0, nakamoto: 0, top_10_holder_concentration: 0 });
      } else {
        const rpc = _getRpcAnalyzer();
        const holders = await rpc.getHolders(mint);
        res.json(computeDistributionMetrics(holders));
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/bot-detect/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      if (_insightxClient) {
        const [clusters, snipers, bundlers] = await Promise.all([
          _insightxClient.getClusters(mint),
          _insightxClient.getSnipers(mint),
          _insightxClient.getBundlers(mint),
        ]);
        res.json(detectBotPattern(clusters, snipers, bundlers));
      } else {
        const rpc = _getRpcAnalyzer();
        const holders = await rpc.getHolders(mint);
        res.json(detectBotPatternFromHolders(holders));
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/insightx/scan/:mint', async (req, res) => {
    try {
      if (!_insightxClient) return res.json({ note: 'Security scan requires InsightX API key' });
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return res.status(400).json({ error: 'Invalid mint' });
      const result = await _insightxClient.scanToken(mint);
      res.json(result || {});
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/crowd/trending', async (_req, res) => {
    try {
      const db = runtime.getMemory().getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS crowd_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
      )`);
      const h24ago = Date.now() - 24 * 60 * 60 * 1000;
      const rows = db.prepare(`
        SELECT mint, COUNT(*) as cnt, COUNT(DISTINCT session_hash) as users
        FROM crowd_signals WHERE created_at > ?
        GROUP BY mint ORDER BY cnt DESC LIMIT 20
      `).all(h24ago) as any[];
      res.json({ trending: rows || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/nft/info/:mint', async (req, res) => {
    try {
      const mint = req.params.mint;
      if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid mint address' });
      }

      const rpcCfg = runtime.getRpcConfig();
      let heliusUrl = rpcCfg.helius || '';
      if (!heliusUrl && rpcCfg.solana?.includes('helius')) heliusUrl = rpcCfg.solana;

      const result: any = { address: mint, marketplaces: [] };


      if (heliusUrl) {
        try {
          const resp = await fetch(heliusUrl, {
                        method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'nft', method: 'getAsset', params: { id: mint } }),
            signal: AbortSignal.timeout(10000),
          });
          const data = await resp.json() as any;
          const asset = data?.result;
          if (asset) {
            const meta = asset.content?.metadata || {};
            result.name = meta.name || '';
            result.symbol = meta.symbol || '';
            result.description = meta.description || '';
            result.image = asset.content?.links?.image || asset.content?.files?.[0]?.cdn_uri || asset.content?.files?.[0]?.uri || '';
            result.externalUrl = asset.content?.links?.external_url || '';
            result.attributes = (meta.attributes || []).map((a: any) => ({ trait: a.trait_type, value: a.value }));
            result.collection = asset.grouping?.find((g: any) => g.group_key === 'collection')?.group_value || '';
            result.collectionName = asset.content?.metadata?.collection?.name || '';
            result.royalty = asset.royalty?.basis_points ? (asset.royalty.basis_points / 100) : 0;
            result.owner = asset.ownership?.owner || '';
            result.compressed = asset.compression?.compressed || false;
            result.standard = asset.interface || '';
          }
        } catch (e: any) {
          logger.warn(`NFT Helius DAS getAsset failed: ${e.message}`);
        }
      }


      if (!result.name) {
        const cached = _tokenMetaCache.get(mint);
        if (cached) {
          result.name = cached.name;
          result.symbol = cached.symbol;
          result.image = cached.logoURI || '';
        }
      }


      result.marketplaces = [
        { name: 'Magic Eden', url: `https://magiceden.io/item/${encodeURIComponent(mint)}`, icon: 'ME' },
        { name: 'Tensor', url: `https://www.tensor.trade/item/${encodeURIComponent(mint)}`, icon: 'T' },
      ];


      try {
                const meResp = await fetch(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(mint)}/listings?offset=0&limit=20`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        if (meResp.ok) {
          const listings = await meResp.json() as any[];
          if (Array.isArray(listings) && listings.length > 0) {
            const cheapest = listings.sort((a: any, b: any) => (a.price || Infinity) - (b.price || Infinity))[0];
            if (cheapest?.price) {
              result.listingPrice = cheapest.price;
            }
          }
        }
      } catch {}

      if (result.collection) {
        try {
                    const floorResp = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(result.collection)}/stats`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(6000),
          });
          if (floorResp.ok) {
            const stats = await floorResp.json() as any;
            if (stats.floorPrice) result.floorPrice = stats.floorPrice / 1e9;
            if (stats.listedCount) result.listedCount = stats.listedCount;
            if (stats.volumeAll) result.volumeAll = stats.volumeAll / 1e9;
          }
        } catch {}
      }

      res.json(result);
    } catch (err: any) {
      logger.error('NFT info error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/wallet/quote', async (req, res) => {
    try {
      const { inputMint, outputMint, amount, slippageBps } = req.query;
      if (!inputMint || !outputMint || !amount) {
        return res.status(400).json({ error: 'inputMint, outputMint, and amount are required' });
      }
      const slip = (slippageBps as string) || '50';

      const url = `https://api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint as string)}&outputMint=${encodeURIComponent(outputMint as string)}&amount=${encodeURIComponent(amount as string)}&slippageBps=${encodeURIComponent(slip)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return res.status(resp.status).json({ error: `Quote API returned ${resp.status}`, detail: txt });
      }
      const data = await resp.json() as any;
      res.json(data);
    } catch (err: any) {
      logger.error('Quote proxy error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/wallet/quotes', async (req, res) => {
    try {
      const { inputMint, outputMint, amount, slippageBps } = req.query;
      if (!inputMint || !outputMint || !amount) {
        return res.status(400).json({ error: 'inputMint, outputMint, and amount are required' });
      }
      const slip = (slippageBps as string) || '50';
      const encode = encodeURIComponent;
      const inMint = inputMint as string;
      const outMint = outputMint as string;
      const amt = amount as string;


      const jupUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${encode(inMint)}&outputMint=${encode(outMint)}&amount=${encode(amt)}&slippageBps=${encode(slip)}`;
      const rayUrl = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${encode(inMint)}&outputMint=${encode(outMint)}&amount=${encode(amt)}&slippageBps=${encode(slip)}&txVersion=V0`;
      const ultraUrl = `https://ultra-api.jup.ag/order?inputMint=${encode(inMint)}&outputMint=${encode(outMint)}&amount=${encode(amt)}`;

      const results: Array<{ provider: string; outAmount: string; routeLabel: string; timeTaken?: number }> = [];

      const [jupResult, rayResult, ultraResult] = await Promise.allSettled([
        (async () => {
          const t0 = Date.now();
          const r = await fetch(jupUrl, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) return null;
          return { data: await r.json(), ms: Date.now() - t0 };
        })(),
        (async () => {
          const t0 = Date.now();
          const r = await fetch(rayUrl, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) return null;
          return { data: await r.json(), ms: Date.now() - t0 };
        })(),
        (async () => {
          const t0 = Date.now();
          const r = await fetch(ultraUrl, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) return null;
          return { data: await r.json(), ms: Date.now() - t0 };
        })(),
      ]);

      if (jupResult.status === 'fulfilled' && jupResult.value?.data) {
        const d = jupResult.value.data;
        const routes = (d.routePlan || []).map((r: any) => r.swapInfo?.label).filter(Boolean);
        results.push({
          provider: 'Jupiter',
          outAmount: String(d.outAmount || '0'),
          routeLabel: routes.length ? routes.slice(0, 3).join(', ') + (routes.length > 3 ? ` & ${routes.length - 3} more` : '') : '',
          timeTaken: jupResult.value.ms,
        });
      }

      if (rayResult.status === 'fulfilled' && rayResult.value?.data) {
        const d = rayResult.value.data;
        const out = d.data?.outputAmount || d.outputAmount;
        if (out) {
          const rp = d.data?.routePlan || d.routePlan || [];
          const pools = rp.map((s: any) => s.poolId?.slice(0, 6)).filter(Boolean);
          results.push({
            provider: 'Raydium',
            outAmount: String(out),
            routeLabel: rp.length ? `${rp.length} pool${rp.length > 1 ? 's' : ''}` : '',
            timeTaken: rayResult.value.ms,
          });
        }
      }

      if (ultraResult.status === 'fulfilled' && ultraResult.value?.data) {
        const d = ultraResult.value.data;
        if (d.outAmount) {

          const routes = (d.routePlan || []).map((r: any) => r.swapInfo?.label).filter(Boolean);
          const swapType = d.swapType || '';
          let providerName = 'Ultra';
          if (swapType === 'okx' || routes.some((l: string) => /okx/i.test(l))) providerName = 'OKX';
          else if (routes.length) providerName = routes[0];

          const isDup = results.some(r => r.provider === providerName);
          if (!isDup) {
            results.push({
              provider: providerName,
              outAmount: String(d.outAmount),
              routeLabel: routes.length ? routes.join(', ') : swapType || '',
              timeTaken: ultraResult.value.ms,
            });
          }
        }
      }


      results.sort((a, b) => {
        const aOut = BigInt(a.outAmount || '0');
        const bOut = BigInt(b.outAmount || '0');
        return aOut > bOut ? -1 : aOut < bOut ? 1 : 0;
      });


      if (results.length > 0) {
        (results[0] as any).best = true;
      }

      res.json({ quotes: results, inputAmount: amount });
    } catch (err: any) {
      logger.error('Multi-quote error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/simulate-dapp-tx', async (req, res) => {
    try {
      const { transaction, origin } = req.body;
      if (!transaction) return res.status(400).json({ error: 'transaction bytes required' });

      const { VersionedTransaction, PublicKey: PK, SystemProgram, AddressLookupTableAccount } = await import('@solana/web3.js');
      const w = runtime.getWallet();
      const conn = w.getConnection();
      const walletAddr = w.getAddress();

      const txBuf = Buffer.from(transaction);
      const vtx = VersionedTransaction.deserialize(txBuf);


      let simulation: any = null;
      let simError: string | null = null;
      try {
        simulation = await conn.simulateTransaction(vtx, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        });
        if (simulation.value?.err) {
          simError = typeof simulation.value.err === 'string'
            ? simulation.value.err
            : JSON.stringify(simulation.value.err);
        }
      } catch (e: any) {
        simError = e.message;
      }


      let accountKeys: string[] = [];
      try {
        const msg = vtx.message;
        const altLookups = (msg as any).addressTableLookups || [];
        if (altLookups.length > 0) {

          const altAccounts = await Promise.all(
            altLookups.map(async (lookup: any) => {
              try {
                const altAddr = new PK(lookup.accountKey);
                const altInfo = await conn.getAddressLookupTable(altAddr);
                return altInfo.value;
              } catch { return null; }
            })
          );
          const validALTs = altAccounts.filter((a: any): a is InstanceType<typeof AddressLookupTableAccount> => a !== null);
          const resolved = msg.getAccountKeys({ addressLookupTableAccounts: validALTs });
          accountKeys = Array.from({ length: resolved.length }, (_, i) => {
            try { return resolved.get(i)!.toBase58(); } catch { return `unknown-${i}`; }
          });
        } else {

          const resolved = msg.getAccountKeys?.() ? msg.getAccountKeys() : null;
          if (resolved) {
            accountKeys = Array.from({ length: resolved.length }, (_, i) => {
              try { return resolved.get(i)!.toBase58(); } catch { return `unknown-${i}`; }
            });
          } else {
            accountKeys = ((msg as any).staticAccountKeys || []).map((k: any) => {
              try { return k.toBase58(); } catch { return 'unknown'; }
            });
          }
        }
      } catch (altErr: any) {

        const staticKeys = (vtx.message as any).staticAccountKeys || [];
        accountKeys = staticKeys.map((k: any) => { try { return k.toBase58(); } catch { return 'unknown'; } });
        logger.warn('ALT resolution failed, using static keys only:', altErr.message);
      }


      const PROGRAMS: Record<string, string> = {
        '11111111111111111111111111111111': 'System Program',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token',
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
        'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky': 'Mercurial',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
        'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP': 'pump.fun Swap',
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Metadata',
        'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg': 'Metaplex Auth',
        'ComputeBudget111111111111111111111111111111': 'Compute Budget',

        'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K': 'Magic Eden v2',
        'M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1': 'Magic Eden v3',
        'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN': 'Tensor Swap',
        'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp': 'Tensor cNFT',
        'hadeK9DLv9eA7ya5KCTqSvSvRZeJC3JgD5a9Y3CNbvu': 'Hadeswap',
        'CJsLwbP1iu5DuUikKoTKCmAUkzRj3a9b8SQfH4eRJiMc': 'ME AMM',
        'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc': 'ME MMM Pool',

        'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY': 'Bubblegum (cNFT)',
        'noopb9bkMVfRPU8AsBHBNRs82211yQ8pKYndLJ6gKXI': 'SPL Noop',
        'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK': 'SPL Compression',
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d': 'Metaplex Core',
        'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g': 'Metaplex Guard',
        'TokenRecor111111111111111111111111111111111': 'Token Metadata',
      };

      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      const SYSTEM_PROGRAM = '11111111111111111111111111111111';

      const instructions: Array<{
        program: string;
        programName: string;
        type: string;
        details: Record<string, any>;
      }> = [];

      const warnings: Array<{ level: 'danger' | 'warning' | 'info'; message: string }> = [];
      let riskScore = 0;

      const compiledIxs = vtx.message.compiledInstructions || (vtx.message as any).instructions || [];
      for (const ix of compiledIxs) {
        const progIdx = ix.programIdIndex;
        const progAddr = accountKeys[progIdx] || 'unknown';
        const progName = PROGRAMS[progAddr] || progAddr.slice(0, 8) + 'Ã¢â‚¬Â¦';
        const data = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data || []);
        const accs = (ix.accountKeyIndexes || []).map((i: number) => accountKeys[i] || '?');

        let ixType = 'unknown';
        const details: Record<string, any> = {};


        if (progAddr === SYSTEM_PROGRAM && data.length >= 4) {
          const ixId = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
          if (ixId === 2) {
            ixType = 'SOL Transfer';
            if (data.length >= 12) {
              const lamports = Number((data as Buffer).readBigUInt64LE(4));
              details.amount = lamports / 1e9;
              details.from = accs[0];
              details.to = accs[1];
              if (accs[0] === walletAddr) {
                details.direction = 'outgoing';
                if (details.amount > 1) { riskScore += 20; warnings.push({ level: 'warning', message: `Transfers ${details.amount.toFixed(4)} SOL from your wallet` }); }
                if (details.amount > 10) { riskScore += 20; warnings.push({ level: 'danger', message: `Large SOL transfer: ${details.amount.toFixed(4)} SOL` }); }
              }
            }
          } else if (ixId === 3) {
            ixType = 'Create Account';
            details.owner = accs[1];
          } else if (ixId === 11) {
            ixType = 'Assign (Change Owner)';
            details.account = accs[0];
            details.newOwner = accs[1];
            if (accs[0] === walletAddr) {
              riskScore += 50;
              warnings.push({ level: 'danger', message: 'Ã°Å¸Å¡Â¨ Attempting to reassign ownership of your account!' });
            }
          }
        }


        if ((progAddr === TOKEN_PROGRAM || progAddr === TOKEN_2022) && data.length >= 1) {
          const ixId = data[0];
          if (ixId === 3) {
            ixType = 'Token Transfer';
            if (data.length >= 9) {
              const rawAmount = Number((data as Buffer).readBigUInt64LE(1));
              details.from = accs[0];
              details.to = accs[1];
              details.authority = accs[2];
              details.rawAmount = rawAmount;
              if (accs[2] === walletAddr) details.direction = 'outgoing';
            }
          } else if (ixId === 4) {
            ixType = 'Ã¢Å¡Â Ã¯Â¸Â Token Approve (Delegation)';
            if (data.length >= 9) {
              const rawAmount = Number((data as Buffer).readBigUInt64LE(1));
              details.tokenAccount = accs[0];
              details.delegate = accs[1];
              details.owner = accs[2];
              details.rawAmount = rawAmount;
              if (accs[2] === walletAddr) {
                riskScore += 35;
                warnings.push({
                  level: 'danger',
                  message: `Grants token spend approval to ${accs[1].slice(0, 8)}Ã¢â‚¬Â¦ Ã¢â‚¬â€ they can move your tokens!`,
                });
                if (rawAmount > 1e15) {
                  riskScore += 20;
                  warnings.push({ level: 'danger', message: 'Unlimited token approval Ã¢â‚¬â€ maximum risk!' });
                }
              }
            }
          } else if (ixId === 5) {
            ixType = 'Token Revoke';
            details.tokenAccount = accs[0];
            details.owner = accs[1];
          } else if (ixId === 6) {
            ixType = 'Ã¢Å¡Â Ã¯Â¸Â SetAuthority';
            details.account = accs[0];
            details.currentAuthority = accs[1];
            if (data.length > 1) details.authorityType = data[1];
            if (accs[1] === walletAddr) {
              riskScore += 40;
              warnings.push({ level: 'danger', message: 'Changes authority on your token account Ã¢â‚¬â€ potential drain vector!' });
            }
          } else if (ixId === 7) {
            ixType = 'Mint Tokens';
          } else if (ixId === 8) {
            ixType = 'Burn Tokens';
          } else if (ixId === 9) {
            ixType = 'Close Account';
            details.account = accs[0];
            details.destination = accs[1];
            details.owner = accs[2];
          } else if (ixId === 12) {
            ixType = 'Token TransferChecked';
            details.from = accs[0];
            details.mint = accs[1];
            details.to = accs[2];
            details.authority = accs[3];
            if (accs[3] === walletAddr) details.direction = 'outgoing';
          } else if (ixId === 13) {
            ixType = 'Ã¢Å¡Â Ã¯Â¸Â Token ApproveChecked';
            details.tokenAccount = accs[0];
            details.mint = accs[1];
            details.delegate = accs[2];
            details.owner = accs[3];
            if (accs[3] === walletAddr) {
              riskScore += 35;
              warnings.push({ level: 'danger', message: `Grants checked token approval to ${accs[2].slice(0, 8)}Ã¢â‚¬Â¦` });
            }
          }
        }


        if (PROGRAMS[progAddr]) {
          if (ixType === 'unknown') ixType = progName + ' call';
        } else {

          if (ixType === 'unknown') {
            ixType = 'Unknown Program Call';
            riskScore += 10;
            warnings.push({ level: 'warning', message: `Calls unverified program: ${progAddr.slice(0, 12)}Ã¢â‚¬Â¦` });
          }
        }

        instructions.push({ program: progAddr, programName: progName, type: ixType, details });
      }


      let balanceChanges: Array<{ account: string; before: number; after: number; diff: number }> = [];
      if (simulation?.value?.accounts && !simError) {

        const preBalances = simulation.value.preBalances || [];
        const postBalances = simulation.value.postBalances || [];
        for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
          const diff = (postBalances[i] - preBalances[i]) / 1e9;
          if (Math.abs(diff) > 0.000001) {
            balanceChanges.push({
              account: accountKeys[i] || `account-${i}`,
              before: preBalances[i] / 1e9,
              after: postBalances[i] / 1e9,
              diff,
            });
          }
        }
      }


      const walletChange = balanceChanges.find(c => c.account === walletAddr);
      if (walletChange && walletChange.diff < -0.1) {
        riskScore += 15;
        warnings.push({ level: 'warning', message: `You will lose ${Math.abs(walletChange.diff).toFixed(4)} SOL` });
      }
      if (walletChange && walletChange.diff < -1) {
        riskScore += 20;
        warnings.push({ level: 'danger', message: `Large SOL loss: ${Math.abs(walletChange.diff).toFixed(4)} SOL` });
      }


      const hasApprove = instructions.some(i => i.type.includes('Approve'));
      const hasTransfer = instructions.some(i => i.type.includes('Transfer') && i.details.direction === 'outgoing');
      const hasSetAuthority = instructions.some(i => i.type.includes('SetAuthority'));
      const hasUnknownPrograms = instructions.some(i => i.type === 'Unknown Program Call');

      if (hasApprove && hasUnknownPrograms) {
        riskScore += 25;
        warnings.push({ level: 'danger', message: 'Ã°Å¸Å¡Â¨ Token approval + unknown program = common drainer pattern!' });
      }
      if (hasSetAuthority && hasUnknownPrograms) {
        riskScore += 30;
        warnings.push({ level: 'danger', message: 'Ã°Å¸Å¡Â¨ Authority change + unknown program = high drainer risk!' });
      }
      if (hasApprove && hasTransfer) {
        riskScore += 15;
        warnings.push({ level: 'warning', message: 'Approval + transfer in same transaction Ã¢â‚¬â€ verify carefully' });
      }

      riskScore = Math.min(100, riskScore);
      const riskLevel = riskScore >= 50 ? 'high' : riskScore >= 20 ? 'medium' : 'low';

      res.json({
        riskScore,
        riskLevel,
        warnings,
        instructions,
        balanceChanges,
        simError,
        origin: origin || null,
      });
    } catch (err: any) {
      logger.error('simulate-dapp-tx error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/ai-scan-dapp-tx', async (req, res) => {
    try {
      const { transaction, origin, simulationResult } = req.body;
      if (!transaction) return res.status(400).json({ error: 'transaction required' });

      const { VersionedTransaction, PublicKey: PK, AddressLookupTableAccount } = await import('@solana/web3.js');
      const w = runtime.getWallet();
      const walletAddr = w.getAddress();
      const conn = w.getConnection();


      const txBuf = Buffer.from(transaction);
      const vtx = VersionedTransaction.deserialize(txBuf);

      let accountKeys: string[] = [];
      try {
        const msg = vtx.message;
        const altLookups = (msg as any).addressTableLookups || [];
        if (altLookups.length > 0) {
          const altAccounts = await Promise.all(
            altLookups.map(async (lookup: any) => {
              try {
                const altInfo = await conn.getAddressLookupTable(new PK(lookup.accountKey));
                return altInfo.value;
              } catch { return null; }
            })
          );
          const validALTs = altAccounts.filter((a: any): a is InstanceType<typeof AddressLookupTableAccount> => a !== null);
          const resolved = msg.getAccountKeys({ addressLookupTableAccounts: validALTs });
          accountKeys = Array.from({ length: resolved.length }, (_, i) => {
            try { return resolved.get(i)!.toBase58(); } catch { return `unknown-${i}`; }
          });
        } else {
          const resolved = msg.getAccountKeys?.() ? msg.getAccountKeys() : null;
          if (resolved) {
            accountKeys = Array.from({ length: resolved.length }, (_, i) => {
              try { return resolved.get(i)!.toBase58(); } catch { return `unknown-${i}`; }
            });
          } else {
            accountKeys = ((msg as any).staticAccountKeys || []).map((k: any) => { try { return k.toBase58(); } catch { return 'unknown'; } });
          }
        }
      } catch {
        const staticKeys = (vtx.message as any).staticAccountKeys || [];
        accountKeys = staticKeys.map((k: any) => { try { return k.toBase58(); } catch { return 'unknown'; } });
      }


      const KNOWN_PROGRAMS: Record<string, string> = {
        '11111111111111111111111111111111': 'System Program',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022',
        'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Account',
        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6 Aggregator',
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
        'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP': 'pump.fun Swap',
        'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': 'Metaplex Token Metadata',
        'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg': 'Metaplex Authorization Rules',
        'ComputeBudget111111111111111111111111111111': 'Compute Budget',
        'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K': 'Magic Eden v2 Marketplace',
        'M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1': 'Magic Eden v3 Marketplace',
        'TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN': 'Tensor Swap',
        'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp': 'Tensor cNFT',
        'hadeK9DLv9eA7ya5KCTqSvSvRZeJC3JgD5a9Y3CNbvu': 'Hadeswap',
        'CJsLwbP1iu5DuUikKoTKCmAUkzRj3a9b8SQfH4eRJiMc': 'ME AMM',
        'mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc': 'ME MMM Pool',
        'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY': 'Bubblegum (cNFT Minting/Transfer)',
        'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK': 'SPL Account Compression',
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d': 'Metaplex Core',
        'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g': 'Metaplex Candy Guard',
        'noopb9bkMVfRPU8AsBHBNRs82211yQ8pKYndLJ6gKXI': 'SPL Noop',
        'SysvarRent111111111111111111111111111111111': 'Sysvar Rent',
        'Stake11111111111111111111111111111111111111': 'Stake Program',
        'Vote111111111111111111111111111111111111111': 'Vote Program',
      };


      let context = `dApp Origin: ${origin || 'unknown'}\n`;
      context += `User Wallet: ${walletAddr}\n`;
      context += `Transaction Version: ${(vtx.message as any).version !== undefined ? 'V0' : 'Legacy'}\n`;
      context += `Total Accounts: ${accountKeys.length}\n\n`;


      const compiledIxs = vtx.message.compiledInstructions || (vtx.message as any).instructions || [];
      const programsUsed = new Set<string>();
      for (const ix of compiledIxs) {
        const addr = accountKeys[ix.programIdIndex] || 'unknown';
        programsUsed.add(addr);
      }
      context += `Programs invoked:\n`;
      for (const p of programsUsed) {
        context += `  ${KNOWN_PROGRAMS[p] || 'Unknown'} (${p})\n`;
      }


      context += `\nInstruction breakdown (${compiledIxs.length} instructions):\n`;
      for (let i = 0; i < compiledIxs.length; i++) {
        const ix = compiledIxs[i];
        const progAddr = accountKeys[ix.programIdIndex] || 'unknown';
        const progName = KNOWN_PROGRAMS[progAddr] || `Unknown (${progAddr.slice(0, 16)}Ã¢â‚¬Â¦)`;
        const ixAccounts = (ix.accountKeyIndexes || []).map((idx: number) => accountKeys[idx] || '?');
        const data = ix.data instanceof Uint8Array ? ix.data : Buffer.from(ix.data || []);

        context += `  [${i + 1}] Program: ${progName}\n`;
        context += `      Accounts (${ixAccounts.length}): `;
        const accSummary = ixAccounts.map((a: string) => {
          if (a === walletAddr) return `${a.slice(0, 8)}Ã¢â‚¬Â¦ [YOUR WALLET]`;
          if (KNOWN_PROGRAMS[a]) return `${a.slice(0, 8)}Ã¢â‚¬Â¦ [${KNOWN_PROGRAMS[a]}]`;
          return `${a.slice(0, 12)}Ã¢â‚¬Â¦`;
        }).join(', ');
        context += accSummary + '\n';
        if (data.length > 0) context += `      Data: ${data.length} bytes (discriminator: 0x${Buffer.from(data.slice(0, 8)).toString('hex')})\n`;
      }


      if (simulationResult) {
        context += `\nSimulation Analysis:\n`;
        context += `Risk score: ${simulationResult.riskScore}/100 (${simulationResult.riskLevel})\n`;
        if (simulationResult.simError) context += `Simulation error: ${simulationResult.simError}\n`;
        if (simulationResult.instructions?.length) {
          context += `\nDecoded instruction types:\n`;
          for (const ix of simulationResult.instructions) {
            context += `  - ${ix.type} (${ix.programName})`;
            if (ix.details.amount != null) context += ` amount:${ix.details.amount}`;
            if (ix.details.delegate) context += ` delegate:${ix.details.delegate}`;
            if (ix.details.from) context += ` from:${ix.details.from.slice(0, 12)}Ã¢â‚¬Â¦`;
            if (ix.details.to) context += ` to:${ix.details.to.slice(0, 12)}Ã¢â‚¬Â¦`;
            if (ix.details.direction) context += ` [${ix.details.direction}]`;
            context += `\n`;
          }
        }
        if (simulationResult.balanceChanges?.length) {
          context += `\nSOL balance changes:\n`;
          for (const c of simulationResult.balanceChanges) {
            context += `  ${c.account === walletAddr ? 'YOUR WALLET' : c.account.slice(0, 12) + 'Ã¢â‚¬Â¦'}: ${c.diff > 0 ? '+' : ''}${c.diff.toFixed(6)} SOL\n`;
          }
        }
        if (simulationResult.warnings?.length) {
          context += `\nWarnings triggered:\n`;
          for (const w of simulationResult.warnings) {
            context += `  [${w.level}] ${w.message}\n`;
          }
        }
      }

      const aiPrompt = `You are an expert Solana blockchain analyst. Your job is to determine what a transaction does and whether it is safe.

TRANSACTION CONTEXT:
${context}

ANALYSIS GUIDELINES:
1. First identify the TRANSACTION PURPOSE based on the programs invoked:
   - Magic Eden / Tensor / Hadeswap programs Ã¢â€ â€™ NFT buy, sell, list, delist, bid, cancel
   - Jupiter / Raydium / Orca programs Ã¢â€ â€™ Token swap / DEX trade
   - pump.fun programs Ã¢â€ â€™ Memecoin buy/sell on bonding curve
   - Metaplex Metadata + Token Program Ã¢â€ â€™ NFT mint, metadata update
   - System Program SOL Transfer alone Ã¢â€ â€™ Simple SOL transfer
   - Stake Program Ã¢â€ â€™ SOL staking/unstaking
   - Token Approve/SetAuthority Ã¢â€ â€™ Permission grant (scrutinize carefully!)
   - Bubblegum / SPL Compression Ã¢â€ â€™ Compressed NFT operations

2. Known-safe patterns (DO NOT flag as suspicious unless there are additional red flags):
   - Magic Eden v2/v3 buy/sell from magiceden.io Ã¢â€ â€™ SAFE (standard NFT marketplace)
   - Jupiter swap from jup.ag Ã¢â€ â€™ SAFE (standard DEX aggregator)
   - Compute Budget instructions Ã¢â€ â€™ SAFE (gas optimization, always present)
   - Associated Token Account creation Ã¢â€ â€™ SAFE (needed for receiving tokens)
   - SOL transfer of small amounts (<0.5 SOL) as part of NFT buy Ã¢â€ â€™ SAFE (payment)

3. DANGEROUS patterns to flag:
   - Token Approve/ApproveChecked granting delegate authority to unknown addresses
   - SetAuthority changing ownership of your token accounts
   - Large SOL transfers (>5 SOL) to unknown wallets outside of known programs
   - Unknown programs combined with approvals Ã¢â‚¬â€ classic drainer pattern
   - Domain mismatch (e.g., "magiceden" typosquat)

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "verdict": "safe" | "suspicious" | "dangerous",
  "confidence": 0-100,
  "summary": "Clear 1-2 sentence explanation of what this transaction does in plain language",
  "txPurpose": "specific action: NFT Purchase, NFT Listing, Token Swap, SOL Transfer, NFT Mint, Staking, Token Approval, etc.",
  "risks": ["only list REAL specific risks, empty array if safe"],
  "recommendation": "concise advice for the user"
}`;

      const aiResponse = await runtime.quickLlm(aiPrompt);

      let analysis;
      try {
        analysis = JSON.parse(aiResponse);
      } catch {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        } else {
          analysis = {
            verdict: 'unknown',
            confidence: 0,
            summary: aiResponse.slice(0, 200),
            risks: [],
            recommendation: 'Could not parse AI analysis',
            txPurpose: 'unknown',
          };
        }
      }

      res.json(analysis);
    } catch (err: any) {
      logger.error('ai-scan-dapp-tx error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/ai-scan-page', async (req, res) => {
    try {
      const { url, hostname, title, bodyText, inlineCode, externalScripts, iframes,
              metaTags, links, ctas, inputs, storageKeys, protocol, hasServiceWorker,
              origin, walletPatterns, hiddenOverlays, cookieNames, documentForms, totalScripts, totalIframes } = req.body;
      if (!url) return res.status(400).json({ error: 'url required' });


      let context = `=== SITE IDENTITY ===\nURL: ${url}\nHostname: ${hostname}\nOrigin: ${origin || url}\nTitle: ${title || '(none)'}\nProtocol: ${protocol || 'unknown'}\n`;
      if (hasServiceWorker) context += `Service Worker: ACTIVE\n`;
      context += `Total scripts: ${totalScripts || 0}, Total iframes: ${totalIframes || 0}, Forms: ${documentForms || 0}\n`;


      if (metaTags && Object.keys(metaTags).length) {
        context += `\n=== META TAGS ===\n`;
        for (const [k, v] of Object.entries(metaTags)) {
          context += `  ${k}: ${v}\n`;
        }
      }


      if (bodyText) {
        context += `\n=== PAGE TEXT (first 8000 chars) ===\n${String(bodyText).slice(0, 8000)}\n`;
      }


      if (ctas?.length) {
        context += `\n=== BUTTONS / CTAs ===\n${(ctas as string[]).slice(0, 25).join(' | ')}\n`;
      }


      if (inputs?.length) {
        context += `\n=== INPUT FIELDS ===\n${(inputs as any[]).map((i: any) => `[${i.type}] name="${i.name}" placeholder="${i.placeholder}"`).join('\n')}\n`;
      }


      if (links?.length) {
        const broken = (links as any[]).filter((l: any) => l.broken);
        const external = (links as any[]).filter((l: any) => l.external);
        const internal = (links as any[]).filter((l: any) => !l.broken && !l.external);
        context += `\n=== LINKS ===\n`;
        if (internal.length) context += `Internal (${internal.length}): ${internal.slice(0, 10).map((l: any) => `"${l.text}"->${l.href}`).join(', ')}\n`;
        if (external.length) context += `External (${external.length}): ${external.slice(0, 15).map((l: any) => `"${l.text}"->${l.href}`).join(', ')}\n`;
        if (broken.length) context += `Void/fake links (${broken.length}): ${broken.slice(0, 10).map((l: any) => `"${l.text}"`).join(', ')}\n`;
      }


      if (storageKeys?.length) {
        context += `\n=== LOCALSTORAGE KEYS ===\n${(storageKeys as string[]).join(', ')}\n`;
      }


      if (cookieNames?.length) {
        context += `\n=== COOKIE NAMES ===\n${(cookieNames as string[]).join(', ')}\n`;
      }


      if (walletPatterns?.length) {
        context += `\n=== WALLET/CRYPTO JS PATTERNS DETECTED ===\n`;
        for (const wp of walletPatterns as any[]) {
          context += `  ${wp.pattern} (Ã—${wp.count})\n`;
        }
      }


      if (hiddenOverlays?.length) {
        context += `\n=== HIDDEN OVERLAYS/MODALS TEXT ===\n`;
        for (const h of hiddenOverlays as string[]) {
          context += `  "${h}"\n`;
        }
      }


      if (externalScripts?.length) {
        context += `\n=== EXTERNAL SCRIPTS (${(externalScripts as string[]).length} total) ===\n${(externalScripts as string[]).map((s: string) => `  ${s}`).join('\n')}\n`;
      }


      if (iframes?.length) {
        context += `\n=== IFRAMES (${(iframes as any[]).length} total) ===\n${(iframes as any[]).map((f: any) => `  src: ${f.src || '(none)'}, ${f.width}x${f.height}${f.hidden ? ' [HIDDEN]' : ''}${f.sandbox ? ` sandbox="${f.sandbox}"` : ''}${f.allow ? ` allow="${f.allow}"` : ''}`).join('\n')}\n`;
      }


      if (inlineCode) {
        context += `\n=== INLINE JAVASCRIPT (first 50000 chars) ===\n${String(inlineCode).slice(0, 50000)}\n`;
      }

      const aiPrompt = `You are an elite Web3 security analyst. A Solana wallet browser extension is about to connect to a website. Your job: analyze ALL the raw data below and determine if this specific site is trying to drain/steal the user's wallet funds.

${context}

YOUR ANALYSIS METHODOLOGY:
1. FIRST â€” identify what this site IS. Check the domain, title, meta tags, page content. Is this a well-known dApp (DEX, NFT marketplace, DeFi, launchpad, trading terminal)? Or an unknown site?

2. WELL-KNOWN LEGITIMATE SITES â€” these are SAFE by default when on their real domains:
   pump.fun, magiceden.io, phantom.app, jup.ag, raydium.io, tensor.trade, orca.so, drift.trade, marinade.finance, marginfi.com, kamino.finance, birdeye.so, dexscreener.com, axiom.trade, bullx.io, photon-sol.tinyastro.io, defined.fi, backpack.app, helius.dev, metaplex.com, solscan.io, solana.fm, uniswap.org, opensea.io, blur.io, lido.fi, aave.com, coinbase.com, binance.com, okx.com, bybit.com, kraken.com
   If the site is one of these on its official domain â†’ verdict "safe", period. Don't overthink it.

3. ONLY IF the site is NOT a known legitimate project â€” analyze the JavaScript code for actual drainer signatures:
   - CRITICAL DANGER: setAuthority, createApproveInstruction (token delegation/theft)
   - CRITICAL DANGER: VersionedTransaction.deserialize + signAllTransactions (blind signing of external payloads)
   - CRITICAL DANGER: eval() / Function() with obfuscated payloads, atob() with huge base64 strings
   - CRITICAL DANGER: Seed phrase / private key / mnemonic input fields
   - CRITICAL DANGER: Webhook exfiltration (discord webhooks, telegram bot API, webhook.site)
   - CRITICAL DANGER: skipPreflight:true combined with externally-built transactions
   - SUSPICIOUS: Free hosting (vercel.app, netlify.app, pages.dev) + "airdrop/claim/reward" language
   - SUSPICIOUS: Typosquat domains (phant0m.app, magiced3n.io, etc.)
   - SUSPICIOUS: All links are # or javascript:void â€” no real navigation
   - SUSPICIOUS: Countdown timers + urgency language + "limited supply" + "claim now"
   - NORMAL/SAFE: Standard wallet adapter (@solana/wallet-adapter), createTransferInstruction, SystemProgram.transfer, normal swap/trade logic
   - NORMAL/SAFE: Analytics scripts (google, segment, amplitude, datadog, sentry), CDN scripts (unpkg, cdnjs, jsdelivr), web-vitals
   - NORMAL/SAFE: Hidden iframes for analytics/tracking/auth â€” every major site has these
   - NORMAL/SAFE: Minified/bundled JavaScript â€” every production site minifies code
   - NORMAL/SAFE: Service workers for caching/PWA functionality

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "verdict": "safe" | "suspicious" | "dangerous",
  "confidence": 0-100,
  "summary": "1-2 sentence plain language assessment",
  "risks": ["only list REAL specific risks found, not generic concerns"],
  "recommendation": "actionable advice",
  "siteType": "legitimate dApp | phishing | drainer | airdrop scam | unknown"
}

CRITICAL RULES:
- A known legitimate site on its real domain = "safe". No exceptions.
- Minified JS, hidden analytics iframes, CDN scripts are NORMAL â€” never flag them.
- "suspicious" means you found SPECIFIC concerning patterns, not vague doubts.
- "dangerous" means you found ACTUAL drainer code signatures or clear phishing.
- Empty risks array for safe sites. Do not invent risks that don't exist.
- unpkg.com, cdnjs.cloudflare.com, jsdelivr.net are trusted CDNs â€” not suspicious sources.`;

      const aiResponse = await runtime.quickLlm(aiPrompt);

      let analysis;
      try {
        analysis = JSON.parse(aiResponse);
      } catch {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        } else {
          analysis = {
            verdict: 'unknown',
            confidence: 0,
            summary: aiResponse.slice(0, 200),
            risks: [],
            recommendation: 'Could not parse AI analysis',
            siteType: 'unknown',
          };
        }
      }

      res.json(analysis);
    } catch (err: any) {
      logger.error('ai-scan-page error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/tx-safety-check', async (req, res) => {
    try {
      const { type, toAddress, tokenMint, amount } = req.body;
      if (!type) return res.status(400).json({ error: 'type is required' });

      const warnings: Array<{ level: 'danger' | 'warning' | 'info'; message: string }> = [];
      let riskScore = 0;

      const encode = encodeURIComponent;
      const fetchTimeout = (url: string, ms = 5000) => fetch(url, { signal: AbortSignal.timeout(ms) });


      if (toAddress && type !== 'swap') {

        const knownDrainerPatterns = [
          /^1111111111/,
        ];
        if (knownDrainerPatterns.some(p => p.test(toAddress))) {
          warnings.push({ level: 'danger', message: 'Recipient address matches known drainer pattern' });
          riskScore += 40;
        }


        try {
          const w = runtime.getWallet();
          const conn = w.getConnection();
          const { PublicKey } = await import('@solana/web3.js');
          const accInfo = await conn.getAccountInfo(new PublicKey(toAddress));
          if (!accInfo) {
            warnings.push({ level: 'info', message: 'Recipient is a new/empty account (never used before)' });
            riskScore += 5;
          }
        } catch {}
      }


      if (tokenMint && tokenMint !== 'So11111111111111111111111111111111111111112') {
        try {

          const jupResp = await fetchTimeout(`https://token.jup.ag/${encodeURIComponent(tokenMint)}`);
          if (jupResp.ok) {
            const tok = await jupResp.json() as any;

            if (!tok.tags || tok.tags.length === 0) {
              warnings.push({ level: 'warning', message: `Token is not verified on Jupiter (no tags)` });
              riskScore += 15;
            }
          } else {
            warnings.push({ level: 'warning', message: 'Token not found in Jupiter registry Ã¢â‚¬â€ could be very new or suspicious' });
            riskScore += 20;
          }
        } catch {}

        try {

          const w = runtime.getWallet();
          const conn = w.getConnection();
          const { PublicKey } = await import('@solana/web3.js');
          const mintInfo = await conn.getParsedAccountInfo(new PublicKey(tokenMint));
          if (mintInfo?.value) {
            const parsed = (mintInfo.value.data as any)?.parsed?.info;
            if (parsed) {
              if (parsed.mintAuthority) {
                warnings.push({ level: 'warning', message: 'Token has active mint authority Ã¢â‚¬â€ supply can be inflated' });
                riskScore += 15;
              }
              if (parsed.freezeAuthority) {
                warnings.push({ level: 'danger', message: 'Token has freeze authority Ã¢â‚¬â€ your tokens can be frozen' });
                riskScore += 25;
              }
            }
          }
        } catch {}

        try {

                    const gmResp = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encode(tokenMint)}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
            signal: AbortSignal.timeout(5000),
          });
          if (gmResp.ok) {
            const gm = await gmResp.json() as any;
            const t = gm?.data?.token;
            if (t) {
              const liq = t.liquidity || 0;
              const age = t.open_timestamp ? Date.now() - t.open_timestamp * 1000 : 0;

              if (liq < 1000) {
                warnings.push({ level: 'danger', message: `Extremely low liquidity: $${liq.toFixed(0)}` });
                riskScore += 25;
              } else if (liq < 10000) {
                warnings.push({ level: 'warning', message: `Low liquidity: $${liq.toFixed(0)}` });
                riskScore += 10;
              }

              if (age > 0 && age < 3600000) {
                warnings.push({ level: 'warning', message: 'Token pair created less than 1 hour ago' });
                riskScore += 15;
              } else if (age > 0 && age < 86400000) {
                warnings.push({ level: 'info', message: 'Token pair created less than 24 hours ago' });
                riskScore += 5;
              }

              if (t.is_honeypot) {
                warnings.push({ level: 'danger', message: 'GMGN flagged as honeypot' });
                riskScore += 30;
              }
              if (t.buy_tax > 5 || t.sell_tax > 5) {
                warnings.push({ level: 'warning', message: `High tax detected â€” buy: ${t.buy_tax}%, sell: ${t.sell_tax}%` });
                riskScore += 15;
              }
            } else {
              warnings.push({ level: 'warning', message: 'No trading data found on GMGN' });
              riskScore += 15;
            }
          }
        } catch {}
      }


      if (amount && type !== 'swap') {
        try {
          const w = runtime.getWallet();
          const bal = await w.getBalance();
          if (bal > 0 && Number(amount) / bal > 0.9) {
            warnings.push({ level: 'warning', message: 'Sending over 90% of your SOL balance' });
            riskScore += 10;
          }
        } catch {}
      }

      riskScore = Math.min(100, riskScore);
      const riskLevel = riskScore >= 50 ? 'high' : riskScore >= 20 ? 'medium' : 'low';

      res.json({ riskScore, riskLevel, warnings });
    } catch (err: any) {
      logger.error('tx-safety-check error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/ai-drainer-check', async (req, res) => {
    try {
      const { type, toAddress, tokenMint, tokenSymbol, amount, fromSymbol, toSymbol } = req.body;
      if (!type) return res.status(400).json({ error: 'type is required' });


      let context = `Transaction type: ${type}\n`;
      if (amount) context += `Amount: ${amount}\n`;
      if (toAddress) context += `Recipient: ${toAddress}\n`;
      if (tokenMint) context += `Token mint: ${tokenMint}\n`;
      if (tokenSymbol) context += `Token: ${tokenSymbol}\n`;
      if (fromSymbol) context += `From: ${fromSymbol}\n`;
      if (toSymbol) context += `To: ${toSymbol}\n`;


      let onChainData = '';
      const encode = encodeURIComponent;

      if (tokenMint && tokenMint !== 'So11111111111111111111111111111111111111112') {
        try {
                    const gmResp = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encode(tokenMint)}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
            signal: AbortSignal.timeout(5000),
          });
          if (gmResp.ok) {
            const gm = await gmResp.json() as any;
            const t = gm?.data?.token;
            if (t) {
              onChainData += `\nGMGN data:\n`;
              onChainData += `  Token: ${t.symbol || '?'}/${t.name || '?'}\n`;
              onChainData += `  Price: $${t.price || '?'}\n`;
              onChainData += `  Liquidity: $${t.liquidity || 0}\n`;
              onChainData += `  24h Volume: $${t.volume_24h || 0}\n`;
              onChainData += `  24h Change: ${t.price_change_percent?.h24 || 0}%\n`;
              onChainData += `  Created: ${t.open_timestamp ? new Date(t.open_timestamp * 1000).toISOString() : 'unknown'}\n`;
              onChainData += `  FDV: $${t.fdv || t.market_cap || '?'}\n`;
              onChainData += `  Holders: ${t.holder_count || '?'}\n`;
              onChainData += `  Top10 Hold: ${t.top_10_holder_rate ? (t.top_10_holder_rate * 100).toFixed(1) + '%' : '?'}\n`;
              onChainData += `  Honeypot: ${t.is_honeypot ?? 'unknown'}\n`;
              onChainData += `  Launchpad: ${t.launchpad || 'unknown'}\n`;
            }
          }
        } catch {}

        try {
          const w = runtime.getWallet();
          const conn = w.getConnection();
          const { PublicKey } = await import('@solana/web3.js');
          const mintInfo = await conn.getParsedAccountInfo(new PublicKey(tokenMint));
          const parsed = (mintInfo?.value?.data as any)?.parsed?.info;
          if (parsed) {
            onChainData += `\nOn-chain mint info:\n`;
            onChainData += `  Supply: ${parsed.supply}\n`;
            onChainData += `  Decimals: ${parsed.decimals}\n`;
            onChainData += `  Mint Authority: ${parsed.mintAuthority || 'disabled'}\n`;
            onChainData += `  Freeze Authority: ${parsed.freezeAuthority || 'disabled'}\n`;
          }
        } catch {}
      }

      if (toAddress) {
        try {
          const w = runtime.getWallet();
          const conn = w.getConnection();
          const { PublicKey } = await import('@solana/web3.js');
          const accInfo = await conn.getAccountInfo(new PublicKey(toAddress));
          onChainData += `\nRecipient account:\n`;
          onChainData += `  Exists: ${!!accInfo}\n`;
          if (accInfo) {
            onChainData += `  Balance: ${accInfo.lamports / 1e9} SOL\n`;
            onChainData += `  Executable: ${accInfo.executable}\n`;
            onChainData += `  Owner: ${accInfo.owner.toBase58()}\n`;
          }
        } catch {}
      }

      const aiPrompt = `You are a Solana blockchain security expert. Analyze this transaction for drainer/scam/rug-pull risks.

TRANSACTION:
${context}
${onChainData}

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "verdict": "safe" | "suspicious" | "dangerous",
  "confidence": 0-100,
  "summary": "brief 1-2 sentence summary",
  "risks": ["risk1", "risk2"],
  "recommendation": "brief recommendation"
}`;

      const aiResponse = await runtime.chat('commander', aiPrompt);


      let analysis;
      try {
        analysis = JSON.parse(aiResponse);
      } catch {

        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
        } else {
          analysis = {
            verdict: 'unknown',
            confidence: 0,
            summary: aiResponse.slice(0, 200),
            risks: [],
            recommendation: 'Could not parse AI analysis'
          };
        }
      }

      res.json(analysis);
    } catch (err: any) {
      logger.error('ai-drainer-check error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/wallet/swap', async (req, res) => {
    try {
      const { fromMint, toMint, amount, slippage } = req.body;
      if (!fromMint || !toMint || !amount) {
        return res.status(400).json({ error: 'fromMint, toMint, and amount are required' });
      }
      const w = runtime.getWallet();
      if (!w.hasWallet()) return res.status(400).json({ error: 'No wallet configured' });
      const conn = w.getConnection();
      const { VersionedTransaction } = await import('@solana/web3.js');

      const slipBps = Math.round((slippage || 0.5) * 100);


      let decimals = 9;
      if (fromMint !== 'So11111111111111111111111111111111111111112') {
        try {
          const { PublicKey: PK } = await import('@solana/web3.js');
          const mintInfo = await conn.getParsedAccountInfo(new PK(fromMint));
          const parsed = (mintInfo.value?.data as any)?.parsed?.info;
          if (parsed?.decimals !== undefined) decimals = parsed.decimals;
        } catch {  }
      }
      const lamports = Math.round(Number(amount) * Math.pow(10, decimals));


      const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${fromMint}&outputMint=${toMint}&amount=${lamports}&slippageBps=${slipBps}`;
      const quoteResp = await fetch(quoteUrl);
      if (!quoteResp.ok) throw new Error(`Quote failed: ${quoteResp.status}`);
      const quoteData = await quoteResp.json();


      const swapResp = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: w.getAddress(),
          wrapAndUnwrapSol: true,
        }),
      });
      if (!swapResp.ok) {
        const errTxt = await swapResp.text().catch(() => '');
        throw new Error(`Swap API failed: ${swapResp.status} ${errTxt}`);
      }
      const swapData = await swapResp.json() as any;
      const swapTxBase64 = swapData.swapTransaction;
      if (!swapTxBase64) throw new Error('No swap transaction returned');


      const txBuf = Buffer.from(swapTxBase64, 'base64');
      const vtx = VersionedTransaction.deserialize(txBuf);
      const kp = w.getKeypairRaw();
      vtx.sign([kp]);
      const raw = vtx.serialize();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
      await conn.confirmTransaction(sig, 'confirmed');

      logger.info(`Swap executed: ${sig}`);

      _txCache.ts = 0;
      res.json({ signature: sig });
    } catch (err: any) {
      logger.error('Swap error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  const BRIDGE_CHAINS: Record<string, { id: number | string; name: string; nativeToken: string; nativeDecimals: number; nativeAddress: string }> = {
    solana:    { id: 7565164, name: 'Solana',    nativeToken: 'SOL',   nativeDecimals: 9,  nativeAddress: 'So11111111111111111111111111111111111111112' },
    ethereum:  { id: 1,       name: 'Ethereum',  nativeToken: 'ETH',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    bsc:       { id: 56,      name: 'BSC',       nativeToken: 'BNB',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    polygon:   { id: 137,     name: 'Polygon',   nativeToken: 'POL',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    arbitrum:  { id: 42161,   name: 'Arbitrum',  nativeToken: 'ETH',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    avalanche: { id: 43114,   name: 'Avalanche', nativeToken: 'AVAX',  nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    base:      { id: 8453,    name: 'Base',      nativeToken: 'ETH',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
    optimism:  { id: 10,      name: 'Optimism',  nativeToken: 'ETH',   nativeDecimals: 18, nativeAddress: '0x0000000000000000000000000000000000000000' },
  };


  const BRIDGE_TOKENS: Record<string, Record<string, { address: string; decimals: number }>> = {
    solana: {
      SOL:  { address: 'So11111111111111111111111111111111111111112', decimals: 9 },
      USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      USDT: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    },
    ethereum: {
      ETH:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    },
    bsc: {
      BNB:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    },
    polygon: {
      POL:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    },
    arbitrum: {
      ETH:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    },
    avalanche: {
      AVAX: { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
      USDT: { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
    },
    base: {
      ETH:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    },
    optimism: {
      ETH:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
      USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
      USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    },
  };


  app.get('/api/wallet/bridge/chains', (_req, res) => {
    const chains = Object.entries(BRIDGE_CHAINS).map(([key, ch]) => ({
      key,
      ...ch,
      tokens: Object.entries(BRIDGE_TOKENS[key] || {}).map(([symbol, t]) => ({ symbol, ...t })),
    }));
    res.json({ chains });
  });


  app.get('/api/wallet/bridge/quote', async (req, res) => {
    try {
      const { fromChain, toChain, fromToken, toToken, amount } = req.query;
      if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
        return res.status(400).json({ error: 'fromChain, toChain, fromToken, toToken, amount required' });
      }
      const src = BRIDGE_CHAINS[fromChain as string];
      const dst = BRIDGE_CHAINS[toChain as string];
      if (!src || !dst) return res.status(400).json({ error: 'Unsupported chain' });

      const srcToken = BRIDGE_TOKENS[fromChain as string]?.[fromToken as string];
      const dstToken = BRIDGE_TOKENS[toChain as string]?.[toToken as string];
      if (!srcToken || !dstToken) return res.status(400).json({ error: 'Unsupported token' });

      const rawAmount = BigInt(Math.round(Number(amount) * Math.pow(10, srcToken.decimals))).toString();

      const url = `https://dln.debridge.finance/v1.0/dln/order/quote-and-create-order?` +
        `srcChainId=${src.id}&srcChainTokenIn=${srcToken.address}` +
        `&srcChainTokenInAmount=${rawAmount}` +
        `&dstChainId=${dst.id}&dstChainTokenOut=${dstToken.address}` +
        `&prependOperatingExpenses=true`;

      const resp = await fetch(url);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return res.status(resp.status).json({ error: `deBridge quote failed: ${resp.status}`, detail: txt });
      }
      const data = await resp.json() as any;


      const est = data.estimation;
      const dstOut = est?.dstChainTokenOut;
      const outAmount = dstOut ? Number(dstOut.recommendedAmount || dstOut.amount) / Math.pow(10, dstOut.decimals) : 0;

      const inUsd = Number(est?.srcChainTokenIn?.originApproximateUsdValue || 0);
      const outUsd = Number(dstOut?.recommendedApproximateUsdValue || dstOut?.approximateUsdValue || 0);
      const fee = inUsd > 0 && outUsd > 0 ? (inUsd - outUsd) : 0;

      res.json({
        outAmount,
        outSymbol: dstOut?.symbol || toToken,
        feeUsd: fee.toFixed(2),
        estimatedTime: '1-3 min',
        raw: data,
      });
    } catch (err: any) {
      logger.error('Bridge quote error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


  const LIFI_CHAIN_IDS: Record<string, number | string> = {
    solana: 1151111081099710,
    ethereum: 1, bsc: 56, polygon: 137,
    arbitrum: 42161, base: 8453, optimism: 10, avalanche: 43114,
  };


  async function fetchDebridgeRoute(src: typeof BRIDGE_CHAINS[string], dst: typeof BRIDGE_CHAINS[string],
    srcToken: { address: string; decimals: number }, dstToken: { address: string; decimals: number },
    rawAmount: string, toTokenSymbol: string) {
    const url = `https://dln.debridge.finance/v1.0/dln/order/quote-and-create-order?` +
      `srcChainId=${src.id}&srcChainTokenIn=${srcToken.address}` +
      `&srcChainTokenInAmount=${rawAmount}` +
      `&dstChainId=${dst.id}&dstChainTokenOut=${dstToken.address}` +
      `&prependOperatingExpenses=true`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const est = data.estimation;
    const dstOut = est?.dstChainTokenOut;
    const outAmount = dstOut ? Number(dstOut.recommendedAmount || dstOut.amount) / Math.pow(10, dstOut.decimals) : 0;
    const inUsd = Number(est?.srcChainTokenIn?.originApproximateUsdValue || 0);
    const outUsd = Number(dstOut?.recommendedApproximateUsdValue || dstOut?.approximateUsdValue || 0);
    const fee = inUsd > 0 && outUsd > 0 ? (inUsd - outUsd) : 0;
    return {
      aggregator: 'deBridge',
      outAmount,
      outSymbol: dstOut?.symbol || toTokenSymbol,
      feeUsd: fee.toFixed(2),
      estimatedTime: '1-3 min',
      estimatedSeconds: 120,
      raw: data,
    };
  }


  async function fetchLiFiRoute(fromChainKey: string, toChainKey: string,
    srcToken: { address: string; decimals: number }, dstToken: { address: string; decimals: number },
    rawAmount: string, toTokenSymbol: string) {
    const srcChainId = LIFI_CHAIN_IDS[fromChainKey];
    const dstChainId = LIFI_CHAIN_IDS[toChainKey];
    if (!srcChainId || !dstChainId) return null;
    const url = `https://li.quest/v1/quote?fromChainId=${srcChainId}&toChainId=${dstChainId}` +
      `&fromToken=${srcToken.address}&toToken=${dstToken.address}` +
      `&fromAmount=${rawAmount}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const est = data.estimate;
    if (!est) return null;
    const outAmount = Number(est.toAmount || 0) / Math.pow(10, dstToken.decimals);
    const gasCostUsd = Number(est.gasCosts?.[0]?.amountUSD || 0);
    const feeCostUsd = est.feeCosts?.reduce((s: number, f: any) => s + Number(f.amountUSD || 0), 0) || 0;
    const fee = gasCostUsd + feeCostUsd;
    const execTime = data.estimate?.executionDuration || 180;
    const mins = Math.ceil(execTime / 60);
    return {
      aggregator: 'Li.Fi',
      outAmount,
      outSymbol: data.action?.toToken?.symbol || toTokenSymbol,
      feeUsd: fee.toFixed(2),
      estimatedTime: mins <= 1 ? '~1 min' : `~${mins} min`,
      estimatedSeconds: execTime,
      raw: data,
    };
  }


  async function fetchSocketRoute(fromChainKey: string, toChainKey: string,
    srcToken: { address: string; decimals: number }, dstToken: { address: string; decimals: number },
    rawAmount: string, toTokenSymbol: string, senderAddress: string) {

    const srcChainId = LIFI_CHAIN_IDS[fromChainKey];
    const dstChainId = LIFI_CHAIN_IDS[toChainKey];
    if (!srcChainId || !dstChainId) return null;

    if (fromChainKey === 'solana' || toChainKey === 'solana') return null;
    const url = `https://api.socket.tech/v2/quote?fromChainId=${srcChainId}&toChainId=${dstChainId}` +
      `&fromTokenAddress=${srcToken.address}&toTokenAddress=${dstToken.address}` +
      `&fromAmount=${rawAmount}&userAddress=${senderAddress || '0x0000000000000000000000000000000000000001'}` +
      `&sort=output&singleTxOnly=true`;
    const resp = await fetch(url, {
      headers: { 'API-KEY': '72a5b4b0-e727-48be-8aa1-5da9d62fe635' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const route = data.result?.routes?.[0];
    if (!route) return null;
    const outAmount = Number(route.toAmount || 0) / Math.pow(10, dstToken.decimals);
    const fee = Number(route.totalGasFeesInUsd || 0);
    const secs = Number(route.serviceTime || 180);
    const mins = Math.ceil(secs / 60);
    return {
      aggregator: 'Socket',
      outAmount,
      outSymbol: toTokenSymbol,
      feeUsd: fee.toFixed(2),
      estimatedTime: mins <= 1 ? '~1 min' : `~${mins} min`,
      estimatedSeconds: secs,
      raw: data,
    };
  }


  app.get('/api/wallet/bridge/routes', async (req, res) => {
    try {
      const { fromChain, toChain, fromToken, toToken, amount, sender } = req.query;
      if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
        return res.status(400).json({ error: 'fromChain, toChain, fromToken, toToken, amount required' });
      }
      const src = BRIDGE_CHAINS[fromChain as string];
      const dst = BRIDGE_CHAINS[toChain as string];
      if (!src || !dst) return res.status(400).json({ error: 'Unsupported chain' });

      const srcToken = BRIDGE_TOKENS[fromChain as string]?.[fromToken as string];
      const dstToken = BRIDGE_TOKENS[toChain as string]?.[toToken as string];
      if (!srcToken || !dstToken) return res.status(400).json({ error: 'Unsupported token' });

      const rawAmount = BigInt(Math.round(Number(amount) * Math.pow(10, srcToken.decimals))).toString();


      const promises = [
        fetchDebridgeRoute(src, dst, srcToken, dstToken, rawAmount, toToken as string).catch(() => null),
        fetchLiFiRoute(fromChain as string, toChain as string, srcToken, dstToken, rawAmount, toToken as string).catch(() => null),
        fetchSocketRoute(fromChain as string, toChain as string, srcToken, dstToken, rawAmount, toToken as string, sender as string || '').catch(() => null),
      ];

      const results = await Promise.allSettled(promises);
      const routes = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter((r): r is NonNullable<typeof r> => r !== null && r.outAmount > 0);


      routes.sort((a, b) => b.outAmount - a.outAmount);


      if (routes.length > 0) {
        (routes[0] as any).tags = ['best'];
        const fastest = routes.reduce((f, r) => r.estimatedSeconds < f.estimatedSeconds ? r : f, routes[0]);
        if (fastest !== routes[0]) {
          (fastest as any).tags = [...((fastest as any).tags || []), 'fast'];
        }
      }

      res.json({ routes });
    } catch (err: any) {
      logger.error('Bridge routes error:', err.message);
      res.status(500).json({ error: err.message, routes: [] });
    }
  });


  app.post('/api/wallet/bridge', async (req, res) => {
    try {
      const { fromChain, toChain, fromToken, toToken, amount, toAddress } = req.body;
      if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
        return res.status(400).json({ error: 'fromChain, toChain, fromToken, toToken, amount required' });
      }
      const w = runtime.getWallet();
      if (!w.hasWallet()) return res.status(400).json({ error: 'No wallet configured' });

      const src = BRIDGE_CHAINS[fromChain];
      const dst = BRIDGE_CHAINS[toChain];
      if (!src || !dst) return res.status(400).json({ error: 'Unsupported chain' });

      const srcToken = BRIDGE_TOKENS[fromChain]?.[fromToken];
      const dstToken = BRIDGE_TOKENS[toChain]?.[toToken];
      if (!srcToken || !dstToken) return res.status(400).json({ error: 'Unsupported token' });


      const dstAddress = toChain === 'solana' ? w.getAddress() : toAddress;
      if (!dstAddress) return res.status(400).json({ error: 'Destination address (toAddress) required for cross-chain bridge' });

      const rawAmount = BigInt(Math.round(Number(amount) * Math.pow(10, srcToken.decimals))).toString();
      const srcAddress = w.getAddress();


      if (fromChain !== 'solana') {
        const url = `https://dln.debridge.finance/v1.0/dln/order/quote-and-create-order?` +
          `srcChainId=${src.id}&srcChainTokenIn=${srcToken.address}` +
          `&srcChainTokenInAmount=${rawAmount}` +
          `&dstChainId=${dst.id}&dstChainTokenOut=${dstToken.address}` +
          `&dstChainTokenOutRecipient=${encodeURIComponent(dstAddress)}` +
          `&srcChainOrderAuthorityAddress=${encodeURIComponent(toAddress || '')}` +
          `&prependOperatingExpenses=true&affiliateFeePercent=0`;
        const resp = await fetch(url);
        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          throw new Error(`deBridge create-tx failed: ${resp.status} ${txt.slice(0, 200)}`);
        }
        const data = await resp.json() as any;

        return res.json({
          requiresEvmSign: true,
          tx: data.tx,
          orderId: data.orderId || null,
          chainId: src.id,
        });
      }

      const url = `https://dln.debridge.finance/v1.0/dln/order/quote-and-create-order?` +
        `srcChainId=${src.id}&srcChainTokenIn=${srcToken.address}` +
        `&srcChainTokenInAmount=${rawAmount}` +
        `&dstChainId=${dst.id}&dstChainTokenOut=${dstToken.address}` +
        `&dstChainTokenOutRecipient=${encodeURIComponent(dstAddress)}` +
        `&srcChainOrderAuthorityAddress=${srcAddress}` +
        `&prependOperatingExpenses=true&affiliateFeePercent=0`;

      const resp = await fetch(url);
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`deBridge create-tx failed: ${resp.status} ${txt.slice(0, 200)}`);
      }
      const data = await resp.json() as any;
      const txData = data.tx?.data;
      if (!txData) throw new Error('No transaction data returned from deBridge');


      const { VersionedTransaction } = await import('@solana/web3.js');
      let txBuf: Buffer;

      try {
        txBuf = Buffer.from(txData, 'base64');

        VersionedTransaction.deserialize(txBuf);
      } catch {

        const bs58 = (await import('bs58')).default;
        txBuf = Buffer.from(bs58.decode(txData));
      }

      const vtx = VersionedTransaction.deserialize(txBuf);
      const kp = w.getKeypairRaw();
      vtx.sign([kp]);

      const conn = w.getConnection();
      const raw = vtx.serialize();
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
      await conn.confirmTransaction(sig, 'confirmed');

      logger.info(`Bridge executed: ${sig} (${fromChain}/${fromToken} Ã¢â€ â€™ ${toChain}/${toToken}, deBridge)`);
      _txCache.ts = 0;
      res.json({ txHash: sig, orderId: data.orderId || null });
    } catch (err: any) {
      logger.error('Bridge error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });


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

  const _portfolioPnlCache = new Map<string, { data: any; ts: number }>();
  const _gmgnActivityCache = new Map<string, { data: any; ts: number }>();

  function getPeriodMs(period: string): number {
    switch (period) {
      case '24h': return 24 * 60 * 60 * 1000;
      case '7d': return 7 * 24 * 60 * 60 * 1000;
      case '30d': return 30 * 24 * 60 * 60 * 1000;
      default: return 7 * 24 * 60 * 60 * 1000;
    }
  }

  async function fetchPortfolioPnlSummary(address: string, period = '7d'): Promise<any> {
    const cacheKey = `${address}:${period}`;
    const cached = _portfolioPnlCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < 30_000) return cached.data;

    const wallet = runtime.getWallet();
    const nativeBalance = wallet.hasWallet() ? await wallet.getBalance().catch(() => 0) : 0;
    const since = now - getPeriodMs(period);
    const trades = runtime.getMemory().getTradeHistory({ since }) as any[];
    const successfulTrades = trades.filter(t => t && t.success);
    const buys = successfulTrades.filter(t => t.action === 'buy');
    const sells = successfulTrades.filter(t => t.action === 'sell');
    const localBought = buys.reduce((sum, trade) => sum + Number(trade.amount_sol || 0), 0);
    const localSold = sells.reduce((sum, trade) => sum + Number(trade.amount_sol || 0), 0);
    const localProfit = localSold - localBought;
    const localPnl = localBought > 0 ? localProfit / localBought : null;
    const localSummary = {
      address,
      period,
      native_balance: String(nativeBalance || 0),
      realized_profit: String(localProfit),
      realized_profit_pnl: localPnl,
      unrealized_profit: '0',
      unrealized_profit_pnl: null,
      total_profit: String(localProfit),
      total_profit_pnl: localPnl,
      buy: buys.length,
      sell: sells.length,
      total_bought_cost: String(localBought),
      total_sold_income: String(localSold),
      source: 'local',
    };

    try {
      const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm';
      const tzOffset = -new Date().getTimezoneOffset() * 60;
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const appVer = `${datePart}-12279-c315e4d`;
      const deviceId = '17d36dea-7b0f-41a5-b075-55e05ac80fed';
      const fpDid = '658c1cb4de30106c298c464bd5273547';
      const clientId = `gmgn_web_${appVer}`;
      const params = new URLSearchParams({
        device_id: deviceId,
        fp_did: fpDid,
        client_id: clientId,
        from_app: 'gmgn',
        app_ver: appVer,
        tz_name: tzName,
        tz_offset: String(tzOffset),
        app_lang: 'ru',
        os: 'web',
        worker: '0',
      });
      const url = `https://gmgn.ai/defi/quotation/v1/wallet/sol/wallet_activity/${address}?period=${period}&${params.toString()}`;

      const { execSync } = await import('child_process');
      const allActivities: any[] = [];
      let next: string | null = null;
      let cursor = '';
      const pageLimit = 50;
      for (let page = 1; page <= 10; page++) {
        const pageUrl = cursor ? `${url}&cursor=${cursor}&limit=${pageLimit}` : `${url}&limit=${pageLimit}`;
        const curlCmd = `curl.exe -s --max-time 12 "${pageUrl}" -H "Accept: application/json, text/plain, */*" -H "Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" -H "Origin: https://gmgn.ai" -H "Referer: https://gmgn.ai/"`;
        try {
        const stdout = execSync(curlCmd, { encoding: 'utf-8', timeout: 18000 });
        const payload = JSON.parse(stdout);
        if (payload?.code !== 0 || !payload?.data) {
          logger.warn(`GMGN wallet_activity page ${page}: code=${payload?.code}, msg=${payload?.message}`);
          break;
        }
        const activities = payload.data.activities || [];
        allActivities.push(...activities);
        next = payload.data.next || null;
        cursor = next || '';
        if (!next || activities.length < pageLimit) break;
      } catch (err: any) {
        logger.warn(`GMGN wallet_activity page ${page} error: ${err.message}`);
        break;
      }
    }

      const result = { activities: allActivities, next, total: allActivities.length };
      _portfolioPnlCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    } catch {
      _portfolioPnlCache.set(cacheKey, { data: localSummary, ts: Date.now() });
      return localSummary;
    }
  }

  async function fetchGmgnWalletActivity(address: string, opts: { limit: number; cursor: string; maxPages: number }) {
    const { limit, cursor: initCursor, maxPages } = opts;
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Stockholm';
    const tzOffset = -new Date().getTimezoneOffset() * 60;
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const appVer = `${datePart}-12279-c315e4d`;
    const deviceId = '17d36dea-7b0f-41a5-b075-55e05ac80fed';
    const fpDid = '658c1cb4de30106c298c464bd5273547';
    const clientId = `gmgn_web_${appVer}`;
    const params = new URLSearchParams({
      device_id: deviceId, fp_did: fpDid, client_id: clientId,
      from_app: 'gmgn', app_ver: appVer, tz_name: tzName,
      tz_offset: String(tzOffset), app_lang: 'ru', os: 'web', worker: '0',
    });
    const baseUrl = `https://gmgn.ai/defi/quotation/v1/wallet/sol/wallet_activity/${address}?${params.toString()}`;
    const { execSync } = await import('child_process');
    const allActivities: any[] = [];
    let next: string | null = null;
    let cursor = initCursor;
    for (let page = 1; page <= maxPages; page++) {
      const pageUrl = cursor
        ? `${baseUrl}&cursor=${encodeURIComponent(cursor)}&limit=${limit}`
        : `${baseUrl}&limit=${limit}`;
      const curlCmd = `curl.exe -s --max-time 12 "${pageUrl}" -H "Accept: application/json, text/plain, */*" -H "Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" -H "Origin: https://gmgn.ai" -H "Referer: https://gmgn.ai/"`;
      try {
        const stdout = execSync(curlCmd, { encoding: 'utf-8', timeout: 18000 });
        const payload = JSON.parse(stdout);
        if (payload?.code !== 0 || !payload?.data) break;
        const activities = payload.data.activities || [];
        allActivities.push(...activities);
        next = payload.data.next || null;
        cursor = next || '';
        if (!next || activities.length < limit) break;
      } catch { break; }
    }
    return { activities: allActivities, next, total: allActivities.length };
  }


  app.get('/api/portfolio/activity', async (req, res) => {
    try {
      const walletParam = req.query.wallet as string | undefined;
      const address = walletParam || runtime.getWallet().getAddress();
      if (!address) return res.json({ activities: [], next: null, total: 0 });

      const cursor = req.query.cursor as string || '';
      const limit = Math.min(Number(req.query.limit) || 50, 50);
      const maxPages = Math.min(Number(req.query.pages) || 1, 20);


      const cacheKey = `activity:${address}:${cursor}:${limit}`;
      if (maxPages === 1) {
        const cached = _gmgnActivityCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 15_000) return res.json(cached.data);
      }

      const result = await fetchGmgnWalletActivity(address, { limit, cursor, maxPages });
      if (maxPages === 1) _gmgnActivityCache.set(cacheKey, { data: result, ts: Date.now() });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/stats', (_req, res) => {
    res.json(runtime.getSessionStats());
  });

  app.get('/api/stats/:period', (req, res) => {
    const period = req.params.period as '1h' | '4h' | '24h' | '7d' | 'all';
    const stats = runtime.getMemory().getStats(period);
    res.json(stats);
  });


  app.get('/api/trades', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const mint = req.query.mint as string | undefined;
    const trades = runtime.getMemory().getTradeHistory({ limit, mint });
    res.json(trades);
  });


  app.get('/api/tokens/trending', (_req, res) => {
    const trending = runtime.getMemory().getTokenStore().getTrendingTokens(20);
    res.json(trending);
  });


  app.get('/api/trending/feed', async (req, res) => {
    try {
      const period = (req.query.period as string) || '1h';
      const limit = Math.min(Number(req.query.limit) || 30, 50);
      const skillLoader = runtime.getSkillLoader();


      const [topRunners, featured] = await Promise.allSettled([
        skillLoader.executeTool('get_trending_tokens', { limit: 30 }),
        skillLoader.executeTool('get_featured_tokens', { timeWindow: period, limit: 30 }),
      ]);


      const seen = new Set<string>();
      const merged: any[] = [];

      const addTokens = (result: PromiseSettledResult<any>, source: string) => {
        if (result.status !== 'fulfilled') return;
        const tokens = result.value?.tokens || [];
        for (const t of tokens) {
          if (t.mint && !seen.has(t.mint)) {
            seen.add(t.mint);
            merged.push({ ...t, source });
          }
        }
      };

      addTokens(topRunners, 'top_runners');
      addTokens(featured, 'featured');


      const mints = merged.slice(0, limit).map((t: any) => t.mint);
      let activity: Record<string, any> = {};
      if (mints.length > 0) {
        try {
          const actResult = await skillLoader.executeTool('batch_get_market_activity', {
            mints,
            intervals: ['5m', '1h'],
          });
          if (actResult?.data && typeof actResult.data === 'object') {
            activity = actResult.data;
          }
        } catch {}
      }


      const tokenStore = runtime.getMemory().getTokenStore();
      const now = Date.now();

      const enriched = merged.slice(0, limit).map((t: any) => {
        const act = activity[t.mint] || {};
        const act5m = act['5m'] || {};
        const act1h = act['1h'] || {};
        return {
          mint: t.mint,
          name: t.name,
          symbol: t.symbol,
          image: t.image,
          dev: t.dev,
          createdAt: t.createdAt,
          marketCap: t.marketCap || 0,
          bondingCurveProgress: t.bondingCurveProgress || 0,
          price: t.price || 0,
          twitter: t.twitter || null,
          telegram: t.telegram || null,
          website: t.website || null,
          source: t.source,
          activity: {
            '5m': {
              volume: act5m.volumeUSD || 0,
              buys: act5m.numBuys || 0,
              sells: act5m.numSells || 0,
              buyers: act5m.numBuyers || 0,
              sellers: act5m.numSellers || 0,
              priceChange: act5m.priceChangePercent || 0,
            },
            '1h': {
              volume: act1h.volumeUSD || 0,
              buys: act1h.numBuys || 0,
              sells: act1h.numSells || 0,
              buyers: act1h.numBuyers || 0,
              sellers: act1h.numSellers || 0,
              priceChange: act1h.priceChangePercent || 0,
            },
          },
        };
      });

      const feed = enriched.filter((t: any) => {
        const vol1h = t.activity?.['1h']?.volume || 0;
        const vol5m = t.activity?.['5m']?.volume || 0;
        const mcap = t.marketCap || 0;
        const ageMs = now - (t.createdAt || now);
        const ageHours = ageMs / 3_600_000;
        if (ageHours > 168 && (vol1h < 50_000 || mcap < 500_000)) return false;
        if (ageHours > 48 && (vol1h < 10_000 || mcap < 100_000)) return false;
        if (ageHours > 24 && vol1h < 5_000 && mcap < 50_000) return false;
        if (vol1h < 100 && vol5m < 10 && mcap < 5_000) return false;
        return true;
      });

      for (const t of feed) {
        try {
          tokenStore.store({
            mint: t.mint, name: t.name || '', symbol: t.symbol || '',
            description: '', image: t.image || '',
            twitter: t.twitter || '', telegram: t.telegram || '',
            website: t.website || '', dev: t.dev || '',
            createdAt: t.createdAt || now,
            bondingCurveProgress: t.bondingCurveProgress || 0,
            marketCap: t.marketCap || 0, volume24h: 0,
            holders: 0, price: t.price || 0,
          });
        } catch {}
      }

      res.json({ period, count: feed.length, feed });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
    const needsEnrich = !token || !token.volume24h || !token.holders || (!token.twitter && !token.telegram);

    if (needsEnrich) {


      try {
                const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
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


      let holderCount = 0;
      const [gmgnResult, rugResult] = await Promise.allSettled([
                fetch(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${encodeURIComponent(mint)}`, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://gmgn.ai/', 'Origin': 'https://gmgn.ai' },
          signal: AbortSignal.timeout(8000),
        }).then(r => r.ok ? r.json() as Promise<any> : null),
                fetch(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        }).then(r => r.ok ? r.json() as Promise<any> : null),
      ]);


      try {
        const rug = rugResult.status === 'fulfilled' ? rugResult.value as any : null;
        if (rug && rug.totalHolders) {
          holderCount = rug.totalHolders;
          if (token && !token.holders) token.holders = holderCount;
        }
      } catch {}


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
              holderCount = accounts.length;
              if (token && !token.holders) token.holders = holderCount;
            }
          }
        } catch {}
      }


      try {
        const gmRaw = gmgnResult.status === 'fulfilled' ? gmgnResult.value as any : null;
        const t = gmRaw?.data?.token;
        if (t) {
          const vol24h = t.volume_24h || 0;
          const mcap = t.market_cap || t.fdv || 0;
          const gmPrice = t.price || 0;
          const gmHolders = t.holder_count || 0;
          if (gmHolders && !holderCount) holderCount = gmHolders;


          if (!token) {
            token = {
              mint: t.address || mint,
              name: t.name || '',
              symbol: t.symbol || '',
              description: '',
              image: t.logo || '',
              twitter: t.twitter_username || '',
              telegram: t.telegram || '',
              website: t.website || '',
              dev: t.creator_address || '',
              createdAt: t.open_timestamp ? t.open_timestamp * 1000 : t.creation_timestamp ? t.creation_timestamp * 1000 : Date.now(),
              bondingCurveProgress: t.launchpad === 'pump.fun' && t.pool_address ? 100 : (t.launchpad ? 100 : 0),
              marketCap: mcap,
              volume24h: vol24h,
              holders: holderCount || gmHolders,
              price: gmPrice,
            };
            runtime.getMemory().getTokenStore().store(token);
          } else {
            if (vol24h) token.volume24h = vol24h;
            if (mcap && mcap > (token.marketCap || 0)) token.marketCap = mcap;
            if (gmPrice) token.price = gmPrice;
            if (holderCount && !token.holders) token.holders = holderCount;
            if (gmHolders && !token.holders) token.holders = gmHolders;
          }


          runtime.getMemory().getTokenStore().storeSnapshot({
            mint,
            price: token.price || 0,
            mcap: token.marketCap || 0,
            volume5m: t.volume_5m || 0,
            volume1h: t.volume_1h || 0,
            volume24h: vol24h,
            holders: holderCount || gmHolders,
            bondingProgress: token.bondingCurveProgress || 0,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        logger.warn(`GMGN processing failed for ${mint}: ${err}`);
      }
    }

    if (!token || !token.volume24h || !token.holders || (!token.twitter && !token.telegram)) {
      try {
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (dexRes.ok) {
          const dexData = await dexRes.json() as any;
          const pair = dexData?.pairs?.[0];
          if (pair) {
            const baseToken = pair.baseToken || {};
            const socials = pair.info?.socials || [];
            const dexTwitter = socials.find((s: any) => s.type === 'twitter')?.url || '';
            const dexTelegram = socials.find((s: any) => s.type === 'telegram')?.url || '';
            const dexWebsite = pair.info?.websites?.[0]?.url || '';
            const dexVol24 = pair.volume?.h24 || 0;
            const dexMcap = pair.marketCap || pair.fdv || 0;
            const dexPrice = parseFloat(pair.priceUsd) || 0;
            if (token) {
              if (!token.volume24h && dexVol24) token.volume24h = dexVol24;
              if (!token.twitter && dexTwitter) token.twitter = dexTwitter;
              if (!token.telegram && dexTelegram) token.telegram = dexTelegram;
              if (!token.website && dexWebsite) token.website = dexWebsite;
              if (dexMcap && dexMcap > (token.marketCap || 0)) token.marketCap = dexMcap;
              if (dexPrice) token.price = dexPrice;
            } else {
              token = {
                mint: baseToken.address || mint,
                name: baseToken.name || '',
                symbol: baseToken.symbol || '',
                description: '',
                image: pair.info?.imageUrl || '',
                twitter: dexTwitter,
                telegram: dexTelegram,
                website: dexWebsite,
                dev: '',
                createdAt: pair.pairCreatedAt || Date.now(),
                bondingCurveProgress: 100,
                marketCap: dexMcap,
                volume24h: dexVol24,
                holders: 0,
                price: dexPrice,
              };
            }
            runtime.getMemory().getTokenStore().store(token);
          }
        }
      } catch {}
    }

    if (!token) return res.status(404).json({ error: 'Token not found' });
    const analysis = runtime.getMemory().getAnalysis(mint);
    const holders = runtime.getMemory().getHolderData(mint);
    res.json({ token, analysis, holders });
  });


  app.post('/api/chat', async (req, res) => {
    try {
      const { agent, message, chatId, image: rawImage, projectFolder } = req.body;
      if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
      if (message.length > 100000) return res.status(400).json({ error: 'Message too long (max 100K chars)' });
      const agentId = (typeof agent === 'string' && agent) ? agent.slice(0, 50) : 'commander';
      const image = typeof rawImage === 'string' && rawImage.length < 4_000_000 ? rawImage : undefined;
      const sessionId = chatId ? String(chatId).slice(0, 100) : '';


      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      if (projectsSkill?.setChatId && chatId) projectsSkill.setChatId(String(chatId).slice(0, 100));
      if (projectsSkill?.setProjectFolder) projectsSkill.setProjectFolder(projectFolder ? String(projectFolder).slice(0, 500) : '');


      const filterAgentId = sessionId || agentId;


      const steps: { type: string; tool?: string; params?: any; round?: number; result?: string; durationMs?: number }[] = [];
      const eventBus = runtime.getEventBus();
      const toolCallHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        steps.push({ type: 'tool_call', tool: data.tool, params: data.params, round: data.round });
      };
      const toolResultHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        steps.push({ type: 'tool_result', tool: data.tool, result: data.result, durationMs: data.durationMs });
      };
      const thinkingHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        steps.push({ type: 'thinking', round: data.round, tool: undefined });
      };
      eventBus.on('agent:tool_call' as any, toolCallHandler);
      eventBus.on('agent:tool_result' as any, toolResultHandler);
      eventBus.on('agent:llm_response' as any, thinkingHandler);


      const response = sessionId
        ? await runtime.sessionChat(sessionId, message, agentId, image)
        : await runtime.chat(agentId, message, image);

      eventBus.off('agent:tool_call' as any, toolCallHandler);
      eventBus.off('agent:tool_result' as any, toolResultHandler);
      eventBus.off('agent:llm_response' as any, thinkingHandler);

      res.json({ agent: agentId, response, steps });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


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
- GET /api/status Ã¢â‚¬â€ { wallet, balance, session: {mode, status}, uptime, agents[], skills[] }
- GET /api/stats/24h Ã¢â‚¬â€ { totalPnlSol, tradesExecuted, tradesWon, tradesLost, peakPnlSol, worstDrawdownSol }
- GET /api/portfolio Ã¢â‚¬â€ { positions[], trades[] }
- GET /api/events?limit=20 Ã¢â‚¬â€ recent events array
- GET /api/skills Ã¢â‚¬â€ skills with tools array

Example response:
{"title":"SOL Balance","html":"<div id=\\"wb\\"><span style=\\"color:var(--muted);font-size:.75rem\\">Balance</span><div id=\\"wbVal\\" style=\\"font-size:1.5rem;font-weight:800;color:var(--green)\\">...</div></div>","js":"function loadBal(){api('/api/status').then(function(s){document.getElementById('wbVal').textContent=(s.balance||0).toFixed(4)+' SOL'}).catch(function(){})}loadBal();","css":"","refreshInterval":30}`;

      const aiMsg = `Generate a dashboard widget: ${prompt}`;
      const response = await runtime.chat('commander', `[SYSTEM INSTRUCTION Ã¢â‚¬â€ you are a widget code generator, respond ONLY with raw JSON, no markdown]\n\n${systemPrompt}\n\nUser request: ${aiMsg}`);


      let widget;
      try {

        widget = JSON.parse(response);
      } catch {

        const jsonMatch = response.match(/\{[\s\S]*"title"[\s\S]*"html"[\s\S]*\}/);
        if (jsonMatch) {
          widget = JSON.parse(jsonMatch[0]);
        } else {
          return res.status(422).json({ error: 'AI did not return valid widget JSON. Try rephrasing your request.', raw: response.slice(0, 500) });
        }
      }


      if (!widget.title || !widget.html) {
        return res.status(422).json({ error: 'Widget missing required fields (title, html)' });
      }


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


  app.post('/api/chat/stop', (req, res) => {
    const agentId = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 50) : 'commander';
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.slice(0, 100) : '';
    const ok = chatId ? runtime.sessionCancel(chatId) : runtime.cancelChat(agentId);
    res.json({ cancelled: ok, agentId, chatId });
  });


  app.post('/api/chat/compact', async (req, res) => {
    try {
      const agentId = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 50) : 'commander';
      const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.slice(0, 100) : '';
      const result = chatId
        ? await runtime.sessionCompact(chatId)
        : await runtime.compactChat(agentId);
      res.json({ result, agentId, chatId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/chat/new', (req, res) => {
    const agentId = typeof req.body?.agent === 'string' && req.body.agent ? req.body.agent.slice(0, 50) : 'commander';
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.slice(0, 100) : '';
    logger.info(`[API] /api/chat/new called for agent "${agentId}" chatId="${chatId}"`);
    const result = chatId ? runtime.sessionNew(chatId) : runtime.newChat(agentId);
    logger.info(`[API] /api/chat/new result: ${result}`);
    res.json({ result, agentId, chatId });
  });


  app.get('/api/chat/sessions', (_req, res) => {
    res.json({ sessions: runtime.listSessions() });
  });


  app.delete('/api/chat/sessions/:id', (req, res) => {
    const id = req.params.id;
    const ok = runtime.deleteSession(id);
    res.json({ deleted: ok, id });
  });


  app.get('/api/chat/checkpoints', (req, res) => {
    const agentId = typeof req.query?.agent === 'string' ? req.query.agent.slice(0, 50) : 'commander';
    const chatId = typeof req.query?.chatId === 'string' ? req.query.chatId.slice(0, 100) : '';
    const checkpoints = chatId
      ? runtime.sessionCheckpoints(chatId)
      : runtime.getCheckpoints(agentId);
    res.json({ checkpoints, agentId, chatId });
  });


  app.post('/api/chat/checkpoint/restore', (req, res) => {
    const agentId = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 50) : 'commander';
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.slice(0, 100) : '';
    const checkpointId = typeof req.body?.checkpointId === 'number' ? req.body.checkpointId : 0;
    if (!checkpointId) return res.status(400).json({ error: 'checkpointId required' });
    const result = chatId
      ? runtime.sessionRestoreCheckpoint(chatId, checkpointId)
      : runtime.restoreCheckpoint(agentId, checkpointId);
    if (!result.ok) return res.status(404).json({ error: 'Checkpoint not found' });
    res.json({ ...result, agentId, chatId, checkpointId });
  });


  app.get('/api/chat/diagnostics', (req, res) => {
    const agentId = typeof req.query?.agent === 'string' ? req.query.agent.slice(0, 50) : 'commander';
    const chatId = typeof req.query?.chatId === 'string' ? req.query.chatId.slice(0, 100) : '';
    const diag = chatId
      ? runtime.sessionDiagnostics(chatId)
      : runtime.getAgentDiagnostics(agentId);
    if (!diag) return res.status(404).json({ error: 'Agent not found' });
    res.json(diag);
  });


  app.post('/api/chat/prompt-mode', (req, res) => {
    const agentId = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 50) : 'commander';
    const mode = req.body?.mode;
    if (!mode || !['full', 'minimal', 'none'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be full, minimal, or none' });
    }
    const ok = runtime.setAgentPromptMode(agentId, mode);
    res.json({ ok, agentId, mode });
  });


  app.post('/api/chat/efficiency-mode', (req, res) => {
    const agentId = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 50) : 'commander';
    const mode = req.body?.mode;
    if (!mode || !['economy', 'balanced', 'max'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be economy, balanced, or max' });
    }
    const ok = runtime.setAgentEfficiencyMode(agentId, mode);
    res.json({ ok, agentId, mode });
  });


  app.post('/api/chat/stream', async (req, res) => {
    try {
      const { agent, message, chatId, image: rawImage, projectFolder } = req.body;
      if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
      if (message.length > 100000) return res.status(400).json({ error: 'Message too long (max 100K chars)' });
      const agentId = (typeof agent === 'string' && agent) ? agent.slice(0, 50) : 'commander';
      const image = typeof rawImage === 'string' && rawImage.length < 4_000_000 ? rawImage : undefined;
      const storeKey = chatId ? String(chatId).slice(0, 100) : '';

      const filterAgentId = storeKey || agentId;


      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      if (projectsSkill?.setChatId && chatId) projectsSkill.setChatId(String(chatId).slice(0, 100));
      if (projectsSkill?.setProjectFolder) projectsSkill.setProjectFolder(projectFolder ? String(projectFolder).slice(0, 500) : '');
      if (projectsSkill?.setAgentId) projectsSkill.setAgentId(agentId);


      if (storeKey) {
        chatResponseStore.set(storeKey, {
          status: 'processing',
          agentId,
          events: [],
          startedAt: Date.now(),
        });
      }


      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let clientDisconnected = false;
      res.on('close', () => { clientDisconnected = true; });

      const sendEvent = (type: string, data: any) => {
        const eventObj = { type, ...data };

        if (storeKey) {
          const entry = chatResponseStore.get(storeKey);
          if (entry) entry.events.push(eventObj);
        }
        if (!clientDisconnected) {
          try {
            res.write(`data: ${JSON.stringify(eventObj)}\n\n`);
            if (type === 'response' || type === 'done' || type === 'error') {
              logger.info(`[SSE] sent "${type}" event to client (agent=${agentId}, disconnected=${clientDisconnected})`);
            }
          } catch (writeErr) {
            logger.warn(`[SSE] write error for "${type}" event: ${writeErr}`);
          }
        } else {
          if (type === 'response' || type === 'done' || type === 'error') {
            logger.warn(`[SSE] client disconnected, skipping "${type}" event (agent=${agentId})`);
          }
        }
      };


      const eventBus = runtime.getEventBus();
      const toolHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('tool_call', { tool: data.tool, params: data.params, round: data.round });
      };
      const toolResultHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('tool_result', { tool: data.tool, result: typeof data.result === 'string' ? data.result.slice(0, 500) : JSON.stringify(data.result).slice(0, 500), durationMs: data.durationMs });
      };
      const responseHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('thinking', { round: data.round, toolCalls: data.toolCallsCount, usage: data.usage });
      };

      const tokenHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('token', { token: data.token, final: data.final || false });
      };

      const cycleUsageHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('cycle_usage', { promptTokens: data.promptTokens, completionTokens: data.completionTokens, totalTokens: data.totalTokens, contextWindowTokens: data.contextWindowTokens });
      };

      const fileChangeHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('file_change', { path: data.path, diff: data.diff, tool: data.tool });
      };


      const checkpointHandler = (data: any) => {
        if (data?.agentId !== filterAgentId) return;
        sendEvent('checkpoint', { id: data.id, timestamp: data.timestamp, messageCount: data.messageCount, preview: data.preview });
      };


      const imageHandler = (data: any) => {
        sendEvent('image', { image: data.image, caption: data.caption || '' });
      };

      eventBus.on('agent:tool_call' as any, toolHandler);
      eventBus.on('agent:tool_result' as any, toolResultHandler);
      eventBus.on('agent:llm_response' as any, responseHandler);
      eventBus.on('agent:token' as any, tokenHandler);
      eventBus.on('agent:cycle_usage' as any, cycleUsageHandler);
      eventBus.on('agent:file_change' as any, fileChangeHandler);
      eventBus.on('agent:checkpoint' as any, checkpointHandler);
      eventBus.on('agent:image' as any, imageHandler);

      sendEvent('status', { status: 'thinking', agentId });


      const heartbeatTimer = setInterval(() => {
        if (!clientDisconnected) {
          try { res.write(':keepalive\n\n'); } catch (_) {}
        }
      }, 15000);

      try {
        const response = storeKey
        ? await runtime.sessionChat(storeKey, message, agentId, image)
        : await runtime.chat(agentId, message, image);
        clearInterval(heartbeatTimer);
        sendEvent('response', { agent: agentId, response });

        if (storeKey) {
          const entry = chatResponseStore.get(storeKey);
          if (entry) {
            entry.status = 'done';
            entry.response = response;
          }
        }
      } catch (err: any) {
        clearInterval(heartbeatTimer);
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
      eventBus.off('agent:token' as any, tokenHandler);
      eventBus.off('agent:cycle_usage' as any, cycleUsageHandler);
      eventBus.off('agent:file_change' as any, fileChangeHandler);
      eventBus.off('agent:checkpoint' as any, checkpointHandler);
      eventBus.off('agent:image' as any, imageHandler);

      sendEvent('done', {});
      if (!clientDisconnected) {

        if (storeKey) chatResponseStore.delete(storeKey);
        try { res.end(); } catch (_) {}
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });


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

    if (entry.status !== 'processing') {
      chatResponseStore.delete(chatId);
    }
  });


  app.get('/api/chat/agents', async (_req, res) => {
    try {
      await runtime.ensureAgents();
    } catch (err: any) {
      logger.warn('ensureAgents failed: ' + err.message);
    }
    res.json({
      agents: runtime.getAvailableAgents(),
      models: runtime.getAgentModels(),
      capabilities: runtime.getAgentCapabilities(),
    });
  });


  app.post('/api/agents/reload', async (_req, res) => {
    try {
      const created = await runtime.ensureAgents();
      res.json({ success: created, agents: runtime.getAvailableAgents() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  const jobMgr = runtime.getJobManager();

  app.get('/api/jobs', (_req, res) => {
    const status = typeof _req.query.status === 'string' ? _req.query.status : undefined;
    const tag = typeof _req.query.tag === 'string' ? _req.query.tag : undefined;
    const jobs = jobMgr.listJobs({ status: status as any, tag });
    res.json({ jobs, stats: jobMgr.getStats() });
  });

  app.get('/api/jobs/stats', (_req, res) => {
    res.json(jobMgr.getStats());
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobMgr.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  app.get('/api/jobs/:id/results', (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const results = jobMgr.getJobResults(req.params.id, limit);
    const job = jobMgr.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job_id: job.id, name: job.name, status: job.status, total_runs: job.totalRuns, results });
  });

  app.post('/api/jobs', (req, res) => {
    try {
      const { name, prompt, interval_minutes, duration_minutes, max_runs, delay_minutes, tags, agent_id, priority, depends_on } = req.body;
      if (!name || !prompt) return res.status(400).json({ error: 'name, prompt required' });


      const existing = jobMgr.findDuplicate(String(name), String(prompt));
      if (existing) {
        return res.status(409).json({ error: `Job "${name}" already exists and is ${existing.status} (${existing.id}). Cancel or delete it first.`, existing_job: existing });
      }

      const job = jobMgr.createJob({
        name: String(name).slice(0, 100),
        prompt: String(prompt).slice(0, 5000),
        schedule: 'interval',
        intervalMinutes: Number(interval_minutes) || 3,
        durationMinutes: Number(duration_minutes) || 30,
        maxRuns: Number(max_runs) || undefined,
        delayMinutes: Number(delay_minutes) || undefined,
        agentId: agent_id ? String(agent_id) : undefined,
        tags: Array.isArray(tags) ? tags.map(String).slice(0, 10) : [],
        priority: ['high', 'normal', 'low'].includes(priority) ? priority : undefined,
        dependsOn: Array.isArray(depends_on) ? depends_on.map(String).slice(0, 10) : undefined,
      });
      res.json({ success: true, job });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    const ok = jobMgr.cancelJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Could not cancel job' });
    res.json({ success: true });
  });

  app.post('/api/jobs/:id/pause', (req, res) => {
    const ok = jobMgr.pauseJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Could not pause job' });
    res.json({ success: true });
  });

  app.post('/api/jobs/:id/resume', (req, res) => {
    const ok = jobMgr.resumeJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Could not resume job' });
    res.json({ success: true });
  });

  app.post('/api/jobs/:id/restart', (req, res) => {
    const ok = jobMgr.restartJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Could not restart job (only completed/cancelled/failed jobs can be restarted)' });
    res.json({ success: true });
  });

  app.patch('/api/jobs/:id/priority', (req, res) => {
    const { priority } = req.body;
    if (!['high', 'normal', 'low'].includes(priority)) return res.status(400).json({ error: 'priority must be high, normal, or low' });
    const ok = jobMgr.setJobPriority(req.params.id, priority);
    if (!ok) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true });
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const ok = jobMgr.deleteJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Could not delete job (active/paused jobs must be cancelled first)' });
    res.json({ success: true });
  });

  app.post('/api/jobs/clear-inactive', (_req, res) => {
    const removed = jobMgr.clearInactiveJobs();
    res.json({ success: true, removed });
  });


  app.get('/api/models', async (_req, res) => {
    await refreshOllamaModels();
    res.json(getAvailableModels());
  });


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


  app.post('/api/agents/update', (req, res) => {
    try {
      const { id, name, role, model, skills, autonomy, riskLimits } = req.body;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const validAutonomy = ['autopilot', 'advisor', 'monitor', 'manual'];
      const agentConfig = {
        id,
        name: name || 'Agent',
        role: role || '',
        model: { provider: model?.provider || 'copilot', model: model?.model || 'gpt-4o' },
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


  app.get('/api/strategies', (_req, res) => {
    const strategies = runtime.getStrategyEngine().getAll();
    res.json(strategies);
  });


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
        '- DO NOT change the topic or shift focus. If user says "analyze blockchain transactions" Ã¢â‚¬â€ the result must be about analyzing blockchain transactions, NOT about trading memecoins.',
        '- DO NOT add capabilities the user did not ask for. Only expand on what they actually wrote.',
        '- DO NOT assume the agent is a trading bot unless the user explicitly says so.',
        '- Preserve the user\'s language (Russian prompt Ã¢â€ â€™ Russian output, English Ã¢â€ â€™ English).',
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


  app.get('/api/skills', (_req, res) => {
    const manifests = runtime.getSkillLoader().getAllManifests();
    res.json(manifests);
  });


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


  app.post('/api/projects/undo', (req, res) => {
    try {
      const filePath = req.body?.path;
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      if (!projectsSkill?.execute) return res.status(500).json({ error: 'Projects skill not loaded' });
      projectsSkill.execute('project_undo', { path: filePath }).then((result: any) => {
        res.json(result);
      }).catch((err: any) => {
        res.status(500).json({ error: err.message });
      });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });


  app.get('/api/projects/browse', (req, res) => {
    try {
      const projectsSkill = runtime.getSkillLoader().getSkill('projects') as any;
      const projectFolder = projectsSkill?.getProjectFolder?.() || '';
      const basePath = projectFolder || PROJECTS_ROOT;
      const subPath = (req.query.path as string) || '';
      const query = ((req.query.q as string) || '').toLowerCase();
      const typeFilter = (req.query.type as string) || '';

      const targetDir = subPath ? path.resolve(basePath, subPath) : basePath;
      const resolved = path.resolve(targetDir);


      if (!resolved.startsWith(path.resolve(basePath))) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.json({ basePath, path: resolved, entries: [] });
      }

      const SKIP = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.next', '.venv', 'build', '.cache', '.idea', '.vscode']);
      const entries: Array<{ name: string; path: string; relativePath: string; isDir: boolean; size: number }> = [];


      if (query) {

        const walk = (dir: string, depth: number) => {
          if (depth > 4 || entries.length >= 50) return;
          let items: string[];
          try { items = fs.readdirSync(dir); } catch { return; }
          for (const name of items) {
            if (entries.length >= 50) break;
            if (name.startsWith('.') || SKIP.has(name)) continue;
            const full = path.join(dir, name);
            try {
              const st = fs.statSync(full);
              const isDir = st.isDirectory();
              if (typeFilter === 'file' && isDir && depth < 4) { walk(full, depth + 1); continue; }
              if (typeFilter === 'folder' && !isDir) continue;
              const relPath = path.relative(basePath, full).replace(/\\/g, '/');
              if (name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)) {
                entries.push({ name, path: full, relativePath: relPath, isDir, size: isDir ? 0 : st.size });
              }
              if (isDir && depth < 4) walk(full, depth + 1);
            } catch {  }
          }
        };
        walk(resolved, 0);
      } else {

        let items: string[];
        try { items = fs.readdirSync(resolved); } catch { items = []; }
        for (const name of items) {
          if (name.startsWith('.') || SKIP.has(name)) continue;
          const full = path.join(resolved, name);
          try {
            const st = fs.statSync(full);
            const isDir = st.isDirectory();

            if (typeFilter === 'folder' && !isDir) continue;
            const relPath = path.relative(basePath, full).replace(/\\/g, '/');
            entries.push({ name, path: full, relativePath: relPath, isDir, size: isDir ? 0 : st.size });
          } catch {  }
        }
      }


      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.json({ basePath, path: resolved, entries: entries.slice(0, 50) });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });


  app.get('/api/mcp/servers', (_req, res) => {
    const mcpPath = path.join(PROJECT_ROOT, 'data', 'mcp.json');
    if (!fs.existsSync(mcpPath)) return res.json({ servers: [] });
    try {
      const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      res.json({ servers: config.mcpServers || [] });
    } catch { res.json({ servers: [] }); }
  });

  app.post('/api/mcp/servers', (req, res) => {
    const mcpPath = path.join(PROJECT_ROOT, 'data', 'mcp.json');
    try {
      const servers = req.body?.mcpServers;
      if (!Array.isArray(servers)) return res.status(400).json({ error: 'mcpServers array required' });
      fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');
      res.json({ success: true, message: 'Restart to apply MCP changes' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  app.use('/api/projects/preview', (req, res, next) => {

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


  const activeTerminals = new Map<string, { proc: ChildProcess; output: string[]; alive: boolean }>();
  const PROJECTS_ROOT_ABS = path.resolve('./data/projects');
  const TERMINAL_MAX_OUTPUT = 50_000;

  app.post('/api/desktop/terminal/create', (_req, res) => {
    const id = crypto.randomUUID();

    fs.mkdirSync(PROJECTS_ROOT_ABS, { recursive: true });


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


  app.get('/api/events', (req, res) => {
    const event = req.query.event as EventName | undefined;
    const limit = Number(req.query.limit) || 50;
    const events = runtime.getEventBus().history(event, limit);
    res.json(events);
  });


  app.get('/api/sessions', (_req, res) => {
    const sessions = runtime.getMemory().getRecentSessions(20);
    res.json(sessions);
  });


  app.get('/api/explanations', (_req, res) => {
    const limit = Number((_req as any).query?.limit) || 20;
    res.json(runtime.getDecisionExplainer().getRecentExplanations(limit));
  });

  app.get('/api/explanations/:intentId', (req, res) => {
    const e = runtime.getDecisionExplainer().getExplanation(req.params.intentId);
    if (!e) return res.status(404).json({ error: 'Not found' });
    res.json(e);
  });


  app.get('/api/report/daily', async (_req, res) => {
    try {
      const report = await runtime.getDailyReportGenerator().generateReport();
      res.json({ report });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


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


  app.get('/api/agents/messages', (_req, res) => {
    const coordinator = runtime.getMultiAgentCoordinator();
    if (!coordinator) return res.json([]);
    res.json(coordinator.getMessageLog(50));
  });


  app.get('/api/auto-approve/status', (_req, res) => {
    res.json(runtime.getAutoApprove().getStatus());
  });

  app.post('/api/auto-approve/level', (req, res) => {
    const { level } = req.body;
    if (!['off', 'conservative', 'moderate', 'aggressive', 'full'].includes(level)) {
      return res.status(400).json({ error: 'Invalid level. Use: off, conservative, moderate, aggressive, full' });
    }
    runtime.setAutoApproveLevel(level);

    try {
      const approveFile = path.join(PROJECT_ROOT, 'data', 'auto-approve.json');
      const dir = path.dirname(approveFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(approveFile, JSON.stringify({ level }));
    } catch (e: any) { logger.warn('Failed to persist auto-approve level: ' + e.message); }
    res.json({ success: true, level });
  });

  app.get('/api/auto-approve/audit', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json(runtime.getAutoApprove().getAuditTrail(limit));
  });


  const uiPrefsPath = path.join(PROJECT_ROOT, 'data', 'ui-prefs.json');

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


  app.get('/api/privacy/stats', (_req, res) => {
    res.json(runtime.getPrivacyStats());
  });

  app.post('/api/privacy/config', (req, res) => {
    const config = req.body;
    runtime.setPrivacyConfig(config);
    res.json({ success: true, config });
  });


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

  const OAUTH_PROVIDERS = new Set(['github', 'google', 'azure', 'kiro']);
  const API_KEY_ONLY_PROVIDERS = new Set([
    'openai', 'anthropic', 'google', 'groq', 'deepseek', 'mistral',
    'openrouter', 'xai', 'cerebras', 'together', 'fireworks', 'sambanova',
    'ollama', 'kiro',
  ]);

  const buildProviderGuide = (provider: string): SetupGuide => {
    if (provider === 'copilot') {
      return {
        provider,
        title: 'GitHub Copilot Setup',
        summary: 'Copilot uses a GitHub OAuth token and works without an API key.',
        steps: [
          {
            id: 'copilot-github-oauth',
            title: 'Connect GitHub Account',
            description: 'Copilot works through GitHub. Click the Connect button below Ã¢â‚¬â€ an authorization window will open. Enter the code on the GitHub page and confirm. Status will update automatically after connecting.',
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
            title: 'Done Ã¢â‚¬â€ Test It Out',
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

    if (provider === 'kiro-oauth') {
      const envKey = 'OAUTH_KIRO_CLIENT_ID';
      const clientIdReady = !!(process.env[envKey] || '').trim();
      const oauthDesc = clientIdReady
        ? `Click the Connect button below — a Kiro authorization window will open. Confirm access. Status will update automatically after connecting.`
        : `⚠ Kiro OAuth requires ${envKey} (and optionally OAUTH_KIRO_DEVICE_URL / OAUTH_KIRO_TOKEN_URL / OAUTH_KIRO_SCOPES) in .env. Alternatively, use the "kiro" provider (API Key mode) by setting KIRO_API_KEY in Settings → API Keys.`;
      return {
        provider,
        title: 'Kiro OAuth Setup',
        summary: clientIdReady
          ? 'Kiro works via OAuth — no API key needed once connected.'
          : '⚠ Kiro OAuth Client ID not configured. Use KIRO_API_KEY (simpler) or set OAUTH_KIRO_CLIENT_ID in .env.',
        steps: [
          {
            id: 'kiro-oauth-oauth',
            title: 'Connect Kiro Account',
            description: oauthDesc,
            blocking: clientIdReady,
            actions: [],
          },
          {
            id: 'kiro-oauth-model-selected',
            title: 'Choose Kiro Model',
            description: 'Pick a Kiro-routed model from the list below and click Apply model.',
            blocking: true,
            actions: [],
          },
          {
            id: 'kiro-oauth-reload-check',
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

    if (provider === 'google-oauth' || provider === 'azure-oauth') {
      const oauthProvider = provider === 'google-oauth' ? 'google' : 'azure';
      const envKey = provider === 'google-oauth' ? 'OAUTH_GOOGLE_CLIENT_ID' : 'OAUTH_AZURE_CLIENT_ID';
      const clientIdReady = !!(process.env[envKey] || '').trim();
      const oauthDesc = clientIdReady
        ? `Click the Connect button below Ã¢â‚¬â€ a ${oauthProvider === 'google' ? 'Google' : 'Azure'} authorization window will open. Confirm access. Status will update automatically after connecting.`
        : oauthProvider === 'google'
          ? `Ã¢Å¡Â  Google OAuth requires a Client ID on the server. Set ${envKey} in your .env file and restart, OR switch to the "google" provider (API Key mode) Ã¢â‚¬â€ just set GOOGLE_API_KEY in Settings Ã¢â€ â€™ API Keys. That is much simpler and works right away.`
          : `Ã¢Å¡Â  Azure OAuth requires a Client ID on the server. Set ${envKey} in your .env file and restart.`;
      return {
        provider,
        title: `${provider} Setup`,
        summary: clientIdReady
          ? 'This provider works via OAuth Ã¢â‚¬â€ no API key needed.'
          : oauthProvider === 'google'
            ? 'Ã¢Å¡Â  OAuth Client ID not configured. Use GOOGLE_API_KEY instead (simpler) or set up the OAuth client.'
            : 'Ã¢Å¡Â  OAuth Client ID not configured. Set OAUTH_AZURE_CLIENT_ID in .env and restart.',
        steps: [
          {
            id: `${provider}-oauth`,
            title: `Connect ${oauthProvider === 'google' ? 'Google' : 'Azure'} Account`,
            description: oauthDesc,
            blocking: clientIdReady,
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
            title: 'Done Ã¢â‚¬â€ Test It Out',
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
          title: 'Done Ã¢â‚¬â€ Test It Out',
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

  const buildSetupStepStatus = async (provider: string) => {
    const oauthManager = runtime.getOAuthManager();
    const keys = runtime.getApiKeys();
    const keyConfigured = !!keys[provider];
    const githubConnected = oauthManager.hasToken('github');
    const googleConnected = oauthManager.hasToken('google');
    const azureConnected = oauthManager.hasToken('azure');
    const kiroConnected = oauthManager.hasToken('kiro');
    const current = runtime.getModelConfig();
    const commander = current.commander;
    const selectedProvider = commander?.provider || '';
    const selectedMatches = selectedProvider === provider;

    const status: Record<string, { done: boolean; detail: string }> = {};

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

    if (provider === 'kiro-oauth') {
      status['kiro-oauth-model-selected'] = {
        done: selectedMatches,
        detail: selectedMatches ? 'Kiro OAuth model selected.' : 'A different model is currently active.',
      };
      status['kiro-oauth-oauth'] = {
        done: kiroConnected,
        detail: kiroConnected ? 'Kiro OAuth connected.' : 'Kiro OAuth connection required.',
      };
      status['kiro-oauth-reload-check'] = {
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
      'copilot',
      'google-oauth',
      'azure-oauth',
      'kiro-oauth',
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
      'kiro',
    ];
    const providers = Array.from(new Set([...knownProviders, ...available.map(m => m.provider)]))
      .filter(p => p && String(p).toLowerCase() !== 'cursor');
    const requested = String(_req.query.provider || '').trim();
    if (requested && requested.toLowerCase() === 'cursor') {
      return res.status(400).json({ error: 'Cursor provider is not supported. Use Copilot (GitHub OAuth) or another provider.' });
    }
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

  app.get('/api/setup-guides/status', async (_req, res) => {
    const provider = String(_req.query.provider || '').trim();
    if (!provider) return res.status(400).json({ error: 'provider query parameter is required' });
    if (provider.toLowerCase() === 'cursor') {
      return res.status(400).json({ error: 'Cursor provider is not supported.' });
    }
    const stepStatus = await buildSetupStepStatus(provider);
    res.json({ provider, stepStatus });
  });

  app.get('/api/model/config', async (_req, res) => {
    await refreshOllamaModels();
    const current = runtime.getModelConfig();
    const available = getAvailableModels();
    res.json({ current, available });
  });

  app.post('/api/model/config', async (req, res) => {
    const { provider, model } = req.body;
    if (!provider || !model || typeof provider !== 'string' || typeof model !== 'string') {
      return res.status(400).json({ error: 'provider and model are required' });
    }
    if (provider.length > 50 || model.length > 100) {
      return res.status(400).json({ error: 'Invalid provider or model name' });
    }
    if (provider === 'cursor') {
      return res.status(400).json({
        error: 'Cursor is no longer supported in this panel. Connect GitHub for Copilot, or use OpenAI / Anthropic / Ollama / another API key provider.',
      });
    }
    try {
      runtime.setModelConfig({ provider, model });
      // Create agents if they don't exist yet (fresh install: OAuth connected, model selected)
      await runtime.ensureAgents();
      res.json({ success: true, provider, model });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/keys/config', (_req, res) => {
    const keys = runtime.getApiKeys();
    res.json({ keys });
  });

  app.post('/api/keys/config', async (req, res) => {
    const { keys } = req.body;
    if (!keys || typeof keys !== 'object') {
      return res.status(400).json({ error: 'keys object required' });
    }

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

      try {
        new URL(solana);
      } catch {
        return res.status(400).json({ error: 'Invalid Solana RPC URL format' });
      }

      try {
        const testRes = await fetch(solana, {
                    method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
          signal: AbortSignal.timeout(10000),
        });
        if (!testRes.ok) throw new Error(`HTTP ${testRes.status}`);
        const testData = await testRes.json() as any;
        if (testData.error) throw new Error(testData.error.message || JSON.stringify(testData.error));
      } catch (err: any) {
        return res.status(400).json({ error: `RPC test failed: ${err.message}` });
      }
    }
    const update: { solana?: string; helius?: string } = {};
    if (solana) update.solana = solana;
    if (helius !== undefined) update.helius = helius;
    runtime.setRpcConfig(update);

    _walletResCache = { data: null, ts: 0 };
    _balCache = { address: '', balance: 0, ts: 0 };
    _txCache.address = ''; _txCache.sigs = ''; _txCache.txs = []; _txCache.ts = 0;
    _txRefreshing = false;
    logger.info(`RPC config updated + caches cleared`);
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


  const _tweetCache = new Map<string, any>();
  let _tweetProvider = 0;

  function normalizeFx(raw: any): any {
    const t = raw.tweet || raw;
    const a = t.author || {};
    const result: any = {
      user_name: a.name || '',
      user_screen_name: a.screen_name || '',
      user_profile_image_url: a.avatar_url || '',
      text: t.text || '',
      likes: t.likes || 0,
      retweets: t.retweets || 0,
      replies: t.replies || 0,
      created_at: t.created_at || '',
      media_extended: [] as any[],
      mediaURLs: [] as string[],
      replying_to: t.replying_to || null,
    };
    const allMedia = t.media?.all || t.media?.photos || [];
    if (allMedia.length) {
      result.media_extended = allMedia.map((m: any) => ({
        type: m.type === 'photo' ? 'image' : (m.type || 'image'),
        url: m.url || m.thumbnail_url || '',
        thumbnail_url: m.thumbnail_url || m.url || '',
      }));
      result.mediaURLs = allMedia.map((m: any) => m.url || '');
    }
    if (t.quote) {
      const qa = t.quote.author || {};
      result.quote = {
        user_name: qa.name || '',
        user_screen_name: qa.screen_name || '',
        user_profile_image_url: qa.avatar_url || '',
        text: t.quote.text || '',
      };
    }
    return result;
  }

  function normalizeVx(raw: any): any {
    return {
      user_name: raw.user_name || '',
      user_screen_name: raw.user_screen_name || '',
      user_profile_image_url: raw.user_profile_image_url || '',
      text: raw.text || '',
      likes: raw.likes || 0,
      retweets: raw.retweets || 0,
      replies: raw.replies || 0,
      created_at: raw.date || '',
      media_extended: raw.media_extended || [],
      mediaURLs: raw.mediaURLs || [],
      replying_to: raw.replying_to || null,
      quote: raw.quote || null,
    };
  }

  async function fetchTweetCached(tweetId: string): Promise<any> {
    if (_tweetCache.has(tweetId)) return _tweetCache.get(tweetId);

    const providers = [

      async () => {
        const r = await fetch(`https://api.fxtwitter.com/x/status/${tweetId}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return null;
        const d = await r.json() as any;
        return (d.tweet?.author?.screen_name) ? normalizeFx(d) : null;
      },

      async () => {
        const r = await fetch(`https://api.vxtwitter.com/x/status/${tweetId}`);
        if (!r.ok) return null;
        const d = await r.json() as any;
        return d.user_screen_name ? normalizeVx(d) : null;
      },
    ];


    const start = _tweetProvider++ % providers.length;
    for (let i = 0; i < providers.length; i++) {
      const idx = (start + i) % providers.length;
      try {
        const result = await providers[idx]();
        if (result && result.user_screen_name) {
          _tweetCache.set(tweetId, result);
          return result;
        }
      } catch (e) {
        logger.warn(`[Tweet] Provider ${idx} failed for ${tweetId}: ${(e as any).message}`);
      }
    }

    return null;
  }


  app.get('/api/twitter/tweet/:tweetId', async (req, res) => {
    try {
      const { tweetId } = req.params;
      if (!/^\d+$/.test(tweetId)) {
        return res.status(400).json({ error: 'Invalid tweet ID' });
      }
      const data = await fetchTweetCached(tweetId);
      if (!data) return res.status(404).json({ error: 'Tweet not found' });
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/twitter/login', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.openTwitterLogin();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/browser/status', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const status = browser.getStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/browser/main/detect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const info = await browser.detectMainBrowser();
      res.json(info);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/main/connect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.connectMainBrowser();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/main/disconnect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      await browser.disconnectMainBrowser();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/main/extract-cookies', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const ok = await browser.extractMainBrowserTwitterCookies();
      res.json({ success: ok, message: ok ? 'Cookies extracted' : 'No Twitter cookies found Ã¢â‚¬â€ are you logged in on x.com?' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/twitter/check', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const loggedIn = await browser.checkTwitterLogin();
      res.json({ loggedIn });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/browser/twitter/search', async (req, res) => {
    try {
      const q = req.query.q as string;
      if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'q query parameter is required' });
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const browser = runtime.getBrowser();
      const results = await browser.searchTwitter(q, limit);
      res.json({ query: q, results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/fetch', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
      }

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


  app.post('/api/browser/axiom/connect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.connectAxiom();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/browser/axiom/disconnect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      await browser.disconnectAxiom();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/browser/axiom/check', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const loggedIn = await browser.checkAxiomSession();
      res.json({ loggedIn });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/browser/axiom/token/:mint', async (req, res) => {
    try {
      const { mint } = req.params;
      if (!/^[a-zA-Z0-9]{32,50}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid mint address' });
      }
      const browser = runtime.getBrowser();
      const result = await browser.scrapeAxiomToken(mint);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/axiom/sync-cookies', async (req, res) => {
    try {
      const { cookies } = req.body;
      if (!Array.isArray(cookies)) {
        return res.status(400).json({ error: 'cookies must be an array' });
      }
      const browser = runtime.getBrowser();
      browser.setAxiomCookies(cookies);
      res.json({ ok: true, count: cookies.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/axiom/sync-headers', express.json(), async (req, res) => {
    try {
      const { headers } = req.body;
      if (!headers || typeof headers !== 'object') {
        return res.status(400).json({ error: 'headers must be an object' });
      }
      const browser = runtime.getBrowser();
      browser.setAxiomAuthHeaders(headers);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/browser/axiom/cookie-status', async (_req, res) => {
    const browser = runtime.getBrowser();
    const status = browser.getStatus();
    const hasCookies = browser.hasAxiomCookies();
    res.json({
      axiomConnected: status.axiomConnected,
      mainBrowserConnected: status.mainBrowserConnected,
      hasCookies,
      hasAuthHeaders: browser.hasAxiomAuthHeaders(),
      cookieCount: (browser as any).axiomCookies?.length || 0,
      cookieNames: ((browser as any).axiomCookies || []).map((c: any) => c.name),
      cookiesAge: (browser as any).axiomCookiesUpdatedAt ? Date.now() - (browser as any).axiomCookiesUpdatedAt : null,
      authHeadersAge: (browser as any).axiomAuthHeadersUpdatedAt ? Date.now() - (browser as any).axiomAuthHeadersUpdatedAt : null,
    });
  });


  app.get('/api/browser/axiom/api/:mint', async (req, res) => {
    try {
      const { mint } = req.params;
      if (!/^[a-zA-Z0-9]{32,50}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid address' });
      }
      const browser = runtime.getBrowser();
      if (!browser.getStatus().axiomConnected) {
        return res.status(400).json({ error: 'Axiom not connected. Connect via Settings â†’ Browser first.' });
      }


      const pairAddress = await browser.resolveAxiomPair(mint) || mint;
      const data = await browser.axiomBatchTokenData(pairAddress);
      res.json(data || { error: 'No data returned' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post('/api/browser/gmgn/connect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.connectGmgn();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/browser/gmgn/disconnect', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      await browser.disconnectGmgn();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/browser/gmgn/check', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const loggedIn = await browser.checkGmgnSession();
      res.json({ loggedIn });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/browser/gmgn/capture-ws', async (_req, res) => {
    try {
      const browser = runtime.getBrowser();
      const result = await browser.captureGmgnWsUrl();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/browser/gmgn/token/:mint', async (req, res) => {
    try {
      const { mint } = req.params;
      if (!/^[a-zA-Z0-9]{32,50}$/.test(mint)) {
        return res.status(400).json({ error: 'Invalid mint address' });
      }
      const browser = runtime.getBrowser();
      const result = await browser.scrapeGmgnToken(mint);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/oauth/capabilities', (_req, res) => {
    const gid = (process.env.OAUTH_GOOGLE_CLIENT_ID || '').trim();
    const aid = (process.env.OAUTH_AZURE_CLIENT_ID || '').trim();
    const kid = (process.env.OAUTH_KIRO_CLIENT_ID || '').trim();
    res.json({
      github: { ready: true, hint: 'Uses built-in device-flow client (VS Code Copilot public client).' },
      google: {
        ready: !!gid,
        envVar: 'OAUTH_GOOGLE_CLIENT_ID',
        hint: gid
          ? ''
          : 'Create an OAuth 2.0 Client (Desktop / TV & limited input) in Google Cloud Console, enable Generative Language API if needed, then set OAUTH_GOOGLE_CLIENT_ID in the server .env and restart.',
      },
      azure: {
        ready: !!aid,
        envVar: 'OAUTH_AZURE_CLIENT_ID',
        hint: aid
          ? ''
          : 'Register an app in Azure AD (device code flow), then set OAUTH_AZURE_CLIENT_ID in the server .env and restart.',
      },
      kiro: {
        ready: !!kid,
        envVar: 'OAUTH_KIRO_CLIENT_ID',
        hint: kid
          ? ''
          : 'Register a Kiro OAuth app (device code flow) and set OAUTH_KIRO_CLIENT_ID in the server .env. Optionally override OAUTH_KIRO_DEVICE_URL / OAUTH_KIRO_TOKEN_URL / OAUTH_KIRO_SCOPES for self-hosted deployments. Or use the simpler API-key path: set KIRO_API_KEY in Settings → API Keys.',
      },
    });
  });

  app.post('/api/oauth/start/:provider', async (req, res) => {
    try {
      const providerName = req.params.provider;
      const oauthManager = runtime.getOAuthManager();
      const envKey = `OAUTH_${providerName.toUpperCase()}_CLIENT_ID`;
      const clientIdOverride = (process.env[envKey] || '').trim() || undefined;
      const flow = await oauthManager.startDeviceFlow(providerName, clientIdOverride);
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


  app.get('/api/oauth/status', (_req, res) => {
    const oauthManager = runtime.getOAuthManager();
    const providers = ['github', 'google', 'azure', 'kiro'];
    const status: Record<string, boolean> = {};
    for (const p of providers) {
      status[p] = oauthManager.hasToken(p);
    }
    res.json(status);
  });


  app.delete('/api/oauth/revoke/:provider', (req, res) => {
    try {
      const oauthManager = runtime.getOAuthManager();
      oauthManager.revokeToken(req.params.provider);
      res.json({ success: true, provider: req.params.provider });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });


  const extensionDir = path.join(PROJECT_ROOT, 'extension');


  app.get('/extension/inject.js', (_req, res) => {
    try {
      const cssPath = path.join(extensionDir, 'overlay.css');
      const jsPath = path.join(extensionDir, 'inject.js');
      if (!fs.existsSync(cssPath) || !fs.existsSync(jsPath)) {
        return res.status(404).send('Extension files not found');
      }
      const css = fs.readFileSync(cssPath, 'utf-8').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
      let js = fs.readFileSync(jsPath, 'utf-8');
      const origin = `${_req.protocol}://${_req.get('host')}`;
      js = js.replace(/__AXIOM_CSS__/g, css);
      js = js.replace(/__AXIOM_HOST__/g, origin);
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      res.set('Cache-Control', 'no-cache');
      res.send(js);
    } catch (err: any) {
      res.status(500).send('// Error: ' + err.message);
    }
  });

  app.use('/extension/static', express.static(extensionDir));

  app.get('/extension/WhiteOwl.crx', (_req, res) => {
    try {
      const origin = `${_req.protocol}://${_req.get('host')}`;
      const keyPath = path.join(PROJECT_ROOT, 'key.pem');
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

  app.get('/extension/update.xml', (_req, res) => {
    try {
      const origin = `${_req.protocol}://${_req.get('host')}`;
      const keyPath = path.join(PROJECT_ROOT, 'key.pem');
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


  app.get('/extension/id', (_req, res) => {
    try {
      const keyPath = path.join(PROJECT_ROOT, 'key.pem');
      const { publicKeyDer } = getOrCreateKey(keyPath);
      res.set('Content-Type', 'text/plain');
      res.send(computeExtensionId(publicKeyDer));
    } catch (err: any) {
      res.status(500).send('Error');
    }
  });


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
title WhiteOwl Ã¢â‚¬â€ Chrome Extension Installer\r
color 0A\r
echo.\r
echo  Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\r
echo    WhiteOwl Ã¢â‚¬â€ Auto-install Chrome Extension\r
echo  Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â\r
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
>"%EXT_DIR%\\manifest.json" echo {"manifest_version":3,"name":"WhiteOwl","version":"1.0.1","description":"AI overlay","host_permissions":["https://pump.fun/*","https://www.pump.fun/*"],"content_scripts":[{"matches":["https://pump.fun/*","https://www.pump.fun/*"],"js":["content.js"],"run_at":"document_idle","world":"MAIN"}],"icons":{"48":"icon48.png","128":"icon128.png"}}\r
echo  Saved to: %EXT_DIR%\r
\r
echo  [3/4] Setting browser policies (HKLM + HKCU + External)...\r
\r
:: Ã¢â€â‚¬Ã¢â€â‚¬ Force-install via HKLM policy (most reliable on unmanaged Windows) Ã¢â€â‚¬Ã¢â€â‚¬\r
reg add "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
\r
:: Ã¢â€â‚¬Ã¢â€â‚¬ Force-install via HKCU policy (backup) Ã¢â€â‚¬Ã¢â€â‚¬\r
reg add "HKCU\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
reg add "HKCU\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%WhiteOwl_URL%/extension/update.xml" /f >nul 2>&1\r
\r
:: Ã¢â€â‚¬Ã¢â€â‚¬ Allow localhost as extension install source Ã¢â€â‚¬Ã¢â€â‚¬\r
reg add "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallSources" /v 1 /t REG_SZ /d "http://localhost:*/*" /f >nul 2>&1\r
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallSources" /v 1 /t REG_SZ /d "http://localhost:*/*" /f >nul 2>&1\r
\r
:: Ã¢â€â‚¬Ã¢â€â‚¬ External Extensions registry (alternative install method) Ã¢â€â‚¬Ã¢â€â‚¬\r
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
start "" chrome.exe https://localhost:${port}\r
\r
echo.\r
echo  Done! Extension installed.\r
echo  Chrome: "Managed by your organization" = normal.\r
echo.\r
echo  Verify: chrome://extensions\r
echo.\r
echo  Fallback (if not auto-loaded):\r
echo    chrome://extensions\r
echo    Load unpacked - %EXT_DIR%\r
echo.\r
pause\r
`;
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="WhiteOwl-install.bat"');
    res.send(bat);
  });


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


  app.get('/extension/status', (_req, res) => {
    try {
      const keyPath = path.join(PROJECT_ROOT, 'key.pem');
      const { publicKeyDer } = getOrCreateKey(keyPath);
      const extId = computeExtensionId(publicKeyDer);
      res.json({ installed: true, version: '1.0.0', extensionId: extId, server: `${_req.protocol}://${_req.get('host')}` });
    } catch (err: any) {
      res.json({ installed: false, error: err.message });
    }
  });

  app.use('/dashboard', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  }, express.static(path.join(PROJECT_ROOT, 'public')));
  app.get('/', (_req, res) => res.redirect('/dashboard'));

  app.get('/proxy-sw.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(PROJECT_ROOT, 'public', 'proxy-sw.js'));
  });

  app.use('/landing', express.static(path.join(PROJECT_ROOT, 'landing')));

  app.get('/metrics', (_req, res) => {
    const metrics = runtime.getMetrics();
    if (!metrics) return res.status(503).send('Metrics not available');
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.getPrometheusMetrics());
  });

  app.get('/health', (_req, res) => {
    const metrics = runtime.getMetrics();
    if (!metrics) {
      return res.status(200).json({ healthy: true, checks: {}, details: 'Metrics not initialized (OK)' });
    }
    const health = metrics.isHealthy();
    res.status(200).json(health);
  });

  const server = http.createServer(app);

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  _wss = wss;
  const termWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const wsProxyServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;


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
            } catch (e) {  }
          });

          clientWs.on('message', (data, isBinary) => {
            try {
              if (targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(data, { binary: isBinary });
              }
            } catch (e) {  }
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


    let currentTermId = 0;
    let currentTerm = terminalManager.get(0)!;
    let onOutput: ((data: string) => void) | null = null;
    let onExit: (() => void) | null = null;
    let onClear: (() => void) | null = null;

    function attachToTerm(term: import('../core/shared-terminal.ts').SharedTerminal, termId: number) {

      detachFromTerm();
      currentTerm = term;
      currentTermId = termId;
      currentTerm.start();

      onOutput = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data, termId: currentTermId }));
        }
      };
      onExit = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', termId: currentTermId }));
        }
      };
      onClear = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'clear', termId: currentTermId }));
        }
      };

      currentTerm.on('output', onOutput);
      currentTerm.on('exit', onExit);
      currentTerm.on('clear', onClear);


      ws.send(JSON.stringify({ type: 'info', mode: 'local', cwd: currentTerm.getCwd(), termId: currentTermId }));
      const recent = currentTerm.read(200);
      if (recent) {
        ws.send(JSON.stringify({ type: 'output', data: recent, termId: currentTermId }));
      }
    }

    function detachFromTerm() {
      if (currentTerm && onOutput) {
        currentTerm.off('output', onOutput);
        currentTerm.off('exit', onExit!);
        currentTerm.off('clear', onClear!);
        onOutput = null; onExit = null; onClear = null;
      }
    }


    attachToTerm(currentTerm, 0);


    ws.send(JSON.stringify({ type: 'term-list', terminals: terminalManager.list() }));

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'input' && msg.data) {

          if (currentTerm && currentTerm.isAlive()) {
            currentTerm.write(msg.data);
          }
        } else if (msg.type === 'switch') {

          const targetId = typeof msg.termId === 'number' ? msg.termId : 0;
          const target = terminalManager.get(targetId);
          if (target) {
            attachToTerm(target, targetId);
          } else {
            ws.send(JSON.stringify({ type: 'error', data: 'Terminal ' + targetId + ' not found' }));
          }
        } else if (msg.type === 'create') {

          const result = terminalManager.create();
          if (result) {
            result.term.start();
            attachToTerm(result.term, result.id);
            ws.send(JSON.stringify({ type: 'term-created', termId: result.id }));
            ws.send(JSON.stringify({ type: 'term-list', terminals: terminalManager.list() }));
          } else {
            ws.send(JSON.stringify({ type: 'error', data: 'Maximum terminals reached' }));
          }
        } else if (msg.type === 'kill') {

          const targetId = typeof msg.termId === 'number' ? msg.termId : -1;
          if (targetId <= 0) {
            ws.send(JSON.stringify({ type: 'error', data: 'Cannot kill the agent terminal' }));
          } else {
            const wasActual = (currentTermId === targetId);
            terminalManager.remove(targetId);
            if (wasActual) {

              attachToTerm(terminalManager.get(0)!, 0);
            }
            ws.send(JSON.stringify({ type: 'term-killed', termId: targetId }));
            ws.send(JSON.stringify({ type: 'term-list', terminals: terminalManager.list() }));
          }
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          if (currentTerm && currentTerm.isAlive()) {
            currentTerm.resize(msg.cols, msg.rows);
          }
        } else if (msg.type === 'list') {
          ws.send(JSON.stringify({ type: 'term-list', terminals: terminalManager.list() }));
        }
      } catch {}
    });

    ws.on('close', () => {
      detachFromTerm();
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    logger.info('WebSocket client connected');

    ws.on('error', (err) => {
      logger.error('WebSocket error: ' + err.message);
    });

    const subscriptions = new Set<string>();
    let subscribeAll = false;


    const WS_MUTED_EVENTS = new Set(['token:trade', 'token:snapshot']);
    const handler = (event: EventName, data: any) => {
      if (!subscribeAll && !subscriptions.has(event)) return;
      if (WS_MUTED_EVENTS.has(event as string)) return;

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

          const agentId = typeof msg.agent === 'string' ? msg.agent.slice(0, 50) : 'commander';
          const message = typeof msg.message === 'string' ? msg.message.slice(0, 4096) : '';
          const image = typeof msg.image === 'string' && msg.image.length < 2_000_000 ? msg.image : undefined;
          const wsChatId = typeof msg.chatId === 'string' ? msg.chatId.slice(0, 100) : '';
          if (!message) {
            ws.send(JSON.stringify({ type: 'chat_error', error: 'message required' }));
            return;
          }


          const projectsSkillWs = runtime.getSkillLoader().getSkill('projects') as any;
          if (projectsSkillWs?.setChatId && wsChatId) projectsSkillWs.setChatId(wsChatId);


          const wsFilterId = wsChatId || agentId;
          ws.send(JSON.stringify({ type: 'chat_status', status: 'thinking', agentId }));


          const chatToolHandler = (data: any) => {
            if (data?.agentId !== wsFilterId) return;
            try {
              ws.send(JSON.stringify({ type: 'chat_tool_call', tool: data.tool, params: data.params, timestamp: Date.now() }));
            } catch {}
          };

          const chatToolResultHandler = (data: any) => {
            if (data?.agentId !== wsFilterId) return;
            try {
              const preview = typeof data.result === 'string' ? data.result.slice(0, 300) : JSON.stringify(data.result).slice(0, 300);
              ws.send(JSON.stringify({ type: 'chat_tool_result', tool: data.tool, preview, durationMs: data.durationMs, timestamp: Date.now() }));
            } catch {}
          };

          const chatTokenHandler = (data: any) => {
            if (data?.agentId !== wsFilterId) return;
            try {
              ws.send(JSON.stringify({ type: 'chat_token', token: data.token, final: !!data.final }));
            } catch {}
          };

          const chatCheckpointHandler = (data: any) => {
            if (data?.agentId !== wsFilterId) return;
            try {
              ws.send(JSON.stringify({ type: 'chat_checkpoint', id: data.id, timestamp: data.timestamp, messageCount: data.messageCount, preview: data.preview }));
            } catch {}
          };

          const chatImageHandler = (data: any) => {
            try {
              const imgLen = typeof data?.image === 'string' ? data.image.length : 0;
              console.log(`[WS] chatImageHandler fired, image length: ${imgLen}, caption: ${data?.caption || ''}`);
              ws.send(JSON.stringify({ type: 'chat_image', image: data.image, caption: data.caption || '' }));
              console.log('[WS] chat_image sent to client');
            } catch (err: any) {
              console.error('[WS] chat_image send failed:', err.message);
            }
          };
          runtime.getEventBus().on('agent:tool_call' as any, chatToolHandler);
          runtime.getEventBus().on('agent:tool_result' as any, chatToolResultHandler);
          runtime.getEventBus().on('agent:token' as any, chatTokenHandler);
          runtime.getEventBus().on('agent:checkpoint' as any, chatCheckpointHandler);
          runtime.getEventBus().on('agent:image' as any, chatImageHandler);

          try {
            const response = wsChatId
              ? await runtime.sessionChat(wsChatId, message, agentId, image)
              : await runtime.chat(agentId, message, image);
            ws.send(JSON.stringify({ type: 'chat_response', agent: agentId, response, timestamp: Date.now() }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'chat_error', error: err.message, timestamp: Date.now() }));
          }

          runtime.getEventBus().off('agent:tool_call' as any, chatToolHandler);
          runtime.getEventBus().off('agent:tool_result' as any, chatToolResultHandler);
          runtime.getEventBus().off('agent:token' as any, chatTokenHandler);
          runtime.getEventBus().off('agent:checkpoint' as any, chatCheckpointHandler);
          runtime.getEventBus().off('agent:image' as any, chatImageHandler);
        } else if (msg.type === 'restore_checkpoint') {
          const agentId = typeof msg.agent === 'string' ? msg.agent.slice(0, 50) : 'commander';
          const checkpointId = typeof msg.checkpointId === 'number' ? msg.checkpointId : 0;
          if (!checkpointId) {
            ws.send(JSON.stringify({ type: 'checkpoint_restored', ok: false, error: 'checkpointId required' }));
            return;
          }
          const result = runtime.restoreCheckpoint(agentId, checkpointId);
          ws.send(JSON.stringify({ type: 'checkpoint_restored', ...result, checkpointId, timestamp: Date.now() }));
        }
      } catch {}
    });

    ws.on('close', () => {
      runtime.getEventBus().offAny(handler);
      logger.info('WebSocket client disconnected');
    });
  });


  app.post('/api/browser/select', (req, res) => {
    const { selector, tag, html, text, url } = req.body;
    if (!selector || typeof selector !== 'string') {
      return res.status(400).json({ error: 'selector is required' });
    }
    const payload = {
      selector: String(selector).slice(0, 500),
      tag: String(tag || 'div').slice(0, 50),
      html: String(html || '').slice(0, 2000),
      text: String(text || '').slice(0, 500),
      url: String(url || '').slice(0, 500),
    };

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(JSON.stringify({ type: 'browser_select', data: payload })); } catch {}
      }
    });
    res.json({ ok: true });
  });


  app.get('/api/browser/inspector.js', (_req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(inspectorScript(port));
  });

  return {
    app,
    server,
    start: () => {
      server.listen(port, () => {
        logger.info(`API server running on http://localhost:${port}`);
        logger.info(`WebSocket available at ws://localhost:${port}/ws`);

        connectGmgnTwitterWs();
      });
    },
    stop: () => {
      return new Promise<void>((resolve) => {
        try { if (_gmgnWs) _gmgnWs.close(); } catch {}
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

            const refResp = await fetch(`https://api.github.com/repos/${repo.full_name}/git/refs/heads/${branch}`, {
        headers: ghHeaders,
      });
      if (refResp.ok) continue;

      logger.info(`Auto-initializing empty repo: ${repo.full_name}`);
      const content = Buffer.from('# WhiteOwl\nAuto-initialized repository.\n').toString('base64');
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
      logger.warn(`Failed to initialize ${repo.full_name} Ã¢â‚¬â€ may need repo scope`);
    }
  } catch (err: any) {
    logger.warn(`Auto-init repos failed: ${err.message}`);
  }
}
