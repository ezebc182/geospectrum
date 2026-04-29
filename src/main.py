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
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Response, status, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, List
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

from src.config.settings import settings
from src.models.event import MonitorReport, SeismicEvent, Alert
from src.services.usgs_service import fetch_usgs_events
from src.services.inpres_service import fetch_inpres_events
from src.services.emsc_service import fetch_emsc_events
from src.services.emsc_detail_service import EMSCDetailService
from src.services.merge_service import merge_events
from src.services.kpi_service import compute_kpis_and_alerts
from src.services.spectrogram_service import get_spectrogram_service
from src.utils.geo import now_utc_iso

# =============================================================================
# Configuración de logging
# =============================================================================

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# =============================================================================
# Métricas Prometheus
# =============================================================================

# Contadores
requests_total = Counter(
    "seismic_monitor_requests_total",
    "Total de requests por endpoint",
    ["endpoint", "status"],
)

events_fetched = Counter(
    "seismic_monitor_events_fetched_total",
    "Total de eventos obtenidos",
    ["source"],
)

alerts_generated = Counter(
    "seismic_monitor_alerts_generated_total",
    "Total de alertas generadas",
    ["tipo"],
)

data_source_errors = Counter(
    "seismic_monitor_data_source_errors_total",
    "Errores al consultar fuentes externas",
    ["source"],
)

# Histogramas
request_duration = Histogram(
    "seismic_monitor_request_duration_seconds",
    "Duración de requests",
    ["endpoint"],
)


# =============================================================================
# Lifecycle hooks
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Lifecycle manager para startup/shutdown."""
    logger.info("🚀 Seismic Monitor Service starting...")
    logger.info(f"Region: {settings.bbox}")
    logger.info(f"Min magnitude: {settings.min_mag_alert}")
    logger.info(f"Window: {settings.window_minutes} minutes")

    if settings.inpres_proxy_url:
        logger.info(f"INPRES proxy: {settings.inpres_proxy_url}")
    else:
        logger.warning("⚠️  INPRES proxy not configured - running USGS-only mode")

    yield

    logger.info("🛑 Seismic Monitor Service shutting down...")


# =============================================================================
# FastAPI app
# =============================================================================

app = FastAPI(
    title="Seismic Monitor Service",
    description="Production-grade seismic monitoring with USGS + INPRES integration",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# =============================================================================
# CORS Configuration
# =============================================================================

# Permitir requests desde el dashboard Next.js
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3008",  # Dashboard Next.js
        "http://localhost:3000",  # Fallback para desarrollo
        "http://127.0.0.1:3008",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        logger.info("🔍 Generating seismic report...")

        # Consultar fuentes en paralelo
        usgs_events, usgs_err = await fetch_usgs_events(settings.window_minutes)
        inpres_events, inpres_err = await fetch_inpres_events(settings.window_minutes)

        # Tracking de métricas
        events_fetched.labels(source="USGS").inc(len(usgs_events))
        events_fetched.labels(source="INPRES").inc(len(inpres_events))

        if usgs_err:
            logger.warning(f"USGS error: {usgs_err}")
            data_source_errors.labels(source="USGS").inc()

        if inpres_err:
            logger.warning(f"INPRES error: {inpres_err}")
            data_source_errors.labels(source="INPRES").inc()

        # Fusionar eventos
        merged_events = merge_events(usgs_events, inpres_events)
        logger.info(f"📊 Merged events: {len(merged_events)} total")

        # Calcular KPIs y alertas
        kpis, alertas = compute_kpis_and_alerts(merged_events, settings.window_minutes)

        # Tracking de alertas
        for alerta in alertas:
            alerts_generated.labels(tipo=alerta.tipo).inc()
            logger.warning(f"🚨 ALERT [{alerta.tipo}]: {alerta.descripcion}")

        # Construir reporte
        errors_list = [e for e in [usgs_err, inpres_err] if e]

        report_obj = MonitorReport(
            timestamp_utc_generacion=now_utc_iso(),
            region_monitorizada=settings.bbox,
            data_source_errors=errors_list,
            kpis=kpis,
            alertas=alertas,
            eventos=merged_events,
        )

        requests_total.labels(endpoint="/report", status="200").inc()
        logger.info("✅ Report generated successfully")

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
        usgs_events, _ = await fetch_usgs_events(settings.window_minutes)
        inpres_events, _ = await fetch_inpres_events(settings.window_minutes)
        merged = merge_events(usgs_events, inpres_events)

        requests_total.labels(endpoint="/events", status="200").inc()
        return merged


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
        usgs_events, _ = await fetch_usgs_events(settings.window_minutes)
        inpres_events, _ = await fetch_inpres_events(settings.window_minutes)
        merged = merge_events(usgs_events, inpres_events)
        _, alertas = compute_kpis_and_alerts(merged, settings.window_minutes)

        requests_total.labels(endpoint="/alerts", status="200").inc()
        return alertas


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

    Permite filtrar por:
    - Fuentes de datos (USGS, EMSC, INPRES)
    - Rango de magnitud
    - Rango de profundidad
    - Bounding box geográfico
    - Ventana temporal
    - Estado (sentido, revisado)

    Similar a la funcionalidad de EMSC: https://www.emsc-csem.org/Earthquake_information/
    """
    with request_duration.labels(endpoint="/events/search").time():
        # Determinar ventana temporal
        time_window = window_minutes if window_minutes is not None else settings.window_minutes

        # Determinar fuentes a consultar
        source_list = sources.lower().split(",") if sources else ["usgs", "emsc", "inpres"]

        all_events = []
        errors = []

        # Fetch de fuentes seleccionadas
        if "usgs" in source_list:
            usgs_events, usgs_err = await fetch_usgs_events(time_window)
            all_events.extend(usgs_events)
            if usgs_err:
                errors.append(usgs_err)
                logger.warning(f"USGS error in search: {usgs_err}")

        if "emsc" in source_list:
            emsc_events, emsc_err = await fetch_emsc_events(time_window)
            all_events.extend(emsc_events)
            if emsc_err:
                errors.append(emsc_err)
                logger.warning(f"EMSC error in search: {emsc_err}")

        if "inpres" in source_list:
            inpres_events, inpres_err = await fetch_inpres_events(time_window)
            all_events.extend(inpres_events)
            if inpres_err:
                errors.append(inpres_err)
                logger.warning(f"INPRES error in search: {inpres_err}")

        # Merge events de todas las fuentes
        merged = merge_events(all_events, [])

        # Aplicar filtros
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

        logger.info(f"🔍 Search: {len(filtered)} events (from {len(merged)} total, sources: {source_list})")

        requests_total.labels(endpoint="/events/search", status="200").inc()
        return filtered


