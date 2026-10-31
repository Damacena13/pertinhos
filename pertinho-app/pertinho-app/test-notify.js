'use strict';
// Testes dos avisos por e-mail.
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-notify-'));
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
const { nextCpf, stopChild } = require('./test-util');
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
    const mk = async (email, name, g) => { const c = new Client(); assert.strictEqual((await c.post('/api/auth/register', reg(email, name, { gender: g }))).status, 201); await c.post('/api/me/photos', photo()); run('UPDATE users SET email_verified_at = ? WHERE email = ?', Date.now(), email); return c; };
    const idOf = (email) => one('SELECT id FROM users WHERE email = ?', email).id;
    const to = (email, re) => mails.filter((m) => m.body.to[0] === email && re.test(m.body.subject));
    const A = await mk('ana@teste.com', 'Ana', 'f'), B = await mk('bob@teste.com', 'Bob', 'm');
    const bid = idOf('bob@teste.com'), aid = idOf('ana@teste.com');
    let matchId;
    await t('match avisa as duas pessoas por e-mail, uma vez só', async () => {
      assert.strictEqual((await A.post('/api/swipe', { userId: bid, kind: 'like' })).status, 200);
      const r = await B.post('/api/swipe', { userId: aid, kind: 'like' }); assert.strictEqual(r.data.match, true); matchId = r.data.matchId;
      await sleep(400);
      assert.strictEqual(to('ana@teste.com', /novo match/i).length, 1); assert.strictEqual(to('bob@teste.com', /novo match/i).length, 1);
      const m = to('bob@teste.com', /novo match/i)[0].body; assert.ok(m.text.includes('https://pertinho.teste/') && m.text.includes('/api/unsubscribe?u=' + bid));
    });
    await t('mensagem avisa quem está offline e respeita o intervalo de 6 horas', async () => {
      run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now() - 3600_000, bid);
      assert.strictEqual((await A.post(`/api/matches/${matchId}/messages`, { body: 'Oi!' })).status, 201); await sleep(400);
      assert.strictEqual(to('bob@teste.com', /mandou uma mensagem/).length, 1);
      run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now() - 3600_000, bid);
      await A.post(`/api/matches/${matchId}/messages`, { body: 'Tudo bem?' }); await sleep(400);
      assert.strictEqual(to('bob@teste.com', /mandou uma mensagem/).length, 1, 'segunda mensagem não deve gerar outro e-mail');
      assert.ok(!to('bob@teste.com', /mandou uma mensagem/)[0].body.text.includes('Oi!'), 'e-mail não pode vazar o conteúdo da mensagem');
    });
    await t('quem está online não recebe e-mail de mensagem', async () => {
      run('DELETE FROM notif_log WHERE key LIKE ?', 'msg:%'); const before = mails.length;
      await B.get('/api/me'); await A.post(`/api/matches/${matchId}/messages`, { body: 'Você está aí?' }); await sleep(400);
      assert.strictEqual(mails.length, before);
    });
    await t('link de descadastro funciona, rejeita assinatura falsa e para os e-mails', async () => {
      const link = to('bob@teste.com', /novo match/i)[0].body.text.match(/https:\/\/pertinho\.teste(\/api\/unsubscribe\?u=\d+&t=[0-9a-f]+)/)[1];
      assert.strictEqual((await new Client().get(link.replace(/t=[0-9a-f]+/, 't=' + '0'.repeat(32)))).status, 400);
      assert.strictEqual((await new Client().get('/api/unsubscribe?u=' + bid + '&t=zz')).status, 400);
      assert.strictEqual(one('SELECT notify_email n FROM users WHERE id = ?', bid).n, 1);
      assert.strictEqual((await new Client().get(link)).status, 200);
      assert.strictEqual(one('SELECT notify_email n FROM users WHERE id = ?', bid).n, 0);
      run('DELETE FROM notif_log'); run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now() - 3600_000, bid); const before = mails.length;
      await A.post(`/api/matches/${matchId}/messages`, { body: 'Ainda aí?' }); await sleep(400);
      assert.strictEqual(mails.length, before);
    });
    await t('preferência no perfil liga e desliga os avisos', async () => {
      assert.strictEqual((await B.patch('/api/me', { notifyEmail: true })).data.user.notifyEmail, true);
      assert.strictEqual((await B.patch('/api/me', { notifyEmail: false })).data.user.notifyEmail, false);
    });
    await t('lembrete de encontro sai uma vez para quem confirmou presença', async () => {
      assert.strictEqual((await B.patch('/api/me', { notifyEmail: true })).status, 200);
      const r = await A.post('/api/events', { title: 'Cinema em grupo', placeType: 'Shopping (praça de alimentação)', placeName: 'Shopping X', capacity: 5, startsAt: Date.now() + 2.5 * 3600_000, description: '' }); assert.strictEqual(r.status, 201);
      assert.strictEqual((await B.post(`/api/events/${r.data.event.id}/join`)).status, 200);
      process.env.PUBLIC_URL = 'https://pertinho.teste';
      const sent = []; const d = dbq();
      try {
        const n = require('./notify').makeNotify({ db: d, mailer: { enabled: () => true, sendMail: async (x) => { sent.push(x); return { sent: true }; } }, now: Date.now, secret: 'x' });
        assert.strictEqual(n.sweepEvents(), 2); assert.strictEqual(n.sweepEvents(), 0);
      } finally { d.close(); }
      assert.deepStrictEqual(sent.map((s) => s.to).sort(), ['ana@teste.com', 'bob@teste.com']);
      assert.ok(sent[0].text.includes('Cinema em grupo') && !sent[0].text.includes('Shopping X'), 'lembrete não revela o local exato');
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  await stopChild(srv); mailSrv.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
