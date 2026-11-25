# RenewX backend – container image for any Docker host (not needed for the Render Blueprint, which uses
# render.yaml with the native Python runtime).
# Secrets (DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY, FRONTEND_ORIGINS) come from the
# host's environment settings – no .env file is copied into the image.
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libglib is needed by opencv-python-headless
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face runs containers as user 1000
RUN useradd -m -u 1000 user
WORKDIR /home/user/app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY --chown=user app ./app
USER user

# Listens on $PORT when the host sets it, otherwise 7860
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers --forwarded-allow-ips '*'"]