# =============================================================================
# Root endpoint (info)
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

    Obtiene datos de ondas sísmicas desde servidores FDSN y genera
    un espectrograma en tiempo real.

    Args:
        city_id: ID de la ciudad
        latitude: Latitud
        longitude: Longitud
        network: Código de red FDSN (opcional)
        duration_hours: Duración del espectrograma (1-168 horas)

    Returns:
        Dict con imagen base64 y metadata
    """
    with request_duration.labels(endpoint=f"/spectrograms/{city_id}").time():
        logger.info(f"🎵 Generating spectrogram for {city_id} at ({latitude}, {longitude})")

        spectrogram_service = get_spectrogram_service()

        result = await spectrogram_service.generate_spectrogram_for_location(
            latitude=latitude,
            longitude=longitude,
            network_code=network,
            duration_hours=duration_hours,
            city_id=city_id  # Pasar city_id para usar estaciones pre-configuradas
        )

        if result["success"]:
            requests_total.labels(endpoint="/spectrograms", status="200").inc()
            logger.info(f"✅ Spectrogram generated for {city_id}")
        else:
            requests_total.labels(endpoint="/spectrograms", status="500").inc()
            logger.warning(f"⚠️  Failed to generate spectrogram for {city_id}: {result.get('error')}")

        return result


@app.get("/events/{event_id}/detail", tags=["advanced"])
async def get_event_detail(event_id: str) -> dict:
    """
    Obtener detalles completos de un evento por su ID (UNID de EMSC, Event ID de USGS, etc).

    Incluye:
    - Información completa del evento
    - Todas las magnitudes calculadas
    - Todos los orígenes (si hay múltiples soluciones)
    - Datos de calidad (errores, gaps azimutales, estaciones usadas)
    - Intensidades máximas si están disponibles
    - Modelo de ruptura si existe (SRCMOD)

    Args:
        event_id: ID del evento (UNID de EMSC, Event ID de USGS, etc)

    Returns:
        Diccionario con información detallada del evento
    """
    with request_duration.labels(endpoint="/events/detail").time():
        logger.info(f"🔍 Fetching detailed event information for {event_id}")

        # Intentar obtener evento con modelo de ruptura
        event_detail = await EMSCDetailService.get_event_with_rupture(event_id)

        if event_detail:
            requests_total.labels(endpoint="/events/detail", status="200").inc()
            logger.info(f"✅ Event {event_id} retrieved successfully")

            # Indicar si hay modelo de ruptura disponible
            if event_detail.get("rupture_model"):
                logger.info(f"📐 Rupture model available for {event_id}")

            return event_detail
        else:
            requests_total.labels(endpoint="/events/detail", status="404").inc()
            logger.warning(f"⚠️  Event {event_id} not found")

            return JSONResponse(
                status_code=404,
                content={"error": f"Event {event_id} not found"}
            )


@app.get("/events/{event_id}/rupture", tags=["advanced"])
async def get_rupture_model(event_id: str) -> dict:
    """
    Obtener modelo de ruptura de falla finita para un evento específico.

    Los modelos de ruptura (finite fault models) proporcionan información detallada sobre
    cómo se rompió la falla durante el terremoto, incluyendo:
    - Distribución de deslizamiento (slip)
    - Velocidad de ruptura
    - Tiempo de levantamiento (rise time)
    - Dimensiones de la falla
    - Número de subfallas

    Fuente: SRCMOD database (Martin Mai)
    Solo disponible para terremotos significativos con modelos publicados.

    Args:
        event_id: ID del evento (UNID de EMSC)

    Returns:
        Diccionario con modelo de ruptura o error si no está disponible
    """
    with request_duration.labels(endpoint="/events/rupture").time():
        logger.info(f"🔍 Fetching rupture model for {event_id}")

        rupture_model = await EMSCDetailService.get_rupture_model(event_id)

        if rupture_model:
            requests_total.labels(endpoint="/events/rupture", status="200").inc()
            logger.info(f"✅ Rupture model found for {event_id}")
            return rupture_model
        else:
            requests_total.labels(endpoint="/events/rupture", status="404").inc()
            logger.warning(f"⚠️  No rupture model available for {event_id}")

            return JSONResponse(
                status_code=404,
                content={
                    "error": f"No rupture model available for event {event_id}",
                    "note": "Rupture models are only available for significant earthquakes with published finite fault solutions."
                }
            )


@app.get("/", tags=["info"])
async def root() -> dict:
    """
    Información básica del servicio.
    """
    return {
        "service": "Seismic Monitor",
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
        reload=False,  # Producción siempre con reload=False
    )
