FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Minifica o JavaScript do site e remove o código-fonte legível, os testes e os utilitários de desenvolvimento
RUN node build-public.js && rm -rf public && npm prune --omit=dev
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
