FROM php:8.4-cli-alpine

WORKDIR /app
COPY backend_php /app
RUN for f in *.php; do php -l "$f"; done

EXPOSE 5000
CMD ["php", "-S", "0.0.0.0:5000", "router.php"]
