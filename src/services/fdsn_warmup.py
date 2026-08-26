"""Warm-up del helicorder: precalienta las 24 h de los canales vivos.

El dolor que resuelve: EarthScope entrega las 24 h de un canal en ~60 s desde
Railway, y el cache en memoria expira a los 900 s. Sin warm-up, el primer
usuario de cada ciclo paga el minuto entero mirando un spinner. Con warm-up,
el fetch lo paga este task de fondo y el endpoint siempre encuentra la key
caliente.

Corre DENTRO del proceso del api a propósito: el cache es memoria del proceso
y uvicorn corre un solo worker (Dockerfile sin `--workers`). Un warm-up en un
worker aparte calentaría la memoria equivocada.

Las variantes de `points` salen de seismic-constants.json — la MISMA fuente
que el frontend verifica por consumo (helicorder-layout.test.ts). El pedido
real de HelicorderCanvas es `?minutes=1440&points={variante}&filter=none`;
la key se arma acá con esa forma exacta y la paridad la fija
test_paridad_de_key_con_el_endpoint_real.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Iterable

from src.services import cache
from src.services.station_waveform import build_waveform_response

logger = logging.getLogger(__name__)

_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)
WARMUP_POINTS_VARIANTS: tuple[int, ...] = tuple(
    json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))["helicorderPointsVariants"]
)

# La ventana del helicorder: 24 h relativas, sin filtro (el default de la UI).
WARMUP_MINUTES = 1440
WARMUP_FILTER = "none"


def warmup_cache_key(channel: str, points: int) -> str:
    """La MISMA key que arma el endpoint /waveform para una ventana relativa."""
    return f"waveform:{channel}:m{WARMUP_MINUTES}:{points}:{WARMUP_FILTER}"


async def _warm_channel(service: Any, channel: str, ttl_seconds: float) -> bool:
    parts = channel.split(".")
    if len(parts) != 4:
        logger.warning("warmup: SCNL malformado en el catálogo: %s", channel)
        return False
    net, sta, loc, cha = parts

    stream = await service.get_waveform_data(
        network=net,
        station=sta,
        location=loc or "*",
        channel=cha,
        duration_hours=24,
    )
    if stream is None or len(stream) == 0:
        logger.info("warmup: sin datos FDSN para %s", channel)
        return False

    # Un solo fetch por canal; las variantes son decimaciones del mismo trace.
    trace = max(stream, key=lambda tr: tr.stats.npts)
    for points in WARMUP_POINTS_VARIANTS:
        result = build_waveform_response(trace, channel, points, apply_filter=False)
        cache.set(warmup_cache_key(channel, points), result, ttl_seconds)
    return True


async def warmup_sweep(
    service: Any,
    channels: Iterable[str],
    ttl_seconds: float,
    concurrency: int = 3,
) -> int:
    """Un barrido completo. Devuelve cuántos canales quedaron calientes.

    Un canal que falla no frena a los demás: FDSN se cae de a ratos y el
    barrido siguiente lo reintenta solo.
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def _bounded(channel: str) -> bool:
        async with semaphore:
            try:
                return await _warm_channel(service, channel, ttl_seconds)
            except Exception:
                logger.warning("warmup: falló %s, sigue el resto", channel, exc_info=True)
                return False

    results = await asyncio.gather(*(_bounded(c) for c in channels))
    warmed = sum(results)
    logger.info("warmup: %d/%d canales calientes", warmed, len(results))
    return warmed


async def run_warmup_loop(
    service: Any,
    get_channels: Any,
    interval_seconds: float,
    ttl_seconds: float,
    stop_event: asyncio.Event,
    concurrency: int = 3,
) -> None:
    """Barre cada `interval_seconds` hasta que el lifespan setee el stop.

    El try envuelve TODO el barrido (la lección del ingestor que salía con
    exit 0 por un hilo sin try/except): FDSN o la base caídos un rato no
    pueden dejar el warm-up muerto para siempre — el próximo ciclo reintenta.
    """
    while not stop_event.is_set():
        try:
            channels = await get_channels()
            await warmup_sweep(service, channels, ttl_seconds, concurrency)
        except Exception:
            logger.warning("warmup: barrido fallido, se reintenta en el próximo ciclo", exc_info=True)
        try:
            # Dormir ESPERANDO el stop: un sleep pelado retrasaría el shutdown
            # hasta 12 minutos.
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass
