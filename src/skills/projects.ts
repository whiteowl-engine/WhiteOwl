
import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

function generateUnifiedDiff(oldText: string, newText: string, filename: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`];


  const maxCtx = 3;
  let i = 0, j = 0;
  const hunks: string[][] = [];
  let hunk: string[] | null = null;
  let ctxBefore: string[] = [];

  while (i < oldLines.length || j < newLines.length) {
    const ol = oldLines[i];
    const nl = newLines[j];
    if (i < oldLines.length && j < newLines.length && ol === nl) {
      if (hunk) {
        hunk.push(' ' + ol);
      }
      ctxBefore.push(' ' + ol);
      if (ctxBefore.length > maxCtx) ctxBefore.shift();
      i++; j++;
    } else {
      if (!hunk) {
        hunk = [`@@ -${i + 1} +${j + 1} @@`, ...ctxBefore];
        hunks.push(hunk);
      }
      ctxBefore = [];
      if (i < oldLines.length) { hunk.push('-' + ol); i++; }
      if (j < newLines.length) { hunk.push('+' + nl); j++; }
    }
  }

  for (const h of hunks) lines.push(...h);
  return lines.join('\n');
}

const PROJECTS_ROOT = path.join(os.homedir(), 'Desktop', 'Projects');


try { if (!fs.existsSync(PROJECTS_ROOT)) fs.mkdirSync(PROJECTS_ROOT, { recursive: true }); } catch {  }

function sanitizePath(p: string): string {

  let cleaned = p.replace(/^(?:cd\s+)?\/d\s+/i, '').trim();

  cleaned = cleaned.replace(/^mkdir\s+/i, '').trim();

  cleaned = cleaned.replace(/^["']+|["']+$/g, '');
  return cleaned;
}

function ensureInsideProjects(p: string): string {
  const clean = sanitizePath(p);
  const resolved = path.resolve(clean);

  if (!resolved.startsWith(PROJECTS_ROOT)) {
    const basename = path.basename(resolved);
    if (basename && basename !== '.' && basename !== '..') {
      const remapped = path.join(PROJECTS_ROOT, basename);
      return remapped;
    }
    throw new Error('Access denied — path must be inside ' + PROJECTS_ROOT + '. Use path like: ' + PROJECTS_ROOT + '\\my_project');
  }

  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(PROJECTS_ROOT)) {
      throw new Error('Access denied — symlink escapes project sandbox');
    }
  }
  return resolved;
}

const COMMAND_DENY_PATTERNS = [
  /\brm\s+(-\w*\s+)*-\w*r\w*\s+[\/\\]/i,
  /\bformat\b.*[a-z]:/i,
  /\bshutdown\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(curl|wget)\b.*\|\s*(ba)?sh/i,
  /\breg\s+(delete|add)\b/i,
];

function validateCommand(command: string): void {
  for (const pattern of COMMAND_DENY_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error('Command blocked by security policy: potentially dangerous pattern detected');
    }
  }
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
        description: 'Create or FULLY overwrite a file. Use ONLY for NEW files. For EXISTING files, prefer project_str_replace to avoid rewriting the whole file. Parent dirs auto-created.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write (absolute or relative to bound project)' },
            content: { type: 'string', description: 'Full file content to write' },
          },
          required: ['path', 'content'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_str_replace',
        description: [
          'Edit an EXISTING file by replacing an exact string with a new one. Like Cursor\'s StrReplace.',
          'WHEN TO USE: Any time you need to modify an existing file — prefer this over project_write (saves tokens, never loses untouched code).',
          'RULES:',
          '• old_string MUST be unique in the file (include 3-5 lines of context around the target change).',
          '• old_string must match the file EXACTLY including whitespace and indentation.',
          '• To delete code, set new_string to empty string.',
          '• To insert code, include surrounding lines in old_string and expanded version in new_string.',
          'GOOD: old_string="  return result;\\n}" new_string="  return result * 2;\\n}"',
          'BAD: old_string="result" (too short, not unique — will fail if matches multiple lines)',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to edit (absolute or relative to bound project)' },
            old_string: { type: 'string', description: 'The exact text to find and replace. Must be unique in the file. Include surrounding context lines if needed.' },
            new_string: { type: 'string', description: 'Replacement text. Empty string to delete.' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_delete',
        description: 'Delete a file or folder. Path must be inside ' + PROJECTS_ROOT + '.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File/folder path inside ' + PROJECTS_ROOT },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_mkdir',
        description: 'Create a directory (and parent directories). All paths MUST be inside ' + PROJECTS_ROOT + '. Example: ' + PROJECTS_ROOT + '\\my_app',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path inside ' + PROJECTS_ROOT + '. Example: ' + PROJECTS_ROOT + '\\project_name' },
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
            path: { type: 'string', description: 'Script file path inside ' + PROJECTS_ROOT },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_run',
        description: 'Run a shell command (npm install, npm run build, pip install, etc). Waits up to 60s for completion. Stdout+stderr returned.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run (e.g. "npm install", "npm run build")' },
            cwd: { type: 'string', description: 'Working directory inside ' + PROJECTS_ROOT },
          },
          required: ['command', 'cwd'],
        },
        riskLevel: 'write',
      },
      {
        name: 'project_start',
        description: 'Start a long-running dev server (npm run dev, npm start, python -m http.server, etc). Runs in background, returns first 10s of output + PID. Use for starting web apps.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to start (e.g. "npm run dev", "npm start")' },
            cwd: { type: 'string', description: 'Working directory inside ' + PROJECTS_ROOT },
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
        description: 'Add a TODO item to your task plan. MUST be your FIRST action before any coding. Create 8-15 specific todos upfront. Format: VERB + SPECIFIC TARGET (e.g. "Write src/fetcher.js: fetchPrices() with retry logic"). BAD: vague like "Create module" or "Initialize project".',
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
        name: 'project_semantic_search',
        description: [
          'Semantic search across project files — finds code by MEANING, not just exact text.',
          'Unlike project_search (regex), this understands intent: "authentication logic", "error handling", "database queries".',
          'Returns the most relevant code snippets ranked by relevance score.',
          'Use this when you need to find WHERE something is implemented without knowing exact identifiers.',
          'GOOD: "find where user tokens are validated", "error handling for API calls", "function that calculates price".',
          'BAD for: finding a specific known string (use project_search instead).',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project directory to search in (absolute or relative)' },
            query: { type: 'string', description: 'Natural-language description of what you are looking for' },
            topK: { type: 'number', description: 'Number of top results to return (default: 8, max: 20)' },
            filePattern: { type: 'string', description: 'Optional file extension filter, e.g. ".ts" or ".js,.py"' },
          },
          required: ['path', 'query'],
        },
        riskLevel: 'read',
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

      {
        name: 'git_status',
        description: 'Get git status of a project directory. Shows staged, unstaged, and untracked files.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path) — must be inside a git repo' },
          },
          required: ['cwd'],
        },
        riskLevel: 'read',
      },
      {
        name: 'git_diff',
        description: 'Show git diff of working changes or staged changes. Use --staged flag for staged diff.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            staged: { type: 'boolean', description: 'If true, show staged diff (--cached). Default: false (working tree diff)' },
            path: { type: 'string', description: 'Optional: limit diff to specific file path' },
          },
          required: ['cwd'],
        },
        riskLevel: 'read',
      },
      {
        name: 'git_log',
        description: 'Show recent git commit history. Returns last N commits with hash, author, date, message.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            count: { type: 'number', description: 'Number of commits to show (default: 10, max: 50)' },
          },
          required: ['cwd'],
        },
        riskLevel: 'read',
      },
      {
        name: 'git_commit',
        description: 'Stage files and create a git commit. Specify files to stage or use all=true to stage everything.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            message: { type: 'string', description: 'Commit message' },
            files: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to stage (relative to cwd)' },
            all: { type: 'boolean', description: 'If true, stage all changes (git add -A) before commit' },
          },
          required: ['cwd', 'message'],
        },
        riskLevel: 'write',
      },

      {
        name: 'project_undo',
        description: 'Undo the last file change. Restores the previous version of the file from the undo stack.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to undo (absolute or relative to bound project). If omitted, shows undo stack.' },
          },
          required: [],
        },
        riskLevel: 'write',
      },

      {
        name: 'git_branch',
        description: 'List, create, switch, or delete git branches.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'], description: 'Action to perform (default: list)' },
            name: { type: 'string', description: 'Branch name (required for create/switch/delete)' },
          },
          required: ['cwd'],
        },
        riskLevel: 'write',
      },
      {
        name: 'git_stash',
        description: 'Stash or restore working changes. Actions: save (default), pop, list, drop.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            action: { type: 'string', enum: ['save', 'pop', 'list', 'drop'], description: 'Stash action (default: save)' },
            message: { type: 'string', description: 'Stash message (for save action)' },
          },
          required: ['cwd'],
        },
        riskLevel: 'write',
      },
      {
        name: 'git_checkout',
        description: 'Discard changes in a file or restore file from a specific commit.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            path: { type: 'string', description: 'File path to restore (relative to cwd)' },
            ref: { type: 'string', description: 'Commit/branch ref to restore from (default: HEAD)' },
          },
          required: ['cwd', 'path'],
        },
        riskLevel: 'write',
      },
      {
        name: 'git_show',
        description: 'Show contents of a specific commit — message, diff, files changed.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory (absolute path)' },
            ref: { type: 'string', description: 'Commit hash or ref (default: HEAD)' },
          },
          required: ['cwd'],
        },
        riskLevel: 'read',
      },

      {
        name: 'project_glob',
        description: 'Find files matching a glob pattern. Useful to discover project structure. Skips node_modules/.git.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Root directory to search (absolute path)' },
            pattern: { type: 'string', description: 'Glob-style pattern, e.g. "**/*.ts", "src/**/*.test.js", "*.json"' },
          },
          required: ['path', 'pattern'],
        },
        riskLevel: 'read',
      },

      {
        name: 'project_diagnostics',
        description: 'Run type-checking / linting on a project. Auto-detects: tsconfig.json → tsc, package.json eslint → eslint, pyproject.toml → mypy/ruff. Returns errors/warnings.',
        parameters: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Project root directory (absolute path)' },
            tool: { type: 'string', description: 'Force specific tool: "tsc", "eslint", "mypy", "ruff". If omitted, auto-detects.' },
          },
          required: ['cwd'],
        },
        riskLevel: 'read',
      },

      {
        name: 'project_test_generate',
        description: [
          'Generate unit tests for a source file. Auto-detects test framework from project config:',
          'jest/vitest (package.json), pytest (pyproject.toml/conftest.py), mocha, go test.',
          'Reads the source file, generates a test file with appropriate imports and test cases,',
          'and writes it next to the source or in the __tests__/test directory.',
          'Then attempts to run the tests and reports results.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the source file to generate tests for (absolute or relative)' },
            framework: { type: 'string', description: 'Force test framework: "jest", "vitest", "pytest", "mocha", "go". Auto-detects if omitted.' },
            output: { type: 'string', description: 'Optional output path for the test file. Auto-generates if omitted.' },
          },
          required: ['path'],
        },
        riskLevel: 'write',
      },
    ],
  };

  logger!: LoggerInterface;
  eventBus?: EventBusInterface;
  currentAgentId?: string;
  todosPath = path.resolve('./data/project-todos.json');
  currentChatId = '';
  currentProjectFolder = '';
  undoStack: { path: string; content: string; tool: string; ts: number }[] = [];
  static MAX_UNDO_ENTRIES = 50;

  setChatId(chatId: string) {
    this.currentChatId = chatId || '';
  }

  setProjectFolder(folder: string) {
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
    this.eventBus = ctx.eventBus;
    this.logger.info('[Projects] Skill initialized');
  }

  setAgentId(agentId: string) {
    this.currentAgentId = agentId;
  }

  private emitFileChange(filePath: string, diff: string, tool: string) {
    if (this.eventBus && this.currentAgentId) {
      this.eventBus.emit('agent:file_change', {
        agentId: this.currentAgentId,
        path: filePath,
        diff,
        tool,
      });
    }
  }

  private resolvePath(p: string): string {
    const clean = sanitizePath(p);
    if (this.currentProjectFolder && !path.isAbsolute(clean)) {
      return ensureInsideProjects(path.join(this.currentProjectFolder, clean));
    }
    if (this.currentProjectFolder) {
      const resolved = path.resolve(clean);
      if (!resolved.startsWith(this.currentProjectFolder)) {
        throw new Error('Access denied — path must be inside bound project: ' + this.currentProjectFolder);
      }
      return resolved;
    }
    return ensureInsideProjects(clean);
  }

  async execute(tool: string, params: any): Promise<any> {
   try {
    switch (tool) {
      case 'project_list': {
        const dirPath = params.path ? this.resolvePath(params.path) : (this.currentProjectFolder || PROJECTS_ROOT);
        if (!fs.existsSync(dirPath)) {
          return { path: dirPath, entries: [], count: 0, error: `Directory not found: ${dirPath}` };
        }
        const entries = fs.readdirSync(dirPath);
        const result = entries
          .filter(name => !name.startsWith('.'))
          .map(name => {
            const full = path.join(dirPath, name);
            try {
              const st = fs.statSync(full);
              return { name, path: full, isDir: st.isDirectory(), size: st.size };
            } catch { return { name, path: full, isDir: false, size: 0 }; }
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
        const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        this.undoStack.push({ path: filePath, content: oldContent, tool: 'project_write', ts: Date.now() });
        if (this.undoStack.length > ProjectsSkill.MAX_UNDO_ENTRIES) this.undoStack.shift();
        fs.writeFileSync(filePath, params.content, 'utf-8');
        this.logger.info('[Projects] Wrote: ' + filePath);
        const diff = generateUnifiedDiff(oldContent, params.content, path.basename(filePath));
        this.emitFileChange(filePath, diff, 'project_write');
        const writeResult: any = { success: true, path: filePath, size: Buffer.byteLength(params.content, 'utf-8') };
        const writeDiag = await this.quickDiagnostics(filePath);
        if (writeDiag) writeResult.diagnostics = writeDiag;
        return writeResult;
      }

      case 'project_str_replace': {
        const filePath = this.resolvePath(params.path);
        if (!fs.existsSync(filePath)) {
          return { error: `File not found: ${filePath}. Use project_write to create a new file.` };
        }
        const original = fs.readFileSync(filePath, 'utf-8');
        const oldStr = params.old_string as string;
        const newStr = (params.new_string ?? '') as string;
        let occurrences = 0;
        let pos = 0;
        while ((pos = original.indexOf(oldStr, pos)) !== -1) { occurrences++; pos += oldStr.length; }
        if (occurrences === 0) {
          const firstLine = oldStr.split('\n')[0].trim().slice(0, 80);
          return {
            error: `old_string not found in ${path.basename(filePath)}. The text "${firstLine}..." does not exist verbatim. ` +
              `Use project_read to see the current file content, then copy the exact text you want to replace.`,
          };
        }
        if (occurrences > 1) {
          return {
            error: `old_string is not unique — found ${occurrences} occurrences in ${path.basename(filePath)}. ` +
              `Add more surrounding context lines to old_string to make it uniquely identify the target.`,
          };
        }
        const updated = original.replace(oldStr, newStr);
        this.undoStack.push({ path: filePath, content: original, tool: 'project_str_replace', ts: Date.now() });
        if (this.undoStack.length > ProjectsSkill.MAX_UNDO_ENTRIES) this.undoStack.shift();
        fs.writeFileSync(filePath, updated, 'utf-8');
        this.logger.info(`[Projects] str_replace in ${filePath}: ${oldStr.length} chars → ${newStr.length} chars`);
        const lineNum = original.slice(0, original.indexOf(oldStr)).split('\n').length;
        const diff = generateUnifiedDiff(original, updated, path.basename(filePath));
        this.emitFileChange(filePath, diff, 'project_str_replace');
        const replaceResult: any = { success: true, path: filePath, line: lineNum, removed: oldStr.length, added: newStr.length };
        const replaceDiag = await this.quickDiagnostics(filePath);
        if (replaceDiag) replaceResult.diagnostics = replaceDiag;
        return replaceResult;
      }

      case 'project_delete': {
        const filePath = this.resolvePath(params.path);
        if (filePath === PROJECTS_ROOT) return { error: 'Cannot delete the Projects root folder' };
        const st = fs.statSync(filePath);
        if (st.isDirectory()) { fs.rmSync(filePath, { recursive: true, force: true }); }
        else { fs.unlinkSync(filePath); }
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

      case 'project_start': {
        const cwd = this.resolvePath(params.cwd);
        this.logger.info('[Projects] Starting background process: ' + params.command + ' in ' + cwd);
        return this.runBackground(params.command, cwd);
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

      case 'project_semantic_search': {
        const dirPath = this.resolvePath(params.path);
        const query = params.query || '';
        const topK = Math.min(Number(params.topK) || 8, 20);
        const extFilter = params.filePattern || '';
        const results = this.semanticSearch(dirPath, query, topK, extFilter);
        return { query, path: dirPath, results, count: results.length };
      }

      case 'project_serve': {
        const dirPath = this.resolvePath(params.path);
        const indexFile = path.join(dirPath, 'index.html');
        if (!fs.existsSync(indexFile)) return { error: 'No index.html found in ' + dirPath };
        const relative = path.relative(PROJECTS_ROOT, dirPath).replace(/\\/g, '/');
        const port = process.env.API_PORT || '3377';
        const previewUrl = 'http://localhost:' + port + '/api/projects/preview/' + relative + '/';
        this.logger.info('[Projects] Serving preview: ' + previewUrl);
        return { success: true, url: previewUrl, path: dirPath, folder: relative };
      }


      case 'git_status': {
        const cwd = this.resolvePath(params.cwd);
        return this.runCommand('git status --porcelain', cwd);
      }

      case 'git_diff': {
        const cwd = this.resolvePath(params.cwd);
        const staged = params.staged ? ' --cached' : '';
        const filePath = params.path ? ' -- ' + params.path : '';
        return this.runCommand('git diff' + staged + filePath, cwd);
      }

      case 'git_log': {
        const cwd = this.resolvePath(params.cwd);
        const count = Math.min(Math.max(Number(params.count) || 10, 1), 50);
        return this.runCommand(`git log --oneline --format="%h %an %ad %s" --date=short -${count}`, cwd);
      }

      case 'git_commit': {
        const cwd = this.resolvePath(params.cwd);
        const message = String(params.message || 'Auto-commit').replace(/"/g, '\\"');
        if (params.all) {
          const stageResult = await this.runCommand('git add -A', cwd);
          if (stageResult.error) return stageResult;
        } else if (params.files && params.files.length > 0) {
          const files = params.files.map((f: string) => '"' + String(f).replace(/"/g, '\\"') + '"').join(' ');
          const stageResult = await this.runCommand('git add ' + files, cwd);
          if (stageResult.error) return stageResult;
        }
        return this.runCommand(`git commit -m "${message}"`, cwd);
      }


      case 'git_branch': {
        const cwd = this.resolvePath(params.cwd);
        const action = params.action || 'list';
        const name = params.name ? String(params.name).replace(/[;&|`$]/g, '') : '';
        switch (action) {
          case 'list': return this.runCommand('git branch -a --no-color', cwd);
          case 'create':
            if (!name) return { error: 'Branch name is required for create action' };
            return this.runCommand(`git branch "${name}"`, cwd);
          case 'switch':
            if (!name) return { error: 'Branch name is required for switch action' };
            return this.runCommand(`git checkout "${name}"`, cwd);
          case 'delete':
            if (!name) return { error: 'Branch name is required for delete action' };
            return this.runCommand(`git branch -d "${name}"`, cwd);
          default: return { error: `Unknown action: ${action}. Use: list, create, switch, delete` };
        }
      }

      case 'git_stash': {
        const cwd = this.resolvePath(params.cwd);
        const action = params.action || 'save';
        switch (action) {
          case 'save': {
            const msg = params.message ? ` -m "${String(params.message).replace(/"/g, '\\"')}"` : '';
            return this.runCommand('git stash push' + msg, cwd);
          }
          case 'pop': return this.runCommand('git stash pop', cwd);
          case 'list': return this.runCommand('git stash list', cwd);
          case 'drop': return this.runCommand('git stash drop', cwd);
          default: return { error: `Unknown action: ${action}. Use: save, pop, list, drop` };
        }
      }

      case 'git_checkout': {
        const cwd = this.resolvePath(params.cwd);
        const filePath = String(params.path).replace(/[;&|`$]/g, '');
        const ref = params.ref ? String(params.ref).replace(/[;&|`$]/g, '') : 'HEAD';
        return this.runCommand(`git checkout "${ref}" -- "${filePath}"`, cwd);
      }

      case 'git_show': {
        const cwd = this.resolvePath(params.cwd);
        const ref = params.ref ? String(params.ref).replace(/[;&|`$]/g, '') : 'HEAD';
        return this.runCommand(`git show "${ref}" --stat --format="commit %H%nAuthor: %an <%ae>%nDate: %ad%n%n%s%n%n%b" --date=short`, cwd);
      }

      case 'project_glob': {
        const dirPath = this.resolvePath(params.path);
        const pattern = String(params.pattern || '**/*');
        const files = this.globFiles(dirPath, pattern);
        return { path: dirPath, pattern, files, count: files.length };
      }

      case 'project_diagnostics': {
        const cwd = this.resolvePath(params.cwd);
        return this.runDiagnostics(cwd, params.tool);
      }

      case 'project_undo': {
        if (!params.path) {
          const recent = this.undoStack.slice(-10).reverse().map(e => ({
            path: e.path,
            tool: e.tool,
            age: Math.round((Date.now() - e.ts) / 1000) + 's ago',
          }));
          return { undoStack: recent, total: this.undoStack.length };
        }
        const filePath = this.resolvePath(params.path);

        let idx = -1;
        for (let i = this.undoStack.length - 1; i >= 0; i--) {
          if (this.undoStack[i].path === filePath) { idx = i; break; }
        }
        if (idx === -1) return { error: 'No undo history for: ' + filePath };
        const entry = this.undoStack.splice(idx, 1)[0];
        const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        fs.writeFileSync(filePath, entry.content, 'utf-8');
        this.logger.info('[Projects] Undo: ' + filePath + ' (' + entry.tool + ')');
        const diff = generateUnifiedDiff(currentContent, entry.content, path.basename(filePath));
        this.emitFileChange(filePath, diff, 'project_undo');
        return { success: true, path: filePath, restoredFrom: entry.tool, restoredSize: entry.content.length };
      }

      case 'project_test_generate': {
        const sourcePath = this.resolvePath(params.path);
        if (!fs.existsSync(sourcePath)) return { error: 'File not found: ' + sourcePath };
        const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
        const ext = path.extname(sourcePath);
        const baseName = path.basename(sourcePath, ext);
        const dir = path.dirname(sourcePath);

        let framework = params.framework || '';
        if (!framework) {
          framework = this.detectTestFramework(dir);
        }

        let outputPath = params.output ? this.resolvePath(params.output) : '';
        if (!outputPath) {
          if (framework === 'pytest') {
            const testDir = path.join(dir, 'tests');
            if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
            outputPath = path.join(testDir, `test_${baseName}.py`);
          } else if (framework === 'go') {
            outputPath = path.join(dir, `${baseName}_test.go`);
          } else {

            const testDir = path.join(dir, '__tests__');
            if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
            outputPath = path.join(testDir, `${baseName}.test${ext}`);
          }
        }


        const testContent = this.generateTestContent(sourceContent, sourcePath, framework, baseName, ext);


        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputPath, testContent, 'utf-8');
        this.logger.info('[Projects] Generated test: ' + outputPath);


        const runResult = this.runTests(outputPath, framework, dir);

        return {
          success: true,
          testFile: outputPath,
          framework,
          sourceFile: sourcePath,
          runResult,
        };
      }

      default:
        return { error: 'Unknown tool: ' + tool };
    }
   } catch (e: any) {

      return { error: e.message };
   }
  }

  async shutdown(): Promise<void> {
    this.logger.info('[Projects] Skill shutdown');
  }


  private loadTodos(): TodoItem[] {
    try {
      if (fs.existsSync(this.todosPath)) {
        return JSON.parse(fs.readFileSync(this.todosPath, 'utf-8'));
      }
    } catch {  }
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
      const proc = spawn(cmd, args, { cwd: path.dirname(filePath), timeout: 120000, env: { ...process.env } });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (exitCode) => {
        resolve({ path: filePath, exitCode, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000) });
      });
      proc.on('error', (err) => {
        resolve({ error: err.message });
      });
    });
  }

  private runCommand(command: string, cwd: string): Promise<any> {
    return new Promise((resolve) => {
      try { validateCommand(command); } catch (e: any) { resolve({ error: e.message }); return; }
      const isWin = process.platform === 'win32';
      const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
        cwd,
        timeout: 180000,
        env: { ...process.env },
      });
      let stdout = '', stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (exitCode) => {
        resolve({ command, cwd, exitCode, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000) });
      });
      proc.on('error', (err) => {
        resolve({ error: err.message });
      });
    });
  }

private runBackground(command: string, cwd: string): Promise<any> {
    return new Promise((resolve) => {
      try { validateCommand(command); } catch (e: any) { resolve({ error: e.message }); return; }
      const isWin = process.platform === 'win32';
      const proc = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
        cwd,
        env: { ...process.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '', stderr = '';
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;

        try { proc.unref(); } catch {  }
        resolve({
          command, cwd,
          pid: proc.pid,
          status: 'running',
          stdout: stdout.slice(0, 20000),
          stderr: stderr.slice(0, 5000),
          hint: 'Process started in background. PID=' + proc.pid + '. Check output above for the URL/port.',
        });
      };

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();

        if (/https?:\/\/localhost[:\d]*/i.test(stdout) || /Local:.*http/i.test(stdout)) {
          setTimeout(finish, 1000);
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (/https?:\/\/localhost[:\d]*/i.test(stderr) || /Local:.*http/i.test(stderr)) {
          setTimeout(finish, 1000);
        }
      });

      proc.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        resolve({ command, cwd, exitCode, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 5000), status: 'exited' });
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ error: err.message });
      });


      setTimeout(finish, 10000);
    });
  }

private semanticSearch(
    dirPath: string,
    query: string,
    topK: number,
    extFilter: string,
  ): Array<{ file: string; startLine: number; endLine: number; score: number; snippet: string }> {
    const extensions = extFilter
      ? extFilter.split(',').map(e => e.trim().startsWith('.') ? e.trim() : '.' + e.trim())
      : ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.rb', '.php', '.vue', '.svelte', '.html', '.css'];


    const tokenize = (text: string): string[] =>
      text.toLowerCase().split(/[^a-z0-9_$]+/).filter(t => t.length > 2);


    const synonymMap: Record<string, string[]> = {
      'auth': ['authentication', 'authorize', 'login', 'token', 'jwt', 'session', 'credential'],
      'authentication': ['auth', 'login', 'token', 'jwt', 'session'],
      'error': ['exception', 'catch', 'throw', 'reject', 'fail', 'invalid'],
      'exception': ['error', 'catch', 'throw'],
      'database': ['db', 'sql', 'query', 'table', 'schema', 'model', 'repository'],
      'db': ['database', 'sql', 'query', 'sqlite'],
      'api': ['endpoint', 'route', 'handler', 'controller', 'request', 'response'],
      'endpoint': ['api', 'route', 'handler'],
      'test': ['spec', 'describe', 'expect', 'assert', 'mock', 'jest', 'vitest'],
      'config': ['configuration', 'settings', 'options', 'env', 'environment'],
      'function': ['method', 'handler', 'callback', 'procedure'],
      'import': ['require', 'module', 'dependency', 'package'],
      'render': ['display', 'view', 'template', 'component', 'jsx', 'html'],
      'cache': ['memoize', 'store', 'buffer', 'redis'],
      'validate': ['check', 'verify', 'sanitize', 'parse', 'schema'],
      'price': ['cost', 'amount', 'fee', 'value', 'total'],
      'user': ['account', 'profile', 'member', 'owner'],
      'send': ['emit', 'dispatch', 'publish', 'notify', 'push'],
      'receive': ['listen', 'subscribe', 'handle', 'consume'],
    };

    const expandQuery = (tokens: string[]): string[] => {
      const expanded = new Set(tokens);
      for (const t of tokens) {
        const syns = synonymMap[t];
        if (syns) for (const s of syns) expanded.add(s);
      }
      return Array.from(expanded);
    };

    const queryTokens = tokenize(query);
    const expandedQueryTokens = expandQuery(queryTokens);
    const querySet = new Set(expandedQueryTokens);

    type Chunk = { file: string; startLine: number; endLine: number; text: string };
    const chunks: Chunk[] = [];

    const CHUNK_SIZE = 30;
    const OVERLAP = 8;

    const walk = (dir: string, depth = 0) => {
      if (depth > 8) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === '__pycache__') continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) { walk(full, depth + 1); continue; }
          if (!st.isFile() || st.size > 500_000) continue;
          if (!extensions.some(e => full.endsWith(e))) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += CHUNK_SIZE - OVERLAP) {
            const end = Math.min(i + CHUNK_SIZE, lines.length);
            chunks.push({ file: full, startLine: i + 1, endLine: end, text: lines.slice(i, end).join('\n') });
          }
        } catch {  }
      }
    };
    walk(dirPath);

    if (chunks.length === 0) return [];


    const N = chunks.length;
    const vocab = new Map<string, number>();
    const chunkTokenSets: Set<string>[] = [];
    for (const chunk of chunks) {
      const tokens = new Set(tokenize(chunk.text));
      chunkTokenSets.push(tokens);
      for (const t of tokens) {
        vocab.set(t, (vocab.get(t) || 0) + 1);
      }
    }


    const idfMap = new Map<string, number>();
    for (const [term, docFreq] of vocab) {
      idfMap.set(term, Math.log((N + 1) / (docFreq + 1)) + 1);
    }


    const queryFreq = new Map<string, number>();
    for (const t of expandedQueryTokens) queryFreq.set(t, (queryFreq.get(t) || 0) + 1);

    for (const t of queryTokens) queryFreq.set(t, (queryFreq.get(t) || 0) + 1);


    const scored = chunks.map((chunk, idx) => {
      const tokens = tokenize(chunk.text);
      const freq = new Map<string, number>();
      for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
      const len = tokens.length;


      let dotProduct = 0;
      let qMag = 0;
      let cMag = 0;


      for (const [qt, qf] of queryFreq) {
        const qTfIdf = qf * (idfMap.get(qt) || 0);
        qMag += qTfIdf * qTfIdf;
        const cf = freq.get(qt) || 0;
        if (cf > 0) {
          const cTfIdf = (cf / len) * (idfMap.get(qt) || 0);
          dotProduct += qTfIdf * cTfIdf;
        }
      }


      for (const [ct, cf] of freq) {
        const cTfIdf = (cf / len) * (idfMap.get(ct) || 0);
        cMag += cTfIdf * cTfIdf;
      }

      qMag = Math.sqrt(qMag);
      cMag = Math.sqrt(cMag);
      let score = (qMag > 0 && cMag > 0) ? dotProduct / (qMag * cMag) : 0;


      const k1 = 1.5, b = 0.75;
      const avgLen = chunks.reduce((s, c) => s + tokenize(c.text).length, 0) / N;
      let bm25 = 0;
      for (const qt of queryTokens) {
        const tf = freq.get(qt) || 0;
        if (tf === 0) continue;
        const dfVal = vocab.get(qt) || 0;
        const idfVal = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
        bm25 += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen));
      }


      score = score * 0.6 + (bm25 > 0 ? Math.min(bm25 / 10, 1) * 0.4 : 0);


      if (chunk.text.toLowerCase().includes(query.toLowerCase())) score *= 2.5;


      const fileLower = chunk.file.toLowerCase();
      for (const qt of queryTokens) {
        if (fileLower.includes(qt)) { score *= 1.3; break; }
      }

      return { ...chunk, score };
    });

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK)
      .filter(r => r.score > 0)
      .map(r => ({
        file: r.file,
        startLine: r.startLine,
        endLine: r.endLine,
        score: Math.round(r.score * 1000) / 1000,
        snippet: r.text.slice(0, 800),
      }));
  }


  private detectTestFramework(dir: string): string {

    let current = dir;
    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(current, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          if (allDeps['vitest']) return 'vitest';
          if (allDeps['jest']) return 'jest';
          if (allDeps['mocha']) return 'mocha';
        } catch {  }
        return 'vitest';
      }
      const pyPath = path.join(current, 'pyproject.toml');
      const conftest = path.join(current, 'conftest.py');
      if (fs.existsSync(pyPath) || fs.existsSync(conftest)) return 'pytest';
      const goMod = path.join(current, 'go.mod');
      if (fs.existsSync(goMod)) return 'go';
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return 'vitest';
  }

  private generateTestContent(source: string, sourcePath: string, framework: string, baseName: string, ext: string): string {

    const exports = this.extractExports(source, ext);
    const relImport = `./${path.relative(path.dirname(sourcePath), sourcePath).replace(/\\/g, '/').replace(/\.[^.]+$/, '')}`;

    switch (framework) {
      case 'vitest':
      case 'jest': {
        const importStatement = framework === 'vitest'
          ? `import { describe, it, expect } from 'vitest';`
          : '';
        const moduleImport = exports.length > 0
          ? `import { ${exports.join(', ')} } from '${relImport}';`
          : ``;
        const tests = exports.length > 0
          ? exports.map(name => `
  it('should handle ${name}', () => {

    expect(${name}).toBeDefined();
  });`).join('\n')
          : `
  it('should work correctly', () => {

    expect(true).toBe(true);
  });`;
        return `${importStatement ? importStatement + '\n' : ''}${moduleImport}

describe('${baseName}', () => {${tests}
});
`;
      }

      case 'pytest': {
        const imports = exports.length > 0
          ? `from ${baseName} import ${exports.join(', ')}`
          : `# from ${baseName} import ...`;
        const tests = exports.length > 0
          ? exports.map(name => `
def test_${name.toLowerCase()}():
    """Test ${name}."""
    # TODO: implement test for ${name}
    assert ${name} is not None
`).join('\n')
          : `
def test_placeholder():
    """TODO: implement tests."""
    assert True
`;
        return `${imports}

${tests}`;
      }

      case 'go': {
        const tests = exports.length > 0
          ? exports.map(name => `
func Test${name}(t *testing.T) {
\t
\tt.Log("Test ${name}")
}
`).join('\n')
          : `
func TestPlaceholder(t *testing.T) {
\t
\tt.Log("placeholder test")
}
`;
        return `package ${baseName}_test

import "testing"
${tests}`;
      }

      default:
        return ``;
    }
  }

  private extractExports(source: string, ext: string): string[] {
    const exports: string[] = [];
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {

      const regex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(source)) !== null) {
        if (!exports.includes(m[1])) exports.push(m[1]);
      }

      const reExport = /export\s*\{([^}]+)\}/g;
      while ((m = reExport.exec(source)) !== null) {
        const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/).pop()!.trim());
        for (const n of names) {
          if (n && !exports.includes(n)) exports.push(n);
        }
      }
    } else if (ext === '.py') {

      const regex = /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(source)) !== null) {
        if (!m[1].startsWith('_') && !exports.includes(m[1])) exports.push(m[1]);
      }
    } else if (ext === '.go') {

      const regex = /^func\s+([A-Z][A-Za-z0-9_]*)/gm;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(source)) !== null) {
        if (!exports.includes(m[1])) exports.push(m[1]);
      }
    }
    return exports.slice(0, 20);
  }

  private runTests(testPath: string, framework: string, cwd: string): { success: boolean; output: string } {
    const { execSync } = require('child_process');
    let cmd = '';
    switch (framework) {
      case 'vitest': cmd = `npx vitest run ${testPath} --reporter=verbose`; break;
      case 'jest': cmd = `npx jest ${testPath} --verbose`; break;
      case 'pytest': cmd = `python -m pytest ${testPath} -v`; break;
      case 'mocha': cmd = `npx mocha ${testPath}`; break;
      case 'go': cmd = `go test -v -run . ${path.dirname(testPath)}`; break;
      default: return { success: false, output: 'Unknown framework: ' + framework };
    }
    try {
      const output = execSync(cmd, { cwd, timeout: 120000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { success: true, output: output.slice(0, 5000) };
    } catch (err: any) {
      return { success: false, output: (err.stdout || '' + err.stderr || '').slice(0, 5000) };
    }
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
        } catch {  }
      }
    };
    walk(dirPath);
    return results;
  }

  private globFiles(dirPath: string, pattern: string, maxResults = 500): string[] {
    const results: string[] = [];
    const SKIP = new Set(['.git', 'node_modules', 'dist', '.next', '__pycache__', '.venv', 'build']);

    const regexStr = pattern
      .replace(/\\/g, '/')
      .split('/')
      .map(seg => {
        if (seg === '**') return '.*';
        return seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '<<GLOBSTAR>>')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')
          .replace(/<<GLOBSTAR>>/g, '.*');
      })
      .join('/');
    const regex = new RegExp('^' + regexStr + '$', 'i');

    const walk = (dir: string) => {
      if (results.length >= maxResults) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (results.length >= maxResults) return;
        if (SKIP.has(name)) continue;
        const full = path.join(dir, name);
        const rel = path.relative(dirPath, full).replace(/\\/g, '/');
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            walk(full);
          } else if (st.isFile()) {
            if (regex.test(rel)) {
              results.push(rel);
            }
          }
        } catch {  }
      }
    };
    walk(dirPath);
    return results;
  }

  private async runDiagnostics(cwd: string, forceTool?: string): Promise<any> {
    const tool = forceTool || this.detectDiagnosticTool(cwd);
    if (!tool) {
      return { error: 'No diagnostic tool detected. Provide tool parameter (tsc, eslint, mypy, ruff).' };
    }

    let cmd: string;
    switch (tool) {
      case 'tsc':
        cmd = 'npx tsc --noEmit --pretty false 2>&1';
        break;
      case 'eslint':
        cmd = 'npx eslint . --format compact --no-error-on-unmatched-pattern 2>&1';
        break;
      case 'mypy':
        cmd = 'mypy . --no-color-output 2>&1';
        break;
      case 'ruff':
        cmd = 'ruff check . --output-format text 2>&1';
        break;
      default:
        return { error: `Unknown diagnostic tool: ${tool}` };
    }

    const result = await this.runCommand(cmd, cwd);
    const output = (result.stdout || '') + (result.stderr || '');
    const lines = output.split('\n').filter((l: string) => l.trim());


    const errorLines = lines.filter((l: string) => /error/i.test(l));
    const warningLines = lines.filter((l: string) => /warning/i.test(l));

    return {
      tool,
      cwd,
      exitCode: result.exitCode,
      errors: errorLines.length,
      warnings: warningLines.length,
      output: output.slice(0, 30000),
    };
  }

  private detectDiagnosticTool(cwd: string): string | null {
    if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) return 'tsc';
    if (fs.existsSync(path.join(cwd, '.eslintrc.js')) || fs.existsSync(path.join(cwd, '.eslintrc.json')) || fs.existsSync(path.join(cwd, 'eslint.config.js'))) return 'eslint';
    if (fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      const content = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf-8');
      if (content.includes('[tool.ruff]')) return 'ruff';
      return 'mypy';
    }
    if (fs.existsSync(path.join(cwd, 'setup.py')) || fs.existsSync(path.join(cwd, 'requirements.txt'))) return 'mypy';

    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.devDependencies?.eslint || pkg.dependencies?.eslint) return 'eslint';
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) return 'tsc';
    } catch {  }
    return null;
  }

private async quickDiagnostics(filePath: string): Promise<{ tool: string; errors: number; summary: string } | null> {
    try {

      let dir = path.dirname(filePath);
      let projectRoot = '';
      for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'tsconfig.json')) || fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) {
          projectRoot = dir;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (!projectRoot) return null;

      const tool = this.detectDiagnosticTool(projectRoot);
      if (!tool) return null;


      if (tool !== 'tsc') return null;

      const result = await this.runCommand('npx tsc --noEmit --pretty false 2>&1', projectRoot);
      const output = (result.stdout || '') + (result.stderr || '');
      const errorLines = output.split('\n').filter((l: string) => /error TS\d+/.test(l));

      if (errorLines.length === 0) return null;
      return {
        tool: 'tsc',
        errors: errorLines.length,
        summary: errorLines.slice(0, 5).join('\n'),
      };
    } catch {
      return null;
    }
  }
}
