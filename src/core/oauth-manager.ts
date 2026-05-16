import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { LoggerInterface } from '../types.ts';
import {
  detectKiroSession,
  loginViaKiroIDE,
  refreshExistingKiroToken,
  type KiroAuthFlavor,
  type KiroSessionToken,
  type DetectedSession,
} from '../llm/kiro-session.ts';

export interface OAuthProviderConfig {
  name: string;
  clientId: string;
  deviceAuthUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenEndpointAuth?: 'body' | 'basic';
}

export interface OAuthToken {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
  /** Optional metadata used by non-standard providers (e.g. Kiro). */
  meta?: {
    flavor?: KiroAuthFlavor;
    source?: string;
    region?: string;
    profileArn?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {

  github: {
    name: 'GitHub Copilot',
    clientId: 'Iv1.b507a08c87ecfe98',
    deviceAuthUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'repo'],
    tokenEndpointAuth: 'body',
  },

  google: {
    name: 'Google Cloud',
    clientId: '',
    deviceAuthUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    tokenEndpointAuth: 'body',
  },

  azure: {
    name: 'Azure AD',
    clientId: '',
    deviceAuthUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['https://cognitiveservices.azure.com/.default'],
    tokenEndpointAuth: 'body',
  },

  // Kiro is NOT a public OAuth 2.0 device-flow provider. Instead, the panel
  // re-uses an existing Kiro IDE / kiro-cli login on the local machine.
  // Defined here only so admin code that iterates OAUTH_PROVIDERS can still
  // see "kiro"; deviceAuthUrl / tokenUrl are intentionally empty and the
  // regular startDeviceFlow() guards against using them.
  kiro: {
    name: 'Kiro IDE',
    clientId: '__via_local_kiro_session__',
    deviceAuthUrl: '',
    tokenUrl: '',
    scopes: [],
    tokenEndpointAuth: 'body',
  },
};

export class OAuthManager {
  private tokens = new Map<string, OAuthToken>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private logger?: LoggerInterface;
  private storagePath: string;
  private encryptionKey: Buffer;

