'use strict';
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, UPLOAD_DIR } = require('./db');
const L = require('./lib');
const cupid = require('./cupid');
const grants = require('./grants')({ db, L });
const { CITIES, UFS, byId: cityById } = require('./cities');
const { makeEvents } = require('./events');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const PAYMENTS = process.env.PAYMENTS_MODE || 'off'; // 'off' | 'demo' | 'asaas'
if (PROD && PAYMENTS === 'demo') throw new Error("PAYMENTS_MODE=demo libera planos de graça e não pode rodar em produção. Use 'off' ou 'asaas'.");
if (!['off', 'demo', 'asaas'].includes(PAYMENTS)) throw new Error("PAYMENTS_MODE precisa ser 'off', 'demo' ou 'asaas'.");
let asaasClient = null, asaasWebhookToken = null;
if (PAYMENTS === 'asaas') {
  const key = process.env.ASAAS_API_KEY || '';
  asaasWebhookToken = process.env.ASAAS_WEBHOOK_TOKEN || '';
  if (!key) throw new Error('PAYMENTS_MODE=asaas exige ASAAS_API_KEY.');
  if (asaasWebhookToken.length < 32 || asaasWebhookToken.length > 255 || /\s/.test(asaasWebhookToken) || asaasWebhookToken === key)
    throw new Error('ASAAS_WEBHOOK_TOKEN precisa ter de 32 a 255 caracteres, sem espaços, e ser diferente da chave da API.');
  const env = process.env.ASAAS_ENV || 'sandbox';
  asaasClient = require('./asaas').createClient({ apiKey: key, env, baseUrl: PROD ? undefined : process.env.ASAAS_BASE_URL });
  if (PROD && env !== 'production') console.warn('AVISO: ASAAS_ENV=sandbox em produção. Os pagamentos NÃO são reais.');
}
const DEMO_BOTS = process.env.DEMO_BOTS === '1';
// Segredo que protege o resumo (HMAC) dos CPFs. Em produção defina CPF_PEPPER; sem ele, geramos um e guardamos ao lado do banco.
const CPF_PEPPER = (() => {
  if (process.env.CPF_PEPPER) return process.env.CPF_PEPPER;
  const f = require('path').join(require('./db').DATA_DIR || process.env.DATA_DIR || require('path').join(__dirname, 'data'), 'cpf.pepper');
  const fs = require('fs');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { /* cria abaixo */ }
  const v = require('crypto').randomBytes(32).toString('hex');
  fs.mkdirSync(require('path').dirname(f), { recursive: true });
  fs.writeFileSync(f, v, { mode: 0o600 });
  return v;
})();
const SECURE_COOKIE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : PROD;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_PHOTOS = 5;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use((req, res, next) => { // recursos do navegador que o site não usa ficam desligados
  res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  next();
});
// Dados pessoais nunca ficam em cache de navegador ou de intermediários (fotos e listas públicas têm regra própria).
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/photos/') && req.path !== '/cities' && req.path !== '/plans') res.set('Cache-Control', 'no-store');
  next();
});
// Barra ferramentas de raspagem conhecidas (não pega quem disfarça o User-Agent: por isso há também limites por usuário).
const BOT_UA = /(curl|wget|python-requests|python-urllib|scrapy|httpx|aiohttp|libwww|go-http-client|okhttp|java\/|httrack|phantomjs|selenium|puppeteer|colly|node-fetch|axios|mechanize|postmanruntime)/i;
app.use('/api', (req, res, next) => {
  if (process.env.BOT_BLOCK === '0' || req.path === '/webhooks/asaas') return next();
  const ua = req.get('user-agent') || '';
  if (!ua || BOT_UA.test(ua)) return res.status(403).json({ error: 'Requisição recusada.' });
  next();
});
app.use(express.json({ limit: '20kb' }));

/* ---------- utilidades HTTP ---------- */
class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const bad = (msg) => new HttpError(400, msg);
const now = () => Date.now();
const intId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function readCookies(req) {
  const o = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignora */ } }
  }
  return o;
}
function setSession(res, token) {
  res.append('Set-Cookie', `pp_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.append('Set-Cookie', `pp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}`);
}

// Proteção CSRF: cookie SameSite=Lax + exigência de um cabeçalho que um site de fora não consegue enviar.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/webhooks/asaas') return next(); // o Asaas se autentica com o token do cabeçalho
  if (req.get('x-pertinho') !== '1') return res.status(403).json({ error: 'Requisição recusada.' });
  next();
});

const limitGeneral = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false });
const limitAuth = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT) || 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
const limitMsg = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user ? req.user.id : req.ip}`, validate: { keyGeneratorIpFallback: false }, message: { error: 'Você está enviando mensagens rápido demais.' } });
const limitUpload = rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user ? req.user.id : req.ip}`, validate: { keyGeneratorIpFallback: false }, message: { error: 'Limite de envios de foto atingido. Tente mais tarde.' } });
app.use('/api', limitGeneral);
const perUser = (windowMs, limit) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user ? req.user.id : req.ip}`, validate: { keyGeneratorIpFallback: false }, message: { error: 'Muitos pedidos em pouco tempo. Aguarde um pouco.' } });
const limitScrape = perUser(10 * 60_000, Number(process.env.SCRAPE_LIMIT) || 150); // descoberta e radar
const limitPhotos = perUser(10 * 60_000, Number(process.env.PHOTO_LIMIT) || 600);

/* ---------- autenticação ---------- */
const qSession = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?');
const qTouch = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

function loadUser(req, res, next) {
  const token = readCookies(req).pp_session;
  if (token) {
    const u = qSession.get(L.sha256(token), now());
    if (u) {
      if (!u.last_seen || now() - u.last_seen > 60_000) qTouch.run(now(), u.id);
      req.user = u;
      req.token = token;
    }
  }
  next();
}
app.use(loadUser);

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Sua conta está suspensa.', suspended: true, reason: req.user.suspend_reason || '' });
  next();
}
const ADMIN_IPS = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);
const adminIpOk = (req) => !ADMIN_IPS.length || ADMIN_IPS.includes(req.ip);
function requireAdmin(req, res, next) {
  if (!adminIpOk(req)) return res.status(404).json({ error: 'Rota não encontrada.' });
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito.' });
  next();
}

/* ---------- serialização ---------- */
const qPhotosOf = db.prepare("SELECT id, is_main FROM photos WHERE user_id = ? AND status = 'ok' ORDER BY is_main DESC, id ASC");
const planOf = (u) => L.PLANS[L.effectivePlan(u)];

function limitsJson(p) {
  return { maxRadius: p.maxRadius, dailyLikes: p.dailyLikes === Infinity ? null : p.dailyLikes, superPerDay: p.superPerDay, rewind: p.rewind, extraPhotos: p.extraPhotos, seeLikes: p.seeLikes, verifiedFilter: p.verifiedFilter, invisible: p.invisible, boost: p.boost };
}
function meJson(u) {
  const plan = L.effectivePlan(u);
  return {
    id: u.id, email: u.email, name: u.name, birthDate: u.birth_date, age: L.ageFrom(u.birth_date),
    gender: u.gender, seeking: u.seeking, bio: u.bio, interests: JSON.parse(u.interests || '[]'),
    cityId: u.city_id, cityName: u.city_name, hasLocation: u.lat != null, locSource: u.loc_source,
    emailConfirmed: confirmed(u), notifyEmail: u.notify_email !== 0,
    cpfMasked: u.cpf_last2 ? '***.***.***-' + u.cpf_last2 : null,
    invisible: !!u.invisible, verified: !!u.verified, role: u.role, renewalOff: !!u.renewal_off, anthem: u.anthem || '',
    plan, planUntil: plan === 'free' ? null : u.plan_until, limits: limitsJson(L.PLANS[plan]),
    passUntil: u.pass_until && u.pass_until > now() ? u.pass_until : null,
    boostUntil: L.boostActive(u) ? u.boost_until : null,
    photoCredits: u.photo_credits || 0,
    chatUnlocked: L.chatUnlocked(u), freeChatMessages: L.FREE_CHAT_MESSAGES,
    photos: qPhotosOf.all(u.id).map((p) => ({ id: p.id, isMain: !!p.is_main })),
  };
}
const qUnlocked = db.prepare('SELECT 1 FROM photo_unlocks WHERE user_id = ? AND target_id = ?');
const photosUnlocked = (viewer, targetId) => planOf(viewer).extraPhotos || !!qUnlocked.get(viewer.id, targetId);
function publicProfile(target, viewer, km) {
  const photos = qPhotosOf.all(target.id);
  const main = photos.find((p) => p.is_main) || photos[0];
  const extra = photos.filter((p) => !main || p.id !== main.id);
  const canSee = photosUnlocked(viewer, target.id);
  const aff = L.affinity(viewer, target, km);
  return {
    id: target.id, name: target.name, age: L.ageFrom(target.birth_date), bio: target.bio,
    interests: JSON.parse(target.interests || '[]'), verified: !!target.verified,
    anthem: target.anthem || '', online: L.isOnline(target), affinity: aff.score, commonInterests: aff.common,
    boosted: L.boostActive(target),
    cityName: target.city_name, distanceKm: km == null ? null : Math.max(1, Math.round(km)),
    distanceText: km == null ? null : L.distanceText(km),
    premium: L.effectivePlan(target) === 'premium',
    mainPhotoId: main ? main.id : null,
    extraCount: extra.length,
    extraPhotoIds: canSee ? extra.map((p) => p.id) : [],
    extraLocked: !canSee && extra.length > 0,
  };
}
const distBetween = (a, b) => (a.lat == null || b.lat == null ? null : L.fuzzyDistance(a, b));

const isBlocked = db.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)');
const blockedBetween = (a, b) => !!isBlocked.get(a, b, b, a);
const audit = (adminId, action, target, detail) =>
  db.prepare('INSERT INTO audit_log (admin_id, action, target, detail, created_at) VALUES (?,?,?,?,?)').run(adminId, action, target, detail ? String(detail).slice(0, 500) : null, now());

