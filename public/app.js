(function () {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pp_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pp_' + k, JSON.stringify(v)); } catch (e) { /* ignora */ } },
};
const hue = (id) => (Number(id) * 47) % 360;
const color = (h, l) => `hsl(${h} 62% ${l}%)`;

/* ---------- estado ---------- */
const S = {
  user: null, plans: null, cities: [], tab: 'descobrir',
  deck: [], deckMeta: null, likes: null, rings: [],
  matches: [], activeMatch: null, thread: null, lastMsgId: 0, selected: null,
  f: Object.assign({ radius: 10, ageMax: 60, verified: false }, store.get('filters', {})),
};

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }
async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opt.headers['x-pertinho'] = '1';
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); } catch (e) { throw new ApiError(0, 'Sem conexão com o servidor. Verifique sua internet.'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* sem corpo */ }
  if (!res.ok) {
    if (res.status === 401 && S.user) { S.user = null; applyUser(); }
    throw new ApiError(res.status, (data && data.error) || 'Algo deu errado. Tente novamente.', data);
  }
  return data;
}
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}
const shopItem = (id) => ((S.plans && S.plans.shop) || []).find((x) => x.id === id);
const shopAction = (id, cls) => { const it = shopItem(id); return it ? { label: `${it.name} (${reais(it.priceCents)})`, cls, run: () => buy({ item: id }) } : null; };
function fail(e) {
  if (e && e.status === 402) {
    const code = e.data && e.data.code;
    if (code === 'trial_over') return paywall(e.message, [shopAction('pass24h', ''), { label: 'Ver os planos', cls: 'ghost', run: () => setTab('planos') }].filter(Boolean));
    if (code === 'need_pass') return paywall(e.message, [shopAction('pass24h', '')].filter(Boolean));
    if (code === 'no_credits') return paywall(e.message, [shopAction('photos3', '')].filter(Boolean));
    return paywall(e.message);
  }
  toast(e && e.message ? e.message : 'Algo deu errado.');
}

/* ---------- modais ---------- */
let lastFocus = null;
function openModal(id) { lastFocus = document.activeElement; const m = $('#' + id); m.hidden = false; const f = m.querySelector('input,select,textarea,button:not([data-close])'); if (f) setTimeout(() => f.focus(), 30); }
function closeModal(id) { $('#' + id).hidden = true; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignora */ } } }
const anyModal = () => $$('.modal').some((m) => !m.hidden);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach((m) => { if (!m.hidden) m.hidden = true; }); });
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; }));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.modal').hidden = true; }));

