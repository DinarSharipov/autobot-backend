FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
WORKDIR /app
COPY nest-cli.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S autobot && adduser -S autobot -G autobot
COPY --from=production-dependencies --chown=autobot:autobot /app/node_modules ./node_modules
COPY --from=build --chown=autobot:autobot /app/dist ./dist
COPY --from=build --chown=autobot:autobot /app/package.json ./package.json
USER autobot
EXPOSE 3000
CMD ["node", "dist/main.js"]
