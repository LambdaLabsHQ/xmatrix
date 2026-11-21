FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