function confirmBox(title, text, ok) {
  return new Promise((resolve) => {
    $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfOk').textContent = ok || 'Confirmar';
    const done = (v) => { $('#confirmModal').hidden = true; resolve(v); };
    $('#cfOk').onclick = () => done(true); $('#cfCancel').onclick = () => done(false);
    openModal('confirmModal');
  });
}
function paywall(msg, extras) {
  $('#pwText').textContent = msg || 'Este recurso faz parte dos planos pagos.';
  $('#pwImg').innerHTML = '';
  const box = $('#pwActions'); box.innerHTML = '';
  (extras || []).forEach((x) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ' + (x.cls || ''); b.textContent = x.label; b.onclick = () => { $('#payModal').hidden = true; x.run(); }; box.appendChild(b); });
  openModal('payModal');
}
$('#pwClose').onclick = () => closeModal('payModal');
$('#pwPlans').onclick = () => { $('#payModal').hidden = true; if (S.user) setTab('planos'); else openAuth('register'); window.scrollTo({ top: 0, behavior: 'smooth' }); };

/* ---------- tema ---------- */
(function () { const t = store.get('theme', null); if (t) { document.documentElement.setAttribute('data-theme', t); if (t === 'light') document.documentElement.style.colorScheme = 'light'; } })();
$('#themeBtn').onclick = () => {
  const root = document.documentElement; let cur = root.getAttribute('data-theme');
  if (!cur) cur = 'dark';
  const nx = cur === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', nx);
  root.style.colorScheme = nx === 'light' ? 'light' : ''; store.set('theme', nx);
  if (S.tab === 'mapa') renderMap();
};

/* ---------- cidades ---------- */
S.ufs = {};
const ufOptions = (sel) => Object.keys(S.ufs).sort((x, y) => S.ufs[x].localeCompare(S.ufs[y], 'pt-BR')).map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(S.ufs[k])} (${k})</option>`).join('');
const cityOptions = (uf, selected) => S.cities.filter((c) => c.uf === uf).map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
// Liga o par estado/cidade: trocar o estado recarrega as cidades dele.
function wireCity(ufSel, citySel, cityId) {
  const c = S.cities.find((x) => x.id === cityId) || S.cities.find((x) => x.id === 'sao-jose-do-rio-preto-sp') || S.cities[0];
  ufSel.innerHTML = ufOptions(c.uf); citySel.innerHTML = cityOptions(c.uf, c.id);
  ufSel.onchange = () => { citySel.innerHTML = cityOptions(ufSel.value, null); };
}

/* ---------- visitante: radar e planos ---------- */
function heroRadar() {
  const ds = [{ n: 'M', a: 35, r: .3, h: 330 }, { n: 'L', a: 150, r: .52, h: 200 }, { n: 'C', a: 260, r: .7, h: 280 }, { n: 'R', a: 320, r: .86, h: 25 }, { n: 'B', a: 80, r: .62, h: 150 }];
  let h = '';
  ds.forEach((d, i) => {
    const x = 50 + Math.sin(d.a * Math.PI / 180) * d.r * 50, y = 50 - Math.cos(d.a * Math.PI / 180) * d.r * 50;
    h += `<span class="dot" style="left:${x}%;top:${y}%;background:${color(d.h, 46)};--d:${i * .6}s">${d.n}</span>`;
  });
  ['300 m', '1,2 km', '3 km'].forEach((t, i) => { h += `<span class="rlabel" style="top:${50 - (i + 1) * 16.6}%">${t}</span>`; });
  $('#heroRadar').innerHTML = h;
}
const reais = (c) => (c === 0 ? 'R$ 0' : 'R$ ' + (c / 100).toFixed(2).replace('.', ','));
function planFeatures(p) {
  const L = p.limits, free = S.plans ? S.plans.freeChatMessages : 3;
  const f = [`Raio de até ${L.maxRadius} km`, L.dailyLikes ? `${L.dailyLikes} curtidas a cada 24 horas` : 'Curtidas ilimitadas', `${L.superPerDay} Super Curtida${L.superPerDay === 1 ? '' : 's'} por dia`, L.extraPhotos ? 'Ver todas as fotos de cada perfil' : 'Foto principal de cada perfil'];
  f.push(p.id === 'free' ? `${free} mensagens grátis em cada match` : 'Conversas sem limite');
  if (L.rewind) f.push('Desfazer a última escolha');
  if (L.seeLikes) f.push('Ver quem curtiu você');
  if (L.verifiedFilter) f.push('Filtro de perfis verificados');
  if (L.invisible) { f.push('Modo invisível'); f.push('Seu perfil sobe na lista de quem está por perto'); }
  return f;
}
const cycleName = (m) => (m === 1 ? 'mês' : m + ' meses');
function priceBlock(p, months) {
  if (!p.prices || months === 1 || !p.prices[months]) return `<div class="price">${reais(p.priceCents)}<small> /mês</small></div>`;
  const total = p.prices[months], per = Math.round(total / months), off = Math.round((1 - total / (p.priceCents * months)) * 100);
  return `<div class="price">${reais(total)}<small> a cada ${months} meses</small></div><span class="permonth">${reais(per)} por mês · economize ${off}%</span>`;
}
function planCards(mode, months) {
  if (!S.plans) return '';
  months = months || 1;
  const cur = S.user ? S.user.plan : null;
  return S.plans.plans.map((p) => {
    const hot = p.id === 'plus';
    let btn;
    if (mode === 'public') btn = `<button class="btn${hot ? '' : ' ghost'}" type="button" data-open-auth="register">${p.id === 'free' ? 'Começar grátis' : 'Assinar o ' + esc(p.name)}</button>`;
    else if (p.id === cur) btn = `<button class="btn ghost" type="button" disabled>Seu plano atual</button>${p.id !== 'free' ? `<button class="btn ghost" type="button" data-buy="${p.id}" data-months="${months}" style="margin-top:.5rem"${S.plans.paymentsEnabled ? '' : ' disabled'}>Renovar por ${cycleName(months)}</button><button class="btn ghost" type="button" data-cancel-plan style="margin-top:.5rem">${S.plans.paymentsMode === 'asaas' ? 'Não renovar' : 'Cancelar assinatura'}</button>` : ''}`;
    else if (p.id === 'free') btn = '';
    else btn = `<button class="btn${hot ? '' : ' ghost'}" type="button" data-buy="${p.id}" data-months="${months}"${S.plans.paymentsEnabled ? '' : ' disabled'}>Assinar o ${esc(p.name)}</button>`;
    return `<div class="plan${hot ? ' hot' : ''}${p.id === cur ? ' cur' : ''}">${hot ? '<span class="chip pink" style="justify-self:start">Mais escolhido</span>' : ''}<h3>${esc(p.name)}</h3>${priceBlock(p, months)}<ul>${planFeatures(p).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${btn}</div>`;
  }).join('');
}
function renderPublicPlans() { $('#publicPlans').innerHTML = planCards('public'); bindAuthOpeners(); }

/* ---------- autenticação ---------- */
function openAuth(mode) { const rn = $('#refNote'); if (rn) rn.hidden = !pendingRef(); setAuthMode(mode); $('#lErr').textContent = ''; $('#rErr').textContent = ''; openModal('authModal'); }
let resetToken = '';
let resetEmail = '';
function setAuthMode(mode) {
  ['forgotForm', 'resetForm'].forEach((id) => { const f = $('#' + id); if (f) f.hidden = true; });
  if (mode === 'forgot' || mode === 'reset') {
    $('#loginForm').hidden = true; $('#regForm').hidden = true;
    $('#forgotForm').hidden = mode !== 'forgot'; $('#resetForm').hidden = mode !== 'reset';
    $('#authTitle').textContent = mode === 'forgot' ? 'Recuperar senha' : 'Nova senha';
    return;
  }
  const reg = mode === 'register';
  $('#loginForm').hidden = reg; $('#regForm').hidden = !reg;
  $('#segLogin').setAttribute('aria-selected', String(!reg)); $('#segReg').setAttribute('aria-selected', String(reg));
  $('#authTitle').textContent = reg ? 'Criar conta' : 'Entrar';
}
function bindAuthOpeners() { $$('[data-open-auth]').forEach((b) => { b.onclick = () => openAuth(b.dataset.openAuth); }); }
$('#btnLogin').onclick = () => openAuth('login');
$('#btnJoin').onclick = () => openAuth('register');
$('#segLogin').onclick = () => setAuthMode('login');
$('#segReg').onclick = () => setAuthMode('register');

(function () { // data máxima = 18 anos atrás
  const d = new Date(); d.setFullYear(d.getFullYear() - 18);
  $('#rBirth').max = d.toISOString().slice(0, 10); $('#rBirth').min = '1920-01-01';
})();

/* ---------- indicação: captura o ?ref= do link e guarda até o cadastro ---------- */
const REF_RE = /^[A-Z0-9]{8}$/;
(function captureRef() {
  try {
    const q = new URLSearchParams(location.search).get('ref');
    const c = q && q.trim().toUpperCase();
    if (c && REF_RE.test(c)) { localStorage.setItem('pp_ref', c); }
    if (q !== null) history.replaceState(null, '', location.pathname + location.hash);
  } catch (e) { /* sem armazenamento: segue sem convite */ }
})();
function pendingRef() { try { const c = localStorage.getItem('pp_ref'); return c && REF_RE.test(c) ? c : ''; } catch (e) { return ''; } }
function cpfOk(v) { // mesma regra do servidor (dígitos verificadores)
  const d = String(v).replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); if (((s * 10) % 11) % 10 !== +d[n]) return false; }
  return true;
}
$('#rCpf').addEventListener('input', () => {
  const d = $('#rCpf').value.replace(/\D/g, '').slice(0, 11);
  $('#rCpf').value = d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
  $('#rCpf').setAttribute('aria-invalid', String(d.length === 11 && !cpfOk(d)));
});
/* ---------- confirmação de e-mail ---------- */
let confirmToken = '';
(function captureConfirm() {
  try {
    const t = new URLSearchParams(location.search).get('confirm');
    if (t !== null) { if (/^[A-Za-z0-9_-]{20,100}$/.test(t)) confirmToken = t; history.replaceState(null, '', location.pathname + location.hash); }
  } catch (e) { /* ignora */ }
})();
/* ---------- recuperação de senha ---------- */
(function captureReset() {
  try {
    const t = new URLSearchParams(location.search).get('reset');
    if (t !== null) { if (/^[A-Za-z0-9_-]{20,100}$/.test(t)) resetToken = t; history.replaceState(null, '', location.pathname + location.hash); }
  } catch (e) { /* ignora */ }
})();
$('#forgotLink').onclick = () => { $('#fgMsg').textContent = ''; $('#fgEmail').value = $('#lEmail').value; setAuthMode('forgot'); };
$('#fgBack').onclick = () => setAuthMode('login');
$('#forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#fgMsg').textContent = '';
  try {
    const email = $('#fgEmail').value.trim();
    const r = await api('POST', '/api/auth/forgot', { email });
    if (r.localResetToken) {
      resetToken = r.localResetToken;
      resetEmail = email;
      $('#rsMsg').style.color = 'var(--ink)';
      $('#rsMsg').textContent = 'Modo local de homologação: crie uma nova senha agora. Este acesso temporário expira em 1 hora.';
      setAuthMode('reset');
      return;
    }
    $('#fgMsg').style.color = 'var(--ink)';
    $('#fgMsg').textContent = r.emailEnabled
      ? 'Se esse e-mail tiver uma conta, enviaremos um link pessoal para redefinir a senha.'
      : 'Para proteger sua conta, a redefinição exige um link pessoal de uso único. Solicite-o ao suporte.';
  } catch (err) { $('#fgMsg').style.color = ''; $('#fgMsg').textContent = err.message; }
});
$('#resetForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#rsMsg').textContent = '';
  try {
    await api('POST', '/api/auth/reset', { token: resetToken, password: $('#rsPass').value });
    resetToken = ''; $('#rsPass').value = ''; $('#lEmail').value = resetEmail; resetEmail = '';
    $('#rsMsg').style.color = ''; setAuthMode('login'); toast('Senha alterada com sucesso. Entre com sua nova senha.');
  } catch (err) { $('#rsMsg').style.color = ''; $('#rsMsg').textContent = err.message; }
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#lErr').textContent = '';
  try {
    const r = await api('POST', '/api/auth/login', { email: $('#lEmail').value, password: $('#lPass').value });
    $('#lPass').value = ''; await onLoggedIn(r.user, false);
  } catch (err) { $('#lErr').textContent = err.message; }
});
$('#regForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#rErr').textContent = '';
  if (!$('#rTerms').checked) { $('#rErr').textContent = 'Confirme que tem 18 anos ou mais e aceita os termos.'; return; }
  if (!cpfOk($('#rCpf').value)) { $('#rErr').textContent = 'Informe um CPF válido.'; return; }
  try {
    const r = await api('POST', '/api/auth/register', {
      cpf: $('#rCpf').value, ref: pendingRef() || undefined, name: $('#rName').value, birthDate: $('#rBirth').value, email: $('#rEmail').value, password: $('#rPass').value,
      gender: $('#rGender').value, seeking: $('#rSeeking').value, cityId: $('#rCity').value, bio: $('#rBio').value, terms: true,
    });
    $('#rPass').value = ''; $('#rCpf').value = ''; if (r.referral) { try { localStorage.removeItem('pp_ref'); } catch (e) { /* ok */ } } await onLoggedIn(r.user, true);
  } catch (err) { $('#rErr').textContent = err.message; }
});
async function onLoggedIn(user, isNew) {
  S.user = user; $('#authModal').hidden = true;
  applyUser();
  setTab(isNew ? 'perfil' : 'descobrir');
  if (isNew) toast('Conta criada! Adicione uma foto principal para aparecer para as outras pessoas.');
  window.scrollTo({ top: 0 });
}
async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignora */ }
  S.user = null; S.deck = []; S.matches = []; S.activeMatch = null; applyUser(); window.scrollTo({ top: 0 });
}

/* ---------- casca: visitante x app ---------- */
function avatarHtml(u, size) {
  const st = size ? `width:${size}px;height:${size}px;` : '';
  if (u.mainPhotoId) return `<span class="av photo" style="${st}"><img src="/api/photos/${Number(u.mainPhotoId)}" alt=""></span>`;
  return `<span class="av" style="${st}background:linear-gradient(135deg,${color(hue(u.id), 52)},${color(hue(u.id) + 40, 38)})">${esc((u.name || '?').charAt(0).toUpperCase())}</span>`;
}
function applyUser() {
  const u = S.user;
  document.body.dataset.view = u ? 'app' : 'public';
  $('#publicView').hidden = !!u; $('#appView').hidden = !u;
  $('#hdrUser').classList.toggle('on', !!u);
  if (!u) { stopPolling(); if (window.PP && PP.onUser) PP.onUser(null); return; }
  const main = u.photos.find((p) => p.isMain);
  $('#hdrName').textContent = u.name;
  $('#hdrAv').className = 'av' + (main ? ' photo' : '');
  $('#hdrAv').innerHTML = main ? `<img src="/api/photos/${main.id}" alt="">` : esc(u.name.charAt(0).toUpperCase());
  if (!main) $('#hdrAv').style.background = `linear-gradient(135deg,${color(330, 52)},${color(20, 40)})`; else $('#hdrAv').style.background = '';
  $('#planChip').textContent = 'Plano ' + ({ free: 'Grátis', plus: 'Plus', premium: 'Premium' })[u.plan];
  const lim = u.limits;
  $('#fRadius').max = lim.maxRadius;
  if (S.f.radius > lim.maxRadius) S.f.radius = lim.maxRadius;
  $('#fRadius').value = S.f.radius; $('#fAgeMax').value = S.f.ageMax;
  $('#fVerified').checked = S.f.verified && lim.verifiedFilter;
  updateFilterLabels();
  const banner = $('#appBanner');
  const noConf = u.emailConfirmed === false;
  banner.innerHTML = (noConf ? `<div class="banner"><p><strong>Confirme seu e-mail.</strong> Enviamos um link para ${esc(u.email)}. Até confirmar, você não aparece para os outros nem consegue curtir ou conversar.</p><button class="btn small" type="button" id="bnConfirm">Reenviar e-mail</button></div>` : '') + (main ? '' : '<div class="banner"><p><strong>Falta a foto principal.</strong> Seu perfil só aparece para outras pessoas depois que você adicionar uma.</p><button class="btn small" type="button" id="bnPhoto">Adicionar foto</button></div>');
  const bn = $('#bnPhoto'); if (bn) bn.onclick = () => setTab('perfil');
  const bc = $('#bnConfirm'); if (bc) bc.onclick = async () => { bc.disabled = true; try { await api('POST', '/api/auth/resend-confirm'); toast('E-mail enviado. Olhe também a caixa de spam.'); } catch (e) { toast(e.message); } setTimeout(() => { bc.disabled = false; }, 60000); };
  startPolling();
  if (window.PP && PP.onUser) PP.onUser(u);
}
$('#planChip').addEventListener('click', (e) => { e.preventDefault(); if (S.user) setTab('planos'); });

/* ---------- abas ---------- */
function setTab(t) {
  S.tab = t;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  ['descobrir', 'mapa', 'matches', 'jogos', 'seguranca', 'perfil', 'planos'].forEach((n) => { $('#p-' + n).hidden = n !== t; });
  $('#filters').style.display = (t === 'descobrir' || t === 'mapa') ? '' : 'none';
  if (t === 'descobrir') loadDeck();
  if (t === 'mapa') { loadDeck().then(renderMap); loadRings(); renderSpots(); loadRadar(); }
  if (t === 'matches') loadMatches(true);
  if (t === 'perfil') renderProfile();
  if (t === 'planos') renderPlansTab();
  if (window.PP && PP.onTab) PP.onTab(t);
}
$$('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

/* ---------- filtros ---------- */
function updateFilterLabels() {
  $('#fRadiusOut').textContent = S.f.radius + ' km'; $('#fAgeOut').textContent = S.f.ageMax;
}
let filterTimer;
function onFilter() {
  S.f.radius = +$('#fRadius').value; S.f.ageMax = +$('#fAgeMax').value;
  S.f.verified = $('#fVerified').checked;
  updateFilterLabels(); store.set('filters', S.f);
  clearTimeout(filterTimer); filterTimer = setTimeout(() => { loadDeck().then(() => { if (S.tab === 'mapa') renderMap(); }); }, 250);
}
$('#fRadius').oninput = onFilter; $('#fAgeMax').oninput = onFilter;
$('#fVerified').onchange = function () {
  if (this.checked && !S.user.limits.verifiedFilter) { this.checked = false; return paywall('O filtro de perfis verificados faz parte dos planos Plus e Premium.'); }
  onFilter();
};
$('#fRadius').addEventListener('change', () => {
  if (S.user && S.user.limits.maxRadius < 50 && +$('#fRadius').value >= S.user.limits.maxRadius) { $('#deckNote').dataset.hintRadius = '1'; }
});

/* ---------- descobrir ---------- */
async function loadDeck() {
  if (!S.user) return;
  try {
    const q = new URLSearchParams({ radius: S.f.radius, ageMin: 18, ageMax: S.f.ageMax, verified: S.f.verified && S.user.limits.verifiedFilter ? '1' : '0', limit: 50 });
    const d = await api('GET', '/api/discover?' + q);
    S.deck = d.profiles; S.deckMeta = d;
    renderDeck(); renderNear();
  } catch (e) { if (e.status !== 401) toast(e.message); }
  loadLikes();
}
function cardHtml(p, back) {
  const photo = p.mainPhotoId ? `<img src="/api/photos/${Number(p.mainPhotoId)}" alt="Foto de ${esc(p.name)}" draggable="false">` : '';
  let gal = '';
  if (p.extraPhotoIds.length) gal = p.extraPhotoIds.map((id, i) => `<button type="button" class="thumb" data-gal="${p.id}" data-i="${i + 1}" aria-label="Abrir foto ${i + 2} de ${esc(p.name)}"><img src="/api/photos/${Number(id)}" alt=""></button>`).join('') + `<span class="galnote">${p.extraPhotoIds.length} fotos extras</span>`;
  else if (p.extraLocked) gal = Array.from({ length: Math.min(p.extraCount, 4) }, (_, i) => `<button type="button" class="thumb lock" data-lock="1" aria-label="Foto extra de ${esc(p.name)} bloqueada. Disponível nos planos pagos"><span class="ph" style="background:linear-gradient(150deg,${color(hue(p.id) + i * 38, 46)},${color(hue(p.id) + i * 38 + 60, 28)})"></span>${LOCK}</button>`).join('') + `<span class="galnote">Ver +${p.extraCount} fotos com plano</span>`;
  return `<article class="card${back ? ' back' : ''}" data-id="${p.id}" aria-label="${esc(p.name)}, ${p.age} anos">
    <div class="photo" style="background:linear-gradient(160deg,${color(hue(p.id), 44)},${color(hue(p.id) + 50, 26)})">${photo}</div>
    <span class="stamp l">CURTI</span><span class="stamp p">PASSO</span>
    <div class="info">${gal ? `<div class="gal" data-nodrag>${gal}</div>` : ''}
      <div class="meta"><span class="dist">${esc(p.distanceText)}</span>${p.verified ? '<span class="chip teal" style="background:rgba(255,255,255,.9)">Verificado</span>' : ''}${p.premium ? '<span class="chip pink">Em destaque</span>' : ''}</div>
      <h3>${esc(p.name)}, ${p.age}</h3>
      <p class="meta" style="opacity:.85">${esc(p.cityName || '')}</p>
      <p class="bio">${esc(p.bio)}</p>
      <div class="tags">${p.interests.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    </div></article>`;
}
const LOCK = '<span class="lk"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>';
const deck = $('#deck');
function renderDeck() {
  const list = S.deck;
  const meta = S.deckMeta || {};
  if (!list.length) {
    const max = S.user.limits.maxRadius;
    const canWiden = S.f.radius < max;
    deck.innerHTML = `<div class="empty"><h3>Ninguém novo neste raio</h3><p class="note">Você viu todas as pessoas num raio de ${S.f.radius} km${S.f.verified ? ' (só verificados)' : ''}. ${canWiden ? 'Amplie o raio para encontrar mais gente.' : (max < 50 ? 'O plano Plus amplia o raio até 50 km.' : 'Volte mais tarde, novas pessoas entram todo dia.')}</p><div>${canWiden ? '<button class="btn" id="moreRadius" type="button">Ampliar raio</button>' : (max < 50 ? '<button class="btn" id="morePlan" type="button">Ver planos</button>' : '')}</div></div>`;
    const mr = $('#moreRadius'); if (mr) mr.onclick = () => { S.f.radius = Math.min(max, S.f.radius + 10); $('#fRadius').value = S.f.radius; onFilter(); };
    const mp = $('#morePlan'); if (mp) mp.onclick = () => setTab('planos');
  } else {
    deck.innerHTML = (list[1] ? cardHtml(list[1], true) : '') + cardHtml(list[0], false);
    bindDrag(deck.querySelector('.card:not(.back)'));
    bindGal(deck);
  }
  $('#bPass').disabled = $('#bLike').disabled = $('#bMsg').disabled = !list.length;
  const left = meta.likesLeft;
  $('#deckNote').textContent = left == null ? 'Arraste o cartão para a direita para curtir e para a esquerda para passar.' : `Arraste para curtir ou passar. Você tem ${left} curtida${left === 1 ? '' : 's'} nas próximas 24 horas.`;
}
function renderNear() {
  const list = S.deck;
  $('#nearTitle').textContent = list.length + (list.length === 1 ? ' pessoa nova' : ' pessoas novas') + ' em ' + S.f.radius + ' km';
  $('#nearSub').textContent = 'Perto de ' + (S.user.cityName || 'você') + ', da mais próxima para a mais distante.';
  $('#nearList').innerHTML = list.slice(0, 6).map((p) => `<li>${avatarHtml(p)}<span class="grow"><strong>${esc(p.name)}, ${p.age}</strong><small>${esc(p.interests.slice(0, 2).join(' · ') || p.cityName || '')}</small></span><span class="mono" style="font-size:.85rem">${p.distanceKm} km</span></li>`).join('') || '<li><span class="note">Nenhuma pessoa nova neste raio. Amplie o raio ou ajuste os filtros.</span></li>';
}
function bindGal(root) {
  root.querySelectorAll('[data-gal]').forEach((b) => { b.onclick = () => { const p = S.deck.find((x) => x.id === Number(b.dataset.gal)); if (p) openLight(p, Number(b.dataset.i)); }; });
  root.querySelectorAll('[data-lock]').forEach((b) => { b.onclick = () => paywall('Você vê a foto principal. As outras fotos ficam disponíveis para assinantes do Plus e do Premium.'); });
}
function bindDrag(card) {
  if (!card) return;
  let sx = 0, dx = 0, drag = false;
  const sl = card.querySelector('.stamp.l'), sp = card.querySelector('.stamp.p');
  card.addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('[data-nodrag]')) return; drag = true; sx = e.clientX; dx = 0; try { card.setPointerCapture(e.pointerId); } catch (x) { /* ignora */ } card.style.transition = 'none'; });
  card.addEventListener('pointermove', (e) => { if (!drag) return; dx = e.clientX - sx; card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`; sl.style.opacity = Math.min(1, Math.max(0, dx / 110)); sp.style.opacity = Math.min(1, Math.max(0, -dx / 110)); });
  const end = () => { if (!drag) return; drag = false; card.style.transition = ''; if (dx > 110) act('like'); else if (dx < -110) act('pass'); else { card.style.transform = ''; sl.style.opacity = 0; sp.style.opacity = 0; } dx = 0; };
  card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
}
let acting = false;
async function act(kind, profile) {
  const p = profile || S.deck[0];
  if (!p || acting) return;
  acting = true;
  const fromDeck = !profile || S.deck[0] === p;
  const card = deck.querySelector('.card:not(.back)');
  if (fromDeck && card) { card.style.transition = 'transform .35s ease,opacity .35s'; card.style.transform = `translateX(${kind === 'like' ? 600 : -600}px) rotate(${kind === 'like' ? 22 : -22}deg)`; card.style.opacity = '0'; }
  try {
    const r = await api('POST', '/api/swipe', { userId: p.id, kind });
    S.deck = S.deck.filter((x) => x.id !== p.id);
    if (S.deckMeta) S.deckMeta.likesLeft = r.likesLeft;
    if (kind !== 'pass' && window.PP && PP.mission) PP.mission('like');
    setTimeout(() => { renderDeck(); renderNear(); if (S.tab === 'mapa') { S.selected = null; renderMap(); renderSel(); } }, fromDeck ? 280 : 0);
    if (r.match) { showMatch(r.profile, r.matchId); loadMatches(false); }
    if (S.deck.length <= 1) setTimeout(loadDeck, 400);
    loadLikes();
  } catch (e) {
    if (card) { card.style.transform = ''; card.style.opacity = ''; }
    fail(e);
  } finally { acting = false; }
}
$('#bPass').onclick = () => act('pass');
let dmTarget = null;
$('#bMsg').onclick = () => {
  const p = S.deck[0]; if (!p) return;
  if (!S.user.passUntil) return fail({ status: 402, data: { code: 'need_pass' }, message: 'Para mandar mensagem antes do match, ative o Passe 24h.' });
  dmTarget = p; $('#dmTitle').textContent = 'Mensagem para ' + p.name; $('#dmBody').value = ''; $('#dmErr').textContent = ''; openModal('directModal');
};
$('#dmCancel').onclick = () => closeModal('directModal');
$('#dmSend').onclick = async () => {
  const body = $('#dmBody').value.trim(); if (!body || !dmTarget) { $('#dmErr').textContent = 'Escreva uma mensagem.'; return; }
  try {
    const r = await api('POST', `/api/users/${dmTarget.id}/direct`, { body });
    closeModal('directModal'); toast(r.existing ? 'Vocês já têm uma conversa.' : 'Pedido de conversa enviado!');
    S.activeMatch = r.matchId; setTab('matches');
  } catch (e) { if (e.status === 402) { closeModal('directModal'); fail(e); } else $('#dmErr').textContent = e.message; }
};
$('#bLike').onclick = () => act('like');
document.addEventListener('keydown', (e) => {
  if (!S.user || S.tab !== 'descobrir' || anyModal()) return;
  if (/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
  if (e.key === 'ArrowRight') act('like'); else if (e.key === 'ArrowLeft') act('pass');
});

async function loadLikes() {
  try {
    S.likes = await api('GET', '/api/likes-received');
    const b = $('#likesBox'); const l = S.likes;
    if (!l.count) { b.innerHTML = '<span class="grow note">Quando alguém curtir você, aparece aqui.</span>'; return; }
    if (l.locked) b.innerHTML = `<span class="num">${l.count}</span><span class="grow"><strong>${l.count === 1 ? 'pessoa curtiu' : 'pessoas curtiram'} você</strong><br><span class="note">Veja quem são com o plano Plus.</span></span><button class="btn small" type="button" id="seeLikes">Ver quem</button>`;
    else b.innerHTML = `<span class="num">${l.count}</span><span class="grow"><strong>${l.count === 1 ? 'pessoa curtiu' : 'pessoas curtiram'} você</strong><br>${l.profiles.slice(0, 3).map((p) => `<button type="button" class="linkbtn" data-likeback="${p.id}">${esc(p.name)}, ${p.age}</button>`).join(' · ')}</span>`;
    const sl = $('#seeLikes'); if (sl) sl.onclick = () => paywall('Ver quem curtiu você faz parte dos planos Plus e Premium.');
    b.querySelectorAll('[data-likeback]').forEach((x) => { x.onclick = () => { const p = l.profiles.find((q) => q.id === Number(x.dataset.likeback)); if (p) { S.deck = S.deck.filter((d) => d.id !== p.id); S.deck.unshift(p); renderDeck(); toast('Mostrando ' + p.name + ' no topo. Curta para dar match.'); } }; });
  } catch (e) { /* silencioso */ }
}

function showMatch(p, matchId) {
  const me = S.user, mm = me.photos.find((x) => x.isMain);
  $('#mPair').innerHTML = (mm ? `<span class="av photo"><img src="/api/photos/${mm.id}" alt=""></span>` : `<span class="av" style="background:${color(330, 45)}">${esc(me.name.charAt(0).toUpperCase())}</span>`) + avatarHtml(p, 84);
  $('#mText').textContent = `Você e ${p.name} se curtiram e estão ${p.distanceText.replace('a cerca de', 'a cerca de').replace('a menos', 'a menos')}. Que tal combinar um café em lugar público?`;
  openModal('matchModal');
  $('#mChat').onclick = () => { $('#matchModal').hidden = true; S.activeMatch = matchId; setTab('matches'); };
}
$('#mClose').onclick = () => closeModal('matchModal');

/* ---------- lightbox ---------- */
let LB = null;
function openLight(p, i) { LB = { p, ids: [p.mainPhotoId, ...p.extraPhotoIds], i }; renderLight(); openModal('lightModal'); }
function renderLight() { $('#lbImg').innerHTML = `<img src="/api/photos/${Number(LB.ids[LB.i])}" alt="Foto ${LB.i + 1} de ${esc(LB.p.name)}" style="width:100%;height:100%;object-fit:cover">`; $('#lbCap').textContent = `${LB.p.name}, foto ${LB.i + 1} de ${LB.ids.length}`; }
$('#lbPrev').onclick = () => { if (LB) { LB.i = (LB.i - 1 + LB.ids.length) % LB.ids.length; renderLight(); } };
$('#lbNext').onclick = () => { if (LB) { LB.i = (LB.i + 1) % LB.ids.length; renderLight(); } };
$('#lbClose').onclick = () => closeModal('lightModal');

/* ---------- mapa ---------- */
const angleOf = (id) => ((Number(id) * 137.508) % 360);
function renderMap() {
  if (!S.user) return;
  const svg = $('#map'), C = 320, R = 285, max = S.deckMeta ? S.deckMeta.radius : S.f.radius;
  let s = '<rect width="640" height="640" fill="var(--bg)"/>';
  for (let i = 0; i < 14; i++) { const a = (i * 53 % 180) * Math.PI / 180, off = ((i * 97 % 400) - 200); s += `<line x1="${(C + Math.cos(a) * 400 + Math.sin(a) * off).toFixed(1)}" y1="${(C + Math.sin(a) * 400 - Math.cos(a) * off).toFixed(1)}" x2="${(C - Math.cos(a) * 400 + Math.sin(a) * off).toFixed(1)}" y2="${(C - Math.sin(a) * 400 - Math.cos(a) * off).toFixed(1)}" stroke="var(--line)" stroke-width="${i % 4 === 0 ? 5 : 2}" stroke-linecap="round"/>`; }
  s += `<circle cx="${C}" cy="${C}" r="${R}" fill="var(--surface)" fill-opacity=".55" stroke="var(--line)" stroke-width="2"/>`;
  [0.25, 0.5, 0.75, 1].forEach((f) => { s += `<circle cx="${C}" cy="${C}" r="${(R * f).toFixed(1)}" fill="none" stroke="var(--teal)" stroke-opacity=".5" stroke-dasharray="4 6"/><text x="${C + 4}" y="${(C - R * f + 14).toFixed(1)}" style="font-family:var(--f-mono);fill:var(--muted);font-size:11px">${Math.round(max * f * 10) / 10} km</text>`; });
  S.deck.forEach((p) => {
    const rr = Math.min(1, p.distanceKm / max) * R, a = angleOf(p.id) * Math.PI / 180;
    const x = C + Math.sin(a) * rr, y = C - Math.cos(a) * rr, sel = S.selected === p.id;
    s += `<g class="pin" tabindex="0" role="button" aria-label="${esc(p.name)}, ${esc(p.distanceText)}" data-person="${p.id}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sel ? 17 : 14}" fill="${color(hue(p.id), 46)}" stroke="${sel ? 'var(--accent)' : 'var(--surface)'}" stroke-width="${sel ? 4 : 3}"/><text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" style="fill:#fff;font-weight:700;font-size:13px;font-family:var(--f-display)">${esc(p.name.charAt(0))}</text></g>`;
  });
  s += `<circle cx="${C}" cy="${C}" r="22" fill="var(--accent)" fill-opacity=".18"/><circle cx="${C}" cy="${C}" r="9" fill="var(--accent)" stroke="var(--surface)" stroke-width="3"/><text x="${C + 14}" y="${C + 4}" style="fill:var(--accent);font-weight:700;font-size:12px;font-family:var(--f-mono)">Você</text>`;
  svg.innerHTML = s;
  svg.querySelectorAll('.pin').forEach((g) => {
    const fn = () => { S.selected = Number(g.dataset.person); renderMap(); renderSel(); };
    g.addEventListener('click', fn);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  });
  renderSel();
}
function renderSel() {
  const box = $('#selBox'), p = S.deck.find((x) => x.id === S.selected);
  if (!p) { box.innerHTML = '<p class="note">Toque em uma pessoa no mapa para ver os detalhes.</p>'; return; }
  box.innerHTML = `<div class="mapdetail"><div style="display:flex;gap:.8rem;align-items:center">${avatarHtml(p, 52)}<div><h3>${esc(p.name)}, ${p.age}</h3><p class="note">${esc(p.distanceText)}${p.verified ? ' · Verificado' : ''}</p></div></div><p>${esc(p.bio)}</p><div style="display:flex;gap:.4rem;flex-wrap:wrap">${p.interests.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div><div style="display:flex;gap:.5rem"><button class="btn small" type="button" id="selLike">Curtir</button><button class="btn ghost small" type="button" id="selPass">Passar</button></div></div>`;
  $('#selLike').onclick = () => act('like', p); $('#selPass').onclick = () => act('pass', p);
}
async function loadRings() {
  try { const r = await api('GET', '/api/discover/count'); S.rings = r.rings; } catch (e) { S.rings = []; }
  const max = S.user.limits.maxRadius;
  $('#ringList').innerHTML = S.rings.map((r) => `<li><span class="sq">${r.km}</span><span class="grow"><strong>Até ${r.km} km</strong>${r.km > max ? '<small>Disponível nos planos Plus e Premium</small>' : ''}</span><span class="mono">${r.km > max ? '—' : r.count + (r.count === 1 ? ' pessoa' : ' pessoas')}</span></li>`).join('');
}
const PLACES = [['Café', 'cafés'], ['Praça', 'praças'], ['Parque', 'parques'], ['Livraria', 'livrarias com café'], ['Sorveteria', 'sorveterias'], ['Shopping (praça de alimentação)', 'shoppings']];
const mapsUrl = (q) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q + ' em ' + (S.user.cityName && S.user.cityName !== 'Localização por GPS' ? S.user.cityName : 'perto de mim'));
let radarInit = false;
async function loadRadar() {
  const sel = $('#radUf'), list = $('#radList'); if (!sel) return;
  const draw = async () => {
    try {
      const r = await api('GET', '/api/radar?uf=' + sel.value);
      list.innerHTML = r.cities.length ? r.cities.map((c) => `<li><span>${esc(c.name)}</span><strong>${c.n}</strong></li>`).join('') : `<li class="note">Ninguém em ${esc(r.name)} ainda. Convide amigos!</li>`;
    } catch (e) { list.innerHTML = ''; }
  };
  if (!radarInit) {
    try {
      const r = await api('GET', '/api/radar');
      const mine = (S.user.cityId || '').slice(-2).toUpperCase();
      sel.innerHTML = r.states.map((s) => `<option value="${s.uf}"${s.uf === mine ? ' selected' : ''}>${esc(s.name)} (${s.uf}) · ${s.n}</option>`).join('');
      sel.onchange = draw; radarInit = true;
    } catch (e) { return; }
  }
  draw();
}
function renderSpots() {
  $('#spotNote').textContent = 'Escolha um lugar movimentado e de fácil acesso. O Google Maps abre em outra aba, com as opções perto de ' + (S.user.cityName || 'você') + '. Confira o horário de funcionamento antes de sair.';
  $('#spotLinks').innerHTML = PLACES.map(([n, q]) => `<a class="btn ghost small" href="${esc(mapsUrl(q))}" target="_blank" rel="noopener noreferrer">${esc(n.split(' ')[0])}</a>`).join('');
}

