'use strict';
/**
 * Proxy adapter for Death Engine (death-final, standalone on 127.0.0.1:3104).
 * Forwards /api/death-engine/* to the standalone engine.
 *
 * H-10 fix (2026-10-15): init() now spawns death-verify-server.js as a
 * subprocess — previously nothing started the standalone server, so
 * /api/death-engine/* returned 503 on a fresh deploy. The standalone
 * server uses only Node built-ins + a local module, so no npm install
 * is needed.
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ENGINE_PORT = parseInt(process.env.DEATH_ENGINE_PORT || '3104', 10);

let _proc = null;

function init() {
  if (_proc) return;
  const serverJs = path.join(__dirname, 'death-verify-server.js');
  if (!fs.existsSync(serverJs)) {
    console.error('[death-final] death-verify-server.js not found, engine not started');
    return;
  }
  _proc = spawn(process.execPath, [serverJs], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(ENGINE_PORT), DEATH_ENGINE_PORT: String(ENGINE_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _proc.stdout.on('data', (d) => {
    const s = String(d);
    if (/localhost|listening/i.test(s)) console.log('[death-final] engine up:', s.trim().slice(0, 120));
  });
  _proc.stderr.on('data', (d) => {
    console.error('[death-verify:engine]', String(d).slice(0, 500));
  });
  _proc.on('exit', (code) => {
    console.error('[death-final] engine exited with code', code);
    _proc = null;
  });
}

function getApp() {
  // Return a plain middleware function (no express required)
  return (req, res) => {
    const bodyData = req.body ? JSON.stringify(req.body) : null;
    const headers = { ...req.headers, host: '127.0.0.1:' + ENGINE_PORT };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    if (bodyData) headers['content-length'] = Buffer.byteLength(bodyData);
    const opts = {
      hostname: '127.0.0.1',
      port: ENGINE_PORT,
      path: req.originalUrl.replace(/^\/api\/death-engine/, '') || '/',
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

function getInfo() { return { engine: 'death-proxy', port: ENGINE_PORT }; }

module.exports = { init, getInfo, getApp };
