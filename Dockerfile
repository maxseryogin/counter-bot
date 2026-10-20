FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
ENV DB_PATH=/data/counter.sqlite
CMD ["node", "src/bot.js"]
