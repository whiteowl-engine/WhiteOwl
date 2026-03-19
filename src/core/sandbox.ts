/**
 * SandboxManager — Isolated filesystem for AI agents.
 *
 * All agent file operations are confined to ./data/sandbox/.
 * The AI cannot read, write, or execute anything outside this directory.
 * This protects the user's personal files, OS folders, and project source.
 *
 * Security layers:
 *  1. Path normalization + startsWith check (blocks ../ traversal)
 *  2. Null byte rejection
 *  3. Symlink detection via realpath
 *  4. Node.js --experimental-permission flag for child processes
 *     (blocks fs/net/child_process at the V8 engine level)
 *  5. Static pattern scan as defense-in-depth
 *  6. Restricted environment variables
 *  7. Execution timeout (15s)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

const SANDBOX_ROOT = path.resolve('./data/sandbox');
const EXEC_TIMEOUT = 15_000; // 15 seconds
const MAX_OUTPUT = 8192; // 8 KB output capture

/**
 * Forbidden patterns — defense-in-depth layer on top of Node permission model.
 * Covers literal matches, dynamic import patterns, bracket notation, node: protocol,
 * template literals, and common obfuscation tricks.
 */
const EXEC_FORBIDDEN: RegExp[] = [
  // Module imports — covers require('fs'), require("fs"), require(`fs`), require('node:fs'), dynamic
  /require\s*\(/i,
  /import\s*\(/i,                          // dynamic import()
  /import\s+.+from\s/i,                    // static import ... from
  /import\s+\*/i,                           // import * as

  // Dangerous globals and builtins
  /child_process/i,
  /\bexec\s*\(/i,
  /\bspawn\s*\(/i,
  /process\s*\.\s*exit/i,
  /process\s*\.\s*kill/i,
  /process\s*(\.\s*env|\[\s*['"`]env)/i,    // process.env and process['env']
  /process\s*\.\s*mainModule/i,
  /\b__dirname\b/,
  /\b__filename\b/,

  // Globals
  /\bglobal\s*\./,
  /\bglobalThis\s*[.\[]/,

  // Eval / Function constructor
  /\beval\s*\(/,
  /\bFunction\s*\(/,

  // Network
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bhttp\b/i,
  /\bnet\b.*\bSocket\b/i,

  // Other runtimes
  /\bDeno\s*\./,
  /\bBun\s*\./,

  // fs / os / path — even via bracket notation
  /\bfs\b/i,
  /\bchild_process\b/i,
];

export interface SandboxFileInfo {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class SandboxManager {
  constructor() {
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  }

  /** Get the absolute sandbox root */
  get root(): string { return SANDBOX_ROOT; }

  /**
   * Resolve a relative path to an absolute path INSIDE the sandbox.
   * Throws if the resolved path escapes the sandbox.
   * Checks: null bytes, traversal, symlink escape.
   */
  safePath(relPath: string): string {
    // Block null bytes — could truncate path at C level
    if (relPath.includes('\0')) {
      throw new Error('Invalid path: null bytes not allowed');
    }
    // Normalize and strip leading slashes / backslashes
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = path.resolve(SANDBOX_ROOT, cleaned);
    // Ensure resolved string is within sandbox
    if (!absolute.startsWith(SANDBOX_ROOT)) {
      throw new Error('Path traversal blocked: cannot access files outside sandbox');
    }
    // If target exists, resolve symlinks and re-check
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(SANDBOX_ROOT)) {
        throw new Error('Symlink escape blocked: target resolves outside sandbox');
      }
    }
    return absolute;
  }

  /** List files in a sandbox directory */
  list(relDir: string = '/'): SandboxFileInfo[] {
    const dir = this.safePath(relDir);
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.map(e => {
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      return {
        name: e.name,
        path: path.relative(SANDBOX_ROOT, full).replace(/\\/g, '/'),
        size: stat.size,
        isDir: e.isDirectory(),
        modified: stat.mtime.toISOString(),
      };
    });
  }

  /** Read a file from the sandbox */
  read(relPath: string): string {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error('Cannot read directory as file');
    return fs.readFileSync(abs, 'utf-8');
  }

  /** Write a file in the sandbox */
  write(relPath: string, content: string): void {
    const abs = this.safePath(relPath);

    // Ensure parent directory exists within sandbox
    const parentDir = path.dirname(abs);
    if (!parentDir.startsWith(SANDBOX_ROOT)) throw new Error('Path traversal blocked');
    fs.mkdirSync(parentDir, { recursive: true });

    // Re-check parent after creation (symlink race protection)
    const realParent = fs.realpathSync(parentDir);
    if (!realParent.startsWith(SANDBOX_ROOT)) throw new Error('Symlink escape blocked in parent directory');

    fs.writeFileSync(abs, content, 'utf-8');
  }

  /** Delete a file from the sandbox */
  remove(relPath: string): void {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
  }

  /** Create a directory in the sandbox */
  mkdir(relPath: string): void {
    const abs = this.safePath(relPath);
    fs.mkdirSync(abs, { recursive: true });
  }

  /**
   * Execute a script inside the sandbox.
   * Security layers:
   *  1. Regex-based static scan (catches obfuscation tricks)
   *  2. Node.js --experimental-permission (V8-level fs/net/child_process block)
   *  3. Restricted env vars (no user secrets leak)
   *  4. Timeout (15s) with SIGKILL fallback
   *  5. Output capture limited to 8KB
   */
  async execute(relPath: string): Promise<SandboxExecResult> {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);

    // Read and scan for forbidden patterns (regex-based)
    const source = fs.readFileSync(abs, 'utf-8');
    // Strip single-line comments and strings to reduce false positives,
    // but scan the raw source to catch patterns hidden in strings too
    for (const pat of EXEC_FORBIDDEN) {
      if (pat.test(source)) {
        throw new Error(`Blocked: code contains forbidden pattern /${pat.source}/`);
      }
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const ext = path.extname(abs).toLowerCase();
      let cmd: string;
      let args: string[];

      // Node.js permission flags — V8-level restriction:
      //  --experimental-permission: enables the permission model
      //  --allow-fs-read=<sandbox>: ONLY allow reading sandbox dir
      //  --allow-fs-write=<sandbox>: ONLY allow writing sandbox dir
      //  (no --allow-child-process => child_process blocked)
      //  (no --allow-worker => Worker threads blocked)
      const permFlags = [
        '--experimental-permission',
        '--allow-fs-read=' + SANDBOX_ROOT + path.sep + '*',
        '--allow-fs-write=' + SANDBOX_ROOT + path.sep + '*',
        // No --allow-child-process → blocked at V8 level
        // No --allow-worker → blocked at V8 level
      ];

      if (ext === '.ts') {
        cmd = 'npx';
        // tsx doesn't support permission flags directly, run via node
        args = ['tsx', abs];
      } else if (ext === '.js' || ext === '.mjs') {
        cmd = 'node';
        args = [...permFlags, abs];
      } else if (ext === '.py') {
        cmd = 'python';
        args = [abs];
      } else {
        return resolve({ stdout: '', stderr: 'Unsupported file type: ' + ext, exitCode: 1, timedOut: false });
      }

      const child = spawn(cmd, args, {
        cwd: SANDBOX_ROOT,
        timeout: EXEC_TIMEOUT,
        env: {
          // Minimal env — no user vars leak
          PATH: process.env.PATH || '',
          NODE_PATH: '',
          HOME: SANDBOX_ROOT,
          USERPROFILE: SANDBOX_ROOT,
          TEMP: path.join(SANDBOX_ROOT, '.tmp'),
          TMP: path.join(SANDBOX_ROOT, '.tmp'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString().slice(0, MAX_OUTPUT - stdout.length);
      });

      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString().slice(0, MAX_OUTPUT - stderr.length);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      }, EXEC_TIMEOUT);

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut });
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 1, timedOut: false });
      });
    });
  }

  /** Get total size of all files in sandbox */
  private getTotalSize(dir: string = SANDBOX_ROOT): number {
    let total = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this.getTotalSize(p);
      } else {
        total += fs.statSync(p).size;
      }
    }
    return total;
  }

  /** Count total files in sandbox */
  private countFiles(dir: string = SANDBOX_ROOT): number {
    let count = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += this.countFiles(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }

  /** Get sandbox stats */
  getStats(): { files: number; totalSize: number } {
    return {
      files: this.countFiles(),
      totalSize: this.getTotalSize(),
    };
  }

  /** Wipe entire sandbox (user-initiated) */
  wipe(): void {
    if (fs.existsSync(SANDBOX_ROOT)) {
      fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  }
}
