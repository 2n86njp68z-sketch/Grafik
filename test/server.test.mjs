import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { validSymbol } from '../lib/yahoo.js';

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('ana sayfa ve katalog sunulur', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Grafik/);
  const c = await (await fetch(base + '/data/catalog.json')).json();
  assert.ok(c.items.length > 1000);
  const syms = new Set(c.items.map((i) => i.s));
  for (const s of ['XU100.IS', 'THYAO.IS', '^GSPC', 'GC=F', 'SI=F', 'GRAMALTIN', 'AAPL', 'TRY=X']) assert.ok(syms.has(s), s);
});

test('dizin dışına çıkma (path traversal) engellenir', async () => {
  const r = await fetch(base + '/..%2fpackage.json');
  assert.ok(r.status === 403 || r.status === 404);
});

test('geçersiz sembol 400 döner', async () => {
  const r = await fetch(base + '/api/daily?symbol=' + encodeURIComponent('AAPL;rm -rf'));
  assert.equal(r.status, 400);
  assert.equal(validSymbol('XU100.IS'), true);
  assert.equal(validSymbol('^GSPC'), true);
  assert.equal(validSymbol('GC=F'), true);
  assert.equal(validSymbol('../x'), false);
});

test('bilinmeyen API yolu 404', async () => {
  const r = await fetch(base + '/api/yok');
  assert.equal(r.status, 404);
});

test('telefon erişimi: LAN adresleri sıralanır, sanal/yerel arayüzler geride kalır', async () => {
  const { lanAddresses } = await import('../server.js');
  const ips = lanAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    eth9: [{ family: 4, address: '169.254.10.10', internal: false }],
  });
  assert.equal(ips[0], '192.168.1.23');
  assert.ok(!ips.includes('127.0.0.1'));
  assert.ok(!ips.includes('169.254.10.10'));
});

test('/api/info: LAN modu kapalıyken adres vermez', async () => {
  const info = await (await fetch(base + '/api/info')).json();
  assert.deepEqual(info, { lan: false, urls: [] });
  const lanServer = createServer({ lan: true });
  await new Promise((r) => lanServer.listen(0, '127.0.0.1', r));
  const port = lanServer.address().port;
  const info2 = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
  assert.equal(info2.lan, true);
  for (const u of info2.urls) assert.match(u, new RegExp(`^http://[\\d.]+:${port}/$`));
  await new Promise((r) => lanServer.close(r));
});
