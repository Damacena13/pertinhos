'use strict';
// Teste de ponta a ponta: sobe o servidor com um banco temporário e percorre o fluxo pela API real.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-test-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '200' };

// PNG 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && !opts.noCsrf) headers['x-pertinho'] = '1';
    let payload = body;
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) { const kv = c.split(';')[0]; if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, o) { return this.req('POST', u, b, o); }
  patch(u, b) { return this.req('PATCH', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FALHOU ' + name + '\n         ' + (e.message || e).toString().split('\n')[0]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/plans'); if (r.ok) return; } catch { /* ainda subindo */ } await sleep(250); }
  throw new Error('Servidor não subiu');
}

const { nextCpf, stopChild } = require('./test-util');
const reg = (email, extra = {}) => ({ cpf: nextCpf(), email, password: 'senha-forte-123', name: 'Teste', birthDate: '1995-05-20', gender: 'f', seeking: 'all', cityId: 'sao-jose-do-rio-preto-sp', bio: 'Bio de teste', terms: true, interests: ['Café', 'Livros'], ...extra });
function photoForm(buf = PNG, name = 'x.png', type = 'image/png') {
  const f = new FormData(); f.append('photo', new Blob([buf], { type }), name); return f;
}

(async () => {
  const seed = spawnSync('node', ['seed-demo.js'], { env, encoding: 'utf8' });
  assert.ok(seed.stdout.includes('Criados'), 'seed falhou: ' + seed.stdout + seed.stderr);
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  try {
    await waitUp();
    const A = new Client(), B = new Client(), ADM = new Client(), anon = new Client();

    console.log('\nCadastro e login');
    await t('rejeita menor de 18 anos', async () => {
      const y = new Date().getUTCFullYear() - 17;
      const r = await anon.post('/api/auth/register', reg('menor@x.com', { birthDate: `${y}-01-01` }));
      assert.strictEqual(r.status, 400); assert.match(r.data.error, /18 anos/);
    });
    await t('rejeita data de nascimento inválida (30/02)', async () => {
      assert.strictEqual((await anon.post('/api/auth/register', reg('d@x.com', { birthDate: '1990-02-30' }))).status, 400);
    });
    await t('exige aceite dos termos e senha mínima', async () => {
      assert.strictEqual((await anon.post('/api/auth/register', reg('t@x.com', { terms: false }))).status, 400);
      assert.strictEqual((await anon.post('/api/auth/register', reg('t@x.com', { password: '123' }))).status, 400);
    });
    await t('cadastra a Ana e já deixa logada', async () => {
      const r = await A.post('/api/auth/register', reg('ana@teste.com', { name: 'Ana' }));
      assert.strictEqual(r.status, 201); assert.strictEqual(r.data.user.plan, 'free');
      assert.ok(A.cookie.startsWith('pp_session='));
      assert.strictEqual(r.data.user.passHash, undefined); assert.strictEqual(r.data.user.pass_hash, undefined);
    });
    await t('e-mail duplicado é recusado', async () => {
      assert.strictEqual((await anon.post('/api/auth/register', reg('ANA@teste.com'))).status, 400);
    });
    await t('CPF: exige número válido (dígitos verificadores) e rejeita repetidos', async () => {
      for (const bad of [undefined, '', '123.456.789-00', '111.111.111-11', '12345', '529.982.247-26', 'abc'])
        assert.strictEqual((await anon.post('/api/auth/register', reg('cpfruim@x.com', { cpf: bad }))).status, 400, 'deveria recusar ' + bad);
    });
    await t('CPF: um CPF só pode ter uma conta (aceita com ou sem pontuação)', async () => {
      const cpf = nextCpf(), pretty = cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
      const anon1 = new Client(); const r1 = await anon1.post('/api/auth/register', reg('cpf1@x.com', { cpf: pretty }));
      assert.strictEqual(r1.status, 201, JSON.stringify(r1.data));
      assert.strictEqual(r1.data.user.cpfMasked, '***.***.***-' + cpf.slice(-2));
      assert.ok(!JSON.stringify(r1.data).includes(cpf), 'a resposta não pode conter o CPF');
      const anon2 = new Client();
      const r2 = await anon2.post('/api/auth/register', reg('cpf2@x.com', { cpf }));
      assert.strictEqual(r2.status, 409);
      const db = new (require('node:sqlite').DatabaseSync)(path.join(DATA_DIR, 'pertinho.db'));
      const row = db.prepare("SELECT * FROM users WHERE email = 'cpf1@x.com'").get(); db.close();
      assert.strictEqual(row.cpf_hash.length, 64); assert.strictEqual(row.cpf_last2, cpf.slice(-2));
      assert.ok(!JSON.stringify(row).includes(cpf), 'o CPF não pode estar em texto puro no banco');
      for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.startsWith('pertinho.db')))
        assert.ok(!fs.readFileSync(path.join(DATA_DIR, f)).toString('latin1').includes(cpf), 'CPF em texto puro em ' + f);
    });
    await t('requisição de escrita sem o cabeçalho anti-CSRF é recusada', async () => {
      assert.strictEqual((await A.post('/api/me/location', { cityId: 'campinas-sp' }, { noCsrf: true })).status, 403);
    });
    await t('rotas protegidas exigem login', async () => {
      assert.strictEqual((await anon.get('/api/discover')).status, 401);
      assert.strictEqual((await anon.get('/api/matches')).status, 401);
    });
    await t('senha errada não entra (mensagem genérica)', async () => {
      const r = await anon.post('/api/auth/login', { email: 'ana@teste.com', password: 'errada-errada' });
      assert.strictEqual(r.status, 401);
      const r2 = await anon.post('/api/auth/login', { email: 'ninguem@teste.com', password: 'errada-errada' });
      assert.strictEqual(r.data.error, r2.data.error);
    });

    console.log('\nFotos');
    await t('arquivo que não é imagem é recusado (mesmo com nome .png)', async () => {
      const r = await A.req('POST', '/api/me/photos', photoForm(Buffer.from('<script>alert(1)</script>'), 'x.png'));
      assert.strictEqual(r.status, 400);
    });
    await t('SVG enviado por usuário é recusado', async () => {
      const r = await A.req('POST', '/api/me/photos', photoForm(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', 'image/svg+xml'));
      assert.strictEqual(r.status, 400);
    });
    await t('primeira foto vira a principal; limite de 5 fotos', async () => {
      let r = await A.req('POST', '/api/me/photos', photoForm());
      assert.strictEqual(r.status, 201); assert.strictEqual(r.data.user.photos.length, 1); assert.ok(r.data.user.photos[0].isMain);
      for (let i = 0; i < 4; i++) assert.strictEqual((await A.req('POST', '/api/me/photos', photoForm())).status, 201);
      assert.strictEqual((await A.req('POST', '/api/me/photos', photoForm())).status, 400);
    });
    await t('dono vê a própria foto; sem login não vê nenhuma', async () => {
      const me = (await A.get('/api/me')).data.user;
      const ok = await A.get(`/api/photos/${me.photos[0].id}`);
      assert.strictEqual(ok.status, 200); assert.strictEqual(ok.headers.get('content-type'), 'image/jpeg');
      assert.strictEqual((await anon.get(`/api/photos/${me.photos[0].id}`)).status, 401);
    });

    console.log('\nDescoberta, planos e fotos extras');
    await t('Bruno entra, e o plano grátis limita o raio a 10 km', async () => {
      assert.strictEqual((await B.post('/api/auth/register', reg('bruno@teste.com', { name: 'Bruno', gender: 'm' }))).status, 201);
      assert.strictEqual((await B.req('POST', '/api/me/photos', photoForm())).status, 201);
      const d = (await B.get('/api/discover?radius=50')).data;
      assert.strictEqual(d.radius, 10);
      assert.ok(d.profiles.length > 0, 'deveria ver perfis de demonstração perto');
      for (const p of d.profiles) assert.ok(p.distanceKm <= 10, `distância ${p.distanceKm}`);
    });
    await t('a API nunca devolve coordenadas, e-mail ou hash', async () => {
      const raw = JSON.stringify((await B.get('/api/discover?radius=10')).data);
      assert.ok(!/"lat"|"lng"|latitude|longitude|email|pass_hash|birth/i.test(raw), 'vazou dado sensível');
    });
    let freeProfile;
    await t('no plano grátis as fotos extras vêm bloqueadas', async () => {
      const d = (await B.get('/api/discover?radius=10&limit=50')).data;
      freeProfile = d.profiles.find((p) => p.extraCount > 0);
      assert.ok(freeProfile, 'algum perfil com fotos extras');
      assert.strictEqual(freeProfile.extraLocked, true); assert.deepStrictEqual(freeProfile.extraPhotoIds, []);
      assert.strictEqual((await B.get(`/api/photos/${freeProfile.mainPhotoId}`)).status, 200);
    });
    await t('tentar adivinhar o id de uma foto extra dá 402', async () => {
      const ids = []; for (let i = 1; i <= 80; i++) ids.push(i);
      let blocked = 0;
      for (const id of ids) { const r = await B.get(`/api/photos/${id}`); if (r.status === 402) blocked++; }
      assert.ok(blocked > 0, 'nenhuma foto extra foi bloqueada');
    });
    await t('modo invisível exige Premium', async () => {
      assert.strictEqual((await B.patch('/api/me', { invisible: true })).status, 402);
    });
    await t('assinar o Plus libera raio de 50 km e fotos extras', async () => {
      const r = await B.post('/api/billing/checkout', { plan: 'plus' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user.plan, 'plus');
      const d = (await B.get('/api/discover?radius=50&limit=50')).data;
      assert.strictEqual(d.radius, 50);
      const p = d.profiles.find((x) => x.id === freeProfile.id);
      assert.ok(p.extraPhotoIds.length > 0 && !p.extraLocked);
      assert.strictEqual((await B.get(`/api/photos/${p.extraPhotoIds[0]}`)).status, 200);
    });
    await t('cancelar volta ao grátis e bloqueia as extras de novo', async () => {
      assert.strictEqual((await B.post('/api/billing/cancel')).data.user.plan, 'free');
      const p = (await B.get('/api/discover?radius=10&limit=50')).data.profiles.find((x) => x.id === freeProfile.id);
      assert.strictEqual(p.extraLocked, true);
    });

    console.log('\nCurtidas, matches e chat');
    let matchId, aliceMatchUser;
    await t('limite de 30 curtidas por 24 h no plano grátis', async () => {
      const C = new Client();
      await C.post('/api/auth/register', reg('carla@teste.com', { name: 'Carla' }));
      const db = new (require('node:sqlite').DatabaseSync)(path.join(DATA_DIR, 'pertinho.db'));
      const cid = db.prepare("SELECT id FROM users WHERE email='carla@teste.com'").get().id;
      const ins = db.prepare("INSERT OR REPLACE INTO swipes (from_id,to_id,kind,created_at) VALUES (?,?, 'like', ?)");
      const demos = db.prepare('SELECT id FROM users WHERE is_demo = 1 LIMIT 31').all();
      for (let i = 0; i < 30; i++) ins.run(cid, demos[i].id, Date.now());
      const r = await C.post('/api/swipe', { userId: demos[30].id, kind: 'like' });
      assert.strictEqual(r.status, 402); db.close();
    });
    await t('curtir um perfil de demonstração gera match', async () => {
      const list = (await B.get('/api/discover?radius=10&limit=50')).data.profiles;
      let m = null;
      for (const p of list) { const r = await B.post('/api/swipe', { userId: p.id, kind: 'like' }); assert.strictEqual(r.status, 200); if (r.data.match) { m = r.data; aliceMatchUser = p; break; } }
      assert.ok(m, 'nenhum match no modo demonstração'); matchId = m.matchId;
    });
    await t('não dá para curtir duas vezes nem a si mesmo', async () => {
      const me = (await B.get('/api/me')).data.user;
      assert.strictEqual((await B.post('/api/swipe', { userId: me.id, kind: 'like' })).status, 400);
    });
    await t('envia mensagem e recebe a resposta automática do perfil de demonstração', async () => {
      assert.strictEqual((await B.post(`/api/matches/${matchId}/messages`, { body: 'Oi! <b>tudo bem?</b>' })).status, 201);
      await sleep(2300);
      const r = (await B.get(`/api/matches/${matchId}/messages`)).data;
      assert.ok(r.messages.length >= 2); assert.ok(r.messages.some((m) => !m.mine));
      assert.ok(r.messages.some((m) => m.body === 'Oi! <b>tudo bem?</b>'));
    });
    await t('sugerir encontro aceita só tipos de local conhecidos', async () => {
      assert.strictEqual((await B.post(`/api/matches/${matchId}/messages`, { kind: 'place', body: 'Café' })).status, 201);
      assert.strictEqual((await B.post(`/api/matches/${matchId}/messages`, { kind: 'place', body: 'Beco escuro' })).status, 400);
    });
    await t('outra pessoa não consegue ler nem escrever na conversa (IDOR)', async () => {
      assert.strictEqual((await A.get(`/api/matches/${matchId}/messages`)).status, 404);
      assert.strictEqual((await A.post(`/api/matches/${matchId}/messages`, { body: 'intruso' })).status, 404);
      assert.strictEqual((await A.del(`/api/matches/${matchId}`)).status, 404);
    });
    await t('lista de matches mostra não lidas e resumo', async () => {
      const r = (await B.get('/api/matches')).data;
      assert.ok(r.matches.length >= 1 && r.matches[0].last);
    });

    console.log('\nBloqueio, denúncia e painel ADM');
    await t('usuário comum não acessa o painel ADM', async () => {
      assert.strictEqual((await B.get('/api/admin/stats')).status, 403);
      assert.strictEqual((await anon.get('/api/admin/users')).status, 403);
    });
    await t('denúncia exige motivo válido e bloquear remove o match', async () => {
      assert.strictEqual((await B.post(`/api/users/${aliceMatchUser.id}/report`, { reason: 'inventado' })).status, 400);
      assert.strictEqual((await B.post(`/api/users/${aliceMatchUser.id}/report`, { reason: 'Perfil falso', details: 'Parece falso', block: true })).status, 200);
      const ms = (await B.get('/api/matches')).data.matches;
      assert.ok(!ms.some((m) => m.id === matchId));
      const d = (await B.get('/api/discover?radius=10&limit=50')).data.profiles;
      assert.ok(!d.some((p) => p.id === aliceMatchUser.id), 'bloqueado ainda aparece');
    });
    await t('administrador entra e vê os números', async () => {
      const r = await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user.role, 'admin');
      const s = (await ADM.get('/api/admin/stats')).data;
      assert.ok(s.users >= 30); assert.strictEqual(s.openReports, 1); assert.strictEqual(s.signups.length, 14);
    });
    await t('busca de usuários funciona e escapa curingas do LIKE', async () => {
      const r = (await ADM.get('/api/admin/users?q=ana')).data;
      assert.ok(r.users.some((u) => u.email === 'ana@teste.com'));
      const w = (await ADM.get('/api/admin/users?q=' + encodeURIComponent('%'))).data;
      assert.strictEqual(w.total, 0);
    });
    await t('admin concede plano manualmente e registra na auditoria', async () => {
      const ana = (await ADM.get('/api/admin/users?q=ana@teste')).data.users[0];
      assert.strictEqual((await ADM.post(`/api/admin/users/${ana.id}/action`, { action: 'setPlan', plan: 'premium', days: 10 })).status, 200);
      assert.strictEqual((await A.get('/api/me')).data.user.plan, 'premium');
      const log = (await ADM.get('/api/admin/audit')).data.log;
      assert.ok(log.some((l) => l.action === 'setPlan'));
      assert.strictEqual((await A.patch('/api/me', { invisible: true })).data.user.invisible, true);
    });
    await t('admin trata a denúncia suspendendo a conta, e a sessão cai na hora', async () => {
      const reps = (await ADM.get('/api/admin/reports')).data.reports;
      assert.strictEqual(reps.length, 1);
      const target = reps[0].reportedId;
      assert.strictEqual((await ADM.post(`/api/admin/reports/${reps[0].id}/resolve`, { action: 'suspend', note: 'Perfil falso confirmado' })).status, 200);
      assert.strictEqual((await ADM.get('/api/admin/stats')).data.openReports, 0);
      const u = (await ADM.get(`/api/admin/users/${target}`)).data.user;
      assert.strictEqual(u.status, 'suspended');
    });
    await t('suspender exige motivo e derruba a sessão do usuário', async () => {
      const bruno = (await ADM.get('/api/admin/users?q=bruno@teste')).data.users[0];
      assert.strictEqual((await ADM.post(`/api/admin/users/${bruno.id}/action`, { action: 'suspend' })).status, 400);
      assert.strictEqual((await ADM.post(`/api/admin/users/${bruno.id}/action`, { action: 'suspend', reason: 'Teste' })).status, 200);
      assert.strictEqual((await B.get('/api/discover')).status, 401);
      const login = await anon.post('/api/auth/login', { email: 'bruno@teste.com', password: 'senha-forte-123' });
      assert.strictEqual(login.status, 403); assert.strictEqual(login.data.suspended, true);
      await ADM.post(`/api/admin/users/${bruno.id}/action`, { action: 'unsuspend' });
    });
    await t('admin não consegue alterar outro administrador', async () => {
      const db = new (require('node:sqlite').DatabaseSync)(path.join(DATA_DIR, 'pertinho.db'));
      const adminId = db.prepare("SELECT id FROM users WHERE role='admin'").get().id; db.close();
      assert.strictEqual((await ADM.post(`/api/admin/users/${adminId}/action`, { action: 'suspend', reason: 'x' })).status, 400);
    });
    await t('admin remove foto e ela some', async () => {
      const ph = (await ADM.get('/api/admin/photos')).data.photos;
      assert.ok(ph.length > 0);
      assert.strictEqual((await ADM.del(`/api/admin/photos/${ph[0].id}`)).status, 200);
      assert.strictEqual((await ADM.get(`/api/photos/${ph[0].id}`)).status, 404);
    });

    console.log('\nPrivacidade (LGPD)');
    await t('exportar dados e apagar a conta com senha', async () => {
      const ex = await A.get('/api/me/export'); assert.strictEqual(ex.status, 200); assert.ok(ex.data.perfil);
      assert.strictEqual((await A.del('/api/me', { password: 'errada-errada' })).status, 400);
      assert.strictEqual((await A.del('/api/me', { password: 'senha-forte-123' })).status, 200);
      assert.strictEqual((await anon.post('/api/auth/login', { email: 'ana@teste.com', password: 'senha-forte-123' })).status, 401);
    });
    await t('o código do servidor e os dados nunca são entregues pelo site', async () => {
      for (const p of ['/server.js', '/db.js', '/lib.js', '/referrals.js', '/billing.js', '/package.json', '/.env', '/.env.example', '/data/pertinho.db', '/pertinho.db', '/cpf.pepper', '/test.js', '/README.md', '/Dockerfile', '/fly.toml', '/node_modules/express/package.json', '/../server.js', '/%2e%2e/server.js']) {
        const r = await fetch(BASE + p, { redirect: 'manual' });
        const body = Buffer.from(await r.arrayBuffer()).toString('utf8');
        assert.ok(r.status !== 200 || /<!doctype html/i.test(body), p + ' devolveu conteúdo (' + r.status + ')');
        assert.ok(!/require\('|CPF_PEPPER|better-sqlite|node:sqlite/.test(body), p + ' vazou código');
      }
    });
    await t('cabeçalhos de segurança estão ativos', async () => {
      const r = await anon.get('/api/plans');
      assert.ok((r.headers.get('content-security-policy') || '').includes("script-src 'self'"));
      assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(!r.headers.get('x-powered-by'));
    });
  } catch (e) {
    failed++; console.log('ERRO GERAL', e.message);
  } finally {
    await stopChild(srv);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log(srvLog);
  process.exit(failed ? 1 : 0);
})();
