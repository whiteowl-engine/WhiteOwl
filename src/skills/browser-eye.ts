import {
  Skill, SkillManifest, SkillContext,
  LoggerInterface,
} from '../types.ts';

export class BrowserEyeSkill implements Skill {
  manifest: SkillManifest = {
    name: 'browser-eye',
    version: '2.0.0',
    description:
      'Full autonomous browser control — navigate any site, click, hover, type, scroll, ' +
      'take screenshots, execute JS, capture network requests, handle dropdowns/forms/modals. ' +
      'The AI\'s own separate Chrome window — does not interfere with the user\'s browsing.',
    tools: [

      {
        name: 'browser_navigate',
        description:
          'Navigate to a URL. The AI\'s dedicated Chrome window opens this page. ' +
          'Waits for the page to fully load (network idle + render). Auto-solves Cloudflare. ' +
          'After navigating, ALWAYS call browser_screenshot to see what loaded.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to navigate to (include https://)' },
            waitFor: {
              type: 'string',
              description: 'CSS selector to wait for after load (optional)',
            },
            timeout: {
              type: 'number',
              description: 'Max wait in ms (default: 35000)',
            },
          },
          required: ['url'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_back',
        description: 'Go back one step in browser history. Useful after following a link.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'browser_forward',
        description: 'Go forward one step in browser history.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'browser_reload',
        description: 'Reload the current page. Use to refresh data or recover from a stuck state.',
        parameters: {
          type: 'object',
          properties: {
            waitFor: { type: 'string', description: 'CSS selector to wait for after reload (optional)' },
          },
        },
        riskLevel: 'read',
      },

      {
        name: 'browser_screenshot',
        description:
          'Take a screenshot of the current browser window and send it to chat. ' +
          'USE THIS FREQUENTLY — it is your primary "eyes". Take a screenshot: ' +
          '(1) after navigating, (2) after clicking, (3) when unsure what\'s on the page, ' +
          '(4) to verify an action worked, (5) when selectors fail. ' +
          'You can also screenshot a specific element with "selector" param.',
        parameters: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'Capture full scrollable page (default: false)' },
            caption: { type: 'string', description: 'Caption for the screenshot in chat' },
            selector: {
              type: 'string',
              description: 'Screenshot only this element (CSS selector). Useful to zoom in on a chart, table, or widget.',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_read',
        description:
          'Read the visible text content of the current page. ' +
          'Optionally use a CSS selector to read a specific section. ' +
          'Set structured=true to also return headings, links, and table data as structured JSON.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector of the section to read (e.g. "main", "table", ".price"). Default: full page.',
            },
            maxLength: {
              type: 'number',
              description: 'Max characters (default: 8000)',
            },
            structured: {
              type: 'boolean',
              description: 'Also extract headings, links, table rows as JSON (default: false)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_get_html',
        description:
          'Get the raw HTML of a section of the page. ' +
          'Use when browser_read misses something or you need to understand the exact HTML structure ' +
          '(class names, data attributes, nesting) to build a better selector.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector of element to get HTML for. Default: full body (trimmed to 12000 chars).',
            },
            maxLength: {
              type: 'number',
              description: 'Max characters (default: 8000)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_elements',
        description:
          'Discover all interactive elements on the page (buttons, links, inputs, tabs, selects, etc). ' +
          'Returns: tag, text, selector, href, position (x,y,w,h), visibility, aria-label, type, value. ' +
          'Use this when you don\'t know what to click, or when a selector fails.',
        parameters: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Filter by text content (case-insensitive). E.g. "buy", "trade", "confirm".',
            },
            selector: {
              type: 'string',
              description: 'Only search inside this container (CSS selector)',
            },
            includeHidden: {
              type: 'boolean',
              description: 'Include hidden/invisible elements (default: false — only visible elements)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_find_text',
        description:
          'Find any text on the page and return the element containing it with its selector. ' +
          'Use this when you need to locate something but don\'t know the CSS class.',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to search for (case-insensitive substring)',
            },
            exact: {
              type: 'boolean',
              description: 'Match full text only (default: false = substring match)',
            },
          },
          required: ['text'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_url',
        description: 'Get the current URL, page title, and whether it\'s still loading.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },

      {
        name: 'browser_click',
        description:
          'Click an element on the page. Automatically scrolls into view. ' +
          'Try selector first, then text. If both fail, try browser_elements or browser_screenshot to find the element. ' +
          'Use browser_click_xy as last resort for canvas/custom elements.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'CSS selector to click (e.g. "button.submit", "[data-tab=\'holders\']", "a[href*=trade]")',
            },
            text: {
              type: 'string',
              description: 'Click element by its visible text (e.g. "Buy", "Confirm", "Next"). Prefers buttons/links.',
            },
            waitAfter: {
              type: 'number',
              description: 'Ms to wait after click for page update (default: 1500)',
            },
            force: {
              type: 'boolean',
              description: 'Force click even if element is not directly clickable (default: false)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_click_xy',
        description:
          'Click at exact (x, y) pixel coordinates on the page. ' +
          'Use as fallback when CSS selectors fail — e.g. for canvas elements, custom UIs. ' +
          'Get coordinates from browser_elements (position field) or by looking at a screenshot.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate (pixels from left of viewport)' },
            y: { type: 'number', description: 'Y coordinate (pixels from top of viewport)' },
            waitAfter: { type: 'number', description: 'Ms to wait after click (default: 1500)' },
          },
          required: ['x', 'y'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_hover',
        description:
          'Hover over an element to trigger hover effects — dropdowns, tooltips, menus. ' +
          'After hovering, use browser_screenshot to see what appeared, then click.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of element to hover' },
            text: { type: 'string', description: 'Hover over element by its text content' },
            waitAfter: { type: 'number', description: 'Ms to wait after hover (default: 800)' },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_scroll',
        description:
          'Scroll the page or a specific element to reveal more content. ' +
          'Use "bottom" to trigger infinite scroll / load more data.',
        parameters: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['down', 'up', 'top', 'bottom'],
              description: 'Scroll direction (default: down)',
            },
            pixels: {
              type: 'number',
              description: 'Pixels to scroll (default: 800). Ignored for "top"/"bottom".',
            },
            selector: {
              type: 'string',
              description: 'Scroll within this element (CSS selector). E.g. a scrollable list or table.',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_type',
        description:
          'Type text into an input or textarea. First clicks to focus the element, then types. ' +
          'Use pressEnter=true to submit forms. Use clearFirst=false to append instead of replace.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the input/textarea' },
            text: { type: 'string', description: 'Text to type' },
            pressEnter: { type: 'boolean', description: 'Press Enter after typing (default: false)' },
            clearFirst: { type: 'boolean', description: 'Clear existing value first (default: true)' },
            delay: { type: 'number', description: 'Typing delay in ms per keystroke (default: 30). Set 0 for instant.' },
          },
          required: ['selector', 'text'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_set_value',
        description:
          'Directly set the value of an input field without simulating keystrokes. ' +
          'Essential for React/Vue controlled inputs where browser_type may not trigger state updates. ' +
          'Fires input/change events so the framework picks up the value.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the input' },
            value: { type: 'string', description: 'Value to set' },
          },
          required: ['selector', 'value'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_select',
        description:
          'Select an option from a native <select> dropdown element. ' +
          'Use the visible text of the option, not its value attribute.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the <select> element' },
            option: { type: 'string', description: 'Option text to select (e.g. "English", "2024", "All")' },
          },
          required: ['selector', 'option'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_key',
        description:
          'Press one or more keyboard keys. Use for: Tab (navigate forms), Escape (close modals), ' +
          'Enter (confirm), ArrowUp/ArrowDown (scroll through lists), Ctrl+A (select all), etc. ' +
          'Key names: Enter, Escape, Tab, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ' +
          'Home, End, PageUp, PageDown, F5 (refresh), Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+Z, Ctrl+Enter.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key name or combo (e.g. "Escape", "Tab", "ArrowDown", "Control+a")' },
            selector: {
              type: 'string',
              description: 'CSS selector to focus before pressing key (optional). If omitted, key is pressed globally.',
            },
            count: { type: 'number', description: 'Number of times to press the key (default: 1)' },
          },
          required: ['key'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_focus',
        description: 'Focus an element (like clicking it without a click event). Useful to prepare for keyboard input.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector to focus' },
          },
          required: ['selector'],
        },
        riskLevel: 'read',
      },

      {
        name: 'browser_eval',
        description:
          'Execute any JavaScript code in the context of the current page. ' +
          'POWER TOOL — use to: extract data from JS state, interact with framework internals, ' +
          'trigger events manually, read variables, modify the DOM, or do anything else impossible ' +
          'with the other tools. Returns the JS return value. ' +
          'Example: "return document.querySelector(\'.price\')?.innerText" — extracts price. ' +
          'Example: "window.__app.state.user" — reads framework state.',
        parameters: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'JavaScript code to execute. Can use return to return a value. Has access to full DOM.',
            },
          },
          required: ['code'],
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_wait_for',
        description:
          'Wait for a condition to become true before continuing. ' +
          'Use to wait for: an element to appear, a URL change, text to appear, a loading spinner to disappear.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description: 'Wait for this CSS selector to appear on the page',
            },
            text: {
              type: 'string',
              description: 'Wait until this text appears in the page body',
            },
            urlContains: {
              type: 'string',
              description: 'Wait until the URL contains this string',
            },
            selectorGone: {
              type: 'string',
              description: 'Wait until this selector DISAPPEARS (e.g. a loading spinner)',
            },
            timeout: {
              type: 'number',
              description: 'Max wait time in ms (default: 10000)',
            },
          },
        },
        riskLevel: 'read',
      },
      {
        name: 'browser_network',
        description:
          'Capture recent network requests (XHR/Fetch) and their responses. ' +
          'Powerful for extracting API data that isn\'t visible in the DOM. ' +
          'Start capturing before navigating/clicking, then read results.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['start', 'stop', 'read'],
              description: '"start" — begin capturing, "stop" — stop, "read" — read captured requests',
            },
            filter: {
              type: 'string',
              description: 'Filter requests by URL substring (e.g. "api", "token", "price")',
            },
            maxItems: {
              type: 'number',
              description: 'Max requests to return (default: 20)',
            },
          },
          required: ['action'],
        },
        riskLevel: 'read',
      },

      {
        name: 'browser_close',
        description: 'Close the AI\'s browser window. Does not close the user\'s Chrome.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
      {
        name: 'browser_solve_cloudflare',
        description:
          'Solve a Cloudflare Turnstile/challenge page. Call this when you see ' +
          '"Verify you are human". ' +
          'Finds the Cloudflare iframe and clicks the checkbox automatically.',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read',
      },
    ],
  };

  private browserService: any;
  private eventBus: any;
  private logger!: LoggerInterface;

  private page: any = null;

  private capturedRequests: Array<{ url: string; method: string; status: number; body: string; responseText: string }> = [];
  private networkCaptureActive = false;

  async initialize(ctx: SkillContext): Promise<void> {
    this.browserService = ctx.browser;
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
  }

  async execute(tool: string, params: Record<string, any>): Promise<any> {
    switch (tool) {
      case 'browser_navigate':          return this.navigate(params);
      case 'browser_back':              return this.historyNav('back');
      case 'browser_forward':           return this.historyNav('forward');
      case 'browser_reload':            return this.reloadPage(params);
      case 'browser_screenshot':        return this.screenshot(params);
      case 'browser_read':              return this.read(params);
      case 'browser_get_html':          return this.getHtml(params);
      case 'browser_elements':          return this.listElements(params);
      case 'browser_find_text':         return this.findText(params);
      case 'browser_url':               return this.getUrl();
      case 'browser_click':             return this.click(params);
      case 'browser_click_xy':          return this.clickXY(params);
      case 'browser_hover':             return this.hover(params);
      case 'browser_scroll':            return this.scroll(params);
      case 'browser_type':              return this.typeText(params);
      case 'browser_set_value':         return this.setValue(params);
      case 'browser_select':            return this.selectOption(params);
      case 'browser_key':               return this.pressKey(params);
      case 'browser_focus':             return this.focusElement(params);
      case 'browser_eval':              return this.evalJS(params);
      case 'browser_wait_for':          return this.waitFor(params);
      case 'browser_network':           return this.networkCapture(params);
      case 'browser_close':             return this.closePage();
      case 'browser_solve_cloudflare':  return this.solveCloudflare();
      default: return { error: `Unknown tool: ${tool}` };
    }
  }

  async shutdown(): Promise<void> {
    await this.closePage();
  }


  private getMainBrowser(): any {
    const mb = this.browserService?.mainBrowser;
    if (!mb?.connected) return null;
    return mb;
  }

  private async getPage(): Promise<any> {
    if (this.page) {
      try {
        await this.page.title();
        return this.page;
      } catch {
        this.page = null;
      }
    }

    const mb = this.getMainBrowser();
    if (!mb) throw new Error('Chrome not connected. Connect via Chrome remote debugging first (chrome://inspect).');


    try {
      const pages = await mb.pages();
      const refPage = pages[0];
      if (refPage) {
        const newTargetPromise = new Promise<any>((resolve) => {
          mb.once('targetcreated', resolve);
        });
        const cdp = await refPage.createCDPSession();
        await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
        await cdp.detach();
        const newTarget = await Promise.race([
          newTargetPromise,
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        this.page = await (newTarget as any).page();
        this.logger.info('[BrowserEye] Opened separate Chrome window for AI');
        return this.page;
      }
    } catch {
      this.logger.warn('[BrowserEye] New window creation failed, falling back to new tab');
    }

    this.page = await mb.newPage();
    this.logger.info('[BrowserEye] Opened new tab (fallback)');
    return this.page;
  }


  private async navigate(params: Record<string, any>): Promise<any> {
    const { url, waitFor, timeout = 35000 } = params;
    if (!url) return { error: 'url is required' };

    try {
      const page = await this.getPage();


      page.off('dialog');
      page.on('dialog', async (dialog: any) => {
        try { await dialog.dismiss(); } catch {}
      });

      await page.goto(url, { waitUntil: 'networkidle2', timeout }).catch(async () => {

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      });

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
      }


      await new Promise(r => setTimeout(r, 3000));


      const cfResult = await this.solveCloudflare({ silent: true });
      if (cfResult.solved) {
        this.logger.info('[BrowserEye] CF auto-solved');
        await new Promise(r => setTimeout(r, 2500));
      }


      const pollStart = Date.now();
      while (Date.now() - pollStart < 8000) {
        const ready = await page.evaluate(() => (document.body?.innerText?.length ?? 0) > 200).catch(() => true);
        if (ready) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      const title = await page.title().catch(() => '');
      const currentUrl = page.url();

      return {
        success: true,
        url: currentUrl,
        title,
        hint: 'Page loaded. Call browser_screenshot to see how it looks, or browser_read to extract text.',
      };
    } catch (err: any) {
      return { error: err.message, hint: 'Call browser_screenshot to see the current state of the page.' };
    }
  }

  private async historyNav(direction: 'back' | 'forward'): Promise<any> {
    try {
      const page = await this.getPage();
      if (direction === 'back') await page.goBack({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      else await page.goForward({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      return { success: true, url: page.url(), title: await page.title().catch(() => '') };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async reloadPage(params: Record<string, any>): Promise<any> {
    const { waitFor } = params;
    try {
      const page = await this.getPage();
      await page.reload({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      return { success: true, url: page.url(), title: await page.title().catch(() => '') };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async screenshot(params: Record<string, any>): Promise<any> {
    const { fullPage = false, caption, selector } = params;
    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded. Use browser_navigate first.' };

      let screenshotB64: string;
      if (selector) {
        const el = await page.$(selector);
        if (!el) return { error: `Element "${selector}" not found for screenshot` };
        screenshotB64 = await el.screenshot({ encoding: 'base64', type: 'png' }) as string;
      } else {
        screenshotB64 = await page.screenshot({ encoding: 'base64', fullPage: !!fullPage, type: 'png' }) as string;
      }

      const title = await page.title().catch(() => '');
      this.eventBus.emit('agent:image', {
        image: screenshotB64,
        caption: caption || (selector ? `${selector} @ ${url}` : title || url),
      });

      return { success: true, url, title, message: 'Screenshot sent to chat.' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async read(params: Record<string, any>): Promise<any> {
    const { selector, maxLength = 8000, structured = false } = params;
    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded.' };

      const result = await page.evaluate((sel: string, max: number, str: boolean) => {
        const root: Element | null = sel ? document.querySelector(sel) : document.body;
        if (!root) return { error: `Selector "${sel}" not found` };
        const el = root as HTMLElement;
        const text = el.innerText || '';

        const out: any = { text: text.substring(0, max), length: text.length, truncated: text.length > max };

        if (str) {

          out.headings = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6'))
            .map(h => ({ level: h.tagName, text: (h as HTMLElement).innerText.trim() }))
            .slice(0, 30);
          out.links = Array.from(el.querySelectorAll('a[href]'))
            .map(a => ({ text: (a as HTMLElement).innerText.trim().substring(0, 60), href: a.getAttribute('href') }))
            .filter(l => l.text)
            .slice(0, 30);
          out.tables = Array.from(el.querySelectorAll('table')).map(table => {
            const rows = Array.from(table.querySelectorAll('tr')).map(row =>
              Array.from(row.querySelectorAll('th,td')).map(cell => (cell as HTMLElement).innerText.trim())
            );
            return rows.slice(0, 20);
          }).slice(0, 3);
        }

        return out;
      }, selector || '', maxLength, structured);

      if (result.error) return result;
      return { url, ...result };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async getHtml(params: Record<string, any>): Promise<any> {
    const { selector, maxLength = 8000 } = params;
    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded.' };

      const html = await page.evaluate((sel: string, max: number) => {
        const el = sel ? document.querySelector(sel) : document.body;
        if (!el) return { error: `Selector "${sel}" not found` };
        return { html: (el as HTMLElement).outerHTML.substring(0, max), length: (el as HTMLElement).outerHTML.length };
      }, selector || '', maxLength);

      if ((html as any).error) return html;
      return { url, ...html, truncated: (html as any).length > maxLength };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async listElements(params: Record<string, any>): Promise<any> {
    const { filter, selector, includeHidden = false } = params;
    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded.' };

      const elements = await page.evaluate((containerSel: string, filterText: string, incHidden: boolean) => {
        const container = (containerSel ? document.querySelector(containerSel) : document) as Element;
        if (!container) return { error: `Container "${containerSel}" not found` };

        const tags = [
          'a', 'button', 'input', 'select', 'textarea', 'label',
          '[role="tab"]', '[role="button"]', '[role="link"]', '[role="menuitem"]',
          '[role="checkbox"]', '[role="radio"]', '[role="option"]',
          '[class*="tab"]', '[class*="btn"]', '[class*="button"]',
          '[tabindex]', '[onclick]',
        ].join(', ');

        const all = Array.from(container.querySelectorAll(tags));
        const lowerFilter = filterText?.toLowerCase() || '';
        const results: any[] = [];

        for (const el of all) {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 && htmlEl.offsetParent !== null;
          if (!incHidden && !isVisible) continue;

          const text = (
            htmlEl.innerText?.trim() ||
            htmlEl.getAttribute('aria-label') ||
            htmlEl.getAttribute('placeholder') ||
            htmlEl.getAttribute('title') ||
            htmlEl.getAttribute('value') ||
            ''
          );
          const href = el.getAttribute('href');
          if (!text && !href) continue;
          if (lowerFilter && !text.toLowerCase().includes(lowerFilter) && !href?.toLowerCase().includes(lowerFilter)) continue;

          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
            : '';

          results.push({
            tag,
            text: text.substring(0, 80),
            selector: id ? `${tag}${id}` : (href ? `a[href="${href}"]` : `${tag}${cls}`),
            href: href || undefined,
            type: (el as HTMLInputElement).type || undefined,
            value: (el as HTMLInputElement).value || undefined,
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            disabled: (el as HTMLInputElement).disabled || undefined,
            visible: isVisible,
            position: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          });

          if (results.length >= 80) break;
        }
        return results;
      }, selector || '', filter || '', includeHidden);

      if ((elements as any).error) return elements;
      return {
        count: (elements as any[]).length,
        elements,
        hint: (elements as any[]).length === 0
          ? 'No matching elements. Try a different filter, or useincludeHidden=true, or call browser_screenshot.'
          : 'Use browser_click with "selector", "text", or browser_click_xy with "position".',
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async findText(params: Record<string, any>): Promise<any> {
    const { text, exact = false } = params;
    if (!text) return { error: 'text is required' };

    try {
      const page = await this.getPage();
      const results = await page.evaluate((searchText: string, isExact: boolean) => {
        const lower = searchText.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const found: any[] = [];
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null) && found.length < 20) {
          const nodeText = (node.textContent || '').trim();
          if (!nodeText) continue;
          const matches = isExact ? nodeText.toLowerCase() === lower : nodeText.toLowerCase().includes(lower);
          if (!matches) continue;

          const parent = node.parentElement as HTMLElement;
          if (!parent) continue;
          const rect = parent.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          const tag = parent.tagName.toLowerCase();
          const id = parent.id ? `#${parent.id}` : '';
          const cls = parent.className && typeof parent.className === 'string'
            ? '.' + parent.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
            : '';

          found.push({
            text: nodeText.substring(0, 100),
            selector: id ? `${tag}${id}` : `${tag}${cls}`,
            position: { x: Math.round(rect.x), y: Math.round(rect.y) },
          });
        }
        return found;
      }, text, exact);

      return {
        results,
        count: results.length,
        hint: results.length > 0 ? 'Use browser_click with the returned selector, or browser_click_xy with position.' : `"${text}" not found on page.`,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async getUrl(): Promise<any> {
    try {
      const page = await this.getPage();
      const url = page.url();
      return { url: url === 'about:blank' ? null : url, title: await page.title().catch(() => '') };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async click(params: Record<string, any>): Promise<any> {
    const { selector, text, waitAfter = 1500, force = false } = params;
    if (!selector && !text) return { error: 'Provide selector or text' };

    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded.' };

      let clicked = false;

      if (selector) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });

          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            el?.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, selector);
          await new Promise(r => setTimeout(r, 200));
          if (force) {
            await page.evaluate((sel: string) => (document.querySelector(sel) as HTMLElement)?.click(), selector);
          } else {
            await page.click(selector);
          }
          clicked = true;
        } catch {

          clicked = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (el) { el.click(); return true; }
            return false;
          }, selector);
        }
      }

      if (!clicked && text) {
        clicked = await page.evaluate((txt: string) => {
          const lower = txt.toLowerCase();

          const interactive = Array.from(document.querySelectorAll(
            'button, a, [role="tab"], [role="button"], [role="menuitem"], input[type="submit"], input[type="button"]'
          )) as HTMLElement[];
          const others = Array.from(document.querySelectorAll('span, div, li, td, p')) as HTMLElement[];
          for (const el of [...interactive, ...others]) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const elText = el.innerText?.trim().toLowerCase() || '';
            if (elText === lower || elText === lower) {
              el.scrollIntoView({ block: 'center', behavior: 'instant' });
              el.click();
              return true;
            }
          }

          for (const el of [...interactive, ...others]) {
            if ((el.getBoundingClientRect().width || 0) === 0) continue;
            const elText = el.innerText?.trim().toLowerCase() || '';
            if (elText.includes(lower)) {
              el.scrollIntoView({ block: 'center', behavior: 'instant' });
              el.click();
              return true;
            }
          }
          return false;
        }, text);
      }

      if (!clicked) {
        return {
          error: `Could not find element to click${selector ? ` (selector: "${selector}")` : ''}${text ? ` (text: "${text}")` : ''}`,
          hint: 'Try browser_elements to discover clickable elements, or browser_screenshot to see what\'s on the page.',
        };
      }

      await new Promise(r => setTimeout(r, waitAfter));
      const newUrl = page.url();
      return { success: true, url: newUrl, navigated: newUrl !== url };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async clickXY(params: Record<string, any>): Promise<any> {
    const { x, y, waitAfter = 1500 } = params;
    if (x === undefined || y === undefined) return { error: 'x and y are required' };
    try {
      const page = await this.getPage();
      await page.mouse.click(x, y);
      await new Promise(r => setTimeout(r, waitAfter));
      return { success: true, clicked: { x, y }, url: page.url() };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async hover(params: Record<string, any>): Promise<any> {
    const { selector, text, waitAfter = 800 } = params;
    try {
      const page = await this.getPage();

      if (selector) {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.hover(selector);
      } else if (text) {
        const found = await page.evaluate((txt: string) => {
          const lower = txt.toLowerCase();
          const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          for (const el of all) {
            if (el.children.length === 0 && el.innerText?.trim().toLowerCase().includes(lower)) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
          return null;
        }, text);
        if (!found) return { error: `Element with text "${text}" not found` };
        await page.mouse.move(found.x, found.y);
      } else {
        return { error: 'Provide selector or text' };
      }

      await new Promise(r => setTimeout(r, waitAfter));
      return { success: true, hint: 'Hovered. Call browser_screenshot to see what appeared (dropdown, tooltip, etc).' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async scroll(params: Record<string, any>): Promise<any> {
    const { direction = 'down', pixels = 800, selector } = params;
    try {
      const page = await this.getPage();
      await page.evaluate((dir: string, px: number, sel: string) => {
        const target = sel ? document.querySelector(sel) : window;
        if (!target) return;
        if (target === window) {
          switch (dir) {
            case 'down':   window.scrollBy(0, px); break;
            case 'up':     window.scrollBy(0, -px); break;
            case 'top':    window.scrollTo(0, 0); break;
            case 'bottom': window.scrollTo(0, document.documentElement.scrollHeight); break;
          }
        } else {
          const el = target as HTMLElement;
          switch (dir) {
            case 'down':   el.scrollTop += px; break;
            case 'up':     el.scrollTop -= px; break;
            case 'top':    el.scrollTop = 0; break;
            case 'bottom': el.scrollTop = el.scrollHeight; break;
          }
        }
      }, direction, pixels, selector || '');
      await new Promise(r => setTimeout(r, 1200));
      return { success: true, direction };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async typeText(params: Record<string, any>): Promise<any> {
    const { selector, text, pressEnter = false, clearFirst = true, delay = 30 } = params;
    try {
      const page = await this.getPage();
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        el?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, selector);
      if (clearFirst) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Delete');
      } else {
        await page.click(selector);
      }
      await page.type(selector, text, { delay });
      if (pressEnter) {
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 1500));
      }
      return { success: true, typed: text };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async setValue(params: Record<string, any>): Promise<any> {
    const { selector, value } = params;
    if (!selector || value === undefined) return { error: 'selector and value are required' };
    try {
      const page = await this.getPage();
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.evaluate((sel: string, val: string) => {
        const input = document.querySelector(sel) as HTMLInputElement;
        if (!input) return;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        (nativeInputValueSetter || nativeTextareaSetter)?.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector, value);
      return { success: true, set: value };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async selectOption(params: Record<string, any>): Promise<any> {
    const { selector, option } = params;
    if (!selector || !option) return { error: 'selector and option are required' };
    try {
      const page = await this.getPage();
      await page.waitForSelector(selector, { timeout: 5000 });
      const selected = await page.evaluate((sel: string, opt: string) => {
        const select = document.querySelector(sel) as HTMLSelectElement;
        if (!select) return false;
        const lower = opt.toLowerCase();
        for (const o of Array.from(select.options)) {
          if (o.text.toLowerCase() === lower || o.text.toLowerCase().includes(lower)) {
            select.value = o.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return o.text;
          }
        }
        return false;
      }, selector, option);

      if (!selected) return { error: `Option "${option}" not found in select. Available options?` };
      return { success: true, selected };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async pressKey(params: Record<string, any>): Promise<any> {
    const { key, selector, count = 1 } = params;
    if (!key) return { error: 'key is required' };
    try {
      const page = await this.getPage();
      if (selector) {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.focus(selector);
      }
      for (let i = 0; i < count; i++) {
        await page.keyboard.press(key);
        if (count > 1) await new Promise(r => setTimeout(r, 100));
      }
      await new Promise(r => setTimeout(r, 500));
      return { success: true, key, count };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async focusElement(params: Record<string, any>): Promise<any> {
    const { selector } = params;
    if (!selector) return { error: 'selector is required' };
    try {
      const page = await this.getPage();
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.focus(selector);
      return { success: true };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async evalJS(params: Record<string, any>): Promise<any> {
    const { code } = params;
    if (!code) return { error: 'code is required' };
    try {
      const page = await this.getPage();
      const url = page.url();
      if (!url || url === 'about:blank') return { error: 'No page loaded.' };

      const wrapped = `(async () => { ${code} })()`;
      const result = await page.evaluate(wrapped).catch((e: any) => ({ __evalError: e.message }));
      if (result && typeof result === 'object' && result.__evalError) {
        return { error: result.__evalError };
      }

      const serialized = result === undefined ? null
        : typeof result === 'object' ? JSON.stringify(result, null, 2).substring(0, 5000)
        : String(result).substring(0, 5000);
      return { result: serialized };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async waitFor(params: Record<string, any>): Promise<any> {
    const { selector, text, urlContains, selectorGone, timeout = 10000 } = params;
    try {
      const page = await this.getPage();
      const deadline = Date.now() + timeout;

      if (selector) {
        await page.waitForSelector(selector, { timeout });
        return { success: true, condition: `selector "${selector}" appeared` };
      }

      if (selectorGone) {
        while (Date.now() < deadline) {
          const exists = await page.$(selectorGone);
          if (!exists) return { success: true, condition: `selector "${selectorGone}" disappeared` };
          await new Promise(r => setTimeout(r, 500));
        }
        return { error: `Selector "${selectorGone}" did not disappear within ${timeout}ms` };
      }

      if (text) {
        while (Date.now() < deadline) {
          const found = await page.evaluate((t: string) => document.body.innerText.includes(t), text);
          if (found) return { success: true, condition: `text "${text}" appeared` };
          await new Promise(r => setTimeout(r, 500));
        }
        return { error: `Text "${text}" did not appear within ${timeout}ms` };
      }

      if (urlContains) {
        while (Date.now() < deadline) {
          if (page.url().includes(urlContains)) return { success: true, condition: `URL contains "${urlContains}"` };
          await new Promise(r => setTimeout(r, 500));
        }
        return { error: `URL did not contain "${urlContains}" within ${timeout}ms` };
      }

      return { error: 'Provide one of: selector, text, urlContains, or selectorGone' };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  private async networkCapture(params: Record<string, any>): Promise<any> {
    const { action, filter, maxItems = 20 } = params;

    try {
      const page = await this.getPage();

      if (action === 'start') {
        this.capturedRequests = [];
        this.networkCaptureActive = true;


        page.off('response');
        page.on('response', async (resp: any) => {
          if (!this.networkCaptureActive) return;
          const respUrl = resp.url();
          const ct = resp.headers()['content-type'] || '';
          if (!ct.includes('json') && !ct.includes('text')) return;
          if (respUrl.includes('favicon') || respUrl.includes('.png') || respUrl.includes('.css')) return;

          try {
            const body = await resp.text().catch(() => '');
            this.capturedRequests.push({
              url: respUrl,
              method: resp.request().method(),
              status: resp.status(),
              body: resp.request().postData()?.substring(0, 500) || '',
              responseText: body.substring(0, 2000),
            });
            if (this.capturedRequests.length > 200) this.capturedRequests.shift();
          } catch {}
        });

        return { success: true, message: 'Network capture started. Navigate or click something, then call browser_network with action="read".' };
      }

      if (action === 'stop') {
        this.networkCaptureActive = false;
        page.off('response');
        return { success: true, captured: this.capturedRequests.length };
      }

      if (action === 'read') {
        let reqs = this.capturedRequests;
        if (filter) reqs = reqs.filter(r => r.url.includes(filter));
        return {
          total: this.capturedRequests.length,
          filtered: reqs.length,
          requests: reqs.slice(-maxItems).reverse().map(r => ({
            method: r.method,
            status: r.status,
            url: r.url,
            requestBody: r.body.substring(0, 200) || undefined,
            response: r.responseText.substring(0, 800),
          })),
        };
      }

      return { error: 'action must be start, stop, or read' };
    } catch (err: any) {
      return { error: err.message };
    }
  }


  private async solveCloudflare(opts?: { silent?: boolean }): Promise<any> {
    try {
      const page = await this.getPage();

      const isCf = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const hasCfTitle = /verify you are human|security check|checking your browser/i.test(bodyText);
        const hasCfFrame = Array.from(document.querySelectorAll('iframe')).some(f =>
          (f.src || '').includes('challenges.cloudflare.com') ||
          (f.title || '').toLowerCase().includes('cloudflare') ||
          (f.id || '').includes('cf-')
        );
        return hasCfTitle || hasCfFrame;
      }).catch(() => false);

      if (!isCf) {
        return opts?.silent ? { solved: false } : { success: false, message: 'No Cloudflare challenge detected.' };
      }

      const frames = page.frames();
      let clicked = false;

      for (const frame of frames) {
        const frameUrl = frame.url();
        if (!frameUrl.includes('challenges.cloudflare.com') && !frameUrl.includes('turnstile')) continue;
        try {
          await frame.waitForSelector('input[type="checkbox"]', { timeout: 8000 }).catch(() => {});
          const ok = await frame.evaluate(() => {
            const cb = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
            if (cb) { cb.click(); return true; }
            const span = document.querySelector('.cb-i, .ctp-checkbox-container');
            if (span) { (span as HTMLElement).click(); return true; }
            return false;
          }).catch(() => false);
          if (ok) { clicked = true; break; }
        } catch {}
      }

      if (!clicked) {
        clicked = await page.evaluate(() => {
          for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
            try {
              const cb = (iframe.contentDocument || iframe.contentWindow?.document)?.querySelector('input[type="checkbox"]') as HTMLElement;
              if (cb) { cb.click(); return true; }
            } catch {}
          }
          return false;
        }).catch(() => false);
      }

      const start = Date.now();
      while (Date.now() - start < 10000) {
        await new Promise(r => setTimeout(r, 1000));
        const resolved = await page.evaluate(() =>
          !/verify you are human|security check|checking your browser/i.test(document.body?.innerText || '')
        ).catch(() => true);
        if (resolved) return opts?.silent ? { solved: true } : { success: true, message: 'Cloudflare solved!' };
      }

      return opts?.silent ? { solved: false } : { success: false, message: 'CF not solved. Take a screenshot to see current state.' };
    } catch (err: any) {
      return opts?.silent ? { solved: false } : { error: err.message };
    }
  }


  private async closePage(): Promise<any> {
    this.networkCaptureActive = false;
    if (this.page) {
      try { await this.page.close(); } catch {}
      this.page = null;
    }
    this.logger.info('[BrowserEye] Browser window closed');
    return { success: true };
  }
}
