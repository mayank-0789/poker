FROM oven/bun:1.1 AS base
WORKDIR /app

# Copy workspace config
COPY package.json bun.lock turbo.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY apps/websocket/package.json ./apps/websocket/package.json

# Install all dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/websocket ./apps/websocket

# Build
RUN cd apps/websocket && bun run build

EXPOSE 3001
CMD ["bun", "run", "apps/websocket/dist/index.js"]
