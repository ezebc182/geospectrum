"""
Servicio de fusión de eventos de múltiples fuentes (USGS + INPRES).
"""
from typing import List, Set
from src.models.event import SeismicEvent
from src.utils.geo import haversine_km, parse_datetime_utc


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
                dt_sec = 999999.0

            # Comparar distancia
            dist_km = haversine_km(ue.lat, ue.lon, ie.lat, ie.lon)

            if dt_sec <= 120 and dist_km <= 30:
                best_match_idx = ii
                break

        if best_match_idx is not None:
            # Fusionar
            used_usgs.add(ui)
            used_inpres.add(best_match_idx)
            fused = _fuse_two_events(ue, inpres_events[best_match_idx])
            merged.append(fused)
        else:
            # USGS solo
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

    Criterios:
    - mag: mayor de ambas (conservador)
    - prof_km: menor de ambas (si ambas existen)
    - revisado: true si cualquiera está revisado
    - sentido: true si cualquiera lo marca
    - hora_utc: la más temprana
    - fuentes: unión de ambas
    """
    # Magnitud mayor
    mag = max(a.mag, b.mag)

    # Profundidad menor (si ambas existen)
    prof_vals = [x for x in [a.prof_km, b.prof_km] if x is not None]
    prof = min(prof_vals) if prof_vals else None

    # Flags acumulativos
    revisado = a.revisado or b.revisado
    sentido = a.sentido or b.sentido

    # Hora más temprana
    try:
        t_a = parse_datetime_utc(a.hora_utc)
        t_b = parse_datetime_utc(b.hora_utc)
        hora = a.hora_utc if t_a <= t_b else b.hora_utc
    except Exception:
        hora = a.hora_utc

    # Fuentes unificadas
    fuentes = sorted(list(set(a.fuentes + b.fuentes)))

    # Coordenadas: preferir la revisada, si no, tomar la de USGS (típicamente más precisa)
    if a.revisado and not b.revisado:
        lat, lon = a.lat, a.lon
        lugar = a.lugar
    elif b.revisado and not a.revisado:
        lat, lon = b.lat, b.lon
        lugar = b.lugar
    else:
        # Ambas revisadas o ambas automáticas → preferir USGS
        if "USGS" in a.fuentes:
            lat, lon = a.lat, a.lon
            lugar = a.lugar
        else:
            lat, lon = b.lat, b.lon
            lugar = b.lugar

    # Tipo de magnitud: preferir Mw si está disponible
    mag_tipo = a.mag_tipo
    if b.mag_tipo == "Mw":
        mag_tipo = "Mw"

    return SeismicEvent(
        id=a.id,  # Mantener ID del evento base
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
