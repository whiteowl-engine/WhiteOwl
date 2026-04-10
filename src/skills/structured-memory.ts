
import * as fs from 'fs';
import * as path from 'path';
import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, MemoryInterface,
} from '../types.ts';

const MEMORY_DIR = path.join(process.cwd(), 'data', 'memory');
const INDEX_PATH = path.join(MEMORY_DIR, 'MEMORY.md');
const TOPICS_DIR = path.join(MEMORY_DIR, 'topics');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

function ensureDirs(): void {
  for (const dir of [MEMORY_DIR, TOPICS_DIR, SESSIONS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function toFileName(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export class StructuredMemorySkill implements Skill {
  manifest: SkillManifest = {
    name: 'structured-memory',
    version: '1.0.0',
    description: 'Claude Code-style 3-layer memory: MEMORY.md index (always loaded), topic files (on-demand), session transcripts (grep-only). Use memory_write_topic to save detailed notes, memory_read_topic to load them, memory_search to grep across all layers.',
    tools: [

      {
        name: 'memory_read_index',
        description: 'Read the MEMORY.md index file. This is already in your system prompt, but call this to get the latest version after updates.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'memory_update_index',
        description: 'Add or update a line in MEMORY.md index under a section. Each line should be ≤150 chars and point to a topic file. ALWAYS write the topic file FIRST, then update the index.',
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Section header in MEMORY.md (e.g., "Trading Patterns", "Dev Wallets", "Market Insights", "User Preferences", "Session History")',
            },
            entry: {
              type: 'string',
              description: 'Index line ≤150 chars. Format: [topic-filename] one-line summary. Example: [serial-ruggers] 14 known serial rug devs, top: 7x2f..., 9kLm...',
            },
            oldEntry: {
              type: 'string',
              description: 'If updating an existing entry, provide the old line to replace. Omit for new entries.',
            },
          },
          required: ['section', 'entry'],
        },
        riskLevel: 'write',
      },

      {
        name: 'memory_read_topic',
        description: 'Read a topic file from data/memory/topics/. Use when MEMORY.md index suggests a relevant topic.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic filename (without .md extension). Example: "serial-ruggers", "profitable-hours", "user-risk-prefs"',
            },
          },
          required: ['topic'],
        },
        riskLevel: 'read',
      },
      {
        name: 'memory_write_topic',
        description: 'Write or append to a topic file in data/memory/topics/. Write here FIRST, then update MEMORY.md index. Each fact should have a timestamp.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic filename (without .md extension)',
            },
            content: {
              type: 'string',
              description: 'Content to write. Include timestamps for each fact. Use markdown format.',
            },
            mode: {
              type: 'string',
              enum: ['overwrite', 'append'],
              description: 'overwrite = replace entire file, append = add to end. Default: append',
            },
          },
          required: ['topic', 'content'],
        },
        riskLevel: 'write',
      },
      {
        name: 'memory_list_topics',
        description: 'List all available topic files in memory.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'memory_delete_topic',
        description: 'Delete a topic file and optionally its index entry.',
        parameters: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'Topic filename to delete (without .md)',
            },
            removeFromIndex: {
              type: 'boolean',
              description: 'Also remove matching index entries (default: true)',
            },
          },
          required: ['topic'],
        },
        riskLevel: 'write',
      },

      {
        name: 'memory_search_sessions',
        description: 'Grep across session transcript JSONL files. Returns matching lines with context. Use for finding past conversations about specific topics.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search string (case-insensitive substring match)',
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 20)',
            },
            sessionId: {
              type: 'string',
              description: 'Optional: search only a specific session file',
            },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'memory_list_sessions',
        description: 'List session transcript files with dates and sizes.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'memory_dream',
        description: 'Run autoDream consolidation: (1) Orient — read MEMORY.md + recent sessions, (2) Gather signal — extract key facts from transcripts, (3) Consolidate — merge/dedupe/update topic files, (4) Prune & index — remove stale entries, update MEMORY.md. Call this periodically or when idle.',
        parameters: {
          type: 'object',
          properties: {
            dryRun: {
              type: 'boolean',
              description: 'If true, only report what would change without writing. Default: false',
            },
          },
        },
        riskLevel: 'write',
      },
    ],
  };

  private logger!: LoggerInterface;
  private memory!: MemoryInterface;

  async initialize(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.memory = ctx.memory;
    ensureDirs();

    if (!fs.existsSync(INDEX_PATH)) {
      fs.writeFileSync(INDEX_PATH, [
        '# MEMORY INDEX',
        '<!-- Auto-maintained by autoDream. Each line ≤150 chars. Format: [topic-file] one-line summary -->',
        '<!-- This file is ALWAYS loaded into system prompt. Keep it lean. -->',
        '<!-- Write to topic file FIRST, then update this index. -->',
        '',
        '## Trading Patterns',
        '',
        '## Dev Wallets',
        '',
        '## Market Insights',
        '',
        '## User Preferences',
        '',
        '## Session History',
        '',
      ].join('\n'), 'utf-8');
    }
    this.logger.info('[StructuredMemory] Skill initialized');
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    ensureDirs();
    switch (tool) {
      case 'memory_read_index':
        return this.readIndex();
      case 'memory_update_index':
        return this.updateIndex(params.section, params.entry, params.oldEntry);
      case 'memory_read_topic':
        return this.readTopic(params.topic);
      case 'memory_write_topic':
        return this.writeTopic(params.topic, params.content, params.mode || 'append');
      case 'memory_list_topics':
        return this.listTopics();
      case 'memory_delete_topic':
        return this.deleteTopic(params.topic, params.removeFromIndex !== false);
      case 'memory_search_sessions':
        return this.searchSessions(params.query, params.limit || 20, params.sessionId);
      case 'memory_list_sessions':
        return this.listSessions();
      case 'memory_dream':
        return this.autoDream(params.dryRun || false);
      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }


  private readIndex(): { content: string; sizeChars: number } {
    const content = fs.existsSync(INDEX_PATH)
      ? fs.readFileSync(INDEX_PATH, 'utf-8')
      : '(empty — no MEMORY.md found)';
    return { content, sizeChars: content.length };
  }

  private updateIndex(section: string, entry: string, oldEntry?: string): { success: boolean; message: string } {
    if (entry.length > 160) {
      return { success: false, message: `Entry too long (${entry.length} chars). Keep ≤150.` };
    }
    let content = fs.existsSync(INDEX_PATH)
      ? fs.readFileSync(INDEX_PATH, 'utf-8')
      : '';


    if (oldEntry && content.includes(oldEntry)) {
      content = content.replace(oldEntry, entry);
      fs.writeFileSync(INDEX_PATH, content, 'utf-8');
      this.logger.info(`[StructuredMemory] Index entry updated in [${section}]`);
      return { success: true, message: `Replaced entry in ${section}` };
    }


    const sectionHeader = `## ${section}`;
    const idx = content.indexOf(sectionHeader);
    if (idx === -1) {

      content += `\n## ${section}\n${entry}\n`;
    } else {

      const afterHeader = content.indexOf('\n', idx);
      if (afterHeader === -1) {
        content += `\n${entry}\n`;
      } else {
        content = content.slice(0, afterHeader + 1) + entry + '\n' + content.slice(afterHeader + 1);
      }
    }

    fs.writeFileSync(INDEX_PATH, content, 'utf-8');
    this.logger.info(`[StructuredMemory] Index entry added to [${section}]`);
    return { success: true, message: `Added entry to ${section}` };
  }


  private readTopic(topic: string): { content: string; path: string; sizeChars: number } | { error: string } {
    const safeName = toFileName(topic);
    const filePath = path.join(TOPICS_DIR, `${safeName}.md`);
    if (!fs.existsSync(filePath)) {
      return { error: `Topic file not found: ${safeName}.md` };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { content, path: `data/memory/topics/${safeName}.md`, sizeChars: content.length };
  }

  private writeTopic(topic: string, content: string, mode: string): { success: boolean; path: string; sizeChars: number } {
    const safeName = toFileName(topic);
    const filePath = path.join(TOPICS_DIR, `${safeName}.md`);
    const timestamp = new Date().toISOString().slice(0, 16);

    if (mode === 'overwrite') {
      fs.writeFileSync(filePath, content, 'utf-8');
    } else {

      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      const separator = existing.length > 0 ? `\n\n---\n_${timestamp}_\n` : `_${timestamp}_\n`;
      fs.writeFileSync(filePath, existing + separator + content, 'utf-8');
    }

    const finalSize = fs.statSync(filePath).size;
    this.logger.info(`[StructuredMemory] Topic written: ${safeName}.md (${mode}, ${finalSize} bytes)`);
    return { success: true, path: `data/memory/topics/${safeName}.md`, sizeChars: finalSize };
  }

  private listTopics(): { topics: Array<{ name: string; sizeBytes: number; modified: string }> } {
    if (!fs.existsSync(TOPICS_DIR)) return { topics: [] };
    const files = fs.readdirSync(TOPICS_DIR).filter(f => f.endsWith('.md'));
    const topics = files.map(f => {
      const stat = fs.statSync(path.join(TOPICS_DIR, f));
      return {
        name: f.replace('.md', ''),
        sizeBytes: stat.size,
        modified: new Date(stat.mtimeMs).toISOString().slice(0, 16),
      };
    });
    return { topics };
  }

  private deleteTopic(topic: string, removeFromIndex: boolean): { success: boolean; message: string } {
    const safeName = toFileName(topic);
    const filePath = path.join(TOPICS_DIR, `${safeName}.md`);

    if (!fs.existsSync(filePath)) {
      return { success: false, message: `Topic not found: ${safeName}.md` };
    }

    fs.unlinkSync(filePath);

    if (removeFromIndex && fs.existsSync(INDEX_PATH)) {
      let content = fs.readFileSync(INDEX_PATH, 'utf-8');

      const lines = content.split('\n');
      const filtered = lines.filter(l => !l.includes(`[${safeName}]`));
      if (filtered.length !== lines.length) {
        fs.writeFileSync(INDEX_PATH, filtered.join('\n'), 'utf-8');
      }
    }

    this.logger.info(`[StructuredMemory] Topic deleted: ${safeName}.md`);
    return { success: true, message: `Deleted ${safeName}.md` + (removeFromIndex ? ' and cleaned index' : '') };
  }


logToSession(sessionId: string, role: string, content: string, meta?: Record<string, any>): void {
    ensureDirs();
    const date = new Date().toISOString().slice(0, 10);
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const filePath = path.join(SESSIONS_DIR, `${date}_${safeSid}.jsonl`);
    const entry = {
      ts: Date.now(),
      role,
      content: content.slice(0, 4000),
      ...(meta ? { meta } : {}),
    };
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  private searchSessions(query: string, limit: number, sessionId?: string): {
    results: Array<{ file: string; line: number; entry: any }>;
    count: number;
    truncated: boolean;
  } {
    const results: Array<{ file: string; line: number; entry: any }> = [];
    const queryLower = query.toLowerCase();
    const files = this.getSessionFiles(sessionId);

    for (const filePath of files) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        const fileName = path.basename(filePath);
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            try {
              const entry = JSON.parse(lines[i]);
              results.push({ file: fileName, line: i + 1, entry });
            } catch {
              results.push({ file: fileName, line: i + 1, entry: { raw: lines[i].slice(0, 300) } });
            }
          }
        }
      } catch {  }
      if (results.length >= limit) break;
    }

    return { results, count: results.length, truncated: results.length >= limit };
  }

  private getSessionFiles(sessionId?: string): string[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    let files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    if (sessionId) {
      const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
      files = files.filter(f => f.includes(safeSid));
    }

    return files.map(f => path.join(SESSIONS_DIR, f));
  }

  private listSessions(): { sessions: Array<{ file: string; sizeBytes: number; lines: number; date: string }> } {
    if (!fs.existsSync(SESSIONS_DIR)) return { sessions: [] };
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();
    const sessions = files.slice(0, 50).map(f => {
      const filePath = path.join(SESSIONS_DIR, f);
      const stat = fs.statSync(filePath);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).length;
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      return {
        file: f,
        sizeBytes: stat.size,
        lines,
        date: dateMatch ? dateMatch[1] : 'unknown',
      };
    });
    return { sessions };
  }


  private autoDream(dryRun: boolean): {
    actions: string[];
    topicsUpdated: string[];
    entriesPruned: number;
    indexUpdated: boolean;
  } {
    const actions: string[] = [];
    const topicsUpdated: string[] = [];
    let entriesPruned = 0;
    let indexUpdated = false;


    const index = this.readIndex();
    actions.push(`Phase 1 (Orient): Index has ${index.sizeChars} chars`);


    const recentFiles = this.getSessionFiles().slice(0, 5);
    const signals: Array<{ type: string; value: string; source: string }> = [];

    for (const filePath of recentFiles) {
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        const fileName = path.basename(filePath);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const text = (entry.content || '').toLowerCase();

            if (text.includes('rug') || text.includes('scam')) {
              const addresses = (entry.content || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
              if (addresses) {
                signals.push({ type: 'rug_address', value: addresses[0], source: fileName });
              }
            }

            if (text.includes('always') || text.includes('never') || text.includes('prefer')) {
              signals.push({ type: 'preference', value: (entry.content || '').slice(0, 200), source: fileName });
            }

            if (text.includes('lesson') || text.includes('mistake') || text.includes('learned')) {
              signals.push({ type: 'lesson', value: (entry.content || '').slice(0, 200), source: fileName });
            }
          } catch {  }
        }
      } catch {  }
    }
    actions.push(`Phase 2 (Gather): Found ${signals.length} signals from ${recentFiles.length} session files`);


    if (!dryRun && signals.length > 0) {

      const grouped: Record<string, typeof signals> = {};
      for (const sig of signals) {
        (grouped[sig.type] ||= []).push(sig);
      }

      const timestamp = new Date().toISOString().slice(0, 16);

      for (const [type, sigs] of Object.entries(grouped)) {
        const topicName = `dream-${type}`;
        const safeName = toFileName(topicName);
        const filePath = path.join(TOPICS_DIR, `${safeName}.md`);


        const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        const newEntries = sigs
          .filter(s => !existing.includes(s.value.slice(0, 50)))
          .map(s => `- ${s.value} _(from ${s.source})_`);

        if (newEntries.length > 0) {
          const append = `\n### autoDream ${timestamp}\n${newEntries.join('\n')}\n`;
          fs.appendFileSync(filePath, append, 'utf-8');
          topicsUpdated.push(safeName);
          actions.push(`Phase 3: Added ${newEntries.length} entries to ${safeName}.md`);
        }
      }
    } else if (dryRun && signals.length > 0) {
      actions.push(`Phase 3 (DryRun): Would consolidate ${signals.length} signals`);
    }


    if (!dryRun) {

      const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
      if (fs.existsSync(TOPICS_DIR)) {
        for (const f of fs.readdirSync(TOPICS_DIR).filter(f => f.endsWith('.md'))) {
          const filePath = path.join(TOPICS_DIR, f);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < thirtyDaysAgo && stat.size < 100) {
            fs.unlinkSync(filePath);
            entriesPruned++;
            actions.push(`Phase 4: Pruned stale empty file ${f}`);
          }
        }
      }


      const fourteenDaysAgo = Date.now() - 14 * 86_400_000;
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'))) {
          const filePath = path.join(SESSIONS_DIR, f);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < fourteenDaysAgo) {
            fs.unlinkSync(filePath);
            entriesPruned++;
            actions.push(`Phase 4: Pruned old session ${f}`);
          }
        }
      }


      if (topicsUpdated.length > 0) {
        let indexContent = fs.readFileSync(INDEX_PATH, 'utf-8');
        for (const topicName of topicsUpdated) {
          const filePath = path.join(TOPICS_DIR, `${topicName}.md`);
          if (!fs.existsSync(filePath)) continue;

          const stat = fs.statSync(filePath);
          const lineCount = fs.readFileSync(filePath, 'utf-8').split('\n').length;
          const indexEntry = `[${topicName}] ${lineCount} entries, updated ${new Date(stat.mtimeMs).toISOString().slice(0, 10)}`;


          if (indexContent.includes(`[${topicName}]`)) {

            const regex = new RegExp(`\\[${topicName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\n]*`);
            indexContent = indexContent.replace(regex, indexEntry);
          } else {

            const section = '## Session History';
            const idx = indexContent.indexOf(section);
            if (idx !== -1) {
              const afterHeader = indexContent.indexOf('\n', idx);
              indexContent = indexContent.slice(0, afterHeader + 1) + indexEntry + '\n' + indexContent.slice(afterHeader + 1);
            }
          }
        }
        fs.writeFileSync(INDEX_PATH, indexContent, 'utf-8');
        indexUpdated = true;
        actions.push(`Phase 4: Updated MEMORY.md index with ${topicsUpdated.length} topic refs`);
      }
    }

    return { actions, topicsUpdated, entriesPruned, indexUpdated };
  }


getIndexContent(): string {
    ensureDirs();
    if (!fs.existsSync(INDEX_PATH)) return '';
    return fs.readFileSync(INDEX_PATH, 'utf-8');
  }

getIndexSize(): number {
    if (!fs.existsSync(INDEX_PATH)) return 0;
    return fs.statSync(INDEX_PATH).size;
  }

  async shutdown(): Promise<void> {}
}
