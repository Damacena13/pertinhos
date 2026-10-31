'use strict';
// Aba "Encontros": grupos de 4 a 12 pessoas da mesma cidade em lugares públicos.
(() => {
const { $, esc, api, toast } = window.PP;
const root = () => $('#p-encontros');
let skipList = false, detailTimer = null, current = null, placeTypes = [];
const fmt = (t) => new Date(t).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const stop = () => { if (detailTimer) { clearInterval(detailTimer); detailTimer = null; } current = null; };
const fail = (e) => toast(e && e.message ? e.message : 'Não foi possível concluir.');

async function list() {
  stop();
  root().innerHTML = '<p class="note">Carregando encontros...</p>';
  try {
    const r = await api('GET', '/api/events'); placeTypes = r.placeTypes;
    const cards = r.items.map((e) => `<article class="panel" style="padding:1rem;margin:.7rem 0">
      <h3 style="margin:0 0 .3rem">${esc(e.title)}</h3>
      <p class="note" style="margin:0">${esc(fmt(e.startsAt))} · ${esc(e.placeType)} · ${esc(e.city)}</p>
      <p class="note" style="margin:.2rem 0 .6rem">Organiza: ${esc(e.hostName)} · ${e.going}/${e.capacity} confirmados${e.joined ? ' · <strong>você vai</strong>' : e.full ? ' · lotado' : ''}</p>
      <button class="btn" data-open="${e.id}" type="button">${e.joined ? 'Abrir' : 'Ver detalhes'}</button></article>`).join('');
    root().innerHTML = `<h2 style="margin:.2rem 0">Encontros em grupo</h2>
      <p class="note">Programas em lugares públicos, em grupo, na sua cidade. O local exato aparece só para quem confirma presença.</p>
      <button class="btn" id="evNew" type="button">Criar um encontro</button>
      <div id="evList">${cards || '<p class="note" style="margin-top:1rem">Ainda não há encontros na sua cidade. Crie o primeiro!</p>'}</div>`;
    $('#evNew').onclick = form;
    root().querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => detail(b.dataset.open); });
  } catch (e) { root().innerHTML = '<p class="note">Entre na sua conta para ver os encontros.</p>'; if (e.status !== 401) fail(e); }
}

function form() {
  stop();
  const min = new Date(Date.now() + 3 * 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  root().innerHTML = `<button class="btn ghost" id="evBack" type="button">Voltar</button><h2>Novo encontro</h2>
    <form id="evForm" class="stack" style="display:grid;gap:.7rem;max-width:30rem">
      <label>Título<input name="title" maxlength="60" required placeholder="Café e conversa"></label>
      <label>Tipo de local público<select name="placeType">${placeTypes.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <label>Nome do local (só quem confirmar vê)<input name="placeName" maxlength="80" placeholder="Ex.: Café Central, Rua das Flores 100"></label>
      <label>Quando<input name="when" type="datetime-local" min="${min}" required></label>
      <label>Vagas (4 a 12)<input name="capacity" type="number" min="4" max="12" value="6" required></label>
      <label>Descrição (opcional)<textarea name="description" maxlength="300" rows="3"></textarea></label>
      <button class="btn" type="submit">Publicar encontro</button>
    </form>`;
  $('#evBack').onclick = list;
  $('#evForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      const r = await api('POST', '/api/events', { title: f.get('title'), placeType: f.get('placeType'), placeName: f.get('placeName'), startsAt: new Date(f.get('when')).getTime(), capacity: Number(f.get('capacity')), description: f.get('description') });
      toast('Encontro publicado!'); detail(r.event.id);
    } catch (e) { fail(e); }
  };
}

