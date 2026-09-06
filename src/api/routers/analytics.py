"""Paneles profesionales de `/analytics` (analytics-professional-panels, Fase 3).

Cuatro endpoints ADITIVOS sobre lo que ya existe, sin tocar `/report`,
`/events/*` ni `/stations/*` (Decision 6 del design):

- `GET /analytics/b-value`       — Gutenberg-Richter por MLE sobre `seismic_events`
- `GET /analytics/hypocenters`   — catálogo para el mapa, ordenado por magnitud
- `GET /analytics/station-uptime`— serie de disponibilidad desde el rollup horario
- `GET /analytics/tremor/{ch}`   — episodios sostenidos sobre la MISMA traza de `/rsam`

Política de auth = la de `/report`: los datos sísmicos son públicos y la
sesión solo PERSONALIZA (área activa) en los dos endpoints de catálogo. Los
endpoints por canal no recortan por área (un canal no pertenece a un área).

DI vía `request.app.state` con guard EXPLÍCITO del 503 (molde `stations.py`):
nada de asserts que `python -O` elimina. La lógica de negocio vive en
`src/services/` (funciones puras testeadas con valores a mano); acá solo se
valida, se consulta y se mapea.
"""

import logging
import math
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

import asyncpg
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from src.api.deps import get_current_user_optional
from src.config.settings import settings
from src.models.analytics import (
    BValueNotEstimable,
    BValueOk,
    BValueResponse,
    HypocentersResponse,
    MagnitudeBin,
    StationUptimeResponse,
    TremorEpisode,
    TremorParameters,
    TremorResponse,
)
from src.models.event import SeismicEvent
from src.models.user import CurrentUser
from src.services import cache
from src.services.event_store import EventStore
from src.services.fdsn_result_cache import trace_covers_window
from src.services.geo_filter import area_to_filter_dict, point_in_area
from src.services.gutenberg_richter import fit_b_value, mag_type_counts
from src.services.spectrogram_service import get_spectrogram_service
from src.services.station_uptime import UptimeBucketKind, fetch_uptime
from src.services.tremor import characterize

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Espejo de MAX_WAVEFORM_WINDOW_HOURS (src/main.py): el tope de FDSN que ya
# imponen /waveform, /spectra y /rsam. No se importa de `main` porque `main`
# importa este router (sería circular).
MAX_TREMOR_WINDOW_HOURS = 24

# Más de 14 días por hora son > 336 puntos por canal: se fuerza `bucket=day`.
MAX_HOURLY_DAYS = 14

# Mismos rangos que /events/recent (main.py): un catálogo no se pagina, se acota.
DEFAULT_HYPOCENTER_LIMIT = 2000
MAX_HYPOCENTER_LIMIT = 5000


# --- helpers de estado -------------------------------------------------------


def _get_event_store(request: Request) -> EventStore:
    """503 si no hay base: devolver `insufficient` o una lista vacía haría que
    la UI diga "no hay sismos" cuando lo cierto es "no sabemos" (mismo criterio
    que /events/recent)."""
    store: Optional[EventStore] = getattr(request.app.state, "event_store", None)
    if store is None:
        raise HTTPException(
            status_code=503,
            detail="El histórico de eventos no está disponible (base no configurada)",
        )
    return store


def _get_db_pool(request: Request) -> asyncpg.Pool:
    pool: Optional[asyncpg.Pool] = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(
            status_code=503,
            detail="El historial de disponibilidad no está disponible (base no configurada)",
        )
    return pool


async def _resolve_area(
    request: Request, current_user: Optional[CurrentUser]
) -> tuple[Optional[dict], Optional[str]]:
    """`(area_filter, area_slug)` del área activa (o del preset default para el
    anónimo). Copia de `/report` (main.py): el área es una PERSONALIZACIÓN; si
    no se puede resolver se degrada a global con `logger.exception`, nunca 500.
    """
    try:
        area_service = request.app.state.area_service
        if current_user is not None:
            active_area, _is_default = await area_service.get_active(current_user.id)
        else:
            active_area = await area_service.get_default()
        return area_to_filter_dict(active_area), active_area.slug
    except Exception:
        logger.exception("No se pudo resolver el área activa; catálogo global")
        return None, None


def _window(days: int) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=days), now


