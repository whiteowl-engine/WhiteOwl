/**
 * Projects Skill — Gives AI agents full project filesystem access.
 *
 * Tools: project_list, project_read, project_write, project_delete,
 *        project_mkdir, project_execute, project_search,
 *        project_todo_list, project_todo_add, project_todo_update, project_todo_remove
 *
 * Unlike Sandbox, operates on real project directories chosen by the user.
 */

import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface,
} from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

const PROJECTS_ROOT = path.join(os.homedir(), 'Desktop', 'Projects');

function ensureInsideProjects(p: string): string {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(PROJECTS_ROOT)) {
    throw new Error('Access denied — path must be inside ' + PROJECTS_ROOT);
  }
  return resolved;
}

interface TodoItem {
  id: string;
  text: string;
  status: 'todo' | 'in-progress' | 'done';
  chatId?: string;
  created: number;
  updated: number;
}

export class ProjectsSkill implements Skill {
  manifest: SkillManifest = {
    name: 'projects',
    version: '1.0.0',
    description: 'Full project filesystem access — read, write, execute files in real project directories. Includes built-in TODO list for task planning.',
    tools: [
      {
        name: 'project_list',
        description: 'List files and folders in a project directory. Returns names, sizes, types. If a project folder is bound, paths can be relative. Omit path to list the bound project root.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list (absolute or relative to bound project). Omit to list the bound project root.' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'project_read',
        description: 'Read the full content of a file in the project. If a project folder is bound, path can be relative (e.g. "src/index.ts").',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read (absolute or relative to bound project)' },
          },
          required: ['path'],
        },
        riskLevel: 'read',
      },
      {
        name: 'project_write',
        description: 'Create or overwrite a file in the project. Parent directories are created automatically. Path can be relative to bound project.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write (absolute or relative to bound project)' },
            content: { type: 'string', description: 'File content to write' },
          },
          required: ['path', 'content'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_delete',
        description: 'Delete a file or folder in the project.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute file/folder path to delete' },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_mkdir',
        description: 'Create a directory (and parent directories) in the project.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute directory path to create' },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_execute',
        description: 'Execute a script file in the project. Supports .js, .ts, .py, .sh, .bat, .ps1. Timeout: 30s.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to script file to execute' },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_run',
        description: 'Run a shell command in a specific directory. Use for npm install, npm run build, pip install, etc. Timeout: 60s.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run (e.g. "npm install", "npm run build")' },
            cwd: { type: 'string', description: 'Working directory for the command (absolute path)' },
          },
          required: ['command', 'cwd'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_search',
        description: 'Search for text/regex in project files. Returns matching lines with file paths and line numbers.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory to search in (absolute path)' },
            query: { type: 'string', description: 'Text or regex pattern to search for' },
            filePattern: { type: 'string', description: 'Glob-like extension filter, e.g. ".ts" or ".js,.tsx" (optional)' },
          },
          required: ['path', 'query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'project_todo_list',
        description: 'List all current TODO items. Use this to review your task plan.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'project_todo_add',
        description: 'Add a TODO item to your task plan. MUST be your FIRST action before any coding. Create 8-15 specific todos upfront. Format: VERB + SPECIFIC TARGET (e.g. "Write src/fetcher.js: fetchPrices() with retry logic"). BAD: vague like "Написать модуль" or "Инициализировать проект".',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'TODO item description' },
          },
          required: ['text'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_todo_update',
        description: 'Update the status of a TODO item.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'TODO item ID' },
            status: { type: 'string', description: 'New status: "todo", "in-progress", or "done"' },
            text: { type: 'string', description: 'Updated text (optional)' },
          },
          required: ['id', 'status'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_todo_remove',
        description: 'Remove a TODO item from the list.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'TODO item ID to remove' },
          },
          required: ['id'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_serve',
        description: 'Start a preview of a project folder. Returns a URL where the user can see the result (HTML/CSS/JS). Use after building a landing page, website, or any HTML project. The preview is served at /api/projects/preview/SUBFOLDER/',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the project folder to serve (must contain index.html)' },
          },
          required: ['path'],
        },
        riskLevel: 'read',
      },
    ],
  };

  private logger!: LoggerInterface;
  private todosPath = path.resolve('./data/project-todos.json');
  private currentChatId: string = '';
  private currentProjectFolder: string = '';

  setChatId(chatId: string): void {
    this.currentChatId = chatId || '';
  }

  setProjectFolder(folder: string): void {
    if (!folder) { this.currentProjectFolder = ''; return; }
    const resolved = path.resolve(folder);
    if (!resolved.startsWith(PROJECTS_ROOT)) {
      this.logger?.warn('[Projects] Rejected project folder outside PROJECTS_ROOT: ' + folder);
      this.currentProjectFolder = '';
      return;
    }
    this.currentProjectFolder = resolved;
  }

  getProjectFolder(): string {
    return this.currentProjectFolder;
  }

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger.info('[Projects] Skill initialized');
  }

  /** Resolve a path parameter — if not absolute, prepend the bound project folder */
  private resolvePath(p: string): string {
    if (this.currentProjectFolder && !path.isAbsolute(p)) {
      return ensureInsideProjects(path.join(this.currentProjectFolder, p));
    }
    // If a project folder is bound, ensure the absolute path is inside it
    if (this.currentProjectFolder) {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(this.currentProjectFolder)) {
        throw new Error('Access denied — path must be inside bound project: ' + this.currentProjectFolder);
      }
      return resolved;
    }
    return ensureInsideProjects(p);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'project_list': {
        const dirPath = params.path ? this.resolvePath(params.path) : (this.currentProjectFolder || PROJECTS_ROOT);
        const entries = fs.readdirSync(dirPath);
        const result = entries
          .filter(name => !name.startsWith('.'))
          .map(name => {
            const full = path.join(dirPath, name);
            try {
              const st = fs.statSync(full);
              return { name, path: full, isDir: st.isDirectory(), size: st.size };
            } catch {
              return { name, path: full, isDir: false, size: 0 };
            }
          });
        return { path: dirPath, entries: result, count: result.length };
      }

      case 'project_read': {
        const filePath = this.resolvePath(params.path);
        const stats = fs.statSync(filePath);
        if (stats.size > 5 * 1024 * 1024) return { error: 'File too large (>5MB)' };
        const buf = fs.readFileSync(filePath);
        const isBinary = buf.some((byte, i) => i < 8000 && byte === 0);
        if (isBinary) return { path: filePath, binary: true, size: stats.size };
        return { path: filePath, content: buf.toString('utf-8'), size: stats.size };
      }

      case 'project_write': {
        const filePath = this.resolvePath(params.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, params.content, 'utf-8');
        this.logger.info('[Projects] Wrote: ' + filePath);
        return { success: true, path: filePath, size: Buffer.byteLength(params.content, 'utf-8') };
      }

      case 'project_delete': {
        const filePath = this.resolvePath(params.path);
        if (filePath === PROJECTS_ROOT) return { error: 'Cannot delete the Projects root folder' };
        const st = fs.statSync(filePath);
        if (st.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
        this.logger.info('[Projects] Deleted: ' + filePath);
        return { success: true, path: filePath };
      }

      case 'project_mkdir': {
        const dirPath = this.resolvePath(params.path);
        fs.mkdirSync(dirPath, { recursive: true });
        return { success: true, path: dirPath };
      }

      case 'project_execute': {
        const filePath = this.resolvePath(params.path);
        this.logger.info('[Projects] Executing: ' + filePath);
        return this.runScript(filePath);
      }

      case 'project_run': {
        const cwd = this.resolvePath(params.cwd);
        this.logger.info('[Projects] Running command: ' + params.command + ' in ' + cwd);
        return this.runCommand(params.command, cwd);
      }

      case 'project_search': {
        const dirPath = this.resolvePath(params.path);
        const query = params.query;
        const extFilter = params.filePattern || '';
        const results = this.searchFiles(dirPath, query, extFilter);
        return { query, path: dirPath, matches: results, count: results.length };
      }

      case 'project_todo_list': {
        return { todos: this.loadTodosForChat() };
      }

      case 'project_todo_add': {
        const allTodos = this.loadTodos();
        const item: TodoItem = {
          id: 'td_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5),
          text: params.text,
          status: 'todo',
          chatId: this.currentChatId || undefined,
          created: Date.now(),
          updated: Date.now(),
        };
        allTodos.push(item);
        this.saveTodos(allTodos);
        this.logger.info('[Projects] TODO added: ' + params.text);
        const chatTodos = this.filterByChatId(allTodos);
        return { success: true, todo: item, total: chatTodos.length };
      }

      case 'project_todo_update': {
        const allTodos = this.loadTodos();
        const idx = allTodos.findIndex(t => t.id === params.id);
        if (idx === -1) return { error: 'TODO not found: ' + params.id };
        if (params.status) allTodos[idx].status = params.status;
        if (params.text) allTodos[idx].text = params.text;
        allTodos[idx].updated = Date.now();
        this.saveTodos(allTodos);
        return { success: true, todo: allTodos[idx] };
      }

      case 'project_todo_remove': {
        let allTodos = this.loadTodos();
        const before = allTodos.length;
        allTodos = allTodos.filter(t => t.id !== params.id);
        this.saveTodos(allTodos);
        return { success: true, removed: before > allTodos.length, remaining: this.filterByChatId(allTodos).length };
      }

      case 'project_serve': {
        const dirPath = this.resolvePath(params.path);
        const indexFile = path.join(dirPath, 'index.html');
        if (!fs.existsSync(indexFile)) return { error: 'No index.html found in ' + dirPath };
        // Calculate the subfolder name relative to PROJECTS_ROOT
        const relative = path.relative(PROJECTS_ROOT, dirPath).replace(/\\/g, '/');
        const port = process.env.API_PORT || '3377';
        const previewUrl = 'http://localhost:' + port + '/api/projects/preview/' + relative + '/';
        this.logger.info('[Projects] Serving preview: ' + previewUrl);
        return { success: true, url: previewUrl, path: dirPath, folder: relative };
      }

      default:
        return { error: 'Unknown tool: ' + tool };
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info('[Projects] Skill shutdown');
  }

  // ── Internal helpers ──

  private loadTodos(): TodoItem[] {
    try {
      if (fs.existsSync(this.todosPath)) {
        return JSON.parse(fs.readFileSync(this.todosPath, 'utf-8'));
      }
    } catch { /* ignore */ }
    return [];
  }

  private loadTodosForChat(): TodoItem[] {
    return this.filterByChatId(this.loadTodos());
  }

  private filterByChatId(todos: TodoItem[]): TodoItem[] {
    if (!this.currentChatId) return todos;
    return todos.filter(t => t.chatId === this.currentChatId);
  }

  private saveTodos(todos: TodoItem[]): void {
    fs.mkdirSync(path.dirname(this.todosPath), { recursive: true });
    fs.writeFileSync(this.todosPath, JSON.stringify(todos, null, 2), 'utf-8');
  }

  private runScript(filePath: string): Promise<any> {
    return new Promise((resolve) => {
      const ext = path.extname(filePath).toLowerCase();
      let cmd: string, args: string[];
      switch (ext) {
        case '.js': case '.mjs': cmd = 'node'; args = [filePath]; break;
        case '.ts': cmd = 'npx'; args = ['tsx', filePath]; break;
        case '.py': cmd = process.platform === 'win32' ? 'python' : 'python3'; args = [filePath]; break;
        case '.sh': cmd = 'bash'; args = [filePath]; break;
        case '.bat': case '.cmd': cmd = 'cmd'; args = ['/c', filePath]; break;
        case '.ps1': cmd = 'powershell'; args = ['-File', filePath]; break;
        default: resolve({ error: 'Unsupported file type: ' + ext }); return;
      }
      const proc = spawn(cmd, args, { cwd: path.dirname(filePath), timeout: 30000, env: { ...process.env } });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (exitCode) => {
        resolve({ path: filePath, exitCode, stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 50000) });
      });
      proc.on('error', (err) => {
        resolve({ error: err.message });
      });
    });
  }

  private runCommand(command: string, cwd: string): Promise<any> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
        cwd,
        timeout: 60000,
        env: { ...process.env },
      });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (exitCode) => {
        resolve({ command, cwd, exitCode, stdout: stdout.slice(0, 50000), stderr: stderr.slice(0, 50000) });
      });
      proc.on('error', (err) => {
        resolve({ error: err.message });
      });
    });
  }

  private searchFiles(dirPath: string, query: string, extFilter: string, maxResults = 100): Array<{ file: string; line: number; text: string }> {
    const results: Array<{ file: string; line: number; text: string }> = [];
    const extensions = extFilter ? extFilter.split(',').map(e => e.trim().startsWith('.') ? e.trim() : '.' + e.trim()) : [];
    let regex: RegExp;
    try { regex = new RegExp(query, 'i'); } catch { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

    const walk = (dir: string) => {
      if (results.length >= maxResults) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (results.length >= maxResults) return;
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === '.git') continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            walk(full);
          } else if (st.isFile() && st.size < 1024 * 1024) {
            if (extensions.length > 0 && !extensions.some(e => full.endsWith(e))) continue;
            const content = fs.readFileSync(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
                if (results.length >= maxResults) return;
              }
            }
          }
        } catch { /* skip unreadable files */ }
      }
    };
    walk(dirPath);
    return results;
  }
}
