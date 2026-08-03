"""
Servicio interno único de fusión de eventos sísmicos.

Orquesta fetch + merge + KPIs/alertas para las fuentes indicadas, y es
usado por /report, /events y /alerts (proyectando el resultado). NO es
usado por /events/search, que mantiene su propio pipeline de fetch+merge
más filtros in-memory (ver design.md del change
"unify-dashboard-events-source" — Decision: Contrato REST).
"""

import asyncio
import logging
from typing import Optional

from src.config.settings import settings
from src.models.event import MonitorReport, SeismicEvent
from src.services import cache
from src.services.emsc_service import fetch_emsc_events
from src.services.inpres_service import fetch_inpres_events
from src.services.kpi_service import compute_kpis_and_alerts
from src.services.geo_filter import point_in_area
from src.services.merge_service import merge_all_sources
from src.services.usgs_service import fetch_usgs_events
from src.utils.geo import now_utc_iso

logger = logging.getLogger(__name__)

# Orden canónico fijo de fuentes usado por /report, /events y /alerts vía
# build_report. Confirmado en Fase 0 (ver tests/unit/test_merge_service.py):
# merge_all_sources NO es conmutativa respecto al orden de sources — sin un
# orden fijo, la alerta de enjambre (_detect_swarms) sería no determinística
# ante el mismo input. Consistente con el default que /events/search ya usa
# hoy (src/main.py, sources = ["usgs", "emsc", "inpres"] cuando no se pasa
# el query param `sources`).
CANONICAL_SOURCES: list[str] = ["usgs", "emsc", "inpres"]


async def _fetch_parallel(
    time_window: int,
    sources: list[str],
) -> tuple[list[SeismicEvent], list[SeismicEvent], list[SeismicEvent], list[str]]:
    """
    Consulta USGS, EMSC e INPRES en paralelo con asyncio.gather.

    Respeta el caché TTL: si hay resultado fresco para la clave fuente+ventana,
    lo devuelve sin hacer fetch externo.

    Movida sin cambios de firma ni de comportamiento desde src/main.py
    (Fase 2, task 2.2 del change "unify-dashboard-events-source").

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


def count_by_source(
    usgs_events: list[SeismicEvent],
    emsc_events: list[SeismicEvent],
    inpres_events: list[SeismicEvent],
) -> dict[str, int]:
    """
    Desglose de eventos obtenidos por fuente, previo a la fusión.

    Existe para que main.py pueda incrementar los contadores Prometheus
    `events_fetched.labels(source=...)` por fuente individual sin que
    report_service.py importe prometheus_client (mantiene la separación
    HTTP-layer vs. lógica de dominio ya establecida en services/). Se
    calcula sobre las listas pre-fusión (antes de merge_all_sources) para
    que el conteo represente lo que cada fuente externa reportó, no cuántos
    eventos sobrevivieron a la deduplicación.

    Args:
        usgs_events, emsc_events, inpres_events: listas devueltas por
            _fetch_parallel, en ese orden.

    Returns:
        dict con claves "USGS", "EMSC", "INPRES" (mayúsculas, igual al
        label usado hoy en main.py para USGS/INPRES) y la cantidad de
        eventos de cada una.
    """
    return {
        "USGS": len(usgs_events),
        "EMSC": len(emsc_events),
        "INPRES": len(inpres_events),
    }


async def build_report(
    sources: list[str],
    window_minutes: Optional[int] = None,
    area: Optional[dict] = None,
) -> MonitorReport:
    """
    Orquesta la fusión de eventos sísmicos de las fuentes dadas y calcula
    KPIs/alertas sobre el resultado.

    Args:
        sources: Fuentes a consultar, ej. ["usgs", "emsc", "inpres"].
            Sin default deliberadamente: cada caller en main.py debe pasar
            CANONICAL_SOURCES de forma explícita para que el comportamiento
            de cada endpoint sea auditable con un grep, sin depender de un
            default silencioso que alguien pueda desalinear sin darse cuenta.
        window_minutes: Ventana temporal en minutos. Si None, usa
            settings.window_minutes (mismo default que /events/search).
        area: Área de interés (AOI-1) con la que recortar geográficamente el
            reporte, en el shape que espera geo_filter.point_in_area(): claves
            "geometry" (GeoJSON) y bbox_minlat/maxlat/minlon/maxlon PLANAS.
            Usar area_to_filter_dict() para convertir un AreaPublic; pasarle el
            .model_dump() crudo NO alcanza, porque ahí el bbox viaja anidado y
            el fast-path de dos etapas de point_in_area() no lo encontraría
            (funcionaría igual, pero cayendo siempre a Shapely).

            Si es None se conserva EXACTAMENTE el comportamiento previo: sin
            filtro geográfico y region_monitorizada desde settings.bbox. El
            parámetro es opcional a propósito — hoy sólo /report resuelve un
            área; /events y /alerts siguen siendo globales y no cambian.

    Returns:
        MonitorReport con kpis, alertas, eventos (fusionados vía
        merge_all_sources en el orden recibido en `sources`),
        region_monitorizada y data_source_errors.

        Cuando `area` viene, el filtro se aplica ANTES de calcular KPIs y
        alertas: el reporte describe el área pedida, no el mundo. Filtrar
        después dejaría un reporte incoherente, con una lista de 3 eventos
        regionales y un total_eventos global de 300.
    """
    effective_window = window_minutes if window_minutes is not None else settings.window_minutes

    usgs_events, emsc_events, inpres_events, errors = await _fetch_parallel(
        effective_window, sources
    )

    merged_events = merge_all_sources(usgs_events, emsc_events, inpres_events)
    logger.info("build_report: merged events: %d total (sources=%s)", len(merged_events), sources)

    if area is not None:
        total_before = len(merged_events)
        merged_events = [
            e for e in merged_events if point_in_area(e.lat, e.lon, area)
        ]
        logger.info(
            "build_report: area filter kept %d/%d events",
            len(merged_events),
            total_before,
        )
        region = area["bbox_public"]
    else:
        region = settings.bbox

    kpis, alertas = compute_kpis_and_alerts(merged_events, effective_window)

    return MonitorReport(
        timestamp_utc_generacion=now_utc_iso(),
        region_monitorizada=region,
        data_source_errors=errors,
        kpis=kpis,
        alertas=alertas,
        eventos=merged_events,
    )
