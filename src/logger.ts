import { LoggerInterface } from './types.ts';
import * as fs from 'fs';
import * as path from 'path';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatData(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return ` ${data}`;
  if (data instanceof Error) {
    const msg = data.message || String(data);
    const stack = data.stack ? `\n  ${data.stack.split('\n').slice(1, 4).join('\n  ')}` : '';
    return ` ${msg}${stack}`;
  }
  try {
    const s = JSON.stringify(data, null, 0);
    return s.length > 200 ? ` ${s.slice(0, 200)}...` : ` ${s}`;
  } catch {
    return ` [Object]`;
  }
}

export class Logger implements LoggerInterface {
  private logStream: fs.WriteStream | null = null;
  private verbose: boolean;

  constructor(opts?: { logFile?: string; verbose?: boolean }) {
    this.verbose = opts?.verbose ?? false;

    if (opts?.logFile) {
      const dir = path.dirname(opts.logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.logStream = fs.createWriteStream(opts.logFile, { flags: 'a' });
    }
  }

  info(msg: string, data?: any): void {
    const line = `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.blue}INFO${COLORS.reset}  ${msg}${formatData(data)}`;
    console.log(line);
    this.writeToFile('INFO', msg, data);
  }

  warn(msg: string, data?: any): void {
    const line = `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${msg}${formatData(data)}`;
    console.log(line);
    this.writeToFile('WARN', msg, data);
  }

  error(msg: string, data?: any): void {
    const line = `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}ERROR${COLORS.reset} ${msg}${formatData(data)}`;
    console.error(line);
    this.writeToFile('ERROR', msg, data);
  }

  debug(msg: string, data?: any): void {
    if (!this.verbose) return;
    const line = `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.dim}DEBUG${COLORS.reset} ${msg}${formatData(data)}`;
    console.log(line);
    this.writeToFile('DEBUG', msg, data);
  }

  trade(msg: string, data?: any): void {
    const line = `${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}TRADE${COLORS.reset} ${msg}${formatData(data)}`;
    console.log(line);
    this.writeToFile('TRADE', msg, data);
  }

  private writeToFile(level: string, msg: string, data?: any): void {
    if (!this.logStream) return;
    const entry = `${timestamp()} [${level}] ${msg}${formatData(data)}\n`;
    this.logStream.write(entry);
  }

  destroy(): void {
    this.logStream?.end();
  }
}
