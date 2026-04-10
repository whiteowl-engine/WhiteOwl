import { Skill, SkillManifest, SkillContext, ToolDefinition, LoggerInterface } from '../types.ts';
import * as fs from 'fs';
import * as path from 'path';

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

        description: tool.description.length > 200
          ? tool.description.slice(0, 197) + '...'
          : tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  getAllManifests(): SkillManifest[] {
    return Array.from(this.skills.values()).map(s => s.manifest);
  }

getToolCatalog(skillNames: string[]): string {
    const sections: string[] = [];
    for (const name of skillNames) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      const m = skill.manifest;
      const toolList = m.tools.map(t => t.name).join(', ');
      sections.push(`[${name}] ${(m.description || '').slice(0, 100)}\n  Tools: ${toolList}`);
    }
    return sections.join('\n');
  }

getToolDetails(toolName: string): ToolDefinition | null {
    const entry = this.toolIndex.get(toolName);
    return entry ? entry.tool : null;
  }

getSkillNameForTool(toolName: string): string | null {
    const entry = this.toolIndex.get(toolName);
    return entry ? entry.skill.manifest.name : null;
  }

getSiblingToolNames(toolName: string): string[] {
    const entry = this.toolIndex.get(toolName);
    if (!entry) return [];
    return entry.skill.manifest.tools.map(t => t.name);
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
    if (this.skillWatcher) {
      this.skillWatcher.close();
      this.skillWatcher = null;
    }
  }


private markdownSkills = new Map<string, { name: string; description: string; instructions: string; dir: string }>();
  private skillWatcher: fs.FSWatcher | null = null;

loadMarkdownSkills(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) return 0;
    let loaded = 0;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      try {
        const content = fs.readFileSync(skillMd, 'utf-8');
        const parsed = this.parseSkillMd(content, entry.name);
        if (parsed) {
          this.markdownSkills.set(parsed.name, { ...parsed, dir: path.join(skillsDir, entry.name) });
          loaded++;
          this.logger.info(`SKILL.md loaded: ${parsed.name} — ${parsed.description.slice(0, 80)}`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to load SKILL.md in ${entry.name}: ${err.message}`);
      }
    }

    return loaded;
  }

private parseSkillMd(content: string, fallbackName: string): { name: string; description: string; instructions: string } | null {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!fmMatch) {

      return { name: fallbackName, description: `Custom skill: ${fallbackName}`, instructions: content.trim() };
    }

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();


    const getVal = (key: string): string => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    };

    const name = getVal('name') || fallbackName;
    const description = getVal('description') || `Skill: ${name}`;

    return { name, description, instructions: body };
  }

getMarkdownSkillPrompt(): string {
    if (this.markdownSkills.size === 0) return '';
    const parts: string[] = ['## INSTALLED SKILLS'];
    for (const [name, skill] of this.markdownSkills) {
      const cap = 3000;
      const instructions = skill.instructions.length > cap
        ? skill.instructions.slice(0, cap) + '\n[Truncated]'
        : skill.instructions;
      parts.push(`### ${name}\n${skill.description}\n\n${instructions}`);
    }
    return parts.join('\n\n');
  }

watchSkillsDir(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return;
    try {
      this.skillWatcher = fs.watch(skillsDir, { recursive: true }, (event, filename) => {
        if (filename && filename.endsWith('SKILL.md')) {
          this.logger.info(`SKILL.md change detected: ${filename} — reloading skills`);
          this.markdownSkills.clear();
          this.loadMarkdownSkills(skillsDir);
        }
      });
    } catch {  }
  }

getMarkdownSkillsList(): Array<{ name: string; description: string; dir: string }> {
    return Array.from(this.markdownSkills.values()).map(s => ({
      name: s.name,
      description: s.description,
      dir: s.dir,
    }));
  }
}
