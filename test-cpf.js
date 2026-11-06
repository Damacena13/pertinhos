'use strict';
// Conferência do CPF em base oficial (provedor simulado).
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3986;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pertinho-cpf-'));
const LOOK = 3985; const env = { ...process.env, CPF_LOOKUP_URL: 'http://127.0.0.1:' + LOOK + '/cpf/{cpf}', CPF_LOOKUP_TOKEN: 'chave-x', CPF_LOOKUP_STATUS_FIELD: 'situacao', PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test', AUTH_RATE_LIMIT: '300' };
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

const http = require('http');
const DB = {}; const seenAuth = []; let down = false, hits = 0;
const lookSrv = http.createServer((req, res) => {
  hits++; seenAuth.push(req.headers.authorization);
  if (down) { res.writeHead(500); return res.end(); }
  const rec = DB[req.url.split('/').pop()];
  if (!rec) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(rec));
}).listen(3985);
(async () => {
  const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
    const login = async (c, email) => assert.strictEqual((await c.post('/api/auth/login', { email, password: 'senha-forte-123' })).status, 200);
    const post = (body) => new Client().post('/api/auth/register', body);
    const base = (cpf, o = {}) => ({ ...reg('x' + cpf + '@teste.com', 'Ana'), cpf, birthDate: '1994-04-10', ...o });
    await t('CPF que confere (nome e nascimento): cadastra e marca como conferido; a chave foi enviada ao provedor', async () => {
      const cpf = nextCpf(); DB[cpf] = { nome: 'ANA MARIA DA SILVA', nascimento: '10/04/1994', situacao: 'REGULAR' };
      const r = await post(base(cpf)); assert.strictEqual(r.status, 201, JSON.stringify(r.data));
      assert.strictEqual(one('SELECT cpf_checked c FROM users WHERE email = ?', 'x' + cpf + '@teste.com').c, 1);
      assert.strictEqual(seenAuth[seenAuth.length - 1], 'Bearer chave-x');
    });
    await t('nome ou nascimento diferentes do CPF são recusados, sem dizer qual campo errou', async () => {
      const cpf = nextCpf(); DB[cpf] = { nome: 'ANA MARIA DA SILVA', nascimento: '10/04/1994', situacao: 'REGULAR' };
      for (const o of [{ name: 'Bruna' }, { birthDate: '1993-04-10' }]) { const r = await post(base(cpf, o)); assert.strictEqual(r.status, 400); assert.ok(/não conferem/.test(r.data.error)); assert.ok(!/nome:|nascimento:/.test(r.data.error)); }
      assert.strictEqual(one('SELECT COUNT(*) c FROM users WHERE email = ?', 'x' + cpf + '@teste.com').c, 0);
    });
    await t('menor de idade pela base oficial é barrado mesmo digitando data de adulto', async () => {
      const cpf = nextCpf(); const y = new Date().getFullYear() - 15; DB[cpf] = { nome: 'JOAO PEDRO', nascimento: `01/02/${y}`, situacao: 'REGULAR' };
      for (const birthDate of ['1994-04-10', `${y}-02-01`]) { const r = await post(base(cpf, { name: 'Joao', birthDate })); assert.ok([400, 403].includes(r.status)); assert.strictEqual(one('SELECT COUNT(*) c FROM users WHERE email = ?', 'x' + cpf + '@teste.com').c, 0); }
      const r = await post(base(cpf, { name: 'Joao', birthDate: '1994-04-10' })); assert.strictEqual(r.status, 403);
      assert.ok(one("SELECT 1 FROM audit_log WHERE action = 'signup.minor_blocked'"));
    });
    await t('CPF não encontrado, cancelado ou de falecido é recusado', async () => {
      const a = nextCpf(); const ra = await post(base(a)); assert.strictEqual(ra.status, 400, JSON.stringify(ra.data));
      const c = nextCpf(); DB[c] = { nome: 'ANA', nascimento: '10/04/1994', situacao: 'CANCELADA' }; const r = await post(base(c)); assert.strictEqual(r.status, 400, JSON.stringify(r.data)); assert.ok(/situa/.test(r.data.error));
    });
    await t('provedor fora do ar: cadastro espera (503) e não entra sem conferir', async () => {
      const cpf = nextCpf(); DB[cpf] = { nome: 'ANA', nascimento: '10/04/1994', situacao: 'REGULAR' }; down = true;
      const r = await post(base(cpf)); down = false; assert.strictEqual(r.status, 503);
      assert.strictEqual((await post(base(cpf))).status, 201);
    });
    await t('CPF matematicamente inválido nem chega ao provedor', async () => {
      const before = hits; assert.strictEqual((await post(base('11111111111'))).status, 400); assert.strictEqual(hits, before);
    });
  } catch (e) { failed++; console.log('ERRO GERAL', e.message); }
  srv.kill(); lookSrv.close();
  await sleep(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passaram, ${failed} falharam`);
  if (failed && process.env.SHOW_LOG) console.log('--- log do servidor ---\n' + srvLog);
  process.exit(failed ? 1 : 0);
})();
