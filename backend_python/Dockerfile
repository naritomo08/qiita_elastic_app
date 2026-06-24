FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY backend_python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend_python ./backend_python

EXPOSE 5000

CMD ["uvicorn", "backend_python.main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "2"]
