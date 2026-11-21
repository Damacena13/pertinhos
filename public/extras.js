/* Proteção. Tudo aqui roda no aparelho da pessoa; nada disso concede benefício pago.
   Depende dos ganchos que o app.js expõe em window.PP. */
(function () {
'use strict';
const PP = window.PP;
if (!PP) return;
const { S, $, $$, esc, api, toast, openModal, closeModal, confirmBox } = PP;
const DAY = 86400000, MIN = 60000;
const today = () => new Date().toISOString().slice(0, 10);
const yest = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const digits = (s) => String(s || '').replace(/\D/g, '');
async function copyText(t) { try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; } }
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- armazenamento por usuário ---------- */
const DEF = () => ({ daily: { d: '', like: 0, msg: 0, map: 0, quiz: 0, done: false }, streak: { n: 0, last: '' }, vibe: null,
  sec: { pin: null, auto: 5, blur: true, scan: true, fails: 0, lockUntil: 0 }, contact: { name: '', phone: '' }, safe: null });
let X = DEF(), uid = null;
const key = () => 'pp_x_' + uid;
function loadX() { try { X = Object.assign(DEF(), JSON.parse(localStorage.getItem(key()) || '{}')); } catch (e) { X = DEF(); } }
function saveX() { try { localStorage.setItem(key(), JSON.stringify(X)); } catch (e) { /* ignora */ } }

/* ---------- detector de golpes ---------- */
const SCAM = [
  ['hi', /\b(pix|transfer(e|ir|encia)|deposit(e|a)|emprest(a|imo|e)|vale.?presente|gift ?card|boleto|cartao de credito|r\$ ?\d|reais)\b/, 'Fala de dinheiro ou pagamento. Quem você acabou de conhecer não deve pedir isso. Não envie nada.'],
  ['hi', /(investiment|cripto|bitcoin|renda extra|lucro garantido|forex|day ?trade)/, 'Parece golpe de investimento. Promessas de lucro fácil são o golpe mais comum em apps de encontro.'],
  ['hi', /(codigo (de verificacao|sms|que (chegou|recebeu))|\bsenha\b|\bcvv\b|\btoken\b)/, 'Pede código, senha ou dado de acesso. Nunca compartilhe isso com ninguém.'],
  ['hi', /(\bnudes?\b|foto (intima|pelada)|sem roupa|video pelad)/, 'Pede conteúdo íntimo. Isso pode virar chantagem. Bloqueie e denuncie.'],
  ['md', /(whatsapp|\bzap\b|telegram|instagram|me chama (la|no)|meu numero|me passa seu)/, 'Quer sair do app logo cedo. Golpistas fazem isso para escapar da moderação.'],
  ['md', /(https?:\/\/|www\.|bit\.ly|tinyurl|wa\.me|\.xyz\b|\.top\b)/, 'Contém link. Confira o endereço antes de abrir, mesmo que pareça inofensivo.'],
  ['md', /(urgente|preciso agora|emergencia|acidente|hospital|me ajuda)/, 'Cria pressão e urgência. É uma tática clássica para você agir sem pensar.'],
];
const PERS = [
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/, 'Parece um CPF. Não compartilhe documentos com quem acabou de conhecer.'],
  [/(\(?\d{2}\)?\s?9\d{4}[-\s]?\d{4})/, 'Parece um telefone. Prefira conversar pelo app até ter confiança.'],
  [/(\b(?:\d[ -]?){13,16}\b)/, 'Parece número de cartão. Nunca envie dados de cartão.'],
  [/(moro (na|no|em) |meu endereco|\brua [a-z ]+,? ?\d+|\bav(enida|\.)? [a-z ]+,? ?\d+)/, 'Parece um endereço. Combine encontros em lugares públicos, sem revelar onde mora.'],
];
const scanIn = (text) => { const n = norm(text); return SCAM.filter((r) => r[1].test(n)).map((r) => ({ l: r[0], t: r[2] })).concat(PERS.filter((r) => r[0].test(n)).slice(0, 1).map((r) => ({ l: 'md', t: r[1] }))); };
const scanOut = (text) => { const n = norm(text); return PERS.filter((r) => r[0].test(n)).map((r) => ({ l: 'md', t: r[1] })); };
const flagHtml = (f) => `<div class="x-flag ${f.l}">${esc(f.t)}</div>`;
PP.scamHtml = (text) => (X.sec.scan && uid) ? scanIn(text).slice(0, 2).map(flagHtml).join('') : '';
PP.guardMsg = async (text) => {
  if (!X.sec.scan || !uid) return true;
  const fl = scanOut(text); if (!fl.length) return true;
  return confirmBox('Você está compartilhando um dado pessoal', fl.map((f) => f.t).join(' ') + ' Enviar mesmo assim?', 'Enviar mesmo assim');
};

