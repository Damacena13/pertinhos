// Verificação do site em navegador real (Chromium via Playwright)
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const APP = '/home/claude/pertinho-app';
const OUT = '/tmp/claude-0/-home-claude/62333f27-3479-5f7f-b960-33ec7094fd9f/scratchpad';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ui-'));
const PORT = 3998, BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_EMAIL: 'admin@teste.com', ADMIN_PASSWORD: 'SenhaAdmin#123', PAYMENTS_MODE: 'demo', REFERRAL_REQUIRE_VERIFIED: '0', DEMO_BOTS: '1', DEMO_AUTOLIKE: '1', NODE_ENV: 'test' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(OUT, 'foto.png'), PNG);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c, extra) => { results.push([n, !!c]); console.log((c ? '  ok    ' : '  FALHOU ') + n + (c ? '' : '  ' + (extra || ''))); };

(async () => {
  spawnSync('node', ['seed-demo.js'], { cwd: APP, env });
  const srv = spawn('node', ['server.js'], { cwd: APP, env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/plans')).ok) break; } catch (e) { /* subindo */ } await sleep(250); }
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('response', (r) => { const u = r.url(); if (/messages|swipe/.test(u)) console.log('   net', r.request().method(), u.replace(BASE, ''), r.status()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

    console.log('\nVisitante');
    await page.goto(BASE + '/');
    await page.waitForSelector('#publicPlans .plan');
    ok('landing carrega com os 3 planos vindos da API', (await page.locator('#publicPlans .plan').count()) === 3);
    ok('radar do hero desenhado', (await page.locator('#heroRadar .dot').count()) === 5);
    await page.screenshot({ path: path.join(OUT, 'ui-1-landing.png') });

    console.log('\nCadastro');
    await page.click('#btnJoin');
    ok('modal de cadastro abre', await page.locator('#regForm').isVisible());
    await page.fill('#rName', 'Helena');
    const y = new Date().getFullYear() - 17;
    await page.fill('#rBirth', `${y}-06-15`);
    await page.fill('#rCpf', '52998224725');
    await page.fill('#rEmail', 'helena@teste.com');
    await page.fill('#rPass', 'senha-forte-123');
    await page.check('#rTerms');
    await page.click('#regForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#rErr').textContent.length > 0);
    ok('menor de 18 anos é barrado na tela', /18 anos/.test(await page.textContent('#rErr')), await page.textContent('#rErr'));
    await page.fill('#rBirth', '1994-06-15');
    await page.selectOption('#rGender', 'f'); await page.selectOption('#rSeeking', 'all');
    await page.selectOption('#rCity', 'sao-jose-do-rio-preto-sp');
    await page.fill('#rBio', 'Gosto de café e de trilha.');
    await page.click('#regForm button[type=submit]');
    await page.waitForSelector('#appView:not([hidden])');
    ok('depois do cadastro entra no app, na aba Perfil', (await page.getAttribute('#t-perfil', 'aria-selected')) === 'true');
    console.log('\nIndicação');
    await page.waitForSelector('#refLink');
    const refLink = await page.inputValue('#refLink');
    ok('painel de indicação mostra o link com código', /\/\?ref=[A-Z0-9]{8}$/.test(refLink), refLink);
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg2 = await ctx2.newPage();
    await pg2.goto(refLink.replace(/^https?:\/\/[^/]+/, BASE));
    await pg2.click('#btnJoin');
    ok('convidado vê o aviso do prêmio e a URL fica limpa', await pg2.locator('#refNote').isVisible() && !/ref=/.test(pg2.url()));
    await pg2.fill('#rName', 'Bruno'); await pg2.fill('#rBirth', '1993-03-10'); await pg2.fill('#rCpf', '39053344705');
    await pg2.fill('#rEmail', 'bruno@teste.com'); await pg2.fill('#rPass', 'senha-forte-123'); await pg2.check('#rTerms');
    await pg2.click('#regForm button[type=submit]'); await pg2.waitForSelector('#t-perfil[aria-selected=true]');
    await pg2.setInputFiles('#pFile', path.join(OUT, 'foto.png')); await pg2.waitForSelector('#pGrid .pitem');
    await sleep(500); await pg2.reload(); await pg2.waitForSelector('#hdrName');
    ok('convidado ganha Plus ao enviar a foto (automático)', /Plus/.test(await pg2.textContent('#planChip')), await pg2.textContent('#planChip'));
    await page.reload(); await page.click('#t-perfil'); await page.waitForSelector('#refLink');
    ok('quem indicou vê o prêmio liberado', /1<\/strong> prêmio|<strong>1<\/strong>/.test(await page.innerHTML('#refPanel')) && /Bruno: Prêmio liberado/.test(await page.textContent('#refPanel')));
    await ctx2.close();

    ok('aviso de foto principal aparece', await page.locator('#appBanner .banner').isVisible());

    console.log('\nFoto de perfil');
    await page.setInputFiles('#pFile', path.join(OUT, 'foto.png'));
    await page.waitForSelector('#pGrid .pimg.main img');
    ok('foto enviada vira a principal e o aviso some', (await page.locator('#appBanner .banner').count()) === 0);
    const imgOk = await page.evaluate(() => new Promise((r) => { const i = document.querySelector('#pGrid .pimg.main img'); if (i.complete) return r(i.naturalWidth > 0); i.onload = () => r(true); i.onerror = () => r(false); }));
    ok('a imagem é realmente carregada pelo navegador (rota protegida com cookie)', imgOk);
    await page.screenshot({ path: path.join(OUT, 'ui-2-perfil.png'), fullPage: true });

    console.log('\nDescobrir');
    await page.click('#t-descobrir');
    await page.waitForSelector('#deck .card');
    ok('mostra cartões de perfis reais da API', (await page.locator('#deck .card').count()) >= 1);
    ok('distância aparece arredondada', /km/.test(await page.textContent('#deck .card:not(.back) .dist')));
    const locked = await page.locator('#deck .card:not(.back) .thumb.lock').count();
    ok('no plano grátis as fotos extras aparecem bloqueadas', locked > 0, 'locked=' + locked);
    await page.screenshot({ path: path.join(OUT, 'ui-3-descobrir.png') });
    await page.click('#deck .card:not(.back) .thumb.lock');
    ok('tocar numa foto bloqueada abre a oferta de plano', await page.locator('#payModal').isVisible());
    await page.click('#pwClose');
    const radiusMax = await page.getAttribute('#fRadius', 'max');
    ok('raio máximo do plano grátis é 10 km', radiusMax === '10', radiusMax);

    console.log('\nMatch e conversa');
    let matched = false;
    for (let i = 0; i < 12 && !matched; i++) {
      if (!(await page.locator('#deck .card').count())) break;
      await page.click('#bLike');
      try { await page.waitForSelector('#matchModal:not([hidden])', { timeout: 1500 }); matched = true; } catch (e) { /* próximo */ }
    }
    ok('curtindo, acontece um match', matched);
    await page.screenshot({ path: path.join(OUT, 'ui-4-match.png') });
    await page.click('#mChat');
    await page.waitForSelector('#cForm');
    await page.fill('#cIn', 'Oi! Tudo bem? <b>teste</b>');
    await page.click('#cForm button[type=submit]');
    await page.waitForSelector('.msg.me');
    ok('mensagem enviada aparece (HTML é exibido como texto, sem executar)', (await page.textContent('.msg.me')).includes('<b>teste</b>') && (await page.locator('.msg.me b').count()) === 0);
    await page.waitForSelector('.msg.them', { timeout: 9000 });
    ok('resposta chega pelo atualizador automático', (await page.locator('.msg.them').count()) >= 1);
    const st = async (l) => console.log('   dbg', l, JSON.stringify(await page.evaluate(() => ({ menuHidden: document.querySelector('#thMenu') && document.querySelector('#thMenu').hidden, sugHidden: document.querySelector('#suggest') && document.querySelector('#suggest').hidden, msgs: document.querySelectorAll('.msg').length }))));
    await st('antes');
    await page.click('#thMenuBtn'); await st('menu aberto');
    await page.click('#thMenu [data-a=place]'); await st('apos place');
    await page.click('#suggest [data-place="Café"]'); await st('apos chip');
    await page.waitForSelector('.msg.place a');
    const href = await page.getAttribute('.msg.place a', 'href');
    ok('sugestão de encontro leva ao Google Maps da cidade', /google\.com\/maps\/search/.test(href) && /Rio%20Preto/.test(href), href);
    await page.screenshot({ path: path.join(OUT, 'ui-5-chat.png') });

    console.log('\nMapa');
    await page.click('#t-mapa');
    await page.waitForSelector('#map .pin');
    ok('mapa desenha pessoas e contagem por raio', (await page.locator('#map .pin').count()) > 0 && (await page.locator('#ringList li').count()) >= 5);
    await page.screenshot({ path: path.join(OUT, 'ui-6-mapa.png') });

    console.log('\nPlanos');
    await page.click('#t-planos');
    await page.click('[data-buy=plus]');
    await page.waitForFunction(() => document.querySelector('#planChip').textContent.includes('Plus'));
    ok('assinar o Plus muda o plano no cabeçalho', true);
    ok('raio sobe para 50 km', (await page.getAttribute('#fRadius', 'max')) === '50');
    await page.click('#t-descobrir');
    await page.waitForFunction(() => document.querySelector('#deck .card:not(.back) .thumb:not(.lock)') || !document.querySelector('#deck .card'));
    const unlocked = await page.locator('#deck .card:not(.back) .thumb:not(.lock)').count();
    ok('com plano pago as fotos extras ficam liberadas', unlocked > 0);
    if (unlocked) { await page.click('#deck .card:not(.back) .thumb:not(.lock)'); await page.waitForSelector('#lbImg img'); ok('galeria abre com a foto real', true); await page.click('#lbClose'); }

    console.log('\nCelular');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(); await page.waitForSelector('#deck .card, #deck .empty');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('sem rolagem horizontal no celular (390 px)', overflow <= 1, 'overflow=' + overflow);
    await page.screenshot({ path: path.join(OUT, 'ui-7-celular.png') });
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log('\nSair e painel ADM');
    await page.click('#t-perfil');
    await page.click('#pLogout');
    await page.waitForSelector('#publicView:not([hidden])');
    ok('sair volta para a página pública', true);
    await page.goto(BASE + '/admin.html');
    await page.waitForSelector('#loginBox:not([hidden])');
    await page.fill('#aEmail', 'helena@teste.com'); await page.fill('#aPass', 'senha-forte-123');
    await page.click('#loginForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#aErr').textContent.length > 0);
    ok('usuária comum não entra no painel ADM', /não tem acesso/.test(await page.textContent('#aErr')));
    await page.fill('#aEmail', 'admin@teste.com'); await page.fill('#aPass', 'SenhaAdmin#123');
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('#panel:not([hidden]) .kpi');
    ok('administrador entra e vê o resumo', (await page.locator('.kpi').count()) === 9);
    await page.click('.adm-tabs [data-s=verificacoes]');
    await page.waitForFunction(() => /Compare a selfie|Nenhum pedido/.test(document.querySelector('#view').textContent));
    ok('aba Verificações abre', /Compare a selfie|Nenhum pedido/.test(await page.textContent('#view')));
    await page.click('.adm-tabs [data-s=convites]');
    await page.waitForSelector('#view .kpis');
    ok('aba Convites mostra a indicação premiada', /Prêmio liberado/.test(await page.textContent('#view')));
    await page.click('.adm-tabs [data-s=resumo]');
    await page.screenshot({ path: path.join(OUT, 'ui-8-admin.png'), fullPage: true });
    await page.click('[data-s=usuarios]');
    await page.waitForSelector('#utable tr.click');
    await page.fill('#uq', 'helena'); await page.click('#ugo');
    await page.waitForFunction(() => document.querySelectorAll('#utable tr.click').length === 1);
    await page.click('#utable tr.click');
    await page.waitForSelector('#umBody .dl');
    await page.screenshot({ path: path.join(OUT, 'ui-9-admin-user.png') });
    await page.fill('#umReason', 'Teste de suspensão');
    await page.click('#umBody [data-a=suspend]');
    await page.waitForFunction(() => document.querySelector('#userModal').hidden);
    await page.waitForFunction(() => /Suspensa/.test(document.querySelector('#utable').textContent));
    ok('administrador suspende um usuário pela tela', true);
    await page.click('[data-s=auditoria]');
    await page.waitForSelector('#view table tbody tr');
    ok('ação aparece na auditoria', /suspend/.test(await page.textContent('#view table')));

    console.log('\nErros do navegador');
    const real = errors.filter((x) => !/ERR_TUNNEL_CONNECTION_FAILED|status of 400/.test(x));
    ok('nenhum erro de console ou de CSP (fontes externas e o 400 do teste de menor são esperados)', real.length === 0, real.join(' | '));
  } catch (e) {
    console.log('ERRO NO ROTEIRO:', e.message.split('\n')[0]);
    try { const pg = browser.contexts()[0].pages()[0]; await pg.screenshot({ path: path.join(OUT, 'ui-fail.png') });
      console.log('DOMmsgs:', await pg.evaluate(() => [...document.querySelectorAll('.msg')].map((x) => x.className + '|' + x.textContent.slice(0, 40))), 'suggestVisible:', await pg.evaluate(() => !document.querySelector('#suggest').hidden)); console.log('tab:', await pg.evaluate(() => document.querySelector('.tab[aria-selected=true]').dataset.tab), '| thread:', (await pg.evaluate(() => document.querySelector('#thread').innerText)).slice(0, 200), '| convs:', (await pg.evaluate(() => document.querySelector('#convs').innerText)).slice(0, 200)); } catch (x) { console.log('dbg', x.message); }
    results.push(['roteiro', false]);
    if (errors.length) console.log(errors.join('\n'));
  } finally {
    await browser.close(); srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  const bad = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - bad} ok, ${bad} falhas`);
  process.exit(bad ? 1 : 0);
})();
