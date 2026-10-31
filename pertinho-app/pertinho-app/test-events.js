'use strict';
// Testes dos encontros em grupo.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-ev-'));
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
const { nextCpf, stopChild } = require('./test-util');
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
    const mk = async (email, name, withPhoto = true) => { const c = new Client(); assert.strictEqual((await c.post('/api/auth/register', reg(email, name))).status, 201); if (withPhoto) await c.post('/api/me/photos', photo()); return c; };
    const A = await mk('ana@teste.com', 'Ana Silva'), B = await mk('bia@teste.com', 'Bia Souza'), C = await mk('cris@teste.com', 'Cris Lima'), N = await mk('nofoto@teste.com', 'Sem Foto', false);
    const when = Date.now() + 2 * DAY;
    const body = (o = {}) => ({ title: 'Café da tarde', placeType: 'Café', placeName: 'Café Central, Rua 1', capacity: 4, startsAt: when, description: 'Papo leve', ...o });
    let ev;
    await t('exige login', async () => { assert.strictEqual((await new Client().get('/api/events')).status, 401); });
    await t('cria encontro e o organizador já participa', async () => {
      const r = await A.post('/api/events', body()); assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      ev = r.data.event; assert.strictEqual(ev.going, 1); assert.strictEqual(ev.placeName, 'Café Central, Rua 1'); assert.ok(ev.mine);
    });
    await t('regras de criação (foto, antecedência, local, tamanho, limite)', async () => {
      assert.strictEqual((await N.post('/api/events', body())).status, 400);
      assert.strictEqual((await A.post('/api/events', body({ startsAt: Date.now() + 3600000 }))).status, 400);
      assert.strictEqual((await A.post('/api/events', body({ startsAt: Date.now() + 20 * DAY }))).status, 400);
      assert.strictEqual((await A.post('/api/events', body({ placeType: 'Motel' }))).status, 400);
      assert.strictEqual((await A.post('/api/events', body({ capacity: 2 }))).status, 400);
      assert.strictEqual((await A.post('/api/events', body())).status, 201);
      assert.strictEqual((await A.post('/api/events', body())).status, 400, 'terceiro encontro aberto deve ser barrado');
    });
    await t('lista mostra o encontro SEM o local exato para quem não confirmou', async () => {
      const r = await B.get('/api/events'); const e = r.data.items.find((x) => x.id === ev.id);
      assert.ok(e); assert.strictEqual(e.placeName, undefined); assert.strictEqual(e.joined, false); assert.strictEqual(e.hostName, 'Ana');
      assert.ok(!JSON.stringify(r.data).includes('Café Central'));
      const d = await B.get('/api/events/' + ev.id); assert.strictEqual(d.data.event.messages, undefined);
    });
    await t('prévia de compartilhamento: metadados sem dados pessoais e sem o local exato', async () => {
      const r = await new Client().get('/e/' + ev.id); const h = r.data.toString();
      assert.strictEqual(r.status, 200); assert.ok(h.includes('og:title') && h.includes('Café da tarde') && h.includes(`/?evento=${ev.id}`));
      assert.ok(!h.includes('Café Central') && !h.includes('Ana') && !h.includes('teste.com'));
      assert.ok((await new Client().get('/e/99999')).data.toString().includes('og:title'));
      const home = (await new Client().get('/')).data.toString(); assert.ok(/og:image" content="http:\/\/127\.0\.0\.1:3991\/og\.png/.test(home), 'og:image deve ser absoluto');
      const m = await new Client().get('/manifest.webmanifest'); assert.strictEqual(m.status, 200);
    });
    await t('participar libera local, membros e chat; sai e perde acesso', async () => {
      const j = await B.post(`/api/events/${ev.id}/join`); assert.strictEqual(j.status, 200); assert.strictEqual(j.data.event.placeName, 'Café Central, Rua 1');
      assert.strictEqual((await B.post(`/api/events/${ev.id}/messages`, { body: 'Oi pessoal!' })).status, 201);
      const d = await B.get('/api/events/' + ev.id); assert.strictEqual(d.data.event.messages.length, 1); assert.deepStrictEqual(d.data.event.members.map((m) => m.name), ['Ana', 'Bia']);
      assert.strictEqual((await C.post(`/api/events/${ev.id}/messages`, { body: 'intruso' })).status, 404);
      assert.strictEqual((await B.post(`/api/events/${ev.id}/leave`)).status, 200);
      assert.strictEqual((await B.get('/api/events/' + ev.id)).data.event.placeName, undefined);
      await B.post(`/api/events/${ev.id}/join`);
    });
    await t('sem foto não participa; lotado fecha; organizador não sai', async () => {
      assert.strictEqual((await N.post(`/api/events/${ev.id}/join`)).status, 400);
      assert.strictEqual((await C.post(`/api/events/${ev.id}/join`)).status, 200);
      const D = await mk('dani@teste.com', 'Dani'), E = await mk('edu@teste.com', 'Edu');
      assert.strictEqual((await D.post(`/api/events/${ev.id}/join`)).status, 200);
      const r = await E.post(`/api/events/${ev.id}/join`); assert.strictEqual(r.status, 400); assert.ok(/completo/.test(r.data.error));
      assert.strictEqual((await A.post(`/api/events/${ev.id}/leave`)).status, 400);
    });
    await t('bloqueio esconde o encontro e impede a entrada', async () => {
      const F = await mk('fabio@teste.com', 'Fabio');
      const uid = one("SELECT id FROM users WHERE email = 'fabio@teste.com'").id;
      const aid = one("SELECT id FROM users WHERE email = 'ana@teste.com'").id;
      run('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)', uid, aid, Date.now());
      assert.strictEqual((await F.get('/api/events/' + ev.id)).status, 404);
      assert.strictEqual((await F.post(`/api/events/${ev.id}/join`)).status, 404);
    });
    await t('só o organizador cancela; admin lista e cancela', async () => {
      assert.strictEqual((await B.post(`/api/events/${ev.id}/cancel`)).status, 404);
      assert.strictEqual((await A.get('/api/admin/events')).status, 403);
      const ADM = new Client(); await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' });
      const l = await ADM.get('/api/admin/events'); assert.ok(l.data.items.length >= 2);
      assert.strictEqual((await ADM.post(`/api/admin/events/${ev.id}/cancel`)).status, 200);
      assert.ok(!(await B.get('/api/events')).data.items.some((x) => x.id === ev.id));
      const x = (await A.get('/api/events')).data.items.find((i) => i.mine); assert.strictEqual((await A.post(`/api/events/${x.id}/cancel`)).status, 200);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  await stopChild(srv);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
