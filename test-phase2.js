'use strict';
// Fase 2: privacidade da localização, trava de pagamento de teste, provas de denúncia e CPF de conta apagada.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-p2-'));
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
    const L = require('./lib');
    await t('modo de pagamento de teste é recusado em produção', async () => {
      const r = spawnSync('node', ['server.js'], { env: { ...env, NODE_ENV: 'production', PAYMENTS_MODE: 'demo', PORT: '3992', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-p2b-')) }, encoding: 'utf8', timeout: 15000 });
      assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /não pode rodar em produção/);
    });
    await t('distância borrada: erro de até 1,5 km, estável para o mesmo lugar e variável entre lugares', async () => {
      const me = { id: 1, lat: -20.8, lng: -49.38 }, other = { id: 2, lat: -20.85, lng: -49.38 };
      const real = L.haversine(me.lat, me.lng, other.lat, other.lng);
      assert.strictEqual(L.fuzzyDistance(me, other), L.fuzzyDistance(me, other));
      const seen = new Set();
      for (let i = 0; i < 40; i++) {
        const m = { ...me, lat: me.lat + i * 0.02, lng: me.lng }; const o = { ...other, lat: m.lat - 0.05 };
        const r = L.haversine(m.lat, m.lng, o.lat, o.lng), f = L.fuzzyDistance(m, o);
        assert.ok(Math.abs(f - r) <= 1.5 + 1e-9, 'erro maior que 1,5 km'); seen.add((f - r).toFixed(2));
      }
      assert.ok(seen.size > 15, 'o erro precisa variar entre lugares: ' + seen.size); assert.ok(real > 5);
    });
    const A = new Client(); const B = new Client();
    const ra = await A.post('/api/auth/register', reg('a@teste.com', 'Ana')); assert.strictEqual(ra.status, 201, JSON.stringify(ra.data));
    const cpfB = nextCpf();
    const rb = await B.post('/api/auth/register', reg('b@teste.com', 'Beto', { cpf: cpfB, gender: 'm' })); assert.strictEqual(rb.status, 201, JSON.stringify(rb.data));
    const idA = ra.data.user.id, idB = rb.data.user.id;
    await t('trocar de localização tem limite por dia e recusa saltos impossíveis', async () => {
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'sao-paulo-sp' })).status, 200);
      const far = await A.post('/api/me/location', { cityId: 'manaus-am' }); assert.strictEqual(far.status, 429, JSON.stringify(far.data));
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'campinas-sp' })).status, 200);
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'santos-sp' })).status, 200);
      const cap = await A.post('/api/me/location', { cityId: 'sao-paulo-sp' }); assert.strictEqual(cap.status, 429); assert.match(cap.data.error || '', /3 vezes/);
      run('DELETE FROM loc_changes WHERE user_id = ?', idA);
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'sao-paulo-sp' })).status, 200);
    });
    await t('denúncia guarda a conversa mesmo com bloqueio, e o painel ADM mostra', async () => {
      const a = Math.min(idA, idB), b = Math.max(idA, idB);
      const mid = Number(run('INSERT INTO matches (a_id, b_id, created_at) VALUES (?,?,?)', a, b, Date.now()).lastInsertRowid);
      run('INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?,?,?,?)', mid, idB, 'me manda um pix urgente', Date.now());
      const r = await A.post(`/api/users/${idB}/report`, { reason: 'Golpe ou pedido de dinheiro', block: true }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      assert.strictEqual(one('SELECT COUNT(*) c FROM matches WHERE id = ?', mid).c, 0, 'o bloqueio apaga a conversa');
      const ADM = new Client(); assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const rep = (await ADM.get('/api/admin/reports')).data.reports[0];
      assert.strictEqual(rep.evidence.length, 1); assert.strictEqual(rep.evidence[0].body, 'me manda um pix urgente'); assert.strictEqual(rep.evidence[0].from, 'denunciado');
    });
    await t('quem apaga a conta com denúncia aberta não consegue se cadastrar de novo com o mesmo CPF', async () => {
      const d = await B.req('DELETE', '/api/me', { password: 'senha-forte-123' }); assert.strictEqual(d.status, 200, JSON.stringify(d.data));
      const again = await new Client().post('/api/auth/register', reg('b2@teste.com', 'Beto2', { cpf: cpfB, gender: 'm' }));
      assert.strictEqual(again.status, 403, JSON.stringify(again.data)); assert.match(again.data.error || '', /não pode criar/);
    });
    await t('quem apaga a conta sem pendência pode voltar depois', async () => {
      const C = new Client(); const cpfC = nextCpf();
      assert.strictEqual((await C.post('/api/auth/register', reg('c@teste.com', 'Caio', { cpf: cpfC, gender: 'm' }))).status, 201);
      assert.strictEqual((await C.req('DELETE', '/api/me', { password: 'senha-forte-123' })).status, 200);
      assert.strictEqual((await new Client().post('/api/auth/register', reg('c2@teste.com', 'Caio', { cpf: cpfC, gender: 'm' }))).status, 201);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