  constructor(dataDir: string, logger?: LoggerInterface) {
    this.logger = logger;
    this.storagePath = path.join(dataDir, 'oauth-tokens.json');

    const machineId = `${process.env.COMPUTERNAME || 'whiteowl'}-${process.env.USERNAME || 'user'}-whiteowl-oauth`;
    this.encryptionKey = crypto.createHash('sha256').update(machineId).digest();
    this.loadTokens();
  }


async startDeviceFlow(providerName: string, clientIdOverride?: string): Promise<{
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    pollFn: () => Promise<boolean>;
  }> {
    if (providerName === 'kiro') {
      throw new Error('Kiro does not use a public device-code flow. Use signInWithKiroIDE() (or click "Sign in with Kiro IDE" in the panel) — it reuses your existing Kiro IDE / kiro-cli session.');
    }

    const provider = OAUTH_PROVIDERS[providerName];
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerName}. Available: ${Object.keys(OAUTH_PROVIDERS).join(', ')}`);
    }

    const clientId = clientIdOverride || provider.clientId;
    if (!clientId) {
      throw new Error(`No client_id configured for ${providerName}. Set OAUTH_${providerName.toUpperCase()}_CLIENT_ID in .env`);
    }


    const params = new URLSearchParams({
      client_id: clientId,
      scope: provider.scopes.join(' '),
    });

    const dcResponse = await fetch(provider.deviceAuthUrl, {
            method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    if (!dcResponse.ok) {
      const errText = await dcResponse.text();
      throw new Error(`Device auth request failed: ${dcResponse.status} — ${errText}`);
    }

    const dcData = await dcResponse.json() as DeviceCodeResponse;

    this.logger?.info(
      `OAuth [${provider.name}]: Visit ${dcData.verification_uri} and enter code: ${dcData.user_code}`
    );


    const pollInterval = (dcData.interval || 5) * 1000;
    const expiresAt = Date.now() + dcData.expires_in * 1000;

    const pollFn = async (): Promise<boolean> => {
      if (Date.now() >= expiresAt) {
        throw new Error('Device code expired. Please restart the auth flow.');
      }

      await new Promise(r => setTimeout(r, pollInterval));

      const tokenParams = new URLSearchParams({
        client_id: clientId,
        device_code: dcData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      const tokenResponse = await fetch(provider.tokenUrl, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: tokenParams.toString(),
      });

      const tokenData = await tokenResponse.json() as any;

      if (tokenData.error === 'authorization_pending') {
        return false;
      }

      if (tokenData.error === 'slow_down') {
        await new Promise(r => setTimeout(r, 5000));
        return false;
      }

      if (tokenData.error) {
        throw new Error(`OAuth token error: ${tokenData.error} — ${tokenData.error_description || ''}`);
      }


      const token: OAuthToken = {
        provider: providerName,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : Date.now() + 3600 * 1000,
        scope: tokenData.scope || provider.scopes.join(' '),
        tokenType: tokenData.token_type || 'Bearer',
      };

      this.tokens.set(providerName, token);
      this.saveTokens();
      this.scheduleRefresh(providerName);
      this.logger?.info(`OAuth [${provider.name}]: ✓ Authenticated successfully`);
      return true;
    };

    return {
      userCode: dcData.user_code,
      verificationUri: dcData.verification_uri,
      expiresIn: dcData.expires_in,
      pollFn,
    };
  }

async authenticateInteractive(providerName: string, clientIdOverride?: string): Promise<OAuthToken> {
    const { userCode, verificationUri, pollFn } = await this.startDeviceFlow(providerName, clientIdOverride);

    console.log(`\n🔐 OAuth Login for ${OAUTH_PROVIDERS[providerName]?.name || providerName}`);
    console.log(`   Visit:  ${verificationUri}`);
    console.log(`   Code:   ${userCode}`);
    console.log(`   Waiting for authorization...\n`);

    while (true) {
      const done = await pollFn();
      if (done) break;
    }

    return this.tokens.get(providerName)!;
  }


async getToken(providerName: string): Promise<string | null> {
    const token = this.tokens.get(providerName);
    if (!token) return null;

    if (token.expiresAt - Date.now() < 5 * 60 * 1000) {
      // Kiro tokens use a custom refresh path (Kiro Desktop or AWS SSO OIDC),
      // not the standard OAuth 2.0 token endpoint.
      if (providerName === 'kiro' && token.meta?.flavor && token.refreshToken) {
        try {
          const fresh = await refreshExistingKiroToken({
            flavor: token.meta.flavor,
            refreshToken: token.refreshToken,
            region: token.meta.region,
            clientId: token.meta.clientId,
            clientSecret: token.meta.clientSecret,
            source: token.meta.source,
          });
          const stored = this.toOAuthToken('kiro', fresh);
          this.tokens.set('kiro', stored);
          this.saveTokens();
          this.scheduleRefresh('kiro');
          return stored.accessToken;
        } catch (err: any) {
          this.logger?.warn(`Kiro token refresh failed: ${err.message}`);
          return token.accessToken;
        }
      }

      const refreshed = await this.refreshToken(providerName);
      if (refreshed) return refreshed.accessToken;
    }

    return token.accessToken;
  }

hasToken(providerName: string): boolean {
    return this.tokens.has(providerName);
  }

getTokenInfo(providerName: string): {
    authenticated: boolean;
    expiresAt?: number;
    scope?: string;
  } {
    const token = this.tokens.get(providerName);
    if (!token) return { authenticated: false };
    return {
      authenticated: true,
      expiresAt: token.expiresAt,
      scope: token.scope,
    };
  }

revokeToken(providerName: string): void {
    this.tokens.delete(providerName);
    const timer = this.refreshTimers.get(providerName);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(providerName);
    this.saveTokens();
    this.logger?.info(`OAuth [${providerName}]: Token revoked`);
  }

getAuthenticatedProviders(): string[] {
    return Array.from(this.tokens.keys());
  }


  private async refreshToken(providerName: string): Promise<OAuthToken | null> {
    const token = this.tokens.get(providerName);
    if (!token?.refreshToken) return null;

    if (providerName === 'kiro' && token.meta?.flavor) {
      try {
        const fresh = await refreshExistingKiroToken({
          flavor: token.meta.flavor,
          refreshToken: token.refreshToken,
          region: token.meta.region,
          clientId: token.meta.clientId,
          clientSecret: token.meta.clientSecret,
          source: token.meta.source,
        });
        const stored = this.toOAuthToken('kiro', fresh);
        this.tokens.set('kiro', stored);
        this.saveTokens();
        this.scheduleRefresh('kiro');
        this.logger?.debug(`OAuth [Kiro IDE]: token refreshed via ${stored.meta?.flavor}`);
        return stored;
      } catch (err: any) {
        this.logger?.warn(`Kiro token refresh failed: ${err.message}`);
        return null;
      }
    }

    const provider = OAUTH_PROVIDERS[providerName];
    if (!provider) return null;

    try {
      const params = new URLSearchParams({
        client_id: provider.clientId,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      });

      const response = await fetch(provider.tokenUrl, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        this.logger?.warn(`OAuth [${providerName}]: Token refresh failed (${response.status})`);
        return null;
      }

      const data = await response.json() as any;

      const refreshed: OAuthToken = {
        provider: providerName,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || token.refreshToken,
        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 3600 * 1000,
        scope: data.scope || token.scope,
        tokenType: data.token_type || token.tokenType,
      };

      this.tokens.set(providerName, refreshed);
      this.saveTokens();
      this.scheduleRefresh(providerName);
      this.logger?.debug(`OAuth [${providerName}]: Token refreshed, expires in ${data.expires_in}s`);
      return refreshed;
    } catch (err: any) {
      this.logger?.error(`OAuth [${providerName}]: Refresh error — ${err.message}`);
      return null;
    }
  }

  private scheduleRefresh(providerName: string): void {
    const existing = this.refreshTimers.get(providerName);
    if (existing) clearTimeout(existing);

    const token = this.tokens.get(providerName);
    if (!token?.refreshToken) return;


    const refreshIn = Math.max(token.expiresAt - Date.now() - 5 * 60 * 1000, 60_000);
    const timer = setTimeout(() => {
      this.refreshToken(providerName).catch(() => {});
    }, refreshIn);

    this.refreshTimers.set(providerName, timer);
  }


  private loadTokens(): void {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const encrypted = fs.readFileSync(this.storagePath, 'utf-8');
      const decrypted = this.decrypt(encrypted);
      const data = JSON.parse(decrypted) as OAuthToken[];

      for (const token of data) {
        this.tokens.set(token.provider, token);
        this.scheduleRefresh(token.provider);
      }

      this.logger?.debug(`OAuth: Loaded ${data.length} token(s) from disk`);
    } catch {

    }
  }

  private saveTokens(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = Array.from(this.tokens.values());
      const json = JSON.stringify(data);
      const encrypted = this.encrypt(json);
      fs.writeFileSync(this.storagePath, encrypted, 'utf-8');
    } catch (err: any) {
      this.logger?.error(`OAuth: Failed to save tokens — ${err.message}`);
    }
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  private decrypt(text: string): string {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts.slice(1).join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

shutdown(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  /** Convert a refreshed Kiro session into our standard OAuthToken record. */
  private toOAuthToken(provider: string, fresh: KiroSessionToken): OAuthToken {
    return {
      provider,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope,
      tokenType: fresh.tokenType,
      meta: {
        flavor: fresh.flavor,
        source: fresh.source,
        region: fresh.region,
        profileArn: fresh.profileArn,
        clientId: fresh.clientId,
        clientSecret: fresh.clientSecret,
      },
    };
  }

  /**
   * Detect whether a Kiro IDE / kiro-cli session exists on the local machine
   * (used by the panel UI to decide whether the "Sign in with Kiro IDE"
   * button should be live).
   */
  async kiroSessionStatus(): Promise<{
    available: boolean;
    flavor?: KiroAuthFlavor;
    source?: string;
    region?: string;
    connected: boolean;
    expiresAt?: number;
    hint: string;
  }> {
    let detected: DetectedSession | null = null;
    try {
      detected = await detectKiroSession();
    } catch (err: any) {
      this.logger?.debug(`Kiro session detection error: ${err.message}`);
    }

    const stored = this.tokens.get('kiro');
    if (detected) {
      return {
        available: true,
        flavor: detected.flavor,
        source: detected.source,
        region: detected.region,
        connected: !!stored,
        expiresAt: stored?.expiresAt,
        hint: stored
          ? 'Kiro IDE session detected and connected.'
          : 'Kiro IDE session detected — click Connect to reuse it inside WhiteOwl.',
      };
    }

    return {
      available: false,
      connected: !!stored,
      expiresAt: stored?.expiresAt,
      hint: 'No Kiro IDE / kiro-cli session found. Sign in via the Kiro IDE app (or run `kiro-cli login`) and then click Refresh. Or use the simpler API-key path: set KIRO_API_KEY in Settings → API Keys.',
    };
  }

  /**
   * Reuse an existing Kiro IDE / kiro-cli login on this machine and store
   * a freshly-minted access token under the "kiro" provider entry.
   */
  async signInWithKiroIDE(): Promise<OAuthToken> {
    const fresh = await loginViaKiroIDE();
    const stored = this.toOAuthToken('kiro', fresh);
    this.tokens.set('kiro', stored);
    this.saveTokens();
    this.scheduleRefresh('kiro');
    this.logger?.info(`OAuth [Kiro IDE]: connected via ${fresh.flavor} (${fresh.source}, region=${fresh.region})`);
    return stored;
  }
}
