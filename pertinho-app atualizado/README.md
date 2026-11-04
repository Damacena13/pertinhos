# Pertinho

Site de relacionamento por proximidade: cadastro com login, fotos (principal pública, extras só para planos pagos), descoberta por raio de distância, matches, chat, bloqueio e denúncia, planos e painel de administração.

Tecnologia: Node.js 22.5 ou mais novo, Express, SQLite embutido no Node (arquivo único, nada para compilar) e Sharp (tratamento de fotos). O site é HTML, CSS e JavaScript puros, servido pelo próprio servidor.

## Rodar no seu computador

```bash
npm install
npm run seed:demo      # opcional: cria 47 perfis FICTÍCIOS para testar
npm run dev            # liga o modo de demonstração (pagamentos simulados e perfis que respondem)
```

Abra http://localhost:3000.

Na primeira execução o servidor cria a conta de administrador e mostra a senha no terminal (anote, ela aparece uma vez). Para escolher você mesmo:

```bash
ADMIN_EMAIL=voce@seudominio.com ADMIN_PASSWORD='uma-senha-longa' npm run dev
```

O painel fica em **/admin.html**.

## Testes

```bash
npm test
```

Sobe o servidor com um banco temporário e percorre o fluxo pela API: cadastro, login, fotos, planos, curtidas, matches, chat, bloqueio, denúncia, painel ADM e LGPD, incluindo tentativas de burlar o sistema (ler conversa alheia, ver foto bloqueada, usar o ADM sem permissão).

## Publicar de verdade

O sistema precisa de um servidor Node com **disco persistente**, porque guarda o banco e as fotos em arquivos (pasta definida em `DATA_DIR`). Hospedagem só de arquivos estáticos (Netlify, GitHub Pages) **não serve**.

### Opção A: Render, Railway ou Fly.io

1. Envie esta pasta para um repositório no GitHub (a pasta `node_modules` e `data` ficam de fora, o `.gitignore` já cuida disso).
2. Crie um serviço web apontando para o repositório. Comando de build: `npm install`. Comando de início: `npm start`.
3. Adicione um **disco persistente** (por exemplo montado em `/data`) e defina as variáveis abaixo.
4. Aponte seu domínio para o serviço. O HTTPS é automático nesses provedores.

Neste repositório, `render.yaml` na raiz configura o Render no plano grátis para esta pasta. **É apenas para demonstração:** o serviço gratuito não tem disco persistente e pode dormir; o banco, as contas e as fotos em `/tmp` podem ser apagados ao reiniciar ou substituir a instância. Não use para guardar dados reais. Ao criar/sincronizar, informe `ADMIN_EMAIL`, `ADMIN_PASSWORD` e `CPF_PEPPER` como variáveis secretas no Render. Para produção, use um plano com disco persistente montado em `/data` e defina `DATA_DIR=/data`.

### Opção B: VPS própria (Ubuntu)

```bash
# Node 22.5+ instalado
git clone <seu repositório> pertinho && cd pertinho
npm install --omit=dev
export NODE_ENV=production PORT=3000 DATA_DIR=/var/pertinho \
       ADMIN_EMAIL=voce@seudominio.com ADMIN_PASSWORD='uma-senha-longa' TRUST_PROXY=1
npm start
```

Use o `pm2` ou um serviço do `systemd` para manter rodando e o **Caddy** ou Nginx na frente para ter HTTPS (o cookie de login só funciona com HTTPS em produção). Com o Caddy, o arquivo `Caddyfile` fica assim:

```
seudominio.com {
    reverse_proxy localhost:3000
}
```

### Variáveis de ambiente

