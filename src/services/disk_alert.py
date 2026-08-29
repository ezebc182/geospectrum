"""Alerta de disco de TimescaleDB vía ntfy.

El dolor que resuelve: el 2026-08-28 el volumen de TimescaleDB llegó a 100%
por chunks de 7 días con retención de 24h (ver migración 002) y Postgres
entró en crash-loop sin arrancar solo — nadie se enteró hasta que el api ya
estaba caído. Sin esta alerta, el mismo patrón se repite con OTRA tabla que
crezca más rápido de lo esperado.

Mide `pg_database_size()` contra el tope conocido del volumen de Railway
(no el % de disco del contenedor de Postgres, que corre en un servicio
aparte e inalcanzable desde acá vía SQL) — más simple y con la misma
información accionable: cuánto falta para llenarse.

Corre DENTRO del proceso del api, mismo patrón que fdsn_warmup.py: un
asyncio.Task con stop_event esperado (no un sleep pelado) para no demorar
el shutdown, y un try/except que envuelve TODO el ciclo (la lección del
ingestor que salía con exit 0 por un hilo sin try/except).
"""

import asyncio
import logging

import asyncpg
import httpx

logger = logging.getLogger(__name__)

_QUERY_DATABASE_SIZE = "SELECT pg_database_size(current_database())"


async def _database_size_bytes(pool: asyncpg.Pool) -> int:
    async with pool.acquire() as conn:
        return await conn.fetchval(_QUERY_DATABASE_SIZE)


async def _notify_ntfy(topic_url: str, usage_ratio: float, size_bytes: int) -> None:
    size_gb = size_bytes / (1024**3)
    async with httpx.AsyncClient(timeout=10.0) as client:
        await client.post(
            topic_url,
            content=(
                f"TimescaleDB al {usage_ratio:.0%} del volumen "
                f"({size_gb:.2f} GB). Revisar retención antes de que se "
                f"repita la caída del 2026-08-28."
            ).encode("utf-8"),
            headers={
                "Title": "GeoSpectrum: disco de TimescaleDB alto",
                "Priority": "urgent",
                "Tags": "warning,floppy_disk",
            },
        )


async def check_disk_usage(
    pool: asyncpg.Pool,
    volume_capacity_bytes: int,
    threshold_ratio: float,
    ntfy_topic_url: str,
) -> None:
    """Un chequeo. Notifica solo si se cruza el umbral — no en cada ciclo."""
    size_bytes = await _database_size_bytes(pool)
    usage_ratio = size_bytes / volume_capacity_bytes
    if usage_ratio < threshold_ratio:
        logger.debug("disk_alert: uso %.1f%%, por debajo del umbral", usage_ratio * 100)
        return

    logger.warning(
        "disk_alert: TimescaleDB al %.1f%% del volumen (%d bytes) — notificando por ntfy",
        usage_ratio * 100,
        size_bytes,
    )
    await _notify_ntfy(ntfy_topic_url, usage_ratio, size_bytes)


async def run_disk_alert_loop(
    pool: asyncpg.Pool,
    volume_capacity_bytes: int,
    threshold_ratio: float,
    ntfy_topic_url: str,
    interval_seconds: float,
    stop_event: asyncio.Event,
) -> None:
    """Chequea cada `interval_seconds` hasta que el lifespan setee el stop."""
    while not stop_event.is_set():
        try:
            await check_disk_usage(pool, volume_capacity_bytes, threshold_ratio, ntfy_topic_url)
        except Exception:
            logger.warning(
                "disk_alert: chequeo fallido, se reintenta en el próximo ciclo", exc_info=True
            )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass
