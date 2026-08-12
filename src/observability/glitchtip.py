"""
Inicializacion de GlitchTip (compatible con Sentry SDK).

Llamado por el ingestor y la API en startup. Si no hay DSN configurado,
es no-op (util para desarrollo local sin GlitchTip levantado).

GlitchTip vs Prometheus:
- Prometheus: contadores y agregados ("¿cuántos errores hubo?")
- GlitchTip: stack traces y agrupacion ("qué error específico, en qué linea,
  con qué contexto, qué cliente fue afectado")

Son complementarios, no alternativos.
"""

import logging
from typing import Any

import sentry_sdk
from sentry_sdk.integrations.asyncio import AsyncioIntegration

from src.config.settings import settings

logger = logging.getLogger(__name__)


def _sanitize_pii(event: dict, hint: dict) -> dict | None:
    """Filtro before_send: descarta errores conocidos no-actionable.

    Esto evita alarm fatigue en GlitchTip. Se descartan:
    - ConnectionResetError de clientes que cierran browser bruscamente
      (no son bugs del servidor, son comportamiento esperado de SSE)
    """
    exc_info = hint.get("exc_info")
    if exc_info:
        exc_type = exc_info[0]
        if exc_type is ConnectionResetError:
            return None
    return event


def init_glitchtip(component: str) -> None:
    """Inicializa Sentry SDK contra GlitchTip si hay DSN configurado.

    Args:
        component: nombre del servicio ('ingestor' | 'api') para tag.
            Permite filtrar errores por servicio en GlitchTip UI.
    """
    if not settings.glitchtip_dsn:
        logger.info("GlitchTip DSN not configured, skipping init")
        return

    integrations: list[Any] = [AsyncioIntegration()]
    if component == "api":
        # FastAPI/Starlette integrations solo se cargan en el proceso API,
        # no en el ingestor (que es un script standalone).
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        integrations.extend([FastApiIntegration(), StarletteIntegration()])

    sentry_sdk.init(
        dsn=settings.glitchtip_dsn,
        environment=settings.environment,
        release=settings.git_sha,
        traces_sample_rate=settings.glitchtip_traces_sample_rate,
        integrations=integrations,
        before_send=_sanitize_pii,
    )
    sentry_sdk.set_tag("component", component)
    logger.info("GlitchTip initialized for component=%s", component)
