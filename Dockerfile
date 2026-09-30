# The hosted server of docs/14: `npm run server:start`, as an image. Only the server; local play
# (`npm run play:local`) runs on the host and never needs this.
#
# There is no build step. The server runs its TypeScript through Node's type stripping, which is
# why the base is Node 24 (22.6 is the floor). It imports the purposes from `agent/` and some prose
# helpers from `engine/`, so those travel with it (docs/14 §4.3).

FROM node:24-slim

WORKDIR /app

# `--ignore-scripts` skips `prepare`, which points git at `.githooks` and fails where there is no
# git. `--omit=dev` still installs the frontend's libraries, which sit under `dependencies`; the
# server never loads them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY agent ./agent
COPY engine ./engine

# Secrets arrive as environment at run time, never in the image: `.dockerignore` keeps every
# `.env*` file out of the build context.
ENV NODE_ENV=production \
    HOSTED=1 \
    MODEL_PROXY_PORT=3001

USER node
EXPOSE 3001

# `GET /health` needs no token, and is 503 while the server has no database.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Node directly rather than `npm run server:start`, so the stop signal reaches the server.
CMD ["node", "--experimental-strip-types", "server/index.ts"]
