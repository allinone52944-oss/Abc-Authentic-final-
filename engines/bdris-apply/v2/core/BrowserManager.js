/**
 * BrowserManager — Playwright browser lifecycle management
 *
 * Principles:
 * - Single browser instance, multiple isolated contexts
 * - Automatic crash recovery
 * - Health checks
 * - Clean shutdown
 */

const { chromium } = require('playwright');

class BrowserManager {
  constructor(options = {}) {
    this.browser = null;
    this.state = 'IDLE'; // IDLE | STARTING | READY | ERROR | STOPPING
    this.launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      ...options.launchOptions,
    };
    this.healthCheckInterval = null;
    this.onStateChange = options.onStateChange || (() => {});
  }

  setState(newState) {
    const old = this.state;
    this.state = newState;
    this.onStateChange(old, newState);
  }

  async launch() {
    if (this.state === 'READY' && this.browser?.isConnected()) {
      return this.browser;
    }
    if (this.state === 'STARTING') {
      // Wait for in-progress launch
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (this.state === 'READY') return this.browser;
        if (this.state === 'ERROR') break;
      }
      throw new Error('Browser launch timed out or failed');
    }

    this.setState('STARTING');
    try {
      this.browser = await chromium.launch(this.launchOptions);
      this.setState('READY');
      this.startHealthChecks();
      return this.browser;
    } catch (e) {
      this.setState('ERROR');
      throw new Error(`Browser launch failed: ${e.message}`);
    }
  }

  async newContext(options = {}) {
    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...options,
    });
    return context;
  }

  async newPage(contextOptions = {}) {
    const context = await this.newContext(contextOptions);
    const page = await context.newPage();
    // Store context for cleanup
    page._context = context;
    return page;
  }

  async closePage(page) {
    try {
      if (page && !page.isClosed()) {
        const ctx = page._context;
        await page.close().catch(() => {});
        if (ctx) await ctx.close().catch(() => {});
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  startHealthChecks() {
    this.stopHealthChecks();
    this.healthCheckInterval = setInterval(() => {
      if (this.browser && !this.browser.isConnected()) {
        this.setState('ERROR');
        this.stopHealthChecks();
      }
    }, 5000);
  }

  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async close() {
    this.setState('STOPPING');
    this.stopHealthChecks();
    try {
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
    } finally {
      this.setState('IDLE');
    }
  }

  isReady() {
    return this.state === 'READY' && this.browser?.isConnected();
  }
}

module.exports = { BrowserManager };