| Variável | Para que serve |
|---|---|
| `NODE_ENV=production` | Liga o cookie seguro (exige HTTPS) e o cache dos arquivos. |
| `PORT` | Porta do servidor (padrão 3000). |
| `DATA_DIR` | Pasta do banco e das fotos. **Precisa estar em disco persistente.** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Conta de administrador criada na primeira execução. |
| `TRUST_PROXY=1` | Obrigatório atrás de Render, Railway, Caddy ou Nginx, para o limite de tentativas enxergar o IP real. |
| `COOKIE_SECURE=0` | Só para testar produção sem HTTPS. Não use no ar. |
| `PAYMENTS_MODE` | `off` (padrão, seguro) ou `demo`. Veja a seção de pagamentos. |
| `DEMO_BOTS`, `DEMO_AUTOLIKE` | Só para demonstração: perfis fictícios respondem e retribuem curtidas. Não use em produção. |

### Backup

Copie a pasta `DATA_DIR` inteira (banco `pertinho.db` e a pasta `uploads`) com o servidor parado, ou use o comando `sqlite3 pertinho.db ".backup copia.db"` para o banco.

## Pagamentos

**Os pagamentos reais ainda não estão integrados.** Existem dois modos:

- `PAYMENTS_MODE=off` (padrão): os botões de assinatura ficam desligados. Você concede planos manualmente no painel ADM, na ficha do usuário.
- `PAYMENTS_MODE=demo`: qualquer pessoa "assina" sem pagar. Serve só para testar a experiência. **Nunca use no ar.**

Para cobrar de verdade é preciso contratar um gateway (Mercado Pago, Stripe, Pagar.me ou Asaas), criar o checkout e receber o aviso de pagamento por webhook para ativar o plano. O ponto de entrada é a rota `POST /api/billing/checkout` em `server.js`; a ativação do plano é a atualização das colunas `plan` e `plan_until` da tabela `users`.

## O que o painel ADM faz

Resumo (usuários, ativos, cadastros por dia, receita recorrente, cidades), busca de usuários, ficha completa com atividade, suspender ou reativar, verificar perfil, conceder plano manualmente, fila de denúncias (dispensar, advertir ou suspender), moderação de fotos, lista de assinaturas e registro de auditoria de todas as ações dos administradores.

## Segurança já implementada

- Senhas com scrypt e sessões revogáveis no banco; suspensão derruba a sessão na hora.
- Proteção contra CSRF (cookie SameSite + cabeçalho exigido nas escritas).
- Limite de tentativas no login e cadastro, nas mensagens e nos envios de foto.
- Cabeçalhos de segurança e política de conteúdo (CSP) que só permite scripts do próprio site.
- Fotos reprocessadas no servidor: tipo conferido pelo conteúdo, metadados (inclusive GPS) removidos, tamanho limitado. Acesso só com login; fotos extras só para planos pagos, conferido no servidor.
- Localização guardada em grade de cerca de 500 m; a API nunca devolve coordenadas, e-mail ou data de nascimento de outras pessoas, apenas distância arredondada.
- Cada conversa só é acessível pelos dois participantes; ações de administrador só para administradores.
- LGPD: o usuário baixa seus dados e apaga a conta com a própria senha.

## O que ainda falta antes de abrir ao público

1. **Revisão jurídica** de `public/termos.html` e `public/privacidade.html` (são modelos) e dados da empresa.
2. **Confirmação de e-mail e recuperação de senha.** Exigem um serviço de e-mail (Resend, SendGrid, Amazon SES). Hoje quem esquece a senha não consegue recuperar.
3. **Pagamentos reais** (seção acima).
4. **Verificação de identidade.** Hoje o selo "verificado" é concedido manualmente pelo administrador. Para automatizar, é preciso um serviço de prova de vida e documento.
5. **Moderação de imagens** (detecção automática de nudez), se esperar volume alto de fotos.
6. **Chat em tempo real e notificações.** O chat atualiza a cada 4 segundos. Para escala maior, troque por WebSocket e adicione notificações por e-mail ou push.
7. **Escala.** SQLite atende bem milhares de usuários em um servidor. Para dezenas de milhares ou mais de um servidor, migre para PostgreSQL e guarde as fotos em armazenamento de objetos (S3, Cloudflare R2).
8. **Mapa e localização.** O mapa é esquemático e os locais de encontro abrem a busca no Google Maps. Para um mapa real com pins de lugares, use a API do Google Maps ou do Mapbox (exige chave).


