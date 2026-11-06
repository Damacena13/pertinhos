'use strict';
const path = require('path');
const fs = require('fs');

// SQLite embutido no Node (22.5+): não precisa instalar nem compilar nada. Esconde só o aviso de "experimental".
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w && w.message ? w.message : w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'pertinho.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Transação no estilo db.transaction(fn)(): confirma se der certo, desfaz se lançar erro.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(...args); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('f','m','o')),
  seeking TEXT NOT NULL DEFAULT 'all' CHECK (seeking IN ('f','m','all')),
  bio TEXT NOT NULL DEFAULT '',
  interests TEXT NOT NULL DEFAULT '[]',
  city_id TEXT,
  city_name TEXT,
  lat REAL,
  lng REAL,
  loc_source TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspend_reason TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  invisible INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','plus','premium')),
  plan_until INTEGER,
  is_demo INTEGER NOT NULL DEFAULT 0,
  terms_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_geo ON users(lat, lng);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','removed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id);

CREATE TABLE IF NOT EXISTS swipes (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('like','pass','super')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_swipes_to ON swipes(to_id, kind);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (a_id, b_id),
  CHECK (a_id < b_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','place')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_match ON messages(match_id, id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired','canceled','refunded')),
  asaas_payment_id TEXT UNIQUE,
  pix_payload TEXT,
  pix_image TEXT,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  granted_until INTEGER,
  renewal INTEGER NOT NULL DEFAULT 0,
  last_check INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, status);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  asaas_payment_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE TABLE IF NOT EXISTS photo_unlocks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pose TEXT NOT NULL,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected')),
  reason TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verif_status ON verifications(status, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

// Colunas novas em bancos que já existem (cada ALTER só roda se a coluna ainda não existir).
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('asaas_customer_id')) db.exec('ALTER TABLE users ADD COLUMN asaas_customer_id TEXT');
if (!userCols.includes('renewal_off')) db.exec('ALTER TABLE users ADD COLUMN renewal_off INTEGER NOT NULL DEFAULT 0');

if (!userCols.includes('email_verified_at')) { // contas que já existiam ficam como confirmadas
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
  db.exec('UPDATE users SET email_verified_at = created_at');
}
db.exec(`CREATE TABLE IF NOT EXISTS email_confirms (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
)`);

for (const [col, ddl] of [
  ['anthem', "ALTER TABLE users ADD COLUMN anthem TEXT NOT NULL DEFAULT ''"],
  ['pass_until', 'ALTER TABLE users ADD COLUMN pass_until INTEGER'],
  ['boost_until', 'ALTER TABLE users ADD COLUMN boost_until INTEGER'],
  ['photo_credits', 'ALTER TABLE users ADD COLUMN photo_credits INTEGER NOT NULL DEFAULT 0'],
  ['promo', 'ALTER TABLE users ADD COLUMN promo INTEGER NOT NULL DEFAULT 0'],
  ['ref_code', 'ALTER TABLE users ADD COLUMN ref_code TEXT'],
  ['referred_by', 'ALTER TABLE users ADD COLUMN referred_by INTEGER'],
  ['cpf_hash', 'ALTER TABLE users ADD COLUMN cpf_hash TEXT'],
  ['cpf_last2', 'ALTER TABLE users ADD COLUMN cpf_last2 TEXT'],
  ['cpf_checked', 'ALTER TABLE users ADD COLUMN cpf_checked INTEGER NOT NULL DEFAULT 0'],
]) if (!userCols.includes(col)) db.exec(ddl);
// Um CPF só pode ter uma conta. O índice parcial ignora contas sem CPF (administrador e perfis de demonstração).
db.exec(`
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','rejected')),
  reason TEXT,
  net_hash TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id, status);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_refcode ON users(ref_code) WHERE ref_code IS NOT NULL;
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cpf ON users(cpf_hash) WHERE cpf_hash IS NOT NULL');

const payCols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
if (!payCols.includes('item')) db.exec("ALTER TABLE payments ADD COLUMN item TEXT NOT NULL DEFAULT 'plan'");
if (!payCols.includes('months')) db.exec('ALTER TABLE payments ADD COLUMN months INTEGER NOT NULL DEFAULT 1');

// Bancos antigos: a tabela de curtidas precisa aceitar a "super curtida". O SQLite não altera CHECK, então recria a tabela.
const swipesSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'swipes'").get() || {}).sql || '';
if (swipesSql && !swipesSql.includes("'super'")) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE swipes_new (
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('like','pass','super')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    INSERT INTO swipes_new SELECT from_id, to_id, kind, created_at FROM swipes;
    DROP TABLE swipes;
    ALTER TABLE swipes_new RENAME TO swipes;
    CREATE INDEX IF NOT EXISTS idx_swipes_to ON swipes(to_id, kind);`);
  })();
  db.exec('PRAGMA foreign_keys = ON');
}

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  place_type TEXT NOT NULL,
  place_name TEXT NOT NULL DEFAULT '',
  city_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled')),
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_city ON events(city_id, status, starts_at);
CREATE TABLE IF NOT EXISTS event_members (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_members_user ON event_members(user_id);
CREATE TABLE IF NOT EXISTS event_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_messages ON event_messages(event_id, id);
CREATE TABLE IF NOT EXISTS notif_log (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`);
const matchCols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
if (!matchCols.includes('direct_by')) db.exec('ALTER TABLE matches ADD COLUMN direct_by INTEGER'); // pedido de conversa feito com o Passe 24h
if (!matchCols.includes('accepted_at')) db.exec('ALTER TABLE matches ADD COLUMN accepted_at INTEGER');
if (!userCols.includes('notify_email')) db.exec('ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1');
if (!userCols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER');

db.exec(`
CREATE TABLE IF NOT EXISTS loc_changes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, lat REAL NOT NULL, lng REAL NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_loc_changes ON loc_changes(user_id, at);
CREATE TABLE IF NOT EXISTS report_evidence (report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE, messages TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cpf_blocked (cpf_hash TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
`);
module.exports = { db, DATA_DIR, UPLOAD_DIR };