/* ---------- dados públicos ---------- */
app.get('/api/cities', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400').json({ ufs: UFS, cities: CITIES.map((c) => [c.id, c.name, c.uf]) });
});
app.get('/api/plans', (req, res) => {
  res.json({
    paymentsEnabled: PAYMENTS === 'demo' || PAYMENTS === 'asaas',
    paymentsMode: PAYMENTS,
    plans: Object.values(L.PLANS).map((p) => ({ id: p.id, name: p.name, priceCents: p.priceCents, prices: L.PLAN_PRICES[p.id] || null, limits: limitsJson(p) })),
    cycles: L.CYCLE_MONTHS,
    shop: Object.values(L.SHOP).map((x) => ({ id: x.id, name: x.name, priceCents: x.priceCents, desc: x.desc })),
    freeChatMessages: L.FREE_CHAT_MESSAGES,
  });
});

const referrals = require('./referrals')({ db, now, pepper: CPF_PEPPER });

/* ---------- cadastro e login ---------- */
const qEmail = db.prepare('SELECT * FROM users WHERE email = ?');

async function startSession(res, userId) {
  const token = L.newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(L.sha256(token), userId, now() + SESSION_MS, now());
  setSession(res, token);
}

app.post('/api/auth/register', limitAuth, async (req, res) => {
  const b = req.body || {};
  const email = L.clean(b.email, 160).toLowerCase();
  const password = String(b.password || '');
  const name = L.clean(b.name, 30);
  const bio = L.clean(b.bio, 200);
  if (!L.EMAIL_RE.test(email)) throw bad('Informe um e-mail válido.');
  if (password.length < 8 || password.length > 200) throw bad('A senha precisa ter de 8 a 200 caracteres.');
  if (name.length < 2) throw bad('Informe seu nome com pelo menos 2 letras.');
  if (!L.parseBirth(b.birthDate)) throw bad('Informe sua data de nascimento.');
  const age = L.ageFrom(b.birthDate);
  if (age < 18) throw bad('O Pertinho é só para maiores de 18 anos.');
  if (age > 99) throw bad('Informe uma data de nascimento válida.');
  const cpf = L.validCpf(b.cpf);
  if (!cpf) throw bad('Informe um CPF válido. Só aceitamos cadastros com CPF real.');
  if (!['f', 'm', 'o'].includes(b.gender)) throw bad('Informe como você se identifica.');
  const seeking = ['f', 'm', 'all'].includes(b.seeking) ? b.seeking : 'all';
  if (b.terms !== true) throw bad('É preciso aceitar os termos de uso.');
  const city = cityById(b.cityId);
  if (!city) throw bad('Escolha sua cidade.');
  if (qEmail.get(email)) throw bad('Este e-mail já tem cadastro. Entre na sua conta.');
  const cpfH = L.cpfHash(cpf, CPF_PEPPER);
  if (db.prepare('SELECT 1 FROM cpf_blocked WHERE cpf_hash = ?').get(cpfH)) throw new HttpError(403, 'Este CPF não pode criar um novo cadastro. Fale com o suporte.');
  if (db.prepare('SELECT 1 FROM users WHERE cpf_hash = ?').get(cpfH)) throw new HttpError(409, 'Este CPF já tem cadastro. Entre na conta existente ou fale com o suporte.');

  // Conferência em base oficial (quando contratada): idade e nome vêm do CPF, não do que a pessoa digitou.
  let cpfOfficial = 0, birthDate = b.birthDate;
  const chk = await cpfCheck.verify(cpf, { name, birth: String(b.birthDate) });
  if (chk.enabled) {
    if (chk.status === 'minor') { audit(null, 'signup.minor_blocked', `cpf_last2:${cpf.slice(-2)}`, ''); throw new HttpError(403, 'O Pertinho é só para maiores de 18 anos.'); }
    if (chk.status === 'notfound') throw bad('Não encontramos este CPF na base da Receita Federal. Confira os números.');
    if (chk.status === 'blocked') throw bad('Este CPF não pode ser usado no cadastro (situação cadastral irregular).');
    if (chk.status === 'mismatch') throw bad('O nome e a data de nascimento não conferem com este CPF. Use seu primeiro nome como no documento.');
    if (chk.status === 'unavailable' && chk.required) throw new HttpError(503, 'Não conseguimos conferir o CPF agora. Tente de novo em alguns minutos.');
    if (chk.status === 'ok') { cpfOfficial = 1; birthDate = chk.birth; }
  }

  const hash = await L.hashPassword(password);
  const info = db
    .prepare(`INSERT INTO users (email, pass_hash, name, birth_date, gender, seeking, bio, interests, city_id, city_name, lat, lng, loc_source, terms_at, created_at, last_seen, cpf_hash, cpf_last2)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(email, hash, name, birthDate, b.gender, seeking, bio, JSON.stringify(L.cleanInterests(b.interests)), city.id, `${city.name} - ${city.uf}`, null, null, 'city', now(), now(), now(), cpfH, cpf.slice(-2));
  const id = Number(info.lastInsertRowid);
  if (cpfOfficial) db.prepare('UPDATE users SET cpf_checked = 1 WHERE id = ?').run(id);
  const pt = L.cityPoint(city, id);
  db.prepare('UPDATE users SET lat = ?, lng = ? WHERE id = ?').run(pt.lat, pt.lng, id);
  referrals.ensureCode(id);
  if (mailer.enabled()) sendConfirmMail(req, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  const ref = b.ref ? referrals.onRegister(id, b.ref, req.ip) : null;
  await startSession(res, id);
  res.status(201).json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), referral: ref ? 'pending' : null });
});

/* ---------- indicação automática ---------- */
app.get('/api/me/referral', requireAuth, (req, res) => {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.json(referrals.summary(req.user.id, base));
});

const loginFails = new Map(); // bloqueio temporário por e-mail + IP, para não travar a conta da vítima a partir de outro lugar
const LOGIN_MAX_FAILS = 6;
app.post('/api/auth/login', limitAuth, async (req, res) => {
  const email = L.clean(req.body?.email, 160).toLowerCase();
  const password = String(req.body?.password || '');
  const u = qEmail.get(email);
  const lk = loginFails.get(`${email}|${req.ip}`);
  if (lk && lk.until > now()) throw new HttpError(429, 'Muitas tentativas erradas. Aguarde alguns minutos e tente de novo, ou use "Esqueci a senha".');
  const ok = await L.verifyPassword(password, u ? u.pass_hash : L.DUMMY_HASH);
  if (!u || !ok || (u.role === 'admin' && !adminIpOk(req))) {
    const k = `${email}|${req.ip}`, f = loginFails.get(k) || { n: 0 };
    f.n++; if (f.n >= LOGIN_MAX_FAILS) { f.until = now() + 15 * 60_000; f.n = 0; }
    loginFails.set(k, f); if (loginFails.size > 5000) loginFails.clear();
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  loginFails.delete(`${email}|${req.ip}`);
  if (u.status !== 'active') return res.status(403).json({ error: 'Sua conta está suspensa.', suspended: true, reason: u.suspend_reason || '' });
  await startSession(res, u.id);
  qTouch.run(now(), u.id);
  res.json({ user: meJson(u) });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(L.sha256(req.token));
  clearSession(res);
  res.json({ ok: true });
});

app.post('/api/auth/password', requireAuth, limitAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await L.verifyPassword(String(current || ''), req.user.pass_hash))) throw new HttpError(400, 'A senha atual está incorreta.');
  if (String(next || '').length < 8 || String(next).length > 200) throw bad('A nova senha precisa ter de 8 a 200 caracteres.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await L.hashPassword(String(next)), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, L.sha256(req.token));
  res.json({ ok: true });
});

/* ---------- recuperação de senha ---------- */
const mailer = require('./mailer');
const cpfCheck = require('./cpfcheck').makeCpfCheck();
const notify = require('./notify').makeNotify({ db, mailer, now, secret: CPF_PEPPER, cityById });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RESET_MS = 60 * 60 * 1000;
const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
function makeResetToken(userId) {
  const token = L.newToken();
  db.transaction(() => {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(L.sha256(token), userId, now() + RESET_MS, now());
  })();
  return token;
}
/* ---------- confirmação de e-mail ---------- */
// Só vale quando o envio de e-mail está configurado (RESEND_API_KEY + MAIL_FROM). Sem isso, ninguém fica bloqueado.
const CONFIRM_MS = 48 * 60 * 60 * 1000;
const confirmed = (u) => !mailer.enabled() || !!u.email_verified_at || u.role === 'admin' || !!u.is_demo;
function sendConfirmMail(req, u) {
  const token = L.newToken();
  db.transaction(() => {
    db.prepare('DELETE FROM email_confirms WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO email_confirms (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(L.sha256(token), u.id, now() + CONFIRM_MS, now());
  })();
  const link = `${publicBase(req)}/?confirm=${token}`;
  return mailer.sendMail({
    to: u.email, subject: 'Confirme seu e-mail no Pertinho',
    text: `Olá, ${u.name}!\n\nConfirme seu e-mail para curtir e conversar (o link vale por 48 horas):\n${link}\n\nSe não foi você, ignore esta mensagem.`,
    html: `<p>Olá, ${esc(u.name)}!</p><p>Confirme seu e-mail para curtir e conversar: <a href="${link}">clique aqui</a> (vale por 48 horas).</p><p>Se não foi você, ignore esta mensagem.</p>`,
  }).catch(() => {});
}
function requireConfirmed(req, res, next) {
  if (!confirmed(req.user)) return res.status(403).json({ error: 'Confirme seu e-mail para curtir e conversar. Enviamos um link para ' + req.user.email + '.', needsConfirm: true });
  next();
}
app.post('/api/auth/confirm', limitAuth, (req, res) => {
  const token = String(req.body?.token || '');
  const row = /^[A-Za-z0-9_-]{20,100}$/.test(token) && db.prepare('SELECT * FROM email_confirms WHERE token_hash = ? AND expires_at > ?').get(L.sha256(token), now());
  if (!row) throw bad('Este link expirou ou já foi usado. Entre na sua conta e peça outro.');
  db.transaction(() => {
    db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(now(), row.user_id);
    db.prepare('DELETE FROM email_confirms WHERE user_id = ?').run(row.user_id);
  })();
  const hasPhoto = db.prepare("SELECT 1 FROM photos WHERE user_id = ? AND status = 'ok'").get(row.user_id);
  const act = hasPhoto ? referrals.activate(row.user_id) : null; // quem já tinha foto e só faltava confirmar libera o prêmio da indicação agora
  if (act && act.status === 'rewarded') audit(null, 'referral.reward', `user:${row.user_id}`, `indicador ${act.referrerId}, total ${act.total}${act.bonus ? ', bônus Plus' : ''}`);
  res.json({ ok: true });
});
app.post('/api/auth/resend-confirm', requireAuth, limitAuth, async (req, res) => {
  if (confirmed(req.user)) return res.json({ ok: true, already: true });
  const last = db.prepare('SELECT created_at FROM email_confirms WHERE user_id = ?').get(req.user.id);
  if (last && now() - last.created_at < 60_000) throw new HttpError(429, 'Aguarde um minuto para pedir outro e-mail.');
  await sendConfirmMail(req, req.user);
  res.json({ ok: true });
});
// Resposta sempre igual, exista ou não o e-mail, para ninguém descobrir quem tem conta.
app.post('/api/auth/forgot', limitAuth, async (req, res) => {
  const email = L.clean(req.body?.email, 160).toLowerCase();
  const u = L.EMAIL_RE.test(email) && qEmail.get(email);
  if (u && u.status === 'active' && u.role !== 'admin' && mailer.enabled()) {
    const link = `${publicBase(req)}/?reset=${makeResetToken(u.id)}`;
    mailer.sendMail({
      to: u.email, subject: 'Redefinir sua senha do Pertinho',
      text: `Olá, ${u.name}!\n\nPara criar uma nova senha, abra o link abaixo (vale por 1 hora):\n${link}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.`,
      html: `<p>Olá, ${esc(u.name)}!</p><p>Para criar uma nova senha, <a href="${link}">clique aqui</a> (vale por 1 hora).</p><p>Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>`,
    }).catch(() => {});
  }
  res.json({ ok: true, emailEnabled: mailer.enabled() });
});
app.post('/api/auth/reset', limitAuth, async (req, res) => {
  const token = String(req.body?.token || ''), password = String(req.body?.password || '');
  if (password.length < 8 || password.length > 200) throw bad('A nova senha precisa ter de 8 a 200 caracteres.');
  const row = /^[A-Za-z0-9_-]{20,100}$/.test(token) && db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?').get(L.sha256(token), now());
  if (!row) throw bad('Este link expirou ou já foi usado. Peça um novo.');
  const hash = await L.hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
  })();
  res.json({ ok: true });
});

/* ---------- meu perfil ---------- */
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  if (req.user.status !== 'active') return res.json({ user: null, suspended: true, reason: req.user.suspend_reason || '' });
  res.json({ user: meJson(req.user) });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const set = {};
  if (b.name !== undefined) { const n = L.clean(b.name, 30); if (n.length < 2) throw bad('Informe seu nome com pelo menos 2 letras.'); set.name = n; }
  if (b.bio !== undefined) set.bio = L.clean(b.bio, 200);
  if (b.anthem !== undefined) set.anthem = L.clean(b.anthem, 80);
  if (b.gender !== undefined) { if (!['f', 'm', 'o'].includes(b.gender)) throw bad('Valor inválido.'); set.gender = b.gender; }
  if (b.seeking !== undefined) { if (!['f', 'm', 'all'].includes(b.seeking)) throw bad('Valor inválido.'); set.seeking = b.seeking; }
  if (b.interests !== undefined) set.interests = JSON.stringify(L.cleanInterests(b.interests));
  if (b.notifyEmail !== undefined) set.notify_email = b.notifyEmail ? 1 : 0;
  if (b.invisible !== undefined) {
    if (b.invisible && !planOf(u).invisible) throw new HttpError(402, 'O modo invisível faz parte do plano Premium.');
    set.invisible = b.invisible ? 1 : 0;
  }
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), u.id);
  res.json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

const LOC_MAX_PER_DAY = Number(process.env.LOC_MAX_PER_DAY) || 3;
const LOC_MAX_JUMP_KM = 400, LOC_JUMP_WINDOW_MS = 6 * 3600 * 1000;
app.post('/api/me/location', requireAuth, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  // Trocar de lugar sem parar serve para descobrir onde alguém está: limite diário e sem saltos impossíveis.
  const recent = db.prepare('SELECT lat, lng, at FROM loc_changes WHERE user_id = ? AND at > ? ORDER BY at DESC').all(u.id, now() - DAY);
  if (recent.length >= LOC_MAX_PER_DAY) throw new HttpError(429, `Você já trocou de localização ${LOC_MAX_PER_DAY} vezes hoje. Tente de novo amanhã.`);
  const last = recent[0];
  let target = null;
  if (b.cityId === undefined) {
    const la = Number(b.lat), lo = Number(b.lng);
    if (Number.isFinite(la) && Number.isFinite(lo)) target = { lat: la, lng: lo };
  } else { const c = cityById(b.cityId); if (c) target = { lat: c.lat, lng: c.lng }; }
  if (target && last && now() - last.at < LOC_JUMP_WINDOW_MS && L.haversine(last.lat, last.lng, target.lat, target.lng) > LOC_MAX_JUMP_KM)
    throw new HttpError(429, 'Essa mudança é longe demais para tão pouco tempo. Tente de novo mais tarde.');
  if (target) db.prepare('INSERT INTO loc_changes (user_id, lat, lng, at) VALUES (?,?,?,?)').run(u.id, target.lat, target.lng, now());
  if (b.cityId !== undefined) {
    const city = cityById(b.cityId);
    if (!city) throw bad('Cidade inválida.');
    const pt = L.cityPoint(city, u.id);
    db.prepare("UPDATE users SET city_id=?, city_name=?, lat=?, lng=?, loc_source='city' WHERE id=?").run(city.id, `${city.name} - ${city.uf}`, pt.lat, pt.lng, u.id);
  } else {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad('Localização inválida.');
    let near = null, best = Infinity;
    for (const c of CITIES) { const d = L.haversine(lat, lng, c.lat, c.lng); if (d < best) { best = d; near = c; } }
    const label = best <= 60 ? `${near.name} - ${near.uf}` : 'Localização por GPS';
    db.prepare("UPDATE users SET lat=?, lng=?, city_id=?, city_name=?, loc_source='gps' WHERE id=?").run(L.snap(lat), L.snap(lng), best <= 60 ? near.id : null, label, u.id);
  }
  res.json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

/* ---------- fotos ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

app.post('/api/me/photos', requireAuth, limitUpload, upload.single('photo'), async (req, res) => {
  if (!req.file) throw bad('Escolha uma imagem.');
  if (!L.imageKind(req.file.buffer)) throw bad('Use uma imagem JPG, PNG ou WebP.');
  const count = db.prepare("SELECT COUNT(*) c FROM photos WHERE user_id = ? AND status = 'ok'").get(req.user.id).c;
  if (count >= MAX_PHOTOS) throw bad(`Você pode ter até ${MAX_PHOTOS} fotos (1 principal e 4 extras).`);
  // Reprocessa a imagem: aplica a rotação, remove metadados (inclui a localização GPS da câmera) e limita o tamanho.
  let out;
  try {
    out = await sharp(req.file.buffer, { limitInputPixels: 40e6 })
      .rotate()
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw bad('Não consegui ler essa imagem. Use um JPG, PNG ou WebP válido.');
  }
  const filename = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), out, { mode: 0o640 });
  const isMain = count === 0 || req.body?.main === '1' ? 1 : 0;
  db.transaction(() => {
    if (isMain) db.prepare('UPDATE photos SET is_main = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('INSERT INTO photos (user_id, filename, mime, is_main, created_at) VALUES (?,?,?,?,?)').run(req.user.id, filename, 'image/jpeg', isMain, now());
  })();
  const act = confirmed(req.user) ? referrals.activate(req.user.id) : null; // a primeira foto ativa a conta e libera o prêmio da indicação
  if (act && act.status === 'rewarded') audit(null, 'referral.reward', `user:${req.user.id}`, `indicador ${act.referrerId}, total ${act.total}${act.bonus ? ', bônus Plus' : ''}`);
  res.status(201).json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)), referral: act ? act.status : null });
});

app.post('/api/me/photos/:id/main', requireAuth, (req, res) => {
  const id = intId(req.params.id);
  const p = id && db.prepare("SELECT * FROM photos WHERE id = ? AND user_id = ? AND status = 'ok'").get(id, req.user.id);
  if (!p) throw new HttpError(404, 'Foto não encontrada.');
  db.transaction(() => {
    db.prepare('UPDATE photos SET is_main = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE photos SET is_main = 1 WHERE id = ?').run(id);
  })();
  res.json({ user: meJson(req.user) });
});

function deletePhotoRow(p) {
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
  if (p.is_main) {
    const next = db.prepare("SELECT id FROM photos WHERE user_id = ? AND status = 'ok' ORDER BY id LIMIT 1").get(p.user_id);
    if (next) db.prepare('UPDATE photos SET is_main = 1 WHERE id = ?').run(next.id);
  }
}
app.delete('/api/me/photos/:id', requireAuth, (req, res) => {
  const id = intId(req.params.id);
  const p = id && db.prepare('SELECT * FROM photos WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!p) throw new HttpError(404, 'Foto não encontrada.');
  deletePhotoRow(p);
  res.json({ user: meJson(req.user) });
});

// A foto principal é visível para quem está logado. As extras só para o dono, administradores e planos pagos.
app.get('/api/photos/:id', requireAuth, limitPhotos, (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Requisição recusada.'); // sem hotlink de outros sites
  const id = intId(req.params.id);
  const p = id && db.prepare("SELECT p.*, u.status AS ustatus FROM photos p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.status = 'ok'").get(id);
  if (!p) throw new HttpError(404, 'Foto não encontrada.');
  const viewer = req.user;
  const owner = p.user_id === viewer.id;
  if (!owner && viewer.role !== 'admin') {
    if (p.ustatus !== 'active' || blockedBetween(viewer.id, p.user_id)) throw new HttpError(404, 'Foto não encontrada.');
    const main = db.prepare("SELECT id FROM photos WHERE user_id = ? AND status = 'ok' ORDER BY is_main DESC, id LIMIT 1").get(p.user_id);
    const isMain = main && main.id === p.id;
    if (!isMain && !photosUnlocked(viewer, p.user_id)) throw new HttpError(402, 'As fotos extras estão disponíveis nos planos pagos ou com o pacote de desbloqueios.');
  }
  res.set({
    'Content-Type': p.mime,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  const file = path.join(UPLOAD_DIR, path.basename(p.filename));
  res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

/* ---------- verificação por selfie com pose ---------- */
// A pessoa recebe uma pose sorteada, envia uma selfie e um administrador compara com a foto principal.
// A selfie fica guardada só até a decisão e é apagada logo depois. Nada é processado por serviço externo.
const limitVerify = rateLimit({ windowMs: 24 * 3600_000, limit: 6, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `u${req.user ? req.user.id : req.ip}`, validate: { keyGeneratorIpFallback: false }, message: { error: 'Muitas tentativas de verificação hoje. Tente amanhã.' } });
const DRAFT_MS = 60 * 60 * 1000;
const lastVerification = (uid) => db.prepare('SELECT * FROM verifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
const verifJson = (u, v) => ({
  verified: !!u.verified,
  status: u.verified ? 'approved' : v ? (v.status === 'draft' && now() - v.created_at > DRAFT_MS ? 'none' : v.status === 'draft' ? 'draft' : v.status) : 'none',
  pose: v && v.status === 'draft' && now() - v.created_at <= DRAFT_MS ? v.pose : null,
  reason: v && v.status === 'rejected' ? v.reason : null,
});
const rmVerifFile = (name) => { if (name) { try { fs.rmSync(path.join(UPLOAD_DIR, path.basename(name)), { force: true }); } catch { /* já removida */ } } };

app.get('/api/me/verification', requireAuth, (req, res) => res.json(verifJson(req.user, lastVerification(req.user.id))));
app.post('/api/me/verification/start', requireAuth, limitVerify, (req, res) => {
  const u = req.user;
  if (u.verified) throw bad('Seu perfil já é verificado.');
  if (!db.prepare("SELECT 1 FROM photos WHERE user_id = ? AND is_main = 1 AND status = 'ok'").get(u.id)) throw bad('Adicione uma foto principal antes de pedir a verificação.');
  const v = lastVerification(u.id);
  if (v && v.status === 'pending') throw bad('Seu pedido já está em análise.');
  if (!(v && v.status === 'draft' && now() - v.created_at <= DRAFT_MS)) {
    db.prepare("DELETE FROM verifications WHERE user_id = ? AND status = 'draft'").run(u.id);
    const pose = cupid.POSES[crypto.randomInt(cupid.POSES.length)];
    db.prepare("INSERT INTO verifications (user_id, pose, status, created_at) VALUES (?,?,'draft',?)").run(u.id, pose, now());
  }
  res.json(verifJson(u, lastVerification(u.id)));
});
app.post('/api/me/verification', requireAuth, limitVerify, upload.single('selfie'), async (req, res) => {
  const u = req.user;
  if (u.verified) throw bad('Seu perfil já é verificado.');
  const v = lastVerification(u.id);
  if (!v || v.status !== 'draft' || now() - v.created_at > DRAFT_MS) throw bad('Peça uma pose primeiro e envie a selfie em até 1 hora.');
  if (!req.file) throw bad('Tire ou escolha uma selfie.');
  if (!L.imageKind(req.file.buffer)) throw bad('Use uma imagem JPG, PNG ou WebP.');
  let out;
  try { out = await sharp(req.file.buffer, { limitInputPixels: 40e6 }).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(); }
  catch { throw bad('Não consegui ler essa imagem. Use um JPG, PNG ou WebP válido.'); }
  const filename = `v_${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), out, { mode: 0o600 });
  db.prepare("UPDATE verifications SET filename = ?, status = 'pending', created_at = ? WHERE id = ?").run(filename, now(), v.id);
  res.status(201).json(verifJson(u, lastVerification(u.id)));
});

