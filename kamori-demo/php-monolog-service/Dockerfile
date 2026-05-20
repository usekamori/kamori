FROM composer:2 AS composer
FROM php:8.3-cli-alpine

COPY --from=composer /usr/bin/composer /usr/bin/composer

WORKDIR /project
COPY sdks/php ./sdks/php
COPY kamori-demo/php-monolog-service ./kamori-demo/php-monolog-service
WORKDIR /project/kamori-demo/php-monolog-service
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --no-interaction --optimize-autoloader

CMD ["php", "-S", "0.0.0.0:6001", "index.php"]
