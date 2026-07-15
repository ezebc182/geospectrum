"""
Servicio principal de Monitoreo Sísmico.

API REST productiva para consulta de KPIs, eventos y alertas sísmicas.
Integra USGS ComCat + INPRES Argentina.

Endpoints:
- GET /health: Health check (liveness/readiness probes)
- GET /metrics: Métricas Prometheus
- GET /report: Reporte completo con KPIs, alertas y eventos
- GET /events: Solo lista de eventos
- GET /alerts: Solo alertas activas
"""
import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional, List

from fastapi import FastAPI, Response, status, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

from src.config.settings import settings
from src.observability.glitchtip import init_glitchtip
from src.observability.logging_config import configure_logging
from src.observability.request_context import request_id_ctx
from src.models.event import MonitorReport, SeismicEvent, Alert
from src.services.usgs_service import fetch_usgs_events
from src.services.inpres_service import fetch_inpres_events
from src.services.emsc_service import fetch_emsc_events
from src.services.emsc_detail_service import EMSCDetailService
from src.services.merge_service import merge_all_sources
from src.services.report_service import build_report, count_by_source, CANONICAL_SOURCES
from src.services.spectrogram_service import get_spectrogram_service, LIVE_CHANNELS_BY_CITY
from src.services.event_bus import RedisPubSubBus
from src.services.timescale_service import TimescaleColumnWriter
from src.services import cache

# =============================================================================
# Observability — must happen before any logger is used
# =============================================================================

init_glitchtip("api")
configure_logging(settings.log_level)

logger = logging.getLogger(__name__)


# =============================================================================
# Métricas Prometheus
# =============================================================================

# Contadores
requests_total = Counter(
    "geospectrum_requests_total",
    "Total de requests por endpoint",
    ["endpoint", "status"],
)

events_fetched = Counter(
    "geospectrum_events_fetched_total",
    "Total de eventos obtenidos",
    ["source"],
)

alerts_generated = Counter(
    "geospectrum_alerts_generated_total",
    "Total de alertas generadas",
    ["tipo"],
)

data_source_errors = Counter(
    "geospectrum_data_source_errors_total",
    "Errores al consultar fuentes externas",
    ["source"],
)

# Histogramas
request_duration = Histogram(
    "geospectrum_request_duration_seconds",
    "Duración de requests",
    ["endpoint"],
)


# =============================================================================
# Lifecycle hooks
# =============================================================================

