FROM php:8.4-cli-alpine

WORKDIR /app
COPY backend_php /app
RUN php -l index.php && php -l router.php

EXPOSE 5022
CMD ["php", "-S", "0.0.0.0:5022", "router.php"]
