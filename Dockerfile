FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:4000/api/health',r=>r.statusCode===200?process.exit(0):process.exit(1))"
CMD ["node", "src/server.js"]
