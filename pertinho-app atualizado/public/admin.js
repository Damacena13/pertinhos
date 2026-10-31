(function () {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');
const dt = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const PLAN = { free: 'Grátis', plus: 'Plus', premium: 'Premium' };
let me = null, section = 'resumo', usersState = { q: '', status: '', plan: '', page: 1 };

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opt.headers['x-pertinho'] = '1';
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = null; try { data = await res.json(); } catch (e) { /* sem corpo */ }
  if (!res.ok) { const err = new Error((data && data.error) || 'Algo deu errado.'); err.status = res.status; throw err; }
  return data;
}
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3000); }

/* tema */
(function () { try { const t = localStorage.getItem('pp_theme'); if (t) { const v = JSON.parse(t); document.documentElement.setAttribute('data-theme', v); if (v === 'light') document.documentElement.style.colorScheme = 'light'; } } catch (e) { /* ignora */ } })();
$('#themeBtn').onclick = () => {
  const root = document.documentElement; let cur = root.getAttribute('data-theme');
  if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const nx = cur === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', nx); root.style.colorScheme = nx === 'light' ? 'light' : '';
  try { localStorage.setItem('pp_theme', JSON.stringify(nx)); } catch (e) { /* ignora */ }
};

/* entrada */
function showLogin(msg) { $('#loginBox').hidden = false; $('#panel').hidden = true; $('#logout').hidden = true; $('#who').textContent = ''; $('#aErr').textContent = msg || ''; }
function showPanel() { $('#loginBox').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false; $('#who').textContent = me.email; go('resumo'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#aErr').textContent = '';
  try {
    const r = await api('POST', '/api/auth/login', { email: $('#aEmail').value, password: $('#aPass').value });
    $('#aPass').value = '';
    if (r.user.role !== 'admin') { await api('POST', '/api/auth/logout'); return showLogin('Esta conta não tem acesso ao painel.'); }
    me = r.user; showPanel();
  } catch (err) { $('#aErr').textContent = err.message; }
});
$('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignora */ } me = null; showLogin(); };

$$('.adm-tabs .tab').forEach((b) => { b.onclick = () => go(b.dataset.s); });
function go(s) {
  section = s;
  $$('.adm-tabs .tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.s === s)));
  ({ resumo: viewResumo, usuarios: viewUsuarios, denuncias: viewDenuncias, verificacoes: viewVerificacoes, fotos: viewFotos, convites: viewConvites, encontros: viewEncontros, assinaturas: viewAssinaturas, auditoria: viewAuditoria })[s]();
}
const view = () => $('#view');
function onErr(e) { if (e.status === 401 || e.status === 403) { me = null; showLogin('Sua sessão expirou. Entre novamente.'); } else toast(e.message); }

/* ---------- resumo ---------- */
async function viewResumo() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const s = await api('GET', '/api/admin/stats');
    setBadge(s.openReports); { const vb = $('#verBadge'); vb.hidden = !s.pendingVerifications; vb.textContent = s.pendingVerifications; }
    const max = Math.max(1, ...s.signups.map((d) => d.count));
    view().innerHTML = `
    ${s.paymentsMode === 'asaas' ? (s.asaasEnv === 'sandbox' ? '<p class="banner" style="margin-bottom:1rem">Pix via Asaas em modo de TESTE (sandbox): nenhum pagamento é real. Para valer dinheiro, troque ASAAS_ENV para production e use a chave de produção.</p>' : '<p class="banner teal" style="margin-bottom:1rem">Pix via Asaas em produção.</p>') + (s.webhooksFailed ? `<p class="banner" style="margin-bottom:1rem">${s.webhooksFailed} aviso(s) de pagamento do Asaas falharam ao processar. Veja a aba Assinaturas e use "Conferir no Asaas".</p>` : '') : s.paymentsMode !== 'demo' ? '<p class="banner" style="margin-bottom:1rem">Pagamentos desligados neste servidor. Os planos pagos só podem ser concedidos manualmente por aqui, na ficha de cada usuário.</p>' : '<p class="banner" style="margin-bottom:1rem">Modo de demonstração dos pagamentos ligado: qualquer pessoa ativa planos sem pagar. Não use assim em produção.</p>'}
    <div class="kpis">
      <div class="kpi"><span class="n">${s.users}</span><span class="l">Usuários</span></div>
      <div class="kpi"><span class="n">${s.new7}</span><span class="l">Novos em 7 dias</span></div>
      <div class="kpi"><span class="n">${s.active7}</span><span class="l">Ativos em 7 dias</span></div>
      <div class="kpi"><span class="n">${s.matches}</span><span class="l">Matches</span></div>
      <div class="kpi"><span class="n">${s.messages}</span><span class="l">Mensagens</span></div>
      <div class="kpi"><span class="n">${s.paying}</span><span class="l">Assinantes ativos</span></div>
      <div class="kpi"><span class="n">${brl(s.mrrCents)}</span><span class="l">Receita mensal recorrente</span></div>
      ${s.paymentsMode === 'asaas' ? `<div class="kpi"><span class="n">${s.pixPending}</span><span class="l">Pix aguardando pagamento</span></div>` : ''}
      <div class="kpi${s.openReports ? ' alert' : ''}"><span class="n">${s.openReports}</span><span class="l">Denúncias abertas</span></div>
      <div class="kpi${s.pendingVerifications ? ' alert' : ''}"><span class="n">${s.pendingVerifications}</span><span class="l">Verificações pendentes</span></div>
    </div>
    <div class="two">
      <div class="box"><h3>Novos cadastros nos últimos 14 dias</h3>
        <div class="bars" role="img" aria-label="Gráfico de cadastros por dia">${s.signups.map((d) => `<div class="b" style="height:${Math.max(2, (d.count / max) * 100)}%"><span>${d.count || ''}</span></div>`).join('')}</div>
        <div class="barlabels">${s.signups.map((d) => `<span>${d.day.slice(8)}</span>`).join('')}</div></div>
      <div class="box"><h3>Cidades com mais usuários</h3>
        <div class="tablewrap" style="border:0"><table><tbody>${s.topCities.map((c) => `<tr><td>${esc(c.city)}</td><td class="num">${c.c}</td></tr>`).join('') || '<tr><td>Sem dados</td></tr>'}</tbody></table></div>
        <p class="hint" style="margin-top:.8rem">Suspensos: ${s.suspended} · Verificados: ${s.verified}</p></div>
    </div>`;
  } catch (e) { onErr(e); }
}
function setBadge(n) { const b = $('#repBadge'); b.hidden = !n; b.textContent = n; }

