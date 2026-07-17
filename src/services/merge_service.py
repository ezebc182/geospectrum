"""
Servicio de fusión de eventos de múltiples fuentes (USGS + INPRES + EMSC).
"""
import logging
from typing import List, Set
from src.models.event import SeismicEvent
from src.utils.geo import haversine_km, parse_datetime_utc

logger = logging.getLogger(__name__)


def merge_all_sources(*source_lists: List[SeismicEvent]) -> List[SeismicEvent]:
    """
    Fusiona N listas de eventos aplicando deduplicación iterativa.

    Reduce las listas de a pares: (acumulado, siguiente_fuente).
    Así el criterio Δt/distancia aplica correctamente entre fuentes.

    Args:
        *source_lists: Cualquier cantidad de listas de SeismicEvent

    Returns:
        Lista unificada de eventos
    """
    non_empty = [lst for lst in source_lists if lst]
    if not non_empty:
        return []
    result = non_empty[0]
    for next_list in non_empty[1:]:
        result = merge_events(result, next_list)
    return result


def merge_events(
    usgs_events: List[SeismicEvent], inpres_events: List[SeismicEvent]
) -> List[SeismicEvent]:
    """
    Fusiona eventos reportados por USGS e INPRES.

    Criterio de match:
    - Δt ≤ 120 segundos
    - Distancia epicentral ≤ 30 km

    Cuando dos eventos matchean:
    - Se toma la magnitud MAYOR (criterio conservador)
    - revisado = true si alguna fuente está revisada
    - sentido = true si alguna fuente lo marca como sentido
    - profundidad = la menor disponible

    Args:
        usgs_events: Eventos desde USGS
        inpres_events: Eventos desde INPRES

    Returns:
        Lista unificada de eventos
    """
    merged: List[SeismicEvent] = []
    used_inpres: Set[int] = set()
    used_usgs: Set[int] = set()

    # Primer paso: buscar matches USGS ↔ INPRES
    for ui, ue in enumerate(usgs_events):
        best_match_idx: int | None = None

        for ii, ie in enumerate(inpres_events):
            if ii in used_inpres:
                continue

            # Comparar tiempo
            try:
                t_usgs = parse_datetime_utc(ue.hora_utc)
                t_inpres = parse_datetime_utc(ie.hora_utc)
                dt_sec = abs((t_usgs - t_inpres).total_seconds())
            except Exception:
                logger.warning(
                    "merge_events: datetime parse failed, treating as non-match",
                    extra={
                        "usgs_event_id": ue.id,
                        "usgs_hora_utc": ue.hora_utc,
                        "inpres_hora_utc": ie.hora_utc,
                    },
                    exc_info=True,
                )
                dt_sec = 999999.0

            # Comparar distancia
            dist_km = haversine_km(ue.lat, ue.lon, ie.lat, ie.lon)

            if dt_sec <= 120 and dist_km <= 30:
                best_match_idx = ii
                break

        if best_match_idx is not None:
            used_usgs.add(ui)
            used_inpres.add(best_match_idx)
            fused = _fuse_two_events(ue, inpres_events[best_match_idx])
            merged.append(fused)
        else:
            used_usgs.add(ui)
            merged.append(ue)

    # Segundo paso: agregar INPRES que no matchearon
    for ii, ie in enumerate(inpres_events):
        if ii not in used_inpres:
            merged.append(ie)

    return merged


def _fuse_two_events(a: SeismicEvent, b: SeismicEvent) -> SeismicEvent:
    """
    Fusiona dos reportes del mismo evento.
    """
    mag = max(a.mag, b.mag)

    prof_vals = [x for x in [a.prof_km, b.prof_km] if x is not None]
    prof = min(prof_vals) if prof_vals else None

    revisado = a.revisado or b.revisado
    sentido = a.sentido or b.sentido

    try:
        t_a = parse_datetime_utc(a.hora_utc)
        t_b = parse_datetime_utc(b.hora_utc)
        hora = a.hora_utc if t_a <= t_b else b.hora_utc
    except Exception:
        hora = a.hora_utc

    fuentes = sorted(list(set(a.fuentes + b.fuentes)))

    if a.revisado and not b.revisado:
        lat, lon = a.lat, a.lon
        lugar = a.lugar
    elif b.revisado and not a.revisado:
        lat, lon = b.lat, b.lon
        lugar = b.lugar
    else:
        if "USGS" in a.fuentes:
            lat, lon = a.lat, a.lon
            lugar = a.lugar
        else:
            lat, lon = b.lat, b.lon
            lugar = b.lugar

    mag_tipo = a.mag_tipo
    if b.mag_tipo == "Mw":
        mag_tipo = "Mw"

    return SeismicEvent(
        id=a.id,
        fuentes=fuentes,
        hora_utc=hora,
        lat=lat,
        lon=lon,
        prof_km=prof,
        mag=mag,
        mag_tipo=mag_tipo,
        lugar=lugar,
        sentido=sentido,
        revisado=revisado,
    )
