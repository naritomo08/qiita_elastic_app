FROM python:3.13-alpine

WORKDIR /app
COPY metrics/config.py metrics/docker_client.py metrics/metrics.py metrics/logs.py metrics/main.py ./

EXPOSE 8090
CMD ["python", "main.py"]
