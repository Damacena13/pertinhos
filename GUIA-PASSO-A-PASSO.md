# Pertinhos: passo a passo para colocar no ar

Tempo: cerca de 1 hora para ficar no ar; mais 1 a 2 dias para domínio e e-mail propagarem.
Custo aproximado: Fly.io (máquina 1 GB + disco 1 GB) em torno de US$ 6 a 8 por mês; domínio .com.br cerca de R$ 40 por ano; Resend e Cloudflare têm plano grátis. Confira os preços atuais nos sites.

Importante: as páginas da Vercel e da Netlify que você já publicou são só a DEMONSTRAÇÃO (perfis fictícios, pagamento simulado). Para testar com pessoas reais use o sistema deste pacote.

---
## Parte 1. Contas que você vai criar
1. Fly.io (hospedagem): https://fly.io. Pede cartão de crédito.
2. Um domínio, por exemplo no Registro.br (.com.br). Pode ficar para depois: o Fly dá um endereço grátis `https://NOME.fly.dev`.
3. Resend (envio de e-mail): https://resend.com. Plano grátis.
4. Asaas (Pix): https://www.asaas.com. Comece só na conta de testes (sandbox). Só depois, com tudo testado, peça a conta real.

## Parte 2. Instalar a ferramenta do Fly (flyctl)
- Windows (PowerShell): `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`
- Mac: `brew install flyctl`
- Linux: `curl -L https://fly.io/install.sh | sh`

Feche e abra o terminal, depois: `fly auth login` (abre o navegador).

## Parte 3. Preparar o projeto
1. Descompacte `pertinho-app.zip` e entre na pasta: `cd pertinho-app`
2. (Opcional, recomendado) teste no seu computador: `npm ci && npm test` (precisa do Node 22).

## Parte 4. Criar o app no Fly
Rode na pasta do projeto, trocando SEUNOME por algo único (letras minúsculas e hífen):

```
fly launch --no-deploy --copy-config --name pertinhos-SEUNOME --region gru
```
Se perguntar sobre banco de dados, Redis ou deploy agora, responda NÃO. Se perguntar se quer sobrescrever o fly.toml, escolha manter o nosso.

Crie o disco permanente (banco, fotos e segredo ficam nele):
```
fly volumes create pertinho_data --region gru --size 1
```

## Parte 5. Segredos (senhas e chaves)
Gere o segredo do CPF e GUARDE em um lugar seguro (gerenciador de senhas). Se perdê-lo, CPFs já cadastrados deixam de ser reconhecidos como duplicados.
- Mac/Linux: `openssl rand -hex 32`
- Windows (com Node): `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Defina tudo de uma vez (troque os valores):
```
fly secrets set ADMIN_EMAIL="voce@seuemail.com" ADMIN_PASSWORD="uma-senha-longa-e-unica" CPF_PEPPER="O_SEGREDO_GERADO" PUBLIC_URL="https://pertinhos-SEUNOME.fly.dev"
```
Observação: o administrador é criado na primeira vez que o servidor sobe. Depois disso, trocar `ADMIN_PASSWORD` aqui não muda a senha já criada.

## Parte 6. Publicar
```
fly deploy
fly scale count 1
fly status
```
`fly scale count 1` garante uma única máquina (o banco SQLite fica em um disco só). Abra `https://pertinhos-SEUNOME.fly.dev`. Se algo falhar: `fly logs`.

## Parte 7. Entrar no painel administrativo
Vá em `https://pertinhos-SEUNOME.fly.dev/admin.html` e entre com o e-mail e a senha da Parte 5. Abas: Resumo, Usuários, Denúncias, Verificações (selfies), Fotos, Convites, Encontros, Assinaturas, Auditoria.
Faça seu cadastro normal no site com outro e-mail para ver a experiência de usuário.

## Parte 8. E-mail de verdade (Resend)
1. No Resend: Domains, Add Domain, coloque seu domínio. Ele mostra registros DNS (SPF e DKIM). Cadastre-os onde o domínio está registrado e aguarde "Verified".
2. Crie uma API Key (Sending access).
3. No terminal:
```
fly secrets set RESEND_API_KEY="re_..." MAIL_FROM="Pertinhos <contato@seudominio.com>"
```
O Fly reinicia sozinho. A partir daí: novas contas precisam confirmar o e-mail antes de curtir e conversar (contas antigas continuam liberadas), a recuperação de senha chega por e-mail, e os avisos (match, mensagem, lembrete de encontro) passam a ser enviados. Sem domínio verificado o Resend só entrega para o seu próprio e-mail.

## Parte 8b. Conferir CPF na Receita e barrar menores (opcional, recomendado)
Contrate um provedor de consulta de CPF (cobra por consulta) e informe:
```
fly secrets set CPF_LOOKUP_URL="https://api.provedor.com/cpf/{cpf}" CPF_LOOKUP_TOKEN="..." CPF_LOOKUP_NAME_FIELD="nome" CPF_LOOKUP_BIRTH_FIELD="nascimento"
```
Ajuste os nomes dos campos conforme o JSON do provedor. Teste com seu próprio CPF e com um CPF fictício antes de abrir.

