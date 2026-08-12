"""
Cliente para INPRES (Instituto Nacional de Prevención Sísmica, Argentina).

IMPORTANTE: INPRES no tiene API JSON oficial estable públicamente documentada.
Este servicio consume un proxy/adapter interno (INPRES_PROXY_URL) que debe
encargarse de scrapear el sitio oficial y exponer JSON normalizado.

Si INPRES_PROXY_URL no está configurado, simplemente retornamos lista vacía.
"""

import httpx
import logging
import time
import uuid
from typing import List, Optional, Tuple
from datetime import datetime, timezone, timedelta

from src.models.event import SeismicEvent
from src.config.settings import settings
from src.utils.geo import parse_datetime_utc
from src.observability.metrics import source_fetch_duration_seconds, source_errors_total

logger = logging.getLogger(__name__)


async def fetch_inpres_events(window_minutes: int) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Consulta adapter INPRES y retorna eventos normalizados.

    Args:
        window_minutes: Ventana temporal (para filtrar eventos del proxy)

    Returns:
        (lista_eventos, error_string)
    """
    if not settings.inpres_proxy_url:
        return [], None

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.inpres_timeout_s) as client:
            response = await client.get(settings.inpres_proxy_url)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException as e:
        source_fetch_duration_seconds.labels(source="inpres", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="inpres", error_type="timeout").inc()
        return [], f"INPRES_TIMEOUT:{str(e)}"
    except httpx.ConnectError as e:
        source_fetch_duration_seconds.labels(source="inpres", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="inpres", error_type="connection").inc()
        return [], f"INPRES_CONNECTION_ERROR:{str(e)}"
    except httpx.HTTPStatusError as e:
        source_fetch_duration_seconds.labels(source="inpres", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="inpres", error_type="http_error").inc()
        return [], f"INPRES_HTTP_ERROR:{e.response.status_code}"
    except Exception as e:
        source_fetch_duration_seconds.labels(source="inpres", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="inpres", error_type="unknown").inc()
        return [], f"INPRES_ERROR:{str(e)}"

    source_fetch_duration_seconds.labels(source="inpres", status="success").observe(
        time.perf_counter() - t0
    )

    if not isinstance(data, list):
        source_errors_total.labels(source="inpres", error_type="parse").inc()
        return [], "INPRES_INVALID_FORMAT:expected_list"

    events: List[SeismicEvent] = []
    cutoff_utc = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)

    for item in data:
        try:
            hora_utc_str = item.get("hora_utc")
            if not hora_utc_str:
                continue

            hora_dt = parse_datetime_utc(hora_utc_str)
            if hora_dt < cutoff_utc:
                continue

            lat = item.get("lat")
            lon = item.get("lon")
            mag = item.get("mag")

            if lat is None or lon is None or mag is None:
                continue

            event = SeismicEvent(
                id=str(uuid.uuid4()),
                fuentes=["INPRES"],
                hora_utc=hora_utc_str,
                lat=lat,
                lon=lon,
                prof_km=item.get("prof_km"),
                mag=mag,
                mag_tipo=item.get("mag_tipo", "ML"),
                lugar=item.get("lugar"),
                sentido=bool(item.get("sentido", False)),
                revisado=bool(item.get("revisado", False)),
            )
            events.append(event)

        except Exception:
            logger.warning(
                "INPRES: malformed event skipped",
                extra={"hora_utc": item.get("hora_utc"), "item_preview": str(item)[:200]},
                exc_info=True,
            )
            continue

    return events, None
