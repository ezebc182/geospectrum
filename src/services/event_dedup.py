"""
Deduplicación de eventos sísmicos entre fuentes, para ingesta en STREAMING.

Por qué no se reusa merge_service.merge_events tal cual: aquel compara dos
LISTAS completas en memoria (el caso de /report, que trae USGS+EMSC+INPRES de
un saque y los fusiona). El worker de push (PR-W4) recibe los eventos de a UNO
—EMSC empuja por WebSocket en cuanto ocurren— y no tiene ninguna lista contra
la cual comparar: tiene la TABLA.

Lo que sí se reusa es el CRITERIO, que es el mismo y no debe divergir:

    Δt ≤ 120 s  y  distancia epicentral ≤ 30 km  ⇒  es el mismo sismo

Ese umbral vive en merge_service.merge_events:41-43 y se importa desde acá
como constante compartida, para que cambiar uno cambie los dos.

La fusión de campos (qué magnitud gana, qué epicentro se conserva) también se
delega a merge_service._fuse_two_events: EMSC manda revisiones del mismo sismo
minutos después, con magnitud corregida, y la regla de "gana la revisada, si
no gana USGS" ya está resuelta y testeada ahí.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from src.models.event import SeismicEvent
from src.services.merge_service import _fuse_two_events
from src.utils.geo import haversine_km, parse_datetime_utc

logger = logging.getLogger(__name__)


# Mismo criterio que merge_service.merge_events (Δt ≤ 120 s, dist ≤ 30 km).
# Están acá como constantes con nombre para que el worker y /report no puedan
# divergir en silencio: si mañana se afina el umbral, se afina en un lugar.
MATCH_WINDOW_SECONDS = 120.0
MATCH_DISTANCE_KM = 30.0


def canonical_id(event: SeismicEvent) -> str:
    """
    Id estable del evento dentro de nuestra base.

    Es el id de la fuente tal como llega (ya viene prefijado: `usgs_us7000abcd`,
    `emsc_1234567` — ver main.py:2310-2312). NO se inventa un hash de
    lat/lon/hora: dos reportes del mismo sismo difieren justamente en esos
    valores, así que un hash daría ids distintos para el mismo evento y no
    resolvería nada.

    La unificación real la hace `find_duplicate` contra lo ya persistido; este
    id es sólo la clave primaria del PRIMER reporte que llegó, y el que gana
    cuando después aparece el segundo.
    """
    return event.id


def is_same_event(a: SeismicEvent, b: SeismicEvent) -> bool:
    """
    True si los dos reportes describen el mismo sismo.

    Δt ≤ 120 s y distancia ≤ 30 km, igual que merge_service. Un timestamp
    imparseable NO matchea (se trata como evento distinto): preferimos un
    duplicado visible a fusionar dos sismos reales por un error de parseo.
    """
    try:
        t_a = parse_datetime_utc(a.hora_utc)
        t_b = parse_datetime_utc(b.hora_utc)
    except Exception:
        logger.warning(
            "is_same_event: no se pudo parsear la hora, se tratan como distintos",
            extra={"a_id": a.id, "a_hora": a.hora_utc, "b_id": b.id, "b_hora": b.hora_utc},
            exc_info=True,
        )
        return False

    dt_sec = abs((t_a - t_b).total_seconds())
    if dt_sec > MATCH_WINDOW_SECONDS:
        return False

    return haversine_km(a.lat, a.lon, b.lat, b.lon) <= MATCH_DISTANCE_KM


def find_duplicate(
    incoming: SeismicEvent, candidates: Iterable[SeismicEvent]
) -> Optional[SeismicEvent]:
    """
    Busca en `candidates` el reporte ya conocido del mismo sismo que `incoming`.

    `candidates` es la ventana espacio-temporal que el store trae de la tabla
    (los eventos de ±120 s alrededor de `incoming`), no la tabla entera:
    comparar contra todo el histórico sería O(n) por evento entrante.

    Devuelve None si `incoming` es un sismo nuevo.
    """
    for candidate in candidates:
        if candidate.id == incoming.id:
            return candidate
        if is_same_event(incoming, candidate):
            return candidate
    return None


def merge_into(existing: SeismicEvent, incoming: SeismicEvent) -> SeismicEvent:
    """
    Fusiona un reporte nuevo sobre uno ya persistido, conservando el id del
    existente (es la PK de la fila que se va a actualizar).

    La lógica de qué campo gana la delega en merge_service._fuse_two_events,
    que ya resuelve magnitud mayor, profundidad menor, epicentro de la fuente
    revisada y unión de `fuentes`. Acá sólo se fuerza el id, porque
    _fuse_two_events se queda con el del primer argumento y el orden importa.
    """
    fused = _fuse_two_events(existing, incoming)
    if fused.id != existing.id:
        fused = fused.model_copy(update={"id": existing.id})
    return fused


def has_changes(existing: SeismicEvent, fused: SeismicEvent) -> bool:
    """
    True si la fusión aportó algo nuevo respecto de lo ya persistido.

    Es lo que decide si vale la pena escribir Y republicar: EMSC reenvía el
    mismo evento sin cambios más de una vez, y sin este chequeo cada reenvío
    despertaría a todos los clientes conectados para nada.
    """
    return fused.model_dump() != existing.model_dump()
