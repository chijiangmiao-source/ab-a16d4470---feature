'use strict';

/**
 * 零依赖静态站点服务器 + 匹配 HTTP API。
 *
 * - 页面 / Web Worker 等静态资源由 dist 提供；
 * - GET  /health 健康响应；
 * - POST /api/match 在服务端复用与 Web Worker 完全相同的规则编排
 *   （review.js → matching.js / parse.js，用于 HTTP 冒烟与外部核验）；
 *   请求体可附带 "fixedPair": {"a": "...", "b": "..."} 执行固定配对预演；
 *   浏览器页面本身始终在 Web Worker 中计算，不调用本接口。
 *
 * 端口 / 监听地址可由环境变量配置：HOST、PORT。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { reviewMatching } = require('../src/review');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DIST = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(DIST, rel));
  if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found', path: rel });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体超过 1MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleMatch(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch {
    sendJson(res, 400, { ok: false, errors: ['请求体不是合法 JSON'] });
    return;
  }
  const hasFixed = Object.prototype.hasOwnProperty.call(payload, 'fixedPair') && payload.fixedPair != null;
  const outcome = reviewMatching(
    String(payload.channels ?? ''),
    String(payload.edges ?? ''),
    hasFixed ? payload.fixedPair : null
  );
  if (outcome.kind === 'invalid') {
    sendJson(res, 200, { ok: true, valid: false, errors: outcome.errors });
    return;
  }
  const body = {
    ok: true,
    valid: true,
    matched: outcome.kind === 'matched' || outcome.kind === 'fixed-matched',
    channels: outcome.channels,
  };
  if (outcome.fixedPair) {
    body.fixed = true;
    body.fixedPair = outcome.fixedPair;
  }
  if (outcome.pairs) body.pairs = outcome.pairs;
  if (outcome.remainingChannels) body.remainingChannels = outcome.remainingChannels;
  if (outcome.certificate) body.certificate = outcome.certificate;
  sendJson(res, 200, body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'relay-channel-matching', time: new Date().toISOString() });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/match') {
    handleMatch(req, res).catch((err) => sendJson(res, 500, { ok: false, errors: [String(err && err.message || err)] }));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  const actual = server.address();
  console.log(`[relay-matching] listening on http://${HOST}:${actual.port} (serving ${DIST})`);
});

module.exports = server;
