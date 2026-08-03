"""Tests para el filtro geométrico de eventos por área de interés (AOI-1)."""
import pytest

from src.services.geo_filter import (
    InvalidGeometryError,
    bbox_of,
    point_in_area,
    point_in_bbox,
    point_in_geometry,
)


def _square(minlon: float, minlat: float, maxlon: float, maxlat: float) -> dict:
    """Polygon rectangular. Orden GeoJSON: [lon, lat]."""
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [minlon, minlat],
                [maxlon, minlat],
                [maxlon, maxlat],
                [minlon, maxlat],
                [minlon, minlat],
            ]
        ],
    }


# El bbox real de la región que estaba fija en settings.region_* y que pasa a
# ser el preset del sistema por defecto (andes_argentina_chile).
def _andes() -> dict:
    return _square(-75, -40, -60, -20)


# --- bbox_of -----------------------------------------------------------------


def test_bbox_of_polygon():
    assert bbox_of(_andes()) == {
        "minlat": -40,
        "maxlat": -20,
        "minlon": -75,
        "maxlon": -60,
    }


def test_bbox_of_ignora_el_agujero():
    """El bbox lo define el anillo exterior; un agujero no puede agrandarlo."""
    con_agujero = _square(0, 0, 10, 10)
    con_agujero["coordinates"].append(
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    )
    assert bbox_of(con_agujero) == {"minlat": 0, "maxlat": 10, "minlon": 0, "maxlon": 10}


def test_bbox_of_multipolygon_cubre_todas_las_partes():
    multi = {
        "type": "MultiPolygon",
        "coordinates": [
            _square(-10, -10, -5, -5)["coordinates"],
            _square(20, 30, 25, 35)["coordinates"],
        ],
    }
    assert bbox_of(multi) == {"minlat": -10, "maxlat": 35, "minlon": -10, "maxlon": 25}


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 0]},
        {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        {"type": "Polygon"},
        {"type": "Polygon", "coordinates": []},
        {"type": "Polygon", "coordinates": [[[0]]]},
        {},
    ],
)
def test_bbox_of_rechaza_geometrias_invalidas(geometry):
    """Falla explícito: un área malformada no debe volverse un filtro vacío."""
    with pytest.raises(InvalidGeometryError):
        bbox_of(geometry)


# --- point_in_bbox -----------------------------------------------------------


def test_point_in_bbox_dentro_y_fuera():
    bbox = bbox_of(_andes())
    assert point_in_bbox(-32.9, -68.8, bbox) is True  # Mendoza
    assert point_in_bbox(35.5, 139.7, bbox) is False  # Tokio


def test_point_in_bbox_es_inclusivo_en_los_bordes():
    """Misma convención que src/config/regions.py:65-79."""
    bbox = bbox_of(_andes())
    assert point_in_bbox(-40, -75, bbox) is True
    assert point_in_bbox(-20, -60, bbox) is True


def test_point_in_bbox_none_matchea_todo():
    """bbox=None ≡ global ≡ match-all, convención heredada de regions.py."""
    assert point_in_bbox(35.5, 139.7, None) is True


# --- point_in_geometry -------------------------------------------------------


def test_point_in_geometry_dentro_y_fuera():
    andes = _andes()
    assert point_in_geometry(-32.9, -68.8, andes) is True  # Mendoza
    assert point_in_geometry(35.5, 139.7, andes) is False  # Tokio


def test_point_in_geometry_respeta_agujeros():
    """El motivo de usar Shapely y no ray-casting propio (Decisión heredada #2)."""
    con_agujero = _square(0, 0, 10, 10)
    con_agujero["coordinates"].append(
        [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    )
    assert point_in_geometry(1, 1, con_agujero) is True
    assert point_in_geometry(5, 5, con_agujero) is False  # dentro del agujero


def test_point_in_geometry_incluye_la_frontera():
    """covers() y no contains(): el borde matchea, igual que point_in_bbox."""
    assert point_in_geometry(-40, -75, _andes()) is True


def test_point_in_geometry_distingue_bbox_de_forma_real():
    """Un triángulo: el punto está en el bbox pero fuera del polígono.

    Es la prueba de que la etapa 2 realmente aporta algo sobre la etapa 1. Sin
    este caso, un filtro que sólo usara bbox pasaría todos los demás tests.
    """
    triangulo = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 0], [0, 10], [0, 0]]],
    }
    esquina = (9.0, 9.0)  # lat, lon — dentro del bbox 0..10, fuera del triángulo
    assert point_in_bbox(*esquina, bbox_of(triangulo)) is True
    assert point_in_geometry(*esquina, triangulo) is False


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 0]},
        {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
        {},
    ],
)
def test_point_in_geometry_rechaza_tipos_no_soportados(geometry):
    with pytest.raises(InvalidGeometryError):
        point_in_geometry(0, 0, geometry)


# --- antimeridiano (Decisión heredada #5) ------------------------------------


