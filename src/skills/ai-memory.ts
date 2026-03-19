import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, MemoryInterface,
} from '../types';

export class AIMemorySkill implements Skill {
  manifest: SkillManifest = {
    name: 'ai-memory',
    version: '1.0.0',
    description: 'Persistent AI memory: save and recall notes, token analyses, dev profiles, market insights',
    tools: [
      {
        name: 'ai_memory_save',
        description: 'Save a note to persistent AI memory. Use this to remember important findings about tokens, devs, wallets, market conditions, or any insight worth recalling later.',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['token_analysis', 'dev_profile', 'wallet_note', 'market_insight', 'general'],
              description: 'Category of the memory note',
            },
            content: {
              type: 'string',
              description: 'The content/note to remember. Be specific and include key data points.',
            },
            subject: {
              type: 'string',
              description: 'Subject identifier (e.g., token mint address, wallet address, or topic name)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for easier search later (e.g., ["rug", "serial-dev", "safe"])',
            },
          },
          required: ['category', 'content'],
        },
        riskLevel: 'read',
      },
      {
        name: 'ai_memory_search',
        description: 'Search AI memory for past notes by keyword. Searches across content, subject, and tags.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keyword to search for in memories',
            },
            limit: {
              type: 'number',
              description: 'Max results to return (default: 10)',
            },
          },
          required: ['query'],
        },
        riskLevel: 'read',
      },
      {
        name: 'ai_memory_by_category',
        description: 'Get AI memories filtered by category. Optionally filter by subject (e.g., a specific token address).',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['token_analysis', 'dev_profile', 'wallet_note', 'market_insight', 'general'],
              description: 'Category to filter by',
            },
            subject: {
              type: 'string',
              description: 'Optional subject filter (e.g., token mint or wallet address)',
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 20)',
            },
          },
          required: ['category'],
        },
        riskLevel: 'read',
      },
      {
        name: 'ai_memory_recent',
        description: 'Get the most recent AI memory notes across all categories.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max results (default: 15)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'ai_memory_delete',
        description: 'Delete an AI memory note by its ID.',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description: 'Memory note ID to delete',
            },
          },
          required: ['id'],
        },
        riskLevel: 'write',
      },
    ],
  };

  private memory!: MemoryInterface;
  private logger!: LoggerInterface;

  async initialize(ctx: SkillContext): Promise<void> {
    this.memory = ctx.memory;
    this.logger = ctx.logger;
    this.logger.info('[AIMemory] Skill initialized');
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'ai_memory_save': {
        const id = this.memory.saveAIMemory(
          params.category,
          params.content,
          params.subject,
          params.tags,
        );
        this.logger.info(`[AIMemory] Saved note #${id} in category "${params.category}"`);
        return { success: true, id, message: `Memory saved (id: ${id})` };
      }

      case 'ai_memory_search': {
        const results = this.memory.searchAIMemory(params.query, params.limit || 10);
        return { results, count: results.length };
      }

      case 'ai_memory_by_category': {
        const results = this.memory.getAIMemoryByCategory(
          params.category,
          params.subject,
          params.limit || 20,
        );
        return { results, count: results.length };
      }

      case 'ai_memory_recent': {
        const results = this.memory.getRecentAIMemories(params.limit || 15);
        return { results, count: results.length };
      }

      case 'ai_memory_delete': {
        const deleted = this.memory.deleteAIMemory(params.id);
        return { success: deleted, message: deleted ? `Deleted memory #${params.id}` : 'Not found' };
      }

      default:
        return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}
}
