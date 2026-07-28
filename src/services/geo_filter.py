"""
Filtro geométrico de eventos por área de interés (AOI-1).

Módulo PURO: no importa FastAPI, ni asyncpg, ni Shapely en el path rápido.
Se testea sin base y sin app, siguiendo el precedente de dashboard/lib/map-bounds.ts
en el frontend y de src/utils/geo.py acá (Decisión heredada #8: abstracción
render-agnóstica mínima, sin inventar interfaces contra un único consumidor).

Estrategia de dos etapas (Decisión heredada #1 — no hay PostGIS disponible en
timescale/timescaledb:latest-pg15, verificado contra la base corriendo):

    1. BBOX (barato, indexable). Cuatro comparaciones de floats. Descarta la
       enorme mayoría de los eventos sin tocar Shapely. Es la misma prueba que
       hace el índice idx_aoi_bbox de la migración 006, replicada en Python para
       que el filtrado en memoria no tenga que ir a la base.
    2. SHAPELY (caro, exacto). Sólo para los que pasan el bbox. Maneja agujeros
       y multipolígonos, que es por lo que se eligió una librería en vez de
       ray-casting propio (Decisión heredada #2).

El import de Shapely es diferido (dentro de la función) a propósito: los
callers que sólo necesitan `bbox_of()` o `event_in_bbox()` —por ejemplo el
service al calcular el bbox de un área nueva— no pagan el costo de cargar
Shapely + numpy.

ANTIMERIDIANO (Decisión heredada #5). El catálogo curado incluye cinturones que
cruzan ±180° (el Anillo de Fuego). RFC 7946 §3.1.9 obliga a partirlos en dos
polígonos dentro de un MultiPolygon, cada uno con longitudes en -180..180. Esa
representación tiene una consecuencia que hay que tener presente: el bbox
resultante es minlon=-180, maxlon=180, o sea "todo el planeta" en longitud.
Por eso el bbox es un PRE-filtro y nunca la respuesta final — para esas áreas
descarta poco y el trabajo real lo hace Shapely. La alternativa (un bbox que
"envuelva" con minlon > maxlon) rompería el índice de la base y el CHECK
areas_of_interest_bbox_ordered, y está deliberadamente descartada.
"""
from __future__ import annotations

from typing import Any, Optional, TypedDict


class Bbox(TypedDict):
    """Bounding box geográfico en grados decimales.

    Mismo shape que src/config/regions.py:Bbox (presets del stream SSE) y que
    las columnas bbox_* de areas_of_interest. Se redeclara en vez de importarse
    para no acoplar este módulo al catálogo de presets legacy, que se unifica
    recién en AOI-2.
    """

    minlat: float
    maxlat: float
    minlon: float
    maxlon: float


class InvalidGeometryError(ValueError):
    """GeoJSON que no se puede interpretar como área.

    Se levanta explícitamente en vez de devolver None/False para que un área
    malformada falle al escribirse, y no se convierta en un filtro que
    silenciosamente no matchea nada (el mismo criterio que UnknownRegionError
    en src/config/regions.py:107-120).
    """


_SUPPORTED_TYPES = ("Polygon", "MultiPolygon")


def _iter_positions(coordinates: Any, depth: int) -> Any:
    """Aplana el anidamiento de coordenadas GeoJSON hasta las posiciones.

    Polygon anida [anillo][posición][x,y] (depth=2) y MultiPolygon agrega un
    nivel más (depth=3). Recorrer genéricamente evita duplicar la lógica de
    bbox por cada tipo de geometría.
    """
    if depth == 0:
        yield coordinates
        return
    for item in coordinates:
        yield from _iter_positions(item, depth - 1)


def bbox_of(geometry: dict) -> Bbox:
    """Calcula el bounding box de una geometría GeoJSON.

    Es la fuente de las columnas bbox_* de areas_of_interest: el cliente nunca
    las manda, se derivan acá al escribir (ver migración 006).

    Args:
        geometry: GeoJSON dict con "type" Polygon o MultiPolygon y "coordinates"

    Returns:
        Bbox con las coordenadas extremas

    Raises:
        InvalidGeometryError: tipo no soportado, coordenadas vacías o malformadas
    """
    geom_type = geometry.get("type")
    if geom_type not in _SUPPORTED_TYPES:
        raise InvalidGeometryError(
            f"Unsupported geometry type: {geom_type!r}. "
            f"Expected one of {list(_SUPPORTED_TYPES)}"
        )

    coordinates = geometry.get("coordinates")
    if not coordinates:
        raise InvalidGeometryError(f"{geom_type} with empty coordinates")

    depth = 2 if geom_type == "Polygon" else 3

    lons: list[float] = []
    lats: list[float] = []
    for position in _iter_positions(coordinates, depth):
        # GeoJSON RFC 7946 §3.1.1: el orden es [lon, lat], NO [lat, lon].
        # Invertirlo es el error clásico y da áreas que no matchean nada.
        if not isinstance(position, (list, tuple)) or len(position) < 2:
            raise InvalidGeometryError(f"Malformed position in {geom_type}: {position!r}")
        lons.append(float(position[0]))
        lats.append(float(position[1]))

    if not lons:
        raise InvalidGeometryError(f"{geom_type} yielded no positions")

    return Bbox(
        minlat=min(lats),
        maxlat=max(lats),
        minlon=min(lons),
        maxlon=max(lons),
    )


