# ---- dependencies ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
# --ignore-scripts skips the postinstall `prisma generate` which needs
# prisma/schema.prisma — not available in this layer. The builder stage
# runs `prisma generate` explicitly once all source files are present.
RUN npm ci --ignore-scripts

# ---- builder ----
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client (no DB connection needed at this stage)
RUN npx prisma generate

# Provide dummy env vars so Next.js can analyse routes without a live DB.
# Real secrets are injected at runtime via `docker run -e`.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="mysql://build:build@127.0.0.1:3306/build" \
    NEXTAUTH_SECRET="build-placeholder" \
    NEXTAUTH_URL="http://localhost:3000"

RUN npm run build

# ---- runner ----
FROM node:20-slim AS runner
WORKDIR /app
# Commit SHA baked in at build time (CI passes --build-arg GIT_SHA), surfaced
# in the UI footer so a running deployment can be traced back to its commit.
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    GIT_SHA=$GIT_SHA

# OpenSSL is required by the Prisma schema engine (used at runtime for `prisma db push`)
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
# Prisma schema + engine needed for `prisma db push` and runtime queries
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["npm", "start"]
