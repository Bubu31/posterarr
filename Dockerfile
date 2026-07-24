FROM oven/bun:1.3-alpine

WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package.json ./
RUN bun install --production

COPY . .

ENV DB_PATH=/data/posterarr.db
EXPOSE 3939
VOLUME ["/data"]

CMD ["bun", "src/server.ts"]