/* ---------- descoberta ---------- */
// Com envio de e-mail ligado, só aparece para os outros quem confirmou o e-mail (perfis de demonstração sempre aparecem).
const VIS = mailer.enabled() ? ' AND (u.email_verified_at IS NOT NULL OR u.is_demo = 1)' : '';
const DAY = 24 * 3600 * 1000;
const qLikesToday = db.prepare("SELECT COUNT(*) c FROM swipes WHERE from_id = ? AND kind = 'like' AND created_at > ?");
const qSuperToday = db.prepare("SELECT COUNT(*) c FROM swipes WHERE from_id = ? AND kind = 'super' AND created_at > ?");

app.get('/api/discover', requireAuth, limitScrape, (req, res) => {
  const me = req.user;
  const plan = planOf(me);
  if (me.lat == null) throw bad('Defina sua cidade ou localização primeiro.');
  const hasMain = db.prepare("SELECT 1 FROM photos WHERE user_id = ? AND is_main = 1 AND status = 'ok'").get(me.id);
  const radius = Math.min(plan.maxRadius, Math.max(1, Number(req.query.radius) || 10));
  const ageMin = Math.min(99, Math.max(18, Number(req.query.ageMin) || 18));
  const ageMax = Math.min(99, Math.max(ageMin, Number(req.query.ageMax) || 60));
  const onlyVerified = req.query.verified === '1' && plan.verifiedFilter;
  const onlyOnline = req.query.online === '1';
  const dLat = (radius + L.DIST_NOISE_KM) / 111;
  const dLng = (radius + L.DIST_NOISE_KM) / (111 * Math.max(0.2, Math.cos((me.lat * Math.PI) / 180)));
  const rows = db
    .prepare(
      `SELECT u.* FROM users u
       WHERE u.id != @me AND u.role = 'user' AND u.status = 'active' AND u.invisible = 0${VIS}
         AND u.lat BETWEEN @latMin AND @latMax AND u.lng BETWEEN @lngMin AND @lngMax
         AND u.birth_date <= @bornBy AND u.birth_date > @bornAfter
         AND (@verified = 0 OR u.verified = 1)
         AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.from_id = @me AND s.to_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = @me AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = @me))
         AND EXISTS (SELECT 1 FROM photos p WHERE p.user_id = u.id AND p.is_main = 1 AND p.status = 'ok')`
    )
    .all({
      me: me.id, latMin: me.lat - dLat, latMax: me.lat + dLat, lngMin: me.lng - dLng, lngMax: me.lng + dLng,
      bornBy: L.birthLimit(ageMin), bornAfter: L.birthLimit(ageMax + 1), verified: onlyVerified ? 1 : 0,
    });
  const wantG = ['f', 'm'].includes(req.query.gender) ? req.query.gender : null;
  const list = [];
  for (const u of rows) {
    if (!(me.seeking === 'all' || me.seeking === u.gender)) continue;
    if (!(u.seeking === 'all' || u.seeking === me.gender)) continue;
    if (wantG && u.gender !== wantG) continue;
    const km = distBetween(me, u);
    if (km > radius) continue;
    if (onlyOnline && !L.isOnline(u)) continue;
    list.push({ u, km });
  }
  // quem comprou Destaque vem primeiro; depois, mais perto primeiro e perfis Premium sobem dentro da mesma faixa de 2 km
  list.sort((a, b) => {
    const xa = L.boostActive(a.u) ? 0 : 1, xb = L.boostActive(b.u) ? 0 : 1;
    if (xa !== xb) return xa - xb;
    const ba = Math.floor(a.km / 2), bb = Math.floor(b.km / 2);
    if (ba !== bb) return ba - bb;
    const pa = L.effectivePlan(a.u) === 'premium' ? 0 : 1, pb = L.effectivePlan(b.u) === 'premium' ? 0 : 1;
    return pa - pb || a.km - b.km;
  });
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const likesUsed = plan.dailyLikes === Infinity ? 0 : qLikesToday.get(me.id, now() - 24 * 3600 * 1000).c;
  res.json({
    radius, total: list.length, needsPhoto: !hasMain,
    likesLeft: plan.dailyLikes === Infinity ? null : Math.max(0, plan.dailyLikes - likesUsed),
    superLeft: Math.max(0, plan.superPerDay - qSuperToday.get(me.id, now() - DAY).c),
    profiles: list.slice(0, limit).map(({ u, km }) => publicProfile(u, me, km)),
  });
});

