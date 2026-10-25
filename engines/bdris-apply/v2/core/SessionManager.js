/**
 * SessionManager — User session lifecycle
 *
 * Principles:
 * - Each session is isolated (own browser context)
 * - Sessions expire after timeout
 * - Automatic cleanup
 * - No shared state between sessions
 */

// Names-only submit/verify request logging (alternative path 2,
// 2026-10-25): warm-pool pages bypass BrowserManager.newPage, so
// attach here too. attach() is idempotent (marker on the page), so a
// page already carrying the listener is left alone. OFF by default.
const { attachRequestNameLog } = require('../services/RequestNameLog');

class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map(); // sessionId -> session
    this.browserManager = options.browserManager;
    this.sessionTimeoutMs = options.sessionTimeoutMs || 25 * 60 * 1000; // 25 min
    this.cleanupInterval = null;
    this.onSessionExpired = options.onSessionExpired || (() => {});
  }

  generateId() {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async create(userId, metadata = {}) {
    const sessionId = this.generateId();
    // 2026-10-25 warm-up: warm page থাকলে সেটাই নাও — নতুন পেজ +
    // form-load এর খরচ বাঁচে। না থাকলে আগের মতো নতুন পেজ।
    let page = null;
    if (typeof this.browserManager.takeWarmPage === 'function') {
      page = this.browserManager.takeWarmPage();
    }
    if (!page) page = await this.browserManager.newPage();
    // Belt-and-braces attach for warm-pool pages (no-op when OFF,
    // no-op when already attached, failures swallowed).
    attachRequestNameLog(page);

    const session = {
      id: sessionId,
      userId: userId || null,
      page,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      metadata,
      state: 'ACTIVE', // ACTIVE | EXPIRED | CLOSED
    };

    this.sessions.set(sessionId, session);
    this.startCleanup();
    return session;
  }

  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (s.state !== 'ACTIVE') return null;
    if (Date.now() - s.lastActivity > this.sessionTimeoutMs) {
      this.expire(s.id);
      return null;
    }
    return s;
  }

  touch(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s && s.state === 'ACTIVE') {
      s.lastActivity = Date.now();
    }
  }

  async expire(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.state !== 'ACTIVE') return;
    s.state = 'EXPIRED';
    await this.destroy(sessionId);
    this.onSessionExpired(sessionId, s.userId);
  }

  async destroy(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.state = 'CLOSED';
    if (s.page) {
      await this.browserManager.closePage(s.page).catch(() => {});
    }
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0) {
      this.stopCleanup();
    }
  }

  // Find active session for a user (for same-user takeover)
  findByUser(userId) {
    if (!userId) return null;
    for (const s of this.sessions.values()) {
      if (s.state === 'ACTIVE' && String(s.userId) === String(userId)) {
        if (Date.now() - s.lastActivity <= this.sessionTimeoutMs) {
          return s;
        }
      }
    }
    return null;
  }

  startCleanup() {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.state === 'ACTIVE' && now - s.lastActivity > this.sessionTimeoutMs) {
          this.expire(id).catch(() => {});
        }
      }
    }, 60000); // Check every minute
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async closeAll() {
    this.stopCleanup();
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.destroy(id).catch(() => {});
    }
  }

  getStats() {
    return {
      active: [...this.sessions.values()].filter(s => s.state === 'ACTIVE').length,
      total: this.sessions.size,
    };
  }
}

module.exports = { SessionManager };
