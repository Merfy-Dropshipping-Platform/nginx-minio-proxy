# nginx-minio-proxy

Nginx прокси для раздачи статических сайтов из MinIO/S3.

## Использование

Этот образ используется в Coolify для создания отдельных приложений для каждого сайта.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MINIO_URL` | URL MinIO сервера | `https://minio.example.com` |
| `BUCKET` | Название бакета | `merfy-sites` |
| `SITE_PATH` | Путь к файлам сайта | `sites/default` |

### Пример

```bash
docker run -d \
  -e MINIO_URL=https://minio.example.com \
  -e BUCKET=merfy-sites \
  -e SITE_PATH=sites/abc123 \
  -p 80:80 \
  nginx-minio-proxy
```

### Health Check

```bash
curl http://localhost/health
# OK
```

## Coolify Integration

При создании сайта в Merfy, Sites Service автоматически создаёт Coolify app из этого репозитория с нужными environment variables.
