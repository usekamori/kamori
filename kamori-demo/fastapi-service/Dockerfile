FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install fastapi "uvicorn[standard]" httpx
COPY main.py .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
