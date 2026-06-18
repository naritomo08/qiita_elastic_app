FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY backend_python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend_python ./backend_python

EXPOSE 5020

CMD ["sh", "-c", "gunicorn --bind ${BACKEND_HOST:-0.0.0.0}:${BACKEND_PORT:-5020} --workers 2 --threads 4 --timeout 30 backend_python.main:app"]
