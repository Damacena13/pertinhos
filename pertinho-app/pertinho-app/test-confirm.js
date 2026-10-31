'use strict';
// Testes da confirmação de e-mail (Resend simulado): bloqueios até confirmar, link único, prêmio de indicação só depois.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3996;
const MAIL_PORT = 3997;
const http = require('http');
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-confirm-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', REFERRAL_REQUIRE_VERIFIED: '0', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300', RESEND_API_KEY: 'chave-teste', MAIL_FROM: 'Pertinho <nao-responda@teste.com>', RESEND_BASE_URL: `http://127.0.0.1:${MAIL_PORT}`, PUBLIC_URL: 'https://pertinho.teste' };
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
  const mails = [];
  const mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { mails.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"1"}'); }); }).listen(MAIL_PORT);
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  const tokenOf = (m) => (m.body.text.match(/\?confirm=([A-Za-z0-9_-]+)/) || [])[1];
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const A = new Client(), B = new Client(), ADM = new Client();
    const confirmLinkFor = async (email) => { for (let i = 0; i < 30; i++) { const m = [...mails].reverse().find((x) => x.body.to[0] === email && /\?confirm=/.test(x.body.text)); if (m) return tokenOf(m); await sleep(100); } return null; };
    let ana, tok;
    await t('cadastro manda o e-mail de confirmação e a conta nasce não confirmada', async () => {
      const r = await A.post('/api/auth/register', reg('ana@teste.com', 'Ana')); assert.strictEqual(r.status, 201);
      assert.strictEqual(r.data.user.emailConfirmed, false); ana = r.data.user;
      tok = await confirmLinkFor('ana@teste.com'); assert.ok(tok && tok.length >= 40);
      const m = mails.find((x) => x.body.to[0] === 'ana@teste.com'); assert.ok(m.body.text.includes('https://pertinho.teste/?confirm='));
      assert.strictEqual(one("SELECT COUNT(*) c FROM email_confirms WHERE token_hash = ?", tok).c, 0, 'o banco não pode guardar o token puro');
    });
    await t('sem confirmar: não curte, não conversa, não aparece para os outros', async () => {
      await A.post('/api/me/photos', photo());
      const bob = new Client(); assert.strictEqual((await bob.post('/api/auth/register', reg('bob@teste.com', 'Bob', { gender: 'm' }))).status, 201);
      await bob.post('/api/me/photos', photo()); run("UPDATE users SET email_verified_at = ? WHERE email = 'bob@teste.com'", Date.now());
      B.cookie = bob.cookie;
      const d = await B.get('/api/discover'); assert.strictEqual(d.status, 200);
      assert.ok(!JSON.stringify(d.data).includes('Ana'), 'Ana não deveria aparecer antes de confirmar');
      const sw = await A.post('/api/swipe', { toId: 99999, kind: 'like' }); assert.strictEqual(sw.status, 403); assert.strictEqual(sw.data.needsConfirm, true);
      const ms = await A.post('/api/matches/1/messages', { text: 'oi' }); assert.strictEqual(ms.status, 403);
    });
    await t('reenviar tem limite de 1 por minuto', async () => {
      const r = await A.post('/api/auth/resend-confirm'); assert.strictEqual(r.status, 429);
      run("UPDATE email_confirms SET created_at = created_at - 120000 WHERE user_id = ?", ana.id);
      const r2 = await A.post('/api/auth/resend-confirm'); assert.strictEqual(r2.status, 200);
      tok = null; for (let i = 0; i < 30 && !tok; i++) { const ms = mails.filter((x) => /\?confirm=/.test(x.body.text) && x.body.to[0] === 'ana@teste.com'); if (ms.length >= 2) tok = tokenOf(ms[ms.length - 1]); else await sleep(100); }
      assert.ok(tok, 'segundo e-mail não chegou');
    });
    await t('link errado é recusado; link certo confirma e só vale uma vez', async () => {
      assert.strictEqual((await new Client().post('/api/auth/confirm', { token: 'x'.repeat(40) })).status, 400);
      assert.strictEqual((await new Client().post('/api/auth/confirm', { token: tok })).status, 200);
      assert.strictEqual((await new Client().post('/api/auth/confirm', { token: tok })).status, 400);
      const me = await A.get('/api/me'); assert.strictEqual(me.data.user.emailConfirmed, true);
    });
    await t('depois de confirmar, Ana aparece para os outros', async () => {
      const d = await B.get('/api/discover'); assert.ok(JSON.stringify(d.data).includes('Ana'));
    });
    await t('link vencido é recusado', async () => {
      const c = new Client(); assert.strictEqual((await c.post('/api/auth/register', reg('cris@teste.com', 'Cris'))).status, 201);
      const t2 = await confirmLinkFor('cris@teste.com'); run("UPDATE email_confirms SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'cris@teste.com')", Date.now() - 1000);
      assert.strictEqual((await new Client().post('/api/auth/confirm', { token: t2 })).status, 400);
    });
    await t('indicação: o prêmio só sai depois de confirmar o e-mail (mesmo com foto)', async () => {
      const code = (await A.get('/api/me/referral')).data.code;
      const D = new Client(); const r = await D.post('/api/auth/register', reg('dani@teste.com', 'Dani', { ref: code })); assert.strictEqual(r.data.referral, 'pending');
      const up = await D.post('/api/me/photos', photo()); assert.strictEqual(up.data.referral, null); assert.strictEqual(up.data.user.plan, 'free');
      const t3 = await confirmLinkFor('dani@teste.com');
      assert.strictEqual((await new Client().post('/api/auth/confirm', { token: t3 })).status, 200);
      const me = await D.get('/api/me'); assert.strictEqual(me.data.user.plan, 'plus');
      assert.strictEqual((await A.get('/api/me/referral')).data.rewarded, 1);
    });
    await t('admin não precisa confirmar e conta antiga fica confirmada', async () => {
      const r = await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' }); assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.user.emailConfirmed, true);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill(); mailSrv.close();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
