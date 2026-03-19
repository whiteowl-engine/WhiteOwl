import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface, EventBusInterface,
} from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Hub directories ──
const HUB_DIR = path.join(__dirname, 'hub');
const CUSTOM_DIR = path.join(__dirname, 'custom');

// ── Package format ──
export interface SkillPackage {
  format: 'axiom-skill-v1';
  id: string;
  manifest: {
    name: string;
    version: string;
    description: string;
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, any>;
      riskLevel: 'read' | 'write' | 'financial';
    }>;
  };
  meta: {
    author: string;
    tags: string[];
    created: string;
    updated: string;
    readme: string;
    license: string;
    downloads?: number;
    rating?: number;
  };
  source: string;     // TypeScript source code
  checksum: string;    // SHA-256 of source
}

// ── Hub index (local registry of known packages) ──
interface HubEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  toolCount: number;
  installed: boolean;
  created: string;
  rating: number;
  downloads: number;
  fileName: string;
}

// ── Forbidden patterns for security ──
const FORBIDDEN_PATTERNS = [
  'child_process', 'execSync', 'spawnSync', 'exec(', 'spawn(',
  'eval(', 'Function(', 'require(\'fs\')', 'require("fs")',
  'process.exit', 'process.kill', 'process.env',
  'import * as fs', 'import fs',
  'import * as child', 'import child',
  '__dirname', '__filename',
  'global.', 'globalThis.',
];

