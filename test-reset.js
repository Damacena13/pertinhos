'use strict';
// Testes da recuperação de senha: e-mail (Resend simulado), link único e com validade, link gerado pelo admin.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3994;
const MAIL_PORT = 3995;
const http = require('http');
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-reset-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300', RESEND_API_KEY: 'chave-teste', MAIL_FROM: 'Pertinho <nao-responda@teste.com>', RESEND_BASE_URL: `http://127.0.0.1:${MAIL_PORT}`, PUBLIC_URL: 'https://pertinho.teste' };
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
const all = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const run = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const stopServer = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
};

(async () => {
  const mails = [];
  const mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { mails.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"1"}'); }); }).listen(MAIL_PORT);
  let srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  const tokenOf = (m) => (m.body.text.match(/\?reset=([A-Za-z0-9_-]+)/) || [])[1];
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const A = new Client(), ADM = new Client(), anon = new Client();
    assert.strictEqual((await A.post('/api/auth/register', reg('ana@teste.com', 'Ana'))).status, 201);
    await sleep(400); mails.length = 0; // descarta o e-mail de confirmação do cadastro
    let token;
    await t('e-mail desconhecido recebe a mesma resposta e nada é enviado', async () => {
      const r = await anon.post('/api/auth/forgot', { email: 'ninguem@teste.com' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.ok, true); await sleep(200); assert.strictEqual(mails.length, 0);
    });
    await t('e-mail conhecido recebe o link (chave do provedor enviada, link com o endereço público)', async () => {
      const r = await anon.post('/api/auth/forgot', { email: 'ANA@teste.com' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.emailEnabled, true);
      for (let i = 0; i < 20 && !mails.length; i++) await sleep(100);
      assert.strictEqual(mails.length, 1); assert.strictEqual(mails[0].auth, 'Bearer chave-teste');
      assert.deepStrictEqual(mails[0].body.to, ['ana@teste.com']);
      assert.ok(mails[0].body.text.includes('https://pertinho.teste/?reset='));
      token = tokenOf(mails[0]); assert.ok(token && token.length >= 40);
      assert.ok(!(await fetch(BASE + '/api/auth/forgot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pertinho': '1' }, body: JSON.stringify({ email: 'ana@teste.com' }) }).then((x) => x.text())).includes(token));
    });
    await t('o banco guarda só o resumo do token, nunca o token', async () => {
      const rows = all('SELECT token_hash FROM password_resets');
      assert.ok(rows.length >= 1); assert.ok(rows.every((r) => r.token_hash !== token && r.token_hash.length === 64));
    });
    await t('token errado ou senha curta são recusados', async () => {
      assert.strictEqual((await anon.post('/api/auth/reset', { token: 'x'.repeat(43), password: 'nova-senha-123' })).status, 400);
      assert.strictEqual((await anon.post('/api/auth/reset', { token: '<script>', password: 'nova-senha-123' })).status, 400);
      assert.strictEqual((await anon.post('/api/auth/reset', { token: tokenOf(mails[mails.length - 1]) || token, password: '123' })).status, 400);
    });
    await t('o último link vale: troca a senha, derruba as sessões e só funciona uma vez', async () => {
      const t2 = tokenOf(mails[mails.length - 1]);
      assert.strictEqual((await A.get('/api/me')).data.user.email, 'ana@teste.com');
      assert.strictEqual((await anon.post('/api/auth/reset', { token: t2, password: 'nova-senha-123' })).status, 200);
      assert.ok(!(await A.get('/api/me')).data.user, 'sessão antiga deveria cair');
      assert.strictEqual((await new Client().post('/api/auth/login', { email: 'ana@teste.com', password: 'senha-forte-123' })).status, 401);
      assert.strictEqual((await new Client().post('/api/auth/login', { email: 'ana@teste.com', password: 'nova-senha-123' })).status, 200);
      assert.strictEqual((await anon.post('/api/auth/reset', { token: t2, password: 'outra-senha-123' })).status, 400);
    });
    await t('link vencido é recusado', async () => {
      await anon.post('/api/auth/forgot', { email: 'ana@teste.com' }); for (let i = 0; i < 20 && mails.length < 3; i++) await sleep(100);
      const t3 = tokenOf(mails[mails.length - 1]);
      const d = new DatabaseSync(path.join(DATA_DIR, 'pertinho.db')); d.prepare('UPDATE password_resets SET expires_at = 1').run(); d.close();
      assert.strictEqual((await anon.post('/api/auth/reset', { token: t3, password: 'nova-senha-456' })).status, 400);
    });
    await t('conta suspensa não recebe link', async () => {
      const n = mails.length; const d = new DatabaseSync(path.join(DATA_DIR, 'pertinho.db')); d.prepare("UPDATE users SET status='suspended' WHERE email='ana@teste.com'").run(); d.close();
      await anon.post('/api/auth/forgot', { email: 'ana@teste.com' }); await sleep(300); assert.strictEqual(mails.length, n);
      const d2 = new DatabaseSync(path.join(DATA_DIR, 'pertinho.db')); d2.prepare("UPDATE users SET status='active' WHERE email='ana@teste.com'").run(); d2.close();
    });
    await t('admin gera link de redefinição (com auditoria) e o link funciona', async () => {
      assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const uid = (await ADM.get('/api/admin/users?q=ana@teste')).data.users[0].id;
      const r = await ADM.post(`/api/admin/users/${uid}/action`, { action: 'resetLink' });
      assert.strictEqual(r.status, 200); assert.ok(r.data.link.startsWith('https://pertinho.teste/?reset=')); assert.strictEqual(r.data.expiresInMinutes, 60);
      const tk = r.data.link.split('?reset=')[1];
      assert.strictEqual((await anon.post('/api/auth/reset', { token: tk, password: 'senha-do-admin-123' })).status, 200);
      assert.ok((await ADM.get('/api/admin/audit')).data.log.some((l) => l.action === 'resetLink'));
    });
    await t('admin não gera link para outro administrador; usuário comum não usa a rota', async () => {
      const aid = one("SELECT id FROM users WHERE role='admin'").id;
      assert.strictEqual((await ADM.post(`/api/admin/users/${aid}/action`, { action: 'resetLink' })).status, 400);
      assert.strictEqual((await new Client().post(`/api/admin/users/1/action`, { action: 'resetLink' })).status, 403);
    });
    await t('modo local revela token de uso único somente para conta existente via loopback', async () => {
      const mailCountBefore = mails.length;
      await stopServer(srv);
      const localEnv = { ...env, RESEND_API_KEY: '', MAIL_FROM: '', PASSWORD_RESET_DEV_MODE: '1' };
      srv = spawn('node', ['server.js'], { env: localEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
      const local = new Client();
      const known = await local.post('/api/auth/forgot', { email: 'ana@teste.com' });
      assert.strictEqual(known.status, 200);
      const localToken = known.data.localResetToken;
      assert.ok(localToken && localToken.length >= 40);
      assert.strictEqual(known.data.emailEnabled, false);
      const unknown = await local.post('/api/auth/forgot', { email: 'nao-existe@teste.com' });
      assert.strictEqual(unknown.status, 200); assert.ok(!unknown.data.localResetToken);
      const remoteHost = await new Promise((resolve, reject) => {
        const request = http.request({
          hostname: '127.0.0.1', port: PORT, path: '/api/auth/forgot', method: 'POST',
          headers: { Host: 'remote.example', 'content-type': 'application/json', 'x-pertinho': '1' },
        }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.on('error', reject);
        request.end(JSON.stringify({ email: 'ana@teste.com' }));
      });
      assert.ok(!/"localResetToken"\s*:/.test(remoteHost.body), 'Host público não pode obter token local');
      assert.strictEqual((await local.post('/api/auth/reset', { token: localToken, password: 'senha-homologacao-123' })).status, 200);
      assert.strictEqual((await local.post('/api/auth/reset', { token: localToken, password: 'senha-repetida-123' })).status, 400);
      assert.strictEqual((await new Client().post('/api/auth/login', { email: 'ana@teste.com', password: 'senha-homologacao-123' })).status, 200);
      await sleep(200); assert.strictEqual(mails.length, mailCountBefore, 'modo local não deve enviar e-mail');
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  await stopServer(srv);
  await new Promise((resolve) => mailSrv.close(resolve));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
