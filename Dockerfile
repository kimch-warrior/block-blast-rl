FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY docker/runtime-package.json ./package.json
COPY public/game ./public/game
COPY app/api/_lib/service.js app/api/_lib/score-migration.js ./app/api/_lib/
COPY server ./server
COPY examples/rl-client.mjs ./examples/rl-client.mjs
COPY scripts/benchmark-rl.mjs ./scripts/benchmark-rl.mjs
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server/index.mjs"]
