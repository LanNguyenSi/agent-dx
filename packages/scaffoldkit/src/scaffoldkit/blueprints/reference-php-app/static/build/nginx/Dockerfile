FROM nginx:stable-alpine-slim@sha256:5374cc0cf98e39870519e3636847fe7ca0d4755f031c38d4270677f40023b78f as dev

COPY build/nginx/default.dev.conf /etc/nginx/conf.d/default.conf

# --- PROD STAGE ---
FROM dev as prod

COPY build/nginx/default.prod.conf /etc/nginx/conf.d/default.conf