## Cadastro só com CPF válido

- O cadastro (`POST /api/auth/register`) exige `cpf` com dígitos verificadores corretos (aceita com ou sem pontuação) e recusa sequências repetidas.
- Um CPF só pode ter uma conta (índice único). Repetido devolve 409.
- O número **não é guardado**: o banco recebe um HMAC-SHA256 com o segredo `CPF_PEPPER` (`cpf_hash`) e os 2 últimos dígitos (`cpf_last2`) para o usuário reconhecer o cadastro. Sem `CPF_PEPPER`, o servidor gera um e salva em `DATA_DIR/cpf.pepper`. Em produção, defina a variável e faça backup dela.
- **Limite importante:** conferir o dígito verificador prova que o número é matematicamente válido e ainda não usado aqui, mas **não prova que o CPF é da pessoa**. Para isso é preciso uma consulta a um provedor de validação de identidade (por exemplo, serviços de validação biométrica/cadastral contratados). Isso exige contrato e fica fora deste pacote. Idade também não sai do CPF: ela vem da data de nascimento informada.
- `AUTH_RATE_LIMIT` (padrão 20 por 15 min) ajusta o limite das rotas de login e cadastro.

## Pix com Asaas: checklist para ir ao ar

1. Crie a conta no Asaas, gere a chave de **sandbox** e rode tudo em `ASAAS_ENV=sandbox` primeiro.
2. Defina `PAYMENTS_MODE=asaas`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` (token longo e diferente da chave).
3. No painel do Asaas, cadastre o webhook apontando para `https://SEU-DOMINIO/api/webhooks/asaas` com o mesmo token, marcando os eventos de cobrança (recebida, confirmada, estornada, vencida).
4. Pague uma cobrança de teste no sandbox e confira: o plano ativa, o pagamento aparece no painel ADM e repetir o webhook não ativa duas vezes.
5. Só então troque para a chave de produção e `ASAAS_ENV=production`.
6. O servidor sempre consulta o pagamento no Asaas antes de liberar o plano; um webhook falso não libera nada.

Testado aqui contra um Asaas simulado (`mock-asaas.js`, 38 verificações). Nunca testado contra o Asaas de verdade: isso depende das suas chaves de sandbox. Os status assumidos são RECEIVED e CONFIRMED como pago e REFUNDED como estorno.


## Indicação automática

Cada conta tem um código (`GET /api/me/referral` devolve código, link e contadores) e o painel aparece na aba Perfil. Fluxo, sem ninguém aprovar nada:

1. O amigo abre `https://seusite/?ref=CODIGO`. O código fica guardado no navegador e vai junto no cadastro (`ref`). Código inválido nunca impede o cadastro.
2. O cadastro cria uma indicação **pendente**. Cadastrar sozinho não vale nada.
3. Quando o amigo envia a **primeira foto**, o servidor ativa a indicação: o amigo ganha 3 dias de Plus; quem indicou ganha um Destaque de 30 min e, a cada 3 indicações válidas, 7 dias de Plus.
4. Quem já paga tem o plano estendido. Quem não paga recebe um Plus promocional (sem cobrança de renovação e fora da receita no painel ADM).

Travas: CPF único por conta, sem auto-indicação, no máximo 2 prêmios por rede (mesmo IP) por quem indica, teto de 30 prêmios e 50 pendentes por pessoa, indicador suspenso não paga. Os números ficam em `RULES`, no topo de `referrals.js`. O painel ADM tem a lista em `GET /api/admin/referrals`. Atrás de proxy, defina `TRUST_PROXY` para o IP real ser considerado.

