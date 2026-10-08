FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

USER 10001

EXPOSE 8080
CMD ["node", "src/server.js"]
