'use strict';
// Asaas FALSO, só para desenvolvimento e testes. Imita os endpoints que o Pertinho usa e dispara o webhook como o Asaas faria.
// Uso avulso: node mock-asaas.js 4010   (abre uma página em http://localhost:4010 para "pagar" os Pix de mentira)
const http = require('http');
const crypto = require('crypto');

// PNG 1x1 só para ter uma imagem válida no lugar do QR Code
const FAKE_QR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createMock({ apiKey = 'test_key', webhookUrl = null, webhookToken = null } = {}) {
  const st = { customers: new Map(), payments: new Map(), requests: [], webhooks: [], failures: [], seq: 0 };
  const id = (p) => `${p}_${String(++st.seq).padStart(6, '0')}${crypto.randomBytes(3).toString('hex')}`;
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const err = (res, code, description) => send(res, code, { errors: [{ code: 'invalid_action', description }] });

  async function fireWebhook(event, p) {
    if (!webhookUrl) return;
    const body = { id: `evt_${crypto.randomBytes(8).toString('hex')}`, event, dateCreated: '2026-10-16 12:00:00', account: { id: 'acc_mock', ownerId: null },
      payment: { object: 'payment', id: p.id, customer: p.customer, value: p.value, status: p.status, billingType: p.billingType, externalReference: p.externalReference, deleted: p.deleted } };
    st.webhooks.push(body);
    try { await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': webhookToken || '' }, body: JSON.stringify(body) }); } catch (e) { /* servidor fora do ar */ }
  }

  const api = {
    state: st,
    pay: async (payId, { silent = false } = {}) => { const p = st.payments.get(payId); p.status = 'RECEIVED'; if (!silent) await fireWebhook('PAYMENT_RECEIVED', p); },
    refund: async (payId) => { const p = st.payments.get(payId); p.status = 'REFUNDED'; await fireWebhook('PAYMENT_REFUNDED', p); },
    tamper: (payId, fields) => Object.assign(st.payments.get(payId), fields),
    fail: (match) => st.failures.push({ times: 1, status: 500, ...match }),
    fireWebhook,
    paymentByRef: (ref) => [...st.payments.values()].find((p) => p.externalReference === ref),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { /* ignora */ }
      const path = url.pathname;

      if (path === '/' && req.method === 'GET') { // página de apoio para pagar os Pix de mentira
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const rows = [...st.payments.values()].map((p) => `<tr><td>${p.id}</td><td>R$ ${Number(p.value).toFixed(2)}</td><td>${p.status}${p.deleted ? ' (removida)' : ''}</td><td>${p.status === 'PENDING' && !p.deleted ? `<form method="post" action="/__pay/${p.id}"><button>Simular pagamento</button></form>` : ''}</td></tr>`).join('');
        return res.end(`<!doctype html><meta charset="utf-8"><title>Asaas falso</title><body style="font:16px system-ui;padding:2rem"><h1>Asaas falso (só para testes)</h1><p>Gere um Pix no site e clique em "Simular pagamento".</p><table border="1" cellpadding="8" style="border-collapse:collapse"><tr><th>Cobrança</th><th>Valor</th><th>Situação</th><th></th></tr>${rows || '<tr><td colspan="4">Nenhuma cobrança ainda</td></tr>'}</table><script>setTimeout(()=>location.reload(),4000)</script>`);
      }
      if (req.method === 'POST' && path.startsWith('/__pay/')) { const pid = path.split('/').pop(); if (st.payments.has(pid)) await api.pay(pid); res.writeHead(303, { location: '/' }); return res.end(); }

      st.requests.push({ method: req.method, path, headers: req.headers, body });
      if (!path.startsWith('/v3/')) return err(res, 404, 'Rota não encontrada');
      const f = st.failures.find((x) => x.times > 0 && (!x.method || x.method === req.method) && (!x.path || path.startsWith(x.path)));
      if (f) { f.times--; return err(res, f.status, 'Falha simulada'); }
      if (req.headers.access_token !== apiKey) return send(res, 401, { errors: [{ code: 'invalid_access_token', description: 'A chave de API fornecida é inválida' }] });
      if (!req.headers['user-agent'] || !/^Pertinho/.test(req.headers['user-agent'])) return err(res, 400, 'O header User-Agent é obrigatório');
      if (req.method === 'GET' && raw) return err(res, 403, 'GET sem corpo');

      if (req.method === 'POST' && path === '/v3/customers') {
        if (!body || !body.name) return err(res, 400, 'O campo name é obrigatório');
        if (!body.cpfCnpj || !/^\d{11}$|^\d{14}$/.test(body.cpfCnpj)) return err(res, 400, 'O CPF/CNPJ informado é inválido');
        const c = { object: 'customer', id: id('cus'), name: body.name, cpfCnpj: body.cpfCnpj, email: body.email, externalReference: body.externalReference };
        st.customers.set(c.id, c); return send(res, 200, c);
      }
      if (req.method === 'POST' && path === '/v3/payments') {
        if (!body || !st.customers.has(body.customer)) return err(res, 400, 'Cliente inválido');
        if (body.billingType !== 'PIX') return err(res, 400, 'Este mock só aceita PIX');
        if (!(Number(body.value) > 0)) return err(res, 400, 'O valor deve ser maior que zero');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '')) return err(res, 400, 'A data de vencimento é inválida');
        const p = { object: 'payment', id: id('pay'), customer: body.customer, value: Number(body.value), billingType: 'PIX', status: 'PENDING', dueDate: body.dueDate, description: body.description, externalReference: body.externalReference, deleted: false };
        st.payments.set(p.id, p); return send(res, 200, p);
      }
      let m = path.match(/^\/v3\/payments\/([^/]+)\/pixQrCode$/);
      if (req.method === 'GET' && m) {
        const p = st.payments.get(m[1]); if (!p) return err(res, 404, 'Cobrança não encontrada');
        return send(res, 200, { success: true, encodedImage: FAKE_QR, payload: `00020126580014br.gov.bcb.pix0136${crypto.randomUUID()}5204000053039865406${p.value.toFixed(2)}5802BR5909PERTINHO6009SAO PAULO62070503***6304ABCD`, expirationDate: '2027-10-16 23:59:59' });
      }
      m = path.match(/^\/v3\/payments\/([^/]+)$/);
      if (m && req.method === 'GET') { const p = st.payments.get(m[1]); return p ? send(res, 200, p) : err(res, 404, 'Cobrança não encontrada'); }
      if (m && req.method === 'DELETE') { const p = st.payments.get(m[1]); if (!p) return err(res, 404, 'Cobrança não encontrada'); p.deleted = true; return send(res, 200, { deleted: true, id: p.id }); }
      return err(res, 404, 'Rota não encontrada');
    });
  });

  api.listen = (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port)));
  api.close = () => new Promise((r) => server.close(r));
  return api;
}

module.exports = { createMock };

if (require.main === module) {
  const port = Number(process.argv[2]) || 4010;
  const mock = createMock({
    apiKey: process.env.ASAAS_API_KEY || 'chave-de-teste',
    webhookUrl: process.env.MOCK_WEBHOOK_URL || 'http://127.0.0.1:3000/api/webhooks/asaas',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || 'token-de-teste-com-pelo-menos-32-caracteres-aaaa',
  });
  mock.listen(port).then((p) => console.log(`Asaas falso em http://localhost:${p}`));
}