/* ---------- conversas ---------- */
let polling = null, pollSlow = null;
function startPolling() {
  stopPolling();
  polling = setInterval(pollThread, 4000);
  pollSlow = setInterval(() => { if (!document.hidden) loadMatches(false); }, 20000);
  loadMatches(false);
}
function stopPolling() { clearInterval(polling); clearInterval(pollSlow); polling = pollSlow = null; }
async function loadMatches(openFirst) {
  if (!S.user) return;
  try {
    const r = await api('GET', '/api/matches'); S.matches = r.matches;
    const b = $('#unreadBadge'); b.hidden = !r.unreadTotal; b.textContent = r.unreadTotal;
    if (S.tab === 'matches') {
      if (!S.activeMatch && openFirst && S.matches.length && window.innerWidth > 900) S.activeMatch = S.matches[0].id;
      renderConvs();
      if (S.activeMatch && (!S.thread || S.thread.id !== S.activeMatch)) loadThread(S.activeMatch);
      else if (!S.activeMatch) renderThread();
    }
  } catch (e) { /* silencioso */ }
}
function renderConvs() {
  const ul = $('#convs');
  if (!S.matches.length) { ul.innerHTML = '<li class="note">Seus matches aparecem aqui. Curta pessoas na aba Descobrir.</li>'; return; }
  ul.innerHTML = S.matches.map((m) => `<li><button class="conv" type="button" data-id="${m.id}" aria-current="${S.activeMatch === m.id}">${avatarHtml(m.user)}<span class="grow"><strong>${esc(m.user.name)}</strong>${m.request === 'received' ? ' <span class="chip pink">Pedido</span>' : ''}${m.unread ? ` <span class="badge" style="margin:0">${m.unread}</span>` : ''}<small>${esc(m.last || 'Diga oi!')}</small></span></button></li>`).join('');
  ul.querySelectorAll('.conv').forEach((b) => { b.onclick = () => { S.activeMatch = Number(b.dataset.id); renderConvs(); loadThread(S.activeMatch); }; });
}
async function loadThread(id) {
  try {
    const r = await api('GET', `/api/matches/${id}/messages`);
    S.thread = { id, other: r.other, messages: r.messages, request: r.request }; S.lastMsgId = r.messages.length ? r.messages[r.messages.length - 1].id : 0;
    renderThread(); loadMatches(false);
  } catch (e) { S.activeMatch = null; S.thread = null; renderThread(); if (e.status !== 401) toast(e.message); }
}
function msgHtml(m) {
  const t = new Date(m.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (m.kind === 'place') {
    const q = (PLACES.find((x) => x[0] === m.body) || [m.body, m.body])[1];
    return `<div class="msg ${m.mine ? 'me' : 'them'} place"><div class="placebox"><strong>Sugestão de encontro</strong><span>Que tal: ${esc(m.body)}? Escolham um lugar público e movimentado.</span><a href="${esc(mapsUrl(q))}" target="_blank" rel="noopener noreferrer">Ver opções no mapa</a></div><time>${t}</time></div>`;
  }
  return `<div class="msg ${m.mine ? 'me' : 'them'}">${esc(m.body)}<time>${t}</time>${!m.mine && window.PP && PP.scamHtml ? PP.scamHtml(m.body) : ''}</div>`;
}
function renderThread() {
  const th = $('#thread');
  if (!S.thread || !S.activeMatch) {
    th.innerHTML = `<div class="nochat"><h3>${S.matches.length ? 'Escolha uma conversa' : 'Nenhum match ainda'}</h3><p>${S.matches.length ? 'Selecione alguém na lista.' : 'Curta pessoas na aba Descobrir. Quando for recíproco, a conversa abre aqui.'}</p></div>`;
    return;
  }
  const o = S.thread.other;
  th.innerHTML = `<div class="thead">${avatarHtml(o)}<div style="min-width:0"><strong>${esc(o.name)}, ${o.age}</strong><div class="note">${esc(o.distanceText || '')}</div></div>
    <div class="menu" style="margin-left:auto"><button class="btn ghost small" type="button" id="thMenuBtn" aria-haspopup="true" aria-expanded="false">Opções</button>
    <div class="menu-list" id="thMenu" hidden><button type="button" data-a="place">Sugerir encontro</button><button type="button" data-a="unmatch">Desfazer match</button><button type="button" data-a="report" class="danger">Denunciar</button><button type="button" data-a="block" class="danger">Bloquear</button></div></div></div>
    ${S.thread.request === 'received' ? `<div class="banner" id="reqBar" style="margin:.5rem"><span>${esc(o.name)} quer conversar. Responda para aceitar.</span> <button class="btn ghost small" id="reqNo" type="button">Recusar</button></div>` : S.thread.request === 'sent' ? '<p class="note" style="margin:.5rem">Pedido enviado. Você pode mandar outra mensagem quando a pessoa responder.</p>' : ''}
    <div class="msgs" id="msgs">${S.thread.messages.map(msgHtml).join('') || '<p class="note" style="text-align:center">Vocês deram match. Diga oi!</p>'}</div>
    <div class="suggest" id="suggest" hidden><span class="note" style="width:100%">Escolha o tipo de local público:</span>${PLACES.map(([n]) => `<button type="button" class="chip teal" data-place="${esc(n)}" style="border:0;cursor:pointer">${esc(n)}</button>`).join('')}</div>
    <form class="composer" id="cForm"><label for="cIn" class="sr" style="position:absolute;left:-9999px">Mensagem</label><input type="text" id="cIn" placeholder="Escreva uma mensagem" autocomplete="off" maxlength="1000"><button class="btn small" type="submit">Enviar</button></form>`;
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  $('#cForm').onsubmit = async (e) => { e.preventDefault(); const v = $('#cIn').value.trim(); if (!v) return; if (window.PP && PP.guardMsg && !(await PP.guardMsg(v))) return; $('#cIn').value = ''; await sendMsg({ body: v }); };
  const rn = $('#reqNo');
  if (rn) rn.onclick = async () => { try { await api('POST', `/api/matches/${S.activeMatch}/decline`); afterRemoved('Pedido recusado.'); } catch (e) { fail(e); } };
  const mb = $('#thMenuBtn'), ml = $('#thMenu');
  mb.onclick = () => { ml.hidden = !ml.hidden; mb.setAttribute('aria-expanded', String(!ml.hidden)); };
  ml.querySelectorAll('button').forEach((b) => { b.onclick = () => { ml.hidden = true; threadAction(b.dataset.a); }; });
  th.querySelectorAll('[data-place]').forEach((b) => { b.onclick = async () => { $('#suggest').hidden = true; await sendMsg({ kind: 'place', body: b.dataset.place }); }; });
}
async function sendMsg(payload) {
  try { await api('POST', `/api/matches/${S.activeMatch}/messages`, payload); if (S.thread && S.thread.request === 'received') { S.thread.request = null; const rb = $('#reqBar'); if (rb) rb.remove(); } if (window.PP && PP.mission) PP.mission('msg'); await pollThread(); } catch (e) { fail(e); }
}
async function pollThread() {
  if (!S.user || S.tab !== 'matches' || !S.activeMatch || !S.thread || document.hidden) return;
  try {
    const r = await api('GET', `/api/matches/${S.activeMatch}/messages?after=${S.lastMsgId}`);
    if (!r.messages.length) return;
    const box = $('#msgs'); if (!box) return;
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const ph = box.querySelector('p.note'); if (ph) ph.remove();
    r.messages.forEach((m) => { S.thread.messages.push(m); box.insertAdjacentHTML('beforeend', msgHtml(m)); S.lastMsgId = m.id; });
    if (stick) box.scrollTop = box.scrollHeight;
    loadMatches(false);
  } catch (e) { /* tenta de novo no próximo ciclo */ }
}
let reportTarget = null;
async function threadAction(a) {
  const o = S.thread.other, id = S.activeMatch;
  if (a === 'place') { $('#suggest').hidden = !$('#suggest').hidden; return; }
  if (a === 'unmatch') { if (!(await confirmBox('Desfazer match?', `A conversa com ${o.name} será apagada para vocês dois.`, 'Desfazer'))) return; try { await api('DELETE', `/api/matches/${id}`); afterRemoved('Match desfeito.'); } catch (e) { fail(e); } }
  if (a === 'block') { if (!(await confirmBox('Bloquear ' + o.name + '?', 'Vocês não se verão mais e a conversa será removida.', 'Bloquear'))) return; try { await api('POST', `/api/users/${o.id}/block`); afterRemoved(o.name + ' foi bloqueado(a).'); } catch (e) { fail(e); } }
  if (a === 'report') { reportTarget = o; $('#repErr').textContent = ''; $('#repDetails').value = ''; openModal('reportModal'); }
}
function afterRemoved(msg) { S.activeMatch = null; S.thread = null; toast(msg); loadMatches(false).then(() => { renderConvs(); renderThread(); }); }
$('#repCancel').onclick = () => closeModal('reportModal');
$('#repSend').onclick = async () => {
  try {
    await api('POST', `/api/users/${reportTarget.id}/report`, { reason: $('#repReason').value, details: $('#repDetails').value, block: $('#repBlock').checked });
    $('#reportModal').hidden = true; toast('Denúncia enviada. Obrigado por avisar.');
    if ($('#repBlock').checked) afterRemoved('');
  } catch (e) { $('#repErr').textContent = e.message; }
};

/* ---------- perfil ---------- */
async function loadRefPanel() {
  const box = $('#refPanel'); if (!box) return;
  try {
    const r = await api('GET', '/api/me/referral');
    const st = { rewarded: 'Prêmio liberado', pending: r.requireVerified ? 'Aguardando a selfie verificada' : 'Aguardando a primeira foto', not_counted: 'Não contou' };
    box.innerHTML = `<h3>Convide amigos e ganhe Plus</h3>
      <p class="note">Quem entra pelo seu link ganha ${r.rules.inviteeDays} dias de Plus ao enviar a primeira foto${r.requireVerified ? ' e ter a selfie verificada' : ''}. Você ganha um Destaque de 30 min por amigo e ${r.rules.referrerDays} dias de Plus a cada ${r.rules.every} amigos. Tudo é liberado automaticamente.</p>
      <div style="display:flex;gap:.5rem"><input type="text" id="refLink" readonly value="${esc(r.link)}" aria-label="Seu link de convite"><button class="btn small" id="refCopy" type="button">Copiar</button><button class="btn ghost small" id="refShare" type="button">Compartilhar</button></div>
      <p class="note"><strong>${r.rewarded}</strong> prêmio(s) liberado(s) · <strong>${r.pending}</strong> aguardando · faltam <strong>${r.untilBonus}</strong> para o bônus de Plus.</p>
      ${r.items.length ? `<ul class="note" style="padding-left:1.1rem">${r.items.slice(0, 8).map((i) => `<li>${esc(i.name)}: ${st[i.status] || ''}</li>`).join('')}</ul>` : ''}`;
    $('#refCopy').onclick = async () => { try { await navigator.clipboard.writeText(r.link); toast('Link copiado.'); } catch (e) { $('#refLink').select(); toast('Selecione e copie o link.'); } };
    $('#refShare').onclick = async () => {
      const text = 'Entre no Pertinho pelo meu convite e ganhe 3 dias de Plus: ' + r.link;
      try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast('Convite copiado.'); } } catch (e) { /* cancelado */ }
    };
  } catch (e) { box.innerHTML = ''; }
}
function renderProfile() {
  const u = S.user, p = $('#p-perfil'), lim = u.limits;
  p.innerHTML = `
  <div class="formgrid" style="align-items:start;gap:2rem">
    <div style="display:grid;gap:1.2rem">
      <h3>Seus dados</h3>
      <div class="field"><label for="pName">Nome</label><input type="text" id="pName" maxlength="30" value="${esc(u.name)}"></div>
      <div class="field"><label for="pBio">Sobre você</label><textarea id="pBio" maxlength="200">${esc(u.bio)}</textarea></div>
      <div class="field"><label for="pInt">Interesses</label><input type="text" id="pInt" maxlength="160" value="${esc(u.interests.join(', '))}"><span class="hint">Até 6, separados por vírgula. Ex.: Café, Corrida, Livros</span></div>
      <div class="formgrid"><div class="field"><label for="pGender">Eu sou</label><select id="pGender"><option value="f">Mulher</option><option value="m">Homem</option><option value="o">Outro</option></select></div>
      <div class="field"><label for="pSeek">Quero conhecer</label><select id="pSeek"><option value="all">Todos</option><option value="f">Mulheres</option><option value="m">Homens</option></select></div></div>
      <label class="check"><input type="checkbox" id="pNotify"${u.notifyEmail ? ' checked' : ''}> Receber avisos por e-mail (match, mensagens, encontros)</label>
      <label class="check"><input type="checkbox" id="pInvis"${u.invisible ? ' checked' : ''}${lim.invisible ? '' : ' disabled'}> Modo invisível (Premium)</label>
      <p class="formerr" id="pErr" role="alert"></p>
      <div><button class="btn" id="pSave" type="button">Salvar alterações</button></div>

      <h3 style="margin-top:1rem">Localização</h3>
      <p class="note">Guardamos sua posição de forma aproximada e só mostramos distâncias arredondadas. Hoje: <strong>${esc(u.cityName || 'não definida')}</strong>${u.locSource === 'gps' ? ' (por GPS)' : ''}.</p>
      <div class="field"><label for="pUf">Estado</label><select id="pUf"></select></div>
      <div class="field"><label for="pCity">Cidade</label><select id="pCity"></select></div>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap"><button class="btn ghost" id="pCitySave" type="button">Usar esta cidade</button><button class="btn ghost" id="pGps" type="button">Usar minha localização</button></div>
    </div>

    <div style="display:grid;gap:1.2rem">
      <div id="refPanel" class="refpanel"></div>
      <h3>Suas fotos <span class="hint" style="font-weight:400">${u.photos.length} de 5</span></h3>
      <p class="note">A primeira é a principal e aparece para todos. As outras 4 só aparecem para quem tem plano pago. Removemos da imagem os dados de GPS do celular.</p>
      <div class="pgrid" id="pGrid">
        ${u.photos.map((ph) => `<div class="pitem"><div class="pimg${ph.isMain ? ' main' : ''}"><img src="/api/photos/${ph.id}" alt="Sua foto${ph.isMain ? ' principal' : ''}">${ph.isMain ? '<span class="tag">Principal</span>' : ''}</div><div class="pbtns">${ph.isMain ? '' : `<button class="btn ghost" type="button" data-main="${ph.id}">Tornar principal</button>`}<button class="btn ghost" type="button" data-del="${ph.id}">Excluir</button></div></div>`).join('')}
        ${u.photos.length < 5 ? '<label class="addphoto" for="pFile">+ Adicionar foto</label>' : ''}
      </div>
      <input type="file" id="pFile" accept="image/jpeg,image/png,image/webp" hidden>
      <p class="formerr" id="phErr" role="alert"></p>

      <h3 style="margin-top:1rem">Conta</h3>
      <p class="note">${esc(u.email)} · ${u.verified ? 'Perfil verificado' : 'Perfil ainda não verificado'}</p>
      <details><summary>Alterar senha</summary><div class="field" style="margin-top:.8rem"><label for="pwCur">Senha atual</label><input type="password" id="pwCur" autocomplete="current-password"></div><div class="field" style="margin-top:.6rem"><label for="pwNew">Nova senha</label><input type="password" id="pwNew" autocomplete="new-password"></div><p class="formerr" id="pwErr" role="alert"></p><button class="btn ghost small" id="pwSave" type="button">Alterar senha</button></details>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap"><a class="btn ghost small" href="/api/me/export">Baixar meus dados</a><button class="btn ghost small" id="pLogout" type="button">Sair da conta</button></div>
      <div class="dangerzone"><strong>Apagar minha conta</strong><p class="note">Remove perfil, fotos, curtidas e conversas. Não dá para desfazer.</p><div class="field"><label for="delPass">Confirme sua senha</label><input type="password" id="delPass" autocomplete="current-password"></div><p class="formerr" id="delErr" role="alert"></p><div><button class="btn ghost small" id="delBtn" type="button" style="color:var(--accent)">Apagar conta</button></div></div>
    </div>
  </div>`;
  $('#pGender').value = u.gender; $('#pSeek').value = u.seeking;
  wireCity($('#pUf'), $('#pCity'), u.cityId);
  loadRefPanel();
  $('#pSave').onclick = async () => {
    $('#pErr').textContent = '';
    try {
      const r = await api('PATCH', '/api/me', { name: $('#pName').value, bio: $('#pBio').value, interests: $('#pInt').value.split(','), gender: $('#pGender').value, seeking: $('#pSeek').value, invisible: $('#pInvis').checked, notifyEmail: $('#pNotify').checked });
      S.user = r.user; applyUser(); toast('Perfil salvo.');
    } catch (e) { if (e.status === 402) { $('#pInvis').checked = false; } $('#pErr').textContent = e.message; }
  };
  $('#pCitySave').onclick = async () => { try { const r = await api('POST', '/api/me/location', { cityId: $('#pCity').value }); S.user = r.user; applyUser(); renderProfile(); toast('Cidade atualizada.'); } catch (e) { fail(e); } };
  $('#pGps').onclick = () => {
    if (!navigator.geolocation) return toast('Este navegador não oferece localização.');
    toast('Pedindo permissão de localização...');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { const r = await api('POST', '/api/me/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }); S.user = r.user; applyUser(); renderProfile(); toast('Localização atualizada.'); } catch (e) { fail(e); }
    }, () => toast('Não foi possível obter a localização. Escolha sua cidade na lista.'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  };
  $('#pFile').onchange = async function () {
    const f = this.files[0]; this.value = ''; $('#phErr').textContent = '';
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { $('#phErr').textContent = 'Use uma imagem JPG, PNG ou WebP.'; return; }
    if (f.size > 5 * 1024 * 1024) { $('#phErr').textContent = 'A imagem passa de 5 MB.'; return; }
    const fd = new FormData(); fd.append('photo', f);
    try { const r = await api('POST', '/api/me/photos', fd); S.user = r.user; applyUser(); renderProfile(); toast('Foto adicionada.'); } catch (e) { $('#phErr').textContent = e.message; }
  };
  p.querySelectorAll('[data-main]').forEach((b) => { b.onclick = async () => { try { const r = await api('POST', `/api/me/photos/${b.dataset.main}/main`); S.user = r.user; applyUser(); renderProfile(); } catch (e) { fail(e); } }; });
  p.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { if (!(await confirmBox('Excluir foto?', 'Esta foto será removida do seu perfil.', 'Excluir'))) return; try { const r = await api('DELETE', `/api/me/photos/${b.dataset.del}`); S.user = r.user; applyUser(); renderProfile(); } catch (e) { fail(e); } }; });
  $('#pwSave').onclick = async () => { $('#pwErr').textContent = ''; try { await api('POST', '/api/auth/password', { current: $('#pwCur').value, next: $('#pwNew').value }); $('#pwCur').value = $('#pwNew').value = ''; toast('Senha alterada.'); } catch (e) { $('#pwErr').textContent = e.message; } };
  $('#pLogout').onclick = logout;
  $('#delBtn').onclick = async () => {
    $('#delErr').textContent = '';
    if (!$('#delPass').value) { $('#delErr').textContent = 'Digite sua senha para confirmar.'; return; }
    if (!(await confirmBox('Apagar sua conta?', 'Perfil, fotos, curtidas e conversas serão apagados para sempre.', 'Apagar tudo'))) return;
    try { await api('DELETE', '/api/me', { password: $('#delPass').value }); S.user = null; applyUser(); toast('Conta apagada.'); } catch (e) { $('#delErr').textContent = e.message; }
  };
}