// Radar do Brasil: quantas pessoas há por estado e, escolhendo um estado, por cidade. Só números, nunca perfis.
app.get('/api/radar', requireAuth, limitScrape, (req, res) => {
  const uf = String(req.query.uf || '').toUpperCase();
  const base = "FROM users u WHERE u.role = 'user' AND u.status = 'active' AND u.city_id IS NOT NULL" + VIS;
  if (!uf) {
    const rows = db.prepare(`SELECT substr(u.city_id, -2) AS uf, COUNT(*) n ${base} GROUP BY 1`).all();
    const by = Object.fromEntries(rows.map((r) => [r.uf.toUpperCase(), r.n]));
    return res.json({ total: rows.reduce((a, r) => a + r.n, 0), states: Object.keys(UFS).map((k) => ({ uf: k, name: UFS[k], n: by[k] || 0 })) });
  }
  if (!UFS[uf]) throw bad('Estado inválido.');
  const rows = db.prepare(`SELECT u.city_id, COUNT(*) n ${base} AND u.city_id LIKE ? GROUP BY u.city_id ORDER BY n DESC LIMIT 60`).all('%-' + uf.toLowerCase());
  const cities = rows.map((r) => { const c = cityById(r.city_id); return c ? { id: c.id, name: c.name, n: r.n } : null; }).filter(Boolean);
  res.json({ uf, name: UFS[uf], total: cities.reduce((a, c) => a + c.n, 0), cities });
});
app.get('/api/discover/count', requireAuth, (req, res) => {
  // quantas pessoas existem por raio (1, 5, 10, 25, 50, 100 km), para o mapa
  const me = req.user;
  if (me.lat == null) return res.json({ rings: [] });
  const rows = db.prepare(`SELECT u.id, u.lat, u.lng, u.gender, u.seeking FROM users u WHERE u.id != ? AND u.role='user' AND u.status='active' AND u.invisible=0${VIS} AND u.lat IS NOT NULL AND EXISTS (SELECT 1 FROM photos p WHERE p.user_id=u.id AND p.is_main=1 AND p.status='ok')`).all(me.id);
  const rings = [1, 5, 10, 25, 50, 100].map((r) => ({ km: r, count: 0 }));
  for (const u of rows) {
    if (!(me.seeking === 'all' || me.seeking === u.gender) || !(u.seeking === 'all' || u.seeking === me.gender)) continue;
    const d = L.fuzzyDistance(me, u);
    for (const r of rings) if (d <= r.km) r.count++;
  }
  res.json({ rings });
});

