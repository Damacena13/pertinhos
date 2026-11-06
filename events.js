'use strict';
// Encontros em grupo: pessoas da mesma cidade marcam um programa em lugar público.
// O local exato e o chat só aparecem para quem confirmou presença.
const express = require('express');

const DAY = 86_400_000, HOUR = 3_600_000;
const RULES = { minAheadMs: 2 * HOUR, maxAheadMs: 14 * DAY, minCap: 4, maxCap: 12, maxHosted: 2, maxJoined: 5 };

function makeEvents({ db, requireAuth, requireConfirmed, blockedBetween, bad, HttpError, intId, now, cityById, audit, PLACE_TYPES, limit }) {
  const router = express.Router();
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'Alguém';
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  const count = (id) => db.prepare('SELECT COUNT(*) c FROM event_members WHERE event_id = ?').get(id).c;
  const isMember = (eid, uid) => !!db.prepare('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?').get(eid, uid);
  const hasPhoto = (uid) => !!db.prepare("SELECT 1 FROM photos WHERE user_id = ? AND status = 'ok'").get(uid);

  function view(ev, me, full) {
    const city = cityById(ev.city_id);
    const member = isMember(ev.id, me.id) || ev.host_id === me.id;
    const out = {
      id: ev.id, title: ev.title, placeType: ev.place_type, city: city ? `${city.name} - ${city.uf}` : '',
      startsAt: ev.starts_at, capacity: ev.capacity, going: count(ev.id), status: ev.status,
      hostName: first(ev.host_name), mine: ev.host_id === me.id, joined: member, description: ev.description,
      full: count(ev.id) >= ev.capacity,
    };
    if (member) out.placeName = ev.place_name;
    if (full && member) {
      out.members = db.prepare(`SELECT u.id, u.name FROM event_members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? ORDER BY m.created_at`)
        .all(ev.id).map((r) => ({ id: r.id, name: first(r.name), host: r.id === ev.host_id }));
      out.messages = db.prepare(`SELECT m.id, m.user_id, m.body, m.created_at, u.name FROM event_messages m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? ORDER BY m.id DESC LIMIT 100`)
        .all(ev.id).reverse().map((r) => ({ id: r.id, mine: r.user_id === me.id, name: first(r.name), body: r.body, at: r.created_at }));
    }
    return out;
  }
  const load = (id) => db.prepare('SELECT e.*, u.name AS host_name FROM events e JOIN users u ON u.id = e.host_id WHERE e.id = ?').get(id);
  const hidden = (ev, me) => ev.host_id !== me.id && blockedBetween(me.id, ev.host_id);

  router.get('/', requireAuth, (req, res) => {
    const me = req.user;
    const rows = db.prepare(`SELECT e.*, u.name AS host_name FROM events e JOIN users u ON u.id = e.host_id
      WHERE e.status = 'open' AND e.starts_at > ? AND (e.city_id = ? OR e.id IN (SELECT event_id FROM event_members WHERE user_id = ?))
      ORDER BY e.starts_at LIMIT 60`).all(now(), me.city_id || '', me.id);
    res.json({ items: rows.filter((e) => !hidden(e, me)).map((e) => view(e, me, false)), rules: { minCap: RULES.minCap, maxCap: RULES.maxCap }, placeTypes: PLACE_TYPES });
  });

  router.post('/', requireAuth, requireConfirmed, limit, (req, res) => {
    const me = req.user, b = req.body || {};
    if (!me.city_id || !cityById(me.city_id)) throw bad('Defina sua cidade no perfil antes de criar um encontro.');
    if (!hasPhoto(me.id)) throw bad('Adicione uma foto ao seu perfil para criar encontros.');
    const title = clean(b.title, 60);
    if (title.length < 4) throw bad('Dê um título ao encontro (mínimo 4 letras).');
    if (!PLACE_TYPES.includes(b.placeType)) throw bad('Escolha um tipo de local público.');
    const cap = Number(b.capacity);
    if (!Number.isInteger(cap) || cap < RULES.minCap || cap > RULES.maxCap) throw bad(`O grupo deve ter de ${RULES.minCap} a ${RULES.maxCap} pessoas.`);
    const at = Number(b.startsAt);
    if (!Number.isFinite(at) || at < now() + RULES.minAheadMs) throw bad('Marque o encontro com pelo menos 2 horas de antecedência.');
    if (at > now() + RULES.maxAheadMs) throw bad('Marque o encontro para os próximos 14 dias.');
    const hosted = db.prepare("SELECT COUNT(*) c FROM events WHERE host_id = ? AND status = 'open' AND starts_at > ?").get(me.id, now()).c;
    if (hosted >= RULES.maxHosted) throw bad(`Você já organiza ${RULES.maxHosted} encontros abertos.`);
    const id = db.transaction(() => {
      const r = db.prepare('INSERT INTO events (host_id, title, place_type, place_name, city_id, starts_at, capacity, description, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(me.id, title, b.placeType, clean(b.placeName, 80), me.city_id, Math.floor(at), cap, clean(b.description, 300), now());
      db.prepare('INSERT INTO event_members (event_id, user_id, created_at) VALUES (?,?,?)').run(r.lastInsertRowid, me.id, now());
      return Number(r.lastInsertRowid);
    })();
    res.status(201).json({ event: view(load(id), me, true) });
  });

  router.get('/:id', requireAuth, (req, res) => {
    const ev = load(intId(req.params.id));
    if (!ev || hidden(ev, req.user)) throw new HttpError(404, 'Encontro não encontrado.');
    res.json({ event: view(ev, req.user, true) });
  });

  router.post('/:id/join', requireAuth, requireConfirmed, limit, (req, res) => {
    const me = req.user, ev = load(intId(req.params.id));
    if (!ev || hidden(ev, me)) throw new HttpError(404, 'Encontro não encontrado.');
    if (ev.status !== 'open' || ev.starts_at <= now()) throw bad('Este encontro não está mais aberto.');
    if (ev.city_id !== me.city_id) throw bad('Este encontro é em outra cidade.');
    if (!hasPhoto(me.id)) throw bad('Adicione uma foto ao seu perfil para participar.');
    if (isMember(ev.id, me.id)) return res.json({ event: view(ev, me, true) });
    const joined = db.prepare("SELECT COUNT(*) c FROM event_members m JOIN events e ON e.id = m.event_id WHERE m.user_id = ? AND e.status = 'open' AND e.starts_at > ?").get(me.id, now()).c;
    if (joined >= RULES.maxJoined) throw bad(`Você já confirmou presença em ${RULES.maxJoined} encontros.`);
    const ids = db.prepare('SELECT user_id FROM event_members WHERE event_id = ?').all(ev.id).map((r) => r.user_id);
    if (ids.some((u) => blockedBetween(me.id, u))) throw new HttpError(404, 'Encontro não encontrado.');
    db.transaction(() => {
      if (count(ev.id) >= ev.capacity) throw bad('O grupo já está completo.');
      db.prepare('INSERT INTO event_members (event_id, user_id, created_at) VALUES (?,?,?)').run(ev.id, me.id, now());
    })();
    res.json({ event: view(load(ev.id), me, true) });
  });

  router.post('/:id/leave', requireAuth, (req, res) => {
    const me = req.user, ev = load(intId(req.params.id));
    if (!ev) throw new HttpError(404, 'Encontro não encontrado.');
    if (ev.host_id === me.id) throw bad('Quem organiza não pode sair: cancele o encontro.');
    db.prepare('DELETE FROM event_members WHERE event_id = ? AND user_id = ?').run(ev.id, me.id);
    res.json({ ok: true });
  });

  router.post('/:id/cancel', requireAuth, (req, res) => {
    const ev = load(intId(req.params.id));
    if (!ev || ev.host_id !== req.user.id) throw new HttpError(404, 'Encontro não encontrado.');
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(ev.id);
    res.json({ ok: true });
  });

  router.post('/:id/messages', requireAuth, requireConfirmed, limit, (req, res) => {
    const me = req.user, ev = load(intId(req.params.id));
    if (!ev || !isMember(ev.id, me.id)) throw new HttpError(404, 'Encontro não encontrado.');
    if (ev.status !== 'open') throw bad('Este encontro foi cancelado.');
    const body = clean(req.body?.body, 500);
    if (!body) throw bad('Escreva uma mensagem.');
    const r = db.prepare('INSERT INTO event_messages (event_id, user_id, body, created_at) VALUES (?,?,?,?)').run(ev.id, me.id, body, now());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // Rotas do painel de administração (montadas no roteador admin).
  function adminRoutes(admin) {
    admin.get('/events', (req, res) => {
      const rows = db.prepare(`SELECT e.*, u.name AS host_name, u.email AS host_email, (SELECT COUNT(*) FROM event_members m WHERE m.event_id = e.id) AS going
        FROM events e JOIN users u ON u.id = e.host_id ORDER BY e.id DESC LIMIT 100`).all();
      res.json({ items: rows.map((e) => ({ id: e.id, title: e.title, placeType: e.place_type, placeName: e.place_name, city: (cityById(e.city_id) || {}).name || e.city_id, startsAt: e.starts_at, capacity: e.capacity, going: e.going, status: e.status, host: e.host_name, hostEmail: e.host_email })) });
    });
    admin.post('/events/:id/cancel', (req, res) => {
      const id = intId(req.params.id);
      const r = db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(id);
      if (!r.changes) throw new HttpError(404, 'Encontro não encontrado ou já cancelado.');
      audit(req.user.id, 'event.cancel', `event:${id}`, '');
      res.json({ ok: true });
    });
  }
  return { router, adminRoutes, RULES };
}
module.exports = { makeEvents, RULES };