/* ---------- planos (aba) ---------- */
const PLAN_NAME = { free: 'Grátis', plus: 'Plus', premium: 'Premium' };
function renderPlansTab() {
  const u = S.user, until = u.planUntil ? new Date(u.planUntil).toLocaleDateString('pt-BR') : null;
  const asaas = S.plans && S.plans.paymentsMode === 'asaas';
  $('#p-planos').innerHTML = `<div class="sechead" style="margin-bottom:1.4rem"><h2 style="font-size:1.8rem">Seu plano: ${PLAN_NAME[u.plan]}</h2>${until ? `<p class="note">Ativo até ${until}.${asaas && u.plan !== 'free' ? (u.renewalOff ? ' Não será renovado automaticamente.' : '') : ''}</p>` : ''}${S.plans && !S.plans.paymentsEnabled ? '<p class="banner" style="margin:0">Os pagamentos ainda não estão ativados neste servidor. Os botões de assinatura ficam desligados até a ativação.</p>' : ''}<div id="billBanner"></div></div><div class="plans">${planCards('app')}</div>`;
  $$('#p-planos [data-buy]').forEach((b) => {
    b.onclick = async () => {
      if (asaas) return startPix(b.dataset.buy);
      try { const r = await api('POST', '/api/billing/checkout', { plan: b.dataset.buy }); S.user = r.user; applyUser(); renderPlansTab(); toast('Plano ' + r.user.plan + ' ativado.'); } catch (e) { toast(e.message); }
    };
  });
  const c = $('#p-planos [data-cancel-plan]');
  if (c) c.onclick = async () => {
    const msg = asaas ? 'Seu plano continua até o fim do período já pago e não será renovado.' : 'Você volta ao plano Grátis agora e perde os recursos do plano pago.';
    if (!(await confirmBox('Cancelar assinatura?', msg, 'Cancelar plano'))) return;
    try { const r = await api('POST', '/api/billing/cancel'); S.user = r.user; applyUser(); renderPlansTab(); toast(asaas ? 'Renovação desligada.' : 'Assinatura cancelada.'); } catch (e) { fail(e); }
  };
  if (asaas) loadBillBanner();
}