def point_in_bbox(lat: float, lon: float, bbox: Optional[Bbox]) -> bool:
    """Etapa 1 del filtro: prueba barata contra el bounding box.

    Convención heredada de src/config/regions.py:65-79 — bbox=None significa
    "global / sin filtro" y siempre matchea. Mantenerla evita que los callers
    tengan que ramificar entre "filtrar" y "no filtrar".

    Args:
        lat, lon: Coordenadas del evento en grados decimales
        bbox: Bounding box, o None para "match all"

    Returns:
        True si el punto cae dentro del bbox (bordes incluidos)
    """
    if bbox is None:
        return True
    return (
        bbox["minlat"] <= lat <= bbox["maxlat"]
        and bbox["minlon"] <= lon <= bbox["maxlon"]
    )


def point_in_geometry(lat: float, lon: float, geometry: dict) -> bool:
    """Etapa 2 del filtro: prueba exacta punto-en-polígono con Shapely.

    Import diferido de Shapely: ver el docstring del módulo.

    Usa `covers()` y no `contains()` deliberadamente. `contains()` excluye la
    frontera, así que un evento exactamente sobre el borde de un área daría
    False —incoherente con point_in_bbox(), que incluye los bordes. `covers()`
    los incluye, y así las dos etapas del filtro coinciden en el límite.

    Args:
        lat, lon: Coordenadas del evento en grados decimales
        geometry: GeoJSON dict con "type" Polygon o MultiPolygon

    Returns:
        True si el punto cae dentro de la geometría (frontera incluida)

    Raises:
        InvalidGeometryError: la geometría no es interpretable por Shapely
    """
    geom_type = geometry.get("type")
    if geom_type not in _SUPPORTED_TYPES:
        raise InvalidGeometryError(
            f"Unsupported geometry type: {geom_type!r}. "
            f"Expected one of {list(_SUPPORTED_TYPES)}"
        )

    from shapely.geometry import Point, shape

    try:
        polygon = shape(geometry)
    except Exception as exc:  # shapely levanta varios tipos según el defecto
        raise InvalidGeometryError(f"Shapely could not build {geom_type}: {exc}") from exc

    # Point(x, y) = Point(lon, lat) — mismo orden que GeoJSON, invertido
    # respecto de cómo se nombran las coordenadas en el resto del proyecto.
    return polygon.covers(Point(lon, lat))


def point_in_area(lat: float, lon: float, area: dict) -> bool:
    """Filtro completo de dos etapas: bbox primero, Shapely sólo si hace falta.

    Es el entrypoint que usan los callers. `area` es la fila de
    areas_of_interest tal como sale de la base (o su equivalente en dict), con
    las columnas bbox_* ya calculadas y `geometry` como GeoJSON.

    Si el área no trae bbox_*, se calcula al vuelo con bbox_of(). Eso cubre a
    los callers que construyen un área en memoria sin pasar por la base.

    Args:
        lat, lon: Coordenadas del evento en grados decimales
        area: dict con "geometry" y opcionalmente bbox_minlat/maxlat/minlon/maxlon

    Returns:
        True si el evento cae dentro del área

    Raises:
        InvalidGeometryError: el área no tiene geometría interpretable
    """
    geometry = area.get("geometry")
    if not isinstance(geometry, dict):
        raise InvalidGeometryError(f"Area has no usable geometry: {geometry!r}")

    bbox: Optional[Bbox]
    if all(
        area.get(k) is not None
        for k in ("bbox_minlat", "bbox_maxlat", "bbox_minlon", "bbox_maxlon")
    ):
        bbox = Bbox(
            minlat=float(area["bbox_minlat"]),
            maxlat=float(area["bbox_maxlat"]),
            minlon=float(area["bbox_minlon"]),
            maxlon=float(area["bbox_maxlon"]),
        )
    else:
        bbox = bbox_of(geometry)

    # Etapa 1: descarte barato. Si no pasa el bbox, no puede estar en el
    # polígono (el bbox siempre lo contiene), así que se evita Shapely.
    if not point_in_bbox(lat, lon, bbox):
        return False

    # Etapa 2: prueba exacta.
    return point_in_geometry(lat, lon, geometry)
