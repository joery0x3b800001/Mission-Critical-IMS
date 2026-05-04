# ─────────────────────────────────────────────────────────────────────────────
# Stage 0 — lockfile
#   Generate package-lock.json inside Docker, no host lockfile needed.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS lockfile

WORKDIR /app

COPY package.json ./

RUN npm install --package-lock-only

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps
#   Install ALL dependencies (including devDeps needed for tsc).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json ./
COPY --from=lockfile /app/package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — builder
#   Compile TypeScript → dist/
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# ✅ package.json must be here so npm run build resolves the script
COPY package.json ./
COPY --from=lockfile /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — prod-deps
#   Re-install only production dependencies.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS prod-deps

WORKDIR /app

COPY package.json ./
COPY --from=lockfile /app/package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — production
#   Minimal runtime image — compiled JS + prod node_modules only.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

RUN addgroup -S ims && adduser -S ims -G ims

WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/dist         ./dist
COPY package.json ./

USER ims

EXPOSE 3001

CMD ["node", "dist/index.js"]
