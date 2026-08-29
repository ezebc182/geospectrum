"""Canales SeedLink efímeros: suscripción bajo demanda fuera del catálogo.

El dolor que resuelve: LIVE_CANDIDATES_BY_CITY (spectrogram_service.py) es la
lista FIJA de canales que el ingestor suscribe al arrancar. Un canal fuera de
esa lista nunca tuvo datos en vivo — /ws/spectrogram/{channel} queda mudo para
siempre, sin error, porque nadie publicó nunca en `spec:<channel>`.

Este módulo es el punto de encuentro entre los dos procesos (api e ingestor,
ver seedlink_ingestor.py líneas 1-17): el api PIDE un canal escribiendo en
Redis con un TTL que se renueva mientras haya al menos un WebSocket
conectado; el ingestor LEE la lista vigente en cada ciclo de reconexión y la
suma al catálogo fijo. Cuando el TTL expira solo (nadie renovó porque el
último WebSocket se desconectó), el próximo ciclo de reconexión del ingestor
ya no lo incluye — mismo espíritu que STALE_AFTER_SECONDS del watchdog:
expira por ausencia de señal, sin necesitar una baja activa.

Cliente Redis SÍNCRONO a propósito: el poll de este módulo vive en un hilo
del ingestor sin loop de asyncio propio (igual que _watchdog_loop en
seedlink_ingestor.py), no en el hilo con el loop de column_writer.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import redis
    import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

_REDIS_KEY_PREFIX = "ephemeral_channel:"

# TTL de cada pedido. Un WebSocket vivo lo renueva (volviendo a llamar
# request_channel_async) antes de que expire; si el cliente se desconecta sin
# avisar (cierre abrupto de pestaña), el canal sigue suscripto hasta este
# vencimiento como máximo.
DEFAULT_TTL_SECONDS = 300


def _key(channel: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{channel}"


def request_channel(client: redis.Redis, channel: str, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
    """Pide (o renueva) la suscripción efímera a `channel` (formato NET.STA.LOC.CHA).

    Cliente SÍNCRONO — la usa el ingestor. El api usa request_channel_async.
    """
    client.set(_key(channel), "1", ex=ttl_seconds)


async def request_channel_async(
    client: aioredis.Redis, channel: str, ttl_seconds: int = DEFAULT_TTL_SECONDS
) -> None:
    """Igual que request_channel, pero con el cliente async del api (event_bus.client)."""
    await client.set(_key(channel), "1", ex=ttl_seconds)


def list_requested_channels(client: redis.Redis) -> list[tuple[str, str, str]]:
    """Canales efímeros vigentes, en la forma (network, station, channel) que
    espera SeedLinkIngestor.run() — el location code se descarta, igual que
    channels_from_catalog: SeedLink lo resuelve solo."""
    channels: list[tuple[str, str, str]] = []
    for key in client.scan_iter(match=f"{_REDIS_KEY_PREFIX}*"):
        seed_id = key[len(_REDIS_KEY_PREFIX):] if isinstance(key, str) else key.decode()[len(_REDIS_KEY_PREFIX):]
        parts = seed_id.split(".")
        if len(parts) != 4:
            logger.warning("ephemeral_channels: SCNL malformado en Redis: %s", seed_id)
            continue
        net, sta, _loc, cha = parts
        channels.append((net, sta, cha))
    return channels
