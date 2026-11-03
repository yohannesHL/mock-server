FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/providers ./providers
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4310
CMD ["node", "--env-file-if-exists=.env", "dist/server/index.js"]
