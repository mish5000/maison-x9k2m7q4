# Auralis production image.
#
# Two stages. The first installs every dependency and builds all three
# packages; the second starts clean and installs production dependencies only,
# so the build toolchain never ships. The result runs one process: the Fastify
# API, serving the built client from the same origin.
#
# Node 22.6 is the floor — node:sqlite and the --experimental-sqlite flag are
# what remove the need for a database server.

# ---------------------------------------------------------------- build stage
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, so a change to source does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/ packages/

RUN npm run build

# -------------------------------------------------------------- runtime stage
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# --omit=dev drops TypeScript, Vite, Vitest and Playwright. The workspace
# symlinks under node_modules/@auralis are recreated here, which is what lets
# the server resolve @auralis/core at runtime.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# The API serves the built client from its own origin, so there is one port and
# no CORS surface. The database lives in a directory intended to be a volume.
ENV AURALIS_HOST=0.0.0.0 \
    AURALIS_PORT=8080 \
    AURALIS_SERVE_WEB=true \
    AURALIS_WEB_DIST=packages/web/dist \
    AURALIS_DATABASE_PATH=/data/auralis.db

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# The process exits non-zero on a configuration error (EX_CONFIG, 78), so a
# missing AURALIS_SECRET_KEY fails the deploy rather than starting degraded.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AURALIS_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "packages/server/dist/main.js"]
