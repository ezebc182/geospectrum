"""
Configuración de logging estructurado JSON para el servicio.

Usa python-json-logger para emitir cada línea de log como un objeto JSON
parseable por Loki, Elasticsearch, o cualquier stack de log aggregation.

Campos siempre presentes en cada línea:
- asctime, name, levelname, message  (formato base)
- service="geospectrum"              (campo fijo)
- request_id                         (inyectado por RequestIdFilter cuando disponible)
"""
import logging
import sys
from typing import Optional


def configure_logging(level: str = "INFO") -> None:
    """Configura el root logger con output JSON estructurado.

    Debe llamarse ANTES de crear la app FastAPI para que todos los loggers
    del proceso hereden la configuración.

    Args:
        level: Nivel de logging (DEBUG, INFO, WARNING, ERROR, CRITICAL).
               Corresponde a la env var LOG_LEVEL.
    """
    try:
        from pythonjsonlogger import jsonlogger
    except ImportError as exc:  # pragma: no cover
        logging.basicConfig(level=level.upper())
        logging.getLogger(__name__).warning(
            "python-json-logger not installed, falling back to plain text logging: %s", exc
        )
        return

    # Formato base: los campos que queremos en cada línea JSON.
    # pythonjsonlogger serializa los campos del LogRecord cuyos nombres
    # aparecen en el format string, más cualquier extra={} que pase el caller.
    fmt = "%(asctime)s %(name)s %(levelname)s %(message)s"

    class _SeismicJsonFormatter(jsonlogger.JsonFormatter):
        """Extiende JsonFormatter añadiendo campos fijos del servicio."""

        def add_fields(
            self,
            log_record: dict,
            record: logging.LogRecord,
            message_dict: dict,
        ) -> None:
            super().add_fields(log_record, record, message_dict)
            # Campo fijo: identifica el proceso en entornos multi-servicio
            log_record.setdefault("service", "geospectrum")
            # request_id es inyectado por RequestIdFilter; si no está presente
            # (e.g. logs de startup antes del primer request) ponemos "-".
            log_record.setdefault("request_id", "-")

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_SeismicJsonFormatter(fmt))

    # Importar el filter aquí para evitar import circular en startup.
    # request_context importa a logging, pero logging_config no importa
    # a request_context en module-level — solo lo hace aquí, en tiempo de
    # ejecución de configure_logging().
    try:
        from src.observability.request_context import RequestIdFilter
        handler.addFilter(RequestIdFilter())
    except ImportError:
        # Durante tests unitarios de logging_config sin el módulo completo
        pass

    numeric_level = getattr(logging, level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(numeric_level)
    # Reemplazar handlers existentes (evita duplicación si se llama dos veces)
    root.handlers = [handler]
