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
    // 2026-10-25 warm-up pool: engine startup-এ আগেই Chromium + BDRIS
    // ফর্ম লোড করা কয়েকটি পেজ পুলে থাকে। সেশন এখান থেকে নিলে
    // launch + form-load খরচ আর দিতে হয় না। প্রতিটি পুল-পেজ
    // anonymous public ফর্ম — কোনো ইউজার ডেটা এতে থাকে না, তাই
    // সেশনে দেওয়া নিরাপদ। নেওয়া পেজ পুলে আর ফেরে না।
    this.warmPool = [];
    // Max pool size (server fills up to BDRIS_WARM_POOL_SIZE, clamp 1..5).
    this.maxWarmPoolSize = 5;
    // Replenish hook: invoked non-blocking on every successful take.
    // The server sets this to refill one page; never awaited here.
    this.onWarmPageTaken = null;
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

  // Push a fresh pre-loaded page onto the pool (FIFO). Kept for
  // existing callers: setWarmPage(null) is safe, and pages beyond the
  // cap are closed instead of leaked. A closed page is never pooled.
  setWarmPage(page) {
    if (!page) return;
    try { if (typeof page.isClosed === 'function' && page.isClosed()) return; } catch (e) { return; }
    if (this.warmPool.length >= this.maxWarmPoolSize) {
      try {
        if (typeof page.close === 'function') {
          const r = page.close();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        }
      } catch (e) { /* excess page dropped, never leaked into the pool */ }
      return;
    }
    this.warmPool.push(page);
  }

  // Drop closed pages silently; used by warmPoolSize() so it never
  // counts a page that can no longer be handed out.
  _purgeClosedWarmPages() {
    this.warmPool = this.warmPool.filter((page) => {
      try { return !(typeof page.isClosed === 'function' && page.isClosed()); }
      catch (e) { return false; }
    });
  }

  warmPoolSize() {
    this._purgeClosedWarmPages();
    return this.warmPool.length;
  }

  // Returns the oldest pooled page once, or null (caller then creates
  // a fresh page). A closed page is skipped, never handed out. On a
  // successful take only, the replenish hook fires non-blocking and
  // its errors are swallowed so session creation never breaks.
  takeWarmPage() {
    while (this.warmPool.length > 0) {
      const page = this.warmPool.shift();
      let closed = false;
      try { closed = typeof page.isClosed === 'function' && page.isClosed(); }
      catch (e) { closed = true; }
      if (closed) continue;
      if (typeof this.onWarmPageTaken === 'function') {
        try {
          const r = this.onWarmPageTaken();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch (e) { /* replenish must never break session creation */ }
      }
      return page;
    }
    return null;
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
