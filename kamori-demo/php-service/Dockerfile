FROM composer:2 AS composer
FROM php:8.3-cli-alpine

COPY --from=composer /usr/bin/composer /usr/bin/composer

WORKDIR /project
COPY sdks/php ./sdks/php
COPY kamori-demo/php-service ./kamori-demo/php-service
WORKDIR /project/kamori-demo/php-service
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --no-interaction --optimize-autoloader

CMD ["php", "-S", "0.0.0.0:6100", "index.php"]
