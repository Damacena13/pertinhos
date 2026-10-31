FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
