FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7865
ENV AI8_CONFIG_PATH=/app/data/config.json
ENV AI8_LOG_PATH=/app/logs/ai8-adapter.log

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY admin ./admin
COPY .env.example ./
COPY README.md ./

RUN mkdir -p /app/data /app/logs

EXPOSE 7865

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:7865/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