async def _catalog(
    store: EventStore,
    start: datetime,
    end: datetime,
    min_mag: Optional[float],
    area_filter: Optional[dict],
    *,
    order_by_magnitude: bool = False,
) -> list[SeismicEvent]:
    """Filtro de área en dos etapas: bbox en SQL (`EventStore.between`) y
    polígono en Python (`point_in_area`, el MISMO que usa `build_report`)."""
    bbox = None
    if area_filter is not None:
        bbox = (
            area_filter["bbox_minlat"],
            area_filter["bbox_maxlat"],
            area_filter["bbox_minlon"],
            area_filter["bbox_maxlon"],
        )
    events = await store.between(
        start, end, min_magnitude=min_mag, bbox=bbox, order_by_magnitude=order_by_magnitude
    )
    if area_filter is None:
        return events
    return [e for e in events if point_in_area(e.lat, e.lon, area_filter)]


# --- GET /analytics/b-value --------------------------------------------------


@router.get("/b-value", response_model=BValueResponse)
async def get_b_value(
    request: Request,
    days: int = Query(30, ge=1, le=365, description="Ventana [now − days, now]"),
    min_mag: Optional[float] = Query(None, ge=0, le=10),
    mc: Optional[float] = Query(
        None, ge=0, le=10, description="Magnitud de completitud; ausente ⇒ MAXC + 0.2"
    ),
    current_user: Optional[CurrentUser] = Depends(get_current_user_optional),
) -> BValueResponse:
    """b-value (Aki-Utsu MLE, σ de Shi & Bolt) sobre el catálogo persistido.

    Lee `seismic_events` (≈ 1 año, sin retención), NO `/report` (60 min en
    vivo). Con `status != "ok"` el body NO lleva `b`/`a`/`sigma_b` — ni como
    `null` — porque `BValueNotEstimable` no los declara ([R8]/[R9]). La
    estimación y la guarda de N viven en `gutenberg_richter.fit_b_value`;
    acá no se reimplementa nada.
    """
    store = _get_event_store(request)
    window_start, window_end = _window(days)
    area_filter, area_slug = await _resolve_area(request, current_user)
    events = await _catalog(store, window_start, window_end, min_mag, area_filter)

    fit = fit_b_value([e.mag for e in events], mc)
    base: dict[str, Any] = dict(
        method=fit.method,
        n_total=fit.n_total,
        n_above_mc=fit.n_above_mc,
        min_events=fit.min_events,
        mc=fit.mc,
        mc_at_catalog_floor=fit.mc_at_catalog_floor,
        bins=[MagnitudeBin(m=b.m, count=b.count, cumulative=b.cumulative) for b in fit.bins],
        mag_type_counts=mag_type_counts(events),
        window_start=window_start,
        window_end=window_end,
        area_slug=area_slug,
    )
    if fit.status == "ok":
        return BValueOk(status="ok", b=fit.b, a=fit.a, sigma_b=fit.sigma_b, **base)
    return BValueNotEstimable(status=fit.status, **base)


# --- GET /analytics/hypocenters ----------------------------------------------


@router.get("/hypocenters", response_model=HypocentersResponse)
async def get_hypocenters(
    request: Request,
    days: int = Query(30, ge=1, le=365),
    min_mag: Optional[float] = Query(None, ge=0, le=10),
    limit: int = Query(DEFAULT_HYPOCENTER_LIMIT, ge=1, le=MAX_HYPOCENTER_LIMIT),
    current_user: Optional[CurrentUser] = Depends(get_current_user_optional),
) -> HypocentersResponse:
    """Catálogo para el mapa de hipocentros, ordenado por magnitud DESC.

    El recorte a `limit` se hace en Python DESPUÉS del polígono (la etapa 2
    puede descartar filas que el bbox dejó pasar) y `total` se cuenta ANTES
    del corte: un `LIMIT` en SQL obligaría a una segunda query de conteo para
    que `truncated` no mienta, y el catálogo pesa ~1 MB por año. Ordenar por
    magnitud garantiza que el recorte se lleva microsismicidad, nunca el M6.
    No consulta USGS/EMSC/INPRES: lee la tabla, como /events/recent.
    """
    store = _get_event_store(request)
    window_start, window_end = _window(days)
    area_filter, area_slug = await _resolve_area(request, current_user)
    events = await _catalog(
        store, window_start, window_end, min_mag, area_filter, order_by_magnitude=True
    )
    total = len(events)
    return HypocentersResponse(
        eventos=events[:limit],
        total=total,
        truncated=total > limit,
        window_start=window_start,
        window_end=window_end,
        area_slug=area_slug,
    )


# --- GET /analytics/station-uptime -------------------------------------------


