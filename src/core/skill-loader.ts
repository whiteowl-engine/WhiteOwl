import { Skill, SkillManifest, SkillContext, ToolDefinition, LoggerInterface } from '../types';

export class SkillLoader {
  private skills = new Map<string, Skill>();
  private toolIndex = new Map<string, { skill: Skill; tool: ToolDefinition }>();
  private logger: LoggerInterface;

  constructor(logger: LoggerInterface) {
    this.logger = logger;
  }

  register(skill: Skill): void {
    const { name, tools } = skill.manifest;

    if (this.skills.has(name)) {
      this.logger.warn(`Skill "${name}" already registered, replacing`);
    }

    this.skills.set(name, skill);

    for (const tool of tools) {
      const fullName = `${name}.${tool.name}`;
      this.toolIndex.set(fullName, { skill, tool });
      this.toolIndex.set(tool.name, { skill, tool });
    }

    this.logger.info(`Skill registered: ${name} (${tools.length} tools)`);
  }

  async initializeAll(ctx: SkillContext): Promise<void> {
    for (const [name, skill] of this.skills) {
      try {
        await skill.initialize(ctx);
        this.logger.info(`Skill initialized: ${name}`);
      } catch (err) {
        this.logger.error(`Failed to initialize skill "${name}"`, err);
      }
    }
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<any> {
    const entry = this.toolIndex.get(toolName);
    if (!entry) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    return entry.skill.execute(entry.tool.name, params);
  }

  getToolsForSkills(skillNames: string[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (skill) {
        tools.push(...skill.manifest.tools);
      }
    }
    return tools;
  }

  getToolsAsLLMFormat(skillNames: string[]): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, any> };
  }> {
    return this.getToolsForSkills(skillNames).map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  getAllManifests(): SkillManifest[] {
    return Array.from(this.skills.values()).map(s => s.manifest);
  }

  async shutdownAll(): Promise<void> {
    for (const [name, skill] of this.skills) {
      try {
        await skill.shutdown();
      } catch (err) {
        this.logger.error(`Error shutting down skill "${name}"`, err);
      }
    }
    this.skills.clear();
    this.toolIndex.clear();
  }
}
