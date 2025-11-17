FROM node:20-alpine

WORKDIR /usr/src/app

# Устанавливаем зависимости
COPY package*.json ./
RUN npm ci --production

# Копируем код
COPY . .

# Создаём папку по умолчанию (строго не влияет на volume — volume монтируется при старте)
RUN mkdir -p /data/telegram-posts && mkdir -p /data/telegram-posts/assets

# Запуск бота
CMD ["node", "telegram-to-obsidian.js"]
