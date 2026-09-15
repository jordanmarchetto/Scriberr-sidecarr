FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.ui.json vite.config.ts ./
COPY src ./src
COPY ui ./ui
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui-dist ./ui-dist

RUN mkdir -p /app/data /watch/transcripts && chown node:node /app/data /watch/transcripts
USER node

VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.SIDECARR_WEBHOOK_PORT||'8080')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
