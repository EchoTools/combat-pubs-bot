FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js nakama-auth.js ./

# state.json is written at runtime — mount a volume at /data
RUN mkdir -p /data && chown node:node /data
ENV STATE_FILE=/data/state.json

USER node

CMD ["node", "bot.js"]
