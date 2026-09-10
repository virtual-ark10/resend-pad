# Email pad - containerised pad-kit (brand-agnostic, zero npm dependencies).
#
# The kit has ZERO npm dependencies (plain node:http), so there is no install
# step: copy four files and run. config.json and .env are deliberately NOT
# baked in — they are mounted/passed at run time so a new VPS only needs the
# image plus those two files.
FROM node:22-alpine

# tzdata so log timestamps can be localised; busybox wget (used by the
# healthcheck) is already present in alpine.
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json server.cjs index.html outreach-links.cjs ./

# DATA_DIR holds drafts.json, sent-drafts.jsonl and webhooks.jsonl. Created and
# chowned here so a fresh named volume inherits the right ownership.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/app/data

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server.cjs"]
