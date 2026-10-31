'use strict';
// Endurecimento: bots, limites por usuário, hotlink, bloqueio de tentativas, administrador por IP.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3982;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-sec-'));
const env = { ...process.env, ADMIN_ALLOWED_IPS: '10.9.9.9', SCRAPE_LIMIT: '3', PHOTO_LIMIT: '4', PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
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
    const A = new Client(); const reg1 = await A.post('/api/auth/register', reg('ana@teste.com', 'Ana')); assert.strictEqual(reg1.status, 201);
    const pr = await A.post('/api/me/photos', photo()); const pid = pr.data.user.photos[0].id;
    await t('cabeçalhos: Permissions-Policy, CSP, HSTS-compatível e dados pessoais sem cache', async () => {
      const r = await A.get('/api/me'); assert.ok(/geolocation=\(self\)/.test(r.headers.get('permissions-policy'))); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
      assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'")); assert.strictEqual(r.headers.get('x-powered-by'), null);
    });
    await t('ferramentas de raspagem conhecidas são barradas na API', async () => {
      for (const ua of ['curl/8.0', 'python-requests/2.31', 'Scrapy/2.11', 'Go-http-client/1.1', '']) {
        const res = await fetch(BASE + '/api/plans', { headers: { 'user-agent': ua } }); assert.strictEqual(res.status, 403, 'UA: ' + ua);
      }
      assert.strictEqual((await fetch(BASE + '/api/plans', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux) Chrome/120' } })).status, 200);
    });
    await t('foto: hotlink de outro site é recusado e há limite por usuário', async () => {
      const get = (h) => fetch(BASE + '/api/photos/' + pid, { headers: { cookie: A.cookie, ...h } });
      assert.strictEqual((await get({ 'sec-fetch-site': 'cross-site' })).status, 403);
      for (let i = 0; i < 3; i++) assert.strictEqual((await get({ 'sec-fetch-site': 'same-origin' })).status, 200);
      assert.strictEqual((await get({})).status, 429);
    });
    await t('descoberta tem limite por usuário contra raspagem', async () => {
      const codes = []; for (let i = 0; i < 5; i++) codes.push((await A.get('/api/discover?radius=10')).status);
      assert.ok(codes.includes(429), codes.join(','));
    });
    await t('6 senhas erradas bloqueiam por alguns minutos (mesmo com a senha certa)', async () => {
      const B = new Client(); await B.post('/api/auth/register', reg('bia@teste.com', 'Bia')); const C = new Client();
      for (let i = 0; i < 6; i++) assert.strictEqual((await C.post('/api/auth/login', { email: 'bia@teste.com', password: 'errada-' + i })).status, 401);
      assert.strictEqual((await C.post('/api/auth/login', { email: 'bia@teste.com', password: 'senha-forte-123' })).status, 429);
    });
    await t('administrador só entra pelos IPs permitidos', async () => {
      const ADM = new Client();
      assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 401);
      assert.ok([403, 404].includes((await ADM.get('/api/admin/stats')).status));
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
