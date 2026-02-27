FROM oven/bun:1.1 AS base
WORKDIR /app

# Copy all package.json files for workspace resolution
COPY package.json bun.lock turbo.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/websocket/package.json ./apps/websocket/package.json
COPY apps/user-frontend/package.json ./apps/user-frontend/package.json
COPY apps/admin-frontend/package.json ./apps/admin-frontend/package.json
COPY apps/tests/package.json ./apps/tests/package.json

# Install all dependencies
RUN bun install --frozen-lockfile

# Copy source code needed for websocket
COPY packages/db ./packages/db
COPY packages/types ./packages/types
COPY apps/websocket ./apps/websocket

# Build
RUN cd apps/websocket && bun run build

EXPOSE 3001
CMD ["bun", "run", "apps/websocket/dist/index.js"]
