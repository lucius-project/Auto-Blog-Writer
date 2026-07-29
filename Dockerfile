# Automated Blog Writer — one build, three service targets (api / worker / web).
FROM node:20-bookworm-slim AS base
# openssl before prisma generate — engine detection needs it (else it picks 1.1.x and fails at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate
COPY . .

# ---- API ------------------------------------------------------------------
FROM base AS api
WORKDIR /app/apps/api
EXPOSE 3101
CMD ["sh", "-c", "npx prisma migrate deploy --schema /app/prisma/schema.prisma && npx tsx src/server.ts"]

# ---- Worker (BullMQ + headless Playwright publishing) ---------------------
FROM base AS worker
RUN npx playwright install --with-deps chromium
WORKDIR /app/apps/worker
CMD ["npx", "tsx", "src/index.ts"]

# ---- Web (Next.js) --------------------------------------------------------
FROM base AS web
WORKDIR /app/apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:3101
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build
EXPOSE 3100
CMD ["npm", "run", "start"]
