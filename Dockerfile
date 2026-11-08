# Used by Cloud Run "deploy from repository" (alternative to AI Studio's Publish button)
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); server.ts reads it.
CMD ["npm", "start"]
