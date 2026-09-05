FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY samples ./samples
COPY scripts ./scripts
# データは永続ディスク（/data）に置く
ENV DB_PATH=/data/app.db
ENV PORT=3000
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/auth/status >/dev/null || exit 1
CMD ["node", "server/index.js"]
