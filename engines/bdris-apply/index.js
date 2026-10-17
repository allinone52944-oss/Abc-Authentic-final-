'use strict';
/**
 * engines/bdris-apply/index.js — Abc Authentic adapter for the
 * BDRIS Apply Engine (BDRIS Auto-fill Bot v6).
 *
 * WRAPPING ONLY — the engine folder is an as-is copy of the
 * bdris-apply engine (server.js + helpers + frontend-index.html).
 * No engine logic is modified here.
 *
 * Integration:
 *  - The engine is a standalone Express + Socket.IO + Playwright app.
 *    The adapter spawns it as a subprocess on 127.0.0.1:3102
 *    (configurable via BDRIS_APPLY_PORT).
 *  - getApp() returns Express middleware that reverse-proxies
 *    /api/bdris-apply/* → the subprocess (HTTP + WebSocket upgrade
 *    for Socket.IO).
 *  - The main backend mounts it with JWT auth + rate limit.
 *  - Wallet charging is handled by backend/routes/bdris-apply.js
 *    (separate charge endpoints called by the frontend shim before
 *    SUBMIT_S4_OTP and FETCH_ORIGINAL).
 *
 * Notes:
 *  - Engine deps (VM): cd engines/bdris-apply && npm install
 *    (needs playwright + socket.io + express + cors + tesseract.js;
 *    playwright downloads ~170MB browser on first run).
 *  - Playwright browser: the engine uses its own Playwright (headless).
 *  - If the subprocess fails to start, the proxy returns 503 JSON;
 *    other app routes are unaffected.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ENGINE_PORT = parseInt(process.env.BDRIS_APPLY_PORT || '3102', 10);
const ENGINE_HOST = '127.0.0.1';

let _proc = null;
let _procStartTime = 0; // W-1 fix: process কখন start হলো — probe কখনো OK না হলে zombie ধরা যাবে
let _ready = false;

function engineDir() {
  return __dirname;
}

let _installing = false;
let _restartTimer = null;
let _watchdog = null;
let _crashCount = 0;

function scheduleRestart() {
  // Exponential backoff: 5s, 10s, 20s ... capped at 5 min. Prevents tight crash loops.
  if (_restartTimer) return;
  _crashCount += 1;
  const delay = Math.min(5000 * Math.pow(2, Math.min(_crashCount - 1, 6)), 300000);
  console.error(`[bdris-apply] scheduling restart in ${Math.round(delay / 1000)}s (crash #${_crashCount})`);
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    init();
  }, delay);
  if (_restartTimer.unref) _restartTimer.unref();
}

function init() {
  if (_proc || _installing) return;
  const serverJs = path.join(engineDir(), 'server.js');
  if (!fs.existsSync(serverJs)) {
    console.error('[bdris-apply] server.js not found, engine not started');
    return;
  }
  // Auto-install node_modules on first run (no manual VM step needed)
  if (!fs.existsSync(path.join(engineDir(), 'node_modules'))) {
    console.log('[bdris-apply] node_modules missing — auto-installing (first run, may take a few minutes)...');
    _installing = true;
    const npm = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: engineDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    npm.stdout.on('data', (d) => console.log('[bdris-apply:npm]', String(d).slice(0, 200)));
    npm.stderr.on('data', (d) => console.error('[bdris-apply:npm]', String(d).slice(0, 200)));
    npm.on('close', (code) => {
      _installing = false;
      if (code === 0) {
        _crashCount = 0; // fresh install succeeded — reset backoff
        console.log('[bdris-apply] npm install done — starting engine');
        // Playwright browser (non-blocking; engine works in mock mode without it)
        const pw = spawn('npx', ['playwright', 'install', 'chromium', '--only-shell'], {
          cwd: engineDir(), stdio: 'ignore',
        });
        pw.on('close', () => console.log('[bdris-apply] playwright chromium ready (or skipped)'));
        startEngine();
      } else {
        console.error('[bdris-apply] npm install failed with code', code, '— will retry via supervisor');
        scheduleRestart();
      }
    });
    npm.on('error', (e) => {
      _installing = false;
      console.error('[bdris-apply] npm spawn failed:', e.message);
      scheduleRestart();
    });
    return;
  }
  startEngine();
}

function startEngine() {
  if (_proc) return;
  const serverJs = path.join(engineDir(), 'server.js');
  _proc = spawn(process.execPath, [serverJs], {
    cwd: engineDir(),
    env: Object.assign({}, process.env, {
      PORT: String(ENGINE_PORT),
      HEADLESS: '1', // always headless on server
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _procStartTime = Date.now(); // W-1 fix
  _lastProbeOk = 0; // W-1 fix: নতুন process-এর জন্য probe history রিসেট
  _proc.stdout.on('data', (d) => {
    const s = String(d);
    if (/listening|ready|BDRIS/i.test(s)) _ready = true;
    // Forward engine logs (2026-10-15): previously swallowed, making diagnosis impossible.
    // Filter out noisy page-console spam, keep important lines.
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^PAGE-CONSOLE/.test(t) && !/error/i.test(t)) continue;
      console.log('[bdris-apply:engine]', t.slice(0, 300));
    }
  });
  _proc.stderr.on('data', (d) => {
    console.error('[bdris-apply:engine]', String(d).slice(0, 500));
  });
  _proc.on('exit', (code) => {
    console.error('[bdris-apply] engine exited with code', code);
    _proc = null;
    _procStartTime = 0;
    _ready = false;
    // Supervisor: restart crashed engine (2026-10-15 — previously a single
    // crash left the engine dead until the next full service restart).
    scheduleRestart();
  });
  // Watchdog: every 60s, make sure the engine is running (covers cases where
  // init was never retried, e.g. server.js missing at boot then restored).
  // Also: if process exists but port probe has failed for >2min, the process
  // is hung — kill it and restart fresh (2026-10-16 robustness).
  if (!_watchdog) {
    _watchdog = setInterval(() => {
      if (!_proc && !_installing && !_restartTimer) init();
      // Hung process detection: _proc exists but no successful probe in 2min
      if (_proc && _lastProbeOk > 0 && Date.now() - _lastProbeOk > 120000) {
        console.error('[bdris-apply] watchdog: process hung (no probe OK in 2min), killing');
        try { _proc.kill('SIGKILL'); } catch (e) {}
        _proc = null;
        _procStartTime = 0;
        _ready = false;
        _crashCount = 0; // fresh start, not a crash loop
        scheduleRestart();
      }
      // W-1 fix: process start হয়েছে কিন্তু 90s-এ একবারও probe OK হয়নি
      // (port bind fail / silent hang) — zombie kill করে restart
      if (_proc && _lastProbeOk === 0 && _procStartTime > 0 && Date.now() - _procStartTime > 90000) {
        console.error('[bdris-apply] watchdog: process never became healthy in 90s, killing zombie');
        try { _proc.kill('SIGKILL'); } catch (e) {}
        _proc = null;
        _procStartTime = 0;
        _ready = false;
        scheduleRestart();
      }
    }, 60000);
    if (_watchdog.unref) _watchdog.unref();
  }
  // Give it a moment; readiness is best-effort (proxy retries anyway)
  // W-3 fix: শুধু process এখনো বেঁচে থাকলেই ready flag ওঠাও — crash হলে নয়
  setTimeout(() => { if (_proc) _ready = true; }, 8000);
}

function isReady() {
  if (!!_proc && _ready) return true;
  // Orphaned engine: trust the background port probe, but only if it
  // succeeded recently (30s). A stale/failed probe honestly reports
  // not-ready instead of a permanent misleading "ready".
  if (_portOk && Date.now() - _lastProbeOk < 30000) return true;
  try { probePort(true); } catch (e) {}
  return _portOk && Date.now() - _lastProbeOk < 30000;
}

// Cached port probe — refreshed every 10s in background, non-blocking.
// Pass force=true to bypass the 10s throttle (used by isReady).
let _portOk = false;
let _lastProbeOk = 0;
let _portProbeAt = 0;
function probePort(force) {
  const now = Date.now();
  if (!force && now - _portProbeAt < 10000) return;
  _portProbeAt = now;
  const req = http.request({
    host: ENGINE_HOST, port: ENGINE_PORT, path: '/api/health',
    method: 'GET', timeout: 3000,
  }, (res) => {
    const ok = res.statusCode >= 200 && res.statusCode < 500;
    _portOk = ok;
    if (ok) {
      _lastProbeOk = Date.now();
      // Successful probe resets crash count — transient issues shouldn't
      // cause ever-increasing backoff (2026-10-16 robustness).
      if (_crashCount > 0) _crashCount = 0;
    }
    res.resume();
  });
  req.on('error', () => { _portOk = false; });
  req.on('timeout', () => { req.destroy(); _portOk = false; });
  req.end();
}
setInterval(probePort, 10000);
if (typeof probePort.unref === 'function') { /* keep alive for accuracy */ }
probePort();

