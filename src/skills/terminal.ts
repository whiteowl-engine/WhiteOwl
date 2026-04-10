import { Skill, SkillManifest, SkillContext, LoggerInterface } from '../types.ts';
import { sharedTerminal } from '../core/shared-terminal.ts';

function detectErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');
  const errorPatterns = [
    /^\s*error\s+TS\d+:\s*.+/i,
    /^\s*error\s+E\d+:\s*.+/i,
    /\bENOENT\b|\bEACCES\b|\bEPERM\b|\bECONNREFUSED\b/,
    /\b(?:Uncaught\s+)?(?:SyntaxError|TypeError|ReferenceError|RangeError)\b/,
    /\bCannot find module\b/i,
    /\bModule not found\b/i,
    /^npm ERR!/,
    /\bFATAL ERROR\b/i,
    /\bSegmentation fault\b/i,
    /:\s*command not found\s*$/i,
    /is not recognized as.*command/i,
    /\bBuild failed\b/i,
    /\bFailed to compile\b/i,
    /\bELIFECYCLE\b/,
  ];

  const skipPatterns = [
    /no\s+errors?\b/i,
    /\berrors?:\s*0\b/i,
    /\bwarn(ing)?\b/i,
    /if you (get|see|encounter)\b/i,
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;

    if (skipPatterns.some(p => p.test(trimmed))) continue;
    for (const pattern of errorPatterns) {
      if (pattern.test(trimmed)) {
        errors.push(trimmed.slice(0, 200));
        break;
      }
    }
  }
  return errors.slice(0, 10);
}

export class TerminalSkill implements Skill {
  manifest: SkillManifest = {
    name: 'terminal',
    version: '1.1.0',
    description: 'Persistent shared terminal — execute commands, read output. The terminal is visible in the UI so the user can see what you run.',
    tools: [
      {
        name: 'terminal_exec',
        description:
          'Execute a shell command in the shared persistent terminal. The command and its output are visible to the user in the Terminal tab. Waits up to 180s for completion. Use this for ALL execution: npm install, npm run dev, builds, tests, etc. ALWAYS call terminal_read after this to check for errors. WARNING: Do NOT call "npm run dev" or any dev server command twice — it blocks the terminal. If a server is already running, use terminal_read instead.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute (e.g. "npm install", "npm run build", "cd src && ls")',
            },
          },
          required: ['command'],
        },
        riskLevel: 'write',
      },
      {
        name: 'terminal_read',
        description:
          'Read recent output from the shared terminal. Use this to check build errors, server logs, test results, or anything the user might have run manually. Returns the last N lines of terminal output.',
        parameters: {
          type: 'object',
          properties: {
            lines: {
              type: 'number',
              description: 'Number of recent lines to read (default: 80, max: 500)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'terminal_write',
        description:
          'Write raw input to the terminal stdin. Use for interactive prompts (e.g. answering y/n, entering values). Does NOT wait for output.',
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Raw text to write to terminal stdin (include \\n for Enter)',
            },
          },
          required: ['input'],
        },
        riskLevel: 'write',
      },
      {
        name: 'terminal_clear',
        description: 'Clear the terminal output buffer.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private logger!: LoggerInterface;
  private activeBackgroundCommand: string | null = null;
  private consecutiveTimeouts = 0;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;

    sharedTerminal.start();
    this.logger.info('[Terminal] Shared terminal initialized, PID=' + (sharedTerminal.isAlive() ? 'active' : 'failed'));
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'terminal_exec': {
        const command = params.command as string;
        if (!command) return { error: 'command is required' };

        const serverPatterns = /\b(npm\s+run\s+dev|npm\s+start|npx\s+vite|npx\s+next\s+dev|yarn\s+dev|yarn\s+start|node\s+.*server|nodemon|webpack\s+serve|webpack-dev-server)\b/i;
        if (serverPatterns.test(command) && this.activeBackgroundCommand) {
          this.logger.warn(`[Terminal] Blocked duplicate server command: "${command}" — already running: "${this.activeBackgroundCommand}"`);
          return {
            command,
            output: '',
            completed: false,
            hint: `Server/watcher "${this.activeBackgroundCommand}" is already running. Do NOT launch it again — use terminal_read to check its output. If you need to restart, first kill the terminal with Ctrl+C (terminal_write "\\x03\\n").`,
          };
        }

        let killedServer: string | null = null;
        if (this.activeBackgroundCommand && !serverPatterns.test(command)) {
          this.logger.info(`[Terminal] Auto-killing server "${this.activeBackgroundCommand}" to free terminal for: ${command}`);
          sharedTerminal.write('\x03');
          await new Promise(r => setTimeout(r, 1500));
          sharedTerminal.write('\r');
          await new Promise(r => setTimeout(r, 1000));
          killedServer = this.activeBackgroundCommand;
          this.activeBackgroundCommand = null;
          this.consecutiveTimeouts = 0;

          sharedTerminal.clear();
        }

        this.logger.info(`[Terminal] exec: ${command}`);
        const result = await sharedTerminal.exec(command);
        const output = result.output.slice(0, 30_000);


        const errors = detectErrors(output);


        const outputTrimmed = output.replace(/[\s\r\n]/g, '');
        const isSuspiciouslyEmpty = result.exitMarkerFound && outputTrimmed.length < 10
          && /\b(install|build|run|test|start)\b/i.test(command);

        const res: Record<string, any> = {
          command,
          output,
          completed: result.exitMarkerFound,
        };

        if (errors.length > 0) {
          res.detectedErrors = errors;
          res.hint = `Command completed with ${errors.length} error(s). Fix the errors and retry.`;
        } else if (isSuspiciouslyEmpty) {
          res.hint = 'WARNING: Command produced almost no output. Verify the directory exists and has package.json. Use terminal_read for more details.';
        } else if (result.exitMarkerFound) {
          res.hint = 'Command completed successfully.';
        } else if (output.length > 50) {

          res.hint = 'Command is running in background (server/watcher). Output captured above. Do NOT call terminal_exec again for this command — use terminal_read to check its output.';

          this.activeBackgroundCommand = command;
        } else {
          res.hint = 'Command may still be running (timed out after 180s). Use terminal_read to check latest output.';
        }


        if (!result.exitMarkerFound && outputTrimmed.length < 10) {
          this.consecutiveTimeouts++;
          if (this.consecutiveTimeouts >= 2) {
            res.hint = `TERMINAL STUCK: ${this.consecutiveTimeouts} consecutive commands timed out with no output. STOP using terminal_exec immediately. Finish your work with project_write/project_str_replace and preview with project_serve. If you MUST use terminal, first call terminal_write("\\x03\\n") to send Ctrl+C, then retry.`;
          }
        } else {
          this.consecutiveTimeouts = 0;
        }


        if (killedServer) {
          res.note = `Server "${killedServer}" was auto-killed to free the terminal. Restart it with npm run dev when you are done building/testing.`;
        }

        return res;
      }

      case 'terminal_read': {
        const lines = Math.min(params.lines || 80, 500);
        const output = sharedTerminal.read(lines);
        return {
          lines: lines,
          output: output.slice(0, 20_000),
          alive: sharedTerminal.isAlive(),
          cwd: sharedTerminal.getCwd(),
        };
      }

      case 'terminal_write': {
        const input = params.input as string;
        if (!input) return { error: 'input is required' };
        sharedTerminal.write(input);
        return { success: true, wrote: input.length + ' chars' };
      }

      case 'terminal_clear': {
        sharedTerminal.clear();
        return { success: true, message: 'Terminal buffer cleared' };
      }

      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {
    sharedTerminal.kill();
  }
}
