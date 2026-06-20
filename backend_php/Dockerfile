FROM php:8.4-cli-alpine

WORKDIR /app
COPY backend_php /app
RUN php -l index.php && php -l router.php

EXPOSE 5000
CMD ["php", "-S", "0.0.0.0:5000", "router.php"]
