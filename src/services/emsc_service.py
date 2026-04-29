"""
Servicio para consultar eventos sísmicos desde EMSC (Euro-Mediterranean Seismological Centre).

EMSC provee datos sísmicos globales de alta calidad con buena cobertura en Europa,
Mediterráneo, y también eventos significativos a nivel mundial.

API: https://www.seismicportal.eu/eventdetails.html
Feed RSS/JSON disponible.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Tuple, Optional

import httpx
from src.models.event import SeismicEvent
from src.config.settings import settings

logger = logging.getLogger(__name__)


async def fetch_emsc_events(window_minutes: int) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Fetch eventos desde EMSC API.

    EMSC provee un feed JSON con eventos recientes.
    Endpoint: https://www.seismicportal.eu/fdsnws/event/1/query

    Args:
        window_minutes: Ventana temporal en minutos

    Returns:
        Tupla (lista_eventos, error_opcional)
    """
    try:
        now = datetime.now(timezone.utc)
        start_time = now - timedelta(minutes=window_minutes)

        # EMSC FDSN web service
        # Similar a USGS pero con mejor cobertura en Europa/Mediterráneo
        url = "https://www.seismicportal.eu/fdsnws/event/1/query"

        params = {
            "format": "json",
            "start": start_time.strftime("%Y-%m-%dT%H:%M:%S"),
            "end": now.strftime("%Y-%m-%dT%H:%M:%S"),
            "minmag": str(settings.min_mag_alert),
            "minlat": str(settings.bbox["minlat"]),
            "maxlat": str(settings.bbox["maxlat"]),
            "minlon": str(settings.bbox["minlon"]),
            "maxlon": str(settings.bbox["maxlon"]),
            "orderby": "time-asc",
            "limit": "200",
        }

        async with httpx.AsyncClient(timeout=settings.usgs_timeout_s) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

        events = []

        # EMSC devuelve estructura similar a USGS pero con algunas diferencias
        features = data.get("features", [])

        for feature in features:
            try:
                props = feature["properties"]
                geom = feature["geometry"]
                coords = geom["coordinates"]

                # Parse time (EMSC usa ISO format)
                time_str = props.get("time")
                if isinstance(time_str, str):
                    # Remove 'Z' and parse
                    time_str = time_str.replace("Z", "+00:00")
                    event_time = datetime.fromisoformat(time_str)
                else:
                    # Unix timestamp in milliseconds
                    event_time = datetime.fromtimestamp(time_str / 1000, tz=timezone.utc)

                # Determinar si fue sentido (felt reports)
                felt = props.get("felt", 0)
                sentido = felt is not None and felt > 0

                # Estado de revisión
                status = props.get("status", "automatic")
                revisado = status in ["reviewed", "manual"]

                event = SeismicEvent(
                    id=f"emsc_{props.get('eventid', feature.get('id'))}",
                    fuentes=["EMSC"],
                    hora_utc=event_time.isoformat(),
                    lat=coords[1],
                    lon=coords[0],
                    prof_km=coords[2] if len(coords) > 2 and coords[2] is not None else None,
                    mag=props.get("mag", 0.0),
                    mag_tipo=props.get("magtype", "M"),
                    lugar=props.get("flynn_region") or props.get("place", "Unknown location"),
                    sentido=sentido,
                    revisado=revisado,
                )
                events.append(event)

            except (KeyError, ValueError, TypeError) as e:
                logger.warning(f"Error parsing EMSC event: {e}")
                continue

        logger.info(f"✅ EMSC: fetched {len(events)} events")
        return events, None

    except httpx.HTTPStatusError as e:
        error_msg = f"EMSC API HTTP error: {e.response.status_code}"
        logger.error(error_msg)
        return [], error_msg

    except httpx.RequestError as e:
        error_msg = f"EMSC API connection error: {str(e)}"
        logger.error(error_msg)
        return [], error_msg

    except Exception as e:
        error_msg = f"EMSC unexpected error: {str(e)}"
        logger.error(error_msg)
        return [], error_msg
