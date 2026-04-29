# =============================================================================
# Multi-stage Dockerfile para Seismic Monitor Service
# Imagen production-ready con security hardening
# =============================================================================

FROM python:3.11-slim AS base

# Metadata
LABEL maintainer="seismic-ops@example.com"
LABEL description="Production-grade seismic monitoring service"

# Security: usuario no root
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app && \
    chown appuser:appuser /app

WORKDIR /app

# Dependencias del sistema (mínimas)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq5 \
        && \
    rm -rf /var/lib/apt/lists/*

# =============================================================================
# Stage: dependencies
# =============================================================================

FROM base AS dependencies

# Dependencias de build
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
        && \
    rm -rf /var/lib/apt/lists/*

# Copiar requirements
COPY requirements.txt .

# Instalar dependencias Python
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# =============================================================================
# Stage: production
# =============================================================================

FROM base AS production

# Copiar dependencias instaladas
COPY --from=dependencies /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=dependencies /usr/local/bin /usr/local/bin

# Copiar código fuente
COPY --chown=appuser:appuser src /app/src
COPY --chown=appuser:appuser .env.example /app/.env.example

# Cambiar a usuario no root
USER appuser

# Exponer puerto
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/health', timeout=2)" || exit 1

# Entry point
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