const qMatchBetween = db.prepare('SELECT id FROM matches WHERE a_id = ? AND b_id = ?');
function createMatch(x, y) {
  const a = Math.min(x, y), b = Math.max(x, y);
  const ex = qMatchBetween.get(a, b);
  if (ex) { db.prepare('UPDATE matches SET accepted_at = ? WHERE id = ? AND direct_by IS NOT NULL AND accepted_at IS NULL').run(now(), ex.id); return ex.id; } // curtida recíproca aceita o pedido
  const id = Number(db.prepare('INSERT INTO matches (a_id, b_id, created_at) VALUES (?,?,?)').run(a, b, now()).lastInsertRowid);
  try { notify.match(a, b, id); } catch (e) { console.error(e); }
  return id;
}

function swipeState(me, plan) {
  return {
    likesLeft: plan.dailyLikes === Infinity ? null : Math.max(0, plan.dailyLikes - qLikesToday.get(me.id, now() - DAY).c),
    superLeft: Math.max(0, plan.superPerDay - qSuperToday.get(me.id, now() - DAY).c),
  };
}
app.post('/api/swipe', requireAuth, requireConfirmed, (req, res) => {
  const me = req.user;
  const toId = intId(req.body?.userId);
  const kind = req.body?.kind;
  if (!toId || toId === me.id || !['like', 'pass', 'super'].includes(kind)) throw bad('Pedido inválido.');
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status = 'active'").get(toId);
  if (!target || blockedBetween(me.id, toId)) throw new HttpError(404, 'Perfil não encontrado.');
  const plan = planOf(me);
  if (kind === 'like' && plan.dailyLikes !== Infinity) {
    const used = qLikesToday.get(me.id, now() - DAY).c;
    if (used >= plan.dailyLikes) throw new HttpError(402, `Você usou as ${plan.dailyLikes} curtidas das últimas 24 horas. Assine o Plus para curtir sem limite.`);
  }
  if (kind === 'super' && qSuperToday.get(me.id, now() - DAY).c >= plan.superPerDay) {
    throw new HttpError(402, plan.id === 'free' ? 'Você já usou sua Super Curtida das últimas 24 horas. O Plus dá 5 por dia e o Premium dá 10.' : `Você usou as ${plan.superPerDay} Super Curtidas das últimas 24 horas.`);
  }
  db.prepare('INSERT OR REPLACE INTO swipes (from_id, to_id, kind, created_at) VALUES (?,?,?,?)').run(me.id, toId, kind, now());
  let matchId = null;
  if (kind !== 'pass') {
    const back = db.prepare("SELECT 1 FROM swipes WHERE from_id = ? AND to_id = ? AND kind IN ('like','super')").get(toId, me.id);
    let reciprocate = !!back;
    if (!reciprocate && target.is_demo && process.env.DEMO_AUTOLIKE === '1' && L.hash32(me.id * 7919 + toId) % 100 < (kind === 'super' ? 90 : 65)) {
      db.prepare('INSERT OR REPLACE INTO swipes (from_id, to_id, kind, created_at) VALUES (?,?,?,?)').run(toId, me.id, 'like', now());
      reciprocate = true;
    }
    if (reciprocate) matchId = createMatch(me.id, toId);
  }
  res.json({ match: !!matchId, matchId, ...swipeState(me, plan), profile: matchId ? publicProfile(target, me, distBetween(me, target)) : null });
});

