'use strict';
// Indicação automática. Regras (ajuste nas constantes):
// - quem entra por um link ganha 3 dias de Plus; quem indicou ganha um Destaque de 30 min e, a cada 3 indicações válidas, 7 dias de Plus.
// - o prêmio só sai quando o indicado ATIVA a conta (envia a primeira foto). Cadastro sozinho não vale nada.
// - travas: CPF único (já exigido no cadastro), nada de auto-indicação, no máximo 2 prêmios por rede (mesmo IP) por quem indica,
//   teto de 30 prêmios por pessoa e de 50 convites pendentes.
const crypto = require('crypto');
const DAY = 86400000;
const BOOST_MS = 30 * 60 * 1000;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RULES = { inviteeDays: 3, referrerDays: 7, every: 3, maxRewarded: 30, maxPending: 50, maxSameNetwork: 2 };
const CODE_RE = /^[A-Z0-9]{8}$/;

module.exports = function makeReferrals({ db, now, pepper }) {
  const newCode = () => { let s = ''; for (const b of crypto.randomBytes(8)) s += ALPHA[b % 32]; return s; };
  const netHash = (ip) => crypto.createHmac('sha256', pepper).update('ip:' + String(ip || '')).digest('hex').slice(0, 32);

  function ensureCode(uid) {
    const cur = db.prepare('SELECT ref_code FROM users WHERE id = ?').get(uid);
    if (!cur) return null;
    if (cur.ref_code) return cur.ref_code;
    for (let i = 0; i < 10; i++) {
      try {
        db.prepare('UPDATE users SET ref_code = ? WHERE id = ? AND ref_code IS NULL').run(newCode(), uid);
        return db.prepare('SELECT ref_code FROM users WHERE id = ?').get(uid).ref_code;
      } catch (e) { /* colisão rara: tenta outro código */ }
    }
    return null;
  }

  // Concede dias de Plus sem mexer em quem já paga: estende o plano ativo ou cria um Plus promocional (sem renovação cobrada).
  function grantPlusDays(uid, days, t) {
    const u = db.prepare('SELECT plan, plan_until, renewal_off, photo_credits FROM users WHERE id = ?').get(uid);
    const active = u.plan !== 'free' && u.plan_until && u.plan_until > t;
    if (active && u.plan === 'premium') { db.prepare('UPDATE users SET photo_credits = photo_credits + 1 WHERE id = ?').run(uid); return 'credit'; }
    const base = active ? u.plan_until : t;
    if (active) db.prepare('UPDATE users SET plan_until = ? WHERE id = ?').run(base + days * DAY, uid);
    else db.prepare("UPDATE users SET plan = 'plus', plan_until = ?, renewal_off = 1, promo = 1 WHERE id = ?").run(base + days * DAY, uid);
    return 'plus';
  }

  // Chamado no cadastro. Código inválido nunca impede o cadastro.
  function onRegister(inviteeId, rawCode, ip) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return null;
    const ref = db.prepare("SELECT id FROM users WHERE ref_code = ? AND status = 'active'").get(code);
    if (!ref || ref.id === inviteeId) return null;
    const pend = db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'pending'").get(ref.id).c;
    if (pend >= RULES.maxPending) return null;
    db.prepare('INSERT INTO referrals (referrer_id, invitee_id, status, net_hash, created_at) VALUES (?,?,?,?,?)').run(ref.id, inviteeId, 'pending', netHash(ip), now());
    db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(ref.id, inviteeId);
    return { referrerId: ref.id };
  }

  // Chamado quando o indicado envia a primeira foto. Idempotente: só age sobre indicação pendente.
  function activate(inviteeId) {
    return db.transaction(() => {
      const r = db.prepare("SELECT * FROM referrals WHERE invitee_id = ? AND status = 'pending'").get(inviteeId);
      if (!r) return null;
      if (process.env.REFERRAL_REQUIRE_VERIFIED !== '0') { // prêmio só com selfie aprovada: barra contas falsas em massa
        const v = db.prepare('SELECT verified FROM users WHERE id = ?').get(inviteeId);
        if (!v || !v.verified) return { status: 'pending', waiting: 'selfie' };
      }
      const t = now();
      const reject = (reason) => { db.prepare("UPDATE referrals SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ?").run(reason, t, r.id); return { status: 'rejected', reason }; };
      const referrer = db.prepare('SELECT id, status FROM users WHERE id = ?').get(r.referrer_id);
      if (!referrer || referrer.status !== 'active') return reject('referrer_inactive');
      const rewarded = db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'rewarded'").get(r.referrer_id).c;
      if (rewarded >= RULES.maxRewarded) return reject('cap');
      const same = db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = 'rewarded' AND net_hash = ?").get(r.referrer_id, r.net_hash).c;
      if (same >= RULES.maxSameNetwork) return reject('same_network');
      grantPlusDays(inviteeId, RULES.inviteeDays, t);
      const cur = db.prepare('SELECT boost_until FROM users WHERE id = ?').get(r.referrer_id);
      db.prepare('UPDATE users SET boost_until = ? WHERE id = ?').run(Math.max(t, cur.boost_until || 0) + BOOST_MS, r.referrer_id);
      const total = rewarded + 1;
      let bonus = false;
      if (total % RULES.every === 0) { grantPlusDays(r.referrer_id, RULES.referrerDays, t); bonus = true; }
      db.prepare("UPDATE referrals SET status = 'rewarded', decided_at = ? WHERE id = ?").run(t, r.id);
      return { status: 'rewarded', referrerId: r.referrer_id, total, bonus };
    })();
  }

  function summary(uid, baseUrl) {
    const code = ensureCode(uid);
    const rows = db.prepare('SELECT r.status, r.created_at, r.decided_at, u.name FROM referrals r JOIN users u ON u.id = r.invitee_id WHERE r.referrer_id = ? ORDER BY r.id DESC LIMIT 30').all(uid);
    const n = (s) => db.prepare('SELECT COUNT(*) c FROM referrals WHERE referrer_id = ? AND status = ?').get(uid, s).c;
    const rewarded = n('rewarded');
    return {
      code, link: `${baseUrl}/?ref=${code}`,
      pending: n('pending'), rewarded, invited: rows.length,
      untilBonus: RULES.every - (rewarded % RULES.every),
      rules: RULES, requireVerified: process.env.REFERRAL_REQUIRE_VERIFIED !== '0',
      items: rows.map((x) => ({ name: String(x.name).split(' ')[0], status: x.status === 'rejected' ? 'not_counted' : x.status, at: x.decided_at || x.created_at })),
    };
  }
  return { onRegister, activate, summary, ensureCode, RULES };
};
