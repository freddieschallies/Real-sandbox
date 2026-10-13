FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY bridge.mjs ./
ENV AUTH_DIR=/data/auth
VOLUME /data
CMD ["node", "bridge.mjs"]
