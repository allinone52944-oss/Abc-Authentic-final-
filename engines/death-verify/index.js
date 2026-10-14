'use strict';
/**
 * Proxy adapter for Death Engine (standalone on 127.0.0.1:3001).
 * Forwards /api/death-engine/* to the standalone engine.
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
    const opts = {
      hostname: '127.0.0.1',
      port: 3001,
      path: req.originalUrl.replace(/^\/api\/death-engine/, '') || '/',
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:3001', 'content-length': bodyData ? Buffer.byteLength(bodyData) : 0 }
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

function getInfo() { return { engine: 'death-proxy', port: 3001 }; }

module.exports = { init, getInfo, getApp };