async function detail(id) {
  stop(); current = id;
  const draw = async (keepScroll) => {
    let e;
    try { e = (await api('GET', '/api/events/' + id)).event; } catch (er) { fail(er); return list(); }
    const link = `${location.origin}/e/${e.id}`;
    const msgs = (e.messages || []).map((m) => `<p style="margin:.3rem 0;${m.mine ? 'text-align:right' : ''}"><small class="note">${esc(m.name)}</small><br>${esc(m.body)}</p>`).join('');
    const box = e.joined ? `<h3>Quem vai</h3><p>${e.members.map((m) => esc(m.name) + (m.host ? ' (organiza)' : '')).join(', ')}</p>
      <p><strong>Local:</strong> ${esc(e.placeName || e.placeType)}</p>
      <h3>Chat do grupo</h3><div id="evMsgs" style="max-height:16rem;overflow:auto;border:1px solid var(--line,#ddd);border-radius:.6rem;padding:.5rem">${msgs || '<p class="note">Sem mensagens ainda.</p>'}</div>
      <form id="evSend" style="display:flex;gap:.5rem;margin-top:.5rem"><input name="body" maxlength="500" placeholder="Escreva para o grupo" style="flex:1" required><button class="btn" type="submit">Enviar</button></form>
      <p class="note">Segurança: encontre o grupo em lugar público, avise alguém de confiança e leve seu transporte.</p>` : '<p class="note">Confirme presença para ver o local exato, quem vai e o chat do grupo.</p>';
    const act = e.mine ? '<button class="btn ghost" id="evCancel" type="button">Cancelar encontro</button>' : e.joined ? '<button class="btn ghost" id="evLeave" type="button">Não vou mais</button>' : (e.full || e.status !== 'open' ? '' : '<button class="btn" id="evJoin" type="button">Confirmar presença</button>');
    const y = root().scrollTop;
    root().innerHTML = `<button class="btn ghost" id="evBack" type="button">Voltar</button>
      <h2 style="margin:.6rem 0 .2rem">${esc(e.title)}${e.status === 'cancelled' ? ' (cancelado)' : ''}</h2>
      <p class="note">${esc(fmt(e.startsAt))} · ${esc(e.placeType)} · ${esc(e.city)} · ${e.going}/${e.capacity} confirmados · organiza ${esc(e.hostName)}</p>
      ${e.description ? `<p>${esc(e.description)}</p>` : ''}${act} <button class="btn ghost" id="evShare" type="button">Compartilhar</button>${box}`;
    $('#evBack').onclick = list;
    const run = (sel, fn) => { const b = $(sel); if (b) b.onclick = async () => { try { await fn(); } catch (er) { fail(er); } }; };
    run('#evJoin', async () => { await api('POST', `/api/events/${id}/join`); toast('Presença confirmada!'); draw(); });
    run('#evLeave', async () => { await api('POST', `/api/events/${id}/leave`); list(); });
    run('#evCancel', async () => { if (!window.confirm('Cancelar este encontro para todos?')) return; await api('POST', `/api/events/${id}/cancel`); list(); });
    run('#evShare', async () => {
      const text = `Vem comigo? ${e.title} - ${fmt(e.startsAt)} (${e.city})`;
      if (navigator.share) { try { await navigator.share({ title: e.title, text, url: link }); return; } catch (er) { if (er.name === 'AbortError') return; } }
      window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + link), '_blank', 'noopener');
    });
    const f = $('#evSend');
    if (f) {
      f.onsubmit = async (ev) => { ev.preventDefault(); const inp = f.elements.body; const body = inp.value; try { await api('POST', `/api/events/${id}/messages`, { body }); inp.value = ''; draw(); } catch (er) { fail(er); } };
      const m = $('#evMsgs'); if (m) m.scrollTop = m.scrollHeight;
    }
    root().scrollTop = y;
  };
  await draw();
  detailTimer = setInterval(() => { if (current === id && !document.hidden && root() && !root().hidden && !(document.activeElement && document.activeElement.name === 'body')) draw(); }, 10000);
}

const prevTab = window.PP.onTab, prevUser = window.PP.onUser;
window.PP.onTab = (t) => { if (prevTab) prevTab(t); if (t === 'encontros') { if (skipList) skipList = false; else list(); } else stop(); };
window.PP.onUser = (u) => {
  if (prevUser) prevUser(u);
  if (!u) { stop(); return; }
  const id = new URLSearchParams(location.search).get('evento');
  if (id && /^\d+$/.test(id) && !window.__evOpened) { window.__evOpened = true; history.replaceState(null, '', location.pathname); skipList = true; window.PP.setTab('encontros'); detail(id); }
};
})();
