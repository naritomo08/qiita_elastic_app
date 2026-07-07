FROM node:22-alpine AS builder

WORKDIR /src
COPY frontend/package.json frontend/package.json
COPY frontend/package-lock.json frontend/package-lock.json
COPY frontend/vite.config.js frontend/vite.config.js
COPY frontend/index.html frontend/index.html
COPY frontend/src frontend/src
COPY frontend/static frontend/static
WORKDIR /src/frontend
RUN npm ci
RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo Asia/Tokyo > /etc/timezone

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/proxy_params /etc/nginx/proxy_params
COPY --chmod=755 frontend/05-init-access-log-volume.sh /docker-entrypoint.d/05-init-access-log-volume.sh
COPY --from=builder /src/frontend/dist /usr/share/nginx/html

EXPOSE 8082
