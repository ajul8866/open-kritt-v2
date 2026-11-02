FROM python:3.15.0-slim-bookworm

WORKDIR /app

RUN pip install --no-cache-dir psycopg[binary]==3.3.6

COPY server.py ./

ENV EXECUTOR_VIEW_HOST=0.0.0.0 \
    EXECUTOR_VIEW_PORT=8090

CMD ["python", "server.py"]
