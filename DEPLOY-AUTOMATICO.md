# Publicação automática: VS Code / Cline -> GitHub -> Render

Fluxo: você (ou o Cline) edita -> `npm test` -> push na branch `main` -> o GitHub roda os testes -> se passarem, a Render publica sozinha.

## Acertos que precisam ser feitos no painel da Render (uma vez, serviço `pertinhos-oficial`)
O painel não é alterado pelo código. Em **Settings**:
1. **Health Check Path:** `/healthz`.
2. **Auto-Deploy:** mude de "On Commit" para **"After CI Checks Pass"**. Assim um envio com teste quebrado não vai ao ar.
3. **Build Command:** `npm ci --include=dev && npm run build` (gera o site minificado, que é o que é servido).
4. **Environment:** confira que existem `NODE_ENV=production`, `TRUST_PROXY=1`, `PAYMENTS_MODE=off`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CPF_PEPPER` (texto longo e aleatório, guarde uma cópia) e `PUBLIC_URL` (o endereço do site). **Sem `CPF_PEPPER` fixo, o segredo do CPF muda a cada reinício.** Não use `DEMO_BOTS`.
5. **Dois serviços:** `pertinhos-demo` e `pertinhos-oficial` publicam o mesmo repositório. Suspenda ou apague o que não usa.

## Plano grátis x usuários reais
- No plano grátis não há disco: cada reinício ou publicação APAGA banco, fotos e contas. O painel ADM mostra um aviso vermelho nessa situação.
- Para usuários reais: plano pago com disco. Use `render.paid.yaml.example` (renomeie para `render.yaml`) e aponte `DATA_DIR=/data`.

## Uma vez só no seu computador
1. Instale no VS Code a extensão **Cline** e configure o modelo e a chave. O arquivo `.clinerules` diz ao Cline as regras do projeto.
2. `git remote -v` deve apontar para `https://github.com/Damacena13/pertinhos.git`.

## No dia a dia
Tarefa do VS Code **Enviar para o GitHub** (Terminal > Executar tarefa): roda os testes, faz commit e push. Acompanhe em Actions (GitHub) e no painel da Render.

## Atenção
- Mantenha `PAYMENTS_MODE=off` até testar o Asaas no sandbox. O modo `demo` é recusado em produção.
- Segredos só no painel da Render, nunca no GitHub.
