# Раздача витрин новых тем (design.md блока 5, В5-3 А): свой образ рядом с прокси нынешних магазинов.
# Контекст сборки — папка storefront/. Модуль njs уже есть в официальном образе nginx (design.md, факт 19).
FROM nginx:1.31.3-alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY storefront.conf.template /etc/nginx/templates/storefront.conf.template
COPY njs/ /etc/nginx/njs/

ENV MINIO_URL=http://minio:9000 \
    BUCKET=merfy-sites \
    RENDERER_URL=http://renderer:8080 \
    DRAW_TIMEOUT=5s \
    ROUTES_MEMORY=64m

EXPOSE 80
