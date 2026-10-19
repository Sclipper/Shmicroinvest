# syntax=docker/dockerfile:1
# Shmicroinvest Shmelta Pro – production image.
# Build from the repository root:  docker build -f deploy/Dockerfile -t shmelta:1.0.0 .

# ---- build: the sources are TypeScript run natively by Node 26 -------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@12.0.0
# Dependencies first, so source changes reuse this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile
COPY . .
# release/: server.js (bundled for Node 22+), web/, migrations/, PGlite
RUN pnpm release:bundle

# ---- runtime: plain JavaScript on the Node LTS ----------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app
# Code owned by root (read-only for the app); only /data is writable.
COPY --from=build /src/release/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "server.js"]
