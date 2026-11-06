'use strict';
// Avisos por e-mail: novo match, mensagem nova (com freio) e lembrete de encontro em grupo.
// Só funciona com o envio de e-mail ligado (Resend) e só para quem confirmou o e-mail e não desligou os avisos.
const crypto = require('crypto');
const HOUR = 3_600_000, MIN = 60_000;
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeNotify({ db, mailer, now, secret, cityById }) {
  const base = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const sig = (uid) => crypto.createHmac('sha256', String(secret)).update('unsub:' + uid).digest('hex').slice(0, 32);
  const unsubLink = (uid) => `${base()}/api/unsubscribe?u=${uid}&t=${sig(uid)}`;
  const eligible = (u) => u && mailer.enabled() && u.status === 'active' && !u.is_demo && u.role === 'user' && u.notify_email && u.email_verified_at;
  const user = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'Alguém';
  const fresh = (key, windowMs) => { const r = db.prepare('SELECT created_at FROM notif_log WHERE key = ?').get(key); return !r || now() - r.created_at >= windowMs; };
  const mark = (key) => db.prepare('INSERT OR REPLACE INTO notif_log (key, created_at) VALUES (?,?)').run(key, now());

  function send(u, subject, line, path) {
    if (!base()) return Promise.resolve(); // sem PUBLIC_URL não há como montar links seguros
    const link = base() + path, un = unsubLink(u.id);
    return mailer.sendMail({
      to: u.email, subject,
      text: `Olá, ${first(u.name)}!\n\n${line}\n${link}\n\nPara não receber estes avisos: ${un}`,
      html: `<p>Olá, ${esc(first(u.name))}!</p><p>${esc(line)}</p><p><a href="${link}">Abrir o Pertinhos</a></p><p style="color:#888;font-size:12px"><a href="${un}">Parar de receber estes avisos</a></p>`,
    }).catch(() => {});
  }

  return {
    sig,
    match(aId, bId, matchId) {
      for (const [me, other] of [[aId, bId], [bId, aId]]) {
        const u = user(me); if (!eligible(u)) continue;
        const key = `match:${matchId}:${me}`; if (!fresh(key, 1e15)) continue; mark(key);
        send(u, 'Você tem um novo match no Pertinhos', `Você e ${first((user(other) || {}).name)} deram match. Vá dizer oi!`, '/');
      }
    },
    message(toId, fromId, matchId) {
      const u = user(toId); if (!eligible(u)) return;
      if (u.last_seen && now() - u.last_seen < 15 * MIN) return; // está online: não incomoda
      const key = `msg:${toId}:${matchId}`; if (!fresh(key, 6 * HOUR)) return; mark(key);
      send(u, `${first((user(fromId) || {}).name)} mandou uma mensagem`, 'Você recebeu uma mensagem nova no Pertinhos.', '/');
    },
    sweepEvents() {
      if (!mailer.enabled()) return 0;
      const evs = db.prepare("SELECT * FROM events WHERE status = 'open' AND reminded = 0 AND starts_at > ? AND starts_at <= ?").all(now(), now() + 3 * HOUR);
      let n = 0;
      for (const ev of evs) {
        db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(ev.id);
        const hora = new Date(ev.starts_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
        for (const m of db.prepare('SELECT user_id FROM event_members WHERE event_id = ?').all(ev.id)) {
          const u = user(m.user_id); if (!eligible(u)) continue;
          send(u, `Lembrete: ${ev.title} hoje`, `Seu encontro "${ev.title}" começa às ${hora}. Local e chat do grupo estão no app.`, `/?evento=${ev.id}`); n++;
        }
      }
      return n;
    },
    start() { setInterval(() => { try { this.sweepEvents(); } catch (e) { console.error(e); } }, 10 * MIN).unref(); },
    unsubscribe(uid, t) {
      const ok = Number.isInteger(uid) && /^[0-9a-f]{32}$/.test(String(t)) && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(sig(uid)));
      if (ok) db.prepare('UPDATE users SET notify_email = 0 WHERE id = ?').run(uid);
      return ok;
    },
  };
}
module.exports = { makeNotify };
