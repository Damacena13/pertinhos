'use strict';
// Envio de e-mail pela API do Resend (https://resend.com). Sem RESEND_API_KEY o envio fica desligado
// e o administrador gera o link de redefinição de senha pelo painel.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || '';
const BASE = (process.env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/+$/, '');
const enabled = () => !!(KEY && FROM);

async function sendMail({ to, subject, text, html }) {
  if (!enabled()) return { sent: false, reason: 'disabled' };
  try {
    const res = await fetch(BASE + '/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(10000),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) { return { sent: false, reason: 'network' }; }
}
module.exports = { sendMail, enabled };
