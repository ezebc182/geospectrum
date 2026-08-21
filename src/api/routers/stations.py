"""
Métricas por estación (PR-W3, spec muro §3).

Endpoints PÚBLICOS (misma política que /spectrograms: los datos sísmicos
son públicos, la UI del dashboard es lo que requiere sesión). El batch
existe por la escala del muro: hasta 120 canales visibles — un request
cada 15 s en vez de 120 pollers sueltos.

/metrics va declarado ANTES de /{channel}/metrics — mismo patrón que
/walls/global en walls.py.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from src.services.metrics_store import MetricsStore

router = APIRouter(prefix="/stations", tags=["stations"])

# Espejo de MAX_WALL_CHANNELS (wall_service.py): el muro es el
# consumidor más grande posible del batch.
MAX_METRICS_CHANNELS = 120


def _get_metrics_store(request: Request) -> MetricsStore:
    """Guard EXPLÍCITO del 503.

    No se delega en el `assert self._client is not None` de MetricsStore:
    bajo `python -O` los asserts desaparecen y el fallo mutaría a un
    AttributeError sobre None (500), no al 503 que documenta el contrato.
    """
    store: Optional[MetricsStore] = getattr(request.app.state, "metrics_store", None)
    if store is None:
        raise HTTPException(
            status_code=503, detail="Métricas no disponibles (Redis no configurado)"
        )
    return store


@router.get("/metrics")
async def get_stations_metrics(
    request: Request,
    channel: list[str] = Query(..., description="SCNL completo, repetible"),
) -> dict:
    if len(channel) > MAX_METRICS_CHANNELS:
        raise HTTPException(
            status_code=422,
            detail=f"Máximo {MAX_METRICS_CHANNELS} canales por request",
        )
    store = _get_metrics_store(request)
    return {"metrics": await store.get_snapshots(channel)}


@router.get("/{channel}/metrics")
async def get_station_metrics(channel: str, request: Request) -> dict:
    store = _get_metrics_store(request)
    snapshot = await store.get_snapshot(channel)
    if snapshot is None:
        raise HTTPException(
            status_code=404, detail="Sin métricas recientes para el canal"
        )
    return snapshot
