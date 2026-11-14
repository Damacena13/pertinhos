'use strict';
// Crescimento: cidade em lista de espera, convite e funil de métricas.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-gr-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', CITY_OPEN_MIN: '3', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
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
    const mk = async (email, name, withPhoto, extra = {}) => {
      const c = new Client(); const r = await c.post('/api/auth/register', reg(email, name, extra)); assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      if (withPhoto) assert.strictEqual((await c.req('POST', '/api/me/photos', photo())).status, 201);
      return { c, id: r.data.user.id };
    };
    const A = await mk('a@teste.com', 'Ana', true);
    await t('cidade fica em lista de espera: conta só quem está ativo e com foto, e diz quantos faltam', async () => {
      await mk('b@teste.com', 'Beto', false, { gender: 'm' });
      let s = (await A.c.get('/api/city-status')).data;
      assert.strictEqual(s.known, true); assert.strictEqual(s.nearby, 1); assert.strictEqual(s.needed, 3); assert.strictEqual(s.open, false); assert.strictEqual(s.missing, 2);
      assert.match(s.cityName, /São José do Rio Preto/);
      assert.deepStrictEqual(Object.keys(s).sort(), ['cityName', 'km', 'known', 'missing', 'nearby', 'needed', 'open']);
    });
    await t('a cidade abre quando chega ao mínimo; quem não está logado não vê', async () => {
      await mk('c@teste.com', 'Caio', true, { gender: 'm' }); await mk('d@teste.com', 'Duda', true);
      const s = (await A.c.get('/api/city-status')).data; assert.strictEqual(s.nearby, 3); assert.strictEqual(s.open, true); assert.strictEqual(s.missing, 0);
      assert.strictEqual((await new Client().get('/api/city-status')).status, 401);
      run("UPDATE users SET invisible = 1 WHERE email = 'd@teste.com'");
      assert.strictEqual((await A.c.get('/api/city-status')).data.nearby, 2, 'invisível não conta');
    });
    await t('cidade distante não soma gente de outra região', async () => {
      const s = (await A.c.get('/api/city-status?cityId=manaus-am')).data; assert.strictEqual(s.nearby, 0); assert.strictEqual(s.open, false);
      assert.strictEqual((await A.c.get('/api/city-status?cityId=xx-nao-existe')).data.known, false);
    });
    await t('convite compartilhado: só eventos conhecidos e repetir não duplica', async () => {
      assert.strictEqual((await A.c.post('/api/me/funnel', { event: 'qualquer-coisa' })).status, 400);
      assert.strictEqual((await A.c.post('/api/me/funnel', { event: 'invite_shared' })).status, 200);
      assert.strictEqual((await A.c.post('/api/me/funnel', { event: 'invite_shared' })).status, 200);
      assert.strictEqual(one("SELECT COUNT(*) c FROM funnel_events WHERE user_id = ?", A.id).c, 1);
      assert.strictEqual((await new Client().post('/api/me/funnel', { event: 'invite_shared' })).status, 401);
    });
    await t('funil do ADM conta cada passo, ignora demonstração e exige administrador', async () => {
      const B = (await mk('e@teste.com', 'Eva', true)); 
      const a = Math.min(A.id, B.id), b = Math.max(A.id, B.id);
      run("INSERT INTO swipes (from_id, to_id, kind, created_at) VALUES (?,?,?,?)", A.id, B.id, 'like', Date.now());
      const mid = Number(run('INSERT INTO matches (a_id, b_id, created_at) VALUES (?,?,?)', a, b, Date.now()).lastInsertRowid);
      run('INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?,?,?,?)', mid, A.id, 'oi', Date.now());
      run("INSERT INTO users (email, pass_hash, name, birth_date, gender, created_at, is_demo) VALUES ('demo@x.com','h','Demo','1990-01-01','f',?,1)", Date.now());
      assert.strictEqual((await A.c.get('/api/admin/funnel')).status, 403);
      const ADM = new Client(); assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const f = (await ADM.get('/api/admin/funnel?days=30')).data; const n = Object.fromEntries(f.steps.map((x) => [x.label, x]));
      assert.strictEqual(n['Cadastro'].n, 5, 'demo e admin ficam de fora');
      assert.strictEqual(n['Enviou foto principal'].n, 4); assert.strictEqual(n['Deu a primeira curtida'].n, 1);
      assert.strictEqual(n['Teve o primeiro match'].n, 2); assert.strictEqual(n['Mandou a primeira mensagem'].n, 1);
      assert.strictEqual(n['Compartilhou o convite'].n, 1); assert.strictEqual(n['Enviou foto principal'].pctOfSignups, 80);
    });

    await t('verificação de saúde responde sem login e o ADM avisa se os dados são apagáveis', async () => {
      const h = await fetch(BASE + '/healthz', { headers: { 'user-agent': 'Go-http-client/2.0' } }); assert.strictEqual(h.status, 200); assert.strictEqual(await h.text(), 'ok');
      const ADM2 = new Client(); assert.strictEqual((await ADM2.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const st = (await ADM2.get('/api/admin/stats')).data; assert.strictEqual(st.storageEphemeral, false); assert.strictEqual(st.demoBots, true);
    });

    await t('na Render sem disco permanente (dados na mesma partição do código) o painel mostra o aviso', async () => {
      const dd = fs.mkdtempSync(path.join(__dirname, 'data-eph-'));
      const s2 = spawn('node', ['server.js'], { env: { ...env, PORT: '3994', DATA_DIR: dd, RENDER: 'true' }, stdio: 'ignore' });
      try {
        for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:3994/healthz')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
        const r = await fetch('http://127.0.0.1:3994/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pertinho': '1', 'user-agent': 'x' }, body: JSON.stringify({ email: 'admin@teste.com', password: 'SenhaAdmin#123' }) });
        assert.strictEqual(r.status, 200); const ck = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        const st = await (await fetch('http://127.0.0.1:3994/api/admin/stats', { headers: { cookie: ck, 'user-agent': 'x' } })).json();
        assert.strictEqual(st.storageEphemeral, true);
      } finally { s2.kill(); await sleep(300); fs.rmSync(dd, { recursive: true, force: true }); }
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
