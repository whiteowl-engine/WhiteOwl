import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types.ts';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CUSTOM_DIR = path.join(__dirname, 'custom');

export class SkillBuilderSkill implements Skill {
  manifest: SkillManifest = {
    name: 'skill-builder',
    version: '1.0.0',
    description: 'Create, list, and manage custom skills via AI. Generate new TypeScript skill files that plug into the WhiteOwl framework.',
    tools: [
      {
        name: 'create_custom_skill',
        description: 'Create a new custom skill. Provide a name, description, and tool definitions. The AI generates a complete TypeScript skill file implementing the Skill interface.',
        parameters: {
          type: 'object',
          properties: {
            skillName: {
              type: 'string',
              description: 'Unique name for the skill (kebab-case, e.g. "whale-alert")',
            },
            description: {
              type: 'string',
              description: 'What this skill does',
            },
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Tool name (snake_case)' },
                  description: { type: 'string', description: 'What the tool does' },
                  parameters: { type: 'object', description: 'JSON Schema for parameters' },
                  riskLevel: { type: 'string', enum: ['read', 'write', 'financial'] },
                },
              },
              description: 'Array of tool definitions for this skill',
            },
            executeLogic: {
              type: 'string',
              description: 'TypeScript code for the execute method body. Has access to: this.ctx (SkillContext), this.logger, tool (string), params (Record<string,any>). Must return a value.',
            },
            initializeLogic: {
              type: 'string',
              description: 'Optional TypeScript code run on skill init. Has access to this.ctx, this.logger.',
            },
          },
          required: ['skillName', 'description', 'tools', 'executeLogic'],
        },
        riskLevel: 'write',
      },
      {
        name: 'list_custom_skills',
        description: 'List all custom skills that have been created',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'read_custom_skill',
        description: 'Read the source code of a custom skill',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Name of the custom skill to read' },
          },
          required: ['skillName'],
        },
        riskLevel: 'read',
      },
      {
        name: 'delete_custom_skill',
        description: 'Delete a custom skill file',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Name of the custom skill to delete' },
          },
          required: ['skillName'],
        },
        riskLevel: 'write',
      },
    ],
  };

  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private ctx!: SkillContext;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;

    if (!fs.existsSync(CUSTOM_DIR)) {
      fs.mkdirSync(CUSTOM_DIR, { recursive: true });
    }
    this.logger.info('[SkillBuilder] Ready. Custom skills dir: ' + CUSTOM_DIR);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'create_custom_skill': return this.createSkill(params);
      case 'list_custom_skills': return this.listSkills();
      case 'read_custom_skill': return this.readSkill(params.skillName);
      case 'delete_custom_skill': return this.deleteSkill(params.skillName);
      default: return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}


  private sanitizeName(name: string): string {
    return name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  }

  private toClassName(kebab: string): string {
    return kebab.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Skill';
  }

  private async createSkill(params: Record<string, any>) {
    const name = this.sanitizeName(params.skillName);
    if (!name) return { error: 'Invalid skill name' };
    const className = this.toClassName(name);
    const filePath = path.join(CUSTOM_DIR, `${name}.ts`);

    if (fs.existsSync(filePath)) {
      return { error: `Custom skill "${name}" already exists. Delete it first or choose a different name.` };
    }

    const tools = params.tools || [];
    const toolsDef = JSON.stringify(tools, null, 6);
    const execLogic = params.executeLogic || 'return { error: "Not implemented" };';
    const initLogic = params.initializeLogic || '';


    const forbidden = ['child_process', 'exec(', 'execSync', 'spawn(', 'eval(', 'Function('];
    for (const f of forbidden) {
      if (execLogic.includes(f) || initLogic.includes(f)) {
        return { error: `Forbidden pattern detected: "${f}". Cannot use process execution or eval in custom skills.` };
      }
    }

    const source = `

import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface, MemoryInterface,
} from '../../types.ts';

export class ${className} implements Skill {
  manifest: SkillManifest = {
    name: '${name}',
    version: '1.0.0',
    description: ${JSON.stringify(params.description)},
    tools: ${toolsDef},
  };

  private logger!: LoggerInterface;
  private eventBus!: EventBusInterface;
  private memory!: MemoryInterface;
  private ctx!: SkillContext;

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.memory = ctx.memory;
    this.logger.info('[${className}] Initialized');
    ${initLogic}
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    ${execLogic}
  }

  async shutdown(): Promise<void> {
    this.logger.info('[${className}] Shut down');
  }
}
`;

    fs.writeFileSync(filePath, source, 'utf-8');
    this.logger.info(`[SkillBuilder] Created custom skill: ${name} at ${filePath}`);

    return {
      success: true,
      name,
      className,
      filePath,
      toolCount: tools.length,
      message: `Custom skill "${name}" created with ${tools.length} tool(s). Restart server to load it.`,
    };
  }

  private async listSkills() {
    if (!fs.existsSync(CUSTOM_DIR)) return { skills: [] };
    const files = fs.readdirSync(CUSTOM_DIR).filter(f => f.endsWith('.ts'));
    const skills = files.map(f => {
      const name = f.replace('.ts', '');
      const stat = fs.statSync(path.join(CUSTOM_DIR, f));
      return { name, file: f, size: stat.size, created: stat.birthtime.toISOString() };
    });
    return { skills, directory: CUSTOM_DIR };
  }

  private async readSkill(skillName: string) {
    const name = this.sanitizeName(skillName);
    const filePath = path.join(CUSTOM_DIR, `${name}.ts`);
    if (!fs.existsSync(filePath)) return { error: `Custom skill "${name}" not found` };
    const source = fs.readFileSync(filePath, 'utf-8');
    return { name, source };
  }

  private async deleteSkill(skillName: string) {
    const name = this.sanitizeName(skillName);
    const filePath = path.join(CUSTOM_DIR, `${name}.ts`);
    if (!fs.existsSync(filePath)) return { error: `Custom skill "${name}" not found` };
    fs.unlinkSync(filePath);
    this.logger.info(`[SkillBuilder] Deleted custom skill: ${name}`);
    return { success: true, message: `Custom skill "${name}" deleted.` };
  }
}
