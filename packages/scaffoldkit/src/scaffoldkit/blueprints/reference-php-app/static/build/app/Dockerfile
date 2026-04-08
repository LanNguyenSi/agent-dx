FROM php:8.4-fpm-alpine@sha256:aa3fbc44ad16c4a0ecb35797f31a2259a42c001d7711b649f4916a02deedf6e9 AS base

RUN addgroup -g 10001 docker && \
    adduser -D -u 10001 -G docker docker

RUN apk add --no-cache \
        zip \
        unzip \
        mysql-client \
        zlib-dev \
        libzip-dev && \
    docker-php-ext-install mysqli && \
    docker-php-ext-install pdo && \
    docker-php-ext-install pdo_mysql && \
    docker-php-ext-install zip && \
    docker-php-ext-install opcache && \
    docker-php-ext-enable mysqli pdo pdo_mysql zip opcache

# --- DEV STAGE ---
FROM base AS dev

ENV COMPOSER_ALLOW_SUPERUSER=1

RUN apk add --no-cache git wget bash

# Build and install Xdebug
RUN apk add --no-cache --virtual .build-deps \
    autoconf \
    gcc \
    make \
    libc-dev \
    linux-headers \
    pkgconf \
 && pecl install xdebug-3.5.0 \
 && docker-php-ext-enable xdebug \
 && pecl clear-cache \
 && apk del .build-deps

COPY --from=composer:latest /usr/bin/composer /usr/local/bin/composer

COPY build/app/php.dev.ini /usr/local/etc/php/conf.d/local.ini
COPY --chown=docker:docker ./project/. /var/www/project

WORKDIR /var/www/project
RUN composer install
RUN composer -d tools install

USER root
EXPOSE 9000
CMD ["php-fpm"]

# --- BUILD STAGE ---
FROM dev AS build
RUN composer install --no-dev --no-scripts

# --- PROD STAGE ---
FROM base AS prod

COPY build/app/php.prod.ini /usr/local/etc/php/conf.d/local.ini
COPY --from=build --chown=docker:docker /var/www/project/. /var/www/project

USER docker
WORKDIR /var/www/project
EXPOSE 9000
CMD ["php-fpm"]