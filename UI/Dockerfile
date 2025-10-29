# Simple Dockerfile for the UI (Node.js) service
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
# Use npm by default; pnpm isn't installed in this image, lock is copied only for cache invalidation
RUN npm install --production

# Copy source
COPY . .

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