@router.get("/station-uptime", response_model=StationUptimeResponse)
async def get_station_uptime(
    request: Request,
    days: int = Query(7, ge=1, le=365),
    bucket: Literal["hour", "day"] = Query("hour"),
    channel: Optional[list[str]] = Query(
        None, description="SCNL de 4 partes (trace.id), repetible; ausente ⇒ todos"
    ),
) -> StationUptimeResponse:
    """Serie de disponibilidad por canal desde `station_uptime_hourly`.

    `days > 14` fuerza `bucket=day` (tope de puntos). Un canal pedido sin
    filas en la ventana viene igual, todo `null` (no 404: "no lo miramos" no
    es "estaba caído"). Público: un canal no pertenece a un área.
    """
    pool = _get_db_pool(request)
    kind: UptimeBucketKind = "day" if days > MAX_HOURLY_DAYS else bucket
    now = datetime.now(timezone.utc)
    return await fetch_uptime(pool, now - timedelta(days=days), now, kind, channel, now)


# --- GET /analytics/tremor/{channel} -----------------------------------------


def _opt_float(value: Any) -> Optional[float]:
    return None if value is None else float(value)


@router.get("/tremor/{channel}", response_model=TremorResponse)
async def get_tremor(
    channel: str,
    request: Request,
    start: datetime = Query(..., description="Inicio ISO-8601 UTC"),
    end: datetime = Query(..., description="Fin ISO-8601 UTC"),
) -> dict:
    """Episodios sostenidos de amplitud (candidatos a tremor) sobre una ventana.

    Calca el camino fetch + cache de `GET /stations/{channel}/rsam` (main.py):
    SCNL de 4 partes, tz naive ⇒ UTC, `end ≤ start` ⇒ 422, > 24 h ⇒ 422, cache
    en memoria por clave `tremor:…`, cache eterno en DB, y la MISMA traza
    (`max(stream, key=npts)`). `samples[i].rsam` y `samples[i].t` son
    EXACTAMENTE `value`/`t` de `/rsam` con `period_seconds=600` (misma
    `rsam_series`, mismo redondeo, mismo `t` = centro de la ventana): tremor y
    tendencia comparten la serie por construcción.
    """
    parts = channel.split(".")
    if len(parts) != 4:
        raise HTTPException(status_code=422, detail="channel debe ser NET.STA.LOC.CHA")
    net, sta, loc, cha = parts

    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    start = start.astimezone(timezone.utc)
    end = end.astimezone(timezone.utc)

    if end <= start:
        raise HTTPException(status_code=422, detail="end debe ser posterior a start")
    if (end - start) > timedelta(hours=MAX_TREMOR_WINDOW_HOURS):
        raise HTTPException(status_code=422, detail="la ventana no puede superar 24 horas")

    cache_key = f"tremor:{channel}:{start.isoformat()}~{end.isoformat()}"
    ttl = settings.spectrogram_cache_ttl_seconds
    if ttl > 0:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

    db_cache = getattr(request.app.state, "fdsn_result_cache", None)
    if db_cache is not None:
        persisted = await db_cache.get(cache_key)
        if persisted is not None:
            if ttl > 0:
                cache.set(cache_key, persisted, ttl)
            return persisted

    service = get_spectrogram_service()
    stream = await service.get_waveform_data(
        network=net,
        station=sta,
        location=loc or "*",
        channel=cha,
        duration_hours=max(1, math.ceil((end - start).total_seconds() / 3600)),
        starttime=start,
        endtime=end,
    )
    if stream is None or len(stream) == 0:
        raise HTTPException(status_code=404, detail=f"Sin datos FDSN para {channel}")

    trace = max(stream, key=lambda tr: tr.stats.npts)
    fs = float(trace.stats.sampling_rate)
    signal = np.asarray(trace.data, dtype=np.float64)
    trace_start = trace.stats.starttime.datetime.replace(tzinfo=timezone.utc)
    result = characterize(signal, fs, trace_start)

    period = result.period_seconds
    samples = [
        {
            # La MISMA expresión que /rsam para `t` y `value`: igualdad byte a byte.
            "t": str(trace.stats.starttime + (i + 0.5) * period),
            "rsam": round(float(s["rsam"]), 2),
            "dominant_hz": _opt_float(s["dominant_hz"]),
            "fi": _opt_float(s["fi"]),
        }
        for i, s in enumerate(result.samples)
    ]
    response = TremorResponse(
        channel=channel,
        sampling_rate=fs,
        period_seconds=period,
        baseline_rsam=result.baseline_rsam,
        threshold_rsam=result.threshold_rsam,
        tremor_fraction=result.tremor_fraction,
        parameters=TremorParameters(**result.parameters),
        samples=samples,
        episodes=[TremorEpisode(**asdict(ep)) for ep in result.episodes],
    )
    payload = response.model_dump(mode="json")
    if ttl > 0:
        cache.set(cache_key, payload, ttl)
    # Igual que /rsam: solo se congela un trace que cubre la ventana.
    if db_cache is not None and trace_covers_window(trace, start, end):
        await db_cache.set(cache_key, payload)
    return payload
