'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { db } = require('./db');
const { verifyToken } = require('./auth');
const { routes, HttpError } = require('./routes');
const realtime = require('./realtime');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; frame-ancestors 'none'",
};

/* ---- compile route table ---- */
const compiled = routes.map((r) => {
  const keys = [];
  const source = r.pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'));
  return { ...r, keys, regex: new RegExp(`^${source}$`) };
});

/* ---- tiny in-memory rate limit for auth endpoints ---- */
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 30;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...SECURITY_HEADERS });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const matches = compiled.filter((r) => r.regex.test(url.pathname));
  if (!matches.length) throw new HttpError(404, 'Not found');
  const route = matches.find((r) => r.method === req.method);
  if (!route) throw new HttpError(405, 'Method not allowed');

  if (!route.auth && limited(req.socket.remoteAddress)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');

  const ctx = { params: {}, body: {}, user: null, status: 200 };
  const m = url.pathname.match(route.regex);
  route.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));

  if (route.auth) {
    const header = req.headers.authorization || '';
    const uid = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    ctx.user = uid && db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!ctx.user) throw new HttpError(401, 'Sign in to continue');
  }
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) ctx.body = await readJson(req);

  const data = await route.handler(ctx);
  sendJson(res, ctx.status, data);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(PUBLIC_DIR, pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');

  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong on our side' });
  }
});

realtime.attach(server);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Lane is running at http://localhost:${PORT}`));
}
module.exports = { server };
