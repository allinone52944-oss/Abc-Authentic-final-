'use strict';
/**
 * Proxy adapter for Birth Engine (standalone on 127.0.0.1:3000).
 * Forwards /api/bdris-engine/* to the standalone engine.
 */
const http = require('http');

let app = null;

function init() {}

function getApp() {
  if (app) return app;
  const express = require('express');
  app = express();
  app.use((req, res) => {
    const bodyData = req.body ? JSON.stringify(req.body) : null;
    const headers = { ...req.headers, host: '127.0.0.1:3000' };
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    if (bodyData) headers['content-length'] = Buffer.byteLength(bodyData);
    const opts = {
      hostname: '127.0.0.1',
      port: 3000,
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
  });
  return app;
}

function getInfo() { return { engine: 'birth-proxy', port: 3000 }; }
async function generate() { return { ok: false, error: 'Use API' }; }
async function run() { return { ok: false, error: 'Use API' }; }
function maskBrn(b) { return b; }

module.exports = { init, getInfo, getApp, generate, run, maskBrn };
