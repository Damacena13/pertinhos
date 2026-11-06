'use strict';
// O que cada compra concede (e o que o estorno devolve). Usado pelo modo demonstração e pelo Pix do Asaas.
// Um "pedido" é { item: 'plan', plan: 'plus'|'premium', months: 1|3|6 } ou { item: 'shop', key: 'pass24h'|'boost30m'|'boost90m'|'photos3'|'photos10' }.
const DAY = 86400000;
const PASS_MS = DAY;
const BOOST_MS = 30 * 60 * 1000;
const PHOTO_PACKS = { photos3: 3, photos10: 10 };
const BOOST_PACKS = { boost30m: 1, boost90m: 3 };

module.exports = function makeGrants({ db, L }) {
  // Valida o pedido e devolve o preço oficial (sempre calculado aqui, nunca vindo do cliente).
  function parseOrder(body) {
    if (body && body.item) {
      const it = L.SHOP[body.item];
      if (!it) return null;
      return { item: 'shop', key: it.id, plan: it.id, months: 1, amountCents: it.priceCents, label: it.name };
    }
    const plan = L.PLANS[body && body.plan];
    if (!plan || plan.id === 'free') return null;
    const months = body.months === undefined ? 1 : Number(body.months);
    const cents = L.priceOf(plan.id, months);
    if (!cents) return null;
    return { item: 'plan', key: plan.id, plan: plan.id, months, amountCents: cents, label: `Plano ${plan.name} - ${months === 1 ? '1 mês' : months + ' meses'}` };
  }
  const fromRow = (p) => (p.item === 'shop' ? { item: 'shop', key: p.plan } : { item: 'plan', plan: p.plan, months: p.months || 1 });

  // Chame dentro de uma transação. Devolve o novo limite (plano/passe/destaque) ou null.
  function grant(u, order, t) {
    if (order.item === 'plan') {
      const same = u.plan === order.plan && u.plan_until && u.plan_until > t;
      const until = (same ? u.plan_until : t) + 30 * DAY * order.months;
      db.prepare('UPDATE users SET plan = ?, plan_until = ?, renewal_off = 0, promo = 0 WHERE id = ?').run(order.plan, until, u.id);
      return until;
    }
    if (order.key === 'pass24h') {
      const until = Math.max(t, u.pass_until || 0) + PASS_MS;
      db.prepare('UPDATE users SET pass_until = ? WHERE id = ?').run(until, u.id);
      return until;
    }
    if (BOOST_PACKS[order.key]) {
      const until = Math.max(t, u.boost_until || 0) + BOOST_MS * BOOST_PACKS[order.key];
      db.prepare('UPDATE users SET boost_until = ? WHERE id = ?').run(until, u.id);
      return until;
    }
    if (PHOTO_PACKS[order.key]) { db.prepare('UPDATE users SET photo_credits = photo_credits + ? WHERE id = ?').run(PHOTO_PACKS[order.key], u.id); return null; }
    return null;
  }

  function revoke(u, order, t) {
    if (order.item === 'plan') {
      if (u.plan === order.plan && u.plan_until) {
        const next = u.plan_until - 30 * DAY * order.months;
        if (next <= t) db.prepare("UPDATE users SET plan = 'free', plan_until = NULL, invisible = 0 WHERE id = ?").run(u.id);
        else db.prepare('UPDATE users SET plan_until = ? WHERE id = ?').run(next, u.id);
      }
      return;
    }
    const sub = (col, ms) => {
      const cur = u[col] || 0; const next = cur - ms;
      db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(next > t ? next : null, u.id);
    };
    if (order.key === 'pass24h') sub('pass_until', PASS_MS);
    else if (BOOST_PACKS[order.key]) sub('boost_until', BOOST_MS * BOOST_PACKS[order.key]);
    else if (PHOTO_PACKS[order.key]) db.prepare('UPDATE users SET photo_credits = MAX(0, photo_credits - ?) WHERE id = ?').run(PHOTO_PACKS[order.key], u.id);
  }

  return { parseOrder, fromRow, grant, revoke };
};
