FROM node:20-alpine

WORKDIR /usr/src/app

# Устанавливаем зависимости (и небольшие утилиты)
RUN apk add --no-cache bash

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Создадим директории (runtime volume перезапишет, но на локальной отладке удобно)
RUN mkdir -p /data/telegram-posts && mkdir -p /data/telegram-posts/assets

ENV NODE_ENV=production

CMD ["node", "telegram-to-obsidian.js"]