## Parte 9. Domínio próprio e HTTPS
1. `fly certs add seudominio.com` e `fly certs add www.seudominio.com`
2. `fly ips list` mostra os endereços (IPv4 e IPv6). No DNS do domínio crie registros A (IPv4) e AAAA (IPv6) apontando para eles. O comando `fly certs show seudominio.com` diz o que falta.
3. Quando o certificado ficar emitido: `fly secrets set PUBLIC_URL="https://seudominio.com"`
4. Opcional: Cloudflare grátis na frente (proteção contra ataques). Se usar, deixe o proxy laranja só depois do certificado do Fly estar emitido e use o modo SSL "Full (strict)".

## Parte 9b. Proteção extra do painel e do site
- Se você acessa o painel sempre de lugares fixos: `fly secrets set ADMIN_ALLOWED_IPS="SEU.IP.AQUI"` (separe vários por vírgula). Pelo celular o IP muda, então só use se tiver IP fixo.
- Use no Cloudflare: Bot Fight Mode ligado, regras de limite de requisições e "Under Attack" se houver ataque.
- Guarde o CPF_PEPPER e a senha do ADM num gerenciador de senhas e ative verificação em duas etapas nas contas do Fly, Resend, Asaas e do domínio.
- Registre a marca "Pertinhos" no INPI.

## Parte 10. Pix (Asaas) só quando tudo estiver testado
1. Crie a conta no Asaas, gere a chave de API do SANDBOX.
2. `fly secrets set ASAAS_API_KEY="..." ASAAS_WEBHOOK_TOKEN="um-token-longo-diferente-da-chave" ASAAS_ENV="sandbox" PAYMENTS_MODE="asaas"`
3. No painel do Asaas (sandbox) cadastre o webhook: URL `https://seudominio.com/api/webhooks/asaas` e o mesmo token.
4. Teste uma assinatura Pix pelo site e confira em Assinaturas no painel ADM.
5. Só depois peça a conta real, troque a chave por a de produção e `ASAAS_ENV="production"`.
Até lá deixe `PAYMENTS_MODE=off` (já é o padrão do fly.toml).

## Parte 11. Cópias de segurança
- O Fly tira cópias (snapshots) diárias do disco e guarda por alguns dias. Veja com `fly volumes snapshots list`. Confira a política atual na documentação do Fly.
- Guarde também uma cópia sua: `fly ssh sftp shell` e depois `get /data/pertinho.db`, `get /data/pertinho.db-wal` e `get /data/pertinho.db-shm` (os três arquivos juntos). Faça isso de vez em quando e guarde também o CPF_PEPPER.

## Parte 12. Atualizar o site depois
Altere os arquivos e rode `fly deploy` de novo. Os dados ficam no disco e não são apagados.

---
## Parte 13. Piloto com pessoas reais (a parte que faz o site viralizar)
Não abra para o Brasil inteiro de uma vez. Um site de encontros só funciona quando há gente suficiente perto.
1. Escolha UMA cidade (a sua). Meta: 50 a 100 pessoas cadastradas, equilibrando homens e mulheres o máximo possível.
2. Convide primeiro quem você conhece: amigos, colegas, grupos de WhatsApp, faculdade, academia. Peça que cada um use o link de convite do Perfil (a indicação é automática).
3. Combine 1 ou 2 Encontros em grupo (café, parque) na primeira semana e divulgue o link `/e/NUMERO`: ele gera prévia bonita no WhatsApp e Instagram.
4. Todo dia: abra o painel, aprove as selfies na aba Verificações (a recompensa da indicação só sai depois disso) e olhe Denúncias.
5. Pergunte a cada pessoa: foi fácil cadastrar? Achou alguém perto? Sentiu segurança? Corrija o que repetir.
6. Só expanda para a próxima cidade quando a primeira tiver conversas e encontros acontecendo.

## Lista de teste antes de convidar o primeiro estranho
- Cadastro com CPF válido funciona; o mesmo CPF não cadastra duas vezes.
- Chega o e-mail de confirmação (olhe também o spam) e o link funciona.
- Subir foto, enviar selfie, você aprova no painel, selo aparece.
- Dar match entre duas contas suas, trocar mensagens, receber o e-mail de match.
- Criar um encontro, entrar com outra conta, ver o chat do grupo.
- Esqueci a senha pelo e-mail.
- Denunciar e bloquear; ver a denúncia no painel.
- Abrir pelo celular e usar "Adicionar à tela inicial".
- Termos e Privacidade abrem e dizem o que realmente fazemos.

## O que este pacote NÃO resolve sozinho (seja honesto com seus usuários)
- CPF válido só confere a conta matemática do número; não prova que a pessoa é dona dele. A selfie aprovada por você é a prova real.
- Para operar de verdade e tratar CPF, selfies e dados de localização você é responsável pela LGPD. Revise Termos e Privacidade com um advogado antes de escalar.
- Moderação é humana: quem cuida das denúncias e selfies é você (ou alguém de confiança), todo dia.
- O envio real de e-mail, a hospedagem no Fly e o Pix do Asaas não foram testados por mim no ambiente real (só com simulações); use a lista acima na sua primeira publicação.
