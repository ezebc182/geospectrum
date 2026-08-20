"""
Servicio para consultar eventos sísmicos desde EMSC (Euro-Mediterranean Seismological Centre).

EMSC provee datos sísmicos globales de alta calidad con buena cobertura en Europa,
Mediterráneo, y también eventos significativos a nivel mundial.

API: https://www.seismicportal.eu/eventdetails.html
Feed RSS/JSON disponible.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import List, Tuple, Optional

import httpx
from src.models.event import SeismicEvent
from src.config.settings import settings
from src.observability.metrics import source_fetch_duration_seconds, source_errors_total

logger = logging.getLogger(__name__)


async def fetch_emsc_events(
    window_minutes: int, min_magnitude: Optional[float] = None
) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Fetch eventos desde EMSC API.

    EMSC provee un feed JSON con eventos recientes.
    Endpoint: https://www.seismicportal.eu/fdsnws/event/1/query

    Args:
        window_minutes: Ventana temporal en minutos
        min_magnitude: Piso de magnitud a pedir a la fuente. None usa
            settings.source_min_magnitude (piso bajo anti micro-sismos).

    Returns:
        Tupla (lista_eventos, error_opcional)
    """
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(minutes=window_minutes)
    effective_min_mag = min_magnitude if min_magnitude is not None else settings.source_min_magnitude

    url = "https://www.seismicportal.eu/fdsnws/event/1/query"

    params = {
        "format": "json",
        "start": start_time.strftime("%Y-%m-%dT%H:%M:%S"),
        "end": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "minmag": str(effective_min_mag),
        # Sin bbox: ingesta GLOBAL, el recorte por área ocurre al leer.
        # Ver el comentario equivalente en usgs_service.
        "orderby": "time-asc",
        "limit": str(settings.source_fetch_limit),
    }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.usgs_timeout_s) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

    except httpx.TimeoutException as e:
        source_fetch_duration_seconds.labels(source="emsc", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="emsc", error_type="timeout").inc()
        error_msg = f"EMSC API timeout: {str(e)}"
        logger.warning("EMSC fetch timeout", extra={"error": str(e)})
        return [], error_msg

    except httpx.ConnectError as e:
        source_fetch_duration_seconds.labels(source="emsc", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="emsc", error_type="connection").inc()
        error_msg = f"EMSC API connection error: {str(e)}"
        logger.warning("EMSC fetch connection error", extra={"error": str(e)})
        return [], error_msg

    except httpx.HTTPStatusError as e:
        source_fetch_duration_seconds.labels(source="emsc", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="emsc", error_type="http_error").inc()
        error_msg = f"EMSC API HTTP error: {e.response.status_code}"
        logger.error(error_msg)
        return [], error_msg

    except httpx.RequestError as e:
        source_fetch_duration_seconds.labels(source="emsc", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="emsc", error_type="connection").inc()
        error_msg = f"EMSC API connection error: {str(e)}"
        logger.error(error_msg)
        return [], error_msg

    except Exception as e:
        source_fetch_duration_seconds.labels(source="emsc", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="emsc", error_type="unknown").inc()
        error_msg = f"EMSC unexpected error: {str(e)}"
        logger.error(error_msg)
        return [], error_msg

    source_fetch_duration_seconds.labels(source="emsc", status="success").observe(
        time.perf_counter() - t0
    )

    events = []
    features = data.get("features", [])

    for feature in features:
        try:
            props = feature["properties"]
            geom = feature["geometry"]
            coords = geom["coordinates"]

            time_str = props.get("time")
            if isinstance(time_str, str):
                time_str = time_str.replace("Z", "+00:00")
                event_time = datetime.fromisoformat(time_str)
            else:
                event_time = datetime.fromtimestamp(time_str / 1000, tz=timezone.utc)

            felt = props.get("felt", 0)
            sentido = felt is not None and felt > 0

            status = props.get("status", "automatic")
            revisado = status in ["reviewed", "manual"]

            event = SeismicEvent(
                id=f"emsc_{props.get('eventid', feature.get('id'))}",
                fuentes=["EMSC"],
                hora_utc=event_time.isoformat(),
                lat=coords[1],
                lon=coords[0],
                # GeoJSON estándar reporta coords[2] como elevación (negativa bajo
                # superficie); USGS en cambio ya reporta profundidad positiva. Se
                # normaliza a valor absoluto para que ambas fuentes sean comparables.
                prof_km=abs(coords[2]) if len(coords) > 2 and coords[2] is not None else None,
                mag=props.get("mag", 0.0),
                mag_tipo=props.get("magtype", "M"),
                lugar=props.get("flynn_region") or props.get("place", "Unknown location"),
                sentido=sentido,
                revisado=revisado,
            )
            events.append(event)

        except (KeyError, ValueError, TypeError) as e:
            logger.warning("Error parsing EMSC event: %s", e)
            continue

    logger.info("EMSC: fetched %d events", len(events))
    return events, None
