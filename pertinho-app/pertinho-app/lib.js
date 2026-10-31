'use strict';
const crypto = require('crypto');

/* ---------- senhas ---------- */
const scrypt = (pw, salt) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const got = await scrypt(pw, salt);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
const DUMMY_HASH = 's1$' + Buffer.alloc(16).toString('base64') + '$' + Buffer.alloc(64).toString('base64');

/* ---------- sessões ---------- */
const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- datas e idade ---------- */
function parseBirth(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}
function ageFrom(str, now = new Date()) {
  const b = parseBirth(str);
  if (!b) return null;
  let age = now.getUTCFullYear() - b.y;
  if (now.getUTCMonth() + 1 < b.m || (now.getUTCMonth() + 1 === b.m && now.getUTCDate() < b.d)) age--;
  return age;
}
// data limite: quem nasceu em ou antes desta data tem pelo menos `years` anos
function birthLimit(years, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/* ---------- geografia ---------- */
const R = 6371;
const rad = (x) => (x * Math.PI) / 180;
function haversine(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Guarda a posição numa grade de ~550 m para nunca armazenar o ponto exato do GPS.
const snap = (v) => Math.round(v / 0.005) * 0.005;
function hash32(n) {
  let h = Math.imul(Number(n) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
// Quem escolhe só a cidade fica num ponto estável a até 6 km do centro, para não ficar todo mundo no mesmo lugar.
function cityPoint(city, userId) {
  const h = hash32(userId);
  const ang = ((h % 3600) / 3600) * 2 * Math.PI;
  const dist = 0.8 + (((h >>> 12) % 1000) / 1000) * 5.2;
  const dLat = (dist * Math.cos(ang)) / 111;
  const dLng = (dist * Math.sin(ang)) / (111 * Math.cos(rad(city.lat)));
  return { lat: snap(city.lat + dLat), lng: snap(city.lng + dLng) };
}
function distanceText(km) {
  const k = Math.max(1, Math.round(km));
  return k <= 1 ? 'a menos de 1 km' : `a cerca de ${k} km`;
}

/* ---------- planos e loja ---------- */
const PLANS = {
  free: { id: 'free', name: 'Grátis', priceCents: 0, maxRadius: 10, dailyLikes: 30, superPerDay: 1, rewind: false, extraPhotos: false, seeLikes: false, verifiedFilter: false, invisible: false, boost: false },
  plus: { id: 'plus', name: 'Plus', priceCents: 2990, maxRadius: 50, dailyLikes: Infinity, superPerDay: 5, rewind: true, extraPhotos: true, seeLikes: true, verifiedFilter: true, invisible: false, boost: false },
  premium: { id: 'premium', name: 'Premium', priceCents: 4990, maxRadius: 100, dailyLikes: Infinity, superPerDay: 10, rewind: true, extraPhotos: true, seeLikes: true, verifiedFilter: true, invisible: true, boost: true },
};
// Valor total de cada ciclo, em centavos. Quem paga trimestral ou semestral ganha desconto.
const PLAN_PRICES = { plus: { 1: 2990, 3: 6990, 6: 11990 }, premium: { 1: 4990, 3: 11670, 6: 19950 } };
const CYCLE_MONTHS = [1, 3, 6];
const priceOf = (plan, months) => (PLAN_PRICES[plan] && PLAN_PRICES[plan][months]) || null;
// Compras avulsas, sem assinatura.
const SHOP = {
  pass24h: { id: 'pass24h', name: 'Passe 24h de conversa', priceCents: 690, desc: 'Mensagens sem limite com todos os seus matches por 24 horas.' },
  boost30m: { id: 'boost30m', name: 'Destaque por 30 minutos', priceCents: 990, desc: 'Seu perfil aparece primeiro para quem está por perto durante 30 minutos.' },
  photos3: { id: 'photos3', name: 'Pacote de 3 desbloqueios de fotos', priceCents: 790, desc: 'Libera as fotos extras de 3 perfis, para sempre, sem assinar um plano.' },
};
const FREE_CHAT_MESSAGES = Number.isFinite(Number(process.env.FREE_CHAT_MESSAGES)) && process.env.FREE_CHAT_MESSAGES !== '' ? Math.max(0, Math.floor(Number(process.env.FREE_CHAT_MESSAGES))) : 3;
function effectivePlan(u, now = Date.now()) {
  if (u.plan !== 'free' && u.plan_until && u.plan_until > now) return u.plan;
  return 'free';
}
// Conversa liberada: plano pago ou Passe 24h ativo.
const chatUnlocked = (u, now = Date.now()) => effectivePlan(u, now) !== 'free' || !!(u.pass_until && u.pass_until > now);
const ONLINE_MS = 5 * 60 * 1000;
// Perfis de demonstração não têm ninguém por trás: parte deles aparece sempre como "online" só para o teste ficar completo.
const isOnline = (u, now = Date.now()) => (u.is_demo ? hash32(u.id) % 3 === 0 : !!(u.last_seen && now - u.last_seen < ONLINE_MS));
const boostActive = (u, now = Date.now()) => !!(u.boost_until && u.boost_until > now);

// Sintonia de 0 a 100: interesses em comum (até 60), proximidade (até 25) e idade parecida (até 15).
function affinity(a, b, km) {
  const norm = (x) => String(x).trim().toLowerCase();
  const ia = new Set(JSON.parse(a.interests || '[]').map(norm));
  const common = JSON.parse(b.interests || '[]').filter((x) => ia.has(norm(x)));
  const near = km == null ? 0 : Math.max(0, 25 * (1 - Math.max(0, km - 2) / 48));
  const diff = Math.abs((ageFrom(a.birth_date) || 0) - (ageFrom(b.birth_date) || 0));
  const age = Math.max(0, 15 * (1 - Math.max(0, diff - 2) / 10));
  return { score: Math.round(Math.min(60, common.length * 20) + near + age), common };
}

/* ---------- validação ---------- */
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function cleanInterests(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const t = clean(x, 24);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}
function imageKind(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/* ---------- CPF e CNPJ ---------- */
function validCpfCnpj(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return null;
  if (d.length === 11) {
    for (const n of [9, 10]) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
      const dv = ((sum * 10) % 11) % 10;
      if (dv !== Number(d[n])) return null;
    }
    return d;
  }
  if (d.length === 14) {
    for (const n of [12, 13]) {
      const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Number(d[i]) * w[i];
      const r = sum % 11;
      if ((r < 2 ? 0 : 11 - r) !== Number(d[n])) return null;
    }
    return d;
  }
  return null;
}

/** Só CPF (11 dígitos) com dígitos verificadores corretos. Devolve só os números, ou null. */
function validCpf(input) {
  const d = validCpfCnpj(input);
  return d && d.length === 11 ? d : null;
}
/** Resumo do CPF para detectar cadastro duplicado sem guardar o número (HMAC-SHA256 com segredo do servidor). */
function cpfHash(cpf, pepper) {
  return require('crypto').createHmac('sha256', pepper).update('cpf:' + cpf).digest('hex');
}

module.exports = {
  validCpfCnpj, validCpf, cpfHash,
  hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256,
  parseBirth, ageFrom, birthLimit, haversine, snap, cityPoint, distanceText, hash32,
  PLANS, PLAN_PRICES, CYCLE_MONTHS, priceOf, SHOP, FREE_CHAT_MESSAGES, chatUnlocked, isOnline, boostActive, affinity, effectivePlan, clean, EMAIL_RE, cleanInterests, imageKind,
};
