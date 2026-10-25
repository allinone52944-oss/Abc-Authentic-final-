'use strict';
/**
 * Proxy adapter for Birth Engine (birth-final, standalone on 127.0.0.1:3000).
 * Forwards /api/bdris-engine/* to the standalone engine.
 *
 * H-10 fix (2026-10-15): init() now spawns engines/birth-final/server.js
 * as a subprocess (like bdris-apply does) — previously nothing started the
 * standalone server, so /api/bdris-engine/* returned 503 on a fresh deploy.
 * node_modules are auto-installed on first run.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ENGINE_PORT = parseInt(process.env.BIRTH_ENGINE_PORT || '3000', 10);

let _proc = null;
let _installing = false;

function init() {
  if (_proc || _installing) return;
  const serverJs = path.join(__dirname, 'server.js');
  if (!fs.existsSync(serverJs)) {
    console.error('[birth-final] server.js not found, engine not started');
    return;
  }
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.log('[birth-final] node_modules missing — auto-installing (first run, may take a few minutes)...');
    _installing = true;
    const npm = spawn('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    npm.stdout.on('data', (d) => console.log('[birth-final:npm]', String(d).slice(0, 200)));
    npm.stderr.on('data', (d) => console.error('[birth-final:npm]', String(d).slice(0, 200)));
    npm.on('close', (code) => {
      _installing = false;
      if (code === 0) { console.log('[birth-final] npm install done — starting engine'); startEngine(); }
      else console.error('[birth-final] npm install failed with code', code, '— will retry on next init');
    });
    npm.on('error', (e) => {
      _installing = false;
      console.error('[birth-final] npm spawn failed:', e.message);
    });
    return;
  }
  startEngine();
}

function startEngine() {
  if (_proc) return;
  const serverJs = path.join(__dirname, 'server.js');
  _proc = spawn(process.execPath, [serverJs], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { BIRTH_ENGINE_PORT: String(ENGINE_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _proc.stdout.on('data', (d) => {
    const s = String(d);
    if (/running on port|listening/i.test(s)) console.log('[birth-final] engine up:', s.trim().slice(0, 120));
  });
  _proc.stderr.on('data', (d) => {
    console.error('[birth-final:engine]', String(d).slice(0, 500));
  });
  _proc.on('exit', (code) => {
    console.error('[birth-final] engine exited with code', code);
    _proc = null;
  });
}

function getApp() {
  // Return a plain middleware function (no express required)
  return (req, res) => {
    const bodyData = req.body ? JSON.stringify(req.body) : null;
    const headers = { ...req.headers, host: '127.0.0.1:3000' };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    if (bodyData) headers['content-length'] = Buffer.byteLength(bodyData);
    const opts = {
      hostname: '127.0.0.1',
      port: ENGINE_PORT,
      path: req.originalUrl.replace(/^\/api\/bdris-engine/, '') || '/',
      method: req.method,
      headers
    };
    const proxy = http.request(opts, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    proxy.on('error', () => res.status(503).json({ success: false, error: 'Engine unavailable' }));
    if (bodyData) proxy.write(bodyData);
    proxy.end();
  };
}

function getInfo() { return { engine: 'birth-proxy', port: ENGINE_PORT }; }
async function generate() { return { ok: false, error: 'Use API' }; }
async function run() { return { ok: false, error: 'Use API' }; }
function maskBrn(b) { return b; }

module.exports = { init, getInfo, getApp, generate, run, maskBrn };
