# SecureWallet web application (Node.js / Express)
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/api').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
