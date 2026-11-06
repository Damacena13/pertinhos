# Publicação automática: VS Code / Cline -> GitHub -> Render

Fluxo: você (ou o Cline) edita -> `npm test` -> push na branch `main` -> o GitHub roda os testes -> se passarem, a Render publica sozinha.

## Uma vez só
1. Instale no VS Code a extensão **Cline** (o VS Code já sugere ao abrir a pasta). Na configuração dela, escolha o modelo e cole a sua chave de API. O arquivo `.clinerules` já diz ao Cline as regras do projeto.
2. No terminal da pasta do projeto: `git init`, `git add -A`, `git commit -m "primeira versão"`, `git branch -M main`, `git remote add origin https://github.com/Damacena13/pertinhos.git`, `git push -u origin main`. Confira antes que `.env` e `data/` NÃO aparecem em `git status` (o `.gitignore` já os exclui).
3. Na Render: **New > Blueprint**, escolha o repositório. Ela lê o `render.yaml`. Preencha ADMIN_EMAIL, ADMIN_PASSWORD e PUBLIC_URL (os segredos ficam só no painel).
4. A primeira publicação leva alguns minutos. Abra a URL e entre como administrador.

## No dia a dia
Mude o código (você ou o Cline), rode a tarefa **Enviar para o GitHub** (Terminal > Executar tarefa). Ela roda os testes, faz commit e push. Veja o andamento na aba Actions do GitHub e no painel da Render.

## Atenção
- Disco permanente na Render só existe em plano pago. Sem ele, cada publicação APAGA banco, fotos e o segredo do CPF. Não use o plano grátis com usuários reais.
- Mantenha PAYMENTS_MODE=off até testar o Asaas no sandbox.
- Se a Render deixar de publicar depois de um teste falhar, é o esperado: corrija e envie de novo.
