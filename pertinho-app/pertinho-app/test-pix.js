'use strict';
// Teste do pagamento por Pix com um Asaas FALSO (mock-asaas.js). Nada aqui toca o Asaas de verdade.
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { createMock } = require('./mock-asaas');

const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-pix-'));
const KEY = 'chave_de_teste_do_mock';
const TOKEN = 'token-do-webhook-com-bem-mais-de-32-caracteres-123';
const CPF = '52998224725'; // CPF de teste com dígitos válidos
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sp = (offset) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * DAY));

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET' && !('x-pertinho' in h) && !url.startsWith('/api/webhooks')) h['x-pertinho'] = '1';
    let payload;
    if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    let data = null; try { data = await res.json(); } catch (e) { /* sem corpo */ }
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b, h) { return this.req('POST', u, b ?? {}, h); }
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FALHOU ' + name + '\n         ' + String(e.message || e).split('\n')[0]); }
}
async function until(fn, ms = 6000, label = 'condição') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('tempo esgotado esperando: ' + label); await sleep(100); }
}
const { nextCpf, stopChild } = require('./test-util');
const reg = (email, name) => ({ cpf: nextCpf(), email, password: 'senha-forte-123', name, birthDate: '1992-04-10', gender: 'f', seeking: 'all', cityId: 'campinas-sp', terms: true });
const baseEnv = (extra = {}) => ({ ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'test', ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'asaas', ASAAS_API_KEY: KEY, ASAAS_WEBHOOK_TOKEN: TOKEN, ASAAS_ENV: 'sandbox', PIX_SWEEP_MS: '600', PIX_RETRY_MS: '300', PIX_RENEWAL_MS: '800', PIX_LIMIT_PER_HOUR: '500', ...extra });

