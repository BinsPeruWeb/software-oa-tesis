FROM python:3.12-slim-bookworm

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY services/ml/requirements.txt ./requirements.txt
RUN pip install --index-url "${TORCH_INDEX_URL}" torch==2.8.0 torchvision==0.23.0 \
    && pip install -r requirements.txt
COPY services/ml/app ./app
COPY services/ml/bootstrap_models.py ./bootstrap_models.py
COPY services/ml/tests ./tests
RUN useradd --create-home --uid 10001 oa && mkdir -p /models && chown -R oa:oa /app /models
USER oa
EXPOSE 8000
CMD ["sh", "-c", "python bootstrap_models.py && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-access-log"]
