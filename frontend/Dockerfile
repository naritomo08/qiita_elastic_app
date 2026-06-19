FROM alpine:3.20 AS builder

COPY frontend /src
RUN sh /src/build-assets.sh /src /dist

FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /dist /usr/share/nginx/html

EXPOSE 8082
