import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

const MAX_BUFFER_LINES = 1000;
const EXEC_TIMEOUT_MS = 180_000;
const AUTO_KILL_MS = 4 * 60 * 60_000;

export class SharedTerminal extends EventEmitter {
  private proc: pty.IPty | null = null;
  private buffer: string[] = [];
  private alive = false;
  private cwd: string;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.cwd = path.resolve('./data/projects');
  }

  start(): void {
    if (this.alive && this.proc) return;
    try { fs.mkdirSync(this.cwd, { recursive: true }); } catch {}

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/bash';

    this.proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.cwd,
      env: { ...process.env } as Record<string, string>,
    });

    this.alive = true;
    this.buffer = [];
    this.emit('started', { cwd: this.cwd, pid: this.proc.pid });

    this.proc.onData((data: string) => {
      this._appendBuffer(data);
      this.emit('output', data);
    });

    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      this.proc = null;
      this.emit('exit', exitCode);
    });

    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => { this.kill(); }, AUTO_KILL_MS);
  }

  async exec(command: string): Promise<{ output: string; exitMarkerFound: boolean }> {
    this.start();
    if (!this.alive || !this.proc) {
      return { output: '[Terminal not running]', exitMarkerFound: false };
    }

    const marker = `__WO_END_${Date.now().toString(36)}__`;
    const isWin = process.platform === 'win32';
    const fullCmd = isWin
      ? `${command} & echo ${marker}\r`
      : `${command}; echo ${marker}\n`;


    const startIdx = this.buffer.length;


    this.proc.write(fullCmd);


    const QUIESCE_MS = 5000;

    return new Promise((resolve) => {
      let settled = false;
      let lastBufferLen = 0;
      let quietSince = Date.now();

      const settle = (output: string, markerFound: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(checkInterval);
        clearTimeout(timeoutHandle);
        resolve({ output: this.stripAnsi(output), exitMarkerFound: markerFound });
      };

      const stripEchoLine = (raw: string): string => {

        return raw.replace(new RegExp('^.*' + marker + '.*$', 'gm'), '').trim();
      };

      const checkInterval = setInterval(() => {
        const recent = this.buffer.slice(startIdx).join('');
        const occurrences = recent.split(marker).length - 1;

        if (occurrences >= 2) {


          const firstEnd = recent.indexOf(marker) + marker.length;
          const secondStart = recent.indexOf(marker, firstEnd);
          const output = recent.substring(firstEnd, secondStart).trim();
          settle(output, true);
          return;
        }


        if (recent.length > lastBufferLen) {
          lastBufferLen = recent.length;
          quietSince = Date.now();
        } else if (recent.length > 0 && Date.now() - quietSince > QUIESCE_MS) {
          const cleaned = stripEchoLine(recent);
          if (cleaned.length > 50) {
            settle(cleaned, false);
            return;
          }
        }
      }, 150);

      const timeoutHandle = setTimeout(() => {
        const raw = this.buffer.slice(startIdx).join('');
        settle(stripEchoLine(raw), false);
      }, EXEC_TIMEOUT_MS);
    });
  }

write(input: string): void {
    this.start();
    if (!this.alive || !this.proc) return;
    this.proc.write(input);
  }

private stripAnsi(text: string): string {

    let cleaned = text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

    cleaned = cleaned.replace(/[\u2800-\u28FF]/g, '');

    cleaned = cleaned.replace(/^.*__WO_END_[a-z0-9]+__.*$/gm, '');

    cleaned = cleaned.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
    return cleaned;
  }

read(lines?: number): string {
    const n = lines || 100;
    return this.stripAnsi(this.buffer.slice(-n).join(''));
  }

readAll(): string {
    return this.stripAnsi(this.buffer.join(''));
  }

clear(): void {
    this.buffer = [];
    this.emit('clear');
  }

cd(dir: string): void {
    this.start();
    if (!this.alive || !this.proc) return;
    const isWin = process.platform === 'win32';
    this.proc.write(isWin ? `cd /d "${dir}"\r` : `cd "${dir}"\n`);
    this.cwd = dir;
  }

resize(cols: number, rows: number): void {
    if (this.proc && this.alive) {
      try { this.proc.resize(cols, rows); } catch {}
    }
  }

  getCwd(): string { return this.cwd; }
  isAlive(): boolean { return this.alive; }
  getBufferLineCount(): number { return this.buffer.length; }

  kill(): void {
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.alive = false;
    this.emit('exit', null);
  }

  private _appendBuffer(text: string): void {
    const lines = text.split('\n');
    for (const line of lines) {
      this.buffer.push(line + '\n');
    }

    while (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer.shift();
    }
  }
}

export const sharedTerminal = new SharedTerminal();


const MAX_TERMINALS = 10;
let _nextTermId = 1;

export class TerminalManager extends EventEmitter {
  private terminals = new Map<number, SharedTerminal>();

  constructor() {
    super();

    this.terminals.set(0, sharedTerminal);
  }

create(): { id: number; term: SharedTerminal } | null {
    if (this.terminals.size >= MAX_TERMINALS) return null;
    const id = _nextTermId++;
    const term = new SharedTerminal();
    this.terminals.set(id, term);
    this.emit('created', id);
    return { id, term };
  }

get(id: number): SharedTerminal | undefined {
    return this.terminals.get(id);
  }

remove(id: number): boolean {
    if (id === 0) return false;
    const term = this.terminals.get(id);
    if (!term) return false;
    term.kill();
    this.terminals.delete(id);
    this.emit('removed', id);
    return true;
  }

list(): { id: number; alive: boolean; cwd: string }[] {
    const result: { id: number; alive: boolean; cwd: string }[] = [];
    for (const [id, term] of this.terminals) {
      result.push({ id, alive: term.isAlive(), cwd: term.getCwd() });
    }
    return result;
  }

get size(): number { return this.terminals.size; }
}

export const terminalManager = new TerminalManager();