def _cinturon_antimeridiano() -> dict:
    """Cinturón que cruza ±180°, partido en dos según RFC 7946 §3.1.9.

    Cubre longitudes 170..180 y -180..-170, entre latitudes -10 y 10.
    """
    return {
        "type": "MultiPolygon",
        "coordinates": [
            _square(170, -10, 180, 10)["coordinates"],
            _square(-180, -10, -170, 10)["coordinates"],
        ],
    }


def test_antimeridiano_matchea_de_los_dos_lados():
    cinturon = _cinturon_antimeridiano()
    assert point_in_geometry(0, 175, cinturon) is True  # lado este
    assert point_in_geometry(0, -175, cinturon) is True  # lado oeste


def test_antimeridiano_no_matchea_el_lado_opuesto_del_planeta():
    """El agujero del enfoque por bbox: lon=0 cae en el bbox pero no en el área.

    El bbox de un área partida en el antimeridiano es minlon=-180/maxlon=180
    (todo el planeta en longitud), así que la etapa 1 NO descarta a Greenwich.
    Es Shapely quien lo rechaza. Si este test pasara con sólo bbox, el filtro
    estaría roto para todos los cinturones del catálogo.
    """
    cinturon = _cinturon_antimeridiano()
    bbox = bbox_of(cinturon)
    assert bbox["minlon"] == -180 and bbox["maxlon"] == 180
    assert point_in_bbox(0, 0, bbox) is True  # el pre-filtro no alcanza...
    assert point_in_geometry(0, 0, cinturon) is False  # ...Shapely sí


# --- point_in_area (las dos etapas juntas) -----------------------------------


def test_point_in_area_usa_el_bbox_precalculado_de_la_base():
    """Las columnas bbox_* de areas_of_interest, tal como salen de la fila."""
    area = {
        "geometry": _andes(),
        "bbox_minlat": -40,
        "bbox_maxlat": -20,
        "bbox_minlon": -75,
        "bbox_maxlon": -60,
    }
    assert point_in_area(-32.9, -68.8, area) is True  # Mendoza
    assert point_in_area(35.5, 139.7, area) is False  # Tokio


def test_point_in_area_calcula_el_bbox_si_falta():
    """Áreas construidas en memoria, sin pasar por la base."""
    assert point_in_area(-32.9, -68.8, {"geometry": _andes()}) is True
    assert point_in_area(35.5, 139.7, {"geometry": _andes()}) is False


def test_point_in_area_bbox_incoherente_no_produce_falso_positivo():
    """Si el bbox precalculado es más chico que la geometría, manda el bbox.

    Documenta la consecuencia del cortocircuito: bbox_* es fuente de verdad
    para el descarte. Por eso el service las deriva con bbox_of() al escribir
    y nunca las acepta del cliente.
    """
    area = {
        "geometry": _andes(),
        "bbox_minlat": -30,
        "bbox_maxlat": -25,
        "bbox_minlon": -70,
        "bbox_maxlon": -65,
    }
    # Mendoza está en la geometría pero fuera del bbox declarado.
    assert point_in_area(-32.9, -68.8, area) is False


def test_point_in_area_no_se_conforma_con_el_bbox():
    """point_in_area DEBE correr la etapa 2; el bbox solo no alcanza.

    Un triángulo cuyo bbox es 0..10: la esquina (9,9) pasa el pre-filtro pero
    está fuera del polígono. Si point_in_area cortocircuitara devolviendo True
    tras el bbox, este caso daría un falso positivo.
    """
    triangulo = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [10, 0], [0, 10], [0, 0]]],
    }
    area = {
        "geometry": triangulo,
        "bbox_minlat": 0,
        "bbox_maxlat": 10,
        "bbox_minlon": 0,
        "bbox_maxlon": 10,
    }
    assert point_in_area(1, 1, area) is True  # dentro del triángulo
    assert point_in_area(9, 9, area) is False  # en el bbox, fuera del triángulo


def test_point_in_area_antimeridiano_end_to_end():
    """El caso que motiva las dos etapas, entrando por el filtro completo.

    Con el bbox de un cinturón partido (minlon=-180, maxlon=180), la etapa 1 no
    descarta nada en longitud: si point_in_area no llamara a Shapely, Greenwich
    matchearía el Anillo de Fuego.
    """
    cinturon = _cinturon_antimeridiano()
    area = {"geometry": cinturon, **{
        f"bbox_{k}": v for k, v in bbox_of(cinturon).items()
    }}
    assert point_in_area(0, 175, area) is True  # lado este del cinturón
    assert point_in_area(0, -175, area) is True  # lado oeste
    assert point_in_area(0, 0, area) is False  # Greenwich: pasa el bbox, no el área


def test_point_in_area_rechaza_area_sin_geometria():
    with pytest.raises(InvalidGeometryError):
        point_in_area(0, 0, {"geometry": None})
    with pytest.raises(InvalidGeometryError):
        point_in_area(0, 0, {})
