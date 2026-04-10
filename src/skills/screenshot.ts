import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface,
} from '../types.ts';

export class ScreenshotSkill implements Skill {
  manifest: SkillManifest = {
    name: 'screenshot',
    version: '1.0.0',
    description: 'Take screenshots of web pages, Axiom, GMGN, or any open browser tab and send them to chat',
    tools: [
      {
        name: 'take_screenshot',
        description: 'Take a screenshot of a URL or currently open browser tab and display it in chat. Can screenshot any web page, Axiom token page, GMGN, etc. If no URL given, screenshots the active tab.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to screenshot (e.g. https://axiom.trade/meme/... or https://gmgn.ai/...). Leave empty to screenshot the current active tab.',
            },
            fullPage: {
              type: 'boolean',
              description: 'Capture full page scroll (default: false — viewport only)',
            },
            caption: {
              type: 'string',
              description: 'Optional caption to display with the screenshot in chat',
            },
          },
          required: [],
        },
        riskLevel: 'read',
      },
    ],
  };

  private browser: any;
  private eventBus: any;
  private logger!: LoggerInterface;

  async initialize(ctx: SkillContext): Promise<void> {
    this.browser = ctx.browser;
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    if (tool === 'take_screenshot') {
      return this.takeScreenshot(params);
    }
    return `Unknown tool: ${tool}`;
  }

  async shutdown(): Promise<void> {}

  private async takeScreenshot(params: Record<string, any>): Promise<string> {
    const { url, fullPage = false, caption } = params;

    try {
      let page: any;
      let createdPage = false;

      if (url) {

        const mb = this.browser?.mainBrowser;
        if (!mb?.connected) return 'Chrome not connected. Connect via Settings → Browser first.';
        page = await mb.newPage();
        createdPage = true;

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
      } else {

        if (!this.browser) return 'Browser not connected. Connect Chrome first.';
        const mb = this.browser.mainBrowser;
        if (!mb?.connected) return 'Main browser not connected. Connect Chrome first.';
        const pages = await mb.pages();
        if (!pages.length) return 'No open tabs found in browser.';
        page = pages[pages.length - 1];
      }

      let pageTitle = '';
      try { pageTitle = await page.title(); } catch {}

      const screenshotB64 = await page.screenshot({
        encoding: 'base64',
        fullPage: !!fullPage,
        type: 'png',
      });


      this.eventBus.emit('agent:image', {
        image: screenshotB64,
        caption: caption || (url ? `Screenshot: ${url}` : 'Screenshot of current tab'),
      });


      if (createdPage && page) {
        await page.close().catch(() => {});
      }

      return `Screenshot taken${url ? ` of ${url}` : ' of current tab'}${pageTitle ? ` (${pageTitle})` : ''}. Image sent to chat.`;
    } catch (err: any) {
      this.logger.error(`Screenshot failed: ${err.message}`);
      return `Screenshot failed: ${err.message}`;
    }
  }
}