// Desfazer a última escolha (planos Plus e Premium). Não vale se a escolha gerou match.
app.post('/api/swipe/undo', requireAuth, (req, res) => {
  const me = req.user;
  const plan = planOf(me);
  if (!plan.rewind) throw new HttpError(402, 'Desfazer a última escolha faz parte dos planos Plus e Premium.');
  const last = db.prepare('SELECT rowid AS rid, * FROM swipes WHERE from_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(me.id);
  if (!last) throw new HttpError(404, 'Não há nada para desfazer.');
  if (now() - last.created_at > DAY) throw bad('Só dá para desfazer escolhas das últimas 24 horas.');
  if (qMatchBetween.get(Math.min(me.id, last.to_id), Math.max(me.id, last.to_id))) throw new HttpError(409, 'Essa escolha gerou um match. Para desfazer, use "Desfazer match" na conversa.');
  db.prepare('DELETE FROM swipes WHERE from_id = ? AND to_id = ?').run(me.id, last.to_id);
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status = 'active' AND invisible = 0").get(last.to_id);
  if (!target || blockedBetween(me.id, target.id)) throw new HttpError(404, 'Esse perfil não está mais disponível.');
  res.json({ profile: publicProfile(target, me, distBetween(me, target)), ...swipeState(me, plan) });
});

app.get('/api/likes-received', requireAuth, (req, res) => {
  const me = req.user;
  const rows = db
    .prepare(
      `SELECT u.*, s.kind AS swipe_kind FROM swipes s JOIN users u ON u.id = s.from_id
       WHERE s.to_id = @me AND s.kind IN ('like','super') AND u.status = 'active' AND u.invisible = 0${VIS}
         AND NOT EXISTS (SELECT 1 FROM swipes x WHERE x.from_id = @me AND x.to_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=@me AND b.blocked_id=u.id) OR (b.blocker_id=u.id AND b.blocked_id=@me))
       ORDER BY (s.kind = 'super') DESC, s.created_at DESC LIMIT 50`
    )
    .all({ me: me.id });
  const superCount = rows.filter((r) => r.swipe_kind === 'super').length;
  if (!planOf(me).seeLikes) return res.json({ count: rows.length, superCount, locked: true, profiles: [] });
  res.json({ count: rows.length, superCount, locked: false, profiles: rows.map((u) => ({ ...publicProfile(u, me, distBetween(me, u)), superLike: u.swipe_kind === 'super' })) });
});

// Desbloqueia as fotos extras de um perfil usando 1 crédito do pacote de fotos.
app.post('/api/users/:id/unlock-photos', requireAuth, (req, res) => {
  const me = req.user;
  const id = intId(req.params.id);
  const target = id && id !== me.id && db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status = 'active'").get(id);
  if (!target || blockedBetween(me.id, target.id)) throw new HttpError(404, 'Perfil não encontrado.');
  if (!photosUnlocked(me, target.id)) {
    const used = db.transaction(() => {
      const r = db.prepare('UPDATE users SET photo_credits = photo_credits - 1 WHERE id = ? AND photo_credits > 0').run(me.id);
      if (!Number(r.changes)) return false;
      db.prepare('INSERT OR IGNORE INTO photo_unlocks (user_id, target_id, created_at) VALUES (?,?,?)').run(me.id, target.id, now());
      return true;
    })();
    if (!used) throw new HttpError(402, 'Você não tem desbloqueios de fotos. Assine um plano ou compre o pacote de 3 desbloqueios.', 'no_credits');
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  res.json({ user: meJson(fresh), profile: publicProfile(target, fresh, distBetween(fresh, target)) });
});

/* ---------- matches e chat ---------- */
function matchFor(req, id) {
  const mid = intId(id);
  const m = mid && db.prepare('SELECT * FROM matches WHERE id = ? AND (a_id = ? OR b_id = ?)').get(mid, req.user.id, req.user.id);
  if (!m) throw new HttpError(404, 'Conversa não encontrada.');
  const otherId = m.a_id === req.user.id ? m.b_id : m.a_id;
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
  if (!other || other.status !== 'active' || blockedBetween(req.user.id, otherId)) throw new HttpError(404, 'Conversa não encontrada.');
  return { m, other };
}

// Quantas mensagens grátis ainda restam para esta pessoa nesta conversa (null = sem limite).
const trialLeft = (u, sent) => (L.chatUnlocked(u) ? null : Math.max(0, L.FREE_CHAT_MESSAGES - sent));
const sentIn = (matchId, userId) => db.prepare('SELECT COUNT(*) c FROM messages WHERE match_id = ? AND sender_id = ?').get(matchId, userId).c;

app.get('/api/matches', requireAuth, (req, res) => {
  const me = req.user;
  const rows = db
    .prepare(
      `SELECT m.id, m.created_at, m.direct_by, m.accepted_at, CASE WHEN m.a_id = @me THEN m.b_id ELSE m.a_id END AS other_id,
         (SELECT body FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_body,
         (SELECT kind FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_kind,
         (SELECT created_at FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_at,
         (SELECT COUNT(*) FROM messages WHERE match_id = m.id AND sender_id != @me AND read_at IS NULL) AS unread,
         (SELECT COUNT(*) FROM messages WHERE match_id = m.id AND sender_id = @me) AS sent
       FROM matches m WHERE m.a_id = @me OR m.b_id = @me
       ORDER BY COALESCE(last_at, m.created_at) DESC`
    )
    .all({ me: me.id });
  const out = [];
  for (const r of rows) {
    const o = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(r.other_id);
    if (!o || blockedBetween(me.id, o.id)) continue;
    out.push({
      id: r.id, createdAt: r.created_at, unread: r.unread, lastAt: r.last_at, trialLeft: trialLeft(me, r.sent),
      request: r.direct_by && !r.accepted_at ? (r.direct_by === me.id ? 'sent' : 'received') : null,
      last: r.last_body ? (r.last_kind === 'place' ? 'Sugestão de encontro' : r.last_body) : null,
      user: publicProfile(o, me, distBetween(me, o)),
    });
  }
  res.json({ matches: out, unreadTotal: out.reduce((s, m) => s + m.unread, 0) });
});

app.get('/api/matches/:id/messages', requireAuth, (req, res) => {
  const { m, other } = matchFor(req, req.params.id);
  const after = Number(req.query.after) || 0;
  const msgs = db.prepare('SELECT id, sender_id, kind, body, created_at FROM messages WHERE match_id = ? AND id > ? ORDER BY id ASC LIMIT 200').all(m.id, after);
  db.prepare('UPDATE messages SET read_at = ? WHERE match_id = ? AND sender_id != ? AND read_at IS NULL').run(now(), m.id, req.user.id);
  res.json({
    other: publicProfile(other, req.user, distBetween(req.user, other)),
    trialLeft: trialLeft(req.user, sentIn(m.id, req.user.id)),
    request: m.direct_by && !m.accepted_at ? (m.direct_by === req.user.id ? 'sent' : 'received') : null,
    messages: msgs.map((x) => ({ id: x.id, mine: x.sender_id === req.user.id, kind: x.kind, body: x.body, at: x.created_at })),
  });
});

const BOT_LINES = ['Oi! Que bom que deu match. Como está o seu dia?', 'Adorei seu perfil. Você costuma sair por aqui?', 'Boa! Eu também gosto disso. Qual é o seu lugar favorito da região?', 'Combinado. Me avisa quando estiver a caminho.', 'Ri alto aqui. Vamos continuar essa conversa pessoalmente?'];
function botReply(matchId, botId) {
  setTimeout(() => {
    try {
      const n = db.prepare('SELECT COUNT(*) c FROM messages WHERE match_id = ? AND sender_id = ?').get(matchId, botId).c;
      if (!db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return;
      db.prepare('INSERT INTO messages (match_id, sender_id, body, created_at) VALUES (?,?,?,?)').run(matchId, botId, BOT_LINES[n % BOT_LINES.length], now());
    } catch { /* conversa removida */ }
  }, 1800);
}

const PLACE_TYPES = ['Café', 'Praça', 'Parque', 'Livraria', 'Sorveteria', 'Shopping (praça de alimentação)'];
app.post('/api/matches/:id/messages', requireAuth, requireConfirmed, limitMsg, (req, res) => {
  const { m, other } = matchFor(req, req.params.id);
  const kind = req.body?.kind === 'place' ? 'place' : 'text';
  let body = L.clean(req.body?.body, 1000);
  if (kind === 'place') {
    if (!PLACE_TYPES.includes(body)) throw bad('Tipo de local inválido.');
  } else if (!body) throw bad('Escreva uma mensagem.');
  const pendingDirect = m.direct_by && !m.accepted_at;
  if (pendingDirect && m.direct_by === req.user.id && sentIn(m.id, req.user.id) >= 1) throw new HttpError(409, `Aguarde ${other.name} responder ao seu pedido de conversa.`, 'direct_wait');
  if (!pendingDirect && !L.chatUnlocked(req.user) && sentIn(m.id, req.user.id) >= L.FREE_CHAT_MESSAGES) {
    throw new HttpError(402, `Suas ${L.FREE_CHAT_MESSAGES} mensagens grátis com ${other.name} acabaram. Assine um plano ou compre o Passe 24h para continuar a conversa.`, 'trial_over');
  }
  const info = db.prepare('INSERT INTO messages (match_id, sender_id, kind, body, created_at) VALUES (?,?,?,?,?)').run(m.id, req.user.id, kind, body, now());
  if (pendingDirect && m.direct_by !== req.user.id) db.prepare('UPDATE matches SET accepted_at = ? WHERE id = ?').run(now(), m.id); // responder aceita o pedido
  if (DEMO_BOTS && other.is_demo) botReply(m.id, other.id);
  try { notify.message(other.id, req.user.id, m.id); } catch (e) { console.error(e); }
  res.status(201).json({ id: Number(info.lastInsertRowid), trialLeft: trialLeft(req.user, sentIn(m.id, req.user.id)) });
});

// Cupido: sugestões de primeira mensagem a partir do perfil da outra pessoa. Troque o parâmetro n para ver outras.
app.get('/api/matches/:id/icebreakers', requireAuth, (req, res) => {
  const { other } = matchFor(req, req.params.id);
  const n = Math.min(1000, Math.max(0, Math.floor(Number(req.query.n)) || 0));
  res.json({ suggestions: cupid.icebreakers(req.user, other, n, 3) });
});

// Passe 24h: manda a primeira mensagem sem match. Vira um "pedido de conversa" que a outra pessoa aceita (respondendo) ou recusa.
const DIRECT_PER_PASS = 15;
app.post('/api/users/:id/direct', requireAuth, requireConfirmed, limitMsg, (req, res) => {
  const me = req.user, tid = intId(req.params.id);
  const body = L.clean(req.body?.body, 500);
  if (!tid || tid === me.id) throw bad('Pedido inválido.');
  if (!L.passActive(me)) throw new HttpError(402, 'Para mandar mensagem antes do match, ative o Passe 24h.', 'need_pass');
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status = 'active'").get(tid);
  if (!target || blockedBetween(me.id, tid) || !confirmed(target)) throw new HttpError(404, 'Perfil não encontrado.');
  if (db.prepare("SELECT 1 FROM swipes WHERE from_id = ? AND to_id = ? AND kind = 'pass'").get(tid, me.id)) throw bad('Não foi possível enviar para este perfil.');
  if (!body) throw bad('Escreva uma mensagem.');
  const a = Math.min(me.id, tid), b = Math.max(me.id, tid);
  const ex = qMatchBetween.get(a, b);
  if (ex) return res.status(200).json({ matchId: ex.id, existing: true });
  const since = now() - 24 * 3600_000;
  const used = db.prepare('SELECT COUNT(*) c FROM matches WHERE direct_by = ? AND created_at > ?').get(me.id, Math.max(since, me.pass_until - DAY)).c;
  if (used >= DIRECT_PER_PASS) throw new HttpError(429, `Você já enviou ${DIRECT_PER_PASS} pedidos de conversa com este Passe.`);
  const bot = DEMO_BOTS && target.is_demo;
  const matchId = db.transaction(() => {
    const r = db.prepare('INSERT INTO matches (a_id, b_id, created_at, direct_by, accepted_at) VALUES (?,?,?,?,?)').run(a, b, now(), me.id, bot ? now() : null);
    db.prepare('INSERT INTO messages (match_id, sender_id, kind, body, created_at) VALUES (?,?,?,?,?)').run(r.lastInsertRowid, me.id, 'text', body, now());
    return Number(r.lastInsertRowid);
  })();
  if (bot) botReply(matchId, target.id);
  try { notify.message(tid, me.id, matchId); } catch (e) { console.error(e); }
  res.status(201).json({ matchId });
});
app.post('/api/matches/:id/decline', requireAuth, (req, res) => {
  const { m, other } = matchFor(req, req.params.id);
  if (!m.direct_by || m.accepted_at || m.direct_by === req.user.id) throw bad('Só dá para recusar um pedido de conversa recebido.');
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO swipes (from_id, to_id, kind, created_at) VALUES (?,?,'pass',?)").run(req.user.id, other.id, now());
    db.prepare('DELETE FROM matches WHERE id = ?').run(m.id);
  })();
  res.json({ ok: true });
});
app.delete('/api/matches/:id', requireAuth, (req, res) => {
  const mid = intId(req.params.id);
  const m = mid && db.prepare('SELECT * FROM matches WHERE id = ? AND (a_id = ? OR b_id = ?)').get(mid, req.user.id, req.user.id);
  if (!m) throw new HttpError(404, 'Conversa não encontrada.');
  db.prepare('DELETE FROM matches WHERE id = ?').run(m.id);
  res.json({ ok: true });
});

/* ---------- bloqueio e denúncia ---------- */
const REPORT_REASONS = ['Perfil falso', 'Fotos impróprias', 'Assédio ou ofensas', 'Golpe ou pedido de dinheiro', 'Menor de idade', 'Outro'];
app.post('/api/users/:id/block', requireAuth, (req, res) => {
  const id = intId(req.params.id);
  if (!id || id === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Perfil não encontrado.');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, id, now());
    db.prepare('DELETE FROM matches WHERE a_id = ? AND b_id = ?').run(Math.min(req.user.id, id), Math.max(req.user.id, id));
  })();
  res.json({ ok: true });
});
app.post('/api/users/:id/report', requireAuth, (req, res) => {
  const id = intId(req.params.id);
  if (!id || id === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'Perfil não encontrado.');
  const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : null;
  if (!reason) throw bad('Escolha o motivo da denúncia.');
  const dup = db.prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'").get(req.user.id, id);
  if (!dup) {
    const rid = Number(db.prepare('INSERT INTO reports (reporter_id, reported_id, reason, details, created_at) VALUES (?,?,?,?,?)').run(req.user.id, id, reason, L.clean(req.body?.details, 500), now()).lastInsertRowid);
    // Guarda uma cópia das últimas mensagens entre os dois: o bloqueio apaga a conversa, mas a moderação precisa da prova.
    const m = db.prepare('SELECT id FROM matches WHERE a_id = ? AND b_id = ?').get(Math.min(req.user.id, id), Math.max(req.user.id, id));
    if (m) {
      const msgs = db.prepare('SELECT sender_id, kind, body, created_at FROM messages WHERE match_id = ? ORDER BY id DESC LIMIT 30').all(m.id).reverse();
      if (msgs.length) db.prepare('INSERT INTO report_evidence (report_id, messages, created_at) VALUES (?,?,?)').run(rid, JSON.stringify(msgs.map((x) => ({ from: x.sender_id === req.user.id ? 'denunciante' : 'denunciado', kind: x.kind, body: x.body, at: x.created_at }))), now());
    }
  }
  if (req.body?.block) {
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(req.user.id, id, now());
      db.prepare('DELETE FROM matches WHERE a_id = ? AND b_id = ?').run(Math.min(req.user.id, id), Math.max(req.user.id, id));
    })();
  }
  res.json({ ok: true });
});

/* ---------- planos ---------- */
app.post('/api/billing/checkout', requireAuth, (req, res) => {
  if (PAYMENTS !== 'demo') throw new HttpError(501, 'Os pagamentos ainda não estão ativados neste servidor.');
  const order = grants.parseOrder(req.body);
  if (!order) throw bad('Pedido inválido.');
  const u = req.user;
  db.transaction(() => {
    db.prepare('INSERT INTO subscriptions (user_id, plan, amount_cents, status, provider, created_at) VALUES (?,?,?,?,?,?)').run(u.id, order.plan, order.amountCents, 'paid', 'demo', now());
    grants.grant(u, order, now());
  })();
  res.json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});
