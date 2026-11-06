'use strict';
// Pagamento por Pix via Asaas: cobrança, QR Code, webhook, conferência, renovação e painel ADM.
const crypto = require('crypto');
const { AsaasError } = require('./asaas');

const DAY = 86400000;
const PIX_TTL = DAY; // o QR Code vale 24 horas dentro do app
// Ajustes pensados para testes; em produção valem os padrões.
const SWEEP_MS = Number(process.env.PIX_SWEEP_MS) || 60000;
const RETRY_MS = Number(process.env.PIX_RETRY_MS) || 15000;
const RENEWAL_MS = Number(process.env.PIX_RENEWAL_MS) || 3600000;
const PIX_LIMIT = Number(process.env.PIX_LIMIT_PER_HOUR) || 12;
const PAID = new Set(['RECEIVED', 'CONFIRMED']);
const RELEVANT = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'PAYMENT_REFUND_IN_PROGRESS', 'PAYMENT_DELETED', 'PAYMENT_CHARGEBACK_REQUESTED']);

const spDate = (offsetDays) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offsetDays * DAY));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const log = (...a) => console.log('[pix]', ...a);

module.exports = function mountBilling({ app, admin, db, L, grants, requireAuth, HttpError, now, audit, rateLimit, client, webhookToken }) {
  const getById = db.prepare('SELECT * FROM payments WHERE id = ?');
  const getByRef = db.prepare('SELECT * FROM payments WHERE ref = ?');
  const getByAsaas = db.prepare('SELECT * FROM payments WHERE asaas_payment_id = ?');
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const inflight = new Set();
  const processing = new Set();

  const labelOf = (p) => (p.item === 'shop' ? (L.SHOP[p.plan] || {}).name || p.plan : `Plano ${(L.PLANS[p.plan] || {}).name || p.plan} - ${p.months === 1 ? '1 mês' : p.months + ' meses'}`);
  const toJson = (p) => ({
    ref: p.ref, plan: p.plan, item: p.item, months: p.months, label: labelOf(p), amountCents: p.amount_cents, status: p.status,
    payload: p.status === 'pending' ? p.pix_payload : null,
    image: p.status === 'pending' ? p.pix_image : null,
    expiresAt: p.expires_at, paidAt: p.paid_at, createdAt: p.created_at,
  });

  // Erros do Asaas viram mensagens claras. Detalhes técnicos ficam só no log do servidor.
  function mapErr(e) {
    if (!(e instanceof AsaasError)) return e;
    console.error('[pix] Asaas respondeu', e.status, e.message);
    if (e.status === 400) return new HttpError(400, e.message);
    return new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }

  /* ---------- regras de negócio (todas idempotentes) ---------- */
  const activate = db.transaction((id) => {
    const p = getById.get(id);
    if (!p || p.status === 'paid' || p.status === 'refunded') return p;
    const t = now();
    let until = null;
    const u = p.user_id ? getUser.get(p.user_id) : null;
    if (u) {
      until = grants.grant(u, grants.fromRow(p), t);
      db.prepare('INSERT INTO subscriptions (user_id, plan, amount_cents, status, provider, created_at) VALUES (?,?,?,?,?,?)').run(u.id, p.plan, p.amount_cents, 'paid', 'asaas', t);
    }
    db.prepare("UPDATE payments SET status = 'paid', paid_at = ?, granted_until = ?, note = NULL WHERE id = ?").run(t, until, id);
    log('pagamento confirmado', p.ref, p.plan);
    return getById.get(id);
  });

  const refund = db.transaction((id) => {
    const p = getById.get(id);
    if (!p || p.status === 'refunded') return p;
    const t = now();
    const u = p.user_id ? getUser.get(p.user_id) : null;
    if (u && p.status === 'paid') {
      grants.revoke(u, grants.fromRow(p), t);
      db.prepare('INSERT INTO subscriptions (user_id, plan, amount_cents, status, provider, created_at) VALUES (?,?,?,?,?,?)').run(u.id, p.plan, p.amount_cents, 'refunded', 'asaas', t);
    }
    db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(id);
    log('pagamento estornado', p.ref);
    return getById.get(id);
  });

  const flag = (p, msg) => { db.prepare('UPDATE payments SET note = ? WHERE id = ?').run(String(msg).slice(0, 200), p.id); log('ATENÇÃO', p.ref, msg); };

  // A única fonte da verdade é o próprio Asaas: sempre perguntamos a ele, nunca confiamos no corpo do aviso.
  async function reconcile(p) {
    if (!p || !p.asaas_payment_id) return p;
    db.prepare('UPDATE payments SET last_check = ? WHERE id = ?').run(now(), p.id);
    const remote = await client.getPayment(p.asaas_payment_id);
    if (!remote || remote.id !== p.asaas_payment_id) { flag(p, 'resposta do Asaas não corresponde à cobrança'); return getById.get(p.id); }
    if (remote.externalReference !== p.ref) { flag(p, 'referência externa diferente da nossa'); return getById.get(p.id); }
    if (Math.round(Number(remote.value) * 100) !== p.amount_cents) { flag(p, `valor diferente do esperado (${remote.value})`); return getById.get(p.id); }
    if (PAID.has(remote.status)) return activate(p.id);
    if (remote.status === 'REFUNDED') return refund(p.id);
    if (remote.deleted === true && p.status === 'pending') db.prepare("UPDATE payments SET status = 'canceled', note = 'removida no Asaas' WHERE id = ? AND status = 'pending'").run(p.id);
    return getById.get(p.id);
  }

  async function cancelPayment(p, note, status = 'canceled') {
    const r = db.prepare("UPDATE payments SET status = ?, note = ? WHERE id = ? AND status = 'pending'").run(status, note, p.id);
    if (Number(r.changes) && p.asaas_payment_id) { try { await client.deletePayment(p.asaas_payment_id); } catch (e) { /* já saiu da fila ou o Asaas está fora; não é crítico */ } }
  }

  /* ---------- criação da cobrança ---------- */
  async function ensureCustomer(u, body) {
    if (u.asaas_customer_id) return;
    const cpf = L.validCpfCnpj(body && body.cpfCnpj);
    if (!cpf) throw new HttpError(400, 'Informe um CPF ou CNPJ válido.');
    const fullName = L.clean(body && body.fullName, 100);
    if (fullName.length < 5 || !fullName.includes(' ')) throw new HttpError(400, 'Informe o nome completo do titular do CPF.');
    const c = await client.createCustomer({ name: fullName, cpfCnpj: cpf, email: u.email, externalReference: `user:${u.id}` });
    if (!c || typeof c.id !== 'string') throw new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
    db.prepare('UPDATE users SET asaas_customer_id = ? WHERE id = ?').run(c.id, u.id); // o CPF não é guardado aqui
  }

  async function loadQr(p) {
    const qr = await client.getPixQrCode(p.asaas_payment_id);
    const payload = String((qr && qr.payload) || '');
    const image = String((qr && qr.encodedImage) || '').replace(/\s+/g, '');
    if (!payload || payload.length > 2000 || !/^[A-Za-z0-9+/=]*$/.test(image) || image.length > 300000) throw new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
    db.prepare('UPDATE payments SET pix_payload = ?, pix_image = ? WHERE id = ?').run(payload, image, p.id);
  }

  async function createCharge(u, order, { renewal = false } = {}) {
    const ref = crypto.randomUUID();
    const t = now();
    const remote = await client.createPixPayment({ customer: u.asaas_customer_id, value: order.amountCents / 100, dueDate: spDate(1), description: `Pertinho ${order.label}`, externalReference: ref });
    if (!remote || typeof remote.id !== 'string') throw new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
    const info = db.prepare("INSERT INTO payments (ref, user_id, plan, item, months, amount_cents, status, asaas_payment_id, expires_at, renewal, created_at) VALUES (?,?,?,?,?,?,'pending',?,?,?,?)")
      .run(ref, u.id, order.plan, order.item, order.months, order.amountCents, remote.id, t + PIX_TTL, renewal ? 1 : 0, t);
    const row = getById.get(Number(info.lastInsertRowid));
    try { await loadQr(row); } catch (e) { await cancelPayment(row, 'sem QR Code'); throw e; }
    return getById.get(row.id);
  }

  /* ---------- rotas do usuário ---------- */
  const limitPix = rateLimit({ windowMs: 3600000, limit: PIX_LIMIT, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user ? req.user.id : req.ip}`, validate: { keyGeneratorIpFallback: false }, message: { error: 'Muitos pedidos de Pix. Tente novamente mais tarde.' } });

  app.post('/api/billing/pix', requireAuth, limitPix, async (req, res) => {
    const u = req.user;
    const order = grants.parseOrder(req.body);
    if (!order) throw new HttpError(400, 'Pedido inválido.');
    if (inflight.has(u.id)) throw new HttpError(429, 'Já estamos gerando o seu Pix. Aguarde um instante.');
    inflight.add(u.id);
    try {
      const t = now();
      const open = db.prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC").all(u.id);
      const reuse = open.find((p) => p.plan === order.plan && p.item === order.item && p.months === order.months && p.expires_at > t && p.pix_payload);
      for (const p of open) if (!reuse || p.id !== reuse.id) await cancelPayment(p, 'substituída por outro pedido');
      if (reuse) return res.json({ payment: toJson(reuse) });
      await ensureCustomer(getUser.get(u.id), req.body);
      const p = await createCharge(getUser.get(u.id), order);
      res.status(201).json({ payment: toJson(p) });
    } catch (e) { throw mapErr(e); } finally { inflight.delete(u.id); }
  });

  app.get('/api/billing/status', requireAuth, (req, res) => {
    const u = getUser.get(req.user.id), t = now();
    const plan = L.effectivePlan(u);
    const pend = db.prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' AND expires_at > ? AND pix_payload IS NOT NULL ORDER BY id DESC LIMIT 1").get(u.id, t);
    const daysLeft = plan !== 'free' ? Math.max(0, Math.ceil((u.plan_until - t) / DAY)) : null;
    res.json({
      sandbox: client.env === 'sandbox', needsCustomer: !u.asaas_customer_id, renewalOff: !!u.renewal_off,
      plan, planUntil: plan === 'free' ? null : u.plan_until, daysLeft, renewalDue: daysLeft !== null && daysLeft <= 3,
      pending: pend ? toJson(pend) : null,
    });
  });

  function ownPayment(req) {
    const p = getByRef.get(String(req.params.ref || '').slice(0, 64));
    if (!p || p.user_id !== req.user.id) throw new HttpError(404, 'Pagamento não encontrado.');
    return p;
  }

  app.get('/api/billing/pix/:ref', requireAuth, async (req, res) => {
    let p = ownPayment(req);
    if (p.status === 'pending' && (!p.last_check || now() - p.last_check > 4000)) {
      try { p = await reconcile(p); } catch (e) { /* sem resposta do Asaas agora; o próximo ciclo tenta de novo */ }
    }
    res.json({ payment: toJson(p), user: undefined });
  });

  app.post('/api/billing/pix/:ref/cancel', requireAuth, async (req, res) => {
    const p = ownPayment(req);
    await cancelPayment(p, 'cancelada pelo usuário');
    res.json({ payment: toJson(getById.get(p.id)) });
  });

  app.post('/api/billing/renewal', requireAuth, (req, res) => {
    db.prepare('UPDATE users SET renewal_off = ? WHERE id = ?').run(req.body && req.body.off ? 1 : 0, req.user.id);
    res.json({ renewalOff: !!(req.body && req.body.off) });
  });

  /* ---------- webhook do Asaas ---------- */
  async function processEvent(eventId) {
    if (processing.has(eventId)) return;
    processing.add(eventId);
    try {
      const ev = db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(eventId);
      if (!ev || ev.status === 'done') return;
      db.prepare('UPDATE webhook_events SET attempts = attempts + 1 WHERE event_id = ?').run(eventId);
      try {
        const p = ev.asaas_payment_id ? getByAsaas.get(ev.asaas_payment_id) : null;
        if (p) await reconcile(p);
        db.prepare("UPDATE webhook_events SET status = 'done', processed_at = ?, error = NULL WHERE event_id = ?").run(now(), eventId);
      } catch (e) {
        db.prepare('UPDATE webhook_events SET status = ?, error = ? WHERE event_id = ?').run(ev.attempts + 1 >= 8 ? 'failed' : 'pending', String(e.message).slice(0, 300), eventId);
      }
    } finally { processing.delete(eventId); }
  }

  app.post('/api/webhooks/asaas', (req, res) => {
    if (!safeEqual(req.get('asaas-access-token') || '', webhookToken)) return res.status(401).json({ error: 'Não autorizado.' });
    const b = req.body || {};
    if (typeof b.id !== 'string' || !b.id || b.id.length > 200 || typeof b.event !== 'string' || b.event.length > 80) return res.status(400).json({ error: 'Evento inválido.' });
    if (!RELEVANT.has(b.event)) return res.json({ ok: true, ignored: true });
    const pid = b.payment && typeof b.payment.id === 'string' ? b.payment.id.slice(0, 100) : null;
    const r = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event, asaas_payment_id, payload, received_at) VALUES (?,?,?,?,?)')
      .run(b.id, b.event, pid, JSON.stringify(b).slice(0, 20000), now());
    res.json({ ok: true, duplicate: !Number(r.changes) }); // responde só depois de gravar o evento
    if (Number(r.changes)) setImmediate(() => processEvent(b.id));
  });

  /* ---------- rotina em segundo plano ---------- */
  let lastRenewalRun = 0, sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const t = now();
      for (const e of db.prepare("SELECT event_id FROM webhook_events WHERE status = 'pending' AND received_at < ? LIMIT 20").all(t - RETRY_MS)) await processEvent(e.event_id);
      // Mesmo sem aviso do webhook, confere os Pix que continuam pendentes.
      for (const p of db.prepare("SELECT * FROM payments WHERE status = 'pending' AND created_at < ? AND (last_check IS NULL OR last_check < ?) LIMIT 20").all(t - 60000, t - 120000)) { try { await reconcile(p); } catch (e) { /* tenta de novo depois */ } }
      for (const p of db.prepare("SELECT * FROM payments WHERE status = 'pending' AND expires_at < ? LIMIT 20").all(t)) {
        try { const r = await reconcile(p); if (r.status === 'pending') await cancelPayment(r, 'expirou sem pagamento', 'expired'); } catch (e) { /* tenta de novo depois */ }
      }
      if (t - lastRenewalRun > RENEWAL_MS) {
        lastRenewalRun = t;
        const due = db.prepare(`SELECT * FROM users WHERE role = 'user' AND status = 'active' AND plan != 'free' AND renewal_off = 0 AND asaas_customer_id IS NOT NULL
          AND plan_until BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.user_id = users.id AND p.status = 'pending' AND p.expires_at > ?) LIMIT 50`).all(t, t + 3 * DAY, t);
        for (const u of due) { try {
          const last = db.prepare("SELECT months FROM payments WHERE user_id = ? AND item = 'plan' AND status = 'paid' ORDER BY id DESC LIMIT 1").get(u.id);
          await createCharge(u, grants.parseOrder({ plan: u.plan, months: last ? last.months : 1 }), { renewal: true }); log('cobrança de renovação criada para o usuário', u.id); } catch (e) { console.error('[pix] falha na renovação do usuário', u.id, e.message); } }
      }
    } catch (e) { console.error('[pix] rotina falhou:', e.message); } finally { sweeping = false; }
  }
  const start = () => { setInterval(sweep, SWEEP_MS).unref(); setTimeout(sweep, Math.min(5000, SWEEP_MS)).unref(); };

  /* ---------- painel ADM ---------- */
  admin.get('/payments', (req, res) => {
    const rows = db.prepare(`SELECT p.*, u.name AS uname, u.email AS uemail FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 100`).all();
    const failed = db.prepare("SELECT COUNT(*) c FROM webhook_events WHERE status = 'failed'").get().c;
    res.json({
      failedEvents: failed, sandbox: client.env === 'sandbox',
      payments: rows.map((p) => ({ id: p.id, ref: p.ref, userId: p.user_id, name: p.uname, email: p.uemail, plan: p.plan, item: p.item, months: p.months, label: labelOf(p), amountCents: p.amount_cents, status: p.status, asaasId: p.asaas_payment_id, renewal: !!p.renewal, note: p.note, createdAt: p.created_at, paidAt: p.paid_at })),
    });
  });
  admin.post('/payments/:id/check', async (req, res) => {
    const id = Number(req.params.id);
    const p = Number.isInteger(id) && getById.get(id);
    if (!p) throw new HttpError(404, 'Pagamento não encontrado.');
    let r;
    try { r = await reconcile(p); } catch (e) { throw mapErr(e); }
    audit(req.user.id, 'payment_check', `payment:${id}`, r.status);
    res.json({ status: r.status });
  });

  return { start, sweep, reconcile, processEvent };
};
