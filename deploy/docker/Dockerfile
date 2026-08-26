# =============================================================================
# Multi-stage Dockerfile para GeoSpectrum Service
# Imagen production-ready con security hardening
# =============================================================================

FROM python:3.11-slim AS base

# Metadata
LABEL maintainer="geospectrum-ops@example.com"
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
# Fuente única de constantes sismológicas compartida con el frontend: la carga
# src/services/signal_picks.py AL IMPORTAR y revienta sin ella (a propósito —
# mejor no arrancar que calcular una distancia con defaults). Verificado el
# 2026-08-26: sin este COPY el api de Railway murió con FileNotFoundError.
COPY --chown=appuser:appuser dashboard/lib/seismic-constants.json /app/dashboard/lib/seismic-constants.json
COPY --chown=appuser:appuser .env.example /app/.env.example

# Migraciones + runner: la API las aplica al arranque cuando
# RUN_MIGRATIONS_ON_STARTUP=true (ver src/main.py lifespan). Sin estos COPY
# el flag es un no-op silencioso — los .sql no existirían en el contenedor.
COPY --chown=appuser:appuser scripts /app/scripts
COPY --chown=appuser:appuser deploy/sql/migrations /app/deploy/sql/migrations
COPY --chown=appuser:appuser db/migrations /app/db/migrations

# Cambiar a usuario no root
USER appuser

# Exponer puerto
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/health', timeout=2)" || exit 1

# Entry point
# Host 0.0.0.0 verificado contra Railway el 2026-08-05: su red privada y su
# edge proxy conectan por IPv4 (api.railway.internal resuelve a 10.x). El bind
# "::" NO sirve ahí: el contenedor tiene v6only y rechaza IPv4 con
# "connection refused" → 502 en el edge.
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
