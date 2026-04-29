"""
Utilidades geoespaciales para cálculos sísmicos.
"""
import math
from datetime import datetime, timezone


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calcula distancia epicentral entre dos puntos usando fórmula haversine.

    Args:
        lat1, lon1: Coordenadas punto 1
        lat2, lon2: Coordenadas punto 2

    Returns:
        Distancia en kilómetros
    """
    R = 6371.0  # Radio medio de la Tierra en km

    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


def energy_weight(mag: float) -> float:
    """
    Retorna peso proporcional a energía liberada.

    Energía sísmica crece ~10^(1.5*M) según escala de Gutenberg-Richter.
    Un evento M5 libera ~32x más energía que un M4.

    Args:
        mag: Magnitud del evento

    Returns:
        Peso energético (escala arbitraria)
    """
    return 10 ** (1.5 * mag)


def now_utc_iso() -> str:
    """Retorna timestamp UTC actual en formato ISO8601."""
    return datetime.now(timezone.utc).isoformat()


def ms_to_iso(ms: int) -> str:
    """
    Convierte timestamp UNIX en milisegundos a ISO8601 UTC.

    Args:
        ms: Timestamp en milisegundos (formato USGS)

    Returns:
        String ISO8601
    """
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


def parse_datetime_utc(dt_str: str) -> datetime:
    """
    Parsea string ISO8601 a datetime UTC.

    Args:
        dt_str: String formato ISO8601

    Returns:
        datetime objeto con timezone UTC
    """
    # Normalizar "Z" a "+00:00" para compatibilidad
    normalized = dt_str.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)