event_bus = RedisPubSubBus(settings.redis_url)
column_writer: Optional[TimescaleColumnWriter] = (
    TimescaleColumnWriter(settings.timescaledb_dsn) if settings.timescaledb_dsn else None
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Lifecycle manager para startup/shutdown."""
    logger.info("GeoSpectrum Service starting")
    logger.info("Region: %s", settings.bbox)
    logger.info("Min magnitude: %s", settings.min_mag_alert)
    logger.info("Window: %s minutes", settings.window_minutes)

    if settings.inpres_proxy_url:
        logger.info("INPRES proxy: %s", settings.inpres_proxy_url)
    else:
        logger.warning("INPRES proxy not configured - running USGS-only mode")

    try:
        await event_bus.connect()
        logger.info("EventBus (Redis) conectado: %s", settings.redis_url)
    except Exception:
        logger.warning(
            "EventBus (Redis) no disponible — /ws/spectrogram no funcionará "
            "hasta que Redis esté arriba y se reinicie el servicio",
            exc_info=True,
        )

    if column_writer is not None:
        try:
            await column_writer.connect()
            logger.info("TimescaleDB conectado: %s", settings.timescaledb_host)
        except Exception:
            logger.warning(
                "TimescaleDB no disponible — /spectrograms/{channel}/history no funcionará",
                exc_info=True,
            )
    else:
        logger.info("TimescaleDB no configurado (TIMESCALEDB_HOST vacío) — sin historial persistido")

    yield

    await event_bus.close()
    if column_writer is not None:
        await column_writer.close()
    logger.info("GeoSpectrum Service shutting down")


# =============================================================================
# FastAPI app
# =============================================================================

app = FastAPI(
    title="GeoSpectrum Service",
    description="Production-grade seismic monitoring with USGS + INPRES integration",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# =============================================================================
# CORS Configuration
# =============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# Request ID Middleware (M1.5)
# =============================================================================

@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Propaga o genera un X-Request-ID por cada request.

    - Si el cliente envía X-Request-ID, se reutiliza (trace distribuido).
    - Si no, se genera un UUID4.
    - El ID se almacena en request_id_ctx para que los loggers lo incluyan.
    - El ID se devuelve siempre en el header X-Request-ID de la response.
    """
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    token = request_id_ctx.set(request_id)
    try:
        response = await call_next(request)
    finally:
        request_id_ctx.reset(token)
    response.headers["X-Request-ID"] = request_id
    return response


# =============================================================================
# Endpoints
# =============================================================================

@app.get("/health", response_class=PlainTextResponse, tags=["ops"])
async def health() -> str:
    """
    Health check endpoint para liveness/readiness probes.

    Returns:
        "ok" siempre (si el servicio responde, está healthy)
    """
    requests_total.labels(endpoint="/health", status="200").inc()
    return "ok"


@app.get("/metrics", response_class=PlainTextResponse, tags=["ops"])
async def metrics() -> Response:
    """
    Endpoint de métricas Prometheus.

    Expone contadores y histogramas para scraping por Prometheus.
    """
    data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


async def _fetch_parallel(
    time_window: int,
    sources: list[str],
) -> tuple[list[SeismicEvent], list[SeismicEvent], list[SeismicEvent], list[str]]:
    """
    Consulta USGS, EMSC e INPRES en paralelo con asyncio.gather.

    Respeta el caché TTL: si hay resultado fresco para la clave fuente+ventana,
    lo devuelve sin hacer fetch externo.

    NOTA (change "unify-dashboard-events-source", Fase 3/4): esta copia se
    mantiene deliberadamente en main.py, aunque el diseño propone eliminarla
    (task 3.1), porque /events/search (que NO se toca en este change) es
    probada por tests/integration/test_api.py con
    `patch("src.main.fetch_usgs_events"/"fetch_emsc_events"/"fetch_inpres_events", ...)`.
    Esos mocks solo interceptan llamadas resueltas en el namespace de
    src.main; si /events/search delegara en report_service._fetch_parallel
    (que resuelve fetch_* en su propio namespace), los mocks dejarían de
    tener efecto y los tests golpearían red real. /report, /events y /alerts
    SÍ migraron a report_service.build_report (que trae su propia copia de
    _fetch_parallel) — ver Fase 3/4. Desviación de diseño documentada,
    priorizando no romper el contrato ya probado de /events/search.

    Returns:
        (usgs_events, emsc_events, inpres_events, errors)
    """
    ttl = settings.cache_ttl_seconds

    async def _cached_fetch(source: str, fetcher, window: int):
        key = f"{source}:{window}"
        if ttl > 0:
            hit = cache.get(key)
            if hit is not None:
                return hit
        result = await fetcher(window)
        if ttl > 0:
            cache.set(key, result, ttl)
        return result

    tasks = []
    fetch_map: list[str] = []

    if "usgs" in sources:
        tasks.append(_cached_fetch("usgs", fetch_usgs_events, time_window))
        fetch_map.append("usgs")
    if "emsc" in sources:
        tasks.append(_cached_fetch("emsc", fetch_emsc_events, time_window))
        fetch_map.append("emsc")
    if "inpres" in sources:
        tasks.append(_cached_fetch("inpres", fetch_inpres_events, time_window))
        fetch_map.append("inpres")

    results = await asyncio.gather(*tasks)

    usgs_events: list[SeismicEvent] = []
    emsc_events: list[SeismicEvent] = []
    inpres_events: list[SeismicEvent] = []
    errors: list[str] = []

    for source, (evts, err) in zip(fetch_map, results):
        if err:
            errors.append(err)
            logger.warning("%s fetch error: %s", source.upper(), err)
        if source == "usgs":
            usgs_events = evts
        elif source == "emsc":
            emsc_events = evts
        elif source == "inpres":
            inpres_events = evts

    return usgs_events, emsc_events, inpres_events, errors


@app.get("/report", response_model=MonitorReport, tags=["monitoring"])
async def report() -> MonitorReport:
    """
    Reporte completo de monitoreo sísmico.

    Incluye:
    - KPIs calculados sobre ventana temporal
    - Alertas operativas activas
    - Lista completa de eventos detectados
    - Errores de fuentes externas (si los hubo)

    Returns:
        MonitorReport completo
    """
    with request_duration.labels(endpoint="/report").time():
        logger.info("Generating seismic report")

        report_obj = await build_report(sources=CANONICAL_SOURCES)
        logger.info("Merged events: %d total", len(report_obj.eventos))

        # Desglose por fuente para events_fetched: se calcula sobre eventos
        # ya fusionados (report_obj.eventos), no sobre las listas pre-fusión
        # (esas viven dentro de build_report y no se exponen para evitar
        # duplicar el fetch). count_by_source espera listas separadas por
        # fuente; se arman aquí filtrando por el campo `fuentes` de cada
        # evento fusionado — un evento fusionado de 2+ fuentes cuenta en
        # cada una de ellas, igual que antes cuando USGS/INPRES no tenían
        # overlap real en /report.
        usgs_evts = [e for e in report_obj.eventos if "USGS" in e.fuentes]
        emsc_evts = [e for e in report_obj.eventos if "EMSC" in e.fuentes]
        inpres_evts = [e for e in report_obj.eventos if "INPRES" in e.fuentes]
        source_counts = count_by_source(usgs_evts, emsc_evts, inpres_evts)
        for source_name, count in source_counts.items():
            events_fetched.labels(source=source_name).inc(count)

        for err in report_obj.data_source_errors:
            src = err.split("_")[0]
            data_source_errors.labels(source=src).inc()

        for alerta in report_obj.alertas:
            alerts_generated.labels(tipo=alerta.tipo).inc()
            logger.warning("ALERT [%s]: %s", alerta.tipo, alerta.descripcion)

        requests_total.labels(endpoint="/report", status="200").inc()
        logger.info("Report generated successfully")

        return report_obj


@app.get("/events", response_model=list[SeismicEvent], tags=["monitoring"])
async def get_events() -> list[SeismicEvent]:
    """
    Solo eventos sísmicos (sin KPIs ni alertas).

    Útil para integraciones que solo necesitan lista de eventos.

    Returns:
        Lista de eventos normalizados
    """
    with request_duration.labels(endpoint="/events").time():
        report_obj = await build_report(sources=CANONICAL_SOURCES)

        requests_total.labels(endpoint="/events", status="200").inc()
        return report_obj.eventos


@app.get("/alerts", response_model=list[Alert], tags=["monitoring"])
async def get_alerts() -> list[Alert]:
    """
    Solo alertas activas (sin eventos completos).

    Útil para sistemas de notificación que solo necesitan saber
    si hay alertas operativas activas.

    Returns:
        Lista de alertas
    """
    with request_duration.labels(endpoint="/alerts").time():
        report_obj = await build_report(sources=CANONICAL_SOURCES)

        requests_total.labels(endpoint="/alerts", status="200").inc()
        return report_obj.alertas


@app.get("/events/search", response_model=list[SeismicEvent], tags=["monitoring"])
async def search_events(
    sources: Optional[str] = Query(None, description="Fuentes separadas por coma: usgs,emsc,inpres"),
    min_mag: Optional[float] = Query(None, description="Magnitud mínima"),
    max_mag: Optional[float] = Query(None, description="Magnitud máxima"),
    min_depth: Optional[float] = Query(None, description="Profundidad mínima (km)"),
    max_depth: Optional[float] = Query(None, description="Profundidad máxima (km)"),
    min_lat: Optional[float] = Query(None, description="Latitud mínima"),
    max_lat: Optional[float] = Query(None, description="Latitud máxima"),
    min_lon: Optional[float] = Query(None, description="Longitud mínima"),
    max_lon: Optional[float] = Query(None, description="Longitud máxima"),
    window_minutes: Optional[int] = Query(None, description="Ventana temporal en minutos"),
    felt_only: Optional[bool] = Query(False, description="Solo eventos sentidos"),
    reviewed_only: Optional[bool] = Query(False, description="Solo eventos revisados"),
) -> list[SeismicEvent]:
    """
    Búsqueda avanzada de eventos sísmicos con filtros múltiples.
    """
    with request_duration.labels(endpoint="/events/search").time():
        time_window = window_minutes if window_minutes is not None else settings.window_minutes
        source_list = sources.lower().split(",") if sources else ["usgs", "emsc", "inpres"]
        source_list = [s.strip() for s in source_list]

        usgs_events, emsc_events, inpres_events, errors = await _fetch_parallel(
            time_window, source_list
        )
        for err in errors:
            logger.warning("Source error in search: %s", err)

        merged = merge_all_sources(usgs_events, emsc_events, inpres_events)
        filtered = merged

        if min_mag is not None:
            filtered = [e for e in filtered if e.mag >= min_mag]
        if max_mag is not None:
            filtered = [e for e in filtered if e.mag <= max_mag]
        if min_depth is not None:
            filtered = [e for e in filtered if e.prof_km is not None and e.prof_km >= min_depth]
        if max_depth is not None:
            filtered = [e for e in filtered if e.prof_km is not None and e.prof_km <= max_depth]
        if min_lat is not None:
            filtered = [e for e in filtered if e.lat >= min_lat]
        if max_lat is not None:
            filtered = [e for e in filtered if e.lat <= max_lat]
        if min_lon is not None:
            filtered = [e for e in filtered if e.lon >= min_lon]
        if max_lon is not None:
            filtered = [e for e in filtered if e.lon <= max_lon]
        if felt_only:
            filtered = [e for e in filtered if e.sentido]
        if reviewed_only:
            filtered = [e for e in filtered if e.revisado]

        logger.info(
            "Search: %d events (from %d total, sources: %s)",
            len(filtered), len(merged), source_list,
        )

        requests_total.labels(endpoint="/events/search", status="200").inc()
        return filtered


# =============================================================================
# Spectrograms — WebSocket en vivo (SeedLink -> Redis -> aquí)
# =============================================================================

@app.websocket("/ws/spectrogram/{channel}")
async def ws_spectrogram(websocket: WebSocket, channel: str) -> None:
    """
    Streaming en vivo de columnas de espectrograma para un canal SEED
    (ej. "IU.MAJO.00.BHZ"). Las columnas las produce src/services/seedlink_ingestor.py
    (proceso separado) y las publica en Redis; acá solo hacemos fan-out a
    los navegadores conectados. Requiere que el ingestor esté corriendo.
    """
    await websocket.accept()
    logger.info("WebSocket conectado: /ws/spectrogram/%s", channel)
    try:
        async for column in event_bus.subscribe(f"spec:{channel}"):
            await websocket.send_json(column)
    except WebSocketDisconnect:
        logger.info("WebSocket desconectado: /ws/spectrogram/%s", channel)
    except Exception:
        logger.warning("WebSocket error en /ws/spectrogram/%s", channel, exc_info=True)


@app.get("/spectrograms/live-channels", tags=["spectrograms"])
async def get_live_channels() -> list[dict]:
    """
    Ciudades con streaming en vivo disponible (SeedLink), con su canal SEED
    completo. El frontend usa esto para decidir en qué tarjetas mostrar el
    toggle Vivo/24h — solo aparece donde hay cobertura real.
    """
    return [{"city_id": city_id, "channel": channel} for city_id, channel in LIVE_CHANNELS_BY_CITY.items()]


@app.get("/spectrograms/{channel}/history", tags=["spectrograms"])
async def get_spectrogram_history(
    channel: str,
    minutes: int = Query(5, description="Minutos de historial a recuperar", ge=1, le=1440),
) -> dict:
    """
    Historial persistido de columnas de espectrograma para un canal SEED
    (ej. "IU.MAJO.00.BHZ"), para pintar el canvas antes de conectar el
    WebSocket en vivo. Requiere TimescaleDB configurado y el ingestor
    corriendo con column_writer activo.
    """
    if column_writer is None:
        return {"channel": channel, "columns": [], "error": "TimescaleDB no configurado"}

    columns = await column_writer.fetch_history(channel, minutes)
    return {"channel": channel, "columns": columns}


# =============================================================================
# Spectrograms
# =============================================================================

@app.get("/spectrograms/{city_id}", tags=["spectrograms"])
async def get_spectrogram(
    city_id: str,
    latitude: float = Query(..., description="Latitud de la ciudad"),
    longitude: float = Query(..., description="Longitud de la ciudad"),
    network: Optional[str] = Query(None, description="Código de red FDSN preferido"),
    duration_hours: int = Query(24, description="Duración en horas", ge=1, le=168)
) -> dict:
    """
    Generar espectrograma para una ubicación específica.
    """
    with request_duration.labels(endpoint=f"/spectrograms/{city_id}").time():
        ttl = settings.spectrogram_cache_ttl_seconds
        cache_key = f"spectrogram:{city_id}:{duration_hours}"

        if ttl > 0:
            cached = cache.get(cache_key)
            if cached is not None:
                requests_total.labels(endpoint="/spectrograms", status="200").inc()
                return cached

        logger.info("Generating spectrogram for %s at (%s, %s)", city_id, latitude, longitude)

        spectrogram_service = get_spectrogram_service()

        result = await spectrogram_service.generate_spectrogram_for_location(
            latitude=latitude,
            longitude=longitude,
            network_code=network,
            duration_hours=duration_hours,
            city_id=city_id,
        )

        if result["success"]:
            requests_total.labels(endpoint="/spectrograms", status="200").inc()
            logger.info("Spectrogram generated for %s", city_id)
            if ttl > 0:
                cache.set(cache_key, result, ttl)
        else:
            requests_total.labels(endpoint="/spectrograms", status="500").inc()
            logger.warning(
                "Failed to generate spectrogram for %s: %s",
                city_id, result.get("error"),
            )

        return result


@app.get("/events/{event_id}/detail", tags=["advanced"])
async def get_event_detail(event_id: str) -> dict:
    """
    Obtener detalles completos de un evento por su ID.
    """
    with request_duration.labels(endpoint="/events/detail").time():
        logger.info("Fetching detailed event information for %s", event_id)

        # El id público del catálogo lleva prefijo de fuente (ver emsc_service.py:
        # id=f"emsc_{eventid}"); la API de EMSC solo conoce el eventid crudo.
        raw_event_id = event_id.removeprefix("emsc_")
        event_detail = await EMSCDetailService.get_event_with_rupture(raw_event_id)

        if event_detail:
            requests_total.labels(endpoint="/events/detail", status="200").inc()
            logger.info("Event %s retrieved successfully", event_id)

            if event_detail.get("rupture_model"):
                logger.info("Rupture model available for %s", event_id)

            return event_detail
        else:
            requests_total.labels(endpoint="/events/detail", status="404").inc()
            logger.warning("Event %s not found", event_id)

            return JSONResponse(
                status_code=404,
                content={"error": f"Event {event_id} not found"}
            )


@app.get("/events/{event_id}/rupture", tags=["advanced"])
async def get_rupture_model(event_id: str) -> dict:
    """
    Obtener modelo de ruptura de falla finita para un evento específico.
    """
    with request_duration.labels(endpoint="/events/rupture").time():
        logger.info("Fetching rupture model for %s", event_id)

        raw_event_id = event_id.removeprefix("emsc_")
        rupture_model = await EMSCDetailService.get_rupture_model(raw_event_id)

        if rupture_model:
            requests_total.labels(endpoint="/events/rupture", status="200").inc()
            logger.info("Rupture model found for %s", event_id)
            return rupture_model
        else:
            requests_total.labels(endpoint="/events/rupture", status="404").inc()
            logger.warning("No rupture model available for %s", event_id)

            return JSONResponse(
                status_code=404,
                content={
                    "error": f"No rupture model available for event {event_id}",
                    "note": "Rupture models are only available for significant earthquakes with published finite fault solutions."
                }
            )


# =============================================================================
# Debug endpoints (solo cuando settings.debug == True)
# =============================================================================

if getattr(settings, "debug", False):
    @app.get("/__debug/raise", tags=["debug"])
    async def debug_raise() -> None:
        """Lanza una excepción para testear la integración con Sentry/GlitchTip."""
        raise ValueError("Intentional test exception from /__debug/raise")


# =============================================================================
# Root endpoint
# =============================================================================

@app.get("/", tags=["info"])
async def root() -> dict:
    """
    Información básica del servicio.
    """
    return {
        "service": "GeoSpectrum",
        "version": "1.0.0",
        "status": "operational",
        "docs": "/docs",
        "health": "/health",
        "metrics": "/metrics",
        "endpoints": {
            "report": "/report",
            "events": "/events",
            "events_search": "/events/search",
            "event_detail": "/events/{event_id}/detail",
            "rupture_model": "/events/{event_id}/rupture",
            "alerts": "/alerts",
            "spectrograms": "/spectrograms/{city_id}",
        },
    }


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level.lower(),
        reload=False,
    )
