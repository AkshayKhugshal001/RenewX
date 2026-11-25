# RenewX backend – container for Hugging Face Spaces (Docker SDK). Also works on any Docker host.
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

# Hugging Face Spaces expects the app on port 7860 (see app_port in README.md)
EXPOSE 7860
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860", "--proxy-headers", "--forwarded-allow-ips", "*"]