/* ---------- pagamento por Pix (Asaas) ---------- */
const pix = { ref: null, timer: null, plan: null, needsCustomer: false };
function pixShow(which) {
  $('#pixForm').hidden = which !== 'form'; $('#pixBox').hidden = which !== 'box'; $('#pixDone').hidden = which !== 'done';
}
function pixStop() { clearInterval(pix.timer); pix.timer = null; }
async function loadBillBanner() {
  const box = $('#billBanner'); if (!box) return;
  try {
    const s = await api('GET', '/api/billing/status');
    if (!$('#billBanner')) return;
    const parts = [];
    if (s.sandbox) parts.push('<p class="banner" style="margin-top:1rem"><span>Modo de teste: os pagamentos aqui não são reais.</span></p>');
    if (s.pending) parts.push(`<div class="banner" style="margin-top:1rem"><p>Você tem um Pix aguardando pagamento (${esc(PLAN_NAME[s.pending.plan] || '')}).</p><button class="btn small" type="button" id="pixResume">Ver Pix</button></div>`);
    else if (s.renewalDue && !s.renewalOff) parts.push(`<div class="banner teal" style="margin-top:1rem"><p>Seu plano vence em ${s.daysLeft} dia(s). Renove para não perder os recursos.</p><button class="btn small" type="button" id="pixRenew">Renovar com Pix</button></div>`);
    if (S.user.plan !== 'free' && S.user.planUntil) parts.push(`<p class="note" style="margin-top:.8rem"><button class="linkbtn" type="button" id="renewToggle" style="background:none;border:0;color:var(--accent);text-decoration:underline;padding:0;font:inherit;cursor:pointer">${S.user.renewalOff ? 'Ligar aviso de renovação' : 'Não quero renovar'}</button></p>`);
    box.innerHTML = parts.join('');
    const r1 = $('#pixResume'); if (r1) r1.onclick = () => startPix(s.pending.plan);
    const r2 = $('#pixRenew'); if (r2) r2.onclick = () => startPix(S.user.plan);
    const t = $('#renewToggle');
    if (t) t.onclick = async () => { try { const r = await api('POST', '/api/billing/renewal', { off: !S.user.renewalOff }); S.user = r.user || { ...S.user, renewalOff: !S.user.renewalOff }; applyUser(); renderPlansTab(); } catch (e) { fail(e); } };
  } catch (e) { /* o banner é opcional */ }
}
async function startPix(plan) {
  pix.plan = plan; pixStop(); $('#pixErr').textContent = '';
  try {
    const s = await api('GET', '/api/billing/status');
    pix.needsCustomer = !!s.needsCustomer;
    if (s.needsCustomer && !(s.pending && s.pending.plan === plan)) { pixShow('form'); openModal('pixModal'); return; }
    await requestPix({});
  } catch (e) { fail(e); }
}
async function requestPix(extra) {
  const r = await api('POST', '/api/billing/pix', { plan: pix.plan, ...extra });
  pix.ref = r.payment.ref; showPix(r.payment);
}
function showPix(p) {
  $('#pixInfo').textContent = `Plano ${PLAN_NAME[p.plan || pix.plan] || ''} por ${reais(p.amountCents)} (30 dias). O Pix vale por 24 horas.`;
  $('#pixQr').src = 'data:image/png;base64,' + p.image; // atribuído pela propriedade do DOM, nunca por HTML
  $('#pixCode').value = p.payload || '';
  $('#pixWait').textContent = 'Aguardando o pagamento…';
  pixShow('box'); if ($('#pixModal').hidden) openModal('pixModal');
  pixStop(); pix.timer = setInterval(pixPoll, 4000);
}
async function pixPoll() {
  if (!pix.ref) return;
  try {
    const { payment } = await api('GET', '/api/billing/pix/' + encodeURIComponent(pix.ref));
    if (payment.status === 'paid') {
      pixStop();
      const r = await api('GET', '/api/me'); if (r.user) { S.user = r.user; applyUser(); }
      $('#pixDoneText').textContent = S.user && S.user.planUntil ? `Seu plano ${PLAN_NAME[S.user.plan]} está ativo até ${new Date(S.user.planUntil).toLocaleDateString('pt-BR')}.` : 'Seu plano está ativo.';
      pixShow('done'); if (S.tab === 'planos') renderPlansTab();
    } else if (payment.status !== 'pending') {
      pixStop(); closeModal('pixModal'); toast(payment.status === 'expired' ? 'Esse Pix expirou. Gere outro.' : 'Essa cobrança foi encerrada.'); if (S.tab === 'planos') renderPlansTab();
    }
  } catch (e) { /* falha de rede: tenta de novo no próximo ciclo */ }
}
function bindPix() {
  const m = $('#pixModal');
  m.addEventListener('click', (ev) => { if (ev.target === m || ev.target.hasAttribute('data-close')) { pixStop(); closeModal('pixModal'); if (S.tab === 'planos') renderPlansTab(); } });
  $('#pixForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); $('#pixErr').textContent = '';
    const fullName = $('#pixName').value.trim(), cpfCnpj = $('#pixCpf').value.trim();
    if (!fullName.includes(' ')) { $('#pixErr').textContent = 'Informe nome e sobrenome.'; return; }
    if (cpfCnpj.replace(/\D/g, '').length < 11) { $('#pixErr').textContent = 'Informe um CPF válido.'; return; }
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try { await requestPix({ fullName, cpfCnpj }); $('#pixCpf').value = ''; } catch (e) { $('#pixErr').textContent = e.message; } finally { if (btn) btn.disabled = false; }
  });
  $('#pixCopy').onclick = async () => {
    const code = $('#pixCode').value;
    try { await navigator.clipboard.writeText(code); toast('Código copiado.'); }
    catch (e) { $('#pixCode').select(); try { document.execCommand('copy'); toast('Código copiado.'); } catch (e2) { toast('Selecione o código e copie.'); } }
  };
  $('#pixCancel').onclick = async () => {
    try { await api('POST', '/api/billing/pix/' + encodeURIComponent(pix.ref) + '/cancel'); } catch (e) { /* já encerrada */ }
    pixStop(); closeModal('pixModal'); if (S.tab === 'planos') renderPlansTab();
  };
  $('#pixOk').onclick = () => { closeModal('pixModal'); setTab('descobrir'); };
}

