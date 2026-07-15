"""
Cliente para USGS Earthquake Catalog API (ComCat).
"""
import httpx
import time
import uuid
from typing import List, Optional, Tuple
from datetime import datetime, timezone, timedelta

from src.models.event import SeismicEvent
from src.utils.geo import ms_to_iso
from src.config.settings import settings
from src.observability.metrics import source_fetch_duration_seconds, source_errors_total


async def fetch_usgs_events(window_minutes: int) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Consulta USGS ComCat API y retorna eventos normalizados.

    Args:
        window_minutes: Ventana temporal de consulta (hacia atrás desde ahora)

    Returns:
        (lista_eventos, error_string)
        error_string es None si todo OK, sino contiene descripción del error
    """
    end_utc = datetime.now(timezone.utc)
    start_utc = end_utc - timedelta(minutes=window_minutes)

    params = {
        "format": "geojson",
        "starttime": start_utc.strftime("%Y-%m-%dT%H:%M:%S"),
        "endtime": end_utc.strftime("%Y-%m-%dT%H:%M:%S"),
        "minmagnitude": str(settings.min_mag_alert),
        "minlatitude": str(settings.region_minlat),
        "maxlatitude": str(settings.region_maxlat),
        "minlongitude": str(settings.region_minlon),
        "maxlongitude": str(settings.region_maxlon),
        "orderby": "time",
        "limit": "200",
    }

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=settings.usgs_timeout_s) as client:
            response = await client.get(settings.usgs_api_url, params=params)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException as e:
        source_fetch_duration_seconds.labels(source="usgs", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="usgs", error_type="timeout").inc()
        return [], f"USGS_TIMEOUT:{str(e)}"
    except httpx.HTTPStatusError as e:
        source_fetch_duration_seconds.labels(source="usgs", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="usgs", error_type="http_error").inc()
        return [], f"USGS_HTTP_ERROR:{e.response.status_code}"
    except Exception as e:
        source_fetch_duration_seconds.labels(source="usgs", status="error").observe(
            time.perf_counter() - t0
        )
        source_errors_total.labels(source="usgs", error_type="unknown").inc()
        return [], f"USGS_ERROR:{str(e)}"

    source_fetch_duration_seconds.labels(source="usgs", status="success").observe(
        time.perf_counter() - t0
    )

    events: List[SeismicEvent] = []

    for feature in data.get("features", []):
        try:
            props = feature.get("properties", {})
            geom = feature.get("geometry", {})
            coords = geom.get("coordinates", [None, None, None])

            # Validaciones básicas
            if coords[1] is None or coords[0] is None:
                continue

            time_ms = props.get("time")
            if time_ms is None:
                continue

            hora_iso = ms_to_iso(time_ms)
            mag = props.get("mag")
            if mag is None:
                continue

            # Determinar si fue revisado y sentido
            revisado = props.get("status") == "reviewed"
            felt_count = props.get("felt")
            sentido = bool(felt_count and felt_count > 0)

            event = SeismicEvent(
                id=feature.get("id") or str(uuid.uuid4()),
                fuentes=["USGS"],
                hora_utc=hora_iso,
                lat=coords[1],
                lon=coords[0],
                prof_km=coords[2],
                mag=mag,
                mag_tipo=props.get("magType"),
                lugar=props.get("place"),
                sentido=sentido,
                revisado=revisado,
            )
            events.append(event)

        except Exception as e:
            # Evento individual malformado → skip sin romper todo
            continue

    return events, None