/* ---------- bloqueio por PIN (PBKDF2 via WebCrypto) ---------- */
const subtle = window.crypto && window.crypto.subtle;
const b64 = (u) => btoa(String.fromCharCode.apply(null, Array.from(u)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(pin, salt, it) { const k = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']); return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, k, 256)); }
function ctEq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
async function verifyPin(pin) { const p = X.sec.pin; if (!p || !subtle) return false; try { return ctEq(await derive(pin, unb64(p.salt), p.it), unb64(p.hash)); } catch (e) { return false; } }
const weakPin = (p) => /^(\d)\1+$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p) || ['1212', '2580', '1004', '0852'].includes(p);
let locked = false, lastAct = Date.now();
const GUARD = () => $$('header, #publicView, #appView, footer');
function setInert(on) { GUARD().forEach((e) => { if (on) { e.setAttribute('inert', ''); e.setAttribute('aria-hidden', 'true'); } else { e.removeAttribute('inert'); e.removeAttribute('aria-hidden'); } }); }
function lockNow() {
  if (!X.sec.pin || locked) return;
  locked = true; $$('.modal').forEach((m) => { if (m.id !== 'modalAsk' && m.id !== 'modalSos') m.hidden = true; });
  setInert(true); document.body.classList.remove('x-priv'); $('#xLock').hidden = false; $('#xLockPin').value = ''; $('#xLockSos').hidden = !X.safe; lockMsg();
  setTimeout(() => { const i = $('#xLockPin'); if (i && !i.disabled) i.focus(); }, 60); safeUI();
}
function unlock() { locked = false; lastAct = Date.now(); $('#xLock').hidden = true; setInert(false); safeUI(); }
function lockMsg(extra) {
  const left = X.sec.lockUntil - Date.now(), m = $('#xLockMsg'), i = $('#xLockPin');
  if (left > 0) { i.disabled = true; m.textContent = 'Muitas tentativas. Aguarde ' + Math.ceil(left / 1000) + ' s.'; clearTimeout(lockMsg.t); lockMsg.t = setTimeout(() => lockMsg(), 1000); }
  else { i.disabled = false; m.textContent = extra || (X.sec.fails ? 'PIN incorreto. Tente de novo.' : 'Digite seu PIN para continuar.'); if (!$('#xLock').hidden) i.focus(); }
}
$('#xLockForm').addEventListener('submit', async (e) => {
  e.preventDefault(); if (Date.now() < X.sec.lockUntil) return;
  const ok = await verifyPin($('#xLockPin').value); $('#xLockPin').value = '';
  if (ok) { X.sec.fails = 0; X.sec.lockUntil = 0; saveX(); unlock(); if (S.tab === 'seguranca') renderSeg(); }
  else { X.sec.fails++; if (X.sec.fails >= 3) X.sec.lockUntil = Date.now() + Math.min(900000, 30000 * Math.pow(2, X.sec.fails - 3)); saveX(); lockMsg(); }
});
$('#xLockSos').onclick = () => openModal('modalSos');
$('#xForgot').onclick = async function () {
  if (this.dataset.arm !== '1') { this.dataset.arm = '1'; this.textContent = 'Clique de novo: sai da conta e remove o PIN'; return; }
  X.sec.pin = null; X.sec.fails = 0; X.sec.lockUntil = 0; saveX(); unlock();
  try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignora */ }
  location.reload();
};
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true }));
setInterval(() => { if (uid && X.sec.pin && !locked && X.sec.auto > 0 && Date.now() - lastAct > X.sec.auto * MIN) lockNow(); }, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (uid && X.sec.pin && X.sec.auto === -1) lockNow(); else if (uid && X.sec.blur) document.body.classList.add('x-priv'); }
  else document.body.classList.remove('x-priv');
});
window.addEventListener('blur', () => { if (uid && X.sec.blur && !locked) document.body.classList.add('x-priv'); });
window.addEventListener('focus', () => document.body.classList.remove('x-priv'));