app.post('/api/billing/cancel', requireAuth, (req, res) => {
  const u = req.user;
  if (PAYMENTS === 'asaas') { // plano pago por Pix: cancelar é só não renovar; o plano segue até o fim do período
    db.prepare('UPDATE users SET renewal_off = 1 WHERE id = ?').run(u.id);
    return res.json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  }
  db.transaction(() => {
    db.prepare("UPDATE users SET plan = 'free', plan_until = NULL, invisible = 0 WHERE id = ?").run(u.id);
    db.prepare('INSERT INTO subscriptions (user_id, plan, amount_cents, status, provider, created_at) VALUES (?,?,?,?,?,?)').run(u.id, u.plan, 0, 'canceled', PAYMENTS, now());
  })();
  res.json({ user: meJson(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

/* ---------- LGPD: exportar e apagar os próprios dados ---------- */
app.get('/api/me/export', requireAuth, (req, res) => {
  const u = req.user;
  const data = {
    perfil: meJson(u),
    curtidas: db.prepare('SELECT to_id AS para, kind AS tipo, created_at FROM swipes WHERE from_id = ?').all(u.id),
    matches: db.prepare('SELECT id, a_id, b_id, created_at FROM matches WHERE a_id = ? OR b_id = ?').all(u.id, u.id),
    mensagens: db.prepare('SELECT m.match_id, m.sender_id, m.body, m.created_at FROM messages m JOIN matches x ON x.id = m.match_id WHERE x.a_id = ? OR x.b_id = ?').all(u.id, u.id),
    assinaturas: db.prepare('SELECT plan, amount_cents, status, created_at FROM subscriptions WHERE user_id = ?').all(u.id),
    desbloqueios_de_fotos: db.prepare('SELECT target_id AS perfil, created_at FROM photo_unlocks WHERE user_id = ?').all(u.id),
    verificacao: db.prepare('SELECT status, created_at, reviewed_at FROM verifications WHERE user_id = ?').all(u.id),
  };
  res.set('Content-Disposition', 'attachment; filename="meus-dados-pertinho.json"').json(data);
});
app.delete('/api/me', requireAuth, async (req, res) => {
  if (req.user.role === 'admin') throw new HttpError(400, 'Contas de administrador não podem ser apagadas por aqui.');
  if (!(await L.verifyPassword(String(req.body?.password || ''), req.user.pass_hash))) throw bad('Senha incorreta.');
  for (const p of db.prepare('SELECT filename FROM photos WHERE user_id = ?').all(req.user.id)) fs.rm(path.join(UPLOAD_DIR, p.filename), { force: true }, () => {});
  for (const v of db.prepare('SELECT filename FROM verifications WHERE user_id = ? AND filename IS NOT NULL').all(req.user.id)) rmVerifFile(v.filename);
  const owing = req.user.status === 'suspended' || db.prepare("SELECT 1 FROM reports WHERE reported_id = ? AND status = 'open'").get(req.user.id);
  if (owing && req.user.cpf_hash) db.prepare('INSERT OR IGNORE INTO cpf_blocked (cpf_hash, reason, created_at) VALUES (?,?,?)').run(req.user.cpf_hash, req.user.status === 'suspended' ? 'conta suspensa' : 'denúncia em aberto', now());
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  clearSession(res);
  res.json({ ok: true });
});

/* ====================== PAINEL ADM ====================== */
const admin = express.Router();
admin.use(requireAdmin);
const events = makeEvents({ db, requireAuth, requireConfirmed, blockedBetween, bad, HttpError, intId, now, cityById, audit, PLACE_TYPES, limit: limitMsg });
app.use('/api/events', events.router);
events.adminRoutes(admin);

admin.get('/referrals', (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.status, r.reason, r.created_at, r.decided_at, a.name AS referrer, a.email AS referrer_email, b.name AS invitee
    FROM referrals r JOIN users a ON a.id = r.referrer_id JOIN users b ON b.id = r.invitee_id ORDER BY r.id DESC LIMIT 100`).all();
  const n = (s) => db.prepare('SELECT COUNT(*) c FROM referrals WHERE status = ?').get(s).c;
  res.json({ totals: { pending: n('pending'), rewarded: n('rewarded'), rejected: n('rejected') }, rules: referrals.RULES, items: rows });
});

admin.get('/stats', (req, res) => {
  const d7 = now() - 7 * 86400000;
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;
  const byPlan = db.prepare("SELECT plan, COUNT(*) c FROM users WHERE role='user' AND promo = 0 AND plan != 'free' AND plan_until > ? GROUP BY plan").all(now());
  const mrr = byPlan.reduce((s, r) => s + r.c * L.PLANS[r.plan].priceCents, 0);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - i);
    const to = from.getTime() + 86400000;
    days.push({ day: from.toISOString().slice(0, 10), count: one("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at >= ? AND created_at < ?", from.getTime(), to) });
  }
  res.json({
    users: one("SELECT COUNT(*) c FROM users WHERE role='user'"),
    active7: one("SELECT COUNT(*) c FROM users WHERE role='user' AND last_seen > ?", d7),
    new7: one("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at > ?", d7),
    suspended: one("SELECT COUNT(*) c FROM users WHERE status='suspended'"),
    verified: one("SELECT COUNT(*) c FROM users WHERE role='user' AND verified=1"),
    matches: one('SELECT COUNT(*) c FROM matches'),
    messages: one('SELECT COUNT(*) c FROM messages'),
    openReports: one("SELECT COUNT(*) c FROM reports WHERE status='open'"),
    pendingVerifications: one("SELECT COUNT(*) c FROM verifications WHERE status='pending'"),
    paying: byPlan.reduce((s, r) => s + r.c, 0),
    byPlan, mrrCents: mrr, paymentsMode: PAYMENTS, asaasEnv: asaasClient ? asaasClient.env : null,
    pixPending: one("SELECT COUNT(*) c FROM payments WHERE status = 'pending'"),
    webhooksFailed: one("SELECT COUNT(*) c FROM webhook_events WHERE status = 'failed'"),
    topCities: db.prepare("SELECT COALESCE(city_name,'Sem cidade') AS city, COUNT(*) c FROM users WHERE role='user' GROUP BY city_name ORDER BY c DESC LIMIT 8").all(),
    signups: days,
  });
});

admin.get('/users', (req, res) => {
  const q = L.clean(req.query.q, 80).toLowerCase();
  const status = ['active', 'suspended'].includes(req.query.status) ? req.query.status : null;
  const plan = ['free', 'plus', 'premium'].includes(req.query.plan) ? req.query.plan : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 20;
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const where = "u.role = 'user' AND (@q = '' OR lower(u.name) LIKE @like ESCAPE '\\' OR lower(u.email) LIKE @like ESCAPE '\\') AND (@status IS NULL OR u.status = @status) AND (@plan IS NULL OR (u.plan = @plan AND u.plan_until > @now))";
  const params = { q, like, status, plan, now: now() };
  const total = db.prepare(`SELECT COUNT(*) c FROM users u WHERE ${where}`).get(params).c;
  const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM reports r WHERE r.reported_id = u.id AND r.status = 'open') AS open_reports, (SELECT id FROM photos p WHERE p.user_id = u.id AND p.is_main = 1 AND p.status='ok') AS main_photo FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`).all(params);
  res.json({
    total, page, pages: Math.max(1, Math.ceil(total / size)),
    users: rows.map((u) => ({
      id: u.id, name: u.name, email: u.email, age: L.ageFrom(u.birth_date), city: u.city_name, status: u.status, verified: !!u.verified,
      plan: L.effectivePlan(u), demo: !!u.is_demo, createdAt: u.created_at, lastSeen: u.last_seen, openReports: u.open_reports, mainPhotoId: u.main_photo,
    })),
  });
});

admin.get('/users/:id', (req, res) => {
  const id = intId(req.params.id);
  const u = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Usuário não encontrado.');
  const c = (sql) => db.prepare(sql).get(u.id).c;
  res.json({
    user: { ...meJson(u), cpfChecked: !!u.cpf_checked, status: u.status, suspendReason: u.suspend_reason, createdAt: u.created_at, lastSeen: u.last_seen, demo: !!u.is_demo, role: u.role },
    stats: {
      likesGiven: c("SELECT COUNT(*) c FROM swipes WHERE from_id = ? AND kind='like'"),
      likesReceived: c("SELECT COUNT(*) c FROM swipes WHERE to_id = ? AND kind='like'"),
      matches: db.prepare('SELECT COUNT(*) c FROM matches WHERE a_id = ? OR b_id = ?').get(u.id, u.id).c,
      messagesSent: c('SELECT COUNT(*) c FROM messages WHERE sender_id = ?'),
      blockedBy: c('SELECT COUNT(*) c FROM blocks WHERE blocked_id = ?'),
    },
    reports: db.prepare('SELECT r.id, r.reason, r.details, r.status, r.created_at, (SELECT name FROM users WHERE id = r.reporter_id) AS reporter FROM reports r WHERE r.reported_id = ? ORDER BY r.id DESC LIMIT 20').all(u.id),
    subscriptions: db.prepare('SELECT plan, amount_cents, status, provider, created_at FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(u.id),
  });
});

admin.post('/users/:id/action', (req, res) => {
  const id = intId(req.params.id);
  const u = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Usuário não encontrado.');
  if (u.role === 'admin') throw new HttpError(400, 'Não é possível alterar outro administrador por aqui.');
  const act = req.body?.action;
  const reason = L.clean(req.body?.reason, 200);
  if (act === 'suspend') {
    if (!reason) throw bad('Informe o motivo da suspensão.');
    db.transaction(() => {
      db.prepare("UPDATE users SET status = 'suspended', suspend_reason = ? WHERE id = ?").run(reason, u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    })();
  } else if (act === 'unsuspend') db.prepare("UPDATE users SET status = 'active', suspend_reason = NULL WHERE id = ?").run(u.id);
  else if (act === 'verify') db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(u.id);
  else if (act === 'resetLink') {
    const token = makeResetToken(u.id);
    audit(req.user.id, 'resetLink', `user:${u.id}`, 'link de redefinição gerado');
    return res.json({ ok: true, link: `${publicBase(req)}/?reset=${token}`, expiresInMinutes: RESET_MS / 60000 });
  }
  else if (act === 'unverify') db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run(u.id);
  else if (act === 'setPlan') {
    const p = req.body?.plan;
    if (!['free', 'plus', 'premium'].includes(p)) throw bad('Plano inválido.');
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
    if (p === 'free') db.prepare("UPDATE users SET plan='free', plan_until=NULL, invisible=0 WHERE id=?").run(u.id);
    else db.prepare('UPDATE users SET plan=?, plan_until=?, promo=1, renewal_off=1 WHERE id=?').run(p, now() + days * 86400000, u.id);
  } else throw bad('Ação inválida.');
  audit(req.user.id, act, `user:${u.id}`, reason || req.body?.plan);
  res.json({ ok: true });
});

admin.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const rows = db.prepare(`SELECT r.*, (SELECT name FROM users WHERE id = r.reporter_id) AS reporter, ru.name AS reported_name, ru.status AS reported_status,
      (SELECT COUNT(*) FROM reports x WHERE x.reported_id = r.reported_id) AS total_against
    FROM reports r JOIN users ru ON ru.id = r.reported_id WHERE r.status = ? ORDER BY r.id ASC LIMIT 100`).all(status);
  res.json({ reports: rows.map((r) => ({ id: r.id, reason: r.reason, details: r.details, status: r.status, resolution: r.resolution, createdAt: r.created_at, reporter: r.reporter, reportedId: r.reported_id, reportedName: r.reported_name, reportedStatus: r.reported_status, totalAgainst: r.total_against, evidence: (() => { const e = db.prepare('SELECT messages FROM report_evidence WHERE report_id = ?').get(r.id); try { return e ? JSON.parse(e.messages) : []; } catch { return []; } })() })) });
});
admin.post('/reports/:id/resolve', (req, res) => {
  const id = intId(req.params.id);
  const r = id && db.prepare("SELECT * FROM reports WHERE id = ? AND status = 'open'").get(id);
  if (!r) throw new HttpError(404, 'Denúncia não encontrada ou já tratada.');
  const act = req.body?.action;
  const note = L.clean(req.body?.note, 200);
  if (act === 'dismiss') db.prepare("UPDATE reports SET status='dismissed', resolution=?, resolved_by=?, resolved_at=? WHERE id=?").run(note || 'Sem violação encontrada', req.user.id, now(), id);
  else if (act === 'suspend') {
    const target = db.prepare('SELECT role FROM users WHERE id = ?').get(r.reported_id);
    if (target && target.role === 'admin') throw bad('Não é possível suspender um administrador.');
    db.transaction(() => {
      db.prepare("UPDATE users SET status='suspended', suspend_reason=? WHERE id=?").run(note || r.reason, r.reported_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.reported_id);
      db.prepare("UPDATE reports SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE reported_id=? AND status='open'").run('Conta suspensa. ' + note, req.user.id, now(), r.reported_id);
    })();
  } else if (act === 'warn') db.prepare("UPDATE reports SET status='resolved', resolution=?, resolved_by=?, resolved_at=? WHERE id=?").run('Advertência. ' + note, req.user.id, now(), id);
  else throw bad('Ação inválida.');
  audit(req.user.id, `report_${act}`, `report:${id}`, note);
  res.json({ ok: true });
});

admin.get('/photos', (req, res) => {
  const rows = db.prepare("SELECT p.id, p.is_main, p.created_at, u.id AS uid, u.name FROM photos p JOIN users u ON u.id = p.user_id WHERE p.status = 'ok' AND u.is_demo = 0 ORDER BY p.id DESC LIMIT 40").all();
  res.json({ photos: rows.map((p) => ({ id: p.id, isMain: !!p.is_main, createdAt: p.created_at, userId: p.uid, userName: p.name })) });
});
admin.delete('/photos/:id', (req, res) => {
  const id = intId(req.params.id);
  const p = id && db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'Foto não encontrada.');
  deletePhotoRow(p);
  audit(req.user.id, 'photo_remove', `photo:${id}`, `user:${p.user_id}`);
  res.json({ ok: true });
});

admin.get('/verifications', (req, res) => {
  const rows = db.prepare(`SELECT v.id, v.pose, v.created_at, u.id AS uid, u.name, u.birth_date,
      (SELECT id FROM photos p WHERE p.user_id = u.id AND p.is_main = 1 AND p.status = 'ok' LIMIT 1) AS main_photo
    FROM verifications v JOIN users u ON u.id = v.user_id WHERE v.status = 'pending' ORDER BY v.id ASC LIMIT 50`).all();
  res.json({ verifications: rows.map((v) => ({ id: v.id, pose: v.pose, createdAt: v.created_at, userId: v.uid, name: v.name, age: L.ageFrom(v.birth_date), mainPhotoId: v.main_photo })) });
});
admin.get('/verifications/:id/photo', (req, res) => {
  const id = intId(req.params.id);
  const v = id && db.prepare("SELECT filename FROM verifications WHERE id = ? AND status = 'pending' AND filename IS NOT NULL").get(id);
  if (!v) throw new HttpError(404, 'Selfie não encontrada.');
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  res.sendFile(path.join(UPLOAD_DIR, path.basename(v.filename)), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
admin.post('/verifications/:id/decide', (req, res) => {
  const id = intId(req.params.id);
  const v = id && db.prepare("SELECT * FROM verifications WHERE id = ? AND status = 'pending'").get(id);
  if (!v) throw new HttpError(404, 'Pedido não encontrado ou já decidido.');
  const act = req.body?.action;
  if (!['approve', 'reject'].includes(act)) throw bad('Ação inválida.');
  const reason = L.clean(req.body?.reason, 200) || (act === 'reject' ? 'A selfie não confere com a foto principal ou com a pose pedida.' : '');
  db.transaction(() => {
    db.prepare('UPDATE verifications SET status = ?, reason = ?, reviewed_by = ?, reviewed_at = ?, filename = NULL WHERE id = ?').run(act === 'approve' ? 'approved' : 'rejected', reason, req.user.id, now(), id);
    if (act === 'approve') db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(v.user_id);
  })();
  rmVerifFile(v.filename);
  audit(req.user.id, `verification_${act}`, `user:${v.user_id}`, reason);
  if (act === 'approve') { // a selfie aprovada libera a indicação que estava esperando
    const vu = db.prepare('SELECT * FROM users WHERE id = ?').get(v.user_id);
    const ra = vu && confirmed(vu) && db.prepare("SELECT 1 FROM photos WHERE user_id = ? AND status = 'ok'").get(v.user_id) ? referrals.activate(v.user_id) : null;
    if (ra && ra.status === 'rewarded') audit(req.user.id, 'referral.reward', `user:${v.user_id}`, `indicador ${ra.referrerId}, total ${ra.total}${ra.bonus ? ', bônus de Plus' : ''}`);
  }
  res.json({ ok: true });
});

admin.get('/subscriptions', (req, res) => {
  const rows = db.prepare('SELECT s.*, u.name, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 100').all();
  res.json({ subscriptions: rows.map((s) => ({ id: s.id, userId: s.user_id, name: s.name, email: s.email, plan: s.plan, amountCents: s.amount_cents, status: s.status, provider: s.provider, createdAt: s.created_at })) });
});
admin.get('/audit', (req, res) => {
  const rows = db.prepare('SELECT a.*, (SELECT name FROM users WHERE id = a.admin_id) AS admin_name FROM audit_log a ORDER BY a.id DESC LIMIT 100').all();
  res.json({ log: rows.map((a) => ({ id: a.id, admin: a.admin_name, action: a.action, target: a.target, detail: a.detail, createdAt: a.created_at })) });
});
let billing = null;
if (PAYMENTS === 'asaas') billing = require('./billing')({ app, admin, db, L, grants, requireAuth, HttpError, now, audit, rateLimit, client: asaasClient, webhookToken: asaasWebhookToken });
app.use('/api/admin', admin);

/* ---------- arquivos estáticos e erros ---------- */
app.get('/api/unsubscribe', (req, res) => {
  const ok = notify.unsubscribe(intId(req.query.u), String(req.query.t || ''));
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avisos por e-mail</title><body style="font-family:sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem"><h1>${ok ? 'Pronto!' : 'Link inválido'}</h1><p>${ok ? 'Você não receberá mais avisos por e-mail. Dá para reativar em Perfil, dentro do app.' : 'Este link não é válido. Entre no app e ajuste os avisos em Perfil.'}</p><p><a href="/">Voltar ao Pertinhos</a></p>`);
});
/* ---------- páginas de compartilhamento (prévia no WhatsApp e redes) ---------- */
const PUB_DIR = fs.existsSync(path.join(__dirname, 'public-dist')) ? path.join(__dirname, 'public-dist') : path.join(__dirname, 'public'); // build minificado, se existir
const INDEX_HTML = fs.readFileSync(path.join(PUB_DIR, 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML.replaceAll('__BASE__', publicBase(req)));
});
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Prévia pública do encontro: só título, tipo de local, cidade e data. Nada de local exato nem nomes.
app.get('/e/:id', (req, res) => {
  const base = publicBase(req), id = intId(req.params.id);
  const ev = id && db.prepare("SELECT title, place_type, city_id, starts_at FROM events WHERE id = ? AND status = 'open'").get(id);
  const city = ev && cityById(ev.city_id);
  const title = ev ? `${ev.title} - encontro em grupo` : 'Pertinhos - encontros em grupo';
  const when = ev ? new Date(ev.starts_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '';
  const desc = ev ? `${ev.place_type}${city ? ' em ' + city.name : ''} · ${when}. Entre no Pertinhos para confirmar presença.` : 'Encontros em grupo em lugares públicos, na sua cidade.';
  const dest = ev ? `/?evento=${id}` : '/';
  res.set('Cache-Control', 'no-cache').type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title><meta name="description" content="${escHtml(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Pertinhos"><meta property="og:title" content="${escHtml(title)}"><meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${base}/og.png"><meta property="og:url" content="${base}/e/${ev ? id : ''}"><meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${dest}"><meta name="robots" content="noindex"></head><body><p><a href="${dest}">Abrir no Pertinhos</a></p></body></html>`);
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use(express.static(PUB_DIR, { extensions: ['html'], maxAge: PROD ? '1h' : 0 }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
  if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A imagem passa de 5 MB.' : 'Falha no envio da imagem.' });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Pedido inválido.' });
  console.error(err);
  res.status(500).json({ error: 'Algo deu errado. Tente novamente.' });
});

/* ---------- administrador inicial ---------- */
async function ensureAdmin() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@pertinho.local').toLowerCase();
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD precisa ter pelo menos 8 caracteres.');
  db.prepare("INSERT INTO users (email, pass_hash, name, birth_date, gender, role, terms_at, created_at) VALUES (?,?,?,?,?,'admin',?,?)")
    .run(email, await L.hashPassword(password), 'Administração', '1990-01-01', 'o', now(), now());
  console.log('\n=== Administrador criado ===');
  console.log(`E-mail: ${email}`);
  if (generated) console.log(`Senha:  ${password}   (anote agora, ela não será mostrada de novo)`);
  console.log('Painel: /admin.html\n');
}

if (require.main === module) {
  ensureAdmin().then(() => {
    // limpeza de sessões vencidas
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600_000).unref();
    if (billing) billing.start();
    notify.start();
    app.listen(PORT, () => console.log(`Pertinho no ar em http://localhost:${PORT}  (pagamentos: ${PAYMENTS})`));
  }).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { app, ensureAdmin };
