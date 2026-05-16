// WhiteOwl - Kiro IDE / kiro-cli session detector
//
// Finds a logged-in Kiro session on the local machine and resolves it to a
// fresh access token. Supports two sources of credentials, which mirror what
// the official Kiro IDE and kiro-cli actually write to disk:
//
//   1. Kiro Desktop credentials (Sign in with GitHub / Google / Builder ID
//      via the Kiro IDE app)
//        - JSON file under platform-specific Kiro config dirs
//        - Refreshed via https://prod.{region}.auth.desktop.kiro.dev/refreshToken
//
//   2. AWS SSO OIDC (kiro-cli + IAM Identity Center)
//        - SQLite db at ~/.local/share/kiro-cli/data.sqlite3 (or the
//          platform equivalent) plus optional registration JSON in
//          ~/.aws/sso/cache/<hash>.json
//        - Refreshed via https://oidc.{region}.amazonaws.com/token
//
// We only read these files; we never modify them. The refreshed access token
// is persisted in WhiteOwl's own encrypted oauth-tokens.json so the panel can
// continue to use it after the IDE/cli is closed.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type KiroAuthFlavor = 'kiro_desktop' | 'aws_sso_oidc';

export interface KiroSessionRefreshable {
  flavor: KiroAuthFlavor;
  /** Source description (file path or sqlite key) used for diagnostics. */
  source: string;
  refreshToken: string;
  /** Pre-existing access token (may already be valid). */
  accessToken?: string;
  /** Existing expiry, ms epoch (optional). */
  expiresAt?: number;
  region?: string;
  scopes?: string[];
  // AWS SSO OIDC only:
  clientId?: string;
  clientSecret?: string;
  // Kiro IDE only:
  profileArn?: string;
}

export interface KiroSessionToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
  flavor: KiroAuthFlavor;
  source: string;
  region: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
}

const DEFAULT_REGION = process.env.KIRO_REGION || 'us-east-1';

