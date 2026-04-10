
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { Skill, SkillManifest, SkillContext, ToolDefinition, LoggerInterface } from '../types.ts';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

export interface MCPServerConfig {

  name: string;

  transport: 'stdio' | 'sse';

  command?: string;

  args?: string[];

  env?: Record<string, string>;

  url?: string;

  headers?: Record<string, string>;

  enabled?: boolean;
}

export interface MCPConfig {
  mcpServers: MCPServerConfig[];
}

class StdioTransport {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private logger: LoggerInterface;

  config: MCPServerConfig;

  constructor(config: MCPServerConfig, logger: LoggerInterface) {
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    if (!this.config.command) throw new Error('stdio transport requires "command"');
    const env = { ...process.env, ...(this.config.env || {}) };
    this.proc = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: process.platform === 'win32',
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.logger.warn(`[MCP:${this.config.name}] stderr: ${chunk.toString().trim()}`);
    });

    this.proc.on('exit', (code) => {
      this.logger.info(`[MCP:${this.config.name}] process exited (code=${code})`);
      for (const [, p] of this.pending) p.reject(new Error('MCP process exited'));
      this.pending.clear();
    });
  }

  private processBuffer(): void {

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {

        const nlIdx = this.buffer.indexOf('\n');
        if (nlIdx >= 0) {
          const line = this.buffer.slice(0, nlIdx).trim();
          this.buffer = this.buffer.slice(nlIdx + 1);
          if (line) {
            try {
              const msg = JSON.parse(line);
              this.handleMessage(msg);
            } catch {  }
          }
          continue;
        }
        break;
      }
      const contentLen = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLen) break;
      const body = this.buffer.slice(bodyStart, bodyStart + contentLen);
      this.buffer = this.buffer.slice(bodyStart + contentLen);
      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        this.logger.warn(`[MCP:${this.config.name}] invalid JSON: ${body.slice(0, 200)}`);
      }
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }

  }

  async send(method: string, params?: Record<string, any>): Promise<any> {
    if (!this.proc || this.proc.killed) throw new Error('MCP process not running');
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const body = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  disconnect(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      this.proc = null;
    }
    for (const [, p] of this.pending) p.reject(new Error('Disconnected'));
    this.pending.clear();
  }
}


class SSETransport {
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private messagesUrl = '';
  private abortController: AbortController | null = null;
  private logger: LoggerInterface;

  config: MCPServerConfig;

