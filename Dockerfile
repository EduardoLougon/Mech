# Build from repo root: docker build -t my-bot .
# Runtime: no network, read-only root (writable /tmp 64MB), 1 CPU, 512MB RAM, uid 65534, map at /arena.
FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json tsconfig.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