Limite: a trava por IP não pega quem usa redes diferentes; o CPF único e a exigência da foto é que seguram a maior parte do abuso. Para ir além, exija verificação por selfie antes do prêmio.


## Teste com pessoas reais (roteiro)

O que é real neste sistema: cadastro com CPF válido e único, fotos, descoberta por distância, curtidas, matches, conversas, bloqueio e denúncia, verificação por selfie revisada por você, planos, indicação automática, painel ADM e os alertas de segurança.

1. **Hospede o servidor** (Fly.io, veja `fly.toml`). Vercel e Netlify não servem para isto: não têm disco permanente para o banco e as fotos. A página de demonstração (arquivo único) mostra perfis fictícios e pagamento simulado: não use com pessoas reais.
2. **Não rode `seed-demo.js` e não defina `DEMO_BOTS`**. Sem isso só aparecem pessoas de verdade. Com poucas pessoas, cadastrem-se todas na **mesma cidade** e com o raio aberto, senão a descoberta fica vazia.
3. **Ligue o e-mail** (`RESEND_API_KEY` e `MAIL_FROM`, domínio verificado no Resend). Com ele, todo cadastro precisa confirmar o e-mail: antes disso a pessoa não aparece para os outros, não curte e não conversa, e o prêmio de indicação não sai. Sem ele nada fica bloqueado e o ADM gera o link de nova senha.
4. **Pagamentos:** deixe `PAYMENTS_MODE=off` até testar o Asaas no sandbox. Para dar Plus a testadores, use o painel ADM (Usuários, abrir a pessoa, "Definir plano"): concessão manual conta como cortesia e fica fora da receita.
5. **Painel ADM:** entre em `/admin.html` com `ADMIN_EMAIL` e `ADMIN_PASSWORD`. Abas: Resumo, Usuários (suspender, verificar, definir plano, link de nova senha), Denúncias, Verificações (aprove ou recuse as selfies: sem isso ninguém ganha o selo), Fotos, Convites, Assinaturas e Auditoria.
6. Cada testador deve poder: criar conta, confirmar o e-mail, enviar foto, curtir, dar match, conversar, bloquear, denunciar, pedir verificação e baixar/apagar os próprios dados.

O código do servidor nunca é entregue pelo site (há teste automático para isso). O código do navegador (HTML, CSS e JS da tela) sempre pode ser visto por quem abrir as ferramentas do navegador: isso não tem como esconder, e por isso nenhuma regra importante fica lá. Regras, preços, CPF e prêmios são decididos no servidor.

## Encontros em grupo
Aba "Encontros": grupos de 4 a 12 pessoas da mesma cidade, em lugar público (café, praça, parque, livraria, sorveteria, shopping). Regras no servidor (`events.js`): precisa de foto e (com e-mail ligado) e-mail confirmado; marcar com 2 h a 14 dias de antecedência; no máximo 2 encontros abertos como organizador e 5 confirmados; bloqueios valem. O nome do local e o chat do grupo só aparecem para quem confirmou presença. O painel ADM tem a aba "Encontros" para cancelar qualquer um. Link público `/e/ID` mostra só título, tipo de local, cidade e horário (para prévia no WhatsApp).

## Avisos por e-mail
Com `RESEND_API_KEY`, `MAIL_FROM` e `PUBLIC_URL` definidos: aviso de novo match, de mensagem (só se a pessoa está offline há 15 min, no máximo 1 a cada 6 h por conversa, sem o texto da mensagem) e lembrete 3 h antes do encontro. Cada e-mail tem link de descadastro assinado; a pessoa também liga/desliga em Perfil. Sem `PUBLIC_URL` nenhum aviso é enviado (evita links com endereço falso).

## Indicação exige selfie verificada
Por padrão o prêmio da indicação só sai quando o indicado tem foto, e-mail confirmado (se ligado) **e selfie aprovada** no painel. Para desligar: `REFERRAL_REQUIRE_VERIFIED=0`.

