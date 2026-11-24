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
