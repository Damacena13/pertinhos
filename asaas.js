'use strict';
// Cliente mínimo da API v3 do Asaas (https://docs.asaas.com). Só o que o Pertinho usa para cobrar via Pix.
const BASES = { sandbox: 'https://api-sandbox.asaas.com/v3', production: 'https://api.asaas.com/v3' };

class AsaasError extends Error {
  constructor(status, message, body) { super(message); this.name = 'AsaasError'; this.status = status; this.body = body; }
}

function createClient({ apiKey, env = 'sandbox', baseUrl, userAgent = 'Pertinho/1.0', timeoutMs = 15000 }) {
  if (!apiKey) throw new Error('ASAAS_API_KEY não definida.');
  if (!BASES[env]) throw new Error("ASAAS_ENV precisa ser 'sandbox' ou 'production'.");
  const base = (baseUrl || BASES[env]).replace(/\/+$/, '');

  async function call(method, path, body) {
    const headers = { access_token: apiKey, 'User-Agent': userAgent, accept: 'application/json' };
    const opt = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(base + path, opt); }
    catch (e) { throw new AsaasError(0, 'Não foi possível falar com o Asaas agora. Tente novamente em instantes.'); }
    let json = null;
    try { json = await res.json(); } catch (e) { /* sem corpo */ }
    if (!res.ok) {
      const msg = json && Array.isArray(json.errors) && json.errors[0] && json.errors[0].description;
      throw new AsaasError(res.status, msg || `O Asaas recusou o pedido (erro ${res.status}).`, json);
    }
    return json;
  }

  return {
    env, base,
    createCustomer: ({ name, cpfCnpj, email, externalReference }) =>
      call('POST', '/customers', { name, cpfCnpj, email, externalReference, notificationDisabled: true }),
    createPixPayment: ({ customer, value, dueDate, description, externalReference }) =>
      call('POST', '/payments', { customer, billingType: 'PIX', value, dueDate, description, externalReference }),
    getPixQrCode: (id) => call('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`),
    getPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
    deletePayment: (id) => call('DELETE', `/payments/${encodeURIComponent(id)}`),
    createWebhook: (cfg) => call('POST', '/webhooks', cfg),
  };
}

module.exports = { createClient, AsaasError, BASES };
