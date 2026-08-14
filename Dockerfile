FROM node:26-trixie-slim AS build
WORKDIR /app

# --ignore-scripts matters: better-sqlite3's install script is `node-gyp rebuild`, which
# would compile from source and drag in python/make/g++. Skipping it leaves the prebuilt
# binary that ships in the tarball, which node-gyp-build picks up at require time.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Fail the build, not production, if that prebuilt binary isn't loadable.
RUN node -e "const D=require('better-sqlite3');new D(':memory:').close();console.log('better-sqlite3 ok')"

FROM node:26-trixie-slim
ENV NODE_ENV=production
WORKDIR /app

ENV DB_PATH=/data/bot.sqlite3
RUN mkdir -p /data && chown node:node /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node

CMD ["node", "dist/index.js"]