/* ---------- início ---------- */
async function init() {
  heroRadar(); bindAuthOpeners(); bindPix();
  if (confirmToken) { try { await api('POST', '/api/auth/confirm', { token: confirmToken }); toast('E-mail confirmado! Agora você já pode curtir e conversar.'); } catch (e) { toast(e.message); } }
  if (resetToken) { $('#rsMsg').textContent = ''; setAuthMode('reset'); openModal('authModal'); }
  try { const r = await api('GET', '/api/cities'); S.ufs = r.ufs; S.cities = r.cities.map(([id, name, uf]) => ({ id, name, uf })); wireCity($('#rUf'), $('#rCity'), 'sao-jose-do-rio-preto-sp'); } catch (e) { /* segue */ }
  try { S.plans = await api('GET', '/api/plans'); renderPublicPlans(); } catch (e) { /* segue */ }
  try {
    const r = await api('GET', '/api/me');
    if (r.user) { S.user = r.user; applyUser(); setTab('descobrir'); }
    else { applyUser(); if (r.suspended) { openAuth('login'); $('#lErr').textContent = 'Sua conta está suspensa.' + (r.reason ? ' Motivo: ' + r.reason : ''); } }
  } catch (e) { applyUser(); }
}
window.PP = { S, $, $$, esc, api, toast, openModal, closeModal, confirmBox, setTab, fail, avatarHtml };
init();
})();