## Modelo de receita e chat livre
O chat entre matches é ilimitado e grátis (mantém as pessoas ativas e convidando amigos). Compras avulsas, sem assinatura:
- **Destaque 30 min** R$ 9,90 e **pacote de 3 Destaques (90 min)** R$ 24,90: o perfil aparece primeiro por perto.
- **Passe 24h** R$ 6,90: por 24 horas manda a primeira mensagem para até 15 pessoas sem esperar match. A outra pessoa vê um "pedido de conversa": aceita respondendo (vira conversa normal) ou recusa (o pedido some e quem enviou não consegue mandar de novo). Quem enviou só pode mandar 1 mensagem até a resposta. Bloqueios valem.
- **Fotos extras**: 3 desbloqueios R$ 7,90 ou 10 desbloqueios R$ 19,90 (para sempre, por perfil).
Assinaturas (Plus/Premium) dão raio de 50/100 km, modo invisível, curtidas ilimitadas etc. Preços ficam em `lib.js` (SHOP e PLANS). Se definir `FREE_CHAT_MESSAGES=N`, o chat entre matches passa a ter N mensagens grátis por match (não recomendado neste modelo).

## Conferência do CPF na base da Receita (idade oficial)
Sem configuração, o cadastro só confere os dígitos do CPF. Para conferir nome e data de nascimento em base oficial, contrate um provedor de consulta de CPF (não existe consulta pública gratuita; exemplos: Serpro, Infosimples, BigDataCorp, Direct Data) e defina `CPF_LOOKUP_URL` (com `{cpf}` no lugar do número), `CPF_LOOKUP_TOKEN` e os nomes dos campos do JSON (`CPF_LOOKUP_NAME_FIELD`, `CPF_LOOKUP_BIRTH_FIELD`, `CPF_LOOKUP_STATUS_FIELD`). Veja `cpfcheck.js`. Com isso ligado: CPF inexistente, cancelado/nulo/de falecido é recusado; nome e nascimento digitados precisam bater (a mensagem não diz qual campo errou); quem é menor pela base oficial é barrado mesmo digitando outra data (fica no registro de auditoria só com os 2 últimos dígitos); a data salva é a oficial. Se o provedor cair, o cadastro espera (503); `CPF_LOOKUP_REQUIRED=0` libera só com a validação matemática. Os dados oficiais NÃO são mostrados na tela nem preenchidos no formulário: senão qualquer pessoa digitaria o CPF de um desconhecido e leria nome e nascimento dele. O formato exato do JSON de cada provedor não foi testado com serviço real, só com um provedor simulado.

## Segurança reforçada e proteção contra cópia
Já embutido: bloqueio de ferramentas de raspagem conhecidas na API (`BOT_BLOCK=0` desliga), limite por usuário de buscas/radar (`SCRAPE_LIMIT`, padrão 150 por 10 min) e de fotos (`PHOTO_LIMIT`, padrão 600 por 10 min), recusa de foto embutida em outros sites (hotlink), bloqueio de 15 min após 6 senhas erradas (por e-mail + IP), dados pessoais com `Cache-Control: no-store`, Permissions-Policy, CSP só com scripts do próprio site, CPF guardado só como resumo HMAC. Opcional: `ADMIN_ALLOWED_IPS=1.2.3.4,5.6.7.8` faz o painel ADM e o login de administrador só funcionarem desses IPs.
No deploy (Dockerfile) o JavaScript é minificado/embaralhado (`npm run build` gera `public-dist`) e o código legível do site não vai na imagem.
**Limite honesto:** tudo o que o navegador baixa (HTML, CSS, JavaScript) pode ser visto e copiado por quem quiser: nenhuma tecnologia impede isso. O que protege o negócio é (1) o servidor (banco, regras, pagamentos e e-mails) nunca ser entregue, (2) os dados das pessoas estarem protegidos por login e limites, (3) os Termos proibirem cópia e raspagem, e (4) a comunidade e a marca. Peça registro da marca no INPI.