function existsAndReadable(p: string): boolean {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function tryReadJson(p: string): any | null {
  try {
    if (!existsAndReadable(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function parseExpiresAt(raw: any): number | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    let s = raw.trim();
    if (!s) return undefined;
    if (s.endsWith('Z')) s = s.slice(0, -1) + '+00:00';
    // strip nanoseconds beyond 6 decimals
    s = s.replace(/(\.\d{6})\d+/, '$1');
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Kiro Desktop credential file locations (per OS)
// ---------------------------------------------------------------------------

function kiroDesktopCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(appData, 'Kiro', 'credentials.json'),
      path.join(appData, 'Kiro', 'auth', 'credentials.json'),
      path.join(localAppData, 'Kiro', 'credentials.json'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Kiro', 'credentials.json'),
      path.join(home, 'Library', 'Application Support', 'Kiro', 'auth', 'credentials.json'),
    );
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(
      path.join(xdg, 'kiro', 'credentials.json'),
      path.join(home, '.kiro', 'credentials.json'),
    );
  }

  // Allow explicit override: KIRO_CREDS_FILE=/abs/path/to/credentials.json
  if (process.env.KIRO_CREDS_FILE) candidates.unshift(process.env.KIRO_CREDS_FILE);

  return Array.from(new Set(candidates));
}

function loadKiroDesktopCreds(): KiroSessionRefreshable | null {
  for (const p of kiroDesktopCandidates()) {
    const data = tryReadJson(p);
    if (!data) continue;
    const refreshToken = data.refreshToken || data.refresh_token;
    if (!refreshToken || typeof refreshToken !== 'string') continue;
    return {
      flavor: 'kiro_desktop',
      source: p,
      refreshToken,
      accessToken: data.accessToken || data.access_token,
      expiresAt: parseExpiresAt(data.expiresAt || data.expires_at),
      region: data.region || DEFAULT_REGION,
      profileArn: data.profileArn || data.profile_arn,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// kiro-cli SQLite database (auth_kv table)
// ---------------------------------------------------------------------------

const SQLITE_TOKEN_KEYS = [
  'kirocli:social:token',
  'kirocli:odic:token',
  'codewhisperer:odic:token',
];

const SQLITE_REGISTRATION_KEYS = [
  'kirocli:odic:device-registration',
  'codewhisperer:odic:device-registration',
];

function kiroCliSqliteCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(
      path.join(localAppData, 'kiro-cli', 'data', 'data.sqlite3'),
      path.join(localAppData, 'kiro-cli', 'data.sqlite3'),
      path.join(appData, 'kiro-cli', 'data.sqlite3'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3'),
    );
  } else {
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    candidates.push(
      path.join(xdgData, 'kiro-cli', 'data.sqlite3'),
    );
  }

  if (process.env.KIRO_SQLITE_DB) candidates.unshift(process.env.KIRO_SQLITE_DB);

  return Array.from(new Set(candidates));
}

async function readSqliteAuthKv(dbPath: string): Promise<Map<string, string> | null> {
  if (!existsAndReadable(dbPath)) return null;
  try {
    // Lazy-load sql.js to avoid loading wasm when we don't need it.
    const mod = await import('sql.js');
    const initSqlJs = (mod as any).default || (mod as any).init || (mod as any);
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(new Uint8Array(buf));
    const out = new Map<string, string>();
    try {
      const stmt = db.prepare('SELECT key, value FROM auth_kv');
      while (stmt.step()) {
        const row = stmt.getAsObject();
        const k = String(row.key ?? '');
        const v = String(row.value ?? '');
        if (k) out.set(k, v);
      }
      stmt.free();
    } catch {
      // table may not exist on a freshly-installed kiro-cli that wasn't logged in
      db.close();
      return null;
    }
    db.close();
    return out;
  } catch {
    return null;
  }
}

async function loadKiroCliCreds(): Promise<KiroSessionRefreshable | null> {
  for (const p of kiroCliSqliteCandidates()) {
    const kv = await readSqliteAuthKv(p);
    if (!kv) continue;

    let tokenKey: string | undefined;
    let tokenJson: any;
    for (const k of SQLITE_TOKEN_KEYS) {
      const raw = kv.get(k);
      if (!raw) continue;
      try {
        tokenJson = JSON.parse(raw);
        tokenKey = k;
        break;
      } catch { /* skip malformed */ }
    }
    if (!tokenJson) continue;

    let registrationJson: any;
    for (const k of SQLITE_REGISTRATION_KEYS) {
      const raw = kv.get(k);
      if (!raw) continue;
      try { registrationJson = JSON.parse(raw); break; } catch { /* skip */ }
    }

    const refreshToken = tokenJson.refresh_token || tokenJson.refreshToken;
    if (!refreshToken) continue;

    const flavor: KiroAuthFlavor = registrationJson?.client_id ? 'aws_sso_oidc' : 'kiro_desktop';

    return {
      flavor,
      source: `${p} (${tokenKey})`,
      refreshToken,
      accessToken: tokenJson.access_token || tokenJson.accessToken,
      expiresAt: parseExpiresAt(tokenJson.expires_at || tokenJson.expiresAt),
      region: tokenJson.region || registrationJson?.region || DEFAULT_REGION,
      scopes: tokenJson.scopes,
      profileArn: tokenJson.profile_arn || tokenJson.profileArn,
      clientId: registrationJson?.client_id || registrationJson?.clientId,
      clientSecret: registrationJson?.client_secret || registrationJson?.clientSecret,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session discovery + refresh
// ---------------------------------------------------------------------------

export interface DetectedSession {
  flavor: KiroAuthFlavor;
  source: string;
  region: string;
  /** True iff we have credentials sufficient to call refresh. */
  refreshable: boolean;
}

export async function detectKiroSession(): Promise<DetectedSession | null> {
  const desktop = loadKiroDesktopCreds();
  if (desktop) {
    return { flavor: desktop.flavor, source: desktop.source, region: desktop.region || DEFAULT_REGION, refreshable: !!desktop.refreshToken };
  }
  const cli = await loadKiroCliCreds();
  if (cli) {
    return { flavor: cli.flavor, source: cli.source, region: cli.region || DEFAULT_REGION, refreshable: !!cli.refreshToken };
  }
  return null;
}

async function refreshKiroDesktopToken(creds: KiroSessionRefreshable): Promise<KiroSessionToken> {
  const region = creds.region || DEFAULT_REGION;
  const url = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': `WhiteOwl-KiroAuth/1.0 (${process.platform})`,
    },
    body: JSON.stringify({ refreshToken: creds.refreshToken }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Kiro desktop refresh failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = await resp.json() as any;
  if (!data.accessToken) throw new Error('Kiro desktop refresh response missing accessToken');

  const expiresIn = Number(data.expiresIn || 3600);
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || creds.refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    scope: 'kiro:desktop',
    tokenType: 'Bearer',
    flavor: 'kiro_desktop',
    source: creds.source,
    region,
    profileArn: data.profileArn || creds.profileArn,
  };
}

async function refreshKiroSsoToken(creds: KiroSessionRefreshable): Promise<KiroSessionToken> {
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('AWS SSO OIDC session requires clientId/clientSecret in device-registration');
  }
  const region = creds.region || DEFAULT_REGION;
  const url = `https://oidc.${region}.amazonaws.com/token`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`AWS SSO OIDC refresh failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = await resp.json() as any;
  if (!data.accessToken) throw new Error('AWS SSO OIDC refresh response missing accessToken');

  const expiresIn = Number(data.expiresIn || 3600);
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || creds.refreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    scope: (creds.scopes || []).join(' ') || 'kiro:sso',
    tokenType: 'Bearer',
    flavor: 'aws_sso_oidc',
    source: creds.source,
    region,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  };
}

/**
 * Locate a Kiro IDE / kiro-cli session on the local machine and exchange the
 * stored refresh token for a fresh access token.
 *
 * Throws with a human-readable message when:
 *   - no Kiro session is found
 *   - the refresh token has been revoked / expired
 *   - the network call to Kiro / AWS SSO fails
 */
export async function loginViaKiroIDE(): Promise<KiroSessionToken> {
  const desktop = loadKiroDesktopCreds();
  if (desktop) return refreshKiroDesktopToken(desktop);

  const cli = await loadKiroCliCreds();
  if (cli) {
    return cli.flavor === 'aws_sso_oidc'
      ? refreshKiroSsoToken(cli)
      : refreshKiroDesktopToken(cli);
  }

  throw new Error(
    'No Kiro session found on this machine. Sign in via Kiro IDE (or run `kiro-cli login`) and try again.'
  );
}

export async function refreshExistingKiroToken(token: {
  flavor: KiroAuthFlavor;
  refreshToken: string;
  region?: string;
  clientId?: string;
  clientSecret?: string;
  source?: string;
}): Promise<KiroSessionToken> {
  if (token.flavor === 'aws_sso_oidc') {
    return refreshKiroSsoToken({
      flavor: 'aws_sso_oidc',
      source: token.source || 'whiteowl-cache',
      refreshToken: token.refreshToken,
      region: token.region,
      clientId: token.clientId,
      clientSecret: token.clientSecret,
    });
  }
  return refreshKiroDesktopToken({
    flavor: 'kiro_desktop',
    source: token.source || 'whiteowl-cache',
    refreshToken: token.refreshToken,
    region: token.region,
  });
}