/* ---------- usuários ---------- */
async function viewUsuarios() {
  const st = usersState;
  view().innerHTML = `
    <div class="toolbar">
      <div class="fld"><label for="uq">Buscar por nome ou e-mail</label><input type="text" id="uq" value="${esc(st.q)}"></div>
      <div class="fld"><label for="us">Situação</label><select id="us"><option value="">Todas</option><option value="active">Ativas</option><option value="suspended">Suspensas</option></select></div>
      <div class="fld"><label for="up">Plano</label><select id="up"><option value="">Todos</option><option value="free">Grátis</option><option value="plus">Plus</option><option value="premium">Premium</option></select></div>
      <button class="btn small" id="ugo" type="button">Buscar</button>
    </div>
    <div id="utable"><p class="empty-s">Carregando...</p></div>`;
  $('#us').value = st.status; $('#up').value = st.plan;
  const run = () => { st.q = $('#uq').value; st.status = $('#us').value; st.plan = $('#up').value; st.page = 1; loadUsers(); };
  $('#ugo').onclick = run; $('#uq').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#us').onchange = run; $('#up').onchange = run;
  loadUsers();
}
async function loadUsers() {
  const st = usersState;
  try {
    const q = new URLSearchParams({ q: st.q, status: st.status, plan: st.plan, page: st.page });
    const r = await api('GET', '/api/admin/users?' + q);
    $('#utable').innerHTML = `<div class="tablewrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Cidade</th><th>Plano</th><th>Situação</th><th>Denúncias</th><th>Último acesso</th></tr></thead><tbody>
      ${r.users.map((u) => `<tr class="click" data-id="${u.id}" tabindex="0"><td><strong>${esc(u.name)}</strong>, ${u.age}${u.verified ? ' <span class="st-ok" title="Verificado">&#10003;</span>' : ''}${u.demo ? ' <span class="chip">demo</span>' : ''}</td><td>${esc(u.email)}</td><td>${esc(u.city || '—')}</td><td>${PLAN[u.plan]}</td><td class="${u.status === 'active' ? 'st-ok' : 'st-bad'}">${u.status === 'active' ? 'Ativa' : 'Suspensa'}</td><td class="num">${u.openReports || ''}</td><td>${dt(u.lastSeen)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-s">Nenhum usuário encontrado.</td></tr>'}
      </tbody></table></div>
      <div class="pager"><button class="btn ghost small" id="pprev" type="button"${r.page <= 1 ? ' disabled' : ''}>Anterior</button><span class="hint">Página ${r.page} de ${r.pages} · ${r.total} usuários</span><button class="btn ghost small" id="pnext" type="button"${r.page >= r.pages ? ' disabled' : ''}>Próxima</button></div>`;
    $$('#utable tr.click').forEach((tr) => { const open = () => openUser(Number(tr.dataset.id)); tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
    $('#pprev').onclick = () => { st.page--; loadUsers(); }; $('#pnext').onclick = () => { st.page++; loadUsers(); };
  } catch (e) { onErr(e); }
}
async function openUser(id) {
  try {
    const r = await api('GET', '/api/admin/users/' + id); const u = r.user, s = r.stats;
    const main = u.photos.find((p) => p.isMain);
    $('#umBody').innerHTML = `
      <button class="modal-x" type="button" id="umClose" aria-label="Fechar">&times;</button>
      <div style="display:flex;gap:1rem;align-items:center"><span class="av${main ? ' photo' : ''}" style="width:64px;height:64px;${main ? '' : 'background:var(--accent)'}">${main ? `<img src="/api/photos/${main.id}" alt="">` : esc(u.name.charAt(0))}</span><div><h2 id="umTitle" style="font-size:1.5rem">${esc(u.name)}, ${u.age}</h2><p class="note">${esc(u.email)}</p></div></div>
      <dl class="dl"><dt>Situação</dt><dd class="${u.status === 'active' ? 'st-ok' : 'st-bad'}">${u.status === 'active' ? 'Ativa' : 'Suspensa' + (u.suspendReason ? ': ' + esc(u.suspendReason) : '')}</dd>
        <dt>Plano</dt><dd>${PLAN[u.plan]}${u.planUntil ? ' até ' + dt(u.planUntil) : ''}</dd>
        <dt>Cidade</dt><dd>${esc(u.cityName || '—')}</dd><dt>Verificado</dt><dd>${u.verified ? 'Sim' : 'Não'}</dd>
        <dt>Cadastro</dt><dd>${dt(u.createdAt)}</dd><dt>Último acesso</dt><dd>${dt(u.lastSeen)}</dd>
        <dt>Atividade</dt><dd>${s.likesGiven} curtidas dadas · ${s.likesReceived} recebidas · ${s.matches} matches · ${s.messagesSent} mensagens · bloqueado por ${s.blockedBy}</dd>
        <dt>Bio</dt><dd>${esc(u.bio || '—')}</dd></dl>
      ${u.photos.length ? `<div class="pgrid" style="grid-template-columns:repeat(auto-fill,minmax(80px,1fr))">${u.photos.map((p) => `<div class="pimg${p.isMain ? ' main' : ''}"><img src="/api/photos/${p.id}" alt="Foto do usuário"></div>`).join('')}</div>` : ''}
      <div class="field"><label for="umReason">Motivo ou observação (obrigatório para suspender)</label><input type="text" id="umReason" maxlength="200"></div>
      <div class="actions-row">
        ${u.status === 'active' ? '<button class="btn mini" data-a="suspend" type="button" style="background:var(--accent)">Suspender</button>' : '<button class="btn mini" data-a="unsuspend" type="button">Reativar</button>'}
        <button class="btn ghost mini" data-a="${u.verified ? 'unverify' : 'verify'}" type="button">${u.verified ? 'Remover verificação' : 'Verificar perfil'}</button>
        <button class="btn ghost mini" data-a="resetLink" type="button">Gerar link de nova senha</button>
      </div>
      <div class="field"><label for="umPlan">Conceder plano manualmente</label><div class="actions-row"><select id="umPlan" style="width:auto"><option value="free">Grátis</option><option value="plus">Plus</option><option value="premium">Premium</option></select><input type="number" id="umDays" min="1" max="365" value="30" style="width:90px" aria-label="Dias"><button class="btn ghost mini" data-a="setPlan" type="button">Aplicar</button></div></div>
      ${r.reports.length ? `<h3>Denúncias contra este usuário</h3><div class="cardlist">${r.reports.map((x) => `<div class="rep"><div class="row"><strong>${esc(x.reason)}</strong><span class="chip">${x.status === 'open' ? 'Aberta' : x.status === 'resolved' ? 'Resolvida' : 'Dispensada'}</span><span class="hint">por ${esc(x.reporter || 'conta removida')} · ${dt(x.created_at)}</span></div>${x.details ? `<p class="note">${esc(x.details)}</p>` : ''}</div>`).join('')}</div>` : ''}
      ${r.subscriptions.length ? `<h3>Assinaturas</h3><div class="tablewrap"><table><tbody>${r.subscriptions.map((x) => `<tr><td>${dt(x.created_at)}</td><td>${PLAN[x.plan] || x.plan}</td><td>${brl(x.amount_cents)}</td><td>${esc(x.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="formerr" id="umErr" role="alert"></p>`;
    $('#userModal').hidden = false; $('#umClose').onclick = () => { $('#userModal').hidden = true; };
    $('#umPlan').value = u.plan;
    $$('#umBody [data-a]').forEach((b) => {
      b.onclick = async () => {
        const a = b.dataset.a, body = { action: a, reason: $('#umReason').value };
        if (a === 'setPlan') { body.plan = $('#umPlan').value; body.days = Number($('#umDays').value); }
        try { const rr = await api('POST', `/api/admin/users/${id}/action`, body);
          if (a === 'resetLink') { $('#umErr').style.color = 'var(--ink)'; $('#umErr').innerHTML = 'Envie este link para a pessoa (vale ' + rr.expiresInMinutes + ' min, uso único):<br><input type="text" readonly id="umLink" value="' + esc(rr.link) + '" style="width:100%;margin-top:.4rem">'; $('#umLink').select(); try { await navigator.clipboard.writeText(rr.link); toast('Link copiado.'); } catch (e2) { /* copie à mão */ } return; }
          toast('Feito.'); $('#userModal').hidden = true; if (section === 'usuarios') loadUsers(); else go(section); }
        catch (e) { $('#umErr').textContent = e.message; }
      };
    });
  } catch (e) { onErr(e); }
}
$('#userModal').addEventListener('mousedown', (e) => { if (e.target.id === 'userModal') $('#userModal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#userModal').hidden = true; });

/* ---------- denúncias ---------- */
let repStatus = 'open';
async function viewDenuncias() {
  view().innerHTML = `<div class="toolbar"><div class="fld"><label for="rs">Situação</label><select id="rs"><option value="open">Abertas</option><option value="resolved">Resolvidas</option><option value="dismissed">Dispensadas</option></select></div></div><div id="rlist"><p class="empty-s">Carregando...</p></div>`;
  $('#rs').value = repStatus; $('#rs').onchange = () => { repStatus = $('#rs').value; viewDenuncias(); };
  try {
    const r = await api('GET', '/api/admin/reports?status=' + repStatus);
    if (repStatus === 'open') setBadge(r.reports.length);
    $('#rlist').innerHTML = r.reports.length ? `<div class="cardlist">${r.reports.map((x) => `
      <div class="rep" data-id="${x.id}"><div class="row"><strong>${esc(x.reason)}</strong><span class="hint">contra <a href="#" data-user="${x.reportedId}" style="font-weight:700">${esc(x.reportedName)}</a>${x.reportedStatus === 'suspended' ? ' (suspenso)' : ''} · por ${esc(x.reporter || 'conta removida')} · ${dt(x.createdAt)}</span><span class="chip">${x.totalAgainst} denúncia${x.totalAgainst === 1 ? '' : 's'} no total</span></div>
      ${x.details ? `<p>${esc(x.details)}</p>` : ''}
      ${x.status === 'open' ? `<div class="row"><input type="text" placeholder="Observação (opcional)" maxlength="200" data-note style="flex:1;min-width:200px"><button class="btn ghost mini" data-r="dismiss" type="button">Dispensar</button><button class="btn ghost mini" data-r="warn" type="button">Advertir</button><button class="btn mini" data-r="suspend" type="button" style="background:var(--accent)">Suspender conta</button></div>` : `<p class="note">${esc(x.resolution || '')}</p>`}</div>`).join('')}</div>` : '<p class="empty-s">Nenhuma denúncia nesta lista.</p>';
    $$('#rlist [data-user]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openUser(Number(a.dataset.user)); }; });
    $$('#rlist [data-r]').forEach((b) => {
      b.onclick = async () => {
        const card = b.closest('.rep');
        try { await api('POST', `/api/admin/reports/${card.dataset.id}/resolve`, { action: b.dataset.r, note: card.querySelector('[data-note]').value }); toast('Denúncia tratada.'); viewDenuncias(); }
        catch (e) { toast(e.message); }
      };
    });
  } catch (e) { onErr(e); }
}

/* ---------- fotos ---------- */
async function viewFotos() {
  view().innerHTML = '<p class="note" style="margin-bottom:1rem">Últimas fotos enviadas por usuários reais (perfis de demonstração ficam de fora). Remova o que violar as regras.</p><div id="pl"><p class="empty-s">Carregando...</p></div>';
  try {
    const r = await api('GET', '/api/admin/photos');
    $('#pl').innerHTML = r.photos.length ? `<div class="photos">${r.photos.map((p) => `<div class="ph-item"><div class="pimg${p.isMain ? ' main' : ''}"><img src="/api/photos/${p.id}" alt="Foto de ${esc(p.userName)}" loading="lazy"></div><div class="hint"><a href="#" data-user="${p.userId}">${esc(p.userName)}</a> · ${dt(p.createdAt)}</div><button class="btn ghost mini" data-del="${p.id}" type="button">Remover</button></div>`).join('')}</div>` : '<p class="empty-s">Nenhuma foto enviada ainda.</p>';
    $$('#pl [data-user]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); openUser(Number(a.dataset.user)); }; });
    $$('#pl [data-del]').forEach((b) => { b.onclick = async () => { try { await api('DELETE', '/api/admin/photos/' + b.dataset.del); toast('Foto removida.'); viewFotos(); } catch (e) { toast(e.message); } }; });
  } catch (e) { onErr(e); }
}

/* ---------- verificações por selfie ---------- */
async function viewVerificacoes() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const r = await api('GET', '/api/admin/verifications');
    const b = $('#verBadge'); b.hidden = !r.verifications.length; b.textContent = r.verifications.length;
    view().innerHTML = `<p class="note" style="margin-bottom:1rem">Compare a selfie com a foto principal e com a pose pedida. Aprovar dá o selo de verificado. A selfie é apagada assim que você decide.</p>` +
      (r.verifications.length ? r.verifications.map((v) => `<div class="panel" style="margin-bottom:1rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;align-items:start" data-v="${v.id}">
        <div><strong>${esc(v.name)}, ${v.age}</strong><p class="note">Pose pedida: <strong>${esc(v.pose)}</strong></p><p class="note">${dt(v.createdAt)}</p></div>
        <div><p class="note">Selfie enviada</p><img src="/api/admin/verifications/${v.id}/photo" alt="Selfie de ${esc(v.name)}" style="width:100%;max-width:240px;border-radius:12px"></div>
        <div><p class="note">Foto principal do perfil</p>${v.mainPhotoId ? `<img src="/api/photos/${v.mainPhotoId}" alt="Foto principal de ${esc(v.name)}" style="width:100%;max-width:240px;border-radius:12px">` : '<p class="note">Sem foto principal.</p>'}</div>
        <div style="display:grid;gap:.5rem"><input type="text" placeholder="Motivo (se recusar)" maxlength="200" data-reason><button class="btn" type="button" data-d="approve">Aprovar</button><button class="btn ghost" type="button" data-d="reject">Recusar</button></div>
      </div>`).join('') : '<p class="empty-s">Nenhum pedido de verificação aguardando.</p>');
    $$('#view [data-v]').forEach((box) => { box.querySelectorAll('[data-d]').forEach((btn) => { btn.onclick = async () => {
      btn.disabled = true;
      try { await api('POST', `/api/admin/verifications/${box.dataset.v}/decide`, { action: btn.dataset.d, reason: box.querySelector('[data-reason]').value }); toast(btn.dataset.d === 'approve' ? 'Perfil verificado.' : 'Pedido recusado.'); viewVerificacoes(); }
      catch (e) { btn.disabled = false; onErr(e); }
    }; }); });
  } catch (e) { onErr(e); }
}
/* ---------- convites (indicação) ---------- */
async function viewConvites() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const r = await api('GET', '/api/admin/referrals');
    const st = { pending: 'Aguardando foto/selfie', rewarded: 'Prêmio liberado', rejected: 'Recusada' };
    const why = { same_network: 'mesma rede', cap: 'limite de prêmios', referrer_inactive: 'indicador inativo' };
    view().innerHTML = `<div class="kpis"><div class="kpi"><span class="n">${r.totals.rewarded}</span><span class="l">Prêmios liberados</span></div><div class="kpi"><span class="n">${r.totals.pending}</span><span class="l">Aguardando</span></div><div class="kpi"><span class="n">${r.totals.rejected}</span><span class="l">Recusadas</span></div></div>
      <p class="note" style="margin:.8rem 0">Regras: o amigo ganha ${r.rules.inviteeDays} dias de Plus ao enviar a primeira foto; quem indicou ganha Destaque e, a cada ${r.rules.every} amigos, ${r.rules.referrerDays} dias de Plus. Tudo automático.</p>
      <div class="tablewrap"><table><thead><tr><th>Data</th><th>Quem indicou</th><th>Indicado</th><th>Situação</th></tr></thead><tbody>${r.items.map((i) => `<tr><td>${dt(i.created_at)}</td><td>${esc(i.referrer)}</td><td>${esc(i.invitee)}</td><td>${st[i.status] || i.status}${i.reason ? ' (' + (why[i.reason] || esc(i.reason)) + ')' : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-s">Nenhuma indicação ainda.</td></tr>'}</tbody></table></div>`;
  } catch (e) { onErr(e); }
}
async function viewEncontros() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const r = await api('GET', '/api/admin/events');
    const rows = r.items.map((e) => `<tr><td>${dt(e.startsAt)}</td><td>${esc(e.title)}<br><small>${esc(e.placeType)}${e.placeName ? ' - ' + esc(e.placeName) : ''}</small></td><td>${esc(e.city)}</td><td>${esc(e.host)}<br><small>${esc(e.hostEmail)}</small></td><td>${e.going}/${e.capacity}</td><td>${e.status === 'open' ? 'Aberto' : 'Cancelado'}</td><td>${e.status === 'open' ? `<button class="btn ghost" data-cancel="${e.id}" type="button">Cancelar</button>` : ''}</td></tr>`).join('');
    view().innerHTML = `<p class="note">Encontros em grupo em lugares públicos. Cancele qualquer um que viole as regras.</p><div class="tablewrap"><table><thead><tr><th>Quando</th><th>Encontro</th><th>Cidade</th><th>Organizador</th><th>Vagas</th><th>Situação</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">Nenhum encontro ainda.</td></tr>'}</tbody></table></div>`;
    $$('[data-cancel]').forEach((b) => { b.onclick = async () => { if (!confirm('Cancelar este encontro?')) return; try { await api('POST', '/api/admin/events/' + b.dataset.cancel + '/cancel'); viewEncontros(); } catch (e) { onErr(e); } }; });
  } catch (e) { onErr(e); }
}
/* ---------- assinaturas e auditoria ---------- */
const PIXST = { pending: 'Aguardando', paid: 'Pago', expired: 'Expirado', canceled: 'Cancelado', refunded: 'Estornado' };
async function viewAssinaturas() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const r = await api('GET', '/api/admin/subscriptions');
    let pixHtml = '';
    let pr = null;
    try { pr = await api('GET', '/api/admin/payments'); } catch (e) { /* modo sem Asaas: rota não existe */ }
    if (pr) {
      pixHtml = `<h3 style="margin:1.4rem 0 .6rem">Cobranças Pix (Asaas${pr.sandbox ? ' – teste' : ''})</h3>${pr.failedEvents ? `<p class="banner">${pr.failedEvents} aviso(s) do Asaas com falha.</p>` : ''}<div class="tablewrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Plano</th><th>Valor</th><th>Situação</th><th>Observação</th><th></th></tr></thead><tbody>${pr.payments.map((p) => `<tr><td>${dt(p.createdAt)}</td><td>${p.name ? `${esc(p.name)} <span class="hint">${esc(p.email)}</span>` : '<span class="hint">conta apagada</span>'}</td><td>${PLAN[p.plan] || esc(p.plan)}${p.renewal ? ' <span class="hint">(renovação)</span>' : ''}</td><td class="num">${brl(p.amountCents)}</td><td>${esc(PIXST[p.status] || p.status)}</td><td style="white-space:normal">${esc(p.note || '')}</td><td>${p.status === 'pending' ? `<button class="btn small" type="button" data-check="${p.id}">Conferir no Asaas</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-s">Nenhuma cobrança Pix ainda.</td></tr>'}</tbody></table></div>`;
    }
    view().innerHTML = `<div class="tablewrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Plano</th><th>Valor</th><th>Situação</th><th>Origem</th></tr></thead><tbody>${r.subscriptions.map((s) => `<tr><td>${dt(s.createdAt)}</td><td>${esc(s.name)} <span class="hint">${esc(s.email)}</span></td><td>${PLAN[s.plan] || esc(s.plan)}</td><td class="num">${brl(s.amountCents)}</td><td>${esc(s.status)}</td><td>${esc(s.provider)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-s">Nenhuma assinatura registrada.</td></tr>'}</tbody></table></div>${pixHtml}`;
    view().querySelectorAll('[data-check]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { await api('POST', '/api/admin/payments/' + b.dataset.check + '/check'); toast('Conferido no Asaas.'); viewAssinaturas(); } catch (e) { b.disabled = false; onErr(e); } }; });
  } catch (e) { onErr(e); }
}
async function viewAuditoria() {
  view().innerHTML = '<p class="empty-s">Carregando...</p>';
  try {
    const r = await api('GET', '/api/admin/audit');
    view().innerHTML = `<div class="tablewrap"><table><thead><tr><th>Data</th><th>Administrador</th><th>Ação</th><th>Alvo</th><th>Detalhe</th></tr></thead><tbody>${r.log.map((a) => `<tr><td>${dt(a.createdAt)}</td><td>${esc(a.admin || '—')}</td><td>${esc(a.action)}</td><td>${esc(a.target || '')}</td><td style="white-space:normal">${esc(a.detail || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-s">Nenhuma ação registrada ainda.</td></tr>'}</tbody></table></div>`;
  } catch (e) { onErr(e); }
}

/* início */
(async function () {
  try {
    const r = await api('GET', '/api/me');
    if (r.user && r.user.role === 'admin') { me = r.user; showPanel(); } else showLogin(r.user ? 'Você está logado como usuário comum. Entre com uma conta de administrador.' : '');
  } catch (e) { showLogin(); }
})();
})();