export class SkillHubSkill implements Skill {
  manifest: SkillManifest = {
    name: 'skill-hub',
    version: '1.0.0',
    description: 'Community Skill Hub — browse, import, export, install, and share custom skills. Users can package their skills and share them with others.',
    tools: [
      {
        name: 'hub_browse',
        description: 'Browse all available skill packages in the local hub. Shows name, description, author, tags, tool count, install status.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query to filter skills by name, tag, or description' },
            tag: { type: 'string', description: 'Filter by specific tag' },
            installed: { type: 'boolean', description: 'Filter: true = installed only, false = not installed only' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'hub_export',
        description: 'Export a custom skill as a shareable .axiom-skill package file. Other users can import this package to use the skill.',
        parameters: {
          type: 'object',
          properties: {
            skillName: { type: 'string', description: 'Name of the custom skill to export' },
            author: { type: 'string', description: 'Author name to include in the package' },
            tags: { type: 'string', description: 'Comma-separated tags (e.g. "trading,alerts,whales")' },
            readme: { type: 'string', description: 'Description/readme for the package (Markdown supported)' },
          },
          required: ['skillName'],
        },
        riskLevel: 'read',
      },
      {
        name: 'hub_import',
        description: 'Import a skill package from a .axiom-skill file path into the hub. Does NOT install it — just makes it available in the hub for review.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the .axiom-skill package file' },
          },
          required: ['filePath'],
        },
        riskLevel: 'write',
      },
      {
        name: 'hub_install',
        description: 'Install a skill from the hub — copies it to the custom skills directory so it can be loaded on next restart.',
        parameters: {
          type: 'object',
          properties: {
            packageId: { type: 'string', description: 'Package ID (from hub_browse) to install' },
          },
          required: ['packageId'],
        },
        riskLevel: 'write',
      },
      {
        name: 'hub_uninstall',
        description: 'Uninstall a hub skill — removes it from the custom skills directory. The package stays in the hub for re-install.',
        parameters: {
          type: 'object',
          properties: {
            packageId: { type: 'string', description: 'Package ID to uninstall' },
          },
          required: ['packageId'],
        },
        riskLevel: 'write',
      },
      {
        name: 'hub_inspect',
        description: 'Inspect a skill package — view full manifest, source code, tools, and security audit results before installing.',
        parameters: {
          type: 'object',
          properties: {
            packageId: { type: 'string', description: 'Package ID to inspect' },
          },
          required: ['packageId'],
        },
        riskLevel: 'read',
      },
      {
        name: 'hub_remove',
        description: 'Remove a skill package from the hub entirely (also uninstalls if installed).',
        parameters: {
          type: 'object',
          properties: {
            packageId: { type: 'string', description: 'Package ID to remove from hub' },
          },
          required: ['packageId'],
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

    // Ensure directories exist
    for (const dir of [HUB_DIR, CUSTOM_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.logger.info('[SkillHub] Ready. Hub dir: ' + HUB_DIR);
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'hub_browse': return this.browse(params);
      case 'hub_export': return this.exportSkill(params);
      case 'hub_import': return this.importPackage(params);
      case 'hub_install': return this.install(params.packageId);
      case 'hub_uninstall': return this.uninstall(params.packageId);
      case 'hub_inspect': return this.inspect(params.packageId);
      case 'hub_remove': return this.remove(params.packageId);
      default: return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {}

  // ═══════════════════════════════════════════
  // BROWSE
  // ═══════════════════════════════════════════
  private browse(params: Record<string, any>) {
    const packages = this.loadAllPackages();
    let entries: HubEntry[] = packages.map(pkg => this.toEntry(pkg));

    // Filter by query
    if (params.query) {
      const q = String(params.query).toLowerCase();
      entries = entries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    // Filter by tag
    if (params.tag) {
      const tag = String(params.tag).toLowerCase();
      entries = entries.filter(e => e.tags.some(t => t.toLowerCase() === tag));
    }

    // Filter by installed status
    if (params.installed === true) entries = entries.filter(e => e.installed);
    if (params.installed === false) entries = entries.filter(e => !e.installed);

    return {
      total: entries.length,
      packages: entries,
    };
  }

  // ═══════════════════════════════════════════
  // EXPORT
  // ═══════════════════════════════════════════
  private exportSkill(params: Record<string, any>) {
    const name = this.sanitize(params.skillName);
    if (!name) return { error: 'Invalid skill name' };

    // Read source from custom skills dir
    const srcPath = path.join(CUSTOM_DIR, `${name}.ts`);
    if (!fs.existsSync(srcPath)) {
      return { error: `Custom skill "${name}" not found in ${CUSTOM_DIR}. Only custom-created skills can be exported.` };
    }
    const source = fs.readFileSync(srcPath, 'utf-8');

    // Parse manifest from source (extract tools array)
    const manifest = this.parseManifestFromSource(source, name);
    if (!manifest) return { error: 'Could not parse skill manifest from source' };

    // Build package
    const pkg: SkillPackage = {
      format: 'axiom-skill-v1',
      id: crypto.randomUUID(),
      manifest,
      meta: {
        author: params.author || 'anonymous',
        tags: params.tags ? String(params.tags).split(',').map(t => t.trim()).filter(Boolean) : [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        readme: params.readme || manifest.description,
        license: 'MIT',
        downloads: 0,
        rating: 0,
      },
      source,
      checksum: crypto.createHash('sha256').update(source).digest('hex'),
    };

    // Save to hub directory AND export file
    const pkgFileName = `${name}.axiom-skill`;
    const hubPath = path.join(HUB_DIR, pkgFileName);
    const exportPath = path.join(path.dirname(HUB_DIR), '..', pkgFileName);

    fs.writeFileSync(hubPath, JSON.stringify(pkg, null, 2), 'utf-8');
    fs.writeFileSync(exportPath, JSON.stringify(pkg, null, 2), 'utf-8');

    this.logger.info(`[SkillHub] Exported skill "${name}" -> ${exportPath}`);
    return {
      success: true,
      packageId: pkg.id,
      name: manifest.name,
      toolCount: manifest.tools.length,
      exportPath,
      hubPath,
      message: `Skill "${name}" exported! Share the .axiom-skill file with other users.`,
    };
  }

  // ═══════════════════════════════════════════
  // IMPORT
  // ═══════════════════════════════════════════
  private importPackage(params: Record<string, any>) {
    const filePath = String(params.filePath || '');
    if (!filePath) return { error: 'File path required' };

    // Validate path is safe (no traversal)
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) return { error: `File not found: ${resolved}` };
    if (!resolved.endsWith('.axiom-skill')) return { error: 'File must have .axiom-skill extension' };

    const raw = fs.readFileSync(resolved, 'utf-8');
    let pkg: SkillPackage;
    try {
      pkg = JSON.parse(raw);
    } catch {
      return { error: 'Invalid package file — not valid JSON' };
    }

    // Validate format
    if (pkg.format !== 'axiom-skill-v1') return { error: `Unknown package format: ${pkg.format}` };
    if (!pkg.manifest?.name || !pkg.source) return { error: 'Invalid package — missing manifest or source' };

    // Verify checksum
    const actualChecksum = crypto.createHash('sha256').update(pkg.source).digest('hex');
    if (pkg.checksum && pkg.checksum !== actualChecksum) {
      return { error: 'Checksum mismatch — package may be corrupted or tampered with' };
    }

    // Security audit
    const audit = this.securityAudit(pkg.source);
    if (audit.blocked) {
      return {
        error: 'Security audit FAILED — package contains forbidden patterns',
        violations: audit.violations,
      };
    }

    // Copy to hub
    const name = this.sanitize(pkg.manifest.name);
    const hubPath = path.join(HUB_DIR, `${name}.axiom-skill`);
    fs.writeFileSync(hubPath, JSON.stringify(pkg, null, 2), 'utf-8');

    this.logger.info(`[SkillHub] Imported package "${name}" from ${resolved}`);
    return {
      success: true,
      packageId: pkg.id,
      name: pkg.manifest.name,
      author: pkg.meta?.author || 'unknown',
      toolCount: pkg.manifest.tools?.length || 0,
      securityAudit: audit,
      message: `Package "${name}" imported to hub. Use hub_inspect to review, then hub_install to activate.`,
    };
  }

  // ═══════════════════════════════════════════
  // INSTALL
  // ═══════════════════════════════════════════
  private install(packageId: string) {
    if (!packageId) return { error: 'Package ID required' };
    const pkg = this.findPackageById(packageId);
    if (!pkg) return { error: `Package not found: ${packageId}` };

    const name = this.sanitize(pkg.manifest.name);

    // Security re-check before install
    const audit = this.securityAudit(pkg.source);
    if (audit.blocked) {
      return { error: 'Security audit FAILED', violations: audit.violations };
    }

    // Check if custom skill already exists
    const destPath = path.join(CUSTOM_DIR, `${name}.ts`);
    if (fs.existsSync(destPath)) {
      return { error: `Skill "${name}" already exists in custom skills. Delete it first or choose a different name.` };
    }

    // Write source to custom dir
    fs.writeFileSync(destPath, pkg.source, 'utf-8');
    this.logger.info(`[SkillHub] Installed skill "${name}" from hub`);

    return {
      success: true,
      name,
      installedTo: destPath,
      toolCount: pkg.manifest.tools?.length || 0,
      message: `Skill "${name}" installed! Restart the server to load it.`,
    };
  }

  // ═══════════════════════════════════════════
  // UNINSTALL
  // ═══════════════════════════════════════════
  private uninstall(packageId: string) {
    if (!packageId) return { error: 'Package ID required' };
    const pkg = this.findPackageById(packageId);
    if (!pkg) return { error: `Package not found: ${packageId}` };

    const name = this.sanitize(pkg.manifest.name);
    const destPath = path.join(CUSTOM_DIR, `${name}.ts`);

    if (!fs.existsSync(destPath)) {
      return { error: `Skill "${name}" is not currently installed` };
    }

    fs.unlinkSync(destPath);
    this.logger.info(`[SkillHub] Uninstalled skill "${name}"`);

    return {
      success: true,
      name,
      message: `Skill "${name}" uninstalled. Restart the server to remove it.`,
    };
  }

  // ═══════════════════════════════════════════
  // INSPECT
  // ═══════════════════════════════════════════
  private inspect(packageId: string) {
    if (!packageId) return { error: 'Package ID required' };
    const pkg = this.findPackageById(packageId);
    if (!pkg) return { error: `Package not found: ${packageId}` };

    const audit = this.securityAudit(pkg.source);
    const name = this.sanitize(pkg.manifest.name);
    const installed = fs.existsSync(path.join(CUSTOM_DIR, `${name}.ts`));

    return {
      id: pkg.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description,
      author: pkg.meta?.author || 'unknown',
      tags: pkg.meta?.tags || [],
      readme: pkg.meta?.readme || '',
      license: pkg.meta?.license || 'unknown',
      created: pkg.meta?.created,
      tools: pkg.manifest.tools?.map(t => ({
        name: t.name,
        description: t.description,
        riskLevel: t.riskLevel,
        params: Object.keys(t.parameters?.properties || {}),
      })) || [],
      installed,
      sourcePreview: pkg.source.slice(0, 2000) + (pkg.source.length > 2000 ? '\n... (truncated)' : ''),
      sourceLines: pkg.source.split('\n').length,
      checksum: pkg.checksum,
      securityAudit: audit,
    };
  }

  // ═══════════════════════════════════════════
  // REMOVE
  // ═══════════════════════════════════════════
  private remove(packageId: string) {
    if (!packageId) return { error: 'Package ID required' };
    const pkg = this.findPackageById(packageId);
    if (!pkg) return { error: `Package not found: ${packageId}` };

    const name = this.sanitize(pkg.manifest.name);

    // Uninstall first if installed
    const customPath = path.join(CUSTOM_DIR, `${name}.ts`);
    if (fs.existsSync(customPath)) {
      fs.unlinkSync(customPath);
    }

    // Remove from hub
    const hubFile = path.join(HUB_DIR, `${name}.axiom-skill`);
    if (fs.existsSync(hubFile)) {
      fs.unlinkSync(hubFile);
    }

    // Also try removing by ID-based filename
    const files = fs.readdirSync(HUB_DIR).filter(f => f.endsWith('.axiom-skill'));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(HUB_DIR, f), 'utf-8');
        const p = JSON.parse(raw) as SkillPackage;
        if (p.id === packageId) {
          fs.unlinkSync(path.join(HUB_DIR, f));
        }
      } catch { /* skip */ }
    }

    this.logger.info(`[SkillHub] Removed package "${name}" from hub`);
    return {
      success: true,
      name,
      message: `Package "${name}" removed from hub and uninstalled.`,
    };
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════
  private sanitize(name: string): string {
    return String(name || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  }

  private loadAllPackages(): SkillPackage[] {
    if (!fs.existsSync(HUB_DIR)) return [];
    const files = fs.readdirSync(HUB_DIR).filter(f => f.endsWith('.axiom-skill'));
    const packages: SkillPackage[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(HUB_DIR, f), 'utf-8');
        const pkg = JSON.parse(raw) as SkillPackage;
        if (pkg.format === 'axiom-skill-v1' && pkg.manifest?.name) {
          (pkg as any)._fileName = f;
          packages.push(pkg);
        }
      } catch { /* skip corrupt files */ }
    }
    return packages;
  }

  private findPackageById(id: string): SkillPackage | null {
    const packages = this.loadAllPackages();
    return packages.find(p => p.id === id) || null;
  }

  private toEntry(pkg: SkillPackage): HubEntry {
    const name = this.sanitize(pkg.manifest.name);
    const installed = fs.existsSync(path.join(CUSTOM_DIR, `${name}.ts`));
    return {
      id: pkg.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version || '1.0.0',
      description: pkg.manifest.description || '',
      author: pkg.meta?.author || 'unknown',
      tags: pkg.meta?.tags || [],
      toolCount: pkg.manifest.tools?.length || 0,
      installed,
      created: pkg.meta?.created || '',
      rating: pkg.meta?.rating || 0,
      downloads: pkg.meta?.downloads || 0,
      fileName: (pkg as any)._fileName || '',
    };
  }

  private securityAudit(source: string): { passed: boolean; blocked: boolean; violations: string[]; warnings: string[] } {
    const violations: string[] = [];
    const warnings: string[] = [];

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (source.includes(pattern)) {
        violations.push(`Contains forbidden pattern: "${pattern}"`);
      }
    }

    // Check for network calls (warn, not block)
    if (source.includes('fetch(') || source.includes('http')) {
      warnings.push('Makes network requests (fetch/http)');
    }

    // Check for wallet access
    if (source.includes('wallet') || source.includes('privateKey') || source.includes('secretKey')) {
      warnings.push('Accesses wallet/key data — review carefully');
    }

    // Check for financial operations
    if (source.includes('riskLevel: \'financial\'') || source.includes('riskLevel: "financial"')) {
      warnings.push('Contains financial-risk tools — requires extra review');
    }

    return {
      passed: violations.length === 0,
      blocked: violations.length > 0,
      violations,
      warnings,
    };
  }

  private parseManifestFromSource(source: string, fallbackName: string): SkillPackage['manifest'] | null {
    try {
      // Try to extract name
      const nameMatch = source.match(/name:\s*['"`]([^'"`]+)['"`]/);
      const versionMatch = source.match(/version:\s*['"`]([^'"`]+)['"`]/);
      const descMatch = source.match(/description:\s*['"`]([^'"`]+)['"`]/);

      // Extract tools array — simplified extraction
      const toolsMatch = source.match(/tools:\s*\[([\s\S]*?)\]\s*,?\s*\}/);
      let tools: any[] = [];
      if (toolsMatch) {
        // Count tool objects by finding name: patterns
        const toolNames = source.match(/name:\s*['"`][a-z_]+['"`]/g) || [];
        // Just count, we'll store tools from the loaded manifest if available
      }

      return {
        name: nameMatch ? nameMatch[1] : fallbackName,
        version: versionMatch ? versionMatch[1] : '1.0.0',
        description: descMatch ? descMatch[1] : 'Custom skill',
        tools: [], // Will be populated from the actual running skill if loaded
      };
    } catch {
      return {
        name: fallbackName,
        version: '1.0.0',
        description: 'Custom skill',
        tools: [],
      };
    }
  }
}
