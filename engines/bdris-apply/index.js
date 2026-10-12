'use strict';
/**
 * engines/bdris-apply/index.js — Abc Authentic adapter for the
 * BDRIS Apply Engine (BDRIS Auto-fill Bot v6).
 *
 * WRAPPING ONLY — the engine folder is an as-is copy of
 * Bdris-apply-v2-CLEAN-v23.zip contents (server.js + helpers +
 * frontend-index.html). No engine logic is modified here.
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
let _ready = false;

function engineDir() {
  return __dirname;
}

function init() {
  if (_proc) return;
  const serverJs = path.join(engineDir(), 'server.js');
  if (!fs.existsSync(serverJs)) {
    console.error('[bdris-apply] server.js not found, engine not started');
    return;
  }
  // Check node_modules
  if (!fs.existsSync(path.join(engineDir(), 'node_modules'))) {
    console.error('[bdris-apply] node_modules missing — run: cd engines/bdris-apply && npm install');
    return;
  }
  _proc = spawn(process.execPath, [serverJs], {
    cwd: engineDir(),
    env: Object.assign({}, process.env, {
      PORT: String(ENGINE_PORT),
      HEADLESS: '1', // always headless on server
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _proc.stdout.on('data', (d) => {
    const s = String(d);
    if (/listening|ready|BDRIS/i.test(s)) _ready = true;
  });
  _proc.stderr.on('data', (d) => {
    console.error('[bdris-apply:engine]', String(d).slice(0, 500));
  });
  _proc.on('exit', (code) => {
    console.error('[bdris-apply] engine exited with code', code);
    _proc = null;
    _ready = false;
  });
  // Give it a moment; readiness is best-effort (proxy retries anyway)
  setTimeout(() => { _ready = true; }, 8000);
}

function isReady() {
  return !!_proc && _ready;
}

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
    proxyReq.setTimeout(30000);
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
