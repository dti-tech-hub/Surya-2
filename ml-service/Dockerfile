# ML service image.
#
# Models are NOT baked into the image. They are trained by CI and on the developer
# machine, then mounted or copied at deploy time. Baking a trained model would mean a
# stale model could ship silently with a fresh image tag, which is exactly the kind of
# "the AI says it's fine" failure this project should avoid.

FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Build deps are installed, used, and removed in one layer so they never reach the
# final image.
RUN apt-get update \
 && apt-get install --no-install-recommends -y build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY ml-service/requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt \
 && apt-get purge -y build-essential && apt-get autoremove -y

COPY ml-service/*.py ./

# Model artifacts are mounted at runtime (see docker-compose.yml).
ENV MODEL_DIR=/app/models
RUN mkdir -p /app/models /app/data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health').read()"

# Models may be absent on first boot; the service reports models_trained=false rather
# than crash-looping, and the backend surfaces that state instead of silently scoring.
CMD ["uvicorn", "ml_service_api:app", "--host", "0.0.0.0", "--port", "8000"]