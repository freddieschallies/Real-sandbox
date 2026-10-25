# The app in the browser (the office's computers, and phones until the phone app is installed), served
# with the server's API on one web address, with HTTPS from Let's Encrypt (Caddy does it by itself).
# Built from the repository root: docker compose builds it with context ../ (see docker-compose.yml).
FROM node:22-slim AS build
WORKDIR /src
COPY server/src/core ./server/src/core
COPY mobile/package.json mobile/package-lock.json ./mobile/
RUN cd mobile && npm ci --no-audit --no-fund
COPY mobile ./mobile
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN cd mobile && npx expo export --platform web --output-dir dist && node scripts/copy-zxing.mjs dist

FROM caddy:2
COPY --from=build /src/mobile/dist /srv/web
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