(async () => {
  const mock = createMock({ apiKey: KEY, webhookUrl: `${BASE}/api/webhooks/asaas`, webhookToken: TOKEN });
  const mockPort = await mock.listen(0);
  const env = baseEnv({ ASAAS_BASE_URL: `http://127.0.0.1:${mockPort}/v3` });
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  const dbq = () => new DatabaseSync(path.join(DATA_DIR, 'pertinho.db'));
  const one = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).get(...a); } finally { d.close(); } };
  const run = (sql, ...a) => { const d = dbq(); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
  const hook = (event, asaasId, token = TOKEN, id = 'evt_manual_' + Math.random().toString(36).slice(2)) =>
    new Client().req('POST', '/api/webhooks/asaas', { id, event, payment: { object: 'payment', id: asaasId } }, token === null ? {} : { 'asaas-access-token': token });

  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const A = new Client(), B = new Client(), ADM = new Client(), anon = new Client();
    let ana, payA, payB, payPrem;

    console.log('\nCobrança Pix');
    await t('a API informa que os pagamentos estão ativos', async () => {
      const r = (await anon.get('/api/plans')).data; assert.strictEqual(r.paymentsEnabled, true); assert.strictEqual(r.paymentsMode, 'asaas');
    });
    await t('exige login e plano válido', async () => {
      assert.strictEqual((await anon.post('/api/billing/pix', { plan: 'plus' })).status, 401);
      ana = (await A.post('/api/auth/register', reg('ana@teste.com', 'Ana'))).data.user;
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'free' })).status, 400);
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'ouro' })).status, 400);
    });
    await t('primeira compra pede nome completo e CPF válidos', async () => {
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'plus' })).status, 400);
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'plus', cpfCnpj: '111.111.111-11', fullName: 'Ana Maria Souza' })).status, 400);
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'plus', cpfCnpj: '529.982.247-26', fullName: 'Ana Maria Souza' })).status, 400, 'dígito verificador errado');
      assert.strictEqual((await A.post('/api/billing/pix', { plan: 'plus', cpfCnpj: CPF, fullName: 'Ana' })).status, 400, 'só um nome');
      assert.strictEqual(mock.state.customers.size, 0, 'nada deveria ter ido ao Asaas');
    });
    await t('gera o Pix com QR Code e código copia e cola', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'plus', cpfCnpj: '529.982.247-25', fullName: 'Ana Maria Souza' });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      payA = r.data.payment;
      assert.strictEqual(payA.status, 'pending'); assert.strictEqual(payA.amountCents, 2990);
      assert.match(payA.payload, /^0002/); assert.match(payA.image, /^[A-Za-z0-9+/=]+$/);
      assert.ok(payA.expiresAt > Date.now() + 20 * 3600000);
    });
    await t('o pedido ao Asaas leva chave, User-Agent, valor, referência e vencimento corretos', async () => {
      const cust = mock.state.requests.find((x) => x.path === '/v3/customers');
      const pay = mock.state.requests.find((x) => x.path === '/v3/payments' && x.method === 'POST');
      assert.strictEqual(cust.headers.access_token, KEY); assert.match(cust.headers['user-agent'], /^Pertinho/);
      assert.strictEqual(cust.body.cpfCnpj, CPF); assert.strictEqual(cust.body.name, 'Ana Maria Souza');
      assert.strictEqual(pay.body.billingType, 'PIX'); assert.strictEqual(pay.body.value, 29.9);
      assert.strictEqual(pay.body.externalReference, payA.ref); assert.strictEqual(pay.body.dueDate, sp(1));
      assert.ok(!mock.state.requests.some((x) => x.method === 'GET' && x.headers['content-length'] > 0));
    });
    await t('o CPF não fica guardado no nosso banco', async () => {
      const files = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('pertinho.db'));
      for (const f of files) assert.ok(!fs.readFileSync(path.join(DATA_DIR, f)).includes(CPF), 'CPF encontrado em ' + f);
    });
    await t('pedir de novo reaproveita a mesma cobrança (sem duplicar)', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'plus' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.payment.ref, payA.ref);
      assert.strictEqual(mock.state.payments.size, 1);
    });
    await t('o status mostra o Pix pendente e que o cliente já existe', async () => {
      const s = (await A.get('/api/billing/status')).data;
      assert.strictEqual(s.pending.ref, payA.ref); assert.strictEqual(s.needsCustomer, false); assert.strictEqual(s.sandbox, true); assert.strictEqual(s.plan, 'free');
    });
    await t('trocar de plano cancela a cobrança anterior também no Asaas', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'premium' });
      assert.strictEqual(r.status, 201); payPrem = r.data.payment; assert.notStrictEqual(payPrem.ref, payA.ref); assert.strictEqual(payPrem.amountCents, 4990);
      assert.strictEqual(one('SELECT status FROM payments WHERE ref = ?', payA.ref).status, 'canceled');
      assert.strictEqual(mock.paymentByRef(payA.ref).deleted, true);
    });
    await t('falha do Asaas vira erro claro, sem vazar detalhes e sem deixar cobrança pendurada', async () => {
      const before = one('SELECT COUNT(*) c FROM payments').c;
      B.cookie = ''; await B.post('/api/auth/register', reg('bia@teste.com', 'Bia'));
      mock.fail({ method: 'POST', path: '/v3/payments', status: 500 });
      const r = await B.post('/api/billing/pix', { plan: 'plus', cpfCnpj: CPF, fullName: 'Beatriz Lima Costa' });
      assert.strictEqual(r.status, 502); assert.ok(!/Falha simulada|500|asaas/i.test(r.data.error), r.data.error);
      assert.strictEqual(one('SELECT COUNT(*) c FROM payments').c, before);
    });

    console.log('\nWebhook: segurança');
    await t('sem token ou com token errado: 401', async () => {
      assert.strictEqual((await hook('PAYMENT_RECEIVED', 'pay_x', null)).status, 401);
      assert.strictEqual((await hook('PAYMENT_RECEIVED', 'pay_x', 'token-errado-token-errado-token-errado')).status, 401);
      assert.strictEqual(one('SELECT COUNT(*) c FROM webhook_events').c, 0);
    });
    await t('aviso malformado: 400', async () => {
      assert.strictEqual((await new Client().req('POST', '/api/webhooks/asaas', { foo: 1 }, { 'asaas-access-token': TOKEN })).status, 400);
    });
    await t('ATAQUE: aviso falso de pagamento com o token certo, mas sem pagamento no Asaas, não libera o plano', async () => {
      const aid = mock.paymentByRef(payPrem.ref).id;
      const r = await hook('PAYMENT_RECEIVED', aid); assert.strictEqual(r.status, 200);
      await until(() => one("SELECT status FROM webhook_events WHERE event_id = ?", r.data && 'x') || one("SELECT 1 x FROM webhook_events WHERE status = 'done'"), 4000, 'evento processado');
      await sleep(400);
      assert.strictEqual((await A.get('/api/me')).data.user.plan, 'free');
      assert.strictEqual(one('SELECT status FROM payments WHERE ref = ?', payPrem.ref).status, 'pending');
    });
    await t('evento de cobrança desconhecida é aceito e ignorado (para o Asaas não ficar reenviando)', async () => {
      assert.strictEqual((await hook('PAYMENT_RECEIVED', 'pay_que_nao_existe')).status, 200);
      assert.strictEqual((await hook('PAYMENT_BANK_SLIP_VIEWED', 'pay_x')).data.ignored, true);
    });

    console.log('\nPagamento confirmado');
    let until1;
    await t('Pix pago no Asaas: o webhook libera o Premium por 30 dias', async () => {
      const aid = mock.paymentByRef(payPrem.ref).id;
      await mock.pay(aid);
      const u = await until(async () => { const m = (await A.get('/api/me')).data.user; return m.plan === 'premium' ? m : null; }, 6000, 'plano premium');
      until1 = u.planUntil;
      assert.ok(Math.abs(until1 - (Date.now() + 30 * DAY)) < 120000);
      const row = one('SELECT status, paid_at, granted_until FROM payments WHERE ref = ?', payPrem.ref);
      assert.strictEqual(row.status, 'paid'); assert.strictEqual(row.granted_until, until1);
      assert.strictEqual(one("SELECT COUNT(*) c FROM subscriptions WHERE provider = 'asaas' AND status = 'paid'").c, 1);
    });
    await t('o mesmo aviso reenviado (entrega duplicada) não soma outros 30 dias', async () => {
      const ev = mock.state.webhooks.find((w) => w.event === 'PAYMENT_RECEIVED');
      const r = await hook('PAYMENT_RECEIVED', ev.payment.id, TOKEN, ev.id);
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.duplicate, true);
      await sleep(500);
      assert.strictEqual((await A.get('/api/me')).data.user.planUntil, until1);
    });
    await t('o plano pago libera os recursos (raio de 50 km) e o modo invisível', async () => {
      const d = (await A.get('/api/discover?radius=50')).data; assert.strictEqual(d.radius, 50);
      assert.strictEqual((await A.req('PATCH', '/api/me', { invisible: true })).data.user.invisible, true);
    });
    await t('ATAQUE: valor adulterado no Asaas não libera nada', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'premium' }); assert.strictEqual(r.status, 201);
      const ref = r.data.payment.ref; const aid = mock.paymentByRef(ref).id;
      mock.tamper(aid, { value: 1 }); await mock.pay(aid);
      await until(() => /valor diferente/.test(one('SELECT note FROM payments WHERE ref = ?', ref).note || ''), 5000, 'alerta de valor');
      assert.strictEqual(one('SELECT status FROM payments WHERE ref = ?', ref).status, 'pending');
      assert.strictEqual((await A.get('/api/me')).data.user.planUntil, until1);
      await A.post(`/api/billing/pix/${ref}/cancel`);
    });
    await t('renovar antes do fim soma 30 dias ao que ainda resta', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'premium' }); const ref = r.data.payment.ref;
      await mock.pay(mock.paymentByRef(ref).id);
      const u = await until(async () => { const m = (await A.get('/api/me')).data.user; return m.planUntil > until1 ? m : null; }, 6000, 'renovação');
      assert.ok(Math.abs(u.planUntil - (until1 + 30 * DAY)) < 1000);
      until1 = u.planUntil;
    });
    await t('sem webhook, a própria tela de pagamento confere no Asaas e libera', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'premium' }); const ref = r.data.payment.ref;
      await mock.pay(mock.paymentByRef(ref).id, { silent: true });
      const st = await until(async () => { const x = (await A.get(`/api/billing/pix/${ref}`)).data.payment; return x.status === 'paid' ? x : null; }, 6000, 'conferência pela tela');
      assert.strictEqual(st.payload, null, 'não devolve mais o QR Code depois de pago');
      assert.ok((await A.get('/api/me')).data.user.planUntil > until1);
      until1 = (await A.get('/api/me')).data.user.planUntil;
    });
    await t('Asaas fora do ar no momento do aviso: o evento é guardado e reprocessado sozinho', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'premium' }); const ref = r.data.payment.ref; const aid = mock.paymentByRef(ref).id;
      mock.fail({ method: 'GET', path: '/v3/payments/', status: 503, times: 2 });
      await mock.pay(aid);
      await until(() => one("SELECT attempts, error FROM webhook_events WHERE asaas_payment_id = ? ORDER BY received_at DESC", aid)?.error, 4000, 'primeira falha registrada');
      await until(() => one('SELECT status FROM payments WHERE ref = ?', ref).status === 'paid', 8000, 'pago após nova tentativa');
      assert.ok(one('SELECT attempts FROM webhook_events WHERE asaas_payment_id = ?', aid).attempts >= 2);
      until1 = (await A.get('/api/me')).data.user.planUntil;
    });

    console.log('\nEstorno, expiração e renovação');
    await t('estorno devolve 30 dias: o plano encurta e o pagamento fica como estornado', async () => {
      const last = one("SELECT ref, granted_until FROM payments WHERE status = 'paid' ORDER BY id DESC LIMIT 1");
      assert.strictEqual(last.granted_until, until1);
      await mock.refund(mock.paymentByRef(last.ref).id);
      await until(() => one('SELECT status FROM payments WHERE ref = ?', last.ref).status === 'refunded', 6000, 'estorno');
      const now = (await A.get('/api/me')).data.user;
      assert.ok(Math.abs(now.planUntil - (until1 - 30 * DAY)) < 1000);
      assert.strictEqual(one("SELECT COUNT(*) c FROM subscriptions WHERE status = 'refunded'").c, 1);
      until1 = now.planUntil;
    });
    await t('Pix não pago em 24 h expira e a cobrança é removida do Asaas', async () => {
      const r = await A.post('/api/billing/pix', { plan: 'plus' }); const ref = r.data.payment.ref;
      run('UPDATE payments SET expires_at = ? WHERE ref = ?', Date.now() - 1000, ref);
      await until(() => one('SELECT status FROM payments WHERE ref = ?', ref).status === 'expired', 6000, 'expirar');
      assert.strictEqual(mock.paymentByRef(ref).deleted, true);
      assert.strictEqual((await A.get('/api/billing/status')).data.pending, null);
    });
    await t('cancelar a assinatura só desliga a renovação: o plano segue até o fim', async () => {
      const r = await A.post('/api/billing/cancel'); assert.strictEqual(r.status, 200);
      const u = (await A.get('/api/me')).data.user; assert.strictEqual(u.plan, 'premium'); assert.strictEqual(u.renewalOff, true); assert.strictEqual(u.planUntil, until1);
    });
    await t('perto do vencimento o sistema gera sozinho a cobrança de renovação', async () => {
      run('UPDATE users SET plan_until = ?, renewal_off = 0 WHERE id = ?', Date.now() + 2 * DAY, ana.id);
      await until(async () => (await A.get('/api/billing/status')).data.pending, 8000, 'cobrança de renovação');
      const s = (await A.get('/api/billing/status')).data;
      assert.strictEqual(s.renewalDue, true); assert.strictEqual(s.daysLeft, 2);
      assert.strictEqual(one('SELECT renewal FROM payments WHERE ref = ?', s.pending.ref).renewal, 1);
    });
    await t('quem desligou a renovação não recebe cobrança automática', async () => {
      await A.post('/api/billing/renewal', { off: true });
      const pend = (await A.get('/api/billing/status')).data.pending;
      await A.post(`/api/billing/pix/${pend.ref}/cancel`);
      const n = one('SELECT COUNT(*) c FROM payments').c;
      await sleep(2500);
      assert.strictEqual(one('SELECT COUNT(*) c FROM payments').c, n);
    });

    console.log('\nCiclos e compras avulsas por Pix');
    const D = new Client();
    let dUser;
    await t('plano trimestral: cobra o valor do ciclo e libera 90 dias', async () => {
      dUser = (await D.post('/api/auth/register', reg('dora@teste.com', 'Dora'))).data.user;
      assert.strictEqual((await D.post('/api/billing/pix', { plan: 'plus', months: 2, cpfCnpj: CPF, fullName: 'Dora Alves Pinto' })).status, 400, 'ciclo inexistente');
      assert.strictEqual((await D.post('/api/billing/pix', { item: 'ouro', cpfCnpj: CPF, fullName: 'Dora Alves Pinto' })).status, 400, 'item inexistente');
      const r = await D.post('/api/billing/pix', { plan: 'plus', months: 3, amountCents: 1, cpfCnpj: CPF, fullName: 'Dora Alves Pinto' });
      assert.strictEqual(r.status, 201, JSON.stringify(r.data)); assert.strictEqual(r.data.payment.amountCents, 6990); assert.match(r.data.payment.label, /3 meses/);
      const ap = mock.paymentByRef(r.data.payment.ref); assert.strictEqual(ap.value, 69.9); assert.match(ap.description, /3 meses/);
      await mock.pay(ap.id);
      const u = await until(async () => { const m = (await D.get('/api/me')).data.user; return m.plan === 'plus' ? m : null; }, 6000, 'plus trimestral');
      assert.ok(Math.abs(u.planUntil - (Date.now() + 90 * DAY)) < 120000);
    });
    await t('cada ciclo tem a sua cobrança; pedir o mesmo ciclo reaproveita', async () => {
      const a = await D.post('/api/billing/pix', { plan: 'plus', months: 6 });
      const b = await D.post('/api/billing/pix', { plan: 'plus', months: 6 });
      assert.strictEqual(a.data.payment.ref, b.data.payment.ref); assert.strictEqual(a.data.payment.amountCents, 11990);
      const c = await D.post('/api/billing/pix', { plan: 'plus', months: 1 });
      assert.notStrictEqual(c.data.payment.ref, a.data.payment.ref);
      assert.strictEqual(one('SELECT status FROM payments WHERE ref = ?', a.data.payment.ref).status, 'canceled');
      await D.post(`/api/billing/pix/${c.data.payment.ref}/cancel`);
    });
    await t('Passe 24h por Pix: libera o chat por 24 h e o estorno retira', async () => {
      const r = await D.post('/api/billing/pix', { item: 'pass24h' }); assert.strictEqual(r.status, 201); assert.strictEqual(r.data.payment.amountCents, 690);
      const aid = mock.paymentByRef(r.data.payment.ref).id;
      await mock.pay(aid);
      const u = await until(async () => { const m = (await D.get('/api/me')).data.user; return m.passUntil ? m : null; }, 6000, 'passe 24h');
      assert.ok(Math.abs(u.passUntil - (Date.now() + DAY)) < 120000); assert.strictEqual(u.plan, 'plus', 'o plano não muda');
      await mock.refund(aid);
      await until(() => one('SELECT status FROM payments WHERE ref = ?', r.data.payment.ref).status === 'refunded', 6000, 'estorno do passe');
      assert.strictEqual((await D.get('/api/me')).data.user.passUntil, null);
    });
    await t('Destaque e pacote de fotos por Pix', async () => {
      const b = await D.post('/api/billing/pix', { item: 'boost30m' }); assert.strictEqual(b.data.payment.amountCents, 990);
      await mock.pay(mock.paymentByRef(b.data.payment.ref).id);
      const u1 = await until(async () => { const m = (await D.get('/api/me')).data.user; return m.boostUntil ? m : null; }, 6000, 'destaque');
      assert.ok(Math.abs(u1.boostUntil - (Date.now() + 30 * 60000)) < 120000);
      const f = await D.post('/api/billing/pix', { item: 'photos3' }); assert.strictEqual(f.data.payment.amountCents, 790);
      const fid = mock.paymentByRef(f.data.payment.ref).id; await mock.pay(fid);
      await until(async () => (await D.get('/api/me')).data.user.photoCredits === 3, 6000, 'créditos de foto');
      await mock.pay(fid); // pagamento já processado: repetir o aviso não soma de novo
      await hook('PAYMENT_RECEIVED', fid); await sleep(600);
      assert.strictEqual((await D.get('/api/me')).data.user.photoCredits, 3);
    });
    await t('renovação automática usa o mesmo ciclo da última compra do plano', async () => {
      run('UPDATE users SET plan_until = ?, renewal_off = 0 WHERE id = ?', Date.now() + 2 * DAY, dUser.id);
      const pend = await until(async () => (await D.get('/api/billing/status')).data.pending, 8000, 'renovação');
      assert.strictEqual(pend.amountCents, 6990); assert.strictEqual(pend.months, 3);
      await D.post(`/api/billing/pix/${pend.ref}/cancel`);
    });

    console.log('\nIsolamento e painel ADM');
    await t('outra pessoa não vê nem cancela o pagamento alheio', async () => {
      const ref = one("SELECT ref FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1", ana.id).ref;
      assert.strictEqual((await B.get(`/api/billing/pix/${ref}`)).status, 404);
      assert.strictEqual((await B.post(`/api/billing/pix/${ref}/cancel`)).status, 404);
      assert.strictEqual((await anon.get(`/api/billing/pix/${ref}`)).status, 401);
    });
    await t('o painel ADM lista cobranças e permite conferir no Asaas; usuário comum não acessa', async () => {
      assert.strictEqual((await ADM.post('/api/auth/login', { email: 'admin@teste.com', password: 'SenhaAdmin#123' })).status, 200);
      const r = (await ADM.get('/api/admin/payments')).data;
      assert.ok(r.payments.length >= 6); assert.strictEqual(r.sandbox, true); assert.ok(r.payments.some((p) => p.status === 'refunded') && r.payments.some((p) => p.status === 'paid'));
      assert.strictEqual((await ADM.post(`/api/admin/payments/${r.payments[0].id}/check`)).status, 200);
      assert.strictEqual((await A.get('/api/admin/payments')).status, 403);
      const s = (await ADM.get('/api/admin/stats')).data; assert.strictEqual(s.asaasEnv, 'sandbox'); assert.strictEqual(typeof s.pixPending, 'number');
    });
    await t('apagar a conta preserva o registro financeiro, sem vínculo com a pessoa', async () => {
      const before = one('SELECT COUNT(*) c FROM payments').c;
      assert.strictEqual((await B.req('DELETE', '/api/me', { password: 'senha-forte-123' })).status, 200);
      assert.strictEqual((await D.req('DELETE', '/api/me', { password: 'senha-forte-123' })).status, 200);
      assert.strictEqual((await A.req('DELETE', '/api/me', { password: 'senha-forte-123' })).status, 200);
      assert.strictEqual(one('SELECT COUNT(*) c FROM payments').c, before);
      assert.strictEqual(one('SELECT COUNT(*) c FROM payments WHERE user_id IS NOT NULL').c, 0);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.stack); }
  finally { await stopChild(srv); await mock.close(); }

  console.log('\nConfiguração na inicialização');
  const boot = (extra) => spawnSync('node', ['server.js'], { env: baseEnv({ DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-cfg-')), PORT: '3994', ...extra }), encoding: 'utf8', timeout: 8000 });
  await t('recusa iniciar em modo asaas sem a chave da API', async () => { const r = boot({ ASAAS_API_KEY: '' }); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /ASAAS_API_KEY/); });
  await t('recusa token de webhook curto demais', async () => { const r = boot({ ASAAS_WEBHOOK_TOKEN: 'curto' }); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /ASAAS_WEBHOOK_TOKEN/); });
  await t('recusa token de webhook igual à chave da API', async () => { const k = 'k'.repeat(40); const r = boot({ ASAAS_API_KEY: k, ASAAS_WEBHOOK_TOKEN: k }); assert.notStrictEqual(r.status, 0); });
  await t('recusa modo de pagamento desconhecido', async () => { const r = boot({ PAYMENTS_MODE: 'bitcoin' }); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /PAYMENTS_MODE/); });

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
