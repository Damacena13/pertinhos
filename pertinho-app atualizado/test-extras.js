'use strict';
// Testes das novidades: super curtida, desfazer, quota do chat, Passe 24h, ciclos, destaque, pacote de fotos,
// sintonia, Cupido, verificação por selfie e migração de bancos antigos.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-extras-'));
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', FREE_CHAT_MESSAGES: '3', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test' };
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
  const seed = spawnSync('node', ['seed-demo.js'], { env, encoding: 'utf8' });
  assert.ok(seed.stdout.includes('Criados'), 'seed falhou');
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const A = new Client(), B = new Client(), C = new Client(), ADM = new Client(), anon = new Client();
    let me, bUser, cUser;
    const mk = async (client, email, name, extra) => { const r = await client.post('/api/auth/register', reg(email, name, extra)); assert.strictEqual(r.status, 201, JSON.stringify(r.data)); await client.post('/api/me/photos', photo()); const photoRes = await client.get('/api/me'); return photoRes.data.user; };

    console.log('\nCatálogo e perfil');
    await t('a API publica ciclos, preços, loja e o limite de mensagens grátis', async () => {
      const r = (await anon.get('/api/plans')).data;
      assert.deepStrictEqual(r.cycles, [1, 3, 6]);
      assert.strictEqual(r.plans.find((p) => p.id === 'plus').prices['3'], 6990);
      assert.strictEqual(r.plans.find((p) => p.id === 'premium').prices['6'], 19950);
      assert.deepStrictEqual(r.shop.map((x) => x.id).sort(), ['boost30m', 'boost90m', 'pass24h', 'photos10', 'photos3']);
      assert.strictEqual(r.freeChatMessages, 3);
      assert.strictEqual(r.plans.find((p) => p.id === 'premium').limits.maxRadius, 100);
    });
    me = await mk(A, 'ana@teste.com', 'Ana');
    bUser = await mk(B, 'bia@teste.com', 'Bia', { interests: ['café', 'Livros'] });
    cUser = await mk(C, 'caio@teste.com', 'Caio', { gender: 'm', interests: ['Games'] });
    await t('música do perfil é salva, limitada a 80 caracteres e aparece para os outros', async () => {
      const r = await B.patch('/api/me', { anthem: 'Djavan - Oceano' + 'x'.repeat(100) });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user.anthem.length, 80);
      await B.patch('/api/me', { anthem: 'Djavan - Oceano' });
      const d = (await A.get('/api/discover?radius=10&limit=50')).data;
      assert.strictEqual(d.profiles.find((p) => p.id === bUser.id).anthem, 'Djavan - Oceano');
    });
    await t('sintonia, interesses em comum e "online" vêm do servidor', async () => {
      const d = (await A.get('/api/discover?radius=10&limit=50')).data;
      const b = d.profiles.find((p) => p.id === bUser.id);
      assert.ok(b.affinity >= 20 && b.affinity <= 100, 'sintonia ' + b.affinity);
      assert.deepStrictEqual(b.commonInterests.map((x) => x.toLowerCase()), ['café']);
      assert.strictEqual(b.online, true);
      const c = d.profiles.find((p) => p.id === cUser.id);
      assert.strictEqual(c.commonInterests.length, 0);
      assert.ok(b.affinity > c.affinity);
      assert.ok(!JSON.stringify(d).match(/lat|lng|email|birth/i), 'vazou dado privado');
    });
    await t('o filtro "só quem está online" só devolve gente online', async () => {
      const d = (await A.get('/api/discover?radius=10&limit=50&online=1')).data;
      assert.ok(d.profiles.length >= 2);
      assert.ok(d.profiles.every((p) => p.online));
      run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now() - 3600_000, cUser.id);
      assert.ok(!(await A.get('/api/discover?radius=10&limit=50&online=1')).data.profiles.some((p) => p.id === cUser.id));
      assert.strictEqual((await A.get('/api/discover?radius=10&limit=50')).data.profiles.find((p) => p.id === cUser.id).online, false);
    });

    console.log('\nSuper curtida e desfazer');
    await t('plano grátis tem 1 Super Curtida por 24 h, separada das curtidas comuns', async () => {
      const d0 = (await A.get('/api/discover?radius=10&limit=50')).data; assert.strictEqual(d0.superLeft, 1);
      const r = await A.post('/api/swipe', { userId: cUser.id, kind: 'super' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.superLeft, 0); assert.strictEqual(r.data.likesLeft, 30);
      const again = await A.post('/api/swipe', { userId: bUser.id, kind: 'super' });
      assert.strictEqual(again.status, 402); assert.match(again.data.error, /Super Curtida/);
      assert.strictEqual((await A.post('/api/swipe', { userId: bUser.id, kind: 'turbo' })).status, 400);
    });
    await t('quem recebeu vê a Super Curtida em destaque (Plus) ou só a contagem (grátis)', async () => {
      const free = (await C.get('/api/likes-received')).data;
      assert.strictEqual(free.locked, true); assert.strictEqual(free.superCount, 1); assert.strictEqual(free.profiles.length, 0);
      await C.post('/api/billing/checkout', { plan: 'plus' });
      const plus = (await C.get('/api/likes-received')).data;
      assert.strictEqual(plus.locked, false); assert.strictEqual(plus.profiles[0].id, me.id); assert.strictEqual(plus.profiles[0].superLike, true);
    });
    await t('curtir de volta quem deu Super Curtida gera match', async () => {
      const r = await C.post('/api/swipe', { userId: me.id, kind: 'like' });
      assert.strictEqual(r.data.match, true);
    });
    await t('desfazer é recurso dos planos pagos e restaura o perfil na fila', async () => {
      assert.strictEqual((await A.post('/api/swipe/undo')).status, 402);
      await B.post('/api/billing/checkout', { plan: 'plus' });
      await B.post('/api/swipe', { userId: me.id, kind: 'pass' });
      assert.ok(!(await B.get('/api/discover?radius=10&limit=50')).data.profiles.some((p) => p.id === me.id));
      const u = await B.post('/api/swipe/undo');
      assert.strictEqual(u.status, 200); assert.strictEqual(u.data.profile.id, me.id);
      assert.ok((await B.get('/api/discover?radius=10&limit=50')).data.profiles.some((p) => p.id === me.id));
    });
    await t('não dá para desfazer uma escolha que virou match', async () => {
      await B.post('/api/swipe', { userId: me.id, kind: 'like' });
      await A.post('/api/billing/checkout', { plan: 'plus' }); // A precisa de Plus para curtir sem limite e responder
      const r = await A.post('/api/swipe', { userId: bUser.id, kind: 'like' });
      assert.strictEqual(r.data.match, true);
      const u = await A.post('/api/swipe/undo');
      assert.strictEqual(u.status, 409);
    });

    console.log('\nChat: mensagens grátis, Passe 24h e Cupido');
    let matchWithCaio;
    await t('plano grátis manda 3 mensagens por match; a 4ª pede plano ou Passe 24h', async () => {
      // A voltou a ser Plus acima; usa duas contas novas e grátis para este teste
      const X = new Client(), Y = new Client();
      const x = await mk(X, 'xuxa@teste.com', 'Xuxa'); const y = await mk(Y, 'yuri@teste.com', 'Yuri', { gender: 'm' });
      await X.post('/api/swipe', { userId: y.id, kind: 'like' });
      const m = await Y.post('/api/swipe', { userId: x.id, kind: 'like' });
      assert.strictEqual(m.data.match, true);
      const id = m.data.matchId;
      for (let i = 1; i <= 3; i++) { const r = await X.post(`/api/matches/${id}/messages`, { body: 'oi ' + i }); assert.strictEqual(r.status, 201); assert.strictEqual(r.data.trialLeft, 3 - i); }
      const blocked = await X.post(`/api/matches/${id}/messages`, { body: 'oi 4' });
      assert.strictEqual(blocked.status, 402); assert.strictEqual(blocked.data.code, 'trial_over'); assert.match(blocked.data.error, /Passe 24h/);
      const list = (await X.get('/api/matches')).data.matches.find((q) => q.id === id);
      assert.strictEqual(list.trialLeft, 0);
      assert.strictEqual((await X.get(`/api/matches/${id}/messages`)).data.trialLeft, 0);
      // o outro lado também é grátis e tem o próprio contador
      assert.strictEqual((await Y.post(`/api/matches/${id}/messages`, { body: 'oi!' })).data.trialLeft, 2);
      // Passe 24h libera, para todos os matches
      const buy = await X.post('/api/billing/checkout', { item: 'pass24h' });
      assert.strictEqual(buy.status, 200); assert.ok(Math.abs(buy.data.user.passUntil - (Date.now() + DAY)) < 60000); assert.strictEqual(buy.data.user.chatUnlocked, true);
      assert.strictEqual((await X.post(`/api/matches/${id}/messages`, { body: 'agora vai' })).status, 201);
      assert.strictEqual((await X.get('/api/matches')).data.matches.find((q) => q.id === id).trialLeft, null);
      // quando o passe vence, volta a valer o limite
      run('UPDATE users SET pass_until = ? WHERE id = ?', Date.now() - 1000, x.id);
      assert.strictEqual((await X.post(`/api/matches/${id}/messages`, { body: 'de novo' })).status, 402);
      matchWithCaio = { id, X, Y, x, y };
    });
    await t('mensagem de demonstração (bot) não gasta a cota de quem conversa', async () => {
      const Z = new Client(); await mk(Z, 'zeca@teste.com', 'Zeca', { gender: 'm' });
      const d = (await Z.get('/api/discover?radius=10&limit=50')).data.profiles;
      let mid = null;
      for (const p of d) { const r = await Z.post('/api/swipe', { userId: p.id, kind: 'like' }); if (r.data.match) { mid = r.data.matchId; break; } }
      assert.ok(mid, 'nenhum match com demo');
      await Z.post(`/api/matches/${mid}/messages`, { body: 'um' }); await sleep(2100);
      const msgs = (await Z.get(`/api/matches/${mid}/messages`)).data;
      assert.ok(msgs.messages.some((m) => !m.mine), 'bot não respondeu');
      assert.strictEqual(msgs.trialLeft, 2);
    });
    await t('Cupido sugere 3 mensagens a partir do perfil; mudar o parâmetro traz outras; só quem está no match vê', async () => {
      const { id, X } = matchWithCaio;
      const a = (await X.get(`/api/matches/${id}/icebreakers?n=0`)).data.suggestions;
      const b = (await X.get(`/api/matches/${id}/icebreakers?n=1`)).data.suggestions;
      assert.strictEqual(a.length, 3); assert.ok(a.every((x) => typeof x === 'string' && x.length > 10 && x.length <= 200));
      assert.notDeepStrictEqual(a, b);
      assert.deepStrictEqual(a, (await X.get(`/api/matches/${id}/icebreakers?n=0`)).data.suggestions);
      assert.strictEqual((await anon.get(`/api/matches/${id}/icebreakers`)).status, 401);
      assert.strictEqual((await B.get(`/api/matches/${id}/icebreakers`)).status, 404);
    });

    console.log('\nCompras: ciclos, destaque e pacote de fotos');
    await t('Plus trimestral: 90 dias, cobra o valor oficial e ignora preço enviado pelo cliente', async () => {
      const U = new Client(); await mk(U, 'ursula@teste.com', 'Ursula');
      const r = await U.post('/api/billing/checkout', { plan: 'plus', months: 3, amountCents: 1, priceCents: 1 });
      assert.strictEqual(r.status, 200);
      assert.ok(Math.abs(r.data.user.planUntil - (Date.now() + 90 * DAY)) < 60000);
      assert.strictEqual(one("SELECT amount_cents c FROM subscriptions WHERE plan = 'plus' AND user_id = ? ORDER BY id DESC", r.data.user.id).c, 6990);
      assert.strictEqual((await U.post('/api/billing/checkout', { plan: 'plus', months: 2 })).status, 400);
      assert.strictEqual((await U.post('/api/billing/checkout', { item: 'ouro' })).status, 400);
      assert.strictEqual((await U.post('/api/billing/checkout', { plan: 'plus', months: -3 })).status, 400);
    });
    await t('Premium dá raio de 100 km e o mapa conta pessoas até 100 km', async () => {
      const P = new Client(); const pu = await mk(P, 'paulo@teste.com', 'Paulo', { gender: 'm' });
      await P.post('/api/billing/checkout', { plan: 'premium', months: 6 });
      assert.strictEqual((await P.get('/api/me')).data.user.limits.maxRadius, 100);
      assert.strictEqual((await P.get('/api/discover?radius=100')).data.radius, 100);
      assert.strictEqual((await A.get('/api/discover?radius=100')).data.radius, 50, 'Plus continua em 50');
      assert.deepStrictEqual((await P.get('/api/discover/count')).data.rings.map((r) => r.km), [1, 5, 10, 25, 50, 100]);
      assert.ok(Math.abs((await P.get('/api/me')).data.user.planUntil - (Date.now() + 180 * DAY)) < 60000);
    });
    await t('Destaque de 30 min coloca o perfil em primeiro na fila dos outros e some quando vence', async () => {
      const R = new Client(), V = new Client();
      const r = await mk(R, 'rita@teste.com', 'Rita'); await mk(V, 'vera@teste.com', 'Vera');
      const q = '/api/discover?radius=10&limit=50';
      const before = (await V.get(q)).data.profiles;
      const pos = before.findIndex((p) => p.id === r.id);
      assert.ok(pos >= 0, 'Rita precisa aparecer para a Vera');
      const buy = await R.post('/api/billing/checkout', { item: 'boost30m' });
      assert.ok(Math.abs(buy.data.user.boostUntil - (Date.now() + 30 * 60000)) < 60000);
      const after = (await V.get(q)).data.profiles;
      assert.strictEqual(after[0].id, r.id); assert.strictEqual(after[0].boosted, true);
      assert.strictEqual(after.filter((p) => p.boosted).length, 1);
      run('UPDATE users SET boost_until = ? WHERE id = ?', Date.now() - 1000, r.id);
      const expired = (await V.get(q)).data.profiles;
      assert.strictEqual(expired.findIndex((p) => p.id === r.id), pos);
      assert.ok(expired.every((p) => !p.boosted));
    });
    await t('Pacote de 3 fotos: libera as extras de 3 perfis, só uma vez por perfil, e acaba', async () => {
      const Q = new Client(); await mk(Q, 'quincas@teste.com', 'Quincas', { gender: 'm' });
      const withExtras = (await Q.get('/api/discover?radius=10&limit=50')).data.profiles.filter((p) => p.extraLocked);
      assert.ok(withExtras.length >= 4, 'preciso de 4 perfis com fotos extras');
      assert.strictEqual((await Q.post(`/api/users/${withExtras[0].id}/unlock-photos`)).data.code, 'no_credits');
      const buy = await Q.post('/api/billing/checkout', { item: 'photos3' }); assert.strictEqual(buy.data.user.photoCredits, 3);
      const first = withExtras[0];
      const ph = await Q.get(`/api/photos/${first.id}`); void ph;
      const r1 = await Q.post(`/api/users/${first.id}/unlock-photos`);
      assert.strictEqual(r1.status, 200); assert.strictEqual(r1.data.user.photoCredits, 2);
      assert.ok(r1.data.profile.extraPhotoIds.length > 0); assert.strictEqual(r1.data.profile.extraLocked, false);
      const extraId = r1.data.profile.extraPhotoIds[0];
      assert.strictEqual((await Q.get(`/api/photos/${extraId}`)).status, 200);
      assert.strictEqual((await Q.post(`/api/users/${first.id}/unlock-photos`)).data.user.photoCredits, 2, 'repetir não gasta crédito');
      await Q.post(`/api/users/${withExtras[1].id}/unlock-photos`); await Q.post(`/api/users/${withExtras[2].id}/unlock-photos`);
      assert.strictEqual((await Q.get('/api/me')).data.user.photoCredits, 0);
      const noMore = await Q.post(`/api/users/${withExtras[3].id}/unlock-photos`);
      assert.strictEqual(noMore.status, 402); assert.strictEqual(noMore.data.code, 'no_credits');
      const other = (await Q.get('/api/discover?radius=10&limit=50')).data.profiles.find((p) => p.id === withExtras[3].id);
      assert.strictEqual(other.extraLocked, true);
      assert.strictEqual((await Q.post('/api/users/999999/unlock-photos')).status, 404);
      // foto extra de quem NÃO foi desbloqueado continua bloqueada
      const lockedExtra = one("SELECT id FROM photos WHERE user_id = ? AND is_main = 0 AND status = 'ok' LIMIT 1", withExtras[3].id).id;
      assert.strictEqual((await Q.get(`/api/photos/${lockedExtra}`)).status, 402);
    });

    console.log('\nVerificação por selfie');
    await t('exige foto principal, entrega uma pose e recebe a selfie', async () => {
      const N = new Client(); await N.post('/api/auth/register', reg('nina@teste.com', 'Nina'));
      assert.strictEqual((await N.post('/api/me/verification/start')).status, 400, 'sem foto principal');
      await N.post('/api/me/photos', photo());
      assert.strictEqual((await N.get('/api/me/verification')).data.status, 'none');
      const st = (await N.post('/api/me/verification/start')).data;
      assert.strictEqual(st.status, 'draft'); assert.ok(st.pose.length > 10);
      assert.strictEqual((await N.post('/api/me/verification/start')).data.pose, st.pose, 'mesma pose enquanto o pedido está aberto');
      assert.strictEqual((await N.req('POST', '/api/me/verification', photo('selfie'))).status, 201);
      assert.strictEqual((await N.get('/api/me/verification')).data.status, 'pending');
      assert.strictEqual((await N.post('/api/me/verification/start')).status, 400, 'já em análise');
      const bad = new FormData(); bad.append('selfie', new Blob(['nao sou imagem'], { type: 'image/png' }), 'x.png');
      assert.strictEqual((await B.req('POST', '/api/me/verification', bad)).status, 400);
    });
    await t('só administrador vê a fila e a selfie; a selfie não é servida como foto de perfil', async () => {
      assert.strictEqual((await B.get('/api/admin/verifications')).status, 403);
      assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const q = (await ADM.get('/api/admin/verifications')).data.verifications;
      assert.strictEqual(q.length, 1); assert.ok(q[0].pose && q[0].mainPhotoId);
      assert.strictEqual((await B.get(`/api/admin/verifications/${q[0].id}/photo`)).status, 403);
      const img = await ADM.get(`/api/admin/verifications/${q[0].id}/photo`);
      assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/jpeg'); assert.match(img.headers.get('cache-control'), /no-store/);
      assert.strictEqual((await ADM.get('/api/admin/stats')).data.pendingVerifications, 1);
      const files = fs.readdirSync(path.join(DATA_DIR, 'uploads')).filter((f) => f.startsWith('v_'));
      assert.strictEqual(files.length, 1);
    });
    await t('aprovar dá o selo, apaga a selfie do disco e registra na auditoria', async () => {
      const id = (await ADM.get('/api/admin/verifications')).data.verifications[0].id;
      assert.strictEqual((await ADM.post(`/api/admin/verifications/${id}/decide`, { action: 'talvez' })).status, 400);
      assert.strictEqual((await ADM.post(`/api/admin/verifications/${id}/decide`, { action: 'approve' })).status, 200);
      assert.strictEqual(one("SELECT verified v FROM users WHERE email = 'nina@teste.com'").v, 1);
      assert.strictEqual(fs.readdirSync(path.join(DATA_DIR, 'uploads')).filter((f) => f.startsWith('v_')).length, 0);
      assert.strictEqual(one('SELECT filename f FROM verifications WHERE id = ?', id).f, null);
      assert.strictEqual((await ADM.post(`/api/admin/verifications/${id}/decide`, { action: 'approve' })).status, 404, 'não decide duas vezes');
      assert.ok((await ADM.get('/api/admin/audit')).data.log.some((l) => l.action === 'verification_approve'));
      assert.strictEqual((await ADM.get(`/api/admin/verifications/${id}/photo`)).status, 404);
    });
    await t('recusar mostra o motivo, não dá selo e permite tentar de novo', async () => {
      const M = new Client(); await mk(M, 'maria@teste.com', 'Maria');
      await M.post('/api/me/verification/start'); await M.req('POST', '/api/me/verification', photo('selfie'));
      const id = (await ADM.get('/api/admin/verifications')).data.verifications[0].id;
      await ADM.post(`/api/admin/verifications/${id}/decide`, { action: 'reject', reason: 'Rosto não aparece' });
      const v = (await M.get('/api/me/verification')).data;
      assert.strictEqual(v.status, 'rejected'); assert.strictEqual(v.reason, 'Rosto não aparece'); assert.strictEqual(v.verified, false);
      assert.strictEqual((await M.post('/api/me/verification/start')).status, 200);
    });
    await t('apagar a conta apaga a selfie pendente', async () => {
      const D = new Client(); await mk(D, 'dani@teste.com', 'Dani');
      await D.post('/api/me/verification/start'); await D.req('POST', '/api/me/verification', photo('selfie'));
      assert.strictEqual(fs.readdirSync(path.join(DATA_DIR, 'uploads')).filter((f) => f.startsWith('v_')).length, 1);
      assert.strictEqual((await D.req('DELETE', '/api/me', { password: 'senha-forte-123' })).status, 200);
      await sleep(200);
      assert.strictEqual(fs.readdirSync(path.join(DATA_DIR, 'uploads')).filter((f) => f.startsWith('v_')).length, 0);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.stack); }
  finally { srv.kill(); }

  console.log('\nMigração de banco antigo');
  await (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-mig-'));
    const e2 = { ...process.env, DATA_DIR: dir };
    spawnSync('node', ['-e', "require('./db')"], { env: e2 });
    const d = new DatabaseSync(path.join(dir, 'pertinho.db'));
    d.exec("PRAGMA foreign_keys = OFF; DROP TABLE swipes; CREATE TABLE swipes (from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('like','pass')), created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));");
    d.exec("INSERT INTO users (email, pass_hash, name, birth_date, gender, created_at) VALUES ('a@x.com','h','A','1990-01-01','f',1),('b@x.com','h','B','1990-01-01','m',1); INSERT INTO swipes VALUES (1,2,'like',5);");
    d.exec('ALTER TABLE users DROP COLUMN anthem; ALTER TABLE users DROP COLUMN pass_until; ALTER TABLE users DROP COLUMN boost_until; ALTER TABLE users DROP COLUMN photo_credits; ALTER TABLE payments DROP COLUMN item; ALTER TABLE payments DROP COLUMN months;');
    d.close();
    const r = spawnSync('node', ['-e', "const {db}=require('./db'); db.prepare(\"INSERT INTO swipes VALUES (2,1,'super',9)\").run(); console.log(JSON.stringify({rows: db.prepare('SELECT from_id,to_id,kind FROM swipes ORDER BY from_id').all(), cols: db.prepare('PRAGMA table_info(users)').all().map(c=>c.name).filter(n=>['anthem','pass_until','boost_until','photo_credits'].includes(n)).length, pay: db.prepare('PRAGMA table_info(payments)').all().map(c=>c.name).filter(n=>['item','months'].includes(n)).length}))"], { env: e2, encoding: 'utf8' });
    await t('banco antigo sobe, mantém as curtidas e passa a aceitar super curtida', async () => {
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepStrictEqual(out.rows, [{ from_id: 1, to_id: 2, kind: 'like' }, { from_id: 2, to_id: 1, kind: 'super' }]);
      assert.strictEqual(out.cols, 4); assert.strictEqual(out.pay, 2);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  })();

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
