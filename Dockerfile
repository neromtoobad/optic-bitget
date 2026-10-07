# OPTIC — Railway deploy image
# node:22-bookworm has glibc prebuilds for better-sqlite3, @resvg/resvg-js and sharp.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production


COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY src ./src
# runtime assets: card fonts (read from cwd) + fixtures (CLI fallbacks) + the site
COPY assets ./assets
COPY fixtures ./fixtures
COPY site-bitget ./site-bitget

# download (and so a render can never fail on a missing browser at runtime).

EXPOSE 3000
CMD ["node", "dist/server.js"]
