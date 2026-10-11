# Backend image.
#
# Multi-stage: TypeScript is compiled in the builder, and only the compiled output plus
# production dependencies are copied into the runtime image. This keeps node_modules free
# of the dev toolchain and makes the runtime image much smaller.

FROM node:22-alpine AS builder
WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node:sqlite is a Node builtin, so there is no native module to compile here. That was
# the reason for dropping better-sqlite3; see docs/DECISIONS.md (D-013).
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The SQLite file is written here; docker-compose mounts a named volume at this path.
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/app.db

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]