# ── Stage 1: Build frontend ────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend ─────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install

COPY backend/ ./
RUN npm run build

# ── Stage 3: Production image ──────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production
WORKDIR /app

# Copy backend production dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy compiled backend
COPY --from=backend-builder /app/backend/dist ./dist

# Copy built frontend into the path server.ts serves from
COPY --from=frontend-builder /app/frontend/dist ./public

EXPOSE 8080

CMD ["node", "dist/server.js"]
