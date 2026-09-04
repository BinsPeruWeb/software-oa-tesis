FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY apps/api/package.json apps/api/tsconfig.json apps/api/nest-cli.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
RUN npm ci
RUN npm run build -w @oa/contracts && npm run build -w @oa/web && npm run build -w @oa/api

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
RUN npm ci --omit=dev --workspace @oa/api --include-workspace-root=false
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/web/dist ./apps/api/public
COPY apps/api/migrations ./apps/api/migrations
RUN useradd --create-home --uid 10001 oa && mkdir -p /data/assets && chown -R oa:oa /app /data/assets
USER oa
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
