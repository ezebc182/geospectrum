"""
Caché TTL en memoria para resultados de fetch de fuentes externas.

Diseño:
- Cada clave guarda (valor, timestamp_expiry).
- Thread-safe para uso con asyncio (no se requiere lock: el GIL protege dict ops).
- TTL configurable por clave; por defecto usa settings.cache_ttl_seconds.
"""
import time
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_store: dict[str, tuple[Any, float]] = {}


def get(key: str) -> Optional[Any]:
    """Retorna el valor si existe y no expiró, None en caso contrario."""
    entry = _store.get(key)
    if entry is None:
        return None
    value, expiry = entry
    if time.monotonic() > expiry:
        del _store[key]
        logger.debug("cache MISS (expired): %s", key)
        return None
    logger.debug("cache HIT: %s", key)
    return value


def set(key: str, value: Any, ttl_seconds: float) -> None:
    """Almacena value bajo key con el TTL indicado."""
    expiry = time.monotonic() + ttl_seconds
    _store[key] = (value, expiry)
    logger.debug("cache SET: %s (ttl=%.0fs)", key, ttl_seconds)


def invalidate(key: str) -> None:
    """Elimina una entrada del caché."""
    _store.pop(key, None)


def clear() -> None:
    """Vacía el caché completo (útil en tests)."""
    _store.clear()
