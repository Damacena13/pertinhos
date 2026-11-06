'use strict';
// Passe 24h (pedido de conversa antes do match) e pacotes de Destaque e fotos.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3990;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-dm-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', FREE_CHAT_MESSAGES: '', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
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
    const mk = async (email, name, g = 'f') => { const c = new Client(); const r = await c.post('/api/auth/register', reg(email, name, { gender: g })); assert.strictEqual(r.status, 201); await c.post('/api/me/photos', photo()); return { c, id: r.data.user.id }; };
    const A = await mk('ana@teste.com', 'Ana'), B = await mk('bob@teste.com', 'Bob', 'm'), C = await mk('caio@teste.com', 'Caio', 'm');
    let mid;
    await t('sem Passe não manda mensagem antes do match', async () => {
      const r = await A.c.post(`/api/users/${B.id}/direct`, { body: 'Oi!' }); assert.strictEqual(r.status, 402); assert.strictEqual(r.data.code, 'need_pass');
    });
    await t('Passe 24h custa R$ 6,90 e libera o pedido de conversa', async () => {
      assert.strictEqual((await A.c.get('/api/plans')).data.shop.find((x) => x.id === 'pass24h').priceCents, 690);
      assert.strictEqual((await A.c.post('/api/billing/checkout', { item: 'pass24h' })).status, 200);
      const r = await A.c.post(`/api/users/${B.id}/direct`, { body: 'Oi, vi seu perfil!' }); assert.strictEqual(r.status, 201); mid = r.data.matchId;
      assert.strictEqual((await A.c.post(`/api/users/${B.id}/direct`, { body: 'de novo' })).data.existing, true);
    });
    await t('quem recebe vê o pedido; quem enviou só manda UMA mensagem até a resposta', async () => {
      const lb = (await B.c.get('/api/matches')).data.matches.find((m) => m.id === mid); assert.strictEqual(lb.request, 'received');
      assert.strictEqual((await A.c.get('/api/matches')).data.matches.find((m) => m.id === mid).request, 'sent');
      const w = await A.c.post(`/api/matches/${mid}/messages`, { body: 'ei?' }); assert.strictEqual(w.status, 409); assert.strictEqual(w.data.code, 'direct_wait');
    });
    await t('responder aceita o pedido e a conversa vira normal', async () => {
      assert.strictEqual((await B.c.post(`/api/matches/${mid}/messages`, { body: 'Oi Ana!' })).status, 201);
      assert.strictEqual((await B.c.get('/api/matches')).data.matches.find((m) => m.id === mid).request, null);
      assert.strictEqual((await A.c.post(`/api/matches/${mid}/messages`, { body: 'Que bom!' })).status, 201);
    });
    await t('recusar apaga o pedido e impede nova tentativa do mesmo perfil', async () => {
      const r = await A.c.post(`/api/users/${C.id}/direct`, { body: 'Olá' }); assert.strictEqual(r.status, 201);
      assert.strictEqual((await A.c.post(`/api/matches/${r.data.matchId}/decline`)).status, 400, 'quem enviou não pode recusar o próprio pedido');
      assert.strictEqual((await C.c.post(`/api/matches/${r.data.matchId}/decline`)).status, 200);
      assert.ok(!(await A.c.get('/api/matches')).data.matches.some((m) => m.id === r.data.matchId));
      assert.strictEqual((await A.c.post(`/api/users/${C.id}/direct`, { body: 'Olá de novo' })).status, 400);
    });
    await t('bloqueio, perfil inexistente e usar em si mesmo são barrados', async () => {
      const D = await mk('dani@teste.com', 'Dani');
      await B.c.post(`/api/users/${D.id}/block`);
      assert.strictEqual((await D.c.post('/api/billing/checkout', { item: 'pass24h' })).status, 200);
      assert.strictEqual((await D.c.post(`/api/users/${B.id}/direct`, { body: 'oi' })).status, 404);
      assert.strictEqual((await D.c.post(`/api/users/${D.id}/direct`, { body: 'oi' })).status, 400);
      assert.strictEqual((await D.c.post('/api/users/999999/direct', { body: 'oi' })).status, 404);
    });
    await t('curtida recíproca também aceita um pedido pendente', async () => {
      const E = await mk('edu@teste.com', 'Edu', 'm'), F = await mk('fa@teste.com', 'Fa');
      await F.c.post('/api/billing/checkout', { item: 'pass24h' });
      const r = await F.c.post(`/api/users/${E.id}/direct`, { body: 'Oi' }); assert.strictEqual(r.status, 201);
      await F.c.post('/api/swipe', { userId: E.id, kind: 'like' });
      const s = await E.c.post('/api/swipe', { userId: F.id, kind: 'like' }); assert.strictEqual(s.data.match, true);
      assert.strictEqual((await E.c.get('/api/matches')).data.matches.find((m) => m.id === r.data.matchId).request, null);
    });
    await t('pacotes: 3 Destaques somam 90 min; 10 fotos somam 10 créditos; estorno não é testado aqui', async () => {
      const G = await mk('gui@teste.com', 'Gui', 'm');
      const b = await G.c.post('/api/billing/checkout', { item: 'boost90m' }); assert.strictEqual(b.status, 200);
      assert.ok(Math.abs(b.data.user.boostUntil - (Date.now() + 90 * 60000)) < 60000);
      const p = await G.c.post('/api/billing/checkout', { item: 'photos10' }); assert.strictEqual(p.data.user.photoCredits, 10);
      const sh = (await G.c.get('/api/plans')).data.shop; assert.strictEqual(sh.find((x) => x.id === 'boost90m').priceCents, 2490); assert.strictEqual(sh.find((x) => x.id === 'photos10').priceCents, 1990);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