  constructor(config: MCPServerConfig, logger: LoggerInterface) {
    this.config = config;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    if (!this.config.url) throw new Error('SSE transport requires "url"');

    return new Promise((resolve, reject) => {
      const url = new URL(this.config.url!);
      const client = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        ...(this.config.headers || {}),
      };

      const req = client.get(this.config.url!, { headers }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE connection failed: ${res.statusCode}`));
          return;
        }
        let buffer = '';
        let endpointReceived = false;

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('event: endpoint')) {

              continue;
            }
            if (line.startsWith('data: ') && !endpointReceived) {
              const data = line.slice(6).trim();
              if (data.startsWith('/') || data.startsWith('http')) {
                this.messagesUrl = data.startsWith('http')
                  ? data
                  : new URL(data, this.config.url!).toString();
                endpointReceived = true;
                resolve();
                continue;
              }
            }
            if (line.startsWith('data: ') && endpointReceived) {
              try {
                const msg = JSON.parse(line.slice(6));
                this.handleMessage(msg);
              } catch {  }
            }
          }
        });

        res.on('end', () => {
          if (!endpointReceived) reject(new Error('SSE stream ended without endpoint'));
        });
      });

      req.on('error', reject);

      setTimeout(() => { if (!this.messagesUrl) reject(new Error('SSE endpoint timeout')); }, 15000);
    });
  }

  private handleMessage(msg: any): void {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  async send(method: string, params?: Record<string, any>): Promise<any> {
    if (!this.messagesUrl) throw new Error('SSE not connected');
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const body = JSON.stringify(msg);
    const url = new URL(this.messagesUrl);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req = client.request(this.messagesUrl, {
                method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(this.config.headers || {}),
        },
      }, (res) => {

        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200 && res.statusCode !== 202) {
            this.pending.delete(id);
            reject(new Error(`MCP SSE POST failed: ${res.statusCode} ${data}`));
          }
        });
      });
      req.on('error', (e) => { this.pending.delete(id); reject(e); });
      req.write(body);
      req.end();

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP SSE request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  disconnect(): void {
    if (this.abortController) this.abortController.abort();
    for (const [, p] of this.pending) p.reject(new Error('Disconnected'));
    this.pending.clear();
  }
}


type Transport = StdioTransport | SSETransport;

export class MCPSkill implements Skill {
  manifest: SkillManifest;
  private transport: Transport;
  private serverConfig: MCPServerConfig;
  private logger: LoggerInterface;

  constructor(config: MCPServerConfig, logger: LoggerInterface) {
    this.serverConfig = config;
    this.config = config;
    this.logger = logger;
    this.manifest = {
      name: `mcp_${config.name}`,
      version: '1.0.0',
      description: `MCP server: ${config.name}`,
      tools: [],
    };
    this.transport = config.transport === 'sse'
      ? new SSETransport(config, logger)
      : new StdioTransport(config, logger);
  }

  async initialize(_ctx: SkillContext): Promise<void> {
    try {
      await this.transport.connect();
      this.logger.info(`[MCP:${this.serverConfig.name}] connected via ${this.serverConfig.transport}`);


      await this.transport.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'axiom', version: '1.0.0' },
      });


      const result = await this.transport.send('tools/list', {});
      const mcpTools = result?.tools || [];

      this.manifest.tools = mcpTools.map((t: any) => this.convertTool(t));
      this.logger.info(`[MCP:${this.serverConfig.name}] discovered ${this.manifest.tools.length} tools`);


      try {
        await this.transport.send('notifications/initialized', {});
      } catch {  }
    } catch (err: any) {
      this.logger.error(`[MCP:${this.serverConfig.name}] init failed: ${err.message}`);
    }
  }

  private convertTool(mcpTool: any): ToolDefinition {
    return {
      name: `mcp_${this.serverConfig.name}_${mcpTool.name}`,
      description: mcpTool.description || mcpTool.name,
      parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
      riskLevel: 'read',
    };
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {

    const prefix = `mcp_${this.serverConfig.name}_`;
    const mcpToolName = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;

    try {
      const result = await this.transport.send('tools/call', {
        name: mcpToolName,
        arguments: params,
      });


      if (result?.content && Array.isArray(result.content)) {
        const texts = result.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text);
        return texts.length === 1 ? texts[0] : texts.join('\n');
      }
      return result;
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async shutdown(): Promise<void> {
    this.transport.disconnect();
    this.logger.info(`[MCP:${this.serverConfig.name}] disconnected`);
  }
}


export class MCPManager {
  private skills: MCPSkill[] = [];
  private logger: LoggerInterface;
  private configPath: string;

  constructor(logger: LoggerInterface, configPath?: string) {
    this.logger = logger;
    this.configPath = configPath || path.join(process.cwd(), 'data', 'mcp.json');
  }

loadConfig(): MCPSkill[] {
    if (!fs.existsSync(this.configPath)) {
      this.logger.info('[MCP] No mcp.json found, skipping MCP servers');
      return [];
    }

    try {
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const config: MCPConfig = JSON.parse(raw);
      if (!config.mcpServers || !Array.isArray(config.mcpServers)) return [];

      for (const serverCfg of config.mcpServers) {
        if (serverCfg.enabled === false) continue;
        if (!serverCfg.name || !serverCfg.transport) {
          this.logger.warn('[MCP] Invalid server config (missing name or transport), skipping');
          continue;
        }
        const skill = new MCPSkill(serverCfg, this.logger);
        this.skills.push(skill);
      }

      this.logger.info(`[MCP] Loaded ${this.skills.length} server config(s) from ${this.configPath}`);
    } catch (err: any) {
      this.logger.error(`[MCP] Failed to load config: ${err.message}`);
    }

    return this.skills;
  }

  getSkills(): MCPSkill[] {
    return this.skills;
  }
}
