#!/usr/bin/env node
// Grafik — yerel web sunucusu.
//   node server.js               -> http://localhost:3000 (yalnızca bu bilgisayar)
//   node server.js --open        -> tarayıcıyı da açar
//   node server.js --lan         -> aynı Wi-Fi'daki telefon/tabletlerden de erişilebilir
// Ortam değişkenleri: PORT (varsayılan 3000), HOST (varsayılan 127.0.0.1, --lan ile 0.0.0.0)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDaily, getIntraday, search, validSymbol, YahooError } from './lib/yahoo.js';

if (typeof fetch !== 'function') {
  console.error('Bu uygulama Node.js 18 veya üstü gerektirir. https://nodejs.org adresinden güncel sürümü kurun.');
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'X-Content-Type-Options': 'nosniff', ...headers };
  const type = h['Content-Type'] || '';
  if (buf.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|svg/.test(type)) {
    buf = zlib.gzipSync(buf, { level: 6 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, obj, maxAge = 0) {
  send(req, res, status, JSON.stringify(obj), {
    'Content-Type': MIME['.json'],
    'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'no-store',
  });
}

/** Telefonun bağlanabileceği yerel ağ (LAN) IPv4 adresleri, en olası olan başta. */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const virtual = /vmware|virtualbox|vbox|docker|veth|^br-|vethernet|hyper-v|wsl|tailscale|zerotier|utun|^tun|^tap|loopback/i;
  const rank = (ip, name) =>
    (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3) +
    (virtual.test(name) ? 10 : 0);
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, r: rank(a.address, name) });
    }
  }
  return [...new Set(out.sort((a, b) => a.r - b.r).map((x) => x.ip))];
}

async function handleApi(req, res, url, opts) {
  const route = url.pathname;
  try {
    if (route === '/api/info') {
      const port = req.socket.localPort;
      const urls = opts.lan ? lanAddresses().map((ip) => `http://${ip}:${port}/`) : [];
      return sendJson(req, res, 200, { lan: !!opts.lan, urls });
    }
    if (route === '/api/daily' || route === '/api/intraday') {
      const symbol = url.searchParams.get('symbol');
      if (!validSymbol(symbol)) return sendJson(req, res, 400, { error: 'Geçersiz sembol' });
      if (route === '/api/daily') return sendJson(req, res, 200, await getDaily(symbol), 60);
      const range = url.searchParams.get('range');
      return sendJson(req, res, 200, await getIntraday(symbol, range), 30);
    }
    if (route === '/api/search') {
      return sendJson(req, res, 200, await search(url.searchParams.get('q')), 600);
    }
    return sendJson(req, res, 404, { error: 'Bulunamadı' });
  } catch (e) {
    const status = e instanceof YahooError ? e.status : 500;
    if (status >= 500) console.warn(`[api] ${route} ${url.search}:`, e.message);
    return sendJson(req, res, status, { error: e.message || 'Sunucu hatası' });
  }
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(req, res, 400, 'Bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, 'Bulunamadı', { 'Content-Type': MIME['.txt'] });
    const ext = path.extname(file).toLowerCase();
    send(req, res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
  });
}

export function createServer(opts = {}) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url, opts);
    return serveStatic(req, res, url);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* tarayıcı açılamazsa sorun değil */ }
}

function start() {
  const lan = process.argv.includes('--lan') || process.env.HOST === '0.0.0.0';
  const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
  const basePort = Number(process.env.PORT) || 3000;
  const wantOpen = process.argv.includes('--open');
  const server = createServer({ lan: lan && (host === '0.0.0.0' || host === '::') });
  let port = basePort;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < basePort + 20) {
      port++;
      server.listen(port, host);
    } else {
      console.error('Sunucu başlatılamadı:', e.message);
      process.exit(1);
    }
  });
  server.on('listening', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  Grafik çalışıyor  ->  ' + url);
    if (lan) {
      const ips = lanAddresses();
      if (ips.length) {
        console.log('');
        console.log('  Telefondan açmak için (aynı Wi-Fi):  http://' + ips[0] + ':' + port);
        console.log('  ya da uygulamadaki telefon simgesine tıklayıp QR kodu okutun.');
      }
    }
    console.log('');
    console.log('  Bu pencere açık kaldığı sürece uygulama çalışır. Kapatmak için Ctrl+C.');
    console.log('');
    if (wantOpen) openBrowser(url);
  });
  server.listen(port, host);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