/* ---------- encontro seguro e SOS ---------- */
const PLACE_OPTS = ['Café', 'Praça', 'Parque', 'Livraria', 'Sorveteria', 'Shopping (praça de alimentação)', 'Outro lugar público'];
function sosText() {
  const d = X.safe, nm = (S.user && S.user.name) || 'Uma pessoa';
  return 'ALERTA Pertinho: ' + nm + ' pode precisar de ajuda.' + (d ? ' Estava em ' + d.place + ' com ' + d.who + ', encontro iniciado às ' + hhmm(d.start) + '.' : '') + ' Tente ligar agora.';
}
function notify(title, body) { try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch (e) { /* ignora */ } }
function startSafe() {
  const sel = $('#xSfWho').value, who = sel === '_' ? ($('#xSfOther').value.trim() || 'alguém que conheci no app') : sel;
  if (!X.contact.phone) { toast('Cadastre antes um contato de confiança.'); return; }
  X.safe = { who: who.slice(0, 60), place: $('#xSfPlace').value, start: Date.now(), end: Date.now() + (+$('#xSfDur').value) * MIN, state: 'on', askAt: 0 };
  saveX(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) { /* ignora */ }
  renderSeg(); safeUI(); toast('Encontro seguro iniciado. Mantenha esta aba aberta: ao fim do tempo pedimos o seu check-in aqui na tela.');
}
function safeTick() {
  const d = X.safe; if (!uid || !d) return;
  const el = $('[data-xleft]');
  if (d.state === 'on') {
    if (Date.now() >= d.end) { d.state = 'ask'; d.askAt = Date.now(); saveX(); $('#xAskTxt').textContent = 'O tempo combinado para o encontro em ' + d.place + ' acabou. Responda em até 3 minutos ou mostramos o atalho para você avisar seu contato.'; openModal('modalAsk'); document.title = '⚠ Está tudo bem? · Pertinho'; notify('Pertinho', 'Está tudo bem no encontro? Responda agora.'); safeUI(); }
    else if (el) el.textContent = mmss(d.end - Date.now());
  } else if (d.state === 'ask') {
    const left = d.askAt + 3 * MIN - Date.now();
    if (el) el.textContent = 'Responda: ' + mmss(left);
    if (left <= 0) { d.state = 'alert'; saveX(); closeModal('modalAsk'); $('#xSosTxt').textContent = 'Sem resposta ao check-in. Avise seu contato de confiança agora.'; openModal('modalSos'); notify('Pertinho', 'Sem resposta ao check-in. Avise seu contato.'); safeUI(); }
  }
}
setInterval(safeTick, 1000);
function endSafe() { X.safe = null; saveX(); document.title = 'Pertinho'; $('#modalAsk').hidden = true; $('#modalSos').hidden = true; safeUI(); if (S.tab === 'seguranca') renderSeg(); }
function safeUI() { const f = $('#xSosFab'); if (f) f.hidden = !(uid && X.safe) || locked; const l = $('#xLockSos'); if (l) l.hidden = !X.safe; }
async function sosShare() {
  let t = sosText();
  if ($('#xSosLoc').checked && navigator.geolocation) {
    try { const p = await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, no, { timeout: 6000, maximumAge: 60000 })); t += ' Localização: https://maps.google.com/?q=' + p.coords.latitude.toFixed(5) + ',' + p.coords.longitude.toFixed(5); }
    catch (e) { toast('Sem permissão de localização. Enviando só o texto.'); }
  }
  const ph = digits(X.contact.phone), full = ph.length <= 11 ? '55' + ph : ph;
  if (ph.length >= 10) window.open('https://wa.me/' + full + '?text=' + encodeURIComponent(t), '_blank', 'noopener');
  else if (navigator.share) { try { await navigator.share({ text: t }); } catch (e) { /* cancelado */ } }
  else { await copyText(t); toast('Mensagem copiada. Envie para alguém de confiança.'); }
}
$('#xSosFab').onclick = () => { $('#xSosTxt').textContent = 'Escolha o que fazer agora. Em risco imediato, ligue para a polícia.'; openModal('modalSos'); };
$('#xSosShare').onclick = sosShare;
$('#xSosHide').onclick = () => { try { location.replace('about:blank'); } catch (e) { document.body.innerHTML = ''; } };
$('#xAskOk').onclick = () => { endSafe(); toast('Que bom! Encontro encerrado.'); };
$('#xAskMore').onclick = () => { if (X.safe) { X.safe.state = 'on'; X.safe.end = Date.now() + 30 * MIN; saveX(); closeModal('modalAsk'); document.title = 'Pertinho'; renderSeg(); } };
$('#xAskSos').onclick = () => { $('#modalAsk').hidden = true; $('#xSosTxt').textContent = 'Escolha o que fazer agora. Em risco imediato, ligue para a polícia.'; openModal('modalSos'); };

