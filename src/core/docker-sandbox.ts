/**
 * DockerSandbox — Full container-based isolation with internet access.
 *
 * When Docker is available:
 *   - Runs code inside a Linux container (node:20-slim + python3)
 *   - Full internet access for npm install, pip install, fetching APIs
 *   - Filesystem isolation at kernel level (user can't escape /workspace)
 *   - Host ./data/sandbox is mounted as /workspace in container
 *
 * When Docker is NOT available:
 *   - Falls back to the local SandboxManager with network unblocked
 *   - Warns user that isolation is path-based only
 *
 * Architecture:
 *   - One long-running container per session ("whiteowl-sandbox")
 *   - docker exec for commands and file operations
 *   - WebSocket ↔ docker exec -it for interactive terminal
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execSync, ChildProcess } from 'child_process';

const SANDBOX_ROOT = path.resolve('./data/sandbox');
const IMAGE_NAME = 'whiteowl-sandbox';
const CONTAINER_NAME = 'whiteowl-sandbox';
const WORKSPACE_PATH = '/workspace';
const EXEC_TIMEOUT = 60_000; // 60s for Docker (npm install can be slow)
const MAX_OUTPUT = 32_768; // 32KB output

export interface DockerStatus {
  available: boolean;
  containerRunning: boolean;
  imageBuild: boolean;
  mode: 'docker' | 'local';
  error?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface SandboxFileInfo {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  modified: string;
}

export class DockerSandbox {
  private dockerAvailable = false;
  private containerRunning = false;
  private imageBuilt = false;
  private dockerPath = 'docker';
  private installing = false;

  constructor() {
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  }

  get root(): string { return SANDBOX_ROOT; }

  /** Check Docker availability and container status */
  async init(): Promise<DockerStatus> {
    // Find docker
    this.dockerAvailable = false;
    try {
      const result = execSync('docker --version 2>&1', { timeout: 5000, encoding: 'utf-8' });
      if (result.includes('Docker')) {
        this.dockerAvailable = true;
      }
    } catch {
      // Try common paths on Windows
      const paths = [
        path.join(process.env.ProgramFiles || '', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Docker', 'wsl', 'docker.exe'),
      ];
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            execSync(`"${p}" --version`, { timeout: 5000, encoding: 'utf-8' });
            this.dockerPath = p;
            this.dockerAvailable = true;
            break;
          }
        } catch {}
      }
    }

    if (!this.dockerAvailable) {
      return { available: false, containerRunning: false, imageBuild: false, mode: 'local' };
    }

    // Check if image exists
    try {
      const images = execSync(`${this.cmd()} images ${IMAGE_NAME} --format "{{.Repository}}"`, {
        timeout: 10000, encoding: 'utf-8'
      }).trim();
      this.imageBuilt = images.includes(IMAGE_NAME);
    } catch {
      this.imageBuilt = false;
    }

    // Check if container is running
    try {
      const status = execSync(
        `${this.cmd()} inspect ${CONTAINER_NAME} --format "{{.State.Running}}" 2>&1`,
        { timeout: 5000, encoding: 'utf-8' }
      ).trim();
      this.containerRunning = status === 'true';
    } catch {
      this.containerRunning = false;
    }

    return {
      available: true,
      containerRunning: this.containerRunning,
      imageBuild: this.imageBuilt,
      mode: 'docker',
    };
  }

  /** Build the sandbox Docker image */
  async buildImage(): Promise<{ success: boolean; log: string }> {
    if (!this.dockerAvailable) {
      return { success: false, log: 'Docker not available' };
    }

    const dockerfilePath = path.resolve('./sandbox.Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      return { success: false, log: 'sandbox.Dockerfile not found' };
    }

    return new Promise((resolve) => {
      const child = spawn(this.dockerPath, [
        'build', '-t', IMAGE_NAME, '-f', dockerfilePath, '.'
      ], { cwd: path.resolve('.'), timeout: 300_000 }); // 5min timeout

      let log = '';
      child.stdout?.on('data', (d: Buffer) => { log += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { log += d.toString(); });
      child.on('close', (code) => {
        this.imageBuilt = code === 0;
        resolve({ success: code === 0, log });
      });
      child.on('error', (err) => {
        resolve({ success: false, log: err.message });
      });
    });
  }

  /** Install Docker Desktop — tries winget, falls back to direct download */
  async installDocker(onProgress?: (msg: string) => void): Promise<{ success: boolean; log: string; needsRestart: boolean }> {
    if (this.dockerAvailable) {
      return { success: true, log: 'Docker is already installed', needsRestart: false };
    }
    if (this.installing) {
      return { success: false, log: 'Installation already in progress', needsRestart: false };
    }
    this.installing = true;

    const log = (msg: string) => { if (onProgress) onProgress(msg); };

    try {
      // Try winget first
      let hasWinget = false;
      try {
        execSync('winget --version', { timeout: 10000, encoding: 'utf-8' });
        hasWinget = true;
      } catch { /* no winget */ }

      if (hasWinget) {
        log('Starting Docker Desktop installation via winget...');
        log('This may take several minutes.');

        return new Promise((resolve) => {
          const child = spawn('winget', [
            'install', 'Docker.DockerDesktop',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--silent',
          ], {
            timeout: 600_000,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let output = '';
          child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); output += s; log(s.trim()); });
          child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); output += s; log(s.trim()); });

          child.on('close', (code) => {
            this.installing = false;
            if (code === 0) {
              log('Docker Desktop installed successfully!');
              log('A system restart or Docker Desktop launch may be required.');
              resolve({ success: true, log: output, needsRestart: true });
            } else {
              log('Installation failed (exit code: ' + code + ')');
              resolve({ success: false, log: output || 'winget install failed with code ' + code, needsRestart: false });
            }
          });
          child.on('error', (err) => { this.installing = false; resolve({ success: false, log: err.message, needsRestart: false }); });
        });
      }

      // Fallback: download installer directly via PowerShell
      log('winget not found — downloading Docker Desktop installer directly...');
      log('Downloading from docker.com (~600 MB). Please wait...');

      const installerPath = path.join(os.tmpdir(), 'DockerDesktopInstaller.exe');
      const downloadUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';

      return new Promise((resolve) => {
        // Download phase
        const dlCmd = `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${installerPath}' -UseBasicParsing"`;
        const dlChild = spawn('cmd', ['/c', dlCmd], {
          timeout: 900_000, // 15 min for download
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let dlOut = '';
        dlChild.stdout?.on('data', (d: Buffer) => { const s = d.toString(); dlOut += s; if (s.trim()) log(s.trim()); });
        dlChild.stderr?.on('data', (d: Buffer) => { const s = d.toString(); dlOut += s; if (s.trim()) log(s.trim()); });

        dlChild.on('close', (dlCode) => {
          if (dlCode !== 0) {
            this.installing = false;
            log('Download failed (exit code: ' + dlCode + ')');
            resolve({ success: false, log: dlOut || 'Download failed', needsRestart: false });
            return;
          }

          log('Download complete. Running installer (silent mode)...');
          log('This may take several minutes...');

          // Install phase
          const instChild = spawn(installerPath, ['install', '--quiet', '--accept-license'], {
            timeout: 600_000,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let instOut = '';
          instChild.stdout?.on('data', (d: Buffer) => { const s = d.toString(); instOut += s; if (s.trim()) log(s.trim()); });
          instChild.stderr?.on('data', (d: Buffer) => { const s = d.toString(); instOut += s; if (s.trim()) log(s.trim()); });

          instChild.on('close', (instCode) => {
            this.installing = false;
            // Clean up installer
            try { require('fs').unlinkSync(installerPath); } catch {}

            if (instCode === 0) {
              log('Docker Desktop installed successfully!');
              log('A system restart or Docker Desktop launch may be required.');
              resolve({ success: true, log: instOut, needsRestart: true });
            } else {
              log('Installer exited with code: ' + instCode);
              resolve({ success: false, log: instOut || 'Installer failed with code ' + instCode, needsRestart: false });
            }
          });
          instChild.on('error', (err) => { this.installing = false; resolve({ success: false, log: err.message, needsRestart: false }); });
        });
        dlChild.on('error', (err) => { this.installing = false; resolve({ success: false, log: err.message, needsRestart: false }); });
      });
    } catch (err: any) {
      this.installing = false;
      return { success: false, log: err.message || 'Unknown error', needsRestart: false };
    }
  }

  get isInstalling(): boolean { return this.installing; }

  /** Start the sandbox container */
  async startContainer(): Promise<{ success: boolean; error?: string }> {
    if (!this.dockerAvailable) return { success: false, error: 'Docker not available' };
    if (!this.imageBuilt) {
      const build = await this.buildImage();
      if (!build.success) return { success: false, error: 'Image build failed: ' + build.log.slice(-500) };
    }

    // Remove existing container if exists
    try {
      execSync(`${this.cmd()} rm -f ${CONTAINER_NAME} 2>&1`, { timeout: 10000 });
    } catch {}

    try {
      // Start container with:
      // - Volume mount: host sandbox → /workspace
      // - Full network access (default bridge)
      // - Memory limit: 512MB
      // - CPU limit: 1 core
      // - Non-root user inside
      // - Keep running (tail -f /dev/null)
      const sandboxAbs = path.resolve(SANDBOX_ROOT).replace(/\\/g, '/');
      execSync(
        `${this.cmd()} run -d ` +
        `--name ${CONTAINER_NAME} ` +
        `--memory=512m ` +
        `--cpus=1 ` +
        `--pids-limit=100 ` +
        `-v "${sandboxAbs}:${WORKSPACE_PATH}" ` +
        `-w ${WORKSPACE_PATH} ` +
        `${IMAGE_NAME} ` +
        `tail -f /dev/null`,
        { timeout: 30000, encoding: 'utf-8' }
      );
      this.containerRunning = true;
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** Stop the sandbox container */
  async stopContainer(): Promise<void> {
    try {
      execSync(`${this.cmd()} stop ${CONTAINER_NAME} -t 5 2>&1`, { timeout: 15000 });
      execSync(`${this.cmd()} rm -f ${CONTAINER_NAME} 2>&1`, { timeout: 10000 });
    } catch {}
    this.containerRunning = false;
  }

  /** Get current mode */
  getMode(): 'docker' | 'local' {
    return this.dockerAvailable && this.containerRunning ? 'docker' : 'local';
  }

  /** Is Docker container running */
  isContainerRunning(): boolean {
    return this.containerRunning;
  }

  private cmd(): string {
    return this.dockerPath.includes(' ') ? `"${this.dockerPath}"` : this.dockerPath;
  }

  // ═══════════════════════════════════════════
  //  File Operations (work on host FS directly since volume-mounted)
  // ═══════════════════════════════════════════

  safePath(relPath: string): string {
    if (relPath.includes('\0')) throw new Error('Invalid path: null bytes');
    const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolute = path.resolve(SANDBOX_ROOT, cleaned);
    if (!absolute.startsWith(SANDBOX_ROOT)) throw new Error('Path traversal blocked');
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute);
      if (!real.startsWith(SANDBOX_ROOT)) throw new Error('Symlink escape blocked');
    }
    return absolute;
  }

  list(relDir: string = '/'): SandboxFileInfo[] {
    const dir = this.safePath(relDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).map(e => {
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

  read(relPath: string): string {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);
    if (fs.statSync(abs).isDirectory()) throw new Error('Cannot read directory');
    return fs.readFileSync(abs, 'utf-8');
  }

  write(relPath: string, content: string): void {
    const abs = this.safePath(relPath);
    const parentDir = path.dirname(abs);
    if (!parentDir.startsWith(SANDBOX_ROOT)) throw new Error('Path traversal blocked');
    fs.mkdirSync(parentDir, { recursive: true });
    const realParent = fs.realpathSync(parentDir);
    if (!realParent.startsWith(SANDBOX_ROOT)) throw new Error('Symlink escape blocked');
    fs.writeFileSync(abs, content, 'utf-8');
  }

  remove(relPath: string): void {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);
    if (fs.statSync(abs).isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
    } else {
      fs.unlinkSync(abs);
    }
  }

  mkdir(relPath: string): void {
    fs.mkdirSync(this.safePath(relPath), { recursive: true });
  }

  // ═══════════════════════════════════════════
  //  Code Execution
  // ═══════════════════════════════════════════

  /** Execute a command in the Docker container (or locally as fallback) */
  async execute(relPath: string): Promise<SandboxExecResult> {
    const abs = this.safePath(relPath);
    if (!fs.existsSync(abs)) throw new Error('File not found: ' + relPath);

    const ext = path.extname(abs).toLowerCase();
    const containerPath = WORKSPACE_PATH + '/' + path.relative(SANDBOX_ROOT, abs).replace(/\\/g, '/');

    if (this.getMode() === 'docker') {
      return this.execInDocker(containerPath, ext);
    } else {
      return this.execLocal(abs, ext);
    }
  }

  /** Execute command string in container */
  async execCommand(command: string): Promise<SandboxExecResult> {
    if (this.getMode() === 'docker') {
      return this.dockerExec(['bash', '-c', command]);
    } else {
      return this.localExec(command);
    }
  }

  private async execInDocker(containerPath: string, ext: string): Promise<SandboxExecResult> {
    let cmd: string[];
    if (ext === '.ts') {
      cmd = ['npx', 'tsx', containerPath];
    } else if (ext === '.js' || ext === '.mjs') {
      cmd = ['node', containerPath];
    } else if (ext === '.py') {
      cmd = ['python3', containerPath];
    } else {
      return { stdout: '', stderr: 'Unsupported file type: ' + ext, exitCode: 1, timedOut: false };
    }
    return this.dockerExec(cmd);
  }

  private async dockerExec(cmd: string[]): Promise<SandboxExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child = spawn(this.dockerPath, [
        'exec', CONTAINER_NAME, ...cmd
      ], { timeout: EXEC_TIMEOUT });

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d.toString().slice(0, MAX_OUTPUT - stdout.length);
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT) stderr += d.toString().slice(0, MAX_OUTPUT - stderr.length);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
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

  private async execLocal(abs: string, ext: string): Promise<SandboxExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      let cmd: string;
      let args: string[];

      if (ext === '.ts') {
        cmd = 'npx';
        args = ['tsx', abs];
      } else if (ext === '.js' || ext === '.mjs') {
        cmd = 'node';
        args = [abs];
      } else if (ext === '.py') {
        cmd = 'python';
        args = [abs];
      } else {
        return resolve({ stdout: '', stderr: 'Unsupported: ' + ext, exitCode: 1, timedOut: false });
      }

      const child = spawn(cmd, args, {
        cwd: SANDBOX_ROOT,
        timeout: EXEC_TIMEOUT,
        env: {
          ...process.env,
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

  private async localExec(command: string): Promise<SandboxExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWin ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd: SANDBOX_ROOT,
        timeout: EXEC_TIMEOUT,
        env: {
          ...process.env,
          HOME: SANDBOX_ROOT,
          USERPROFILE: SANDBOX_ROOT,
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

  // ═══════════════════════════════════════════
  //  Interactive Terminal (for WebSocket bridge)
  // ═══════════════════════════════════════════

  /** Spawn an interactive shell — returns the ChildProcess for piping via WS */
  spawnTerminal(): ChildProcess | null {
    if (this.getMode() === 'docker') {
      return spawn(this.dockerPath, [
        'exec', '-i', CONTAINER_NAME, '/bin/bash'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      const isWin = process.platform === 'win32';
      return spawn(isWin ? 'cmd.exe' : '/bin/bash', isWin ? ['/Q'] : [], {
        cwd: SANDBOX_ROOT,
        env: {
          ...process.env,
          HOME: SANDBOX_ROOT,
          USERPROFILE: SANDBOX_ROOT,
          TEMP: path.join(SANDBOX_ROOT, '.tmp'),
          TMP: path.join(SANDBOX_ROOT, '.tmp'),
          ...(isWin ? { PROMPT: 'sandbox$G ' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }
  }

  // ═══════════════════════════════════════════
  //  Stats & Cleanup
  // ═══════════════════════════════════════════

  getStats(): { files: number; totalSize: number; mode: string; containerRunning: boolean } {
    return {
      files: this.countFiles(),
      totalSize: this.getTotalSize(),
      mode: this.getMode(),
      containerRunning: this.containerRunning,
    };
  }

  wipe(): void {
    if (fs.existsSync(SANDBOX_ROOT)) {
      fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    }
    fs.mkdirSync(SANDBOX_ROOT, { recursive: true });
  }

  private getTotalSize(dir: string = SANDBOX_ROOT): number {
    let total = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? this.getTotalSize(p) : fs.statSync(p).size;
    }
    return total;
  }

  private countFiles(dir: string = SANDBOX_ROOT): number {
    let count = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      count += e.isDirectory() ? this.countFiles(path.join(dir, e.name)) : 1;
    }
    return count;
  }
}
