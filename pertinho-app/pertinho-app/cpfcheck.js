'use strict';
// Conferência do CPF em base oficial (Receita Federal) por um provedor contratado.
// Não existe consulta gratuita e pública de CPF: é preciso contratar um serviço (ex.: Serpro, Infosimples, BigDataCorp, Direct Data)
// e apontar o endereço dele aqui. O provedor deve devolver JSON com nome e data de nascimento.
//   CPF_LOOKUP_URL            endereço da consulta; {cpf} é trocado pelos 11 dígitos. Ex.: https://api.exemplo.com/cpf/{cpf}
//   CPF_LOOKUP_TOKEN          chave do provedor
//   CPF_LOOKUP_AUTH_HEADER    cabeçalho da chave (padrão Authorization; o valor vai como "Bearer CHAVE"). Use "x-api-key" para enviar a chave pura.
//   CPF_LOOKUP_NAME_FIELD     caminho do nome no JSON (padrão nome; aceita caminho com ponto: data.nome)
//   CPF_LOOKUP_BIRTH_FIELD    caminho do nascimento (padrão nascimento; aceita dd/mm/aaaa ou aaaa-mm-dd)
//   CPF_LOOKUP_STATUS_FIELD   (opcional) caminho da situação cadastral; CPF cancelado, nulo ou de titular falecido é recusado
//   CPF_LOOKUP_REQUIRED       1 (padrão): se o provedor cair, o cadastro espera. 0: deixa passar só com a validação matemática.
const DISABLED = { enabled: false };
const pick = (o, path) => String(path).split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
function parseBirth(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const ageOn = (iso, now) => { const [y, mo, d] = iso.split('-').map(Number); const t = new Date(now); let a = t.getUTCFullYear() - y; if (t.getUTCMonth() + 1 < mo || (t.getUTCMonth() + 1 === mo && t.getUTCDate() < d)) a--; return a; };

function makeCpfCheck(env = process.env, fetchFn = fetch) {
  const url = env.CPF_LOOKUP_URL;
  if (!url) return { enabled: false, verify: async () => DISABLED };
  const required = env.CPF_LOOKUP_REQUIRED !== '0';
  const nameF = env.CPF_LOOKUP_NAME_FIELD || 'nome', birthF = env.CPF_LOOKUP_BIRTH_FIELD || 'nascimento', statF = env.CPF_LOOKUP_STATUS_FIELD || '';
  const authH = env.CPF_LOOKUP_AUTH_HEADER || 'Authorization';
  async function verify(cpf, { name, birth }, now = Date.now()) {
    let data;
    try {
      const headers = { accept: 'application/json' };
      if (env.CPF_LOOKUP_TOKEN) headers[authH] = authH.toLowerCase() === 'authorization' ? 'Bearer ' + env.CPF_LOOKUP_TOKEN : env.CPF_LOOKUP_TOKEN;
      const res = await fetchFn(url.replace('{cpf}', cpf), { headers, signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return { enabled: true, status: 'notfound' };
      if (!res.ok) return { enabled: true, status: 'unavailable', required };
      data = await res.json();
    } catch (e) { return { enabled: true, status: 'unavailable', required }; }
    const officialBirth = parseBirth(pick(data, birthF)), officialName = norm(pick(data, nameF));
    if (!officialBirth || !officialName.length) return { enabled: true, status: 'unavailable', required };
    if (statF && /cancelad|nul[ao]|falecid/i.test(String(pick(data, statF) || ''))) return { enabled: true, status: 'blocked' };
    if (ageOn(officialBirth, now) < 18) return { enabled: true, status: 'minor' }; // vale a data oficial, não a digitada
    const typed = norm(name);
    if (!typed.length || typed[0] !== officialName[0] || officialBirth !== birth) return { enabled: true, status: 'mismatch' };
    return { enabled: true, status: 'ok', birth: officialBirth };
  }
  return { enabled: true, verify };
}
module.exports = { makeCpfCheck, parseBirth, norm };