/* ---------- central de proteção ---------- */
function secScore() {
  const it = [
    ['pin', 'Bloqueio por PIN', !!X.sec.pin, 30, 'Protege suas conversas se alguém pegar seu aparelho.'],
    ['ver', 'Perfil verificado', !!(S.user && S.user.verified), 25, 'Mostra que você é quem diz ser e dá mais confiança.'],
    ['contact', 'Contato de confiança', !!X.contact.phone, 25, 'Quem será avisado se você pedir ajuda.'],
    ['scan', 'Detector de golpes', !!X.sec.scan, 20, 'Avisa sobre mensagens suspeitas e dados pessoais.'],
  ];
  return { it, pct: it.reduce((a, x) => a + (x[2] ? x[3] : 0), 0) };
}
function renderSeg() {
  const box = $('#p-seguranca'); if (!box || !uid) return;
  const sc = secScore(), col = sc.pct < 40 ? 'var(--rose)' : sc.pct < 80 ? 'var(--warn)' : 'var(--teal)';
  const ms = (S.matches || []), c = X.contact, d = X.safe;
  let safe = `<h3>Encontro seguro ${d ? '<span class="chip teal">Ativo</span>' : ''}</h3>`;
  if (!c.phone) safe += `<p class="note">1. Cadastre quem será avisado se você pedir ajuda. O número fica só neste aparelho.</p><div class="x-two"><input type="text" id="xCtName" placeholder="Nome" maxlength="40" aria-label="Nome do contato"><input type="text" id="xCtPhone" inputmode="tel" placeholder="(17) 99999-0000" maxlength="20" aria-label="Telefone com DDD"></div><button class="btn" type="button" id="xCtSave">Salvar contato</button><p class="formerr" id="xCtMsg" role="alert"></p>`;
  else if (!d) safe += `<p class="note">Contato de confiança: <strong>${esc(c.name)}</strong>. Inicie antes de sair: ao fim do tempo pedimos um check-in. Sem resposta em 3 minutos você recebe o atalho para avisar ${esc(c.name)}. <strong>Mantenha esta aba aberta</strong>: o aviso depende dela.</p>
      <label class="note" for="xSfWho">Com quem você vai</label><select id="xSfWho">${ms.map((m) => `<option value="${esc((m.other || m).name || 'Match')}">${esc((m.other || m).name || 'Match')}</option>`).join('')}<option value="_">Outra pessoa</option></select>
      <input type="text" id="xSfOther" placeholder="Nome da pessoa" maxlength="40" ${ms.length ? 'hidden' : ''}>
      <label class="note" for="xSfPlace">Onde</label><select id="xSfPlace">${PLACE_OPTS.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
      <label class="note" for="xSfDur">Duração</label><select id="xSfDur"><option value="30">30 minutos</option><option value="60" selected>1 hora</option><option value="90">1h30</option><option value="120">2 horas</option><option value="180">3 horas</option></select>
      <button class="btn emerald" type="button" id="xSfStart">Iniciar encontro seguro</button>`;
  else safe += `<div class="x-card" style="background:var(--surface2)"><strong>${esc(d.who)} · ${esc(d.place)}</strong><div class="x-streak"><b style="font-size:2rem" data-xleft>--:--</b></div><p class="note">Aviso para ${esc(c.name)} se não houver check-in.</p></div><div class="x-row"><button class="btn emerald" type="button" id="xSfOk">Estou bem, encerrar</button><button class="btn ghost" type="button" id="xSfMore">+30 min</button><button class="btn ghost" type="button" id="xSfSos" style="color:var(--rose)">SOS</button></div>`;
  box.innerHTML = `<div class="x-head"><h2>Você decide o que os outros veem</h2><p>Proteção feita para quem vai encontrar pessoas de verdade. Tudo aqui roda no seu aparelho.</p></div>
  <div class="x-grid">
    <div class="x-card"><h3>Central de proteção</h3><div class="x-row" style="flex-wrap:nowrap;gap:1rem"><div class="x-ring" style="--p:${sc.pct};--c:${col}"><b>${sc.pct}</b></div><div><strong>${sc.pct >= 80 ? 'Muito bem protegido(a)' : sc.pct >= 40 ? 'Proteção razoável' : 'Pouco protegido(a)'}</strong><div class="note">Ative os itens abaixo para chegar a 100.</div></div></div>
      <div>${sc.it.map((x) => `<div class="x-sec"><span class="x-ck" style="${x[2] ? 'background:var(--teal);color:#03140d' : ''}">${x[2] ? '✓' : ''}</span><div><strong style="font-size:.9rem">${x[1]}</strong><small>${x[4]}</small></div>${x[2] ? '<span class="chip teal">Ativo</span>' : `<button class="btn small" type="button" data-sg="${x[0]}">Ativar</button>`}</div>`).join('')}</div></div>
    <div class="x-card" id="xPin"><h3>Bloqueio do aplicativo</h3>${X.sec.pin ?
      `<p class="note">PIN ativo. Guardado só como resumo criptográfico (PBKDF2-SHA256, 150 mil iterações, sal aleatório). Após 3 erros o app trava por tempo crescente.</p>
       <label class="note" for="xAuto">Bloquear automaticamente</label><select id="xAuto"><option value="1">Após 1 min parado</option><option value="5">Após 5 min parado</option><option value="15">Após 15 min parado</option><option value="-1">Ao sair da aba</option></select>
       <label class="check"><input type="checkbox" id="xBlur"> Borrar a tela quando eu trocar de aba</label>
       <div class="x-row"><button class="btn small" type="button" id="xLockNow">Bloquear agora</button></div>
       <label class="note" for="xPinCur">Para remover, digite o PIN atual</label><div class="x-row" style="flex-wrap:nowrap"><input class="x-pin" id="xPinCur" type="password" inputmode="numeric" maxlength="6" autocomplete="off"><button class="btn ghost small" type="button" id="xRmPin" style="color:var(--rose)">Remover PIN</button></div>` :
      `<p class="note">Crie um PIN de 4 a 6 números. Ele trava o app quando você sai ou fica parado, para ninguém ler suas conversas.</p>
       <div class="x-two"><input class="x-pin" id="xPinNew" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" autocomplete="new-password" aria-label="Novo PIN"><input class="x-pin" id="xPinNew2" type="password" inputmode="numeric" maxlength="6" placeholder="Repetir" autocomplete="new-password" aria-label="Repetir PIN"></div>
       <button class="btn" type="button" id="xSetPin">Ativar bloqueio</button>`}
      <p class="formerr" id="xPinMsg" role="alert"></p><p class="note">Protege contra quem usa seu aparelho. Para trocar de conta ou sair de vez, use "Sair" no Perfil.</p></div>
    <div class="x-card">${safe}</div>
    <div class="x-card"><h3>Detector de golpes</h3><p class="note">Procura sinais comuns de golpe (pedido de dinheiro, links suspeitos, saída para outro app, dados pessoais). Roda só no seu navegador. No chat, mensagens suspeitas recebem um aviso. Cole uma mensagem para testar:</p>
      <textarea id="xScanIn" rows="3" maxlength="400" placeholder="Ex.: Oi amor, me faz um Pix de 50 reais? Depois me chama no WhatsApp"></textarea>
      <div id="xScan" aria-live="polite" style="display:grid;gap:.5rem"></div>
      <label class="check"><input type="checkbox" id="xOptScan"> Avisar sobre mensagens suspeitas no chat</label></div>
  </div>`;
  $('#xOptScan').checked = !!X.sec.scan;
  const sa = $('#xAuto'); if (sa) sa.value = String(X.sec.auto); const sb = $('#xBlur'); if (sb) sb.checked = !!X.sec.blur;
  const w = $('#xSfWho'), o = $('#xSfOther'); if (w && o) { const f = () => { o.hidden = w.value !== '_'; }; w.onchange = f; f(); }
  bindSeg(); scanDemo(); safeUI();
}
function scanDemo() {
  const v = $('#xScanIn').value, o = $('#xScan'); if (!v.trim()) { o.innerHTML = '<div class="x-flag ok">Digite ou cole uma mensagem para analisar.</div>'; return; }
  const fl = scanIn(v); o.innerHTML = fl.length ? fl.map(flagHtml).join('') : '<div class="x-flag ok">Nenhum sinal conhecido encontrado. Isso não garante que seja seguro: confie no seu instinto.</div>';
}
async function setPin() {
  if (!subtle) { toast('Este navegador não permite criptografia (precisa de HTTPS).'); return; }
  const a = $('#xPinNew').value, b = $('#xPinNew2').value, m = $('#xPinMsg');
  if (!/^\d{4,6}$/.test(a)) { m.textContent = 'Use de 4 a 6 números.'; return; }
  if (a !== b) { m.textContent = 'Os dois PINs precisam ser iguais.'; return; }
  if (weakPin(a)) { m.textContent = 'PIN fácil demais (ex.: 1234, 0000). Escolha outro.'; return; }
  const salt = crypto.getRandomValues(new Uint8Array(16)), it = 150000, h = await derive(a, salt, it);
  X.sec.pin = { salt: b64(salt), hash: b64(h), it }; X.sec.fails = 0; X.sec.lockUntil = 0; saveX(); toast('Bloqueio por PIN ativado.'); renderSeg();
}
async function removePin() {
  if (!(await verifyPin($('#xPinCur').value))) { $('#xPinMsg').textContent = 'PIN atual incorreto.'; return; }
  X.sec.pin = null; saveX(); toast('Bloqueio removido.'); renderSeg();
}
function bindSeg() {
  $$('#p-seguranca [data-sg]').forEach((b) => { b.onclick = () => {
    const k = b.dataset.sg;
    if (k === 'pin') $('#xPin').scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (k === 'ver') PP.setTab('perfil');
    else if (k === 'contact') { const e = $('#xCtName') || $('#xSfWho'); if (e) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    else if (k === 'scan') { X.sec.scan = true; saveX(); renderSeg(); }
  }; });
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  on('xSetPin', setPin); on('xRmPin', removePin); on('xLockNow', lockNow); on('xSfStart', startSafe); on('xSfOk', () => { endSafe(); toast('Que bom! Encontro encerrado.'); });
  on('xSfMore', () => { if (X.safe) { X.safe.state = 'on'; X.safe.end = Date.now() + 30 * MIN; saveX(); renderSeg(); } });
  on('xSfSos', () => { $('#xSosTxt').textContent = 'Escolha o que fazer agora. Em risco imediato, ligue para a polícia.'; openModal('modalSos'); });
  on('xCtSave', () => {
    const n = $('#xCtName').value.trim().slice(0, 40), p = digits($('#xCtPhone').value);
    if (!n || p.length < 10 || p.length > 13) { $('#xCtMsg').textContent = 'Informe um nome e um telefone com DDD (10 a 13 dígitos).'; return; }
    X.contact = { name: n, phone: p }; saveX(); toast('Contato de confiança salvo.'); renderSeg();
  });
  $('#xScanIn').addEventListener('input', scanDemo);
  const o = $('#xOptScan'); o.onchange = () => { X.sec.scan = o.checked; saveX(); renderSeg(); };
  const sa = $('#xAuto'); if (sa) sa.onchange = () => { X.sec.auto = +sa.value; saveX(); };
  const sb = $('#xBlur'); if (sb) sb.onchange = () => { X.sec.blur = sb.checked; saveX(); };
}

/* ---------- ganchos do app ---------- */
PP.onUser = (u) => {
  if (!u) { uid = null; X = DEF(); if (locked) unlock(); $('#xLock').hidden = true; setInert(false); safeUI(); try { localStorage.removeItem('pp_x_last'); } catch (e) { /* ignora */ } return; }
  const id = String(u.id), changed = uid !== id;
  if (changed) { uid = id; loadX(); }
  try { localStorage.setItem('pp_x_last', id); } catch (e) { /* ignora */ }
  if (changed && X.sec.pin && !locked) lockNow();
  safeUI();
};
PP.onTab = (t) => {
  if (!uid) return;
  if (t === 'seguranca') renderSeg();
};
// Trava logo ao abrir a página, antes de saber quem é a pessoa, se o último usuário tinha PIN.
(function earlyLock() {
  try {
    const last = localStorage.getItem('pp_x_last'); if (!last || !/^\d+$/.test(last)) return;
    uid = last; loadX(); if (X.sec.pin) lockNow(); else { uid = null; X = DEF(); }
  } catch (e) { /* ignora */ }
})();
})();
