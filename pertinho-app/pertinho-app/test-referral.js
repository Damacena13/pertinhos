'use strict';
// Testes da indicação automática: código, cadastro com convite, prêmio só após a primeira foto, travas contra fraude.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-ref-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', REFERRAL_REQUIRE_VERIFIED: '0', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
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
    const A = new Client(), ADM = new Client();
    const signup = async (email, name, ref) => { const c = new Client(); const r = await c.post('/api/auth/register', reg(email, name, ref ? { ref } : {})); return { c, r }; };
    let code;
    await t('quem se cadastra já tem um código de indicação e um link', async () => {
      assert.strictEqual((await A.post('/api/auth/register', reg('ana@teste.com', 'Ana'))).status, 201);
      const r = await A.get('/api/me/referral');
      assert.strictEqual(r.status, 200); code = r.data.code;
      assert.ok(/^[A-Z0-9]{8}$/.test(code)); assert.ok(r.data.link.endsWith('/?ref=' + code));
      assert.strictEqual(r.data.rewarded, 0);
    });
    await t('rota exige login', async () => { assert.strictEqual((await new Client().get('/api/me/referral')).status, 401); });
    let B;
    await t('cadastro com convite fica pendente e NÃO dá prêmio sozinho', async () => {
      const s = await signup('bia@teste.com', 'Bia', code.toLowerCase());
      assert.strictEqual(s.r.status, 201); assert.strictEqual(s.r.data.referral, 'pending'); B = s.c;
      assert.strictEqual(s.r.data.user.plan, 'free');
      assert.strictEqual((await A.get('/api/me/referral')).data.pending, 1);
      assert.strictEqual((await A.get('/api/me/referral')).data.rewarded, 0);
    });
    await t('primeira foto ativa: indicado ganha 3 dias de Plus e quem indicou ganha Destaque', async () => {
      const r = await B.post('/api/me/photos', photo());
      assert.strictEqual(r.status, 201); assert.strictEqual(r.data.referral, 'rewarded');
      assert.strictEqual(r.data.user.plan, 'plus');
      const days = (r.data.user.planUntil - Date.now()) / DAY; assert.ok(days > 2.9 && days <= 3.01, 'dias ' + days);
      const row = one("SELECT plan, renewal_off, promo FROM users WHERE email = 'bia@teste.com'");
      assert.strictEqual(row.renewal_off, 1); assert.strictEqual(row.promo, 1);
      const a = one("SELECT boost_until FROM users WHERE email = 'ana@teste.com'"); assert.ok(a.boost_until > Date.now());
      const s = (await A.get('/api/me/referral')).data; assert.strictEqual(s.rewarded, 1); assert.strictEqual(s.pending, 0);
      assert.strictEqual(s.items[0].name, 'Bia'); assert.strictEqual(s.items[0].status, 'rewarded');
    });
    await t('é idempotente: outra foto não paga duas vezes', async () => {
      const before = one("SELECT plan_until FROM users WHERE email = 'bia@teste.com'").plan_until;
      assert.strictEqual((await B.post('/api/me/photos', photo())).data.referral, null);
      assert.strictEqual(one("SELECT plan_until FROM users WHERE email = 'bia@teste.com'").plan_until, before);
      assert.strictEqual((await A.get('/api/me/referral')).data.rewarded, 1);
    });
    await t('código inválido nunca impede o cadastro e não gera indicação', async () => {
      for (const bad of ['ZZZZZZZZ', '<script>', 'abc', '']) {
        const s = await signup(`x${Math.random().toString(36).slice(2, 7)}@teste.com`, 'Xis', bad);
        assert.strictEqual(s.r.status, 201, JSON.stringify(s.r.data)); assert.strictEqual(s.r.data.referral, null);
      }
    });
    await t('mesma rede: a 3ª indicação do mesmo IP é recusada e não paga nada', async () => {
      const s2 = await signup('c2@teste.com', 'Cec', code); await s2.c.post('/api/me/photos', photo());   // 2º prêmio (mesmo IP)
      assert.strictEqual((await A.get('/api/me/referral')).data.rewarded, 2);
      const s3 = await signup('c3@teste.com', 'Dan', code);
      const r = await s3.c.post('/api/me/photos', photo());
      assert.strictEqual(r.data.referral, 'rejected'); assert.strictEqual(r.data.user.plan, 'free');
      assert.strictEqual(one("SELECT reason FROM referrals WHERE invitee_id = (SELECT id FROM users WHERE email='c3@teste.com')").reason, 'same_network');
      assert.strictEqual((await A.get('/api/me/referral')).data.rewarded, 2);
    });
    await t('a cada 3 prêmios quem indicou ganha 7 dias de Plus', async () => {
      const s4 = await signup('c4@teste.com', 'Eva', code);
      run("UPDATE referrals SET net_hash = 'outra-rede' WHERE invitee_id = (SELECT id FROM users WHERE email='c4@teste.com')");
      const r = await s4.c.post('/api/me/photos', photo()); assert.strictEqual(r.data.referral, 'rewarded');
      const a = (await A.get('/api/me/referral')).data; assert.strictEqual(a.rewarded, 3);
      const u = one("SELECT plan, plan_until FROM users WHERE email = 'ana@teste.com'");
      assert.strictEqual(u.plan, 'plus'); const days = (u.plan_until - Date.now()) / DAY; assert.ok(days > 6.9 && days < 7.1, 'dias ' + days);
    });
    await t('quem já paga tem o plano estendido, sem virar promocional', async () => {
      run("UPDATE users SET plan = 'plus', plan_until = ?, renewal_off = 0, promo = 0 WHERE email = 'ana@teste.com'", Date.now() + 10 * DAY);
      const s5 = await signup('c5@teste.com', 'Fê', code);
      run("UPDATE referrals SET net_hash = 'rede-5' WHERE invitee_id = (SELECT id FROM users WHERE email='c5@teste.com')");
      await s5.c.post('/api/me/photos', photo());
      const u = one("SELECT plan, plan_until, renewal_off, promo FROM users WHERE email = 'ana@teste.com'");
      assert.strictEqual(u.renewal_off, 0); assert.strictEqual(u.promo, 0); assert.strictEqual(u.plan, 'plus');
    });
    await t('indicador suspenso não paga', async () => {
      const s6 = await signup('c6@teste.com', 'Gil', code);
      run("UPDATE users SET status = 'suspended' WHERE email = 'ana@teste.com'");
      const r = await s6.c.post('/api/me/photos', photo());
      assert.strictEqual(r.data.referral, 'rejected'); assert.strictEqual(r.data.user.plan, 'free');
      run("UPDATE users SET status = 'active' WHERE email = 'ana@teste.com'");
    });
    await t('admin vê as indicações e o plano promocional não entra na receita', async () => {
      assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const r = await ADM.get('/api/admin/referrals'); assert.strictEqual(r.status, 200);
      assert.ok(r.data.totals.rewarded >= 4 && r.data.totals.rejected >= 2);
      assert.ok(r.data.items.every((i) => !('referrer_email' in i) || typeof i.referrer_email === 'string'));
      run("UPDATE users SET plan = 'plus', plan_until = ?, promo = 0 WHERE email = 'bia@teste.com'", Date.now() + DAY);
      const m0 = (await ADM.get('/api/admin/stats')).data.mrrCents ?? (await ADM.get('/api/admin/stats')).data.mrr;
      run("UPDATE users SET promo = 1 WHERE email = 'bia@teste.com'");
      const m1 = (await ADM.get('/api/admin/stats')).data.mrrCents ?? (await ADM.get('/api/admin/stats')).data.mrr;
      assert.ok(m0 > m1, `receita deveria cair ao marcar como promocional (${m0} -> ${m1})`);
    });
    await t('usuário comum não acessa a lista do admin', async () => { assert.strictEqual((await A.get('/api/admin/referrals')).status, 403); });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  await stopChild(srv);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
