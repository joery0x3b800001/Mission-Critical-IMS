# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — deps
#   Install all dependencies (Vite, TypeScript, Tailwind are devDeps but
#   required for the build step).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — builder
#   Run `tsc && vite build` to emit static assets into dist/.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# ✅ package.json must be here so npm run build resolves the script
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src

RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — production
#   Serve compiled static assets with nginx (~25 MB, no Node at runtime).
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS production

RUN rm /etc/nginx/conf.d/default.conf

RUN printf 'server {\n\
    listen 3000;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
\n\
    location ~* \\.(js|css|woff2?|png|jpg|svg|ico)$ {\n\
        expires 1y;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
\n\
    location = /index.html {\n\
        add_header Cache-Control "no-cache, no-store, must-revalidate";\n\
    }\n\
\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;\n\
    gzip_min_length 1024;\n\
}\n' > /etc/nginx/conf.d/ims.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]