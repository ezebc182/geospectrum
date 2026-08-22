"""
Cliente para INPRES (Instituto Nacional de Prevención Sísmica, Argentina).

INPRES no tiene API JSON, pero sí publica un XML estructurado
(`https://www.inpres.gob.ar/mapa/sismos.xml`) que su propio sitio consume. Ese
feed se lee in-process con `INPRESAdapter`; no hay ningún servicio aparte que
desplegar.

`INPRES_PROXY_URL` sigue soportado para apuntar a un proxy propio (por ejemplo
si algún día conviene cachear o normalizar del lado del servidor), pero ya no es
un requisito: sin esa variable la fuente funciona igual, contra el origen.

Contrato con `report_service`: se devuelve `(eventos, error)`, donde `error=None`
significa ÉXITO. Un fallo tiene que viajar en ese segundo elemento — devolver
`([], None)` ante un problema es indistinguible de "no hubo sismos", y así fue
como esta fuente quedó apagada en producción sin que nadie lo notara.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

import httpx

from src.adapters.inpres_adapter import INPRESAdapter
from src.config.settings import settings
from src.models.event import SeismicEvent
from src.observability.metrics import source_errors_total, source_fetch_duration_seconds
from src.utils.geo import parse_datetime_utc

logger = logging.getLogger(__name__)


async def fetch_inpres_events(window_minutes: int) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Consulta INPRES y retorna eventos normalizados dentro de la ventana.

    Args:
        window_minutes: Ventana temporal hacia atrás desde ahora

    Returns:
        (lista_eventos, error_string). `error_string` es None sólo si la
        consulta fue exitosa; una lista vacía con error None significa que
        INPRES respondió bien y no había sismos en la ventana.
    """
    adapter = INPRESAdapter(
        timeout=settings.inpres_timeout_s,
        **({"url": settings.inpres_proxy_url} if settings.inpres_proxy_url else {}),
    )

    t0 = time.perf_counter()
    try:
        raw_events = await adapter.fetch_recent_events()
    except httpx.TimeoutException as e:
        return _fail(t0, "timeout", f"INPRES_TIMEOUT:{e}")
    except httpx.ConnectError as e:
        return _fail(t0, "connection", f"INPRES_CONNECTION_ERROR:{e}")
    except httpx.HTTPStatusError as e:
        return _fail(t0, "http_error", f"INPRES_HTTP_ERROR:{e.response.status_code}")
    except ValueError as e:
        # XML ilegible, rechazado por seguridad, o raíz inesperada.
        return _fail(t0, "parse", f"INPRES_INVALID_FORMAT:{e}")
    except Exception as e:
        return _fail(t0, "unknown", f"INPRES_ERROR:{e}")

    source_fetch_duration_seconds.labels(source="inpres", status="success").observe(
        time.perf_counter() - t0
    )

    cutoff_utc = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    events: List[SeismicEvent] = []

    for raw in raw_events:
        try:
            if parse_datetime_utc(raw["hora_utc"]) < cutoff_utc:
                continue

            events.append(
                SeismicEvent(
                    # El id del feed (`idSismo`) es estable entre llamadas: el
                    # mismo sismo es el mismo evento. Antes acá se generaba un
                    # uuid4() nuevo en cada fetch y el dedup no tenía asidero.
                    id=f"inpres_{raw['id_externo']}",
                    fuentes=["INPRES"],
                    hora_utc=raw["hora_utc"],
                    lat=raw["lat"],
                    lon=raw["lon"],
                    prof_km=raw.get("prof_km"),
                    mag=raw["mag"],
                    mag_tipo=raw.get("mag_tipo", "ML"),
                    lugar=raw.get("lugar"),
                    sentido=raw["sentido"],
                    revisado=raw["revisado"],
                )
            )
        except Exception:
            logger.warning(
                "INPRES: evento malformado descartado",
                extra={"id_externo": raw.get("id_externo"), "hora_utc": raw.get("hora_utc")},
                exc_info=True,
            )
            continue

    return events, None


def _fail(t0: float, error_type: str, message: str) -> Tuple[List[SeismicEvent], str]:
    """Registra métricas del fallo y arma el retorno de error."""
    source_fetch_duration_seconds.labels(source="inpres", status="error").observe(
        time.perf_counter() - t0
    )
    source_errors_total.labels(source="inpres", error_type=error_type).inc()
    logger.warning("INPRES fetch falló: %s", message)
    return [], message
