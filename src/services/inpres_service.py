"""
Cliente para INPRES (Instituto Nacional de Prevención Sísmica, Argentina).

IMPORTANTE: INPRES no tiene API JSON oficial estable públicamente documentada.
Este servicio consume un proxy/adapter interno (INPRES_PROXY_URL) que debe
encargarse de scrapear el sitio oficial y exponer JSON normalizado.

Si INPRES_PROXY_URL no está configurado, simplemente retornamos lista vacía.
"""
import httpx
import uuid
from typing import List, Optional, Tuple
from datetime import datetime, timezone, timedelta

from src.models.event import SeismicEvent
from src.config.settings import settings
from src.utils.geo import parse_datetime_utc


async def fetch_inpres_events(window_minutes: int) -> Tuple[List[SeismicEvent], Optional[str]]:
    """
    Consulta adapter INPRES y retorna eventos normalizados.

    Formato esperado del proxy (JSON):
    [
        {
            "hora_utc": "2025-10-28T22:26:39+00:00",
            "lat": -31.875,
            "lon": -68.296,
            "prof_km": 108.0,
            "mag": 4.0,
            "mag_tipo": "ML",
            "lugar": "43 km SE de San Juan, Argentina",
            "revisado": true,
            "sentido": true
        },
        ...
    ]

    Args:
        window_minutes: Ventana temporal (para filtrar eventos del proxy)

    Returns:
        (lista_eventos, error_string)
    """
    if not settings.inpres_proxy_url:
        # No configurado → no es error, simplemente no hay fuente INPRES
        return [], None

    try:
        async with httpx.AsyncClient(timeout=settings.inpres_timeout_s) as client:
            response = await client.get(settings.inpres_proxy_url)
            response.raise_for_status()
            data = response.json()
    except httpx.TimeoutException as e:
        return [], f"INPRES_TIMEOUT:{str(e)}"
    except httpx.HTTPStatusError as e:
        return [], f"INPRES_HTTP_ERROR:{e.response.status_code}"
    except Exception as e:
        return [], f"INPRES_ERROR:{str(e)}"

    if not isinstance(data, list):
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
            continue

    return events, None
