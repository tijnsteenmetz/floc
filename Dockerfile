# floc server on Railway: API + studio (built editor) + website, one container.
FROM node:22-slim
# python3: tools/fetch_bgt.py (BGT base map). GDAL is deliberately not installed: that work happens in the studio on the Mac.
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/editor
COPY editor/package.json editor/package-lock.json ./
RUN npm ci
COPY editor/ ./
COPY website/ /app/website/
COPY tools/ /app/tools/
# If the studio build fails, the API, app downloads and website still deploy; /studio then says so.
RUN npx vite build || (echo "STUDIO BUILD MISLUKT" && mkdir -p dist && touch dist/.build-failed)
ENV NODE_ENV=production
CMD ["npx", "tsx", "server/index.ts"]