// Simple reverse proxy middleware (HTTP). Strips the mount prefix.
function proxyMiddleware() {
  return (req, res, next) => {
    if (!_proc) {
      return res.status(503).json({ error: 'ENGINE_NOT_RUNNING' });
    }
    // Strip /api/bdris-apply prefix → engine path
    const targetPath = req.originalUrl.replace(/^\/api\/bdris-apply/, '') || '/';
    const opts = {
      host: ENGINE_HOST,
      port: ENGINE_PORT,
      path: targetPath,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: `${ENGINE_HOST}:${ENGINE_PORT}` }),
    };
    // Don't forward the user's Authorization to the engine (it doesn't need it)
    delete opts.headers['authorization'];
    delete opts.headers['cookie'];

    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(502).json({ error: 'ENGINE_UNREACHABLE' });
    });
    proxyReq.on('timeout', () => proxyReq.destroy());
    proxyReq.setTimeout(120000);
    // Pipe body (for POST/PUT). The main app uses express.json() globally,
    // so req.body is already parsed — re-serialize it.
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      const bodyStr = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      proxyReq.end(bodyStr);
    } else {
      req.pipe(proxyReq);
    }
  };
}

// WebSocket upgrade handler for Socket.IO.
// Attach to the main HTTP server: server.on('upgrade', adapter.handleUpgrade)
function handleUpgrade(req, socket, head) {
  if (!req.url || !req.url.startsWith('/api/bdris-apply/socket.io')) {
    return false; // not ours
  }
  if (!_proc) {
    socket.destroy();
    return true;
  }
  // Rewrite URL: strip /api/bdris-apply prefix for the engine
  const targetPath = req.url.replace(/^\/api\/bdris-apply/, '') || '/';
  const opts = {
    host: ENGINE_HOST,
    port: ENGINE_PORT,
    path: targetPath,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: `${ENGINE_HOST}:${ENGINE_PORT}` }),
  };
  delete opts.headers['authorization'];
  delete opts.headers['cookie'];
  const proxyReq = http.request(opts);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      socket.write(`${k}: ${v}\r\n`);
    }
    socket.write('\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on('error', () => socket.destroy());
  proxyReq.end(head);
  return true;
}

function getApp() {
  // Returns middleware; the main server.js mounts it at /api/bdris-apply
  const express = require('express');
  const router = express.Router();
  router.use(proxyMiddleware());
  return router;
}

module.exports = { init, getApp, handleUpgrade, isReady, ENGINE_PORT };
