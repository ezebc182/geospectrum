"""
Servicio de cálculo de KPIs y generación de alertas.
"""

import logging
from typing import List, Tuple
from datetime import datetime, timezone

from src.models.event import SeismicEvent, KPIs, Alert
from src.utils.geo import haversine_km, energy_weight, parse_datetime_utc

logger = logging.getLogger(__name__)


def compute_kpis_and_alerts(
    events: List[SeismicEvent], window_minutes: int
) -> Tuple[KPIs, List[Alert]]:
    """
    Calcula KPIs y detecta alertas operativas.

    Args:
        events: Lista de eventos sísmicos normalizados
        window_minutes: Ventana temporal analizada

    Returns:
        (kpis, alertas)
    """
    if not events:
        return _empty_kpis(), []

    now_dt = datetime.now(timezone.utc)

    mags: List[float] = []
    energies: List[float] = []
    depths_significant: List[float] = []
    felt_count = 0
    strong_last_minutes: float | None = None

    cluster_points: List[dict] = []

    for event in events:
        mag = event.mag
        mags.append(mag)
        energies.append(energy_weight(mag))

        if mag >= 4.0 and event.prof_km is not None:
            depths_significant.append(event.prof_km)

        if event.sentido:
            felt_count += 1

        if mag >= 5.0:
            try:
                t_dt = parse_datetime_utc(event.hora_utc)
                delta_min = (now_dt - t_dt).total_seconds() / 60.0
                if strong_last_minutes is None or delta_min < strong_last_minutes:
                    strong_last_minutes = delta_min
            except Exception:
                logger.warning(
                    "kpi_service: failed to parse hora_utc for M>=5 timing",
                    extra={"event_id": event.id, "hora_utc": event.hora_utc, "mag": mag},
                    exc_info=True,
                )

        try:
            t_dt = parse_datetime_utc(event.hora_utc)
            cluster_points.append(
                {
                    "t": t_dt,
                    "lat": event.lat,
                    "lon": event.lon,
                    "mag": mag,
                    "id": event.id,
                }
            )
        except Exception:
            logger.warning(
                "kpi_service: failed to parse hora_utc for cluster detection, event excluded",
                extra={"event_id": event.id, "hora_utc": event.hora_utc},
                exc_info=True,
            )

    total_events = len(events)
    tasa_hora = total_events * (60.0 / window_minutes)
    magnitud_max = max(mags) if mags else None

    mag_pond = None
    if energies and mags and sum(energies) > 0:
        mag_pond = sum(m * e for m, e in zip(mags, energies)) / sum(energies)

    prof_media_ge4 = (
        sum(depths_significant) / len(depths_significant) if depths_significant else None
    )

    pct_felt = felt_count / total_events if total_events > 0 else 0.0

    kpis = KPIs(
        total_eventos=total_events,
        tasa_eventos_por_hora=tasa_hora,
        magnitud_max=magnitud_max,
        magnitud_promedio_ponderada_por_energia=mag_pond,
        profundidad_media_M_ge_4=prof_media_ge4,
        eventos_sentidos=felt_count,
        porcentaje_eventos_sentidos=pct_felt,
        minutos_desde_M_ge_5=strong_last_minutes,
    )

    alertas: List[Alert] = []

    swarm_groups = _detect_swarms(cluster_points)
    for swarm_ids in swarm_groups:
        alertas.append(
            Alert(
                tipo="enjambre",
                descripcion=f"{len(swarm_ids)} eventos M>=3 en <=15min y <=20km",
                eventos_relacionados=swarm_ids,
            )
        )

    for event in events:
        if event.mag >= 5.0:
            if event.prof_km is not None and event.prof_km < 70:
                alertas.append(
                    Alert(
                        tipo="evento_significativo",
                        descripcion=f"Sismo M{event.mag:.1f} somero (<70km)",
                        eventos_relacionados=[event.id],
                    )
                )

    if pct_felt > 0.5:
        felt_ids = [ev.id for ev in events if ev.sentido]
        alertas.append(
            Alert(
                tipo="actividad_sentida",
                descripcion=f"{round(pct_felt*100)}% de eventos fueron sentidos",
                eventos_relacionados=felt_ids,
            )
        )

    return kpis, alertas


def _empty_kpis() -> KPIs:
    """Retorna KPIs vacíos cuando no hay eventos."""
    return KPIs(
        total_eventos=0,
        tasa_eventos_por_hora=0.0,
        magnitud_max=None,
        magnitud_promedio_ponderada_por_energia=None,
        profundidad_media_M_ge_4=None,
        eventos_sentidos=0,
        porcentaje_eventos_sentidos=0.0,
        minutos_desde_M_ge_5=None,
    )


def _detect_swarms(cluster_points: List[dict]) -> List[List[str]]:
    """
    Detecta enjambres sísmicos (clusters espacio-temporales).
    Criterio: >=3 eventos con M>=3 en <=15 min y <=20 km
    """
    swarm_groups: List[List[str]] = []

    for i, base in enumerate(cluster_points):
        if base["mag"] < 3.0:
            continue

        local_group = [base["id"]]

        for j, other in enumerate(cluster_points):
            if i == j or other["mag"] < 3.0:
                continue

            dt_min = abs((base["t"] - other["t"]).total_seconds()) / 60.0
            dist_km = haversine_km(base["lat"], base["lon"], other["lat"], other["lon"])

            if dt_min <= 15 and dist_km <= 20:
                if other["id"] not in local_group:
                    local_group.append(other["id"])

        if len(local_group) >= 3:
            local_group_sorted = sorted(local_group)
            if local_group_sorted not in swarm_groups:
                swarm_groups.append(local_group_sorted)

    return swarm_groups
