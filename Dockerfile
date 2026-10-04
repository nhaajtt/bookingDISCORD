FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

# The optional web server (payOS webhook, dashboard, metrics) listens on WEB_PORT when it is set
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
