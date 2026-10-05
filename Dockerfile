# Mock-mode image for the internal-llm-router (order F11-docker; docs/DOCKER.md).
#
# For local demos and UI work only. MOCK_MODE=1 short-circuits assertConfig() in
# src/config.ts (src/mock.ts answers instead of a provider), so this image starts with
# zero secrets, no GPU and no jcode. Real agent runs need the host's jcode, Laya and
# provider keys, none of which exist here.
#
#   docker build -t internal-llm-router:local .
#   docker run --rm -p 8787:8787 -e HOST=0.0.0.0 -e COMPANY_AUTH_TOKEN=<local placeholder> internal-llm-router:local
#
# Preferred: `docker compose up --build` (docker-compose.yml sets those two vars).
# No .env or key is ever copied in: .dockerignore keeps them out of the build context.

FROM node:24-slim AS build
WORKDIR /app
# Package files first so a source-only edit reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    MOCK_MODE=1 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# src/server.ts serves the dashboard from <cwd>/public.
COPY public ./public
# company/ and logs/ are named volumes in docker-compose.yml. Create them here and chown
# /app so a fresh volume is owned by `node` (volume copy-up keeps that ownership).
RUN mkdir -p /app/company /app/logs && chown -R node:node /app
USER node
EXPOSE 8787
# HOST is deliberately unset: config.host defaults to 127.0.0.1, which published ports
# cannot reach, while assertConfig() refuses HOST=0.0.0.0 without COMPANY_AUTH_TOKEN.
# docker-compose.yml sets both to a throwaway local value.
CMD ["node", "dist/server.js"]
