"""
Contexto de request para propagación de request_id a través del proceso.

El ContextVar sobrevive a awaits dentro del mismo asyncio Task, lo que lo
hace adecuado para FastAPI donde cada request corre en su propia Task.

Uso:
    # En el middleware:
    request_id_ctx.set("abc-123")

    # En cualquier logger del mismo Task:
    logger.info("procesando evento", extra={"mag": 4.2})
    # El JsonFormatter incluirá request_id="abc-123" automáticamente
"""

import logging
from contextvars import ContextVar

# Default "-" distingue logs sin contexto de request (startup, background tasks)
# de requests con ID vacío o ausente.
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    """Inyecta el request_id del contexto actual en cada LogRecord.

    Se añade al handler en configure_logging(). Al ser un Filter sobre el
    handler (no sobre un logger específico), aplica a todos los loggers del
    proceso que usen ese handler.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        return True
