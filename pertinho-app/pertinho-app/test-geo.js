'use strict';
// Todos os estados e municípios e o radar do Brasil.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3983;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-geo-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET') headers['x-pertinho'] = '1';
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  patch(u, b) { return this.req('PATCH', u, b); }
}
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FALHOU ' + name + '\n         ' + String(e.message || e).split('\n')[0]); }
}
const { nextCpf } = require('./test-util');
const L = require('./lib');
const { CITIES } = require('./cities');
const reg = (email, name, extra = {}) => ({ cpf: nextCpf(), email, password: 'senha-forte-123', name, birthDate: '1994-04-10', gender: 'f', seeking: 'all', cityId: 'sao-jose-do-rio-preto-sp', bio: 'Teste', terms: true, interests: ['Café', 'Trilhas'], ...extra });
const photo = (field = 'photo') => { const f = new FormData(); f.append(field, new Blob([PNG], { type: 'image/png' }), 'x.png'); return f; };
const dbq = () => new DatabaseSync(path.join(DATA_DIR, 'pertinho.db'));
const one = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
const run = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };

(async () => {
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const login = async (c, email) => assert.strictEqual((await c.post('/api/auth/login', { email, password: 'senha-forte-123' })).status, 200);
    const A = new Client(); const cities = (await A.get('/api/cities')).data;
    await t('lista traz os 27 estados e mais de 5.500 municípios, ids únicos', async () => {
      assert.strictEqual(Object.keys(cities.ufs).length, 27); assert.ok(cities.cities.length >= 5500);
      assert.strictEqual(new Set(cities.cities.map((c) => c[0])).size, cities.cities.length);
      for (const id of ['ourinhos-sp', 'sao-jose-do-rio-preto-sp', 'manaus-am', 'rio-branco-ac', 'boa-vista-rr', 'macapa-ap', 'brasilia-df', 'palmas-to']) assert.ok(cities.cities.some((c) => c[0] === id), id);
    });
    await t('grade GPS desloca menos de 500 m em todas as cidades e não revela coordenadas da conta', async () => {
      for (const city of CITIES) {
        assert.ok(L.haversine(city.lat, city.lng, L.snap(city.lat), L.snap(city.lng)) < 0.5, city.id);
      }
      const r = await A.post('/api/auth/register', reg('mask@teste.com', 'Mask', { cityId: 'ourinhos-sp' }));
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      const user = r.data.user;
      assert.strictEqual(user.cityId, 'ourinhos-sp');
      assert.ok(!Object.hasOwn(user, 'lat') && !Object.hasOwn(user, 'lng'));
      const gps = { lat: -22.9797, lng: -49.8697 };
      const updated = await A.post('/api/me/location', gps);
      assert.strictEqual(updated.status, 200);
      assert.ok(!Object.hasOwn(updated.data.user, 'lat') && !Object.hasOwn(updated.data.user, 'lng'));
      const stored = one('SELECT lat, lng FROM users WHERE id = ?', user.id);
      assert.strictEqual(stored.lat, L.snap(gps.lat));
      assert.strictEqual(stored.lng, L.snap(gps.lng));
      assert.ok(L.haversine(gps.lat, gps.lng, stored.lat, stored.lng) < 0.5);
      assert.strictEqual((await A.post('/api/me/photos', photo())).status, 201);
      const B = new Client();
      const other = await B.post('/api/auth/register', reg('nearby@teste.com', 'Nearby', { cityId: 'ourinhos-sp' }));
      assert.strictEqual(other.status, 201, JSON.stringify(other.data));
      assert.strictEqual((await B.post('/api/me/photos', photo())).status, 201);
      const discover = await A.get('/api/discover');
      assert.strictEqual(discover.status, 200);
      const publicProfile = discover.data.profiles.find((p) => p.id === other.data.user.id);
      assert.ok(publicProfile, 'perfil próximo deve aparecer no mapa');
      assert.ok(!Object.hasOwn(publicProfile, 'lat') && !Object.hasOwn(publicProfile, 'lng'));
      assert.deepStrictEqual(Object.keys((await A.get('/api/discover/count')).data.rings[0]).sort(), ['count', 'km']);
    });
    await t('cadastra em cidade pequena de outro estado e o radar conta por estado e cidade', async () => {
      const tiny = cities.cities.find((c) => c[2] === 'RR' && c[0] !== 'boa-vista-rr');
      const r = await A.post('/api/auth/register', reg('ana@teste.com', 'Ana', { cityId: tiny[0] })); assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      assert.strictEqual(r.data.user.cityId, tiny[0]);
      const all = (await A.get('/api/radar')).data; assert.strictEqual(all.states.length, 27); assert.strictEqual(all.states.find((s) => s.uf === 'RR').n, 1);
      const rr = (await A.get('/api/radar?uf=rr')).data; assert.deepStrictEqual(rr.cities.map((c) => [c.id, c.n]), [[tiny[0], 1]]);
      assert.strictEqual((await A.get('/api/radar?uf=XX')).status, 400);
      assert.strictEqual((await new Client().get('/api/radar')).status, 401);
      assert.ok(!JSON.stringify(rr).includes('Ana'), 'radar só mostra números');
    });
    await t('trocar de cidade e usar o GPS achando a cidade mais próxima no país todo', async () => {
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'manaus-am' })).data.user.cityName, 'Manaus - AM');
      const g = (await A.post('/api/me/location', { lat: -3.1190, lng: -60.0217 })).data.user; assert.strictEqual(g.cityName, 'Manaus - AM');
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'nao-existe-xx' })).status, 400);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
