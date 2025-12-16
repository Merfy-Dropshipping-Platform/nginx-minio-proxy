FROM nginx:alpine

# nginx:alpine поддерживает envsubst через /etc/nginx/templates/
# Файлы *.template автоматически обрабатываются при старте контейнера
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Дефолтные значения (переопределяются через Coolify env vars)
ENV MINIO_URL=https://minio.example.com
ENV BUCKET=merfy-sites
ENV SITE_PATH=sites/default

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